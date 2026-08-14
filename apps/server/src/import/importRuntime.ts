// apps/server/src/import/importRuntime.ts
// composes the long-lived import subsystem from production runtime services

import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  OrchestrationDispatchCommandError,
  type OrchestrationThreadDetailSnapshot,
  type ProjectId,
  ProviderInstanceId,
  type ThreadId,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import * as ServerConfig from '../config.ts'
import { dispatchWithAttachmentLifecycle } from '../orchestration/dispatchWithAttachmentLifecycle.ts'
import * as OrchestrationEngine from '../orchestration/Services/OrchestrationEngine.ts'
import { OrchestrationProjectionPipeline } from '../orchestration/Services/ProjectionPipeline.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import { AttachmentLifecycleRepository } from '../persistence/Services/AttachmentLifecycle.ts'
import { ImportReplacementIntentRepository } from '../persistence/Services/ImportReplacementIntents.ts'
import * as ProviderRegistry from '../provider/Services/ProviderRegistry.ts'
import * as ServerSettings from '../serverSettings.ts'
import * as WorkspacePaths from '../workspace/WorkspacePaths.ts'
import * as ImportDiscovery from './discovery/discovery.ts'
import { partitionAcpImportBytePolicy } from './discovery/resourceLimits.ts'
import { resolveAcpImportSourceCatalog, resolveSourceCatalog } from './discovery/sourceCatalog.ts'
import * as ImportService from './importService.ts'
import {
  AcpImportError,
  loadAcpImportSessionsBatch,
  scanAcpImportCatalog,
} from './parsers/acpImport.ts'

