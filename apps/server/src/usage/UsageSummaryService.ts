// apps/server/src/usage/UsageSummaryService.ts
// reads bounded local transcript usage and applies current custom prices

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from 'node:crypto'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import {
  type ServerSettings,
  type UsageModelBucket,
  type UsageProviderKind,
  UsageReadError,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageSummarySource,
  type UsageTokenTotals,
  USAGE_SUMMARY_MAX_BUCKETS,
  USAGE_SUMMARY_MAX_SOURCES,
} from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import * as ImportDiscovery from '../import/discovery/discovery.ts'
import { makeImportByteBudget } from '../import/discovery/resourceLimits.ts'
import {
  type ImportFileSourceDescriptor,
  type SourceCatalogResult,
  readResolvedImportSourceFile,
  resolveImportSourcePath,
  resolveSourceCatalog,
} from '../import/discovery/sourceCatalog.ts'
import * as ServerSettingsService from '../serverSettings.ts'
import {
  addUsageTotals,
  EMPTY_USAGE_TOTALS,
  parseUsageTranscript,
  type UsageRecord,
} from './usageTranscripts.ts'
import { priceUsageRecord } from './usagePricing.ts'

const USAGE_SCAN_MAX_BYTES = 64 * 1024 * 1024
const USAGE_SCAN_MAX_FILES = 2_000
const USAGE_SCAN_MAX_RECORDS = 100_000
const USAGE_SCAN_CACHE_MS = 30_000
const encodeSourceSettings = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const isUsageReadError = Schema.is(UsageReadError)

interface UsageSourceAccumulator
{
  readonly provider: UsageProviderKind
  readonly fingerprint: string
  status: UsageSummarySource['status']
  scannedFiles: number
  skippedFiles: number
  malformedRecords: number
  message: string | null
}

interface RawUsageSummary
{
  readonly readAt: string
  readonly records: ReadonlyArray<UsageRecord>
  readonly sources: ReadonlyArray<UsageSummarySource>
  readonly partial: boolean
}

interface UsageBucketAccumulator
{
  readonly provider: UsageProviderKind
  readonly model: string
  totals: UsageTokenTotals
  costUsd: number
  records: number
  providerReportedRecords: number
  customPricedRecords: number
  unpricedRecords: number
  readonly sessionIds: Set<string>
}

interface CachedUsageSummary
{
  readonly key: string
  readonly expiresAt: number
  readonly value: RawUsageSummary
}

export class UsageSummaryService extends Context.Service<
  UsageSummaryService,
  {
    readonly getSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>
  }
>()('456code/usage/UsageSummaryService')
{}

function boundedMessage(value: unknown): string
{
  const message = value instanceof Error ? value.message : String(value)
  const normalized = message.replace(/\s+/g, ' ').trim()
  return (normalized.length > 0 ? normalized : 'Unknown transcript read failure.').slice(0, 512)
}

function providerForSource(source: string): UsageProviderKind | null
{
  if (source === 'claude-code') return 'claude'
  if (source === 'codex-cli') return 'codex'
  return null
}

function sourceFingerprint(input: {
  readonly provider: UsageProviderKind
  readonly root: string
}): string
{
  return NodeCrypto.createHash('sha256')
    .update(`${NodeOS.hostname()}\0${input.provider}\0${input.root}`)
    .digest('hex')
    .slice(0, 32)
}

function descriptorContainsPath(
  descriptor: ImportFileSourceDescriptor,
  sourcePath: string,
): boolean
{
  const relative = NodePath.relative(descriptor.scanRoot, sourcePath)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  )
}

function makeSourceAccumulators(
  descriptors: ReadonlyArray<ImportFileSourceDescriptor>,
): Map<string, UsageSourceAccumulator>
{
  const sources = new Map<string, UsageSourceAccumulator>()
  for (const descriptor of descriptors)
  {
    const provider = providerForSource(descriptor.source)
    if (provider === null) continue
    const fingerprint = sourceFingerprint({ provider, root: descriptor.scanRoot })
    const key = `${provider}:${fingerprint}`
    if (!sources.has(key))
    {
      sources.set(key, {
        provider,
        fingerprint,
        status: 'ok',
        scannedFiles: 0,
        skippedFiles: 0,
        malformedRecords: 0,
        message: null,
      })
    }
  }
  return sources
}

function sourceForCandidate(input: {
  readonly descriptors: ReadonlyArray<ImportFileSourceDescriptor>
  readonly sources: ReadonlyMap<string, UsageSourceAccumulator>
  readonly source: string
  readonly sourcePath: string
}): UsageSourceAccumulator | undefined
{
  const descriptor = input.descriptors.find(
    (candidate) =>
      candidate.source === input.source && descriptorContainsPath(candidate, input.sourcePath),
  )
  if (descriptor === undefined) return undefined
  const provider = providerForSource(descriptor.source)
  if (provider === null) return undefined
  return input.sources.get(
    `${provider}:${sourceFingerprint({ provider, root: descriptor.scanRoot })}`,
  )
}

