// apps/mobile/src/state/thread-outbox-manager.ts
// persists and publishes queued mobile messages

import { EnvironmentId, MessageId, ThreadId } from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import { Atom, type AtomRegistry } from 'effect/unstable/reactivity'

import {
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from './thread-outbox-model'
import type { ThreadOutboxStorage } from './thread-outbox-storage'

export class ThreadOutboxManagerError extends Schema.TaggedErrorClass<ThreadOutboxManagerError>()(
  'ThreadOutboxManagerError',
  {
    operation: Schema.Literals([
      'load',
      'enqueue',
      'update',
      'remove',
      'clear-environment-load',
      'clear-environment-remove',
    ]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Thread outbox operation ${this.operation} failed for environment ${this.environmentId ?? 'unknown'}, thread ${this.threadId ?? 'unknown'}, message ${this.messageId ?? 'unknown'}.`
  }
}

export interface ThreadOutboxManagerOptions
{
  readonly registry: AtomRegistry.AtomRegistry
  readonly storage: ThreadOutboxStorage
  readonly warn?: (message: string, error: unknown) => void
}

export type ThreadOutboxEnvironmentCleanupResult =
  | { readonly complete: true; readonly remainingMessageCount: 0 }
  | { readonly complete: false; readonly remainingMessageCount: number }

export function createThreadOutboxManager(options: ThreadOutboxManagerOptions)
{
  const storedMessagesByThreadKeyAtom = Atom.make<
    Record<string, ReadonlyArray<QueuedThreadMessage>>
  >({}).pipe(Atom.keepAlive, Atom.withLabel('mobile:thread-outbox:stored-messages'))
  const dispatchingMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel('mobile:thread-outbox:dispatching-message-id'),
  )
  const queuedMessagesByThreadKeyAtom = Atom.make((get) =>
  {
    const messagesByThreadKey = get(storedMessagesByThreadKeyAtom)
    const dispatchingMessageId = get(dispatchingMessageIdAtom)
    return dispatchingMessageId === null
      ? messagesByThreadKey
      : groupQueuedThreadMessages(
          flattenQueuedThreadMessages(messagesByThreadKey).filter(
            (message) => message.messageId !== dispatchingMessageId,
          ),
        )
  }).pipe(Atom.withLabel('mobile:thread-outbox:queued-messages'))
  const warn =
    options.warn ??
    ((message: string, error: unknown) =>
    {
      console.warn(message, error)
    })
  let loadPromise: Promise<void> | null = null
  let loadAttempt = 0
  let loadRetryTimer: ReturnType<typeof setTimeout> | null = null
  let mutationQueue: Promise<void> = Promise.resolve()

  const serialize = <A>(mutation: () => Promise<A>): Promise<A> =>
  {
    const result = mutationQueue.then(mutation, mutation)
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const currentMessages = (): ReadonlyArray<QueuedThreadMessage> =>
    flattenQueuedThreadMessages(options.registry.get(storedMessagesByThreadKeyAtom))

  const setMessages = (messages: ReadonlyArray<QueuedThreadMessage>): void =>
  {
    options.registry.set(storedMessagesByThreadKeyAtom, groupQueuedThreadMessages(messages))
  }

  const load = (): Promise<void> =>
  {
    if (loadPromise !== null)
    {
      return loadPromise
    }
    loadPromise = serialize(async () =>
    {
      const persistedMessages = await options.storage.load()
      setMessages([...persistedMessages, ...currentMessages()])
    }).then(
      () =>
      {
        loadAttempt = 0
        if (loadRetryTimer !== null)
        {
          clearTimeout(loadRetryTimer)
          loadRetryTimer = null
        }
      },
      (cause) =>
      {
        loadPromise = null
        loadAttempt += 1
        warn(
          '[thread-outbox] failed to load persisted messages',
          new ThreadOutboxManagerError({
            operation: 'load',
            environmentId: null,
            threadId: null,
            messageId: null,
            cause,
          }),
        )
        if (loadRetryTimer === null)
        {
          loadRetryTimer = setTimeout(() =>
          {
            loadRetryTimer = null
            void load()
          }, threadOutboxRetryDelayMs(loadAttempt))
        }
      },
    )
    return loadPromise
  }

  // publish immediately and roll back if durable storage fails
  const enqueue = (message: QueuedThreadMessage): Promise<void> =>
  {
    setMessages([
      ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      message,
    ])
    return serialize(async () =>
    {
      try
      {
        await options.storage.write(message)
      }
      catch (cause)
      {
        // preserve a replacement attempt that reused the message id
        setMessages(currentMessages().filter((candidate) => candidate !== message))
        throw new ThreadOutboxManagerError({
          operation: 'enqueue',
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        })
      }
    })
  }

  // wait for pending writes before confirming delivery eligibility
  const confirmQueued = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => currentMessages().some((candidate) => candidate === message))

  // hide a claimed message from editors before dispatch begins.
  const claimDelivery = (message: QueuedThreadMessage, canClaim: () => boolean): Promise<boolean> =>
    serialize(async () =>
    {
      if (
        options.registry.get(dispatchingMessageIdAtom) !== null ||
        !currentMessages().some((candidate) => candidate === message) ||
        !canClaim()
      )
      {
        return false
      }
      options.registry.set(dispatchingMessageIdAtom, message.messageId)
      return true
    })

  const releaseDelivery = (message: QueuedThreadMessage): void =>
  {
    if (options.registry.get(dispatchingMessageIdAtom) === message.messageId)
    {
      options.registry.set(dispatchingMessageIdAtom, null)
    }
  }

  // rewrites an already-queued message. A no-op when the message has been
  // removed in the meantime (e.g. deleted or delivered), so a trailing editor
  // flush can never resurrect it. Returns whether the message was updated.
  const update = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () =>
    {
      const exists = currentMessages().some(
        (candidate) => candidate.messageId === message.messageId,
      )
      if (!exists)
      {
        return false
      }
      try
      {
        await options.storage.write(message)
      }
      catch (cause)
      {
        throw new ThreadOutboxManagerError({
          operation: 'update',
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        })
      }
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
        message,
      ])
      return true
    })

  const remove = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () =>
    {
      try
      {
        await options.storage.remove(message)
      }
      catch (cause)
      {
        throw new ThreadOutboxManagerError({
          operation: 'remove',
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        })
      }
      setMessages(
        currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      )
    })

  const clearEnvironment = (
    environmentId: EnvironmentId,
  ): Promise<ThreadOutboxEnvironmentCleanupResult> =>
    serialize(async () =>
    {
      let persisted: ReadonlyArray<QueuedThreadMessage>
      try
      {
        persisted = await options.storage.load()
      }
      catch (cause)
      {
        warn(
          '[thread-outbox] failed to load messages while clearing environment',
          new ThreadOutboxManagerError({
            operation: 'clear-environment-load',
            environmentId,
            threadId: null,
            messageId: null,
            cause,
          }),
        )
        return {
          complete: false as const,
          remainingMessageCount: currentMessages().filter(
            (message) => message.environmentId === environmentId,
          ).length,
        }
      }
      const allMessages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...persisted, ...currentMessages()]),
      )
      const removedMessageKeys = new Set<string>()

      const messageKey = (message: QueuedThreadMessage): string =>
        `${message.environmentId}\0${message.messageId}`

      await Promise.all(
        allMessages
          .filter((message) => message.environmentId === environmentId)
          .map(async (message) =>
          {
            try
            {
              await options.storage.remove(message)
              removedMessageKeys.add(messageKey(message))
            }
            catch (cause)
            {
              warn(
                '[thread-outbox] failed to clear persisted message',
                new ThreadOutboxManagerError({
                  operation: 'clear-environment-remove',
                  environmentId: message.environmentId,
                  threadId: message.threadId,
                  messageId: message.messageId,
                  cause,
                }),
              )
            }
          }),
      )

      const remainingMessages = allMessages.filter(
        (message) => !removedMessageKeys.has(messageKey(message)),
      )
      setMessages(remainingMessages)
      const remainingMessageCount = remainingMessages.filter(
        (message) => message.environmentId === environmentId,
      ).length
      return remainingMessageCount === 0
        ? ({ complete: true, remainingMessageCount: 0 } as const)
        : ({ complete: false, remainingMessageCount } as const)
    })

  return {
    queuedMessagesByThreadKeyAtom,
    dispatchingMessageIdAtom,
    serialize,
    load,
    enqueue,
    confirmQueued,
    claimDelivery,
    releaseDelivery,
    update,
    remove,
    clearEnvironment,
  }
}
