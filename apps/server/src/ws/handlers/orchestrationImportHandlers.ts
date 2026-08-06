// apps/server/src/ws/handlers/orchestrationImportHandlers.ts
// import-scan and import-sessions websocket rpc handlers

import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  ORCHESTRATION_WS_METHODS,
  type ProjectId,
  ThreadId,
  type WsRpcGroup,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Path from 'effect/Path'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import * as ServerConfig from '../../config.ts'
import type { OrchestrationProjectionPipeline } from '../../orchestration/Services/ProjectionPipeline.ts'
import type * as ProjectionSnapshotQuery from '../../orchestration/Services/ProjectionSnapshotQuery.ts'
import type { ImportReplacementIntentRepository } from '../../persistence/Services/ImportReplacementIntents.ts'
import * as ImportContinuation from '../../import/continuation/continuationContract.ts'
import * as ImportDiscovery from '../../import/discovery/discovery.ts'
import * as ImportSessions from '../../import/importService.ts'
import {
  AcpImportError,
  loadAcpImportSessionsBatch,
  scanAcpImportCatalog,
} from '../../import/parsers/acpImport.ts'
import { partitionAcpImportBytePolicy } from '../../import/discovery/resourceLimits.ts'
import {
  resolveAcpImportSourceCatalog,
  resolveSourceCatalog,
} from '../../import/discovery/sourceCatalog.ts'
import type * as ProviderRegistry from '../../provider/Services/ProviderRegistry.ts'
import * as ServerRuntimeStartup from '../../serverRuntimeStartup.ts'
import type * as ServerSettings from '../../serverSettings.ts'
import type * as WorkspacePaths from '../../workspace/WorkspacePaths.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'

type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>
type ImportRpcHandlers = Pick<
  WsRpcHandlers,
  typeof ORCHESTRATION_WS_METHODS.importScan | typeof ORCHESTRATION_WS_METHODS.importSessions
>

export interface OrchestrationImportHandlerDependencies
{
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner['Service']
  readonly config: ServerConfig.ServerConfig['Service']
  readonly importContinuationFromContext: Layer.Layer<
    ImportContinuation.ImportContinuationDeps,
    never,
    ImportContinuation.ImportContinuationDeps
  >
  readonly importReplacementIntents: ImportReplacementIntentRepository['Service']
  readonly path: Path.Path
  readonly projectionPipeline: OrchestrationProjectionPipeline['Service']
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  readonly providerRegistry: ProviderRegistry.ProviderRegistry['Service']
  readonly serverSettings: ServerSettings.ServerSettingsService['Service']
  readonly workspacePaths: WorkspacePaths.WorkspacePaths['Service']
  readonly dispatchNormalizedCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>
  readonly toDispatchCommandError: (
    cause: unknown,
    fallbackMessage: string,
  ) => OrchestrationDispatchCommandError
  readonly observeRpcEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcEffect']
}

export const IMPORT_RPC_ENVELOPE_DEADLINE_MS = ImportSessions.IMPORT_REQUEST_DEADLINE_MS + 30_000

interface ImportedThreadShellIndex
{
  readonly find: (
    lookup: Omit<ImportSessions.ImportedThreadLookup, 'contentHash'>,
  ) => ImportSessions.ImportedThreadMatch | null
  readonly findById: (threadId: ThreadId) => ImportSessions.ImportedThreadMatch | null
  readonly addThread: (
    thread: OrchestrationShellSnapshot['threads'][number],
    archived: boolean,
  ) => void
}

function importedSourcePathKey(source: string, sourcePath: string): string
{
  return JSON.stringify([source, sourcePath])
}

function importedNativeSessionKey(
  source: string,
  providerInstanceId: string | null,
  nativeSessionId: string,
): string
{
  return JSON.stringify([source, providerInstanceId, nativeSessionId])
}

