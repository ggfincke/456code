// apps/server/src/ws/handlers/orchestrationHandlers.ts
// builds orchestration websocket rpc handlers from narrow concrete dependencies

import {
  CommandId,
  type ClientOrchestrationCommand,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  ORCHESTRATION_WS_METHODS,
  type ProjectId,
  ThreadId,
  type WsRpcGroup,
} from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Path from 'effect/Path'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import * as CheckpointDiffQuery from '../../checkpointing/CheckpointDiffQuery.ts'
import * as ServerConfig from '../../config.ts'
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from '../../orchestration/ActivityPayloadProjection.ts'
import { normalizeDispatchCommand } from '../../orchestration/Normalizer.ts'
import type * as OrchestrationEngine from '../../orchestration/Services/OrchestrationEngine.ts'
import type { OrchestrationProjectionPipeline } from '../../orchestration/Services/ProjectionPipeline.ts'
import type * as ProjectionSnapshotQuery from '../../orchestration/Services/ProjectionSnapshotQuery.ts'
import type { ImportReplacementIntentRepository } from '../../persistence/Services/ImportReplacementIntents.ts'
import * as ImportContinuation from '../../import/continuationContract.ts'
import * as ImportDiscovery from '../../import/discovery.ts'
import * as ImportSessions from '../../import/importService.ts'
import {
  AcpImportError,
  loadAcpImportSessionsBatch,
  scanAcpImportCatalog,
} from '../../import/acpImport.ts'
import { partitionAcpImportBytePolicy } from '../../import/resourceLimits.ts'
import { resolveAcpImportSourceCatalog, resolveSourceCatalog } from '../../import/sourceCatalog.ts'
import type * as ProviderRegistry from '../../provider/Services/ProviderRegistry.ts'
import * as ServerRuntimeStartup from '../../serverRuntimeStartup.ts'
import type * as ServerSettings from '../../serverSettings.ts'
import type * as TerminalManager from '../../terminal/Manager.ts'
import type * as WorkspacePaths from '../../workspace/WorkspacePaths.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'

type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>
type OrchestrationRpcMethod =
  | typeof ORCHESTRATION_WS_METHODS.dispatchCommand
  | typeof ORCHESTRATION_WS_METHODS.getTurnDiff
  | typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.importScan
  | typeof ORCHESTRATION_WS_METHODS.importSessions
  | typeof ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
type OrchestrationRpcHandlers = Pick<WsRpcHandlers, OrchestrationRpcMethod>

interface OrchestrationRpcHandlerDependencies
{
  readonly checkpointDiffQuery: CheckpointDiffQuery.CheckpointDiffQuery['Service']
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner['Service']
  readonly config: ServerConfig.ServerConfig['Service']
  readonly importContinuationFromContext: Layer.Layer<
    ImportContinuation.ImportContinuationDeps,
    never,
    ImportContinuation.ImportContinuationDeps
  >
  readonly importReplacementIntents: ImportReplacementIntentRepository['Service']
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService['Service']
  readonly path: Path.Path
  readonly projectionPipeline: OrchestrationProjectionPipeline['Service']
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  readonly providerRegistry: ProviderRegistry.ProviderRegistry['Service']
  readonly serverSettings: ServerSettings.ServerSettingsService['Service']
  readonly terminalManager: TerminalManager.TerminalManager['Service']
  readonly workspacePaths: WorkspacePaths.WorkspacePaths['Service']
  readonly dispatchNormalizedCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>
  readonly nowIso: Effect.Effect<string>
  readonly prevalidateImportContinuationProvider: (
    command: ClientOrchestrationCommand,
  ) => Effect.Effect<void, OrchestrationDispatchCommandError>
  readonly toDispatchCommandError: (
    cause: unknown,
    fallbackMessage: string,
  ) => OrchestrationDispatchCommandError
  readonly observeRpcEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcEffect']
  readonly observeRpcStreamEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcStreamEffect']
}

const IMPORT_RPC_ENVELOPE_DEADLINE_MS = ImportSessions.IMPORT_REQUEST_DEADLINE_MS + 30_000

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

function makeImportedThreadShellIndex(
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

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | 'thread.message-sent'
      | 'thread.proposed-plan-upserted'
      | 'thread.activity-appended'
      | 'thread.turn-diff-completed'
      | 'thread.reverted'
      | 'thread.session-set'
      | 'thread.provider-switch-requested'
      | 'thread.provider-switch-progressed'
      | 'thread.provider-switch-failed'
      | 'thread.provider-switched'
      | 'thread.handoff-cleared'
  }