function markSourcePartial(source: UsageSourceAccumulator | undefined, message: string): void
{
  if (source === undefined) return
  source.status = source.scannedFiles > 0 ? 'partial' : 'failed'
  source.skippedFiles += 1
  source.message ??= message
}

function sourceSnapshot(source: UsageSourceAccumulator): UsageSummarySource
{
  return {
    provider: source.provider,
    fingerprint: source.fingerprint,
    status: source.status,
    scannedFiles: source.scannedFiles,
    skippedFiles: source.skippedFiles,
    malformedRecords: source.malformedRecords,
    message: source.message,
  }
}

function aggregateUsage(
  input: UsageSummaryInput,
  raw: RawUsageSummary,
  settings: ServerSettings,
): UsageSummary
{
  const buckets = new Map<string, UsageBucketAccumulator>()
  for (const record of raw.records)
  {
    const key = `${record.provider}\0${record.model}`
    const priced = priceUsageRecord({
      model: record.model,
      totals: record.totals,
      reportedCostUsd: record.reportedCostUsd,
      overrides: settings.usagePriceOverrides,
    })
    const current = buckets.get(key) ?? {
      provider: record.provider,
      model: record.model,
      totals: EMPTY_USAGE_TOTALS,
      costUsd: 0,
      records: 0,
      providerReportedRecords: 0,
      customPricedRecords: 0,
      unpricedRecords: 0,
      sessionIds: new Set<string>(),
    }
    current.totals = addUsageTotals(current.totals, record.totals)
    current.costUsd += priced.costUsd
    current.records += 1
    if (record.sessionId.length > 0) current.sessionIds.add(record.sessionId)
    if (priced.source === 'providerReported') current.providerReportedRecords += 1
    if (priced.source === 'customPriced') current.customPricedRecords += 1
    if (priced.source === 'unpriced') current.unpricedRecords += 1
    buckets.set(key, current)
  }

  const ordered = [...buckets.values()].sort(
    (left, right) =>
      right.costUsd - left.costUsd ||
      right.records - left.records ||
      left.model.localeCompare(right.model),
  )
  const bucketLimitExceeded = ordered.length > USAGE_SUMMARY_MAX_BUCKETS
  return {
    readAt: raw.readAt,
    since: input.since,
    until: input.until,
    buckets: ordered
      .slice(0, USAGE_SUMMARY_MAX_BUCKETS)
      .map(({ sessionIds, ...bucket }): UsageModelBucket => ({
        ...bucket,
        sessions: sessionIds.size,
      })),
    sources: raw.sources,
    partial: raw.partial || bucketLimitExceeded,
  }
}

function usageSourceSettings(settings: ServerSettings): ServerSettings
{
  return {
    ...settings,
    providers: {
      ...settings.providers,
      cursor: { ...settings.providers.cursor, enabled: false },
      grok: { ...settings.providers.grok, enabled: false },
      opencode: { ...settings.providers.opencode, enabled: false },
    },
    providerInstances: Object.fromEntries(
      Object.entries(settings.providerInstances).map(([id, instance]) => [
        id,
        instance.driver === 'codex' || instance.driver === 'claudeAgent'
          ? instance
          : { ...instance, enabled: false },
      ]),
    ),
  }
}

