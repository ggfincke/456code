// tests/apps/web/components/ChatMarkdown.parse.test.ts
// verifies orchestrate plan diagnostics without rendering the chat surface
import { describe, expect, it } from '@effect/vitest'

import { parseOrchestratePlanResult } from '../../../../apps/web/src/components/chat/OrchestratePlanCard'

const VALID_PLAN = {
  workflow: 'review-and-fix',
  stages: [
    {
      id: 'review',
      provider: 'codex',
      model: 'gpt-5.6',
      mode: 'read',
      workers: 1,
      scope: 'apps/web',
    },
    {
      id: 'implement',
      provider: 'codex',
      model: 'gpt-5.6',
      mode: 'edit',
      workers: 1,
      scope: 'apps/web',
    },
  ],
}

describe('parseOrchestratePlanResult', () =>
{
  it('reports the invalid worker field and its received type', () =>
  {
    const result = parseOrchestratePlanResult(
      JSON.stringify({
        ...VALID_PLAN,
        stages: [VALID_PLAN.stages[0], { ...VALID_PLAN.stages[1], workers: 'one' }],
      }),
    )

    expect(result).toEqual({
      status: 'error',
      diagnostic: 'stages[1].workers must be an integer (got string)',
    })
  })

  it('does not diagnose incomplete JSON while streaming', () =>
  {
    const result = parseOrchestratePlanResult('{"workflow":"review-and-fix",', false)

    expect(result).toEqual({ status: 'incomplete' })
    expect('diagnostic' in result).toBe(false)
  })
})