>
{
  return (
    event.type === 'thread.message-sent' ||
    event.type === 'thread.proposed-plan-upserted' ||
    event.type === 'thread.activity-appended' ||
    event.type === 'thread.turn-diff-completed' ||
    event.type === 'thread.reverted' ||
    event.type === 'thread.session-set' ||
    event.type === 'thread.provider-switch-requested' ||
    event.type === 'thread.provider-switch-progressed' ||
    event.type === 'thread.provider-switch-failed' ||
    event.type === 'thread.provider-switched' ||
    event.type === 'thread.handoff-cleared'
  )
}

const RESUME_MAX_EVENT_GAP = 1_000

export function makeOrchestrationRpcHandlers({
  checkpointDiffQuery,
  childProcessSpawner,
  config,
  importContinuationFromContext,
  importReplacementIntents,
  orchestrationEngine,
  path,
  projectionPipeline,
  projectionSnapshotQuery,
  providerRegistry,
  serverSettings,
  terminalManager,
  workspacePaths,
  dispatchNormalizedCommand,
  nowIso,
  prevalidateImportContinuationProvider,
  toDispatchCommandError,
  observeRpcEffect,
  observeRpcStreamEffect,
}: OrchestrationRpcHandlerDependencies)
{
  const toShellStreamEvent = (
    event: OrchestrationEvent,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
  {
    switch (event.type)
    {
      case 'project.created':
      case 'project.meta-updated':
        return projectUpsertOrRemove(event.payload.projectId, event.sequence)
      case 'project.deleted':
        return Effect.succeed(
          Option.some({
            kind: 'project-removed' as const,
            sequence: event.sequence,
            projectId: event.payload.projectId,
          }),
        )
      case 'thread.deleted':
      case 'thread.archived':
        return Effect.succeed(
          Option.some({
            kind: 'thread-removed' as const,
            sequence: event.sequence,
            threadId: event.payload.threadId,
          }),
        )
      case 'thread.unarchived':
        return threadUpsertOrRemove(event.payload.threadId, event.sequence)
      default:
        if (event.aggregateKind !== 'thread')
        {
          return Effect.succeed(Option.none())
        }
        return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence)
    }
  }

  // coalescing makes each projection read represent every event for that
  // aggregate in the current window. Retry a typed persistence failure once
  // so a brief read failure cannot strand the shell at its previous state.
  // if both attempts fail, log and drop the stream item; treating an error as
  // a missing row would incorrectly remove a still-active aggregate.
  const retryShellProjectionRead = <A, E>(
    aggregateKind: 'project' | 'thread',
    aggregateId: string,
    read: Effect.Effect<A, E>,
  ): Effect.Effect<Option.Option<A>, never, never> =>
    read.pipe(
      Effect.retry({ times: 1 }),
      Effect.map(Option.some),
      Effect.tapError((error) =>
        Effect.logWarning('orchestration shell projection refetch failed', {
          aggregateKind,
          aggregateId,
          error,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    )

  const projectUpsertOrRemove = (
    projectId: ProjectId,
    sequence: number,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
    retryShellProjectionRead(
      'project',
      projectId,
      projectionSnapshotQuery.getProjectShellById(projectId),
    ).pipe(
      Effect.map(
        Option.flatMap((project) =>
          Option.match(project, {
            onNone: () =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: 'project-removed' as const,
                sequence,
                projectId,
              }),
            onSome: (nextProject) =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: 'project-upserted' as const,
                sequence,
                project: nextProject,
              }),
          }),
        ),
      ),
    )

  // refetch a thread's shell and emit an upsert if it is still active, or a
  // `thread-removed` if the projection has no active row for it. Emitting a
  // removal on a `none` (rather than dropping the event) is what keeps
  // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
  // into a later refetchable event for the same thread, the refetch returns
  // `none` for the now-inactive row and this still tells the sidebar to drop
  // it. A `thread-removed` the client does not have is a harmless no-op. The
  // projection commits in the same transaction before the event publishes,
  // so a `none` reliably means the thread is deleted or archived, not
  // not-yet-persisted.
  const threadUpsertOrRemove = (
    threadId: ThreadId,
    sequence: number,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
    retryShellProjectionRead(
      'thread',
      threadId,
      projectionSnapshotQuery.getThreadShellById(threadId),
    ).pipe(
      Effect.map(
        Option.flatMap((thread) =>
          Option.match(thread, {
            onNone: () =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: 'thread-removed' as const,
                sequence,
                threadId,
              }),
            onSome: (nextThread) =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: 'thread-upserted' as const,
                sequence,
                thread: nextThread,
              }),
          }),
        ),
      ),
    )

  // turn a batch of domain events into shell stream items, coalescing by
  // aggregate first. `toShellStreamEvent` re-reads the *current* projected
  // shell for an aggregate, so within a batch only the latest event per
  // aggregate matters: a burst of streaming `thread.message-sent` deltas for
  // one thread collapses into a single shell refetch, and an unrelated
  // `thread.created` in the same batch is never stuck behind those DB reads.
  //
  // input events arrive in ascending sequence; we keep the last (highest
  // sequence) event per aggregate, then re-sort ascending before emitting so
  // the client — which applies shell items strictly by increasing sequence
  // and drops any `sequence <= snapshotSequence` — never skips a coalesced
  // item. The refetch runs with bounded concurrency (order-preserving).
  const SHELL_REFETCH_CONCURRENCY = 8
  const coalesceShellEvents = (
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
    Effect.gen(function* ()
    {
      if (events.length === 0)
      {
        return []
      }
      const latestByAggregate = new Map<string, OrchestrationEvent>()
      for (const event of events)
      {
        latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event)
      }
      const survivors = Array.from(latestByAggregate.values()).sort(
        (left, right) => left.sequence - right.sequence,
      )
      const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
        concurrency: SHELL_REFETCH_CONCURRENCY,
      })
      return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []))
    })

  // small time/size window over which to coalesce shell events. The window
  // bounds the worst-case added latency for a brand-new thread to appear in
  // the sidebar (imperceptible), while collapsing high-frequency streaming
  // traffic so it can't serialize the shell stream behind per-event DB reads.
  const SHELL_COALESCE_WINDOW = Duration.millis(50)
  const SHELL_COALESCE_MAX_CHUNK = 512
  const coalesceShellStream = <E, R>(
    stream: Stream.Stream<OrchestrationEvent, E, R>,
  ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
    stream.pipe(
      Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
      Stream.mapEffect(coalesceShellEvents),
      Stream.flatMap((items) => Stream.fromIterable(items)),
    )

  type ShellLiveInput =
    | { readonly kind: 'event'; readonly event: OrchestrationEvent }
    | { readonly kind: 'synchronized' }

  // a completion marker is queued alongside raw live events so it cannot
  // overtake an event still waiting in the coalescing window. Split each
  // batch at markers and coalesce only the event segments on either side.
  const coalesceShellLiveInputs = (
    inputs: ReadonlyArray<ShellLiveInput>,
  ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
    Effect.gen(function* ()
    {
      const output: Array<OrchestrationShellStreamItem> = []
      let pendingEvents: Array<OrchestrationEvent> = []

      for (const input of inputs)
      {
        if (input.kind === 'event')
        {
          pendingEvents.push(input.event)
          continue
        }

        output.push(...(yield* coalesceShellEvents(pendingEvents)))
        pendingEvents = []
        output.push({ kind: 'synchronized' })
      }

      output.push(...(yield* coalesceShellEvents(pendingEvents)))
      return output
    })

  const coalesceShellLiveStream = <E, R>(
    stream: Stream.Stream<ShellLiveInput, E, R>,
  ): Stream.Stream<OrchestrationShellStreamItem, E, R> =>
    stream.pipe(
      Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
      Stream.mapEffect(coalesceShellLiveInputs),
      Stream.flatMap((items) => Stream.fromIterable(items)),
    )

  return {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        Effect.gen(function* ()
        {
          yield* prevalidateImportContinuationProvider(command)
          const normalizedCommand = yield* normalizeDispatchCommand(command)
          const shouldStopSessionAfterArchive =
            normalizedCommand.type === 'thread.archive'
              ? yield* projectionSnapshotQuery.getThreadShellById(normalizedCommand.threadId).pipe(
                  Effect.map(
                    Option.match({
                      onNone: () => false,
                      onSome: (thread) =>
                        thread.session !== null && thread.session.status !== 'stopped',
                    }),
                  ),
                  Effect.orElseSucceed(() => false),
                )
              : false
          const result = yield* dispatchNormalizedCommand(normalizedCommand)
          if (normalizedCommand.type === 'thread.archive')
          {
            if (shouldStopSessionAfterArchive)
            {
              yield* Effect.gen(function* ()
              {
                const stopCommand = yield* normalizeDispatchCommand({
                  type: 'thread.session.stop',
                  commandId: CommandId.make(
                    `session-stop-for-archive:${normalizedCommand.commandId}`,
                  ),
                  threadId: normalizedCommand.threadId,
                  createdAt: yield* nowIso,
                })

                yield* dispatchNormalizedCommand(stopCommand)
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning('failed to stop provider session during archive', {
                    threadId: normalizedCommand.threadId,
                    cause,
                  }),
                ),
              )
            }

            yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
              Effect.catch((error) =>
                Effect.logWarning('failed to close thread terminals after archive', {
                  threadId: normalizedCommand.threadId,
                  error: error.message,
                }),
              ),
            )
          }
          return result
        }).pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, 'Failed to dispatch orchestration command'),
          ),
        ),
        { 'rpc.aggregate': 'orchestration' },
      ),
    [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getTurnDiff,
        checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: 'Failed to load turn diff',
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'orchestration' },
      ),
    [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getFullThreadDiff,
        checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: 'Failed to load full thread diff',
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'orchestration' },
      ),
    [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
      observeRpcStreamEffect(
        ORCHESTRATION_WS_METHODS.subscribeShell,
        Effect.gen(function* ()
        {
          // coalesce the live shell stream per aggregate over a small window
          // so bursts of high-frequency events (streaming message deltas,
          // activity appends) collapse into a single shell refetch and never
          // serialize a brand-new thread's `thread.created` behind hundreds
          // of per-event DB reads. See coalesceShellStream.
          // attach live delivery into a scope-bound buffer BEFORE loading any
          // snapshot or draining catch-up, otherwise an event published while
          // the snapshot query is in flight is lost (it is past the snapshot's
          // sequence but the live subscription is not attached yet). Every
          // path below emits from this same buffered live tail. Overlapping
          // events are deduped by sequence on the client.
          const liveBuffer = yield* Queue.unbounded<ShellLiveInput>()
          yield* Effect.forkScoped(
            orchestrationEngine.streamDomainEvents.pipe(
              Stream.runForEach((event) =>
                Queue.offer(liveBuffer, { kind: 'event' as const, event }),
              ),
            ),
            { startImmediately: true },
          )
          const bufferedLiveStream = coalesceShellLiveStream(Stream.fromQueue(liveBuffer))

          const loadSnapshot = projectionSnapshotQuery.getShellSnapshot().pipe(
            Effect.tapError((cause) =>
              Effect.logError('orchestration shell snapshot load failed', { cause }),
            ),
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: 'Failed to load orchestration shell snapshot',
                  cause,
                }),
            ),
          )

          // offer the completion marker into the same queue as live events.
          // anything buffered while snapshot/replay work was in flight is
          // therefore delivered before the client is told it is synchronized.
          const synchronizedThenLive =
            input.requestCompletionMarker === true
              ? Stream.concat(
                  Stream.fromEffect(
                    Queue.offer(liveBuffer, { kind: 'synchronized' as const }).pipe(
                      Effect.andThen(Queue.takeAll(liveBuffer)),
                      Effect.flatMap(coalesceShellLiveInputs),
                    ),
                  ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                  bufferedLiveStream,
                )
              : bufferedLiveStream

          // when the client already holds a shell snapshot (cached, or loaded
          // over HTTP) it passes that snapshot's sequence, and we resume by
          // replaying shell events after it instead of re-sending the whole
          // projects/threads list over the socket. If the client is too far
          // behind, we fall back to a fresh snapshot instead of an unbounded
          // replay (see below).
          if (input.afterSequence !== undefined)
          {
            const afterSequence = input.afterSequence
            const headSequence = yield* orchestrationEngine.latestSequence
            const replayGap = headSequence - afterSequence
            // gap too large: replaying every intervening event (each a shell
            // refetch) is far more expensive than a single O(active-threads)
            // snapshot. A cursor ahead of this engine's authoritative state
            // is also invalid, so reset it with a snapshot. Send the snapshot
            // followed by the buffered live tail, exactly as the
            // no-afterSequence path does.
            if (replayGap < 0 || replayGap > RESUME_MAX_EVENT_GAP)
            {
              const snapshot = yield* loadSnapshot
              return Stream.concat(
                Stream.make({ kind: 'snapshot' as const, snapshot }),
                synchronizedThenLive,
              )
            }
            const catchUpStream = coalesceShellStream(
              // replay only through the head captured above. Newer events
              // are already covered by the live subscription, so this bound
              // cannot chase a moving event-store head or grow the live
              // buffer indefinitely while waiting for an empty page.
              orchestrationEngine.readEvents(afterSequence, replayGap),
            ).pipe(
              Stream.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: 'Failed to replay orchestration shell events',
                    cause,
                  }),
              ),
            )
            return Stream.concat(catchUpStream, synchronizedThenLive)
          }

          const snapshot = yield* loadSnapshot
          return Stream.concat(
            Stream.make({
              kind: 'snapshot' as const,
              snapshot,
            }),
            synchronizedThenLive,
          )
        }),
        { 'rpc.aggregate': 'orchestration' },
      ),
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
    [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
        projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
          Effect.tapError((cause) =>
            Effect.logError('orchestration archived shell snapshot load failed', { cause }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: 'Failed to load archived orchestration shell snapshot',
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'orchestration' },
      ),
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
      observeRpcStreamEffect(
        ORCHESTRATION_WS_METHODS.subscribeThread,
        Effect.gen(function* ()
        {
          const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
            event.aggregateKind === 'thread' &&
            event.aggregateId === input.threadId &&
            isThreadDetailEvent(event)

          const liveStream = orchestrationEngine.streamDomainEvents.pipe(
            Stream.filter(isThisThreadDetailEvent),
            Stream.map((event) => ({
              kind: 'event' as const,
              event: projectActivityEvent(event),
            })),
          )

          // attach live delivery before reading either replay or snapshot state.
          // otherwise an event published while the snapshot is loading is lost.
          const liveBuffer = yield* Queue.unbounded<OrchestrationThreadStreamItem>()
          yield* Effect.forkScoped(
            liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
            { startImmediately: true },
          )
          const bufferedLiveStream = Stream.fromQueue(liveBuffer)
          const loadSnapshot = projectionSnapshotQuery.getThreadDetailSnapshot(input.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: `Failed to load thread ${input.threadId}`,
                  cause,
                }),
            ),
          )
          const afterCatchUp =
            input.requestCompletionMarker === true
              ? Stream.concat(
                  Stream.fromEffect(
                    Queue.offer(liveBuffer, { kind: 'synchronized' as const }),
                  ).pipe(Stream.drain),
                  bufferedLiveStream,
                )
              : bufferedLiveStream
          const snapshotThenLive = (snapshot: OrchestrationThreadDetailSnapshot) =>
            Stream.concat(
              Stream.make({
                kind: 'snapshot' as const,
                snapshot: projectThreadDetailSnapshot(snapshot),
              }),
              afterCatchUp,
            )

          // when the client already loaded the snapshot over HTTP it passes
          // that snapshot's sequence, and we resume the live subscription by
          // replaying persisted events after it instead of re-sending the
          // (potentially multi-KB) snapshot frame over the socket.
          //
          // the live PubSub subscription must be attached *before* draining
          // the catch-up replay, otherwise events published during the replay
          // window are dropped (they are past the persisted tail the replay
          // read, but the live stream is not yet subscribed). So fork the
          // live stream into a buffer bound to this stream's scope, then emit
          // catch-up followed by the buffered/ongoing live events. Overlapping
          // events are deduped by sequence on the client.
          //
          // bound the catch-up at the head captured before reading so it
          // cannot chase a moving store. Stale or invalid cursors get a fresh
          // detail snapshot instead of scanning the full global event history.
          if (input.afterSequence !== undefined)
          {
            const afterSequence = input.afterSequence
            const headSequence = yield* orchestrationEngine.latestSequence
            const replayGap = headSequence - afterSequence
            if (replayGap < 0 || replayGap > RESUME_MAX_EVENT_GAP)
            {
              const snapshot = yield* loadSnapshot
              if (Option.isNone(snapshot))
              {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                })
              }
              return snapshotThenLive(snapshot.value)
            }
            const catchUpStream = orchestrationEngine.readEvents(afterSequence, replayGap).pipe(
              Stream.filter(isThisThreadDetailEvent),
              Stream.map((event) => ({
                kind: 'event' as const,
                event: projectActivityEvent(event),
              })),
              Stream.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: `Failed to replay thread ${input.threadId} events`,
                    cause,
                  }),
              ),
            )
            return Stream.concat(catchUpStream, afterCatchUp)
          }

          const snapshot = yield* loadSnapshot

          if (Option.isNone(snapshot))
          {
            return yield* new OrchestrationGetSnapshotError({
              message: `Thread ${input.threadId} was not found`,
              cause: input.threadId,
            })
          }
          return snapshotThenLive(snapshot.value)
        }),
        { 'rpc.aggregate': 'orchestration' },
      ),
  } satisfies OrchestrationRpcHandlers
}
