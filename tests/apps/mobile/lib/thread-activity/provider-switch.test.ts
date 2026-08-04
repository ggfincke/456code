// tests/apps/mobile/lib/thread-activity/provider-switch.test.ts
// verifies mobile provider-switch outcome derivation and notice presentation

import { describe, expect, it } from '@effect/vitest'
import { EventId, ProviderInstanceId, type OrchestrationThreadActivity } from '@t3tools/contracts'

import {
  deriveLatestProviderSwitchOutcome,
  providerSwitchSuppressesStop,
  resolveThreadProviderSwitchNotice,
  threadProviderSwitchRequired,
} from '../../../../../apps/mobile/src/lib/thread-activity/provider-switch'

function activity(input: {
  readonly id: string
  readonly kind: string
  readonly createdAt: string
  readonly sequence: number
  readonly payload: unknown
}): OrchestrationThreadActivity
{
  return {
    id: EventId.make(input.id),
    tone: input.kind === 'provider.switch.failed' ? 'error' : 'info',
    kind: input.kind,
    summary: 'Provider switch',
    payload: input.payload,
    turnId: null,
    sequence: input.sequence,
    createdAt: input.createdAt,
  }
}

const NO_DISPLAY_NAMES = () => null

describe('mobile provider switch', () =>
{
  it('derives the newest outcome with a durable retry selection', () =>
  {
    const outcome = deriveLatestProviderSwitchOutcome([
      activity({
        id: 'event-1',
        kind: 'provider.switch.completed',
        createdAt: '2026-08-02T10:00:00.000Z',
        sequence: 1,
        payload: { toInstanceId: 'provider-a', toModel: 'model-a' },
      }),
      activity({
        id: 'event-2',
        kind: 'provider.switch.failed',
        createdAt: '2026-08-02T10:05:00.000Z',
        sequence: 2,
        payload: {
          reasonCode: 'compaction-timeout',
          detail: 'summary timed out',
          retryTargetModelSelection: { instanceId: 'provider-b', model: 'model-b' },
        },
      }),
    ])

    expect(outcome).toMatchObject({
      id: 'event-2',
      status: 'failed',
      reasonCode: 'compaction-timeout',
      retrySelection: { instanceId: 'provider-b', model: 'model-b' },
    })
  })

  it('offers a retry path on failure and drops the notice once dismissed', () =>
  {
    const latestOutcome = deriveLatestProviderSwitchOutcome([
      activity({
        id: 'event-1',
        kind: 'provider.switch.failed',
        createdAt: '2026-08-02T10:05:00.000Z',
        sequence: 1,
        payload: {
          reasonCode: 'target-unavailable',
          retryTargetModelSelection: { instanceId: 'provider-b', model: 'model-b' },
        },
      }),
    ])

    const notice = resolveThreadProviderSwitchNotice({
      providerSwitch: null,
      latestOutcome,
      dismissedOutcomeId: null,
      resolveInstanceDisplayName: NO_DISPLAY_NAMES,
    })

    expect(notice).toMatchObject({
      kind: 'failed',
      outcomeId: 'event-1',
      label: 'Switch to provider-b · model-b failed — the new provider was unavailable',
      retrySelection: { instanceId: 'provider-b', model: 'model-b' },
    })
    expect(
      resolveThreadProviderSwitchNotice({
        providerSwitch: null,
        latestOutcome,
        dismissedOutcomeId: 'event-1',
        resolveInstanceDisplayName: NO_DISPLAY_NAMES,
      }),
    ).toBeNull()
  })

  it('presents an in-flight switch as uncancelable and suppresses the stop action', () =>
  {
    const notice = resolveThreadProviderSwitchNotice({
      providerSwitch: {
        phase: 'compacting',
        targetInstanceId: ProviderInstanceId.make('provider-b'),
        targetModel: 'model-b',
        requestedAt: '2026-08-02T10:00:00.000Z',
      },
      latestOutcome: null,
      dismissedOutcomeId: null,
      resolveInstanceDisplayName: NO_DISPLAY_NAMES,
    })

    expect(notice?.kind).toBe('switching')
    expect(notice?.kind === 'switching' ? notice.detail : null).toContain('cannot be cancelled')
    // a running session and a temporarily null one both stay unstoppable.
    expect(
      providerSwitchSuppressesStop({ sessionStatus: 'running', providerSwitchActive: true }),
    ).toBe(true)
    expect(providerSwitchSuppressesStop({ sessionStatus: null, providerSwitchActive: true })).toBe(
      true,
    )
    expect(
      providerSwitchSuppressesStop({ sessionStatus: 'running', providerSwitchActive: false }),
    ).toBe(false)
  })

  it('requires a switch only when a started thread changes provider instance', () =>
  {
    const current = ProviderInstanceId.make('provider-a')
    const next = ProviderInstanceId.make('provider-b')

    expect(
      threadProviderSwitchRequired({
        threadStarted: true,
        currentInstanceId: current,
        nextInstanceId: next,
      }),
    ).toBe(true)
    expect(
      threadProviderSwitchRequired({
        threadStarted: true,
        currentInstanceId: current,
        nextInstanceId: current,
      }),
    ).toBe(false)
    expect(
      threadProviderSwitchRequired({
        threadStarted: false,
        currentInstanceId: current,
        nextInstanceId: next,
      }),
    ).toBe(false)
  })
})
