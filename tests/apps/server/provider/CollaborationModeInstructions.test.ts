// tests/apps/server/provider/CollaborationModeInstructions.test.ts
// verifies provider-neutral orchestrate prompt composition

import { describe, expect, it } from 'vite-plus/test'
import { ThreadId } from '@t3tools/contracts'

import {
  applyOrchestrateModeInstructions,
  ORCHESTRATE_MODE_INSTRUCTIONS,
} from '../../../../apps/server/src/provider/CollaborationModeInstructions.ts'

describe('applyOrchestrateModeInstructions', () =>
{
  it('applies orchestrate instructions to plan plus orchestrate', () =>
  {
    const result = applyOrchestrateModeInstructions({
      threadId: ThreadId.make('thread-1'),
      input: 'Plan the change.',
      interactionMode: 'plan',
      orchestrate: true,
    })

    expect(result.interactionMode).toBe('plan')
    expect(result.orchestrate).toBe(true)
    expect(result.input).toContain(ORCHESTRATE_MODE_INSTRUCTIONS)
    expect(result.input).toContain('<user_request>\nPlan the change.\n</user_request>')
    expect(ORCHESTRATE_MODE_INSTRUCTIONS).toContain('non-empty decided edit set')
    expect(ORCHESTRATE_MODE_INSTRUCTIONS).toContain('standing-project')
    expect(ORCHESTRATE_MODE_INSTRUCTIONS).not.toContain(
      'complete the linked proposal-preview sequence',
    )
  })

  it('leaves plain plan input unchanged', () =>
  {
    const input = {
      threadId: ThreadId.make('thread-1'),
      input: 'Plan the change.',
      interactionMode: 'plan' as const,
    }

    expect(applyOrchestrateModeInstructions(input)).toBe(input)
  })
})
