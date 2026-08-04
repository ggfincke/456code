import { expect, it } from '@effect/vitest'
import { ThreadId } from '@t3tools/contracts'

import {
  CheckpointRefUnavailableError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
} from '../../../../apps/server/src/checkpointing/Errors.ts'

const threadId = ThreadId.make('thread-1')

it('derives checkpoint messages from structured context', () =>
{
  const range = new CheckpointTurnRangeUnavailableError({
    operation: 'CheckpointDiffQuery.getTurnDiff',
    threadId,
    requestedTurnCount: 4,
    availableTurnCount: 2,
  })
  const checkpoint = new CheckpointRefUnavailableError({
    operation: 'CheckpointDiffQuery.getTurnDiff',
    threadId,
    turnCount: 2,
    checkpoint: 'to',
  })
  const workspace = new CheckpointWorkspacePathMissingError({
    operation: 'CheckpointDiffQuery.getFullThreadDiff',
    threadId,
  })

  expect(range.operation).toBe('CheckpointDiffQuery.getTurnDiff')
  expect(range.threadId).toBe(threadId)
  expect(range.requestedTurnCount).toBe(4)
  expect(range.availableTurnCount).toBe(2)
  expect(range.message).toContain('thread-1')
  expect(range.message).toContain('4')
  expect(range.message).toContain('2')

  expect(checkpoint.operation).toBe('CheckpointDiffQuery.getTurnDiff')
  expect(checkpoint.threadId).toBe(threadId)
  expect(checkpoint.turnCount).toBe(2)
  expect(checkpoint.checkpoint).toBe('to')
  expect(checkpoint.message).toContain('thread-1')
  expect(checkpoint.message).toContain('2')

  expect(workspace.operation).toBe('CheckpointDiffQuery.getFullThreadDiff')
  expect(workspace.threadId).toBe(threadId)
  expect(workspace.message).toContain('CheckpointDiffQuery.getFullThreadDiff')
  expect(workspace.message).toContain('thread-1')
})
