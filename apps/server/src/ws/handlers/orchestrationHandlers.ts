// apps/server/src/ws/handlers/orchestrationHandlers.ts
// builds orchestration websocket rpc handlers from narrow concrete dependencies

import {
  CommandId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  ORCHESTRATION_WS_METHODS,
  type ProjectId,
  ThreadId,
  type WsRpcGroup,
} from '@t3tools/contracts'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Path from 'effect/Path'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import * as CheckpointDiffQuery from '../../orchestration/Services/CheckpointDiffQuery.ts'
import * as ServerConfig from '../../config.ts'
import { normalizeDispatchCommand } from '../../orchestration/Normalizer.ts'
import type * as OrchestrationEngine from '../../orchestration/Services/OrchestrationEngine.ts'
import type { OrchestrationProjectionPipeline } from '../../orchestration/Services/ProjectionPipeline.ts'
import type * as ProjectionSnapshotQuery from '../../orchestration/Services/ProjectionSnapshotQuery.ts'
import type { ImportReplacementIntentRepository } from '../../persistence/Services/ImportReplacementIntents.ts'
import * as ImportContinuation from '../../import/continuation/continuationContract.ts'
import type * as ProviderRegistry from '../../provider/Services/ProviderRegistry.ts'
import type * as ServerSettings from '../../serverSettings.ts'
import type * as TerminalManager from '../../terminal/Manager.ts'
import type * as WorkspacePaths from '../../workspace/WorkspacePaths.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'
import { makeOrchestrationImportHandlers } from './orchestrationImportHandlers.ts'
import {
  makeOrchestrationThreadStreamHandlers,
  RESUME_MAX_EVENT_GAP,
} from './orchestrationThreadStreamHandlers.ts'

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
    ...makeOrchestrationImportHandlers({
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
    }),
    ...makeOrchestrationThreadStreamHandlers({
      orchestrationEngine,
      projectionSnapshotQuery,
      observeRpcStreamEffect,
    }),
  } satisfies OrchestrationRpcHandlers
}
