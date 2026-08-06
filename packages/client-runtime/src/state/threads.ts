// packages/client-runtime/src/state/threads.ts
// synchronizes environment thread state

import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { Atom } from 'effect/unstable/reactivity'

import { EnvironmentRegistry } from '../connection/registry.ts'
import { connectionProjectionPhase } from '../connection/model.ts'
import { EnvironmentSupervisor } from '../connection/supervisor.ts'
import * as ConnectionWakeups from '../connection/wakeups.ts'
import { EnvironmentCacheStore } from '../platform/persistence.ts'
import { subscribeDynamic } from '../rpc/client.ts'
import { ThreadSnapshotLoader } from './threadSnapshotHttp.ts'
import { parseThreadKey, threadKey } from './entities.ts'
import { applyThreadDetailEvent } from './threadReducer.ts'
import { THREAD_STATE_IDLE_TTL_MS } from './threadRetention.ts'
import { followStreamInEnvironment } from './runtime.ts'
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from './threadState.ts'

const THREAD_STREAM_BATCH_SIZE = 128
const THREAD_STREAM_BATCH_WINDOW = '16 millis'

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { readonly type: 'thread.message-sent' }>
type ThreadEventStreamItem = Extract<OrchestrationThreadStreamItem, { readonly kind: 'event' }>

function isStreamingAssistantMessageItem(
  item: OrchestrationThreadStreamItem,
): item is ThreadEventStreamItem & { readonly event: ThreadMessageSentEvent }
{
  return (
    item.kind === 'event' &&
    item.event.type === 'thread.message-sent' &&
    item.event.payload.role === 'assistant' &&
    item.event.payload.streaming
  )
}

function coalesceThreadStreamItems(
  items: Iterable<OrchestrationThreadStreamItem>,
): ReadonlyArray<OrchestrationThreadStreamItem>
{
  const coalesced: OrchestrationThreadStreamItem[] = []
  let streamingRun: Array<ThreadEventStreamItem & { readonly event: ThreadMessageSentEvent }> = []

  const flushStreamingRun = () =>
  {
    const first = streamingRun[0]
    if (first === undefined)
    {
      return
    }
    if (streamingRun.length === 1)
    {
      coalesced.push(first)
      streamingRun = []
      return
    }

    const latest = streamingRun.at(-1)!
    const latestAttachments = streamingRun.findLast(
      (entry) => entry.event.payload.attachments !== undefined,
    )?.event.payload.attachments
    coalesced.push({
      kind: 'event',
      event: {
        ...latest.event,
        payload: {
          ...latest.event.payload,
          text: streamingRun.map((entry) => entry.event.payload.text).join(''),
          createdAt: first.event.payload.createdAt,
          ...(latestAttachments === undefined ? {} : { attachments: latestAttachments }),
        },
      },
    })
    streamingRun = []
  }

  for (const item of items)
  {
    if (isStreamingAssistantMessageItem(item))
    {
      const previous = streamingRun.at(-1)
      if (
        previous === undefined ||
        (previous.event.payload.messageId === item.event.payload.messageId &&
          previous.event.payload.turnId === item.event.payload.turnId)
      )
      {
        streamingRun.push(item)
        continue
      }
    }
    flushStreamingRun()

    if (isStreamingAssistantMessageItem(item))
    {
      streamingRun.push(item)
      continue
    }
    coalesced.push(item)
  }
  flushStreamingRun()
  return coalesced
}

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus
{
  return Option.isSome(data) ? 'cached' : 'empty'
}

function formatThreadError(cause: Cause.Cause<unknown>): string
{
  const error = Cause.squash(cause)
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Could not synchronize the thread.'
}

function shouldPersistThread(thread: OrchestrationThread): boolean
{
  const status = thread.session?.status
  return status !== 'starting' && status !== 'running'
}

