// tests/apps/web/components/ChatMarkdown.parse.test.ts
// verifies orchestrate plan diagnostics without rendering the chat surface
import type { OrchestratePlanRevision } from '@t3tools/contracts'
import { describe, expect, it } from '@effect/vitest'

import { resolveChatMarkdownOrchestrateFence } from '../../../../apps/web/src/components/ChatMarkdown'
import { parseOrchestratePlanResult } from '../../../../apps/web/src/components/chat/OrchestratePlanCard'

const VALID_PLAN = {
  workflow: 'review-and-fix',
  runId: 'run-42',
  revision: 3,
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

const persistedRevision = {
  runId: 'run-42',
  revision: 3,
  turnId: null,
  workflow: 'review-and-fix',
  task: '',
  stages: [],
  totalWorkers: 0,
  maxWorkers: 0,
  source: 'tool',
  leadModelSelection: null,
  status: 'pending',
  createdAt: '2026-08-13T12:00:00.000Z',
  updatedAt: '2026-08-13T12:00:00.000Z',
} satisfies OrchestratePlanRevision

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

describe('ChatMarkdown orchestrate-plan fences', () =>
{
  it('returns null for a persisted matching fence', () =>
  {
    const mount = resolveChatMarkdownOrchestrateFence({
      language: 'orchestrate-plan',
      code: JSON.stringify(VALID_PLAN),
      isComplete: true,
      orchestratePlans: [persistedRevision],
      hasActions: true,
    })

    expect(mount).toEqual({ kind: 'suppress' })
  })

  it('still mounts a card when persist lookup misses', () =>
  {
    const mount = resolveChatMarkdownOrchestrateFence({
      language: 'orchestrate-plan',
      code: JSON.stringify(VALID_PLAN),
      isComplete: true,
      orchestratePlans: [],
      hasActions: true,
    })

    expect(mount.kind).toBe('card')
  })
})
