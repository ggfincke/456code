// apps/server/src/import/continuation.ts
// verifies imported provider sessions and persists resumable runtime bindings
// @effect-diagnostics nodeBuiltinImport:off

import {
  IMPORT_RESULT_MESSAGE_MAX_CHARS,
  type ProviderContinuationIdentity,
  ProviderDriverKind,
  type ModelSelection,
  type ProviderInstanceId,
} from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { ServerConfig } from '../config.ts'
import { ServerSettingsService } from '../serverSettings.ts'
import { ProviderInstanceRegistry } from '../provider/Services/ProviderInstanceRegistry.ts'
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from '../provider/Services/ProviderSessionDirectory.ts'
import {
  IMPORT_CONTINUATION_PRESERVED_BINDING_REASON,
  ImportContinuationDeps,
  type ContinuationOutcome,
  type ContinuationRequest,
} from './continuationContract.ts'
import {
  resolveAcpImportSourceCatalog,
  resolveImportSourcePath,
  resolveSourceCatalog,
} from './sourceCatalog.ts'
import { importedSessionSourceIdentityIssue } from './sourceIdentity.ts'
import type { ImportSource } from './types.ts'

const CODEX = ProviderDriverKind.make('codex')
const CLAUDE = ProviderDriverKind.make('claudeAgent')
const CURSOR = ProviderDriverKind.make('cursor')
const GROK = ProviderDriverKind.make('grok')
const OPENCODE = ProviderDriverKind.make('opencode')

function driverFor(source: ImportSource): ProviderDriverKind
{
  switch (source)
  {
    case 'codex-cli':
      return CODEX
    case 'claude-code':
      return CLAUDE
    case 'opencode':
      return OPENCODE
    case 'cursor':
      return CURSOR
    case 'grok':
      return GROK
  }
}

export interface ResolvedContinuationInstance
{
  readonly instanceId: ProviderInstanceId
  readonly continuationIdentity: ProviderContinuationIdentity
}

// dependency failures are funneled into one tagged error so bind() keeps a
// closed error channel and can always fold failures into a history-only outcome
export class ImportContinuationDepError extends Schema.TaggedErrorClass<ImportContinuationDepError>()(
  'ImportContinuationDepError',
  { message: Schema.String },
)
{}

const isImportContinuationDepError = Schema.is(ImportContinuationDepError)