export function makeImportedThreadShellIndex(
  context: ProjectionSnapshotQuery.ProjectionImportReconciliationContext,
): ImportedThreadShellIndex
{
  const bySourcePath = new Map<string, ImportSessions.ImportedThreadMatch>()
  const byNativeSession = new Map<string, ImportSessions.ImportedThreadMatch>()
  const byThreadId = new Map<ThreadId, ImportSessions.ImportedThreadMatch>()
  const projectWorkspaceRoots = new Map(
    context.projects.map((project) => [project.projectId, project.workspaceRoot]),
  )
  const addMatch = (thread: {
    readonly id: ThreadId
    readonly projectId: ProjectId
    readonly modelSelection: OrchestrationThreadDetailSnapshot['thread']['modelSelection']
    readonly origin: NonNullable<OrchestrationThreadDetailSnapshot['thread']['origin']>
    readonly archived: boolean
  }) =>
  {
    const workspaceRoot = projectWorkspaceRoots.get(thread.projectId)
    const match = {
      threadId: thread.id,
      projectId: thread.projectId,
      contentHash: thread.origin.contentHash,
      source: thread.origin.source,
      sourcePath: thread.origin.sourcePath,
      nativeSessionId: thread.origin.nativeSessionId,
      providerInstanceId: thread.origin.providerInstanceId,
      modelSelection: thread.modelSelection,
      archived: thread.archived,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(thread.origin.originalWorkspaceRoot === undefined
        ? {}
        : { originalWorkspaceRoot: thread.origin.originalWorkspaceRoot }),
    } satisfies ImportSessions.ImportedThreadMatch
    byThreadId.set(thread.id, match)
    const sourcePathKey = importedSourcePathKey(thread.origin.source, thread.origin.sourcePath)
    if (!bySourcePath.has(sourcePathKey))
    {
      bySourcePath.set(sourcePathKey, match)
    }
    if (thread.origin.nativeSessionId !== null)
    {
      const nativeSessionKey = importedNativeSessionKey(
        thread.origin.source,
        thread.origin.providerInstanceId,
        thread.origin.nativeSessionId,
      )
      if (!byNativeSession.has(nativeSessionKey))
      {
        byNativeSession.set(nativeSessionKey, match)
      }
    }
  }
  const addThread: ImportedThreadShellIndex['addThread'] = (thread, archived) =>
  {
    if (thread.origin === null)
    {
      return
    }
    addMatch({
      id: thread.id,
      projectId: thread.projectId,
      modelSelection: thread.modelSelection,
      origin: thread.origin,
      archived,
    })
  }
  for (const thread of context.threads)
  {
    if (!thread.archived)
    {
      addMatch({
        id: thread.threadId,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        origin: thread.origin,
        archived: false,
      })
    }
  }
  for (const thread of context.threads)
  {
    if (thread.archived)
    {
      addMatch({
        id: thread.threadId,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        origin: thread.origin,
        archived: true,
      })
    }
  }
  return {
    addThread,
    findById: (threadId) => byThreadId.get(threadId) ?? null,
    find: (lookup) =>
      bySourcePath.get(importedSourcePathKey(lookup.source, lookup.sourcePath)) ??
      (lookup.nativeSessionId === null
        ? null
        : (byNativeSession.get(
            importedNativeSessionKey(
              lookup.source,
              lookup.providerInstanceId,
              lookup.nativeSessionId,
            ),
          ) ?? null)),
  }
}