export const makeEnvironmentThreadState = Effect.fn('EnvironmentThreadState.make')(function* (
  threadId: ThreadIdType,
)
{
  const supervisor = yield* EnvironmentSupervisor
  const cache = yield* EnvironmentCacheStore
  const snapshotLoader = yield* ThreadSnapshotLoader
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups)
  const environmentId = supervisor.target.environmentId
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning('Could not load cached thread.').pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  )
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread)
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  })
  // seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  )
  const awaitingCompletion = yield* Ref.make(false)
  // a server without the completion marker delivers catch-up events with no
  // boundary the client can recognize, so a resumed subscription cannot tell
  // replayed history from live activity. Such a session asks for a full
  // snapshot instead and stays out of `live` until that snapshot lands.
  const awaitingFreshSnapshot = yield* Ref.make(false)
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1)

  const persist = Effect.fn('EnvironmentThreadState.persist')(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  )
  {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Could not persist the thread cache.').pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    )
  })

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce('500 millis'),
    Stream.runForEach(persist),
    Effect.forkScoped,
  )

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === 'deleted'
      ? current
      : {
          ...current,
          status: 'synchronizing' as const,
          error: Option.none(),
        },
  )
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === 'live' || current.status === 'deleted'
      ? current
      : {
          ...current,
          status: 'synchronizing' as const,
          error: Option.none(),
        },
  )
  const setDisconnected = Effect.gen(function* ()
  {
    yield* Ref.set(awaitingCompletion, false)
    yield* Ref.set(awaitingFreshSnapshot, false)
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === 'deleted' ? current.status : statusWithoutLiveData(current.data),
    }))
  })
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(Ref.set(awaitingFreshSnapshot, false)),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === 'deleted' ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    )

  const setThread = Effect.fn('EnvironmentThreadState.setThread')(function* (
    thread: OrchestrationThread,
  )
  {
    const waiting = (yield* Ref.get(awaitingCompletion)) || (yield* Ref.get(awaitingFreshSnapshot))
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: waiting ? 'synchronizing' : 'live',
      error: Option.none(),
    })
    // active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(thread))
    {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence)
      yield* Queue.offer(persistence, { snapshotSequence, thread })
    }
  })

  const setDeleted = Effect.fn('EnvironmentThreadState.setDeleted')(function* ()
  {
    yield* Ref.set(awaitingCompletion, false)
    yield* Ref.set(awaitingFreshSnapshot, false)
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: 'deleted',
      error: Option.none(),
    })
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning('Could not remove the cached thread.').pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    )
  })

  const applyItem = Effect.fn('EnvironmentThreadState.applyItem')(function* (
    item: OrchestrationThreadStreamItem,
  )
  {
    if (item.kind === 'synchronized')
    {
      yield* Ref.set(awaitingCompletion, false)
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== 'deleted'
          ? { ...current, status: 'live' as const, error: Option.none() }
          : current,
      )
      return
    }

    if (item.kind === 'snapshot')
    {
      // a full snapshot is complete by construction, so it is the boundary a
      // marker-less session was waiting for
      yield* Ref.set(awaitingFreshSnapshot, false)
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence)
      yield* setThread(item.snapshot.thread)
      return
    }

    const sequence = yield* SubscriptionRef.get(lastSequence)
    if (item.event.sequence <= sequence)
    {
      return
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence)

    const current = yield* SubscriptionRef.get(state)
    if (Option.isNone(current.data))
    {
      if (item.event.type === 'thread.deleted')
      {
        yield* setDeleted()
      }
      return
    }
    const result = applyThreadDetailEvent(current.data.value, item.event)
    if (result.kind === 'updated')
    {
      yield* setThread(result.thread)
    }
    else if (result.kind === 'deleted')
    {
      yield* setDeleted()
    }
  })

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) =>
    {
      switch (connectionProjectionPhase(connectionState))
      {
        case 'synchronizing':
          return setSynchronizing
        case 'disconnected':
          return setDisconnected
        case 'ready':
          return setReady
      }
    }),
    Effect.forkScoped,
  )

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  })

  yield* setSynchronizing
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn('EnvironmentThreadState.makeSubscribeInput')(function* (session)
      {
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        )
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker)
        yield* setSynchronizing

        let current = yield* SubscriptionRef.get(state)
        // a snapshot fetched inside this attempt is as trustworthy a boundary
        // as the completion marker, so it keeps the resume cursor usable
        let seededFromFreshSnapshot = false
        if (Option.isNone(current.data) && current.status !== 'deleted')
        {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          )
          const httpSnapshot = yield* snapshotLoader.load(prepared, threadId)
          if (Option.isSome(httpSnapshot))
          {
            yield* applyItem({ kind: 'snapshot', snapshot: httpSnapshot.value })
            current = yield* SubscriptionRef.get(state)
            seededFromFreshSnapshot = true
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence)
        // resuming a marker-less session from a cached cursor would replay
        // history the client cannot separate from live activity — outcomes that
        // already happened would surface as if they had just landed. Ask for the
        // full snapshot instead and stay `synchronizing` until it arrives.
        const canResume =
          Option.isSome(current.data) && (supportsCompletionMarker || seededFromFreshSnapshot)
        yield* Ref.set(awaitingFreshSnapshot, !supportsCompletionMarker && !canResume)

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        }
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: '250 millis',
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(
      Stream.groupedWithin(THREAD_STREAM_BATCH_SIZE, THREAD_STREAM_BATCH_WINDOW),
      Stream.flatMap((items) => Stream.fromIterable(coalesceThreadStreamItems(items))),
      Stream.runForEach(applyItem),
    ),
  )

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread) ? persist({ snapshotSequence, thread }) : Effect.void,
        }),
      ),
    ),
  )

  return state
})

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType)
{
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  )
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
)
{
  const family = Atom.family((key: string) =>
  {
    const { environmentId, threadId } = parseThreadKey(key)
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      )
  })

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  }
}

export * from './archivedThreads.ts'
export * from './checkpointDiff.ts'
export * from './threadSnapshotHttp.ts'
export * from './composerPathSearch.ts'
export * from './threadCommands.ts'
export * from './threadDetail.ts'
export * from './threadReducer.ts'
export * from './threadShell.ts'
export * from './threadState.ts'
