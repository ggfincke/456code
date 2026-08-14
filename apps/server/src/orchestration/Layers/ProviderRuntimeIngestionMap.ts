// apps/server/src/orchestration/Layers/ProviderRuntimeIngestionMap.ts
// pure runtime-event and snapshot lookup helpers for ingestion

import {
  MessageId,
  ThreadId,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationCheckpointSummary,
  type ProviderRuntimeEvent,
  TurnId,
} from '@t3tools/contracts'

import { proposedPlanIdForTurn } from '../proposedPlanIdentity.ts'
import { toTurnId } from './ProviderRuntimeEventMapping.ts'

export function sameId(left: string | null | undefined, right: string | null | undefined): boolean
{
  if (left === null || left === undefined || right === null || right === undefined)
  {
    return false
  }
  return left === right
}

export function hasAssistantMessageForTurn(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId,
  options?: { readonly streamingOnly?: boolean },
): boolean
{
  for (let index = 0; index < messages.length; index += 1)
  {
    const message = messages[index]
    if (!message)
    {
      continue
    }
    if (message.role !== 'assistant' || message.turnId !== turnId)
    {
      continue
    }
    if (options?.streamingOnly === true && !message.streaming)
    {
      continue
    }
    return true
  }
  return false
}

export function findMessageById(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: MessageId,
): OrchestrationMessage | undefined
{
  for (let index = 0; index < messages.length; index += 1)
  {
    const message = messages[index]
    if (message?.id === messageId)
    {
      return message
    }
  }
  return undefined
}

export function findProposedPlanById(
  proposedPlans: ReadonlyArray<
    Pick<OrchestrationProposedPlan, 'id' | 'createdAt' | 'implementedAt' | 'implementationThreadId'>
  >,
  planId: string,
):
  | Pick<OrchestrationProposedPlan, 'id' | 'createdAt' | 'implementedAt' | 'implementationThreadId'>
  | undefined
  {
  for (let index = 0; index < proposedPlans.length; index += 1)
  {
    const proposedPlan = proposedPlans[index]
    if (proposedPlan?.id === planId)
    {
      return proposedPlan
    }
  }
  return undefined
}

export function hasCheckpointForTurn(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
): boolean
{
  for (let index = 0; index < checkpoints.length; index += 1)
  {
    if (checkpoints[index]?.turnId === turnId)
    {
      return true
    }
  }
  return false
}

export function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): number
{
  let maxTurnCount = 0
  for (let index = 0; index < checkpoints.length; index += 1)
  {
    const checkpoint = checkpoints[index]
    if (checkpoint && checkpoint.checkpointTurnCount > maxTurnCount)
    {
      maxTurnCount = checkpoint.checkpointTurnCount
    }
  }
  return maxTurnCount
}

export function normalizeProposedPlanMarkdown(
  planMarkdown: string | undefined,
): string | undefined
{
  const trimmed = planMarkdown?.trim()
  if (!trimmed)
  {
    return undefined
  }
  return trimmed
}

export function hasRenderableAssistantText(text: string | undefined): boolean
{
  return (text?.trim().length ?? 0) > 0
}

export function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string
{
  const turnId = toTurnId(event.turnId)
  if (turnId)
  {
    return proposedPlanIdForTurn(threadId, turnId)
  }
  if (event.itemId)
  {
    return `plan:${threadId}:item:${event.itemId}`
  }
  return `plan:${threadId}:event:${event.eventId}`
}

export function assistantSegmentBaseKeyFromEvent(event: ProviderRuntimeEvent): string
{
  return String(event.itemId ?? event.turnId ?? event.eventId)
}

export function assistantSegmentMessageId(baseKey: string, segmentIndex: number): MessageId
{
  return MessageId.make(
    segmentIndex === 0 ? `assistant:${baseKey}` : `assistant:${baseKey}:segment:${segmentIndex}`,
  )
}
export function normalizeRuntimeTurnState(
  value: string | undefined,
): 'completed' | 'failed' | 'interrupted' | 'cancelled'
{
  switch (value)
  {
    case 'failed':
    case 'interrupted':
    case 'cancelled':
    case 'completed':
      return value
    default:
      return 'completed'
  }
}

export function orchestrationSessionStatusFromRuntimeState(
  state:
    | 'starting'
    | 'running'
    | 'waiting'
    | 'compacting'
    | 'ready'
    | 'interrupted'
    | 'stopped'
    | 'error',
): 'starting' | 'running' | 'ready' | 'interrupted' | 'stopped' | 'error'
{
  switch (state)
  {
    case 'starting':
      return 'starting'
    case 'running':
    case 'waiting':
    // a compaction is the session still working, not a pause. collapsing it to 'running' keeps
    // the active turn alive so the compaction row is additive instead of tearing the turn down
    case 'compacting':
      return 'running'
    case 'ready':
      return 'ready'
    case 'interrupted':
      return 'interrupted'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'error'
  }
}

export function sessionStatusAllowsActiveTurn(
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean
{
  return status === 'starting' || status === 'running'
}
