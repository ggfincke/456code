// packages/shared/src/agentAwareness.ts
// projects thread state into concise agent activity

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from '@t3tools/contracts'

export type AgentAwarenessPhase =
  | 'starting'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'stale'

export interface AgentAwarenessState
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly projectTitle: string
  readonly threadTitle: string
  readonly phase: AgentAwarenessPhase
  readonly headline: string
  readonly detail?: string
  readonly modelTitle: string
  readonly updatedAt: string
  readonly deepLink: string
}

export interface ProjectThreadAwarenessInput
{
  readonly environmentId: EnvironmentId
  readonly project: Pick<OrchestrationProjectShell, 'title'>
  readonly thread: Pick<
    OrchestrationThreadShell,
    | 'id'
    | 'title'
    | 'modelSelection'
    | 'session'
    | 'latestTurn'
    | 'updatedAt'
    | 'approvalOutcomes'
    | 'hasPendingApprovals'
    | 'hasPendingUserInput'
  >
}

export function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
}): string
{
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`
}

export function projectThreadAwareness(
  input: ProjectThreadAwarenessInput,
): AgentAwarenessState | null
{
  const { environmentId, project, thread } = input
  const approvalState = resolveApprovalAwarenessState(thread)
  const phase = resolveThreadAwarenessPhase(thread, approvalState)
  if (!phase)
  {
    return null
  }

  const detail = detailForPhase(phase, thread, approvalState)
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase, approvalState),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: thread.updatedAt,
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  }
}

type ApprovalAwarenessState =
  | { readonly status: 'pending' }
  | { readonly status: 'responding' }
  | { readonly status: 'unknown'; readonly detail?: string }

function resolveApprovalAwarenessState(
  thread: ProjectThreadAwarenessInput['thread'],
): ApprovalAwarenessState | null
{
  const unknown = thread.approvalOutcomes?.find((outcome) => outcome.status === 'unknown')
  if (unknown)
  {
    return {
      status: 'unknown',
      ...(unknown.detail === undefined ? {} : { detail: unknown.detail }),
    }
  }
  if (thread.approvalOutcomes?.some((outcome) => outcome.status === 'responding'))
  {
    return { status: 'responding' }
  }
  if (
    thread.hasPendingApprovals ||
    thread.approvalOutcomes?.some((outcome) => outcome.status === 'pending')
  )
  {
    return { status: 'pending' }
  }
  return null
}

function resolveThreadAwarenessPhase(
  thread: ProjectThreadAwarenessInput['thread'],
  approvalState: ApprovalAwarenessState | null,
): AgentAwarenessPhase | null
{
  if (approvalState !== null)
  {
    return 'waiting_for_approval'
  }
  if (thread.hasPendingUserInput)
  {
    return 'waiting_for_input'
  }
  if (thread.session?.status === 'error' || thread.latestTurn?.state === 'error')
  {
    return 'failed'
  }
  if (thread.session?.status === 'starting')
  {
    return 'starting'
  }
  if (thread.session?.status === 'running' || thread.latestTurn?.state === 'running')
  {
    return 'running'
  }
  if (thread.latestTurn?.state === 'completed')
  {
    return 'completed'
  }
  // a turn that finished can still read as "interrupted" here: session
  // teardown settles still-running turns by session status, and that write
  // can race the turn.completed one. completedAt survives the race — a turn
  // that has a completion timestamp finished, whatever the state column says.
  // without this, quick finish-then-teardown threads resolve to null
  // persistently and get tombstoned instead of published as completed.
  if (thread.latestTurn?.state === 'interrupted' && thread.latestTurn.completedAt !== null)
  {
    return 'completed'
  }
  // legacy or partially materialized shells can lack a latest turn entirely
  // a live ready/idle session with nothing pending or running is still done
  if (thread.session?.status === 'ready' || thread.session?.status === 'idle')
  {
    return 'completed'
  }
  return null
}

function headlineForPhase(
  phase: AgentAwarenessPhase,
  approvalState: ApprovalAwarenessState | null,
): string
{
  switch (phase)
  {
    case 'starting':
      return 'Starting agent'
    case 'running':
      return 'Agent is working'
    case 'waiting_for_approval':
      return approvalState?.status === 'unknown'
        ? 'Approval status unknown'
        : approvalState?.status === 'responding'
          ? 'Approval response pending'
          : 'Approval needed'
    case 'waiting_for_input':
      return 'Waiting for input'
    case 'completed':
      return 'Agent finished'
    case 'failed':
      return 'Agent failed'
    case 'stale':
      return 'Update delayed'
  }
}

function detailForPhase(
  phase: AgentAwarenessPhase,
  thread: ProjectThreadAwarenessInput['thread'],
  approvalState: ApprovalAwarenessState | null,
): string | undefined
{
  if (phase === 'waiting_for_approval' && approvalState?.status === 'unknown')
  {
    const guidance = 'Refresh status or restart the turn to continue safely.'
    return approvalState.detail ? `${approvalState.detail} ${guidance}` : guidance
  }
  if (phase === 'waiting_for_approval' && approvalState?.status === 'responding')
  {
    return 'Waiting for the provider to confirm the approval response.'
  }
  if (phase === 'failed')
  {
    return thread.session?.lastError ?? undefined
  }
  if (phase === 'completed')
  {
    return 'Review the completed task.'
  }
  if (phase === 'running' && thread.session?.providerName)
  {
    return `${thread.session.providerName} is active.`
  }
  return undefined
}
