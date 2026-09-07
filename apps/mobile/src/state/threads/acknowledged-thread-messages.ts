// apps/mobile/src/state/threads/acknowledged-thread-messages.ts
// retains acknowledged outbox messages until the subscribed timeline projects them

import type { MessageId } from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'

import { appAtomRegistry } from '../atom-registry'
import type { QueuedThreadMessage } from './thread-outbox-model'

export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<QueuedThreadMessage>>(
  [],
).pipe(Atom.keepAlive, Atom.withLabel('mobile:thread-outbox:acknowledged-messages'))

export function retainAcknowledgedThreadMessage(message: QueuedThreadMessage): void
{
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom)
  if (current.some((candidate) => candidate.messageId === message.messageId))
  {
    return
  }
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, [...current, message])
}

export function forgetAcknowledgedThreadMessages(messageIds: ReadonlySet<MessageId>): void
{
  if (messageIds.size === 0)
  {
    return
  }
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom)
  const next = current.filter((message) => !messageIds.has(message.messageId))
  if (next.length !== current.length)
  {
    appAtomRegistry.set(acknowledgedThreadMessagesAtom, next)
  }
}
