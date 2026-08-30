// apps/mobile/src/features/threads/thread-list-pinning.ts
// gates thread pinning across mobile list surfaces and actions

import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'

type ThreadPinningCandidate = Pick<EnvironmentThreadShell, 'latestTurn' | 'origin'>

export function isImportedHistoryOnlyThread(thread: ThreadPinningCandidate): boolean
{
  return thread.origin !== null && thread.latestTurn === null
}

export function canPinThread(
  thread: ThreadPinningCandidate,
  environmentSupportsPinning: boolean,
): boolean
{
  return environmentSupportsPinning && !isImportedHistoryOnlyThread(thread)
}
