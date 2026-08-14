// tests/apps/server/import/importService.test.ts
// verifies import command ordering, skips, continuation, and stable identifiers

// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ImportSessionsRequest,
  type ModelSelection,
  type OrchestrationCommand,
} from '@t3tools/contracts'
import { afterEach, describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import { TestClock } from 'effect/testing'

import {
  IMPORT_CONTINUATION_PRESERVED_BINDING_REASON,
  ImportContinuationDeps,
  type ContinuationOutcome,
  type ContinuationRequest,
} from '../../../../apps/server/src/import/continuation/continuationContract.ts'
import {
  ACP_IMPORT_REQUEST_DEADLINE_MS,
  ImportServiceDeps,
  make,
  type ImportedThreadMatch,
  type ImportRequestContext,
  type ImportServiceDepsShape,
  type ResolvedImportTarget,
} from '../../../../apps/server/src/import/importService.ts'
import type {
  AcpImportBatchLoadResult,
  AcpImportedSession,
} from '../../../../apps/server/src/import/parsers/acpImport.ts'
import type { ImportFileSourceDescriptor } from '../../../../apps/server/src/import/discovery/sourceCatalog.ts'
import type { ImportSource } from '../../../../apps/server/src/import/types.ts'
import { fileContinuationIdentity } from '../../../../apps/server/src/provider/continuationIdentity.ts'
import type {
  ImportReplacementIntent,
  ImportReplacementIntentRepositoryShape,
} from '../../../../apps/server/src/persistence/Services/ImportReplacementIntents.ts'
import { ACTIVE_IMPORT_REPLACEMENT_VERSION } from '../../../../apps/server/src/persistence/Services/ImportReplacementIntents.ts'

const temporaryPaths: string[] = []

function makeReplacementIntentMemory(): ImportReplacementIntentRepositoryShape
{
  const rows = new Map<string, ImportReplacementIntent>()
  return {
    getByIntentKey: (intentKey) => Effect.succeed(Option.fromNullishOr(rows.get(intentKey))),
    findOpenBySourceIdentity: (identity) =>
      Effect.succeed(
        Option.fromNullishOr(
          [...rows.values()].find(
            (row) =>
              row.phase !== 'retired' &&
              row.source === identity.source &&
              row.sourcePath === identity.sourcePath &&
              row.nativeSessionId === identity.nativeSessionId &&
              row.providerInstanceId === identity.providerInstanceId,
          ),
        ),
      ),
    insertIfAbsent: (intent) =>
      Effect.sync(() =>
      {
        const existing = rows.get(intent.intentKey)
        if (existing !== undefined) return existing
        rows.set(intent.intentKey, intent)
        return intent
      }),
    casTransition: (transition) =>
      Effect.sync(() =>
      {
        const current = rows.get(transition.intentKey)
        if (current === undefined || current.phase !== transition.expectedPhase) return false
        rows.set(transition.intentKey, {
          ...current,
          phase: transition.nextPhase,
          threadEvidence: transition.threadEvidence,
          attachmentEvidence: transition.attachmentEvidence,
          indexEvidence: transition.indexEvidence,
          attemptCount: transition.attemptCount,
          lastError: transition.lastError,
          retryAfter: transition.retryAfter,
          updatedAt: transition.updatedAt,
        })
        return true
      }),
    listOpen: () => Effect.succeed([...rows.values()].filter((row) => row.phase !== 'retired')),
    retire: (input) =>
      Effect.sync(() =>
      {
        const current = rows.get(input.intentKey)
        if (current === undefined || current.phase !== input.expectedPhase) return false
        rows.set(input.intentKey, {
          ...current,
          phase: 'retired',
          updatedAt: input.retiredAt,
          retiredAt: input.retiredAt,
        })
        return true
      }),
  }
}

function replacementIntentFixture(
  phase: ImportReplacementIntent['phase'],
  suffix: string,
  options: { readonly withEvidence?: boolean } = {},
): ImportReplacementIntent
{
  const replacementThreadId = ThreadId.make(`replacement-${suffix}`)
  const replacementProjectId = ProjectId.make(`replacement-project-${suffix}`)
  const sourceVersion = suffix.padEnd(64, '0').slice(0, 64)
  const withEvidence = options.withEvidence ?? false
  return {
    intentKey: `intent-${suffix}`,
    source: 'codex-cli',
    sourcePath: `/imports/${suffix}.jsonl`,
    nativeSessionId: `native-${suffix}`,
    providerInstanceId: ProviderInstanceId.make('codex'),
    originalWorkspaceRoot: null,
    sourceVersion,
    replacementVersion: ACTIVE_IMPORT_REPLACEMENT_VERSION,
    sourceThreadId: ThreadId.make(`source-${suffix}`),
    sourceProjectId: ProjectId.make(`source-project-${suffix}`),
    replacementThreadId,
    replacementProjectId,
    replacementWorkspaceRoot: '/workspace/imported',
    createCommandId: CommandId.make(`create-${suffix}`),
    tombstoneCommandId: CommandId.make(`delete-${suffix}`),
    expectedMessageCount: 1,
    expectedActivityCount: 0,
    expectedRecordFingerprint: `records-${suffix}`,
    phase,
    threadEvidence: withEvidence
      ? {
          replacementThreadId,
          projectId: replacementProjectId,
          sourceVersion,
          messageCount: 1,
          activityCount: 0,
          snapshotSequence: 1,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        }
      : null,
    attachmentEvidence: withEvidence
      ? {
          replacementThreadId,
          expectedRelativePaths: [],
          exactSetVerified: true,
          sourceCleanupComplete: false,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        }
      : null,
    indexEvidence: null,
    attemptCount: 0,
    lastError: phase === 'manual' ? 'operator review required' : null,
    retryAfter: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
  }
}

function continuationIdentityFor(request: ContinuationRequest)
{
  const driverKind = ProviderDriverKind.make(
    request.meta.source === 'claude-code'
      ? 'claudeAgent'
      : request.meta.source === 'codex-cli'
        ? 'codex'
        : request.meta.source,
  )
  return {
    driverKind,
    continuationKey: `${driverKind}:instance:${request.providerInstanceId}`,
  }
}

async function temporaryDirectory(): Promise<string>
{
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-import-service-'))
  temporaryPaths.push(directory)
  return directory
}

async function temporaryFile(content: string): Promise<string>
{
  const directory = await temporaryDirectory()
  const sessionDirectory = NodePath.join(directory, '2026', '01', '01')
  await NodeFSP.mkdir(sessionDirectory, { recursive: true })
  const path = NodePath.join(sessionDirectory, 'rollout-test.jsonl')
  await NodeFSP.writeFile(path, content)
  return path
}

afterEach(async () =>
{
  await Promise.all(temporaryPaths.splice(0).map((path) => NodeFSP.rm(path, { recursive: true })))
})

function rollout(messageCount: number, cwd = '/workspace/imported'): string
{
  const lines = [
    `{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"native","cwd":"${cwd}","model_provider":"openai"}}`,
    `{"timestamp":"2026-01-01T00:00:00Z","type":"turn_context","payload":{"cwd":"${cwd}","model":"gpt-imported"}}`,
  ]
  for (let index = 0; index < messageCount; index += 1)
  {
    lines.push(
      `{"timestamp":"2026-01-01T00:00:${String((index % 59) + 1).padStart(2, '0')}Z","type":"event_msg","payload":{"type":"user_message","message":"message ${index}"}}`,
    )
  }
  return lines.join('\n')
}

function sizedAcpSession(input: {
  readonly sourcePath: string
  readonly nativeSessionId: string
  readonly serializedBytes: number
}): AcpImportedSession
{
  const makeSession = (text: string): AcpImportedSession => ({
    meta: {
      source: 'cursor-acp',
      sourcePath: input.sourcePath,
      contentHash: 'e'.repeat(64),
      nativeSessionId: input.nativeSessionId,
      cwd: '/workspace/cursor',
      gitBranch: null,
      model: 'cursor-model',
      title: 'Bounded Cursor import',
      firstActivityAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    },
    records: [
      {
        kind: 'message',
        role: 'user',
        text,
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceIndex: 0,
      },
    ],
    warnings: [],
  })
  const emptyTextBytes = Buffer.byteLength(JSON.stringify(makeSession('')), 'utf8')
  if (emptyTextBytes >= input.serializedBytes)
  {
    throw new Error(
      `ACP session fixture needs more than ${emptyTextBytes} bytes to reach its target`,
    )
  }
  return makeSession('x'.repeat(input.serializedBytes - emptyTextBytes))
}

function runImport(input: {
  readonly sourcePath: string
  readonly sourcePaths?: ReadonlyArray<string>
  readonly source?: Extract<ImportSource, 'codex-cli' | 'claude-code'>
  readonly scanRoot?: string
  readonly sourceLayout?: ImportFileSourceDescriptor['layout']
  readonly existingThreadId?: ThreadId
  readonly existingContentHash?: string
  readonly existingArchived?: boolean
  readonly existingFinalized?: boolean
  readonly existingProjectId?: ProjectId
  readonly existingModelSelection?: ModelSelection
  readonly providerInstanceId?: ProviderInstanceId
  readonly followupProviderInstanceId?: ProviderInstanceId
  readonly compatibleInstanceIds?: ReadonlyArray<ProviderInstanceId>
  readonly resolvedTarget?: ResolvedImportTarget | null
  readonly threadExists?: boolean
  readonly continuationOutcome?: ContinuationOutcome
  readonly itemCount?: number
  readonly deleteProjectBeforeFirstThreadCreate?: boolean
  readonly maximumRequestBytes?: number
  readonly maximumRequestRecords?: number
  readonly resolveImportWorkspaceRoot?: ImportServiceDepsShape['resolveImportWorkspaceRoot']
})
{
  const commands: OrchestrationCommand[] = []
  const continuations: ContinuationRequest[] = []
  const targetResolutions: Array<{
    readonly requestedInstanceId: ProviderInstanceId | null
    readonly compatibleInstanceIds: ReadonlyArray<ProviderInstanceId>
  }> = []
  const source = input.source ?? 'codex-cli'
  const driverKind = ProviderDriverKind.make(source === 'codex-cli' ? 'codex' : 'claudeAgent')
  const defaultInstanceId = ProviderInstanceId.make(source === 'codex-cli' ? 'codex' : 'claude')
  const compatibleInstanceIds = input.compatibleInstanceIds ?? [defaultInstanceId]
  const inferredScanRoot = NodePath.resolve(NodePath.dirname(input.sourcePath), '..', '..', '..')
  const scanRoot =
    input.scanRoot ??
    (NodePath.basename(inferredScanRoot).startsWith('456code-import-service-')
      ? inferredScanRoot
      : NodeOS.tmpdir())
  const sourceDescriptors: ImportFileSourceDescriptor[] = compatibleInstanceIds.map(
    (providerInstanceId) => ({
      source,
      driverKind,
      providerInstanceId,
      scanRoot,
      ...(input.sourceLayout === undefined ? {} : { layout: input.sourceLayout }),
      continuationIdentity: fileContinuationIdentity(driverKind, scanRoot),
    }),
  )
  let activeProjectId =
    input.existingProjectId ??
    (input.existingThreadId === undefined ? null : ProjectId.make('existing-project'))
  const activeThreadIds = new Set<ThreadId>()
  const createdThreads = new Map<ThreadId, ImportedThreadMatch>()
  const replacementIntents = makeReplacementIntentMemory()
  let existingThreadDeleted = false
  const visibleThreadCounts = [input.existingThreadId === undefined ? 0 : 1]
  const tombstonedProjectIds = new Set<ProjectId>()
  let injectedProjectDelete = false
  return make.pipe(
    Effect.provideService(
      ImportServiceDeps,
      ImportServiceDeps.of({
        dispatch: (command) =>
          Effect.suspend(() =>
          {
            commands.push(command)
            if (
              command.type === 'project.create' &&
              activeProjectId === null &&
              !tombstonedProjectIds.has(command.projectId)
            )
            {
              activeProjectId = command.projectId
            }
            if (
              command.type === 'thread.create' &&
              input.deleteProjectBeforeFirstThreadCreate === true &&
              !injectedProjectDelete
            )
            {
              injectedProjectDelete = true
              if (activeProjectId !== null)
              {
                tombstonedProjectIds.add(activeProjectId)
              }
              activeProjectId = null
              return Effect.fail(new Error('project was deleted at the thread creation barrier'))
            }
            if (
              command.type === 'thread.create' &&
              (input.threadExists ?? true) &&
              activeProjectId === command.projectId
            )
            {
              activeThreadIds.add(command.threadId)
              createdThreads.set(command.threadId, {
                threadId: command.threadId,
                projectId: command.projectId,
                contentHash: command.origin?.contentHash ?? '',
                source: command.origin?.source ?? source,
                sourcePath: command.origin?.sourcePath ?? input.sourcePath,
                nativeSessionId: command.origin?.nativeSessionId ?? null,
                providerInstanceId: command.origin?.providerInstanceId ?? null,
                modelSelection: command.modelSelection,
                archived: false,
              })
            }
            if (command.type === 'thread.delete')
            {
              activeThreadIds.delete(command.threadId)
              createdThreads.delete(command.threadId)
              if (command.threadId === input.existingThreadId) existingThreadDeleted = true
            }
            visibleThreadCounts.push(
              activeThreadIds.size +
                (input.existingThreadId !== undefined && !existingThreadDeleted ? 1 : 0),
            )
            return Effect.succeed({ sequence: commands.length })
          }),
        findThreadByContentHash: (lookup) =>
          Effect.succeed(
            input.existingThreadId === undefined || existingThreadDeleted
              ? null
              : {
                  threadId: input.existingThreadId,
                  projectId: input.existingProjectId ?? ProjectId.make('existing-project'),
                  contentHash: input.existingContentHash ?? lookup.contentHash,
                  source: lookup.source,
                  sourcePath: lookup.sourcePath,
                  nativeSessionId: lookup.nativeSessionId,
                  providerInstanceId: lookup.providerInstanceId,
                  modelSelection: input.existingModelSelection ?? {
                    instanceId: defaultInstanceId,
                    model: 'gpt-imported',
                  },
                  archived: input.existingArchived ?? false,
                },
          ),
        findThreadById: (threadId) =>
          Effect.succeed(
            createdThreads.get(threadId) ??
              (threadId === input.existingThreadId && !existingThreadDeleted
                ? {
                    threadId,
                    projectId: input.existingProjectId ?? ProjectId.make('existing-project'),
                    contentHash: input.existingContentHash ?? '',
                    source,
                    sourcePath: input.sourcePath,
                    nativeSessionId: 'native',
                    providerInstanceId: input.providerInstanceId ?? defaultInstanceId,
                    modelSelection: input.existingModelSelection ?? {
                      instanceId: defaultInstanceId,
                      model: 'gpt-imported',
                    },
                    archived: input.existingArchived ?? false,
                  }
                : null),
          ),
        findProjectByWorkspaceRoot: () => Effect.succeed(activeProjectId),
        isImportFinalized: () => Effect.succeed(input.existingFinalized ?? true),
        normalizeWorkspaceRoot: (root) => Effect.succeed(root),
        resolveImportWorkspaceRoot:
          input.resolveImportWorkspaceRoot ??
          ((request) =>
            Effect.succeed({
              workspaceRoot:
                request.existingWorkspaceRoot ??
                request.recordedWorkspaceRoot ??
                '/workspace/imported-history',
              ...(request.originalWorkspaceRoot === undefined
                ? {}
                : { originalWorkspaceRoot: request.originalWorkspaceRoot }),
            })),
        threadExistsInShell: (threadId) =>
          Effect.succeed(input.existingThreadId === threadId || activeThreadIds.has(threadId)),
        replacementIntents,
        verifyReplacementThread: (replacement) =>
          Effect.succeed({
            replacementThreadId: replacement.replacementThreadId,
            projectId: replacement.replacementProjectId,
            sourceVersion: replacement.sourceVersion,
            messageCount: replacement.expectedMessageCount,
            activityCount: replacement.expectedActivityCount,
            snapshotSequence: 0,
            verifiedAt: '2026-01-01T00:00:00.000Z',
          }),
        verifyReplacementAttachments: () => Effect.succeed({ complete: true }),
        cleanupDeletedThreadAttachments: () => Effect.succeed({ complete: true }),
        verifyReplacementIndex: ({ replacementThreadId, sourceThreadId }) =>
          Effect.succeed({
            replacementVisible: activeThreadIds.has(replacementThreadId),
            sourceVisible: !existingThreadDeleted && sourceThreadId === input.existingThreadId,
          }),
        ...(input.maximumRequestBytes === undefined
          ? {}
          : { maximumRequestBytes: input.maximumRequestBytes }),
        ...(input.maximumRequestRecords === undefined
          ? {}
          : { maximumRequestRecords: input.maximumRequestRecords }),
        loadRequestContext: () =>
          Effect.succeed({
            fallbackModelSelection: {
              instanceId: ProviderInstanceId.make('fallback'),
              model: 'gpt-fallback',
            },
            sourceDescriptors,
            resolveImportTarget: (_driver, requestedInstanceId, compatibleIds) =>
              Effect.sync(() =>
              {
                targetResolutions.push({
                  requestedInstanceId,
                  compatibleInstanceIds: compatibleIds,
                })
                return input.resolvedTarget === undefined
                  ? {
                      defaultModelSelection: {
                        instanceId: defaultInstanceId,
                        model: 'gpt-fallback',
                      },
                      availableModels: ['gpt-fallback', 'gpt-imported'],
                    }
                  : input.resolvedTarget
              }),
            loadAcpSessionsBatch: () => Effect.succeed([]),
          }),
      }),
    ),
    Effect.provideService(
      ImportContinuationDeps,
      ImportContinuationDeps.of({
        bind: (request) =>
          Effect.sync(() =>
          {
            continuations.push(request)
            return (
              input.continuationOutcome ?? {
                state: 'verified',
                providerInstanceId: request.providerInstanceId,
                continuationIdentity: continuationIdentityFor(request),
                reason: null,
              }
            )
          }),
      }),
    ),
    Effect.flatMap((service) =>
      Effect.gen(function* ()
      {
        const result = yield* service.importSessions({
          items: (
            input.sourcePaths ??
            Array.from({ length: input.itemCount ?? 1 }, () => input.sourcePath)
          ).map((sourcePath) => ({
            source,
            sourcePath,
            providerInstanceId:
              input.providerInstanceId === undefined ? defaultInstanceId : input.providerInstanceId,
          })),
        })
        const followupResult =
          input.followupProviderInstanceId === undefined
            ? null
            : yield* service.importSessions({
                items: [
                  {
                    source: 'codex-cli',
                    sourcePath: input.sourcePath,
                    providerInstanceId: input.followupProviderInstanceId,
                  },
                ],
              })
        return { followupResult, result }
      }),
    ),
    Effect.map(({ followupResult, result }) => ({
      commands,
      continuations,
      followupResult,
      result,
      targetResolutions,
      visibleThreadCounts,
    })),
  )
}

function commandIdentifiers(commands: ReadonlyArray<OrchestrationCommand>): string[][]
{
  return commands.map((command) =>
  {
    const identifiers: string[] = [command.commandId]
    if ('projectId' in command) identifiers.push(command.projectId)
    if ('threadId' in command) identifiers.push(command.threadId)
    if (command.type === 'thread.messages.import')
    {
      identifiers.push(
        ...command.messages.map((message) => message.messageId),
        ...command.activities.map((activity) => activity.id),
      )
    }
    if (command.type === 'thread.activity.append') identifiers.push(command.activity.id)
    return identifiers
  })
}

function runStretchImport(input: {
  readonly source: Extract<ImportSource, 'opencode' | 'cursor' | 'grok'>
  readonly sourcePath: string
  readonly providerInstanceId: ProviderInstanceId
  readonly sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor>
  readonly acpSession?: AcpImportedSession
  readonly items?: ImportSessionsRequest['items']
  readonly loadAcpSessionsBatch?: ImportRequestContext['loadAcpSessionsBatch']
  readonly maximumRequestBytes?: number
  readonly maximumRequestRecords?: number
  readonly requestDeadlineMs?: number
  readonly dispatch?: (command: OrchestrationCommand) => Effect.Effect<unknown, Error>
})
{
  const commands: OrchestrationCommand[] = []
  const continuations: ContinuationRequest[] = []
  const resolvedDrivers: ProviderDriverKind[] = []
  const acpLoads: Array<{
    readonly source: 'cursor' | 'grok'
    readonly sourcePaths: ReadonlyArray<string>
    readonly providerInstanceId: ProviderInstanceId
    readonly maximumBytes: number
  }> = []
  let activeProjectId: ProjectId | null = null
  const activeThreadIds = new Set<ThreadId>()
  const fallbackInstanceId = ProviderInstanceId.make('fallback')
  const replacementIntents = makeReplacementIntentMemory()
  return make.pipe(
    Effect.provideService(
      ImportServiceDeps,
      ImportServiceDeps.of({
        dispatch: (command) =>
          Effect.sync(() =>
          {
            commands.push(command)
            if (command.type === 'project.create' && activeProjectId === null)
            {
              activeProjectId = command.projectId
            }
            if (command.type === 'thread.create' && activeProjectId === command.projectId)
            {
              activeThreadIds.add(command.threadId)
            }
            return { sequence: commands.length }
          }).pipe(
            Effect.flatMap((defaultResult) =>
              input.dispatch === undefined
                ? Effect.succeed(defaultResult)
                : input.dispatch(command),
            ),
          ),
        findThreadByContentHash: () => Effect.succeed(null),
        findThreadById: () => Effect.succeed(null),
        findProjectByWorkspaceRoot: () => Effect.succeed(activeProjectId),
        isImportFinalized: () => Effect.succeed(true),
        normalizeWorkspaceRoot: (root) => Effect.succeed(root),
        resolveImportWorkspaceRoot: (request) =>
          Effect.succeed({
            workspaceRoot:
              request.existingWorkspaceRoot ??
              request.recordedWorkspaceRoot ??
              '/workspace/imported-history',
            ...(request.originalWorkspaceRoot === undefined
              ? {}
              : { originalWorkspaceRoot: request.originalWorkspaceRoot }),
          }),
        threadExistsInShell: (threadId) => Effect.succeed(activeThreadIds.has(threadId)),
        replacementIntents,
        verifyReplacementThread: () => Effect.succeed(null),
        verifyReplacementAttachments: () => Effect.succeed({ complete: true }),
        cleanupDeletedThreadAttachments: () => Effect.succeed({ complete: true }),
        verifyReplacementIndex: ({ replacementThreadId, sourceThreadId }) =>
          Effect.succeed({
            replacementVisible: activeThreadIds.has(replacementThreadId),
            sourceVisible: activeThreadIds.has(sourceThreadId),
          }),
        ...(input.maximumRequestBytes === undefined
          ? {}
          : { maximumRequestBytes: input.maximumRequestBytes }),
        ...(input.maximumRequestRecords === undefined
          ? {}
          : { maximumRequestRecords: input.maximumRequestRecords }),
        ...(input.requestDeadlineMs === undefined
          ? {}
          : { requestDeadlineMs: input.requestDeadlineMs }),
        loadRequestContext: () =>
          Effect.succeed({
            fallbackModelSelection: {
              instanceId: fallbackInstanceId,
              model: 'fallback-model',
            },
            sourceDescriptors: input.sourceDescriptors,
            resolveImportTarget: (driver, requestedInstanceId, compatibleInstanceIds) =>
              Effect.sync(() =>
              {
                resolvedDrivers.push(driver)
                if (
                  requestedInstanceId === null ||
                  !compatibleInstanceIds.includes(requestedInstanceId)
                )
                {
                  return null
                }
                return {
                  defaultModelSelection: {
                    instanceId: requestedInstanceId,
                    model: 'fallback-model',
                  },
                  availableModels: ['fallback-model', 'openai/gpt-5.2', 'cursor-model'],
                }
              }),
            loadAcpSessionsBatch: (request) =>
              Effect.gen(function* ()
              {
                acpLoads.push({
                  source: request.source,
                  sourcePaths: request.sourcePaths,
                  providerInstanceId: request.providerInstanceId,
                  maximumBytes: request.maximumBytes,
                })
                if (input.loadAcpSessionsBatch !== undefined)
                {
                  return yield* input.loadAcpSessionsBatch(request)
                }
                if (input.acpSession === undefined)
                {
                  return yield* Effect.die('unexpected ACP session load')
                }
                return request.sourcePaths.map(
                  (sourcePath) =>
                    ({
                      sourcePath,
                      descriptor: {
                        driverKind: request.source,
                        providerInstanceId: request.providerInstanceId,
                        source: request.source === 'cursor' ? 'cursor-acp' : 'grok-acp',
                        sourcePath,
                        nativeSessionId: input.acpSession!.meta.nativeSessionId,
                        cwd: input.acpSession!.meta.cwd,
                        title: input.acpSession!.meta.title,
                        updatedAt: input.acpSession!.meta.lastActivityAt,
                      },
                      session: input.acpSession!,
                      error: null,
                    }) satisfies AcpImportBatchLoadResult,
                )
              }),
          }),
      }),
    ),
    Effect.provideService(
      ImportContinuationDeps,
      ImportContinuationDeps.of({
        bind: (request) =>
          Effect.sync(() =>
          {
            continuations.push(request)
            return {
              state: 'verified',
              providerInstanceId: request.providerInstanceId,
              continuationIdentity: continuationIdentityFor(request),
              reason: null,
            }
          }),
      }),
    ),
    Effect.flatMap((service) =>
      service.importSessions({
        items: input.items ?? [
          {
            source: input.source,
            sourcePath: input.sourcePath,
            providerInstanceId: input.providerInstanceId,
          },
        ],
      }),
    ),
    Effect.map((result) => ({
      commands,
      continuations,
      result,
      resolvedDrivers,
      acpLoads,
    })),
  )
}

function runCrossSourceHashImport()
{
  const commands: OrchestrationCommand[] = []
  const cursorInstanceId = ProviderInstanceId.make('cursor_exact')
  const grokInstanceId = ProviderInstanceId.make('grok_exact')
  const sharedContentHash = 'c'.repeat(64)
  const activeThreadIds = new Set<ThreadId>()
  const replacementIntents = makeReplacementIntentMemory()
  return make.pipe(
    Effect.provideService(
      ImportServiceDeps,
      ImportServiceDeps.of({
        dispatch: (command) =>
          Effect.sync(() =>
          {
            commands.push(command)
            if (command.type === 'thread.create')
            {
              activeThreadIds.add(command.threadId)
            }
            return { sequence: commands.length }
          }),
        findThreadByContentHash: () => Effect.succeed(null),
        findThreadById: () => Effect.succeed(null),
        findProjectByWorkspaceRoot: () => Effect.succeed(ProjectId.make('existing-project')),
        isImportFinalized: () => Effect.succeed(true),
        normalizeWorkspaceRoot: (root) => Effect.succeed(root),
        resolveImportWorkspaceRoot: (request) =>
          Effect.succeed({
            workspaceRoot:
              request.existingWorkspaceRoot ??
              request.recordedWorkspaceRoot ??
              '/workspace/imported-history',
          }),
        threadExistsInShell: (threadId) => Effect.succeed(activeThreadIds.has(threadId)),
        replacementIntents,
        verifyReplacementThread: () => Effect.succeed(null),
        verifyReplacementAttachments: () => Effect.succeed({ complete: true }),
        cleanupDeletedThreadAttachments: () => Effect.succeed({ complete: true }),
        verifyReplacementIndex: ({ replacementThreadId, sourceThreadId }) =>
          Effect.succeed({
            replacementVisible: activeThreadIds.has(replacementThreadId),
            sourceVisible: activeThreadIds.has(sourceThreadId),
          }),
        loadRequestContext: () =>
          Effect.succeed({
            fallbackModelSelection: {
              instanceId: ProviderInstanceId.make('fallback'),
              model: 'fallback-model',
            },
            sourceDescriptors: [],
            resolveImportTarget: (driver, requestedInstanceId) =>
              Effect.succeed(
                requestedInstanceId === null
                  ? null
                  : {
                      defaultModelSelection: {
                        instanceId: requestedInstanceId,
                        model: `${driver}-model`,
                      },
                      availableModels: [`${driver}-model`],
                    },
              ),
            loadAcpSessionsBatch: (request) =>
              Effect.succeed(
                request.sourcePaths.map((sourcePath) => ({
                  sourcePath,
                  descriptor: {
                    driverKind: request.source,
                    providerInstanceId: request.providerInstanceId,
                    source: request.source === 'cursor' ? 'cursor-acp' : 'grok-acp',
                    sourcePath,
                    nativeSessionId: `${request.source}-session`,
                    cwd: '/workspace/imported',
                    title: `${request.source} import`,
                    updatedAt: '2026-01-01T00:00:00.000Z',
                  },
                  session: {
                    meta: {
                      source: request.source === 'cursor' ? 'cursor-acp' : 'grok-acp',
                      sourcePath,
                      contentHash: sharedContentHash,
                      nativeSessionId: `${request.source}-session`,
                      cwd: '/workspace/imported',
                      gitBranch: null,
                      model: null,
                      title: `${request.source} import`,
                      firstActivityAt: '2026-01-01T00:00:00.000Z',
                      lastActivityAt: '2026-01-01T00:00:00.000Z',
                    },
                    records: [
                      {
                        kind: 'message' as const,
                        role: 'user' as const,
                        text: `${request.source} message`,
                        sourceIndex: 0,
                        createdAt: '2026-01-01T00:00:00.000Z',
                      },
                    ],
                    warnings: [],
                  },
                  error: null,
                })),
              ),
          }),
      }),
    ),
    Effect.provideService(
      ImportContinuationDeps,
      ImportContinuationDeps.of({
        bind: (request) =>
          Effect.succeed({
            state: 'verified',
            providerInstanceId: request.providerInstanceId,
            continuationIdentity: continuationIdentityFor(request),
            reason: null,
          }),
      }),
    ),
    Effect.flatMap((service) =>
      service.importSessions({
        items: [
          {
            source: 'cursor',
            sourcePath: 'acp://cursor/cursor-session',
            providerInstanceId: cursorInstanceId,
          },
          {
            source: 'grok',
            sourcePath: 'acp://grok/grok-session',
            providerInstanceId: grokInstanceId,
          },
        ],
      }),
    ),
    Effect.map((result) => ({ commands, result })),
  )
}

describe('ImportService', () =>
{
  it.effect('deduplicates canonical request items before transcript reads and dispatch', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const run = yield* runImport({ sourcePath, itemCount: 2 })

      expect(
        run.commands.filter((command) => command.type === 'thread.messages.import'),
      ).toHaveLength(1)
      expect(run.result.skipped).toContainEqual({
        sourcePath,
        reason: 'duplicate import request item',
        threadId: null,
      })
    }),
  )

  it.effect('imports selected files beyond the former 25 MiB ceiling', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(`${rollout(1)}\n`))
      yield* Effect.promise(() => NodeFSP.truncate(sourcePath, 25 * 1024 * 1024 + 1))
      const run = yield* runImport({ sourcePath })

      expect(run.result.failed).toEqual([])
      expect(run.result.imported).toEqual([
        expect.objectContaining({
          sourcePath,
          messageCount: 1,
        }),
      ])
    }),
  )

  it.effect('rejects selected files beyond the 256 MiB peak-memory ceiling', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(''))
      yield* Effect.promise(() => NodeFSP.truncate(sourcePath, 256 * 1024 * 1024 + 1))
      const run = yield* runImport({ sourcePath })

      expect(run.commands).toEqual([])
      expect(run.result.failed).toEqual([
        expect.objectContaining({
          sourcePath,
          message: expect.stringContaining('file exceeds 268435456 bytes'),
        }),
      ])
    }),
  )

  it.effect('applies raw and normalized budgets independently to each selected file', () =>
    Effect.gen(function* ()
    {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const sessionDirectory = NodePath.join(directory, '2026', '01', '01')
      const firstPath = NodePath.join(sessionDirectory, 'rollout-first.jsonl')
      const secondPath = NodePath.join(sessionDirectory, 'rollout-second.jsonl')
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(sessionDirectory, { recursive: true })
        await Promise.all([
          NodeFSP.writeFile(
            firstPath,
            `${rollout(1).replace('"id":"native"', '"id":"first"')}\n${' '.repeat(3_000)}`,
          ),
          NodeFSP.writeFile(
            secondPath,
            `${rollout(1).replace('"id":"native"', '"id":"second"')}\n${' '.repeat(3_000)}`,
          ),
        ])
      })
      const run = yield* runImport({
        sourcePath: firstPath,
        sourcePaths: [firstPath, secondPath],
        maximumRequestBytes: 4_096,
      })

      expect(run.result.failed).toEqual([])
      expect(run.result.imported).toHaveLength(2)
    }),
  )

  it.effect('derives imported project identity only from normalized workspace root', () =>
    Effect.gen(function* ()
    {
      const firstPath = yield* Effect.promise(() => temporaryFile(rollout(1, '/same/workspace')))
      const secondPath = yield* Effect.promise(() => temporaryFile(rollout(2, '/same/workspace')))
      const [first, second] = yield* Effect.all([
        runImport({ sourcePath: firstPath }),
        runImport({ sourcePath: secondPath }),
      ])
      const firstCreate = first.commands.find((command) => command.type === 'project.create')
      const secondCreate = second.commands.find((command) => command.type === 'project.create')

      expect(firstCreate?.projectId).toBe(secondCreate?.projectId)
      expect(firstCreate?.commandId).toBe(secondCreate?.commandId)
    }),
  )

  it.effect('dispatches project, thread, and bounded message batches before continuation', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(201)))
      const run = yield* runImport({ sourcePath })

      expect(run.commands.map((command) => command.type)).toEqual([
        'project.create',
        'thread.create',
        'thread.messages.import',
        'thread.messages.import',
        'thread.activity.append',
      ])
      const batches = run.commands.filter((command) => command.type === 'thread.messages.import')
      expect(batches.map((command) => command.messages.length + command.activities.length)).toEqual(
        [200, 1],
      )
      const messageIds = batches.flatMap((command) =>
        command.messages.map((message) => message.messageId),
      )
      expect(messageIds).toEqual(messageIds.toSorted())
      const importedRecordTimestamps = batches.flatMap((command) => [
        ...command.messages.map((message) => message.createdAt),
        ...command.activities.map((activity) => activity.createdAt),
      ])
      const marker = run.commands.at(-1)
      expect(marker?.type).toBe('thread.activity.append')
      if (marker?.type === 'thread.activity.append')
      {
        expect(
          importedRecordTimestamps.every(
            (createdAt) => marker.activity.createdAt.localeCompare(createdAt) > 0,
          ),
        ).toBe(true)
        expect(marker.createdAt).toBe(marker.activity.createdAt)
        expect(marker.activity.sequence).toBe(203)
      }
      expect(run.continuations.map((request) => request.threadId)).toEqual([
        run.result.imported[0]?.threadId,
      ])
      expect(run.result.imported[0]).toMatchObject({
        messageCount: 201,
        activityCount: 0,
        continuation: {
          state: 'verified',
          providerInstanceId: ProviderInstanceId.make('codex'),
          reason: null,
        },
      })
      expect(run.commands.at(-1)).toMatchObject({
        type: 'thread.activity.append',
        activity: {
          kind: 'task.completed',
          summary: 'Native codex continuation verified',
          payload: {
            type: 'import.continuation',
            continuation: {
              state: 'verified',
              providerInstanceId: ProviderInstanceId.make('codex'),
            },
          },
        },
      })
    }),
  )

  it.effect('saturates continuation marker time for a maximum-Date imported record', () =>
    Effect.gen(function* ()
    {
      const maximumTimestamp = '+275760-09-13T00:00:00.000Z'
      const sourcePath = yield* Effect.promise(() =>
        temporaryFile(
          [
            {
              timestamp: '2026-01-01T00:00:00.000Z',
              type: 'session_meta',
              payload: {
                id: 'native',
                cwd: '/workspace/imported',
                model_provider: 'openai',
              },
            },
            {
              timestamp: maximumTimestamp,
              type: 'event_msg',
              payload: {
                type: 'user_message',
                message: 'maximum date record',
              },
            },
          ]
            .map((value) => JSON.stringify(value))
            .join('\n'),
        ),
      )

      const run = yield* runImport({ sourcePath })
      const marker = run.commands.find((command) => command.type === 'thread.activity.append')

      expect(run.result.failed).toEqual([])
      expect(marker?.activity.createdAt).toBe(maximumTimestamp)
      expect(marker?.createdAt).toBe(maximumTimestamp)
    }),
  )

  it.effect('reuses every generated identifier across repeated runs', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(2)))
      const first = yield* runImport({ sourcePath })
      const second = yield* runImport({ sourcePath })

      expect(commandIdentifiers(second.commands)).toEqual(commandIdentifiers(first.commands))
      expect(second.result.imported[0]?.threadId).toBe(first.result.imported[0]?.threadId)
    }),
  )

  it.effect('replays an existing content hash without reusing its thread-create receipt', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const existingThreadId = ThreadId.make('existing-thread')
      const run = yield* runImport({ sourcePath, existingThreadId })

      expect(run.commands.map((command) => command.type)).toEqual([
        'thread.messages.import',
        'thread.activity.append',
      ])
      expect(run.continuations.map((request) => request.threadId)).toEqual([existingThreadId])
      expect(run.result.skipped).toEqual([
        {
          sourcePath,
          reason: 'already imported',
          threadId: existingThreadId,
        },
      ])
    }),
  )

  it.effect('groups missing-workspace imports into one history-only project', () =>
    Effect.gen(function* ()
    {
      const scanRoot = yield* Effect.promise(() => temporaryDirectory())
      const sessionDirectory = NodePath.join(scanRoot, '2026', '01', '01')
      const firstSourcePath = NodePath.join(sessionDirectory, 'rollout-first.jsonl')
      const secondSourcePath = NodePath.join(sessionDirectory, 'rollout-second.jsonl')
      const firstWorkspaceRoot = NodePath.join(scanRoot, 'missing', 'first')
      const secondWorkspaceRoot = NodePath.join(scanRoot, 'missing', 'second')
      const holdingWorkspaceRoot = NodePath.join(scanRoot, 'state', 'imported-history')
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(sessionDirectory, { recursive: true })
        await Promise.all([
          NodeFSP.writeFile(
            firstSourcePath,
            rollout(1, firstWorkspaceRoot).replace('"id":"native"', '"id":"native-first"'),
          ),
          NodeFSP.writeFile(
            secondSourcePath,
            rollout(1, secondWorkspaceRoot).replace('"id":"native"', '"id":"native-second"'),
          ),
        ])
      })

      const run = yield* runImport({
        sourcePath: firstSourcePath,
        sourcePaths: [firstSourcePath, secondSourcePath],
        scanRoot,
        resolveImportWorkspaceRoot: (request) =>
          Effect.succeed({
            workspaceRoot: holdingWorkspaceRoot,
            ...(request.recordedWorkspaceRoot === null
              ? {}
              : { originalWorkspaceRoot: request.recordedWorkspaceRoot }),
          }),
      })
      const projectCreates = run.commands.filter((command) => command.type === 'project.create')
      const threadCreates = run.commands.filter((command) => command.type === 'thread.create')

      expect(run.result.failed).toEqual([])
      expect(run.result.imported).toHaveLength(2)
      expect(projectCreates).toHaveLength(1)
      expect(projectCreates[0]).toMatchObject({
        title: 'Imported history',
        workspaceRoot: holdingWorkspaceRoot,
      })
      expect(new Set(threadCreates.map((command) => command.projectId))).toEqual(
        new Set([projectCreates[0]?.projectId]),
      )
      expect(threadCreates.map((command) => command.origin?.originalWorkspaceRoot)).toEqual([
        firstWorkspaceRoot,
        secondWorkspaceRoot,
      ])
      expect(run.continuations).toEqual([])
      expect(run.result.imported.map((item) => item.continuation)).toEqual([
        expect.objectContaining({
          state: 'history-only',
          reason: 'the original workspace is unavailable',
        }),
        expect.objectContaining({
          state: 'history-only',
          reason: 'the original workspace is unavailable',
        }),
      ])
    }),
  )

  it.effect('imports Codex archive rollouts by native id without binding continuation', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const archiveRoot = NodePath.join(root, 'archived_sessions')
      const sourcePath = NodePath.join(
        archiveRoot,
        'rollout-2026-01-01T00-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl',
      )
      const nativeSessionId = '123e4567-e89b-12d3-a456-426614174000'
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(archiveRoot, { recursive: true })
        await NodeFSP.writeFile(
          sourcePath,
          rollout(1).replace('"id":"native"', `"id":"${nativeSessionId}"`),
        )
      })
      const canonicalSourcePath = yield* Effect.promise(() => NodeFSP.realpath(sourcePath))

      const run = yield* runImport({
        sourcePath,
        scanRoot: archiveRoot,
        sourceLayout: 'codex-archive',
      })
      const threadCreate = run.commands.find((command) => command.type === 'thread.create')

      expect(run.result.failed).toEqual([])
      expect(run.continuations).toEqual([])
      expect(threadCreate?.origin).toMatchObject({
        source: 'codex-cli',
        sourcePath: canonicalSourcePath,
        nativeSessionId,
      })
      expect(run.result.imported[0]?.continuation).toEqual({
        state: 'history-only',
        providerInstanceId: ProviderInstanceId.make('codex'),
        continuationIdentity: null,
        reason: 'the source is not resumable',
      })
    }),
  )

  it.effect('rejects Claude child transcripts at the service boundary', () =>
    Effect.gen(function* ()
    {
      const scanRoot = yield* Effect.promise(() => temporaryDirectory())
      const parentSessionId = '123e4567-e89b-12d3-a456-426614174000'
      const subagentsRoot = NodePath.join(scanRoot, 'workspace', parentSessionId, 'subagents')
      const firstPath = NodePath.join(subagentsRoot, 'agent-first.jsonl')
      const secondPath = NodePath.join(subagentsRoot, 'agent-second.jsonl')
      const childTranscript = (agentId: string, text: string) =>
        JSON.stringify({
          type: 'user',
          uuid: `child-${agentId}`,
          parentUuid: null,
          sessionId: parentSessionId,
          agentId,
          isSidechain: true,
          cwd: '/workspace/imported',
          timestamp: '2026-01-01T00:00:00Z',
          message: { content: text },
        })
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(subagentsRoot, { recursive: true })
        await Promise.all([
          NodeFSP.writeFile(firstPath, childTranscript('first', 'First child task')),
          NodeFSP.writeFile(secondPath, childTranscript('second', 'Second child task')),
        ])
      })

      const run = yield* runImport({
        source: 'claude-code',
        sourcePath: firstPath,
        sourcePaths: [firstPath, secondPath],
        scanRoot,
      })

      expect(run.commands).toEqual([])
      expect(run.continuations).toEqual([])
      expect(run.result.imported).toEqual([])
      expect(run.result.failed.map((failure) => failure.sourcePath)).toEqual([
        firstPath,
        secondPath,
      ])
      for (const failure of run.result.failed)
      {
        expect(failure.message).toContain(
          'the file does not use a recognized session transcript layout',
        )
      }
    }),
  )

  it.effect('replays archived imports without rebinding continuation', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const existingThreadId = ThreadId.make('archived-thread')
      const run = yield* runImport({
        sourcePath,
        existingThreadId,
        existingArchived: true,
      })

      expect(run.commands.map((command) => command.type)).toEqual(['thread.messages.import'])
      expect(run.continuations).toEqual([])
      expect(run.result.skipped[0]?.threadId).toBe(existingThreadId)
    }),
  )

  it.effect('keeps at least one visible thread through active replacement boundaries', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(2)))
      const sourceThreadId = ThreadId.make('active-incomplete-thread')
      const { commands, result, visibleThreadCounts } = yield* runImport({
        sourcePath,
        existingThreadId: sourceThreadId,
        existingContentHash: 'older-content-version',
        existingFinalized: false,
      })

      expect(result.failed).toEqual([])
      const replacementCreateIndex = commands.findIndex(
        (command) => command.type === 'thread.create' && command.threadId !== sourceThreadId,
      )
      const sourceDeleteIndex = commands.findIndex(
        (command) => command.type === 'thread.delete' && command.threadId === sourceThreadId,
      )
      expect(replacementCreateIndex).toBeGreaterThanOrEqual(0)
      expect(sourceDeleteIndex).toBeGreaterThan(replacementCreateIndex)
      expect(Math.min(...visibleThreadCounts)).toBeGreaterThanOrEqual(1)

      const retry = yield* runImport({
        sourcePath,
        existingThreadId: sourceThreadId,
        existingContentHash: 'older-content-version',
        existingFinalized: false,
      })
      const replacementCreate = commands[replacementCreateIndex]
      const retryReplacementCreate = retry.commands.find(
        (command) => command.type === 'thread.create' && command.threadId !== sourceThreadId,
      )
      const sourceDelete = commands[sourceDeleteIndex]
      const retrySourceDelete = retry.commands.find(
        (command) => command.type === 'thread.delete' && command.threadId === sourceThreadId,
      )
      expect(retryReplacementCreate).toMatchObject({
        commandId: replacementCreate?.commandId,
        threadId:
          replacementCreate && 'threadId' in replacementCreate ? replacementCreate.threadId : null,
      })
      expect(retrySourceDelete).toMatchObject({ commandId: sourceDelete?.commandId })
    }),
  )

  it.effect('preserves archived replacement intent across archive and old-delete failures', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(2)))
      const scanRoot = NodePath.resolve(NodePath.dirname(sourcePath), '..', '..', '..')
      const providerInstanceId = ProviderInstanceId.make('codex')
      const projectId = ProjectId.make('archived-replacement-project')
      const oldThreadId = ThreadId.make('archived-incomplete-thread')
      const modelSelection = {
        instanceId: providerInstanceId,
        model: 'gpt-imported',
      } satisfies ModelSelection
      const threads = new Map<
        string,
        ImportedThreadMatch & {
          deleted: boolean
        }
      >([
        [
          oldThreadId,
          {
            threadId: oldThreadId,
            projectId,
            contentHash: 'old-content-hash',
            source: 'codex-cli',
            sourcePath,
            nativeSessionId: 'native',
            providerInstanceId,
            modelSelection,
            archived: true,
            deleted: false,
          },
        ],
      ])
      const commands: OrchestrationCommand[] = []
      const acceptedThreadCreateCommands = new Set<string>()
      const continuationRequests: ContinuationRequest[] = []
      const normalizationStarted = yield* Deferred.make<void>()
      const requestDeadlineMs = 100
      let failNextArchive = true
      let failNextOldDelete = false
      let hangNextNormalization = false
      let unrelatedThreadId: ThreadId | null = null
      const replacementIntents = makeReplacementIntentMemory()

      const service = yield* make.pipe(
        Effect.provideService(
          ImportServiceDeps,
          ImportServiceDeps.of({
            dispatch: (command) =>
              Effect.suspend(() =>
              {
                commands.push(command)
                if (command.type === 'thread.create')
                {
                  if (acceptedThreadCreateCommands.has(command.commandId))
                  {
                    return Effect.succeed({ sequence: commands.length })
                  }
                  acceptedThreadCreateCommands.add(command.commandId)
                  threads.set(command.threadId, {
                    threadId: command.threadId,
                    projectId: command.projectId,
                    contentHash: command.origin?.contentHash ?? 'missing-content-hash',
                    source: command.origin?.source ?? 'codex-cli',
                    sourcePath: command.origin?.sourcePath ?? sourcePath,
                    nativeSessionId: command.origin?.nativeSessionId ?? null,
                    providerInstanceId: command.origin?.providerInstanceId ?? null,
                    modelSelection: command.modelSelection,
                    archived: false,
                    deleted: false,
                  })
                }
                if (command.type === 'thread.archive')
                {
                  if (failNextArchive)
                  {
                    failNextArchive = false
                    return Effect.fail(new Error('injected replacement archive failure'))
                  }
                  const thread = threads.get(command.threadId)
                  if (thread === undefined || thread.deleted)
                  {
                    return Effect.fail(new Error(`thread '${command.threadId}' is unavailable`))
                  }
                  threads.set(command.threadId, { ...thread, archived: true })
                }
                if (command.type === 'thread.delete')
                {
                  if (command.threadId === oldThreadId && failNextOldDelete)
                  {
                    failNextOldDelete = false
                    return Effect.fail(new Error('injected incomplete-thread delete failure'))
                  }
                  const thread = threads.get(command.threadId)
                  if (thread !== undefined)
                  {
                    threads.set(command.threadId, { ...thread, deleted: true })
                  }
                }
                return Effect.succeed({ sequence: commands.length })
              }),
            findThreadByContentHash: () =>
              Effect.sync(
                () =>
                  [...threads.values()]
                    .filter((thread) => !thread.deleted && thread.threadId !== unrelatedThreadId)
                    .toSorted((left, right) => Number(left.archived) - Number(right.archived))[0] ??
                  null,
              ),
            findThreadById: (threadId) =>
              Effect.sync(() =>
              {
                const thread = threads.get(threadId)
                return thread === undefined || thread.deleted ? null : thread
              }),
            findProjectByWorkspaceRoot: () => Effect.succeed(projectId),
            isImportFinalized: () => Effect.succeed(false),
            normalizeWorkspaceRoot: (root) =>
              hangNextNormalization
                ? Effect.sync(() =>
                  {
                    hangNextNormalization = false
                  }).pipe(
                    Effect.andThen(Deferred.succeed(normalizationStarted, undefined)),
                    Effect.andThen(Effect.never),
                  )
                : Effect.succeed(root),
            resolveImportWorkspaceRoot: (request) =>
              Effect.succeed({
                workspaceRoot:
                  request.existingWorkspaceRoot ??
                  request.recordedWorkspaceRoot ??
                  '/workspace/imported-history',
              }),
            threadExistsInShell: (threadId) =>
              Effect.sync(() =>
              {
                const thread = threads.get(threadId)
                return thread !== undefined && !thread.deleted && !thread.archived
              }),
            replacementIntents,
            verifyReplacementThread: () => Effect.succeed(null),
            verifyReplacementAttachments: () => Effect.succeed({ complete: true }),
            cleanupDeletedThreadAttachments: () => Effect.succeed({ complete: true }),
            verifyReplacementIndex: ({ replacementThreadId, sourceThreadId }) =>
              Effect.sync(() => ({
                replacementVisible: threads.get(replacementThreadId)?.deleted === false,
                sourceVisible: threads.get(sourceThreadId)?.deleted === false,
              })),
            requestDeadlineMs,
            loadRequestContext: () =>
              Effect.succeed({
                fallbackModelSelection: modelSelection,
                sourceDescriptors: [
                  {
                    source: 'codex-cli',
                    driverKind: ProviderDriverKind.make('codex'),
                    providerInstanceId,
                    scanRoot,
                    continuationIdentity: fileContinuationIdentity(
                      ProviderDriverKind.make('codex'),
                      scanRoot,
                    ),
                  },
                ],
                resolveImportTarget: () =>
                  Effect.succeed({
                    defaultModelSelection: modelSelection,
                    availableModels: [modelSelection.model],
                  }),
                loadAcpSessionsBatch: () => Effect.succeed([]),
              }),
          }),
        ),
        Effect.provideService(
          ImportContinuationDeps,
          ImportContinuationDeps.of({
            bind: (request) =>
              Effect.sync(() =>
              {
                continuationRequests.push(request)
                return {
                  state: 'verified',
                  providerInstanceId,
                  continuationIdentity: continuationIdentityFor(request),
                  reason: null,
                }
              }),
          }),
        ),
      )
      const request = {
        items: [{ source: 'codex-cli', sourcePath, providerInstanceId }],
      } satisfies ImportSessionsRequest

      const firstResult = yield* service.importSessions(request)
      expect(firstResult.imported).toEqual([])
      expect(firstResult.failed).toEqual([
        {
          sourcePath,
          message: expect.stringContaining('injected replacement archive failure'),
        },
      ])
      const firstReplacementCreate = commands.find((command) => command.type === 'thread.create')
      expect(firstReplacementCreate?.type).toBe('thread.create')
      expect(
        firstReplacementCreate === undefined
          ? undefined
          : threads.get(firstReplacementCreate.threadId)?.deleted,
      ).toBe(true)
      expect(threads.get(oldThreadId)).toMatchObject({
        archived: true,
        deleted: false,
      })
      expect(commands.map((command) => command.type)).toEqual([
        'thread.create',
        'thread.archive',
        'thread.delete',
      ])

      unrelatedThreadId = firstReplacementCreate!.threadId
      const firstReplacement = threads.get(unrelatedThreadId)!
      threads.set(unrelatedThreadId, {
        threadId: unrelatedThreadId,
        projectId: firstReplacement.projectId,
        contentHash: firstReplacement.contentHash,
        source: 'codex-cli',
        sourcePath: '/unrelated/source.jsonl',
        nativeSessionId: 'unrelated-native',
        providerInstanceId,
        modelSelection,
        archived: false,
        deleted: false,
      })
      hangNextNormalization = true
      const timedOutFiber = yield* service.importSessions(request).pipe(Effect.forkScoped)
      yield* Deferred.await(normalizationStarted)
      yield* TestClock.adjust(Duration.millis(requestDeadlineMs))
      const timedOutResult = yield* Fiber.join(timedOutFiber)
      expect(timedOutResult.imported).toEqual([])
      expect(timedOutResult.failed).toEqual([
        {
          sourcePath,
          message: `import request exceeded its ${requestDeadlineMs}ms aggregate execution deadline; retry is safe because import command identifiers are deterministic`,
        },
      ])
      expect(threads.get(unrelatedThreadId)).toMatchObject({
        projectId: firstReplacement.projectId,
        contentHash: firstReplacement.contentHash,
        sourcePath: '/unrelated/source.jsonl',
        deleted: false,
      })

      const timeoutCommandCount = commands.length
      failNextOldDelete = true
      const thirdResult = yield* service.importSessions(request)
      expect(thirdResult.imported).toEqual([])
      expect(thirdResult.failed).toEqual([
        {
          sourcePath,
          message: expect.stringContaining('injected incomplete-thread delete failure'),
        },
      ])
      expect(threads.get(oldThreadId)).toMatchObject({
        archived: true,
        deleted: false,
      })
      expect(
        [...threads.values()].filter(
          (thread) =>
            thread.threadId !== oldThreadId &&
            thread.threadId !== unrelatedThreadId &&
            !thread.deleted,
        ),
      ).toEqual([])
      expect(commands.slice(timeoutCommandCount).map((command) => command.type)).toEqual([
        'thread.create',
        'thread.create',
        'thread.archive',
        'thread.delete',
        'thread.delete',
      ])

      const thirdCommandCount = commands.length
      const fourthResult = yield* service.importSessions(request)
      expect(fourthResult.failed).toEqual([])
      expect(fourthResult.skipped).toEqual([])
      expect(fourthResult.imported).toHaveLength(1)
      expect(fourthResult.imported[0]?.continuation).toEqual({
        state: 'history-only',
        providerInstanceId,
        continuationIdentity: null,
        reason: 'the imported thread remains archived',
      })
      const replacementThreadId = fourthResult.imported[0]!.threadId
      expect(threads.get(replacementThreadId)).toMatchObject({
        archived: true,
        deleted: false,
      })
      expect(threads.get(oldThreadId)?.deleted).toBe(true)
      expect(threads.get(unrelatedThreadId)?.deleted).toBe(false)
      expect(continuationRequests).toEqual([])
      expect(commands.slice(thirdCommandCount).map((command) => command.type)).toEqual([
        'thread.create',
        'thread.create',
        'thread.archive',
        'thread.delete',
        'thread.messages.import',
        'thread.activity.append',
      ])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )

  it.effect('fails honestly after bounded attempts when every thread creation is swallowed', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const run = yield* runImport({ sourcePath, threadExists: false })

      expect(run.commands.map((command) => command.type)).toEqual([
        'project.create',
        'thread.create',
        'thread.create',
        'thread.create',
      ])
      expect(run.continuations).toEqual([])
      expect(run.result.failed).toEqual([
        {
          sourcePath,
          message: expect.stringContaining(
            'Failed to create an active thread for the imported session',
          ),
        },
      ])
    }),
  )

  it.effect('recreates the project when deletion wins at the thread creation barrier', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const run = yield* runImport({
        sourcePath,
        deleteProjectBeforeFirstThreadCreate: true,
      })
      const projectCreates = run.commands.filter(
        (command): command is Extract<OrchestrationCommand, { type: 'project.create' }> =>
          command.type === 'project.create',
      )
      const threadCreates = run.commands.filter(
        (command): command is Extract<OrchestrationCommand, { type: 'thread.create' }> =>
          command.type === 'thread.create',
      )

      expect(run.result.failed).toEqual([])
      expect(run.result.imported).toHaveLength(1)
      expect(projectCreates).toHaveLength(3)
      expect(threadCreates).toHaveLength(2)
      expect(projectCreates[0]?.projectId).toBe(projectCreates[1]?.projectId)
      expect(projectCreates[2]?.projectId).not.toBe(projectCreates[0]?.projectId)
      expect(threadCreates[0]?.projectId).toBe(projectCreates[0]?.projectId)
      expect(threadCreates[1]?.projectId).toBe(projectCreates[2]?.projectId)
      expect(run.result.imported[0]?.projectId).toBe(projectCreates[2]?.projectId)
    }),
  )

  it.effect('uses one resolved instance for thread selection and continuation', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const requestedInstanceId = ProviderInstanceId.make('requested-codex')
      const run = yield* runImport({
        sourcePath,
        providerInstanceId: requestedInstanceId,
        compatibleInstanceIds: [requestedInstanceId],
        resolvedTarget: {
          defaultModelSelection: {
            instanceId: requestedInstanceId,
            model: 'resolved-model',
          },
          availableModels: ['resolved-model', 'gpt-imported'],
        },
      })
      const threadCreate = run.commands.find((command) => command.type === 'thread.create')

      expect(run.targetResolutions).toEqual([
        {
          requestedInstanceId,
          compatibleInstanceIds: [requestedInstanceId],
        },
      ])
      expect(threadCreate?.modelSelection.instanceId).toBe(requestedInstanceId)
      expect(threadCreate?.modelSelection.model).toBe('gpt-imported')
      expect(run.continuations[0]?.providerInstanceId).toBe(requestedInstanceId)
      expect(run.continuations[0]?.modelSelection).toEqual({
        instanceId: requestedInstanceId,
        model: 'gpt-imported',
      })
    }),
  )

  it.effect('never substitutes a different instance for an explicit target', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const requestedInstanceId = ProviderInstanceId.make('requested-codex')
      const substitutedInstanceId = ProviderInstanceId.make('other-codex')
      const run = yield* runImport({
        sourcePath,
        providerInstanceId: requestedInstanceId,
        compatibleInstanceIds: [requestedInstanceId, substitutedInstanceId],
        resolvedTarget: {
          defaultModelSelection: {
            instanceId: substitutedInstanceId,
            model: 'wrong-model',
          },
          availableModels: ['wrong-model'],
        },
      })
      const threadCreate = run.commands.find((command) => command.type === 'thread.create')

      expect(threadCreate?.modelSelection).toEqual({
        instanceId: ProviderInstanceId.make('fallback'),
        model: 'gpt-fallback',
      })
      expect(run.continuations).toEqual([])
      expect(run.result.imported[0]?.continuation).toEqual({
        state: 'history-only',
        providerInstanceId: requestedInstanceId,
        continuationIdentity: null,
        reason: `provider instance '${requestedInstanceId}' is unavailable or does not own this source`,
      })
    }),
  )

  it.effect('rejects a wrong owner without poisoning a subsequent correct-owner import', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const owningInstanceId = ProviderInstanceId.make('owning-codex')
      const wrongInstanceId = ProviderInstanceId.make('wrong-codex')
      const run = yield* runImport({
        sourcePath,
        providerInstanceId: wrongInstanceId,
        followupProviderInstanceId: owningInstanceId,
        compatibleInstanceIds: [owningInstanceId],
        resolvedTarget: {
          defaultModelSelection: {
            instanceId: owningInstanceId,
            model: 'owning-model',
          },
          availableModels: ['owning-model', 'gpt-imported'],
        },
      })
      const threadCreates = run.commands.filter(
        (command): command is Extract<OrchestrationCommand, { type: 'thread.create' }> =>
          command.type === 'thread.create',
      )

      expect(run.result).toEqual({
        imported: [],
        skipped: [
          {
            sourcePath,
            reason: `provider instance '${wrongInstanceId}' does not own this source`,
            threadId: null,
          },
        ],
        failed: [],
      })
      expect(run.targetResolutions).toEqual([
        {
          requestedInstanceId: owningInstanceId,
          compatibleInstanceIds: [owningInstanceId],
        },
      ])
      expect(run.followupResult?.failed).toEqual([])
      expect(run.followupResult?.skipped).toEqual([])
      expect(run.followupResult?.imported).toHaveLength(1)
      expect(threadCreates).toHaveLength(1)
      expect(threadCreates[0]).toMatchObject({
        modelSelection: {
          instanceId: owningInstanceId,
          model: 'gpt-imported',
        },
        origin: {
          kind: 'imported',
          providerInstanceId: owningInstanceId,
        },
      })
      expect(run.continuations[0]?.providerInstanceId).toBe(owningInstanceId)
    }),
  )

  it.effect('uses the target default when the imported model is unavailable', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const run = yield* runImport({
        sourcePath,
        resolvedTarget: {
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'available-default',
          },
          availableModels: ['available-default'],
        },
      })
      const threadCreate = run.commands.find((command) => command.type === 'thread.create')

      expect(threadCreate?.modelSelection).toEqual({
        instanceId: ProviderInstanceId.make('codex'),
        model: 'available-default',
      })
      expect(run.continuations[0]?.modelSelection).toEqual({
        instanceId: ProviderInstanceId.make('codex'),
        model: 'available-default',
      })
    }),
  )

  it.effect('persists history-only continuation outcomes as warning activities', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const run = yield* runImport({
        sourcePath,
        continuationOutcome: {
          state: 'history-only',
          providerInstanceId: ProviderInstanceId.make('codex'),
          continuationIdentity: null,
          reason: 'rollout is outside the selected instance home',
        },
      })
      const continuationActivity = run.commands.find(
        (command) => command.type === 'thread.activity.append',
      )

      expect(continuationActivity?.activity).toMatchObject({
        tone: 'info',
        kind: 'runtime.warning',
        summary: 'History-only import: rollout is outside the selected instance home',
      })
    }),
  )

  it.effect('does not append a history-only marker when a different binding was preserved', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const existingThreadId = ThreadId.make('finalized-existing-thread')
      const run = yield* runImport({
        sourcePath,
        existingThreadId,
        continuationOutcome: {
          state: 'history-only',
          providerInstanceId: ProviderInstanceId.make('codex'),
          continuationIdentity: null,
          reason: IMPORT_CONTINUATION_PRESERVED_BINDING_REASON,
        },
      })

      expect(run.commands.filter((command) => command.type === 'thread.activity.append')).toEqual(
        [],
      )
      expect(run.commands.filter((command) => command.type === 'thread.meta.update')).toEqual([])
      expect(run.result.skipped).toEqual([
        {
          sourcePath,
          reason: 'already imported',
          threadId: existingThreadId,
        },
      ])
    }),
  )

  it.effect('finalizes an incomplete import when a different binding was preserved', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const run = yield* runImport({
        sourcePath,
        existingThreadId: ThreadId.make('incomplete-existing-thread'),
        existingFinalized: false,
        continuationOutcome: {
          state: 'history-only',
          providerInstanceId: ProviderInstanceId.make('codex'),
          continuationIdentity: null,
          reason: IMPORT_CONTINUATION_PRESERVED_BINDING_REASON,
        },
      })

      expect(
        run.commands.filter((command) => command.type === 'thread.activity.append'),
      ).toHaveLength(1)
      expect(run.result.skipped).toEqual([
        {
          sourcePath,
          reason: 'already imported',
          threadId: ThreadId.make('incomplete-existing-thread'),
        },
      ])
    }),
  )

  it.effect('skips native-session matches whose content hash has new activity', () =>
    Effect.gen(function* ()
    {
      const sourcePath = yield* Effect.promise(() => temporaryFile(rollout(1)))
      const existingThreadId = ThreadId.make('existing-native-thread')
      const run = yield* runImport({
        sourcePath,
        existingThreadId,
        existingContentHash: 'older-content-hash',
      })

      expect(run.commands).toEqual([])
      expect(run.continuations).toEqual([])
      expect(run.targetResolutions).toEqual([
        {
          requestedInstanceId: ProviderInstanceId.make('codex'),
          compatibleInstanceIds: [ProviderInstanceId.make('codex')],
        },
      ])
      expect(run.result.skipped).toEqual([
        {
          sourcePath,
          reason:
            'already imported; the original session has new activity (delta sync not yet supported)',
          threadId: existingThreadId,
        },
      ])
    }),
  )

  it.effect('imports an OpenCode storage bundle through the file-source trust boundary', () =>
    Effect.gen(function* ()
    {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const storageRoot = NodePath.join(root, 'storage')
      yield* Effect.promise(() =>
        NodeFSP.cp(new URL('./fixtures/opencode/storage', import.meta.url), storageRoot, {
          recursive: true,
        }),
      )
      const sourcePath = NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json')
      const providerInstanceId = ProviderInstanceId.make('opencode-import')
      const run = yield* runStretchImport({
        source: 'opencode',
        sourcePath,
        providerInstanceId,
        sourceDescriptors: [
          {
            source: 'opencode',
            driverKind: ProviderDriverKind.make('opencode'),
            providerInstanceId,
            scanRoot: NodePath.join(storageRoot, 'session'),
            continuationIdentity: fileContinuationIdentity(
              ProviderDriverKind.make('opencode'),
              NodePath.join(storageRoot, 'session'),
            ),
          },
        ],
      })
      const threadCreate = run.commands.find((command) => command.type === 'thread.create')

      expect(run.result.failed).toEqual([])
      expect(run.result.imported).toEqual([
        expect.objectContaining({
          sourcePath,
          messageCount: 2,
          activityCount: 4,
          continuation: {
            state: 'verified',
            providerInstanceId,
            continuationIdentity: {
              driverKind: ProviderDriverKind.make('opencode'),
              continuationKey: `opencode:instance:${providerInstanceId}`,
            },
            reason: null,
          },
        }),
      ])
      expect(run.commands.map((command) => command.type)).toEqual([
        'project.create',
        'thread.create',
        'thread.messages.import',
        'thread.activity.append',
      ])
      expect(threadCreate).toMatchObject({
        modelSelection: {
          instanceId: providerInstanceId,
          model: 'openai/gpt-5.2',
        },
        origin: {
          kind: 'imported',
          source: 'opencode',
          sourcePath: yield* Effect.promise(() => NodeFSP.realpath(sourcePath)),
          nativeSessionId: 'ses_imported',
        },
      })
      expect(run.resolvedDrivers).toEqual([ProviderDriverKind.make('opencode')])
      expect(run.acpLoads).toEqual([])
      expect(run.continuations[0]?.meta).toMatchObject({
        source: 'opencode',
        nativeSessionId: 'ses_imported',
      })
    }),
  )

  it.effect('imports ACP replay only through the exact selected provider instance', () =>
    Effect.gen(function* ()
    {
      const providerInstanceId = ProviderInstanceId.make('cursor-import')
      const sourcePath = 'acp://cursor/cursor-import/cursor-session'
      const acpSession: AcpImportedSession = {
        meta: {
          source: 'cursor-acp',
          sourcePath,
          contentHash: 'b'.repeat(64),
          nativeSessionId: 'cursor-session',
          cwd: '/workspace/cursor',
          gitBranch: null,
          model: 'cursor-model',
          title: 'Cursor import',
          firstActivityAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.001Z',
        },
        records: [
          {
            kind: 'message',
            role: 'user',
            text: 'Resume Cursor work',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceIndex: 0,
          },
          {
            kind: 'activity',
            tone: 'tool',
            activityKind: 'tool.completed',
            summary: 'Reviewed files',
            payload: { status: 'completed' },
            createdAt: '2026-01-01T00:00:00.001Z',
            sourceIndex: 1,
          },
        ],
        warnings: [],
      }
      const run = yield* runStretchImport({
        source: 'cursor',
        sourcePath,
        providerInstanceId,
        sourceDescriptors: [],
        acpSession,
      })
      const threadCreate = run.commands.find((command) => command.type === 'thread.create')

      expect(run.result.failed).toEqual([])
      expect(run.result.imported).toEqual([
        expect.objectContaining({
          sourcePath,
          messageCount: 1,
          activityCount: 1,
          continuation: {
            state: 'verified',
            providerInstanceId,
            continuationIdentity: {
              driverKind: ProviderDriverKind.make('cursor'),
              continuationKey: `cursor:instance:${providerInstanceId}`,
            },
            reason: null,
          },
        }),
      ])
      expect(run.acpLoads).toEqual([
        {
          source: 'cursor',
          sourcePaths: [sourcePath],
          providerInstanceId,
          maximumBytes: expect.any(Number),
        },
      ])
      expect(run.resolvedDrivers).toEqual([ProviderDriverKind.make('cursor')])
      expect(threadCreate).toMatchObject({
        modelSelection: {
          instanceId: providerInstanceId,
          model: 'cursor-model',
        },
        origin: {
          kind: 'imported',
          source: 'cursor',
          sourcePath,
          nativeSessionId: 'cursor-session',
        },
      })
      expect(run.continuations[0]).toMatchObject({
        providerInstanceId,
        meta: {
          source: 'cursor',
          sourcePath,
          nativeSessionId: 'cursor-session',
        },
      })
    }),
  )

  it.effect('bounds all ACP provider groups by one aggregate request deadline', () =>
    Effect.gen(function* ()
    {
      const firstProviderInstanceId = ProviderInstanceId.make('cursor-first')
      const secondProviderInstanceId = ProviderInstanceId.make('cursor-second')
      const thirdProviderInstanceId = ProviderInstanceId.make('cursor-third')
      const firstSourcePath = 'acp://cursor/cursor-first/first-session'
      const secondSourcePath = 'acp://cursor/cursor-second/second-session'
      const thirdSourcePath = 'acp://cursor/cursor-third/third-session'
      const secondLoadStarted = yield* Deferred.make<void>()
      const firstSession: AcpImportedSession = {
        meta: {
          source: 'cursor-acp',
          sourcePath: firstSourcePath,
          contentHash: 'd'.repeat(64),
          nativeSessionId: 'first-session',
          cwd: '/workspace/cursor',
          gitBranch: null,
          model: 'cursor-model',
          title: 'First Cursor import',
          firstActivityAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        },
        records: [
          {
            kind: 'message',
            role: 'user',
            text: 'first transcript',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceIndex: 0,
          },
        ],
        warnings: [],
      }
      const runFiber = yield* runStretchImport({
        source: 'cursor',
        sourcePath: firstSourcePath,
        providerInstanceId: firstProviderInstanceId,
        sourceDescriptors: [],
        items: [
          {
            source: 'cursor',
            sourcePath: firstSourcePath,
            providerInstanceId: firstProviderInstanceId,
          },
          {
            source: 'cursor',
            sourcePath: secondSourcePath,
            providerInstanceId: secondProviderInstanceId,
          },
          {
            source: 'cursor',
            sourcePath: thirdSourcePath,
            providerInstanceId: thirdProviderInstanceId,
          },
        ],
        loadAcpSessionsBatch: (request) =>
        {
          if (request.providerInstanceId === firstProviderInstanceId)
          {
            return Effect.succeed([
              {
                sourcePath: firstSourcePath,
                descriptor: {
                  driverKind: 'cursor',
                  providerInstanceId: firstProviderInstanceId,
                  source: 'cursor-acp',
                  sourcePath: firstSourcePath,
                  nativeSessionId: 'first-session',
                  cwd: '/workspace/cursor',
                  title: 'First Cursor import',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                },
                session: firstSession,
                error: null,
              },
            ])
          }
          if (request.providerInstanceId === secondProviderInstanceId)
          {
            return Deferred.succeed(secondLoadStarted, undefined).pipe(Effect.andThen(Effect.never))
          }
          return Effect.die('the aggregate deadline must prevent the third ACP group from loading')
        },
      }).pipe(Effect.forkScoped)

      yield* Deferred.await(secondLoadStarted)
      yield* TestClock.adjust(Duration.millis(ACP_IMPORT_REQUEST_DEADLINE_MS))
      const run = yield* Fiber.join(runFiber)

      expect(run.acpLoads.map((load) => load.providerInstanceId)).toEqual([
        firstProviderInstanceId,
        secondProviderInstanceId,
      ])
      expect(run.result.imported).toEqual([
        expect.objectContaining({ sourcePath: firstSourcePath }),
      ])
      expect(run.result.skipped).toEqual([])
      expect(run.result.failed).toEqual([
        {
          sourcePath: secondSourcePath,
          message: `parse failed for '${secondSourcePath}': ACP import request exceeded its ${ACP_IMPORT_REQUEST_DEADLINE_MS}ms aggregate load deadline`,
        },
        {
          sourcePath: thirdSourcePath,
          message: `parse failed for '${thirdSourcePath}': ACP import request exceeded its ${ACP_IMPORT_REQUEST_DEADLINE_MS}ms aggregate load deadline`,
        },
      ])
    }),
  )

  it.effect('bounds retained ACP sessions across providers before loading later groups', () =>
    Effect.gen(function* ()
    {
      const maximumRequestBytes = 4_096
      const firstProviderInstanceId = ProviderInstanceId.make('cursor-memory-first')
      const secondProviderInstanceId = ProviderInstanceId.make('cursor-memory-second')
      const thirdProviderInstanceId = ProviderInstanceId.make('cursor-memory-third')
      const firstSourcePath = 'acp://cursor/cursor-memory-first/first-session'
      const secondSourcePath = 'acp://cursor/cursor-memory-second/second-session'
      const thirdSourcePath = 'acp://cursor/cursor-memory-third/third-session'
      const firstSession = sizedAcpSession({
        sourcePath: firstSourcePath,
        nativeSessionId: 'first-session',
        serializedBytes: maximumRequestBytes,
      })

      const run = yield* runStretchImport({
        source: 'cursor',
        sourcePath: firstSourcePath,
        providerInstanceId: firstProviderInstanceId,
        sourceDescriptors: [],
        maximumRequestBytes,
        items: [
          {
            source: 'cursor',
            sourcePath: firstSourcePath,
            providerInstanceId: firstProviderInstanceId,
          },
          {
            source: 'cursor',
            sourcePath: secondSourcePath,
            providerInstanceId: secondProviderInstanceId,
          },
          {
            source: 'cursor',
            sourcePath: thirdSourcePath,
            providerInstanceId: thirdProviderInstanceId,
          },
        ],
        loadAcpSessionsBatch: (request) =>
        {
          if (request.providerInstanceId !== firstProviderInstanceId)
          {
            return Effect.die('an exhausted request budget must prevent later ACP loads')
          }
          expect(request.maximumBytes).toBe(maximumRequestBytes)
          return Effect.succeed([
            {
              sourcePath: firstSourcePath,
              descriptor: {
                driverKind: 'cursor',
                providerInstanceId: firstProviderInstanceId,
                source: 'cursor-acp',
                sourcePath: firstSourcePath,
                nativeSessionId: 'first-session',
                cwd: '/workspace/cursor',
                title: 'Bounded Cursor import',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
              session: firstSession,
              error: null,
            },
          ])
        },
      })

      expect(run.acpLoads).toHaveLength(1)
      expect(run.result.imported).toEqual([
        expect.objectContaining({ sourcePath: firstSourcePath }),
      ])
      expect(run.result.failed.map((failure) => failure.sourcePath)).toEqual([
        secondSourcePath,
        thirdSourcePath,
      ])
      for (const failure of run.result.failed)
      {
        expect(failure.message).toContain(
          `byte budget exceeded (${maximumRequestBytes} bytes maximum)`,
        )
      }
    }),
  )

  it.effect('charges empty ACP provider wire work before considering later groups', () =>
    Effect.gen(function* ()
    {
      const maximumRequestBytes = 4_096
      const firstProviderInstanceId = ProviderInstanceId.make('cursor-wire-first')
      const secondProviderInstanceId = ProviderInstanceId.make('cursor-wire-second')
      const thirdProviderInstanceId = ProviderInstanceId.make('cursor-wire-third')
      const firstSourcePath = 'acp://cursor/cursor-wire-first/first-session'
      const secondSourcePath = 'acp://cursor/cursor-wire-second/second-session'
      const thirdSourcePath = 'acp://cursor/cursor-wire-third/third-session'
      const run = yield* runStretchImport({
        source: 'cursor',
        sourcePath: firstSourcePath,
        providerInstanceId: firstProviderInstanceId,
        sourceDescriptors: [],
        maximumRequestBytes,
        items: [
          {
            source: 'cursor',
            sourcePath: firstSourcePath,
            providerInstanceId: firstProviderInstanceId,
          },
          {
            source: 'cursor',
            sourcePath: secondSourcePath,
            providerInstanceId: secondProviderInstanceId,
          },
          {
            source: 'cursor',
            sourcePath: thirdSourcePath,
            providerInstanceId: thirdProviderInstanceId,
          },
        ],
        loadAcpSessionsBatch: (request) =>
          Effect.sync(() =>
          {
            if (request.providerInstanceId !== firstProviderInstanceId)
            {
              throw new Error('exhausted wire work must prevent later ACP provider loads')
            }
            expect(request.maximumBytes).toBe(maximumRequestBytes)
            request.wireUsage.consumedBytes += request.maximumBytes
            return []
          }),
      })

      expect(run.acpLoads).toEqual([
        {
          source: 'cursor',
          sourcePaths: [firstSourcePath],
          providerInstanceId: firstProviderInstanceId,
          maximumBytes: maximumRequestBytes,
        },
      ])
      expect(run.result.imported).toEqual([])
      expect(run.result.failed[0]).toEqual({
        sourcePath: firstSourcePath,
        message: `parse failed for '${firstSourcePath}': ACP batch loader did not return this requested session`,
      })
      expect(run.result.failed.slice(1).map((failure) => failure.sourcePath)).toEqual([
        secondSourcePath,
        thirdSourcePath,
      ])
      for (const failure of run.result.failed.slice(1))
      {
        expect(failure.message).toContain(
          `byte budget exceeded (${maximumRequestBytes} bytes maximum)`,
        )
      }
    }),
  )

  it.effect('rejects normalized file amplification before the first persistence dispatch', () =>
    Effect.gen(function* ()
    {
      const repeatedOutput = 'credential-safe-output '.repeat(200)
      const content = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          type: 'session_meta',
          payload: {
            id: 'normalized-byte-limit',
            cwd: '/workspace/imported',
            model_provider: 'openai',
          },
        },
        {
          timestamp: '2026-01-01T00:00:01Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'inspect the output',
          },
        },
        {
          timestamp: '2026-01-01T00:00:02Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call-normalized-limit',
            arguments: '{"cmd":"vp test"}',
          },
        },
        {
          timestamp: '2026-01-01T00:00:03Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-normalized-limit',
            output: repeatedOutput,
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n')
      const sourcePath = yield* Effect.promise(() => temporaryFile(content))
      const maximumRequestBytes = Buffer.byteLength(content, 'utf8') + 64
      const run = yield* runImport({
        sourcePath,
        maximumRequestBytes,
      })

      expect(run.commands).toEqual([])
      expect(run.continuations).toEqual([])
      expect(run.result.imported).toEqual([])
      expect(run.result.failed).toEqual([
        expect.objectContaining({
          sourcePath,
          message: expect.stringContaining(
            `normalized byte budget exceeded (${maximumRequestBytes} bytes maximum)`,
          ),
        }),
      ])
    }),
  )

  it.effect('rejects per-session normalized record amplification before dispatch', () =>
    Effect.gen(function* ()
    {
      const providerInstanceId = ProviderInstanceId.make('cursor-record-limit')
      const sourcePath = 'acp://cursor/cursor-record-limit/record-heavy'
      const acpSession: AcpImportedSession = {
        meta: {
          source: 'cursor-acp',
          sourcePath,
          contentHash: 'f'.repeat(64),
          nativeSessionId: 'record-heavy',
          cwd: '/workspace/cursor',
          gitBranch: null,
          model: 'cursor-model',
          title: 'Record-heavy import',
          firstActivityAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:03.000Z',
        },
        records: Array.from({ length: 4 }, (_, sourceIndex) => ({
          kind: 'message' as const,
          role: sourceIndex === 0 ? ('user' as const) : ('assistant' as const),
          text: `record ${sourceIndex}`,
          createdAt: `2026-01-01T00:00:0${sourceIndex}.000Z`,
          sourceIndex,
        })),
        warnings: [],
      }
      const run = yield* runStretchImport({
        source: 'cursor',
        sourcePath,
        providerInstanceId,
        sourceDescriptors: [],
        acpSession,
        maximumRequestRecords: 3,
      })

      expect(run.commands).toEqual([])
      expect(run.continuations).toEqual([])
      expect(run.result.imported).toEqual([])
      expect(run.result.failed).toEqual([
        expect.objectContaining({
          sourcePath,
          message: expect.stringContaining('normalized record budget exceeded (3 records maximum)'),
        }),
      ])
    }),
  )

  it.effect('inventories every open replacement and recovers only source-independent phases', () =>
    Effect.gen(function* ()
    {
      const replacementIntents = makeReplacementIntentMemory()
      const awaitingIntents = [
        replacementIntentFixture('intent', 'awaiting-intent'),
        replacementIntentFixture('creating', 'awaiting-creating'),
        replacementIntentFixture('importing', 'awaiting-importing'),
      ]
      const verifyingIntent = replacementIntentFixture('verifying', 'recover-verifying')
      const manualIntent = replacementIntentFixture('manual', 'manual')
      const unsafeTombstoneIntent = replacementIntentFixture('tombstoning', 'unsafe-tombstone')
      for (const intent of [
        ...awaitingIntents,
        verifyingIntent,
        manualIntent,
        unsafeTombstoneIntent,
      ])
      {
        yield* replacementIntents.insertIfAbsent(intent)
      }

      let sourceVisible = true
      let requestContextLoadCount = 0
      const dispatchedCommands: OrchestrationCommand[] = []
      const service = yield* make.pipe(
        Effect.provideService(
          ImportServiceDeps,
          ImportServiceDeps.of({
            dispatch: (command) =>
              Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                if (
                  command.type === 'thread.delete' &&
                  command.threadId === verifyingIntent.sourceThreadId
                )
                {
                  sourceVisible = false
                }
                return { sequence: dispatchedCommands.length }
              }),
            findThreadByContentHash: () => Effect.succeed(null),
            findThreadById: (threadId) =>
              Effect.succeed(
                threadId === verifyingIntent.sourceThreadId && sourceVisible
                  ? {
                      threadId,
                      projectId: verifyingIntent.sourceProjectId,
                      contentHash: 'old-source',
                      source: verifyingIntent.source,
                      sourcePath: verifyingIntent.sourcePath,
                      nativeSessionId: verifyingIntent.nativeSessionId,
                      providerInstanceId: verifyingIntent.providerInstanceId,
                      modelSelection: {
                        instanceId: ProviderInstanceId.make('codex'),
                        model: 'gpt-default',
                      },
                      archived: true,
                    }
                  : null,
              ),
            findProjectByWorkspaceRoot: () => Effect.succeed(null),
            isImportFinalized: () => Effect.succeed(true),
            normalizeWorkspaceRoot: (root) => Effect.succeed(root),
            resolveImportWorkspaceRoot: () =>
              Effect.succeed({ workspaceRoot: '/workspace/imported-history' }),
            threadExistsInShell: () => Effect.succeed(false),
            replacementIntents,
            verifyReplacementThread: (replacement) =>
              Effect.succeed({
                replacementThreadId: replacement.replacementThreadId,
                projectId: replacement.replacementProjectId,
                sourceVersion: replacement.sourceVersion,
                messageCount: replacement.expectedMessageCount,
                activityCount: replacement.expectedActivityCount,
                snapshotSequence: 2,
                verifiedAt: '2026-01-01T00:00:01.000Z',
              }),
            verifyReplacementAttachments: () => Effect.succeed({ complete: true }),
            cleanupDeletedThreadAttachments: () => Effect.succeed({ complete: true }),
            verifyReplacementIndex: ({ replacementThreadId, sourceThreadId }) =>
              Effect.succeed({
                replacementVisible: replacementThreadId === verifyingIntent.replacementThreadId,
                sourceVisible: sourceThreadId === verifyingIntent.sourceThreadId && sourceVisible,
              }),
            loadRequestContext: () =>
              Effect.sync(() =>
              {
                requestContextLoadCount += 1
                return {
                  fallbackModelSelection: {
                    instanceId: ProviderInstanceId.make('codex'),
                    model: 'gpt-default',
                  },
                  sourceDescriptors: [],
                  resolveImportTarget: () => Effect.succeed(null),
                  loadAcpSessionsBatch: () => Effect.succeed([]),
                }
              }),
          }),
        ),
        Effect.provideService(
          ImportContinuationDeps,
          ImportContinuationDeps.of({
            bind: () => Effect.die('startup recovery must not bind continuation state'),
          }),
        ),
      )

      const inventory = yield* service.inspectOpenReplacementIntents
      expect(inventory).toMatchObject({
        openIntentCount: 6,
        awaitingSourceRetryCount: 3,
        manualCount: 1,
        recoveredCount: 0,
        blockedCount: 2,
      })
      expect(dispatchedCommands).toEqual([])
      expect(yield* replacementIntents.listOpen()).toHaveLength(6)

      const recovery = yield* service.recoverOpenReplacementIntents
      expect(recovery).toMatchObject({
        openIntentCount: 6,
        awaitingSourceRetryCount: 3,
        manualCount: 2,
        recoveredCount: 1,
        blockedCount: 0,
      })
      expect(recovery.items).toContainEqual(
        expect.objectContaining({
          intentKey: unsafeTombstoneIntent.intentKey,
          disposition: 'manual',
        }),
      )
      expect(requestContextLoadCount).toBe(0)
      expect(dispatchedCommands).toEqual([
        {
          type: 'thread.delete',
          commandId: verifyingIntent.tombstoneCommandId,
          threadId: verifyingIntent.sourceThreadId,
        },
      ])
      expect(
        Option.getOrThrow(yield* replacementIntents.getByIntentKey(verifyingIntent.intentKey)),
      ).toMatchObject({ phase: 'retired' })
      expect(yield* replacementIntents.listOpen()).toHaveLength(5)
    }),
  )

  it.effect('interrupts a hung import deadline', () =>
    Effect.gen(function* ()
    {
      const providerInstanceId = ProviderInstanceId.make('cursor-request-deadline')
      const sourcePath = 'acp://cursor/cursor-request-deadline/native-session'
      const requestDeadlineMs = 100
      const dispatchStarted = yield* Deferred.make<void>()
      const acpSession: AcpImportedSession = {
        meta: {
          source: 'cursor-acp',
          sourcePath,
          contentHash: '1'.repeat(64),
          nativeSessionId: 'native-session',
          cwd: '/workspace/cursor',
          gitBranch: null,
          model: 'cursor-model',
          title: 'Deadline import',
          firstActivityAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        },
        records: [
          {
            kind: 'message',
            role: 'user',
            text: 'resume after timeout',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceIndex: 0,
          },
        ],
        warnings: [],
      }
      const timedOutFiber = yield* runStretchImport({
        source: 'cursor',
        sourcePath,
        providerInstanceId,
        sourceDescriptors: [],
        acpSession,
        requestDeadlineMs,
        dispatch: () =>
          Deferred.succeed(dispatchStarted, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Effect.forkScoped)

      yield* Deferred.await(dispatchStarted)
      yield* TestClock.adjust(Duration.millis(requestDeadlineMs))
      const timedOut = yield* Fiber.join(timedOutFiber)

      expect(timedOut.result.imported).toEqual([])
      expect(timedOut.result.failed).toEqual([
        {
          sourcePath,
          message: `import request exceeded its ${requestDeadlineMs}ms aggregate execution deadline; retry is safe because import command identifiers are deterministic`,
        },
      ])

      const retry = yield* runStretchImport({
        source: 'cursor',
        sourcePath,
        providerInstanceId,
        sourceDescriptors: [],
        acpSession,
        requestDeadlineMs,
      })

      expect(retry.result.failed).toEqual([])
      expect(retry.result.imported).toEqual([
        expect.objectContaining({
          sourcePath,
        }),
      ])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )

  it.effect('isolates concurrent imports owned by independent service scopes', () =>
    Effect.gen(function* ()
    {
      const firstProviderInstanceId = ProviderInstanceId.make('cursor-mutex-first')
      const secondProviderInstanceId = ProviderInstanceId.make('cursor-mutex-second')
      const firstSourcePath = 'acp://cursor/cursor-mutex-first/first-session'
      const secondSourcePath = 'acp://cursor/cursor-mutex-second/second-session'
      const secondSession = sizedAcpSession({
        sourcePath: secondSourcePath,
        nativeSessionId: 'second-session',
        serializedBytes: 2_048,
      })
      const firstLoadStarted = yield* Deferred.make<void>()
      const secondLoadStarted = yield* Deferred.make<void>()
      const batchResult = (
        request: Parameters<ImportRequestContext['loadAcpSessionsBatch']>[0],
        session: AcpImportedSession,
      ): AcpImportBatchLoadResult => ({
        sourcePath: request.sourcePaths[0]!,
        descriptor: {
          driverKind: request.source,
          providerInstanceId: request.providerInstanceId,
          source: request.source === 'cursor' ? 'cursor-acp' : 'grok-acp',
          sourcePath: request.sourcePaths[0]!,
          nativeSessionId: session.meta.nativeSessionId,
          cwd: session.meta.cwd,
          title: session.meta.title,
          updatedAt: session.meta.lastActivityAt,
        },
        session,
        error: null,
      })
      const firstFiber = yield* runStretchImport({
        source: 'cursor',
        sourcePath: firstSourcePath,
        providerInstanceId: firstProviderInstanceId,
        sourceDescriptors: [],
        loadAcpSessionsBatch: (_request) =>
          Effect.gen(function* ()
          {
            yield* Deferred.succeed(firstLoadStarted, undefined)
            return yield* Effect.never
          }),
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(firstLoadStarted)

      const runSecondImport = () =>
        runStretchImport({
          source: 'cursor',
          sourcePath: secondSourcePath,
          providerInstanceId: secondProviderInstanceId,
          sourceDescriptors: [],
          loadAcpSessionsBatch: (request) =>
            Deferred.succeed(secondLoadStarted, undefined).pipe(
              Effect.as([batchResult(request, secondSession)]),
            ),
        })
      const overlappingRun = yield* runSecondImport()

      expect(yield* Deferred.isDone(secondLoadStarted)).toBe(true)
      expect(overlappingRun.result.failed).toEqual([])
      expect(overlappingRun.result.imported).toEqual([
        expect.objectContaining({ sourcePath: secondSourcePath }),
      ])

      yield* Fiber.interrupt(firstFiber)
    }),
  )

  it.effect('keeps identical content hashes isolated by import source', () =>
    Effect.gen(function* ()
    {
      const run = yield* runCrossSourceHashImport()
      const threadCreates = run.commands.filter(
        (command): command is Extract<OrchestrationCommand, { type: 'thread.create' }> =>
          command.type === 'thread.create',
      )

      expect(run.result.imported).toHaveLength(2)
      expect(run.result.skipped).toEqual([])
      expect(threadCreates).toHaveLength(2)
      expect(new Set(threadCreates.map((command) => command.threadId)).size).toBe(2)
      expect(new Set(threadCreates.map((command) => command.commandId)).size).toBe(2)
    }),
  )

  it.effect('groups sessions without recorded cwd in the imported-history project', () =>
    Effect.gen(function* ()
    {
      const holdingWorkspaceRoot = '/state/imported-history'
      const sourcePath = yield* Effect.promise(() =>
        temporaryFile(
          [
            '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"native"}}',
            '{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"hello"}}',
          ].join('\n'),
        ),
      )
      const run = yield* runImport({
        sourcePath,
        resolveImportWorkspaceRoot: (request) =>
        {
          expect(request.recordedWorkspaceRoot).toBeNull()
          return Effect.succeed({ workspaceRoot: holdingWorkspaceRoot })
        },
      })

      expect(run.result.failed).toEqual([])
      expect(run.result.imported).toHaveLength(1)
      expect(run.commands.find((command) => command.type === 'project.create')).toMatchObject({
        title: 'Imported history',
        workspaceRoot: holdingWorkspaceRoot,
      })
      expect(
        run.commands.find((command) => command.type === 'thread.create')?.origin,
      ).not.toHaveProperty('originalWorkspaceRoot')
      expect(run.result.imported[0]?.continuation).toMatchObject({
        state: 'history-only',
        reason: 'the original workspace was not recorded',
      })
    }),
  )

  it.effect('rejects source paths outside the scan roots without reading them', () =>
    Effect.gen(function* ()
    {
      const run = yield* runImport({ sourcePath: '/etc/hosts' })

      expect(run.commands).toEqual([])
      expect(run.continuations).toEqual([])
      expect(run.result.failed).toHaveLength(1)
      expect(run.result.failed[0]).toMatchObject({ sourcePath: '/etc/hosts' })
      expect(run.result.failed[0]?.message).toContain('outside every configured import root')
    }),
  )
})
