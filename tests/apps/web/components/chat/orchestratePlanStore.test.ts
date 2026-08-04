// tests/apps/web/components/chat/orchestratePlanStore.test.ts
// verifies order-based supersession, revision recovery, and bounded store retention
import { beforeEach, describe, expect, it } from '@effect/vitest'

import {
  createOrchestratePlanCardStateKey,
  EMPTY_ORCHESTRATE_PLAN_CARD_STATE,
  isOrchestratePlanCardSuperseded,
  isOrchestratePlanRevisionStarted,
  markOrchestratePlanRevisionStarted,
  readOrchestratePlanCardState,
  readOrchestratePlanStoreSizeForTests,
  registerOrchestratePlanCard,
  resetOrchestratePlanStoreForTests,
  setOrchestratePlanCardStatus,
  setOrchestratePlanMaxWorkers,
  setOrchestrateStageEffort,
  setOrchestrateStageSelection,
} from '../../../../../apps/web/src/components/chat/orchestratePlanStore'

beforeEach(resetOrchestratePlanStoreForTests)

describe('orchestrate plan supersession', () =>
{
  it('keeps the newest emission actionable when it mounts before the older card', () =>
  {
    registerOrchestratePlanCard('run-1', 'new', { messageIndex: 20, planIndex: 0 })
    registerOrchestratePlanCard('run-1', 'old', { messageIndex: 10, planIndex: 0 })

    expect(isOrchestratePlanCardSuperseded('run-1', 'new')).toBe(false)
    expect(isOrchestratePlanCardSuperseded('run-1', 'old')).toBe(true)
  })

  it('produces the same result for oldest-first registration and remounts', () =>
  {
    registerOrchestratePlanCard('run-1', 'old', { messageIndex: 10, planIndex: 0 })
    registerOrchestratePlanCard('run-1', 'new', { messageIndex: 20, planIndex: 0 })
    registerOrchestratePlanCard('run-1', 'old', { messageIndex: 30, planIndex: 0 })

    expect(isOrchestratePlanCardSuperseded('run-1', 'new')).toBe(false)
    expect(isOrchestratePlanCardSuperseded('run-1', 'old')).toBe(true)
  })

  it('orders multiple plans in one message by their fence position', () =>
  {
    registerOrchestratePlanCard('run-1', 'second', { messageIndex: 10, planIndex: 1 })
    registerOrchestratePlanCard('run-1', 'first', { messageIndex: 10, planIndex: 0 })

    expect(isOrchestratePlanCardSuperseded('run-1', 'second')).toBe(false)
    expect(isOrchestratePlanCardSuperseded('run-1', 'first')).toBe(true)
  })
})

describe('orchestrate plan revision state', () =>
{
  it('recovers picker and lifecycle state only for the same revision', () =>
  {
    const firstKey = createOrchestratePlanCardStateKey('run-1', 'message-a:0:content-a')
    const revisedKey = createOrchestratePlanCardStateKey('run-1', 'message-b:0:content-b')

    setOrchestrateStageSelection(firstKey, '0:review', {
      provider: 'cursor',
      model: 'cursor-pro',
      instanceId: null,
    })
    setOrchestrateStageEffort(firstKey, '0:review', 'high')
    setOrchestratePlanMaxWorkers(firstKey, 4)
    setOrchestratePlanCardStatus(firstKey, 'editing')

    expect(readOrchestratePlanCardState(firstKey)).toEqual({
      selections: {
        '0:review': { provider: 'cursor', model: 'cursor-pro', instanceId: null },
      },
      efforts: { '0:review': 'high' },
      maxWorkers: 4,
      status: 'editing',
      error: null,
    })
    expect(readOrchestratePlanCardState(revisedKey)).toBe(EMPTY_ORCHESTRATE_PLAN_CARD_STATE)
  })

  it('marks only the revision whose approval started the run', () =>
  {
    registerOrchestratePlanCard('run-1', 'started', { messageIndex: 10, planIndex: 0 })
    registerOrchestratePlanCard('run-1', 'revised', { messageIndex: 20, planIndex: 0 })
    markOrchestratePlanRevisionStarted('run-1', 'started')

    expect(isOrchestratePlanRevisionStarted('run-1', 'started')).toBe(true)
    expect(isOrchestratePlanRevisionStarted('run-1', 'revised')).toBe(false)
  })
})

describe('orchestrate plan store retention', () =>
{
  it('bounds card, run, and per-run revision growth', () =>
  {
    for (let index = 0; index < 300; index += 1)
    {
      setOrchestratePlanCardStatus(`card-${index}`, 'editing')
    }
    for (let index = 0; index < 150; index += 1)
    {
      registerOrchestratePlanCard(`run-${index}`, 'revision', {
        messageIndex: index,
        planIndex: 0,
      })
    }
    for (let index = 0; index < 24; index += 1)
    {
      registerOrchestratePlanCard('latest-run', `revision-${index}`, {
        messageIndex: index,
        planIndex: 0,
      })
    }

    expect(readOrchestratePlanStoreSizeForTests()).toEqual({
      cardStates: 256,
      runs: 128,
      revisions: 143,
    })
    expect(
      isOrchestratePlanCardSuperseded('latest-run', 'revision-0', {
        messageIndex: 0,
        planIndex: 0,
      }),
    ).toBe(true)
  })
})