export interface ImportContinuationFactoryDeps
{
  readonly resolveInstance: (
    driverKind: ProviderDriverKind,
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ResolvedContinuationInstance | null, ImportContinuationDepError>
  readonly verifySource: (input: {
    readonly source: ImportSource
    readonly sourcePath: string
    readonly providerInstanceId: ProviderInstanceId
  }) => Effect.Effect<ProviderContinuationIdentity, ImportContinuationDepError>
  readonly getBinding: (
    threadId: ContinuationRequest['threadId'],
  ) => Effect.Effect<ProviderRuntimeBinding | null, ImportContinuationDepError>
  readonly upsert: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<void, ImportContinuationDepError>
}

function failureReason(cause: Cause.Cause<ImportContinuationDepError>): string
{
  const error = Cause.squash(cause)
  if (isImportContinuationDepError(error) && error.message.trim().length > 0)
  {
    return error.message
  }
  if (error instanceof Error && error.message.trim().length > 0)
  {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0)
  {
    return error.trim()
  }
  return 'continuation binding failed'
}

// wraps arbitrary dependency effects into the closed dep-error channel
export function asDepEffect<A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ImportContinuationDepError, R>
{
  return effect.pipe(
    Effect.catchCause((cause: Cause.Cause<E>) =>
      Effect.fail(
        new ImportContinuationDepError({
          message: `${label}: ${depFailureMessage(cause)}`,
        }),
      ),
    ),
  )
}

function depFailureMessage(cause: Cause.Cause<unknown>): string
{
  const error = Cause.squash(cause)
  if (error instanceof Error && error.message.trim().length > 0)
  {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0)
  {
    return error.trim()
  }
  return 'operation failed'
}

function historyOnly(
  providerInstanceId: ProviderInstanceId,
  reason: string,
  continuationIdentity: ProviderContinuationIdentity | null = null,
): ContinuationOutcome
{
  const normalizedReason = reason.trim() || 'continuation binding failed'
  return {
    state: 'history-only',
    providerInstanceId,
    continuationIdentity,
    reason:
      normalizedReason.length <= IMPORT_RESULT_MESSAGE_MAX_CHARS
        ? normalizedReason
        : `${normalizedReason.slice(0, IMPORT_RESULT_MESSAGE_MAX_CHARS - 1)}…`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resumeCursorMatches(
  driverKind: ProviderDriverKind,
  existing: unknown,
  expected: unknown,
): boolean
{
  if (!isRecord(existing) || !isRecord(expected))
  {
    return false
  }
  if (driverKind === CODEX)
  {
    return (
      existing.threadId === expected.threadId &&
      existing.requireExisting === true &&
      expected.requireExisting === true
    )
  }
  if (driverKind === CLAUDE)
  {
    return existing.threadId === expected.threadId && existing.resume === expected.resume
  }
  return (
    existing.schemaVersion === expected.schemaVersion &&
    existing.sessionId === expected.sessionId &&
    existing.requireExisting === true
  )
}

function modelSelectionMatches(existing: unknown, expected: ModelSelection): boolean
{
  if (
    !isRecord(existing) ||
    existing.instanceId !== expected.instanceId ||
    existing.model !== expected.model
  )
  {
    return false
  }
  if (expected.options === undefined)
  {
    return existing.options === undefined
  }
  const existingOptions = existing.options
  if (!Array.isArray(existingOptions) || existingOptions.length !== expected.options.length)
  {
    return false
  }
  return expected.options.every((expectedOption, index) =>
  {
    const existingOption = existingOptions[index]
    return (
      isRecord(existingOption) &&
      existingOption.id === expectedOption.id &&
      existingOption.value === expectedOption.value
    )
  })
}

function continuationIdentityMatches(
  existing: unknown,
  expected: ProviderContinuationIdentity,
): boolean
{
  return (
    isRecord(existing) &&
    existing.driverKind === expected.driverKind &&
    existing.continuationKey === expected.continuationKey
  )
}

function readContinuationIdentity(
  binding: ProviderRuntimeBinding,
): ProviderContinuationIdentity | null
{
  if (!isRecord(binding.runtimePayload))
  {
    return null
  }
  const value = binding.runtimePayload.continuationIdentity
  if (
    !isRecord(value) ||
    typeof value.driverKind !== 'string' ||
    typeof value.continuationKey !== 'string' ||
    value.continuationKey.trim().length === 0
  )
  {
    return null
  }
  return {
    driverKind: ProviderDriverKind.make(value.driverKind),
    continuationKey: value.continuationKey,
  }
}

function runtimePayloadMatches(
  binding: ProviderRuntimeBinding,
  request: ContinuationRequest,
): boolean
{
  if (binding.runtimeMode !== request.runtimeMode || !isRecord(binding.runtimePayload))
  {
    return false
  }
  return (
    binding.runtimePayload.cwd === request.meta.cwd &&
    modelSelectionMatches(binding.runtimePayload.modelSelection, request.modelSelection)
  )
}

function isPristineImportedBinding(
  binding: ProviderRuntimeBinding,
  driverKind: ProviderDriverKind,
): boolean
{
  if (
    binding.status !== 'stopped' ||
    binding.adapterKey !== driverKind ||
    !isRecord(binding.runtimePayload)
  )
  {
    return false
  }
  const payloadKeys = Object.keys(binding.runtimePayload)
  return (
    payloadKeys.length === 3 &&
    payloadKeys.includes('cwd') &&
    payloadKeys.includes('modelSelection') &&
    payloadKeys.includes('continuationIdentity')
  )
}

export function makeImportContinuation(deps: ImportContinuationFactoryDeps): {
  readonly bind: (request: ContinuationRequest) => Effect.Effect<ContinuationOutcome>
}
{
  const bind = (request: ContinuationRequest): Effect.Effect<ContinuationOutcome> =>
    deps.getBinding(request.threadId).pipe(
      Effect.flatMap((existingBinding) =>
      {
        const driverKind = driverFor(request.meta.source)
        const persistedIdentity =
          existingBinding === null ? null : readContinuationIdentity(existingBinding)
        const preservedBinding = () =>
          historyOnly(
            request.providerInstanceId,
            IMPORT_CONTINUATION_PRESERVED_BINDING_REASON,
            persistedIdentity,
          )
        const historyOnlyUnlessBound = (
          reason: string,
          continuationIdentity: ProviderContinuationIdentity | null = null,
        ) =>
          existingBinding === null
            ? historyOnly(request.providerInstanceId, reason, continuationIdentity)
            : preservedBinding()
        let resolvedIdentity: ProviderContinuationIdentity | null = null

        return Effect.gen(function* ()
        {
          const instance = yield* deps.resolveInstance(driverKind, request.providerInstanceId)
          const currentIdentity = instance?.continuationIdentity
          resolvedIdentity = currentIdentity ?? null
          const sourceIdentityIssue = importedSessionSourceIdentityIssue(request.meta)
          if (sourceIdentityIssue !== null)
          {
            return historyOnlyUnlessBound(sourceIdentityIssue, currentIdentity)
          }
          const nativeSessionId = request.meta.nativeSessionId
          if (nativeSessionId === null)
          {
            return historyOnlyUnlessBound('native session id is missing', currentIdentity)
          }
          if (request.meta.cwd === null)
          {
            return historyOnlyUnlessBound('session has no cwd', currentIdentity)
          }

          const resumeCursor =
            driverKind === CODEX
              ? { threadId: nativeSessionId, requireExisting: true }
              : driverKind === CLAUDE
                ? { threadId: request.threadId, resume: nativeSessionId }
                : {
                    schemaVersion: 1,
                    sessionId: nativeSessionId,
                    requireExisting: true,
                  }
          const existingBindingMatches =
            existingBinding !== null &&
            existingBinding.provider === driverKind &&
            existingBinding.providerInstanceId === request.providerInstanceId &&
            resumeCursorMatches(driverKind, existingBinding.resumeCursor, resumeCursor)

          if (instance === null)
          {
            return historyOnlyUnlessBound(
              `provider instance '${request.providerInstanceId}' is not available for ${driverKind}`,
            )
          }
          if (request.modelSelection.instanceId !== instance.instanceId)
          {
            return historyOnlyUnlessBound(
              `model selection targets '${request.modelSelection.instanceId}', expected '${instance.instanceId}'`,
              currentIdentity,
            )
          }
          const desiredBinding = {
            threadId: request.threadId,
            provider: driverKind,
            providerInstanceId: request.providerInstanceId,
            adapterKey: driverKind,
            status: 'stopped',
            runtimeMode: request.runtimeMode,
            resumeCursor,
            runtimePayload: {
              cwd: request.meta.cwd,
              modelSelection: request.modelSelection,
              continuationIdentity: instance.continuationIdentity,
            },
          } satisfies ProviderRuntimeBinding

          const sourceIdentity = yield* deps.verifySource({
            source: request.meta.source,
            sourcePath: request.meta.sourcePath,
            providerInstanceId: instance.instanceId,
          })
          if (!continuationIdentityMatches(sourceIdentity, instance.continuationIdentity))
          {
            return historyOnlyUnlessBound(
              `provider instance '${instance.instanceId}' no longer targets the imported continuation source`,
              instance.continuationIdentity,
            )
          }
          if (existingBinding !== null)
          {
            if (!existingBindingMatches)
            {
              return preservedBinding()
            }
            if (
              !continuationIdentityMatches(
                readContinuationIdentity(existingBinding),
                instance.continuationIdentity,
              )
            )
            {
              return preservedBinding()
            }
            if (!runtimePayloadMatches(existingBinding, request))
            {
              if (!isPristineImportedBinding(existingBinding, driverKind))
              {
                return preservedBinding()
              }
              yield* deps.upsert(desiredBinding)
            }
            return {
              state: 'verified',
              providerInstanceId: instance.instanceId,
              continuationIdentity: instance.continuationIdentity,
              reason: null,
            } satisfies ContinuationOutcome
          }

          yield* deps.upsert(desiredBinding)
          return {
            state: 'verified',
            providerInstanceId: instance.instanceId,
            continuationIdentity: instance.continuationIdentity,
            reason: null,
          } satisfies ContinuationOutcome
        }).pipe(
          Effect.catchCause((cause: Cause.Cause<ImportContinuationDepError>) =>
            Effect.succeed(
              existingBinding === null
                ? historyOnly(request.providerInstanceId, failureReason(cause), resolvedIdentity)
                : preservedBinding(),
            ),
          ),
        )
      }),
      Effect.catchCause((_cause: Cause.Cause<ImportContinuationDepError>) =>
        Effect.succeed(
          historyOnly(request.providerInstanceId, IMPORT_CONTINUATION_PRESERVED_BINDING_REASON),
        ),
      ),
    )

  return { bind }
}

const makeImportContinuationLive = Effect.gen(function* ()
{
  const directory = yield* ProviderSessionDirectory
  const registry = yield* ProviderInstanceRegistry
  const serverConfig = yield* ServerConfig
  const serverSettings = yield* ServerSettingsService

  return makeImportContinuation({
    resolveInstance: (driverKind, requestedInstanceId) =>
      asDepEffect(
        'resolve provider instance',
        Effect.gen(function* ()
        {
          const instance = yield* registry.getInstance(requestedInstanceId)
          if (instance === undefined || instance.driverKind !== driverKind || !instance.enabled)
          {
            return null
          }
          return {
            instanceId: instance.instanceId,
            continuationIdentity: yield* instance.resolveContinuationIdentity,
          }
        }),
      ),
    verifySource: ({ source, sourcePath, providerInstanceId }) =>
      asDepEffect(
        'verify continuation source',
        Effect.gen(function* ()
        {
          if (source === 'cursor' || source === 'grok')
          {
            const settings = yield* serverSettings.getSettings
            const catalog = yield* resolveAcpImportSourceCatalog(settings, {
              cwd: serverConfig.cwd,
            })
            const descriptor = catalog.descriptors.find(
              (candidate) =>
                candidate.source === source && candidate.providerInstanceId === providerInstanceId,
            )
            if (descriptor === undefined)
            {
              return yield* new ImportContinuationDepError({
                message: `provider instance '${providerInstanceId}' has no importable ${source} continuation source`,
              })
            }
            return descriptor.continuationIdentity
          }
          const settings = yield* serverSettings.getSettings
          const catalog = yield* resolveSourceCatalog(settings, {
            cwd: serverConfig.cwd,
          })
          const exactDescriptors = catalog.descriptors.filter(
            (descriptor) =>
              descriptor.source === source && descriptor.providerInstanceId === providerInstanceId,
          )
          yield* resolveImportSourcePath(exactDescriptors, source, sourcePath)
          const descriptor = exactDescriptors[0]
          if (descriptor === undefined)
          {
            return yield* new ImportContinuationDepError({
              message: `provider instance '${providerInstanceId}' has no importable ${source} continuation source`,
            })
          }
          return descriptor.continuationIdentity
        }),
      ),
    getBinding: (threadId) =>
      asDepEffect(
        'read existing session binding',
        directory.getBinding(threadId).pipe(
          Effect.map((binding) =>
            Option.match(binding, {
              onNone: () => null,
              onSome: (value) => value,
            }),
          ),
        ),
      ),
    upsert: (binding) => asDepEffect('persist session binding', directory.upsert(binding)),
  })
})

export const ImportContinuationLive = Layer.effect(
  ImportContinuationDeps,
  makeImportContinuationLive,
)
