// apps/mobile/src/state/threads/thread-shell-fallback.ts
// reconciles mobile thread detail and shell state

import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from '@t3tools/client-runtime/state/models'
import { mergeEnvironmentThread } from '@t3tools/client-runtime/state/threads'
import type { EnvironmentId, OrchestrationThread } from '@t3tools/contracts'

function latestUserMessageAt(thread: OrchestrationThread): OrchestrationThread['updatedAt'] | null
{
  for (let index = thread.messages.length - 1; index >= 0; index -= 1)
  {
    const message = thread.messages[index]
    if (message?.role === 'user')
    {
      return message.createdAt
    }
  }

  return null
}

export function threadDetailToShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThreadShell
{
  return {
    providerSwitch: thread.providerSwitch,
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    orchestrate: thread.orchestrate,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    origin: thread.origin,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    unsettledAt: thread.unsettledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    session: thread.session,
    latestUserMessageAt: latestUserMessageAt(thread),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }
}

export function mergeThreadDetailWithShell(
  environmentId: EnvironmentId,
  detail: OrchestrationThread | null,
  shell: EnvironmentThreadShell | null,
): EnvironmentThread | null
{
  return mergeEnvironmentThread(detail === null ? null : { ...detail, environmentId }, shell)
}
