// apps/mobile/src/state/use-thread-outbox.ts
// manage editing queued message ids atom through a React hook

import { useAtomValue } from '@effect/atom-react'
import type { EnvironmentShellStatus } from '@t3tools/client-runtime/state/shell'
import type { EnvironmentId, MessageId, ThreadId } from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'

import { scopedThreadKey } from '../lib/scopedEntities'
import { appAtomRegistry } from './atom-registry'
import { environmentShell } from './shell'
import { threadOutboxManager } from './thread-outbox'

const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> =>
  {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>()
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom)))
    {
      const environmentId = queue[0]?.environmentId
      if (environmentId !== undefined && !statuses.has(environmentId))
      {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status)
      }
    }
    return statuses
  },
).pipe(Atom.withLabel('mobile:thread-outbox:shell-statuses'))

// queued pending tasks the outbox drain must not deliver right now: the one
// open in the new-task editor, plus any whose latest edits could not be saved
// back yet (delivering those would send stale content). Editing sessions hold
// their message id here and release it once the queued payload is current.
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel('mobile:thread-outbox:editing-message-ids'),
)

export function holdEditingQueuedMessage(messageId: MessageId): void
{
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom)
  if (current[messageId])
  {
    return
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true })
}

export function releaseEditingQueuedMessage(messageId: MessageId): void
{
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom)
  if (!current[messageId])
  {
    return
  }
  const next = { ...current }
  delete next[messageId]
  appAtomRegistry.set(editingQueuedMessageIdsAtom, next)
}

// the failure a thread list row must surface. A queued message for a thread the
// user has not opened has no other place to report that delivery gave up;
// queued creations are excluded because their pending-task row already does.
const threadOutboxFailureReasonByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make((get): string | null =>
  {
    const failed = get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[threadKey]?.find(
      (message) => message.failure !== undefined && message.creation === undefined,
    )
    if (failed === undefined)
    {
      return null
    }
    const reason = failed.failure?.reason.trim() ?? ''
    return reason.length > 0 ? reason : 'The queued message could not be sent.'
  }).pipe(Atom.withLabel(`mobile:thread-outbox:failure-reason:${threadKey}`)),
)

export function useThreadOutboxFailureReason(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string | null
{
  return useAtomValue(
    threadOutboxFailureReasonByThreadKeyAtom(scopedThreadKey(environmentId, threadId)),
  )
}

export function useThreadOutboxMessages()
{
  return useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom)
}

export function useThreadOutboxShellStatuses()
{
  return useAtomValue(threadOutboxShellStatusesAtom)
}