interface ImportedThreadShellIndex
{
  readonly find: (
    lookup: Omit<ImportService.ImportedThreadLookup, 'contentHash'>,
  ) => ImportService.ImportedThreadMatch | null
  readonly findById: (threadId: ThreadId) => ImportService.ImportedThreadMatch | null
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
  const bySourcePath = new Map<string, ImportService.ImportedThreadMatch>()
  const byNativeSession = new Map<string, ImportService.ImportedThreadMatch>()
  const byThreadId = new Map<ThreadId, ImportService.ImportedThreadMatch>()
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
    } satisfies ImportService.ImportedThreadMatch
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
  for (const archived of [false, true])
  {
    for (const thread of context.threads)
    {
      if (thread.archived !== archived) continue
      addMatch({
        id: thread.threadId,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        origin: thread.origin,
        archived,
      })
    }
  }
  return {
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

export const make = Effect.gen(function* ()
{
  const attachmentLifecycle = yield* AttachmentLifecycleRepository
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const config = yield* ServerConfig.ServerConfig
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService
  const path = yield* Path.Path
  const projectionPipeline = yield* OrchestrationProjectionPipeline
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry
  const replacementIntents = yield* ImportReplacementIntentRepository
  const serverSettings = yield* ServerSettings.ServerSettingsService
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths

  const verifyThreadAttachmentSet = projectionPipeline.verifyThreadAttachmentSet
  const cleanupDeletedThreadAttachments = projectionPipeline.cleanupDeletedThreadAttachments
  if (verifyThreadAttachmentSet === undefined || cleanupDeletedThreadAttachments === undefined)
  {
    return yield* Effect.die(
      new Error('The production import runtime requires projection attachment verification ports'),
    )
  }

  const readImportedThreadIndex = projectionSnapshotQuery
    .getImportReconciliationContext()
    .pipe(Effect.map(makeImportedThreadShellIndex))
  const importedHistoryWorkspaceRoot = path.join(config.stateDir, 'imported-history')

  const importServiceDeps = ImportService.ImportServiceDeps.of({
    dispatch: (command) =>
      dispatchWithAttachmentLifecycle(command, orchestrationEngine.dispatch(command)).pipe(
        Effect.provideService(AttachmentLifecycleRepository, attachmentLifecycle),
      ),
    replacementIntents,
    findThreadByContentHash: (lookup) =>
      readImportedThreadIndex.pipe(Effect.map((index) => index.find(lookup))),
    findThreadById: (threadId) =>
      readImportedThreadIndex.pipe(Effect.map((index) => index.findById(threadId))),
    findProjectByWorkspaceRoot: (normalizedRoot) =>
      projectionSnapshotQuery
        .getActiveProjectByWorkspaceRoot(normalizedRoot)
        .pipe(Effect.map(Option.match({ onNone: () => null, onSome: (project) => project.id }))),
    isImportFinalized: (threadId) => projectionSnapshotQuery.isThreadImportFinalized(threadId),
    normalizeWorkspaceRoot: (workspaceRoot) => workspacePaths.normalizeWorkspaceRoot(workspaceRoot),
    resolveImportWorkspaceRoot: (request) =>
    {
      if (request.recordedWorkspaceRoot === null)
      {
        return workspacePaths
          .normalizeWorkspaceRoot(importedHistoryWorkspaceRoot, { createIfMissing: true })
          .pipe(Effect.map((workspaceRoot) => ({ workspaceRoot })))
      }
      if (request.originalWorkspaceRoot !== undefined)
      {
        if (request.existingWorkspaceRoot === undefined)
        {
          return Effect.fail(
            new OrchestrationDispatchCommandError({
              message: 'The imported thread project is missing its selected workspace root',
            }),
          )
        }
        return workspacePaths.normalizeWorkspaceRoot(request.existingWorkspaceRoot).pipe(
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
            .normalizeWorkspaceRoot(importedHistoryWorkspaceRoot, { createIfMissing: true })
            .pipe(
              Effect.map((workspaceRoot) => ({
                workspaceRoot,
                originalWorkspaceRoot: missingWorkspace.normalizedWorkspaceRoot,
              })),
            ),
        ),
      )
    },
    threadExistsInShell: (threadId) =>
      projectionSnapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.isSome)),
    verifyReplacementThread: (replacement) =>
      projectionSnapshotQuery.getThreadDetailSnapshot(replacement.replacementThreadId).pipe(
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
                (origin.originalWorkspaceRoot ?? null) !== replacement.originalWorkspaceRoot ||
                origin.contentHash !== replacement.sourceVersion ||
                snapshot.thread.messages.length !== replacement.expectedMessageCount ||
                snapshot.thread.activities.length !== replacement.expectedActivityCount
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
      verifyThreadAttachmentSet({
        threadId: replacement.replacementThreadId,
        expectedRelativePaths: replacement.expectedRelativePaths,
      }),
    cleanupDeletedThreadAttachments: (sourceThreadId) =>
      cleanupDeletedThreadAttachments(sourceThreadId),
    verifyReplacementIndex: (replacement) =>
      readImportedThreadIndex.pipe(
        Effect.map((index) => ({
          replacementVisible: index.findById(replacement.replacementThreadId) !== null,
          sourceVisible: index.findById(replacement.sourceThreadId) !== null,
        })),
      ),
    loadRequestContext: (request) =>
      Effect.gen(function* ()
      {
        const [providers, settings] = yield* Effect.all([
          providerRegistry.getProviders,
          serverSettings.getSettings,
        ])
        const requestedSources = new Set(request.items.map((item) => item.source))
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
        const fallbackModelSelection = {
          instanceId: ProviderInstanceId.make('codex'),
          model: DEFAULT_MODEL,
        }
        return {
          fallbackModelSelection,
          sourceDescriptors: sourceCatalog.descriptors,
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
              defaultModelSelection: { instanceId: provider.instanceId, model },
              availableModels: provider.models.map((candidate) => candidate.slug),
            })
          },
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
                candidate.source === source && candidate.providerInstanceId === providerInstanceId,
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
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            )
          },
        }
      }),
  })

  const discoveryDeps = ImportDiscovery.ImportDiscoveryDeps.of({
    findImportedThread: (lookup) =>
      readImportedThreadIndex.pipe(Effect.map((index) => index.find(lookup))),
    findProjectByWorkspaceRoot: (normalizedRoot) =>
      projectionSnapshotQuery
        .getActiveProjectByWorkspaceRoot(normalizedRoot)
        .pipe(Effect.map(Option.match({ onNone: () => null, onSome: (project) => project.id }))),
    normalizeWorkspaceRoot: (workspaceRoot) => workspacePaths.normalizeWorkspaceRoot(workspaceRoot),
    scanAcpSource: (descriptor) =>
      scanAcpImportCatalog(descriptor.connection).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      ),
  })

  return Layer.mergeAll(
    ImportService.layer.pipe(
      Layer.provide(Layer.succeed(ImportService.ImportServiceDeps, importServiceDeps)),
    ),
    ImportDiscovery.layer.pipe(
      Layer.provide(Layer.succeed(ImportDiscovery.ImportDiscoveryDeps, discoveryDeps)),
    ),
  )
})

export const layer = Layer.unwrap(make)
