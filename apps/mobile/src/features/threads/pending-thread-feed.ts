// apps/mobile/src/features/threads/pending-thread-feed.ts
// appends durable outbox messages to the projected mobile thread timeline

import type { ThreadFeedEntry } from '../../lib/threadActivity'
import type { QueuedThreadMessage } from '../../state/thread-outbox-model'

export type PendingThreadFeedEntry = ThreadFeedEntry & {
  readonly pendingMessage?: QueuedThreadMessage
  readonly acknowledged?: boolean
}

export function appendPendingThreadMessages(
  presentedFeed: ReadonlyArray<ThreadFeedEntry>,
  sourceFeed: ReadonlyArray<ThreadFeedEntry>,
  pendingMessages: ReadonlyArray<{
    readonly message: QueuedThreadMessage
    readonly acknowledged: boolean
  }>,
): ReadonlyArray<PendingThreadFeedEntry>
{
  if (pendingMessages.length === 0)
  {
    return presentedFeed
  }
  const deliveredIds = new Set(
    sourceFeed.flatMap((entry) => (entry.type === 'message' ? [entry.message.id] : [])),
  )
  return [
    ...presentedFeed,
    ...pendingMessages
      .filter(({ message }) => !deliveredIds.has(message.messageId))
      .map(({ message: pendingMessage, acknowledged }): PendingThreadFeedEntry => ({
        type: 'message',
        id: pendingMessage.messageId,
        createdAt: pendingMessage.createdAt,
        pendingMessage,
        acknowledged,
        message: {
          id: pendingMessage.messageId,
          role: 'user',
          text: pendingMessage.text,
          createdAt: pendingMessage.createdAt,
          updatedAt: pendingMessage.createdAt,
          turnId: null,
          streaming: false,
        },
      })),
  ]
}