export const make = Effect.gen(function* ()
{
  const discovery = yield* ImportDiscovery.ImportDiscovery
  const serverSettings = yield* ServerSettingsService.ServerSettingsService
  const hostPlatform = yield* HostProcessPlatform
  const cache = yield* Ref.make<CachedUsageSummary | null>(null)
  const scanGate = yield* Semaphore.make(1)

  const scanUsage = Effect.fn('UsageSummaryService.scanUsage')(function* (
    input: UsageSummaryInput,
    settings: ServerSettings,
    catalog: SourceCatalogResult,
  )
  {
    const sinceMs = Date.parse(input.since)
    const untilMs = Date.parse(input.until)
    const descriptors = catalog.descriptors.filter(
      (descriptor) => providerForSource(descriptor.source) !== null,
    )
    const sources = makeSourceAccumulators(descriptors)
    const scan = yield* discovery.scan(settings)
    let partial = scan.truncated || scan.errors.length > 0 || catalog.errors.length > 0
    if (partial)
    {
      for (const source of sources.values())
      {
        source.status = 'partial'
        source.message = 'Some transcript locations or files could not be scanned.'
      }
    }

    const candidates = scan.candidates
      .filter((candidate) => providerForSource(candidate.source) !== null)
      .filter((candidate) =>
      {
        const modifiedAt = candidate.modifiedAt === null ? null : Date.parse(candidate.modifiedAt)
        return modifiedAt === null || Number.isNaN(modifiedAt) || modifiedAt >= sinceMs
      })
      .sort(
        (left, right) =>
          (right.modifiedAt === null ? 0 : Date.parse(right.modifiedAt)) -
          (left.modifiedAt === null ? 0 : Date.parse(left.modifiedAt)),
      )

    if (candidates.length > USAGE_SCAN_MAX_FILES)
    {
      partial = true
      for (const candidate of candidates.slice(USAGE_SCAN_MAX_FILES))
      {
        markSourcePartial(
          sourceForCandidate({
            descriptors,
            sources,
            source: candidate.source,
            sourcePath: candidate.sourcePath,
          }),
          'The usage scan reached its file limit.',
        )
      }
    }

    const records: UsageRecord[] = []
    const dedupeKeys = new Set<string>()
    const byteBudget = makeImportByteBudget(USAGE_SCAN_MAX_BYTES)
    for (const candidate of candidates.slice(0, USAGE_SCAN_MAX_FILES))
    {
      const provider = providerForSource(candidate.source)
      if (provider === null) continue
      const source = sourceForCandidate({
        descriptors,
        sources,
        source: candidate.source,
        sourcePath: candidate.sourcePath,
      })
      const resolved = yield* resolveImportSourcePath(
        descriptors,
        candidate.source,
        candidate.sourcePath,
      ).pipe(Effect.result)
      if (resolved._tag === 'Failure')
      {
        partial = true
        markSourcePartial(source, boundedMessage(resolved.failure))
        continue
      }
      const loaded = yield* readResolvedImportSourceFile(resolved.success, byteBudget).pipe(
        Effect.result,
      )
      if (loaded._tag === 'Failure')
      {
        partial = true
        markSourcePartial(source, boundedMessage(loaded.failure))
        if (loaded.failure._tag === 'ImportResourceLimitError') break
        continue
      }

      const parsed = parseUsageTranscript(provider, loaded.success.content)
      if (source)
      {
        source.scannedFiles += 1
        source.malformedRecords += parsed.malformedRecords
      }
      if (parsed.malformedRecords > 0)
      {
        partial = true
        markSourcePartial(
          source,
          `Skipped ${parsed.malformedRecords} malformed usage record${parsed.malformedRecords === 1 ? '' : 's'}.`,
        )
      }
      for (const record of parsed.records)
      {
        if (record.timestampMs < sinceMs || record.timestampMs >= untilMs) continue
        if (record.dedupeKey !== null)
        {
          const dedupeKey = `${record.provider}:${record.dedupeKey}`
          if (dedupeKeys.has(dedupeKey)) continue
          dedupeKeys.add(dedupeKey)
        }
        if (records.length >= USAGE_SCAN_MAX_RECORDS)
        {
          partial = true
          markSourcePartial(source, 'The usage scan reached its record limit.')
          break
        }
        records.push(record)
      }
      if (records.length >= USAGE_SCAN_MAX_RECORDS) break
    }

    const sourceValues = [...sources.values()]
    if (sourceValues.length > USAGE_SUMMARY_MAX_SOURCES) partial = true
    return {
      readAt: DateTime.formatIso(yield* DateTime.now),
      records,
      sources: sourceValues.slice(0, USAGE_SUMMARY_MAX_SOURCES).map(sourceSnapshot),
      partial,
    } satisfies RawUsageSummary
  })

  const getSummary = Effect.fn('UsageSummaryService.getSummary')(function* (
    input: UsageSummaryInput,
  )
  {
    const sinceMs = Date.parse(input.since)
    const untilMs = Date.parse(input.until)
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs)
    {
      return yield* new UsageReadError({
        reason: 'invalid-window',
        detail: 'The usage window must contain valid increasing ISO timestamps.',
      })
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: 'scan-failed',
            detail: 'Server settings could not be read for the usage scan.',
            cause,
          }),
      ),
    )
    const sourceSettings = usageSourceSettings(settings)
    const catalog = yield* resolveSourceCatalog(sourceSettings).pipe(
      Effect.provideService(HostProcessPlatform, hostPlatform),
    )
    const sourceSettingsHash = NodeCrypto.createHash('sha256')
      .update(
        yield* encodeSourceSettings(
          catalog.descriptors.map((descriptor) => ({
            source: descriptor.source,
            providerInstanceId: descriptor.providerInstanceId,
            scanRoot: descriptor.scanRoot,
            layout: descriptor.layout,
          })),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: 'scan-failed',
                detail: 'Provider transcript source settings could not be encoded.',
                cause,
              }),
          ),
        ),
      )
      .digest('hex')
    const cacheKey = `${input.since}\0${input.until}\0${sourceSettingsHash}`
    const raw = yield* scanGate
      .withPermits(1)(
        Effect.gen(function* ()
        {
          const held = yield* Ref.get(cache)
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          if (held?.key === cacheKey && held.expiresAt > now) return held.value
          const value = yield* scanUsage(input, sourceSettings, catalog)
          yield* Ref.set(cache, { key: cacheKey, expiresAt: now + USAGE_SCAN_CACHE_MS, value })
          return value
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isUsageReadError(cause)
            ? cause
            : new UsageReadError({
                reason: 'scan-failed',
                detail: 'Provider transcripts could not be summarized.',
                cause,
              }),
        ),
      )
    return aggregateUsage(input, raw, settings)
  })

  return UsageSummaryService.of({ getSummary })
})

export const layer = Layer.effect(UsageSummaryService, make)