export function makeOrchestrationImportHandlers({
  childProcessSpawner,
  config,
  importContinuationFromContext,
  importReplacementIntents,
  path,
  projectionPipeline,
  projectionSnapshotQuery,
  providerRegistry,
  serverSettings,
  workspacePaths,
  dispatchNormalizedCommand,
  toDispatchCommandError,
  observeRpcEffect,
}: OrchestrationImportHandlerDependencies): ImportRpcHandlers
{
  return {
    [ORCHESTRATION_WS_METHODS.importScan]: (_input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.importScan,
        Effect.gen(function* ()
        {
          const [reconciliationContext, settings] = yield* Effect.all([
            projectionSnapshotQuery.getImportReconciliationContext(),
            serverSettings.getSettings,
          ])
          const importedThreadIndex = makeImportedThreadShellIndex(reconciliationContext)
          const discovery = yield* ImportDiscovery.make.pipe(
            Effect.provideService(
              ImportDiscovery.ImportDiscoveryDeps,
              ImportDiscovery.ImportDiscoveryDeps.of({
                findImportedThread: (lookup) => Effect.succeed(importedThreadIndex.find(lookup)),
                findProjectByWorkspaceRoot: (normalizedRoot) =>
                  Effect.succeed(
                    reconciliationContext.projects.find(
                      (project) => project.workspaceRoot === normalizedRoot,
                    )?.projectId ?? null,
                  ),
                normalizeWorkspaceRoot: (workspaceRoot) =>
                  workspacePaths.normalizeWorkspaceRoot(workspaceRoot),
                scanAcpSource: (descriptor) =>
                  scanAcpImportCatalog(descriptor.connection).pipe(
                    Effect.provideService(
                      ChildProcessSpawner.ChildProcessSpawner,
                      childProcessSpawner,
                    ),
                  ),
              }),
            ),
          )
          return yield* discovery.scan(settings, { cwd: config.cwd })
        }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: 'Failed to load session import scan context',
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'orchestration' },
      ),
    [ORCHESTRATION_WS_METHODS.importSessions]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.importSessions,
        Effect.gen(function* ()
        {
          const [providers, settings] = yield* Effect.all([
            providerRegistry.getProviders,
            serverSettings.getSettings,
          ])
          const requestedSources = new Set(input.items.map((item) => item.source))
          const needsFileCatalog =
            requestedSources.has('codex-cli') ||
            requestedSources.has('claude-code') ||
            requestedSources.has('opencode')
          const needsAcpCatalog = requestedSources.has('cursor') || requestedSources.has('grok')
          const [sourceCatalog, acpSourceCatalog] = yield* Effect.all(
            [
              needsFileCatalog
                ? resolveSourceCatalog(settings, { cwd: config.cwd })
                : Effect.succeed({ descriptors: [], errors: [] }),
              needsAcpCatalog
                ? resolveAcpImportSourceCatalog(settings, { cwd: config.cwd })
                : Effect.succeed({ descriptors: [], errors: [] }),
            ],
            { concurrency: 'unbounded' },
          )
          const fallbackModelSelection =
            ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection()
          const importedHistoryWorkspaceRoot = path.join(config.stateDir, 'imported-history')
          yield* importReplacementIntents.listOpen()
          let importReconciliationContext =
            yield* projectionSnapshotQuery.getImportReconciliationContext()
          let importedThreadIndex = makeImportedThreadShellIndex(importReconciliationContext)
          let importedProjectByWorkspaceRoot = new Map(
            importReconciliationContext.projects.map((project) => [
              project.workspaceRoot,
              project.projectId,
            ]),
          )
          let importedThreadIndexDirty = false
          const refreshImportedThreadIndex = Effect.gen(function* ()
          {
            importReconciliationContext =
              yield* projectionSnapshotQuery.getImportReconciliationContext()
            importedThreadIndex = makeImportedThreadShellIndex(importReconciliationContext)
            importedProjectByWorkspaceRoot = new Map(
              importReconciliationContext.projects.map((project) => [
                project.workspaceRoot,
                project.projectId,
              ]),
            )
            importedThreadIndexDirty = false
          })
          const dispatchImportCommand = (command: OrchestrationCommand) =>
            dispatchNormalizedCommand(command).pipe(
              Effect.tapError(() =>
                command.type === 'project.create' ||
                command.type === 'thread.create' ||
                command.type === 'thread.archive' ||
                command.type === 'thread.delete'
                  ? Effect.sync(() =>
                    {
                      importedThreadIndexDirty = true
                    })
                  : Effect.void,
              ),
              Effect.tap(() =>
              {
                if (command.type === 'thread.archive' || command.type === 'thread.delete')
                {
                  return Effect.sync(() =>
                  {
                    importedThreadIndexDirty = true
                  })
                }
                if (command.type === 'project.create')
                {
                  return projectionSnapshotQuery.getProjectShellById(command.projectId).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () =>
                          Effect.sync(() =>
                          {
                            importedThreadIndexDirty = true
                          }),
                        onSome: (project) =>
                          Effect.sync(() =>
                          {
                            importedProjectByWorkspaceRoot.set(project.workspaceRoot, project.id)
                          }),
                      }),
                    ),
                    Effect.catch(() =>
                      Effect.sync(() =>
                      {
                        importedThreadIndexDirty = true
                      }),
                    ),
                  )
                }
                return command.type === 'thread.create'
                  ? projectionSnapshotQuery.getThreadShellById(command.threadId).pipe(
                      Effect.flatMap(
                        Option.match({
                          onNone: () =>
                            Effect.sync(() =>
                              {
                              importedThreadIndexDirty = true
                            }),
                          onSome: (thread) =>
                            Effect.sync(() =>
                              {
                              importedThreadIndex.addThread(thread, false)
                            }),
                        }),
                      ),
                      Effect.catch(() =>
                        Effect.sync(() =>
                          {
                          importedThreadIndexDirty = true
                        }),
                      ),
                    )
                  : Effect.void
              }),
            )
          const importService = yield* ImportSessions.make.pipe(
            Effect.provideService(
              ImportSessions.ImportServiceDeps,
              ImportSessions.ImportServiceDeps.of({
                dispatch: dispatchImportCommand,
                replacementIntents: importReplacementIntents,
                findThreadByContentHash: (lookup) =>
                  Effect.suspend(() =>
                    importedThreadIndexDirty
                      ? refreshImportedThreadIndex.pipe(
                          Effect.map(() => importedThreadIndex.find(lookup)),
                        )
                      : Effect.succeed(importedThreadIndex.find(lookup)),
                  ),
                findThreadById: (threadId) =>
                  Effect.suspend(() =>
                    importedThreadIndexDirty
                      ? refreshImportedThreadIndex.pipe(
                          Effect.map(() => importedThreadIndex.findById(threadId)),
                        )
                      : Effect.succeed(importedThreadIndex.findById(threadId)),
                  ),
                findProjectByWorkspaceRoot: (normalizedRoot) =>
                  Effect.suspend(() =>
                    importedThreadIndexDirty
                      ? refreshImportedThreadIndex.pipe(
                          Effect.map(
                            () => importedProjectByWorkspaceRoot.get(normalizedRoot) ?? null,
                          ),
                        )
                      : Effect.succeed(importedProjectByWorkspaceRoot.get(normalizedRoot) ?? null),
                  ),
                isImportFinalized: (threadId) =>
                  projectionSnapshotQuery.isThreadImportFinalized(threadId),
                normalizeWorkspaceRoot: (workspaceRoot) =>
                  workspacePaths.normalizeWorkspaceRoot(workspaceRoot),
                resolveImportWorkspaceRoot: (request) =>
                {
                  if (request.recordedWorkspaceRoot === null)
                  {
                    return workspacePaths
                      .normalizeWorkspaceRoot(importedHistoryWorkspaceRoot, {
                        createIfMissing: true,
                      })
                      .pipe(Effect.map((workspaceRoot) => ({ workspaceRoot })))
                  }
                  if (request.originalWorkspaceRoot !== undefined)
                  {
                    if (request.existingWorkspaceRoot === undefined)
                    {
                      return Effect.fail(
                        new OrchestrationDispatchCommandError({
                          message:
                            'The imported thread project is missing its selected workspace root',
                        }),
                      )
                    }
                    return workspacePaths
                      .normalizeWorkspaceRoot(request.existingWorkspaceRoot)
                      .pipe(
                        Effect.map((workspaceRoot) => ({
                          workspaceRoot,
                          originalWorkspaceRoot: request.originalWorkspaceRoot,
                        })),
                      )
                  }
                  return workspacePaths.normalizeWorkspaceRoot(request.recordedWorkspaceRoot).pipe(
                    Effect.map((workspaceRoot) => ({ workspaceRoot })),
                    Effect.catchTag('WorkspaceRootNotExistsError', (missingWorkspace) =>
                      workspacePaths
                        .normalizeWorkspaceRoot(importedHistoryWorkspaceRoot, {
                          createIfMissing: true,
                        })
                        .pipe(
                          Effect.map((workspaceRoot) => ({
                            workspaceRoot,
                            originalWorkspaceRoot: missingWorkspace.normalizedWorkspaceRoot,
                          })),
                        ),
                    ),
                  )
                },
                resolveImportTarget: (driver, requestedInstanceId, compatibleInstanceIds) =>
                {
                  const compatibleIds = new Set(compatibleInstanceIds)
                  const eligibleProviders = providers.filter(
                    (candidate) =>
                      candidate.driver === driver &&
                      compatibleIds.has(candidate.instanceId) &&
                      candidate.enabled &&
                      candidate.installed &&
                      candidate.availability !== 'unavailable',
                  )
                  if (requestedInstanceId !== null && !compatibleIds.has(requestedInstanceId))
                  {
                    return Effect.succeed(null)
                  }
                  const defaultInstanceId = defaultInstanceIdForDriver(driver)
                  const provider =
                    requestedInstanceId === null
                      ? (eligibleProviders.find(
                          (candidate) => candidate.instanceId === defaultInstanceId,
                        ) ?? eligibleProviders[0])
                      : eligibleProviders.find(
                          (candidate) => candidate.instanceId === requestedInstanceId,
                        )
                  if (provider === undefined) return Effect.succeed(null)
                  const model =
                    provider.models.find((candidate) => candidate.isDefault)?.slug ??
                    provider.models[0]?.slug ??
                    DEFAULT_MODEL_BY_PROVIDER[driver] ??
                    fallbackModelSelection.model
                  return Effect.succeed({
                    defaultModelSelection: {
                      instanceId: provider.instanceId,
                      model,
                    },
                    availableModels: provider.models.map((candidate) => candidate.slug),
                  })
                },
                threadExistsInShell: (threadId) =>
                  projectionSnapshotQuery
                    .getThreadShellById(threadId)
                    .pipe(Effect.map(Option.isSome)),
                verifyReplacementThread: (replacement) =>
                  projectionSnapshotQuery
                    .getThreadDetailSnapshot(replacement.replacementThreadId)
                    .pipe(
                      Effect.map(
                        Option.match({
                          onNone: () => null,
                          onSome: (snapshot) =>
                          {
                            const origin = snapshot.thread.origin
                            if (
                              snapshot.thread.projectId !== replacement.replacementProjectId ||
                              origin?.kind !== 'imported' ||
                              origin.source !== replacement.source ||
                              origin.sourcePath !== replacement.sourcePath ||
                              origin.nativeSessionId !== replacement.nativeSessionId ||
                              origin.providerInstanceId !== replacement.providerInstanceId ||
                              (origin.originalWorkspaceRoot ?? null) !==
                                replacement.originalWorkspaceRoot ||
                              origin.contentHash !== replacement.sourceVersion ||
                              snapshot.thread.messages.length !==
                                replacement.expectedMessageCount ||
                              snapshot.thread.activities.length !==
                                replacement.expectedActivityCount
                            )
                            {
                              return null
                            }
                            return {
                              replacementThreadId: replacement.replacementThreadId,
                              projectId: replacement.replacementProjectId,
                              sourceVersion: replacement.sourceVersion,
                              messageCount: snapshot.thread.messages.length,
                              activityCount: snapshot.thread.activities.length,
                              snapshotSequence: snapshot.snapshotSequence,
                              verifiedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                            }
                          },
                        }),
                      ),
                    ),
                verifyReplacementAttachments: (replacement) =>
                  projectionPipeline.verifyThreadAttachmentSet!({
                    threadId: replacement.replacementThreadId,
                    expectedRelativePaths: replacement.expectedRelativePaths,
                  }),
                cleanupDeletedThreadAttachments: (sourceThreadId) =>
                  projectionPipeline.cleanupDeletedThreadAttachments!(sourceThreadId),
                verifyReplacementIndex: (replacement) =>
                  refreshImportedThreadIndex.pipe(
                    Effect.map(() => ({
                      replacementVisible:
                        importedThreadIndex.findById(replacement.replacementThreadId) !== null,
                      sourceVisible:
                        importedThreadIndex.findById(replacement.sourceThreadId) !== null,
                    })),
                  ),
                fallbackModelSelection,
                sourceDescriptors: sourceCatalog.descriptors,
                loadAcpSessionsBatch: ({
                  source,
                  sourcePaths,
                  providerInstanceId,
                  maximumBytes,
                  wireUsage,
                }) =>
                {
                  const descriptor = acpSourceCatalog.descriptors.find(
                    (candidate) =>
                      candidate.source === source &&
                      candidate.providerInstanceId === providerInstanceId,
                  )
                  if (descriptor === undefined)
                  {
                    const error = new AcpImportError(
                      'invalid-source',
                      `No configured ${source} import source exists for provider instance '${providerInstanceId}'.`,
                    )
                    return Effect.succeed(
                      sourcePaths.map((sourcePath) => ({
                        sourcePath,
                        descriptor: null,
                        session: null,
                        error,
                      })),
                    )
                  }
                  const boundedBytePolicy = partitionAcpImportBytePolicy(
                    maximumBytes,
                    descriptor.connection.policy,
                  )
                  if (boundedBytePolicy === null)
                  {
                    const error = new AcpImportError(
                      'limit-exceeded',
                      `The remaining ACP import byte budget is too small to load provider instance '${providerInstanceId}'.`,
                    )
                    return Effect.succeed(
                      sourcePaths.map((sourcePath) => ({
                        sourcePath,
                        descriptor: null,
                        session: null,
                        error,
                      })),
                    )
                  }
                  return loadAcpImportSessionsBatch(
                    {
                      ...descriptor.connection,
                      policy: {
                        ...descriptor.connection.policy,
                        ...boundedBytePolicy,
                      },
                      wireUsage,
                    },
                    sourcePaths,
                  ).pipe(
                    Effect.provideService(
                      ChildProcessSpawner.ChildProcessSpawner,
                      childProcessSpawner,
                    ),
                  )
                },
              }),
            ),
            Effect.provide(importContinuationFromContext),
          )
          return yield* importService.importSessions(input)
        }).pipe(
          Effect.timeoutOption(IMPORT_RPC_ENVELOPE_DEADLINE_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new OrchestrationDispatchCommandError({
                    message: `Session import initialization and execution exceeded ${IMPORT_RPC_ENVELOPE_DEADLINE_MS}ms`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, 'Failed to initialize session import'),
          ),
        ),
        { 'rpc.aggregate': 'orchestration' },
      ),
  }
}
