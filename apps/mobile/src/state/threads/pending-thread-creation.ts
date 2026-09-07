// apps/mobile/src/state/threads/pending-thread-creation.ts
// projects queued thread creation into a temporary mobile thread shell

import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from '@t3tools/contracts'

import { deriveThreadTitleFromPrompt } from '../../lib/projectThreadStartTurn'
import type { QueuedThreadMessage } from './thread-outbox-model'

export function pendingThreadCreationShell(
  message: QueuedThreadMessage,
): EnvironmentThreadShell | null
{
  const creation = message.creation
  if (!creation || !message.modelSelection)
  {
    return null
  }

  return {
    providerSwitch: null,
    environmentId: message.environmentId,
    id: message.threadId,
    projectId: creation.projectId,
    title: deriveThreadTitleFromPrompt(message.text),
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: message.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    orchestrate: message.orchestrate ?? false,
    branch: creation.branch,
    worktreePath: creation.workspaceMode === 'worktree' ? null : creation.worktreePath,
    latestTurn: null,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: message.createdAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }
}
