// apps/mobile/src/state/thread-outbox.ts
// exposes queued mobile message state

import type { EnvironmentId } from '@t3tools/contracts'

import { appAtomRegistry } from './atom-registry'
import { createThreadOutboxManager } from './thread-outbox-manager'
import type { QueuedThreadMessage } from './thread-outbox-model'
import { expoThreadOutboxStorage } from './thread-outbox-storage'

export * from './thread-outbox-model'

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
})

export function ensureThreadOutboxLoaded(): void
{
  void threadOutboxManager.load()
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void>
{
  return threadOutboxManager.enqueue(message)
}

// report whether a message remains queued after pending writes settle
export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean>
{
  return threadOutboxManager.confirmQueued(message)
}

/** Rewrite a queued message; no-op (false) if it was removed in the meantime. */
export function updateThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean>
{
  return threadOutboxManager.update(message)
}

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void>
{
  return threadOutboxManager.remove(message)
}

export function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void>
{
  return threadOutboxManager.clearEnvironment(environmentId)
}
