// tests/apps/server/provider/CollaborationModeInstructions.test.ts
// verifies provider-neutral orchestrate prompt composition

import { describe, expect, it } from 'vite-plus/test'
import { ThreadId } from '@t3tools/contracts'

import {
  applyOrchestrateModeInstructions,
  ORCHESTRATE_MODE_INSTRUCTIONS,
  T3_CODE_ARCHITECTURE_TOOL_INSTRUCTIONS,
  T3_CODE_PROPOSAL_TOOL_INSTRUCTIONS,
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
    expect(ORCHESTRATE_MODE_INSTRUCTIONS).toContain('architecture_plan_impact_upsert')
    expect(T3_CODE_ARCHITECTURE_TOOL_INSTRUCTIONS).toContain(
      'Planned Impact is proposal intent, not verified repository evidence',
    )
    expect(T3_CODE_PROPOSAL_TOOL_INSTRUCTIONS).toContain(
      'publish Planned Impact first, then create the proposal preview',
    )
    expect(T3_CODE_PROPOSAL_TOOL_INSTRUCTIONS.indexOf('orchestrate_plan_upsert')).toBeLessThan(
      T3_CODE_PROPOSAL_TOOL_INSTRUCTIONS.indexOf('publish it next'),
    )
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
