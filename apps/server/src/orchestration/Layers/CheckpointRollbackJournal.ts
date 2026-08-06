// apps/server/src/orchestration/Layers/CheckpointRollbackJournal.ts
// encode/decode checkpoint provider rollback journal detail

import { CommandId, type OrchestrationEvent } from '@t3tools/contracts'

import type { CheckpointRevertOperation } from '../../persistence/Services/CheckpointRevertOperations.ts'
import type { ProviderAdapterCapabilities } from '../../provider/Services/ProviderAdapter.ts'

export const REVERT_OPERATION_PREFIX = 'checkpoint-revert:'

export type ProviderRollbackCapability = 'exact' | 'known-unsupported' | 'legacy-unreported'

export interface ProviderRollbackJournalDetail
{
  readonly version: 1
  readonly capability: ProviderRollbackCapability
  readonly state: 'pending' | 'attempt-started' | 'recorded'
  readonly rolledBackTurns: number
  readonly staleRefs: ReadonlyArray<string>
  readonly detail: string | null
}

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: 'thread.message-sent' }>

export function checkpointRevertOperationId(commandId: CommandId): string
{
  return `${REVERT_OPERATION_PREFIX}${commandId}`
}

export function errorDetail(cause: unknown): string
{
  return cause instanceof Error ? cause.message : String(cause)
}

export function rollbackCapabilityFrom(
  capabilities: ProviderAdapterCapabilities,
): ProviderRollbackCapability
{
  const declared = capabilities.conversationRollback
  if (declared === 'unsupported')
  {
    return 'known-unsupported'
  }
  if (declared === 'exact')
  {
    return 'exact'
  }
  // no adapter declares the capability yet, so the revert attempts the
  // rollback and classifies the outcome from what the provider does
  return 'legacy-unreported'
}

export function encodeProviderRollbackJournalDetail(detail: ProviderRollbackJournalDetail): string
{
  return JSON.stringify(detail)
}

export function decodeProviderRollbackJournalDetail(
  operation: CheckpointRevertOperation,
): ProviderRollbackJournalDetail
{
  if (operation.providerOutcomeJson === null)
  {
    throw new Error(
      `Checkpoint revert '${operation.operationId}' is missing provider rollback detail.`,
    )
  }

  const decoded: unknown = JSON.parse(operation.providerOutcomeJson)
  if (typeof decoded !== 'object' || decoded === null)
  {
    throw new Error(
      `Checkpoint revert '${operation.operationId}' has invalid provider rollback detail.`,
    )
  }
  const candidate = decoded as Partial<ProviderRollbackJournalDetail>
  if (
    candidate.version !== 1 ||
    (candidate.capability !== 'exact' &&
      candidate.capability !== 'known-unsupported' &&
      candidate.capability !== 'legacy-unreported') ||
    (candidate.state !== 'pending' &&
      candidate.state !== 'attempt-started' &&
      candidate.state !== 'recorded') ||
    typeof candidate.rolledBackTurns !== 'number' ||
    !Number.isInteger(candidate.rolledBackTurns) ||
    candidate.rolledBackTurns < 0 ||
    !Array.isArray(candidate.staleRefs) ||
    !candidate.staleRefs.every((ref) => typeof ref === 'string') ||
    (candidate.detail !== null && typeof candidate.detail !== 'string')
  )
  {
    throw new Error(
      `Checkpoint revert '${operation.operationId}' has invalid provider rollback detail.`,
    )
  }
  return candidate as ProviderRollbackJournalDetail
}

export function isCheckpointBaselineMessage(event: ThreadMessageSentEvent): boolean
{
  return (
    event.payload.provenance !== 'import' &&
    event.payload.role === 'user' &&
    !event.payload.streaming &&
    event.payload.turnId === null
  )
}
