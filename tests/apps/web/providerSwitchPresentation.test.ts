// tests/apps/web/providerSwitchPresentation.test.ts
// verifies provider switch pill copy, failure reasons, and timeline derivation

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadActivity,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { shouldReconcileComposerDraftModelSelection } from '../../../apps/web/src/components/ChatView.logic'
import {
  canApplyProviderSwitchRetry,
  deriveProviderSwitchTimelineEvents,
  describeProviderSwitchConfirmation,
  describeProviderSwitchFailureReason,
  describeProviderSwitchPickerIntent,
  formatProviderSwitchFailureLabel,
  formatProviderSwitchFailureToastDescription,
  formatProviderSwitchSendBlockedNotice,
  formatProviderSwitchTargetLabel,
  PROVIDER_SWITCH_SEND_BLOCKED_NOTICE,
  providerSwitchPickerIntentCopy,
  reconcileProviderSwitchAnnouncements,
  resolvePendingHandoffPresentation,
  resolveProviderSwitchPillLabel,
  resolveProviderSwitchRetryTarget,
  type ProviderSwitchInstanceResolver,
  type ProviderSwitchTimelineEvent,
} from '../../../apps/web/src/providerSwitchPresentation'
import { deriveWorkLogEntries } from '../../../apps/web/src/session-logic'

let nextActivityId = 0

function makeActivity(overrides: {
  id?: string
  createdAt?: string
  kind: string
  summary?: string
  tone?: OrchestrationThreadActivity['tone']
  payload?: Record<string, unknown>
}): OrchestrationThreadActivity
{
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
    createdAt: overrides.createdAt ?? '2026-08-02T00:00:00.000Z',
    kind: overrides.kind,
    summary: overrides.summary ?? 'Provider switch',
    tone: overrides.tone ?? 'info',
    payload: overrides.payload ?? {},
    turnId: null,
  }
}

const resolveInstance: ProviderSwitchInstanceResolver = (instanceId) =>
  instanceId === 'codex'
    ? { driverKind: ProviderDriverKind.make('codex'), displayName: 'Codex' }
    : instanceId === 'claude'
      ? { driverKind: ProviderDriverKind.make('claudeAgent'), displayName: 'Claude' }
      : instanceId === 'claude-work'
        ? { driverKind: ProviderDriverKind.make('claudeAgent'), displayName: 'Claude Work' }
        : null

describe('formatProviderSwitchTargetLabel', () =>
{
  it('separates two configured instances running the same model', () =>
  {
    const personal = formatProviderSwitchTargetLabel({
      instanceId: 'claude',
      displayName: 'Claude',
      model: 'opus-5',
    })
    const work = formatProviderSwitchTargetLabel({
      instanceId: 'claude-work',
      displayName: 'Claude Work',
      model: 'opus-5',
    })

    expect(personal).toBe('Claude · opus-5')
    expect(work).toBe('Claude Work · opus-5')
    expect(personal).not.toBe(work)
  })

  it('falls back to the raw instance id when the instance is no longer configured', () =>
  {
    expect(formatProviderSwitchTargetLabel({ instanceId: 'claude-work', model: 'opus-5' })).toBe(
      'claude-work · opus-5',
    )
    expect(formatProviderSwitchTargetLabel({ instanceId: 'claude-work', displayName: '  ' })).toBe(
      'claude-work',
    )
  })
})

describe('resolveProviderSwitchPillLabel', () =>
{
  it('names the target in every phase so the pill label stays complete', () =>
  {
    const labels = (['pending', 'compacting', 'finalizing'] as const).map((phase) =>
      resolveProviderSwitchPillLabel({ phase, targetLabel: 'opus-5' }),
    )

    expect(labels).toEqual([
      'Switching to opus-5…',
      'Summarizing conversation for handoff to opus-5… (can take a couple of minutes)',
      'Finishing switch to opus-5…',
    ])
    for (const label of labels)
    {
      expect(label).toContain('opus-5')
    }
  })
})

describe('describeProviderSwitchConfirmation', () =>
{
  it('names the target instance and model without dropping the uncancelable warning', () =>
  {
    const copy = describeProviderSwitchConfirmation({ targetLabel: 'Claude Work · opus-5' })

    expect(copy.title).toBe('Switch to Claude Work · opus-5?')
    expect(copy.description).toContain('Claude Work · opus-5')
    expect(copy.description).toContain("can't be cancelled once it starts")
  })
})

describe('formatProviderSwitchSendBlockedNotice', () =>
{
  it('names the target the blocked draft is waiting on', () =>
  {
    expect(formatProviderSwitchSendBlockedNotice('Claude · opus-5')).toBe(
      'Switching to Claude · opus-5 — your message can be sent when it finishes',
    )
    expect(formatProviderSwitchSendBlockedNotice(null)).toBe(PROVIDER_SWITCH_SEND_BLOCKED_NOTICE)
  })
})

describe('resolvePendingHandoffPresentation', () =>
{
  const handoff = { createdAt: '2026-08-02T00:00:00.000Z' }
  const delivered = makeActivity({
    id: 'handoff-delivered',
    createdAt: '2026-08-02T00:00:05.000Z',
    kind: 'provider.handoff.delivered',
    summary: 'Provider handoff delivered',
  })

  it('promises the next message only while nothing has been sent', () =>
  {
    const presentation = resolvePendingHandoffPresentation({
      handoff,
      activities: [],
      sentSinceHandoff: false,
      targetLabel: 'Claude · opus-5',
    })

    expect(presentation).toEqual({
      delivery: 'queued',
      label: 'Handoff summary pending — it will be included with your next message',
    })
  })

  it('stops promising a resend once delivery is on the record, without claiming it was used', () =>
  {
    const presentation = resolvePendingHandoffPresentation({
      handoff,
      activities: [delivered],
      sentSinceHandoff: true,
      targetLabel: 'Claude · opus-5',
    })

    expect(presentation?.delivery).toBe('delivered')
    expect(presentation?.label).toContain('delivered to Claude · opus-5')
    expect(presentation?.label).not.toContain('will be included')
  })

  it('reports an unconfirmed handoff when a send recorded no delivery', () =>
  {
    const presentation = resolvePendingHandoffPresentation({
      handoff,
      // the marker predates this handoff, so it proves nothing about it
      activities: [{ ...delivered, createdAt: '2026-08-01T23:59:59.000Z' }],
      sentSinceHandoff: true,
      targetLabel: 'Claude · opus-5',
    })

    expect(presentation?.delivery).toBe('unknown')
    expect(presentation?.label).toContain('unconfirmed')
  })

  it('renders nothing without a pending handoff', () =>
  {
    expect(
      resolvePendingHandoffPresentation({
        handoff: null,
        activities: [delivered],
        sentSinceHandoff: true,
      }),
    ).toBeNull()
  })
})

describe('describeProviderSwitchFailureReason', () =>
{
  it('maps known reason codes to human copy', () =>
  {
    expect(describeProviderSwitchFailureReason('compaction-timeout')).toBe(
      'the summary took too long',
    )
    expect(describeProviderSwitchFailureReason('interrupted-by-restart')).toBe(
      'the server restarted mid-switch',
    )
    expect(formatProviderSwitchFailureLabel('target-unavailable')).toBe(
      'Provider switch failed — the new provider was unavailable',
    )
  })

  it('falls back for a missing or unknown code', () =>
  {
    expect(describeProviderSwitchFailureReason(null)).toBe('an unexpected error occurred')
    expect(describeProviderSwitchFailureReason('brand-new-code')).toBe('brand-new-code')
  })

  it('names the target when the outcome carries one', () =>
  {
    expect(formatProviderSwitchFailureLabel('stop-failed', 'Claude')).toBe(
      'Provider switch to Claude failed — the current session could not be stopped',
    )
    expect(
      formatProviderSwitchFailureToastDescription({
        reasonCode: 'stop-failed',
        targetLabel: 'Claude',
      }),
    ).toBe('The switch to Claude stopped because the current session could not be stopped.')
    expect(
      formatProviderSwitchFailureToastDescription({ reasonCode: 'stop-failed', targetLabel: null }),
    ).toBe('The switch stopped because the current session could not be stopped.')
  })
})

describe('deriveProviderSwitchTimelineEvents', () =>
{
  it('derives completed and failed events and leaves them out of the work log', () =>
  {
    const activities = [
      makeActivity({
        id: 'switch-done',
        createdAt: '2026-08-02T00:00:01.000Z',
        kind: 'provider.switch.completed',
        summary: 'Switched from gpt-5-codex to opus-5',
        payload: {
          fromInstanceId: 'codex',
          fromModel: 'gpt-5-codex',
          toInstanceId: 'claude',
          toModel: 'opus-5',
        },
      }),
      makeActivity({
        id: 'switch-failed',
        createdAt: '2026-08-02T00:00:02.000Z',
        kind: 'provider.switch.failed',
        summary: 'Provider switch failed',
        tone: 'error',
        payload: { reasonCode: 'compaction-timeout', detail: 'compaction timed out after 120s' },
      }),
    ]

    const events = deriveProviderSwitchTimelineEvents(activities, resolveInstance)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      id: 'switch-done',
      status: 'completed',
      label: 'Switched from Codex · gpt-5-codex to Claude · opus-5',
      from: { driverKind: 'codex', displayName: 'Codex', modelLabel: 'gpt-5-codex' },
      to: { driverKind: 'claudeAgent', displayName: 'Claude', modelLabel: 'opus-5' },
    })
    expect(events[1]).toMatchObject({
      id: 'switch-failed',
      status: 'failed',
      label: 'Provider switch failed — the summary took too long',
      detail: 'compaction timed out after 120s',
      reasonCode: 'compaction-timeout',
      target: null,
      targetLabel: null,
    })

    expect(deriveWorkLogEntries(activities)).toHaveLength(0)
  })

  it.each([
    {
      outcome: 'completed' as const,
      personal: makeActivity({
        createdAt: '2026-08-02T00:00:01.000Z',
        kind: 'provider.switch.completed',
        summary: 'Switched provider',
        payload: {
          fromInstanceId: 'codex',
          fromModel: 'gpt-5-codex',
          toInstanceId: 'claude',
          toModel: 'opus-5',
        },
      }),
      work: makeActivity({
        createdAt: '2026-08-02T00:00:02.000Z',
        kind: 'provider.switch.completed',
        summary: 'Switched provider',
        payload: {
          fromInstanceId: 'claude',
          fromModel: 'opus-5',
          toInstanceId: 'claude-work',
          toModel: 'opus-5',
        },
      }),
      personalLabel: 'Switched from Codex · gpt-5-codex to Claude · opus-5',
      workLabel: 'Switched from Claude · opus-5 to Claude Work · opus-5',
    },
    {
      outcome: 'failed' as const,
      personal: makeActivity({
        createdAt: '2026-08-02T00:00:01.000Z',
        kind: 'provider.switch.failed',
        tone: 'error',
        payload: {
          reasonCode: 'target-unavailable',
          targetInstanceId: 'claude',
          targetModel: 'opus-5',
        },
      }),
      work: makeActivity({
        createdAt: '2026-08-02T00:00:02.000Z',
        kind: 'provider.switch.failed',
        tone: 'error',
        payload: {
          reasonCode: 'target-unavailable',
          targetInstanceId: 'claude-work',
          targetModel: 'opus-5',
        },
      }),
      personalLabel: 'Provider switch to Claude · opus-5 failed — the new provider was unavailable',
      workLabel:
        'Provider switch to Claude Work · opus-5 failed — the new provider was unavailable',
    },
  ])(
    'keeps two instances on the same model apart in the $outcome copy',
    ({ outcome, personal, work, personalLabel, workLabel }) =>
    {
      const [personalEvent, workEvent] = deriveProviderSwitchTimelineEvents(
        [personal, work],
        resolveInstance,
      )

      expect(personalEvent?.label).toBe(personalLabel)
      expect(workEvent?.label).toBe(workLabel)
      expect(personalEvent?.label).not.toBe(workEvent?.label)
      if (outcome === 'failed')
      {
        expect(personalEvent?.targetLabel).toBe('Claude · opus-5')
        expect(workEvent?.targetLabel).toBe('Claude Work · opus-5')
      }
    },
  )

  it('keeps the activity summary when the completed payload has no models', () =>
  {
    const events = deriveProviderSwitchTimelineEvents(
      [
        makeActivity({
          kind: 'provider.switch.completed',
          summary: 'Switched provider',
          payload: { toInstanceId: 'claude' },
        }),
      ],
      resolveInstance,
    )

    expect(events[0]?.label).toBe('Switched provider')
    expect(events[0]?.from).toBeNull()
    expect(events[0]?.to).toMatchObject({ displayName: 'Claude', modelLabel: null })
  })

  it('reads the durable target off a failed outcome', () =>
  {
    const [failure] = deriveProviderSwitchTimelineEvents(
      [
        makeActivity({
          kind: 'provider.switch.failed',
          tone: 'error',
          payload: {
            reasonCode: 'target-unavailable',
            targetInstanceId: 'claude',
            targetModel: 'opus-5',
          },
        }),
      ],
      resolveInstance,
    )

    expect(failure?.target).toEqual({ instanceId: 'claude', model: 'opus-5' })
    expect(failure?.targetLabel).toBe('Claude · opus-5')
    expect(failure?.label).toBe(
      'Provider switch to Claude · opus-5 failed — the new provider was unavailable',
    )
  })

  it('falls back to the instance name when the failed outcome resolved no model', () =>
  {
    const [failure] = deriveProviderSwitchTimelineEvents(
      [
        makeActivity({
          kind: 'provider.switch.failed',
          tone: 'error',
          payload: { reasonCode: 'internal-error', targetInstanceId: 'claude' },
        }),
      ],
      resolveInstance,
    )

    expect(failure?.target).toEqual({ instanceId: 'claude', model: null })
    expect(failure?.targetLabel).toBe('Claude')
  })
})

function makeOutcome(
  id: string,
  overrides: Partial<ProviderSwitchTimelineEvent> = {},
): ProviderSwitchTimelineEvent
{
  return {
    id,
    createdAt: '2026-08-02T00:00:00.000Z',
    turnId: null,
    status: 'completed',
    label: 'Switched from gpt-5-codex to opus-5',
    from: null,
    to: null,
    detail: null,
    reasonCode: null,
    target: null,
    targetLabel: null,
    ...overrides,
  }
}

describe('reconcileProviderSwitchAnnouncements', () =>
{
  const threadKey = 'environment-local:thread-1'
  const history = [makeOutcome('outcome-1'), makeOutcome('outcome-2')]

  it('never seeds or announces from an unsynchronized snapshot', () =>
  {
    const cached = reconcileProviderSwitchAnnouncements({
      events: [history[0]!],
      state: null,
      synchronized: false,
      threadKey,
    })

    expect(cached).toEqual({ state: null, announce: [] })

    // the catch-up delivery carries the outcome the cached snapshot was missing
    const live = reconcileProviderSwitchAnnouncements({
      events: history,
      state: cached.state,
      synchronized: true,
      threadKey,
    })

    expect(live.announce).toEqual([])
    expect(live.state?.announcedIds.size).toBe(2)
  })

  it('announces a genuinely new outcome exactly once', () =>
  {
    const seeded = reconcileProviderSwitchAnnouncements({
      events: history,
      state: null,
      synchronized: true,
      threadKey,
    })
    const fresh = makeOutcome('outcome-3', { status: 'failed', label: 'Provider switch failed' })

    const first = reconcileProviderSwitchAnnouncements({
      events: [...history, fresh],
      state: seeded.state,
      synchronized: true,
      threadKey,
    })
    const second = reconcileProviderSwitchAnnouncements({
      events: [...history, fresh],
      state: first.state,
      synchronized: true,
      threadKey,
    })

    expect(first.announce.map((event) => event.id)).toEqual(['outcome-3'])
    expect(second.announce).toEqual([])
  })

  it('re-seeds when the thread is reopened instead of replaying what landed off screen', () =>
  {
    const seeded = reconcileProviderSwitchAnnouncements({
      events: history,
      state: null,
      synchronized: true,
      threadKey,
    })
    const otherThread = reconcileProviderSwitchAnnouncements({
      events: [],
      state: seeded.state,
      synchronized: true,
      threadKey: 'environment-local:thread-2',
    })
    const reopened = reconcileProviderSwitchAnnouncements({
      events: [...history, makeOutcome('outcome-3')],
      state: otherThread.state,
      synchronized: true,
      threadKey,
    })

    expect(reopened.announce).toEqual([])
    expect(reopened.state?.announcedIds.size).toBe(3)
  })
})

describe('resolveProviderSwitchRetryTarget', () =>
{
  const threadKey = 'environment-local:thread-1'
  const fallback = {
    threadKey,
    instanceId: ProviderInstanceId.make('claude'),
    model: 'sonnet',
  }

  it('prefers the durable outcome target over the in-memory in-flight target', () =>
  {
    const event = makeOutcome('outcome-1', {
      status: 'failed',
      target: { instanceId: ProviderInstanceId.make('claude'), model: 'opus-5' },
    })

    expect(resolveProviderSwitchRetryTarget({ event, fallback, threadKey })).toEqual({
      instanceId: 'claude',
      model: 'opus-5',
    })
  })

  it('keeps the in-memory target for outcomes written without one', () =>
  {
    const event = makeOutcome('outcome-1', { status: 'failed' })

    expect(resolveProviderSwitchRetryTarget({ event, fallback, threadKey })).toEqual({
      instanceId: 'claude',
      model: 'sonnet',
    })
    expect(resolveProviderSwitchRetryTarget({ event, fallback: null, threadKey })).toBeNull()
    expect(
      resolveProviderSwitchRetryTarget({
        event,
        fallback: { ...fallback, threadKey: 'environment-local:thread-2' },
        threadKey,
      }),
    ).toBeNull()
  })

  // fold from providerSwitchFlow: retry payload wires reconcile + compaction-failed + null fallback
  it('keeps the failed projection current when the picker retries', () =>
  {
    const threadId = ThreadId.make('thread-1')
    const projectedSelection = {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.4',
    }
    const failedTargetSelection = {
      instanceId: ProviderInstanceId.make('claude'),
      model: 'sonnet',
    }
    const failedActivity: OrchestrationThreadActivity = {
      id: EventId.make('provider-switch-failed'),
      tone: 'error',
      kind: 'provider.switch.failed',
      summary: 'Provider switch failed',
      payload: {
        reasonCode: 'compaction-failed',
        detail: 'Compaction failed.',
        targetInstanceId: failedTargetSelection.instanceId,
        targetModel: failedTargetSelection.model,
      },
      turnId: null,
      createdAt: '2026-08-02T00:00:00.000Z',
    }
    const shouldReconcile = shouldReconcileComposerDraftModelSelection({
      composerSelection: failedTargetSelection,
      hasStarted: true,
      previousProjection: {
        threadKey: 'environment-1:thread-1',
        selection: projectedSelection,
      },
      projectedSelection,
      threadKey: 'environment-1:thread-1',
    })
    const pickerSelection = shouldReconcile ? projectedSelection : failedTargetSelection
    const [failure] = deriveProviderSwitchTimelineEvents([failedActivity], () => null)
    // the retry target comes off the durable outcome, with no in-flight ref left
    const retryTarget = resolveProviderSwitchRetryTarget({
      event: failure!,
      fallback: null,
      threadKey: 'environment-1:thread-1',
    })
    const retryPayload = {
      threadId,
      targetModelSelection: { ...retryTarget!, model: retryTarget!.model ?? '' },
      expectedCurrentInstanceId: pickerSelection.instanceId,
    }

    expect(failure?.label).toBe(
      'Provider switch to claude · sonnet failed — the summary could not be generated',
    )
    expect(shouldReconcile).toBe(true)
    expect(retryPayload).toEqual({
      threadId,
      targetModelSelection: failedTargetSelection,
      expectedCurrentInstanceId: projectedSelection.instanceId,
    })
  })
})

describe('canApplyProviderSwitchRetry', () =>
{
  it('refuses a thread-A retry once the route has moved to thread B', () =>
  {
    const announcedThreadKey = 'environment-local:thread-a'

    expect(
      canApplyProviderSwitchRetry({ announcedThreadKey, routeThreadKey: announcedThreadKey }),
    ).toBe(true)
    expect(
      canApplyProviderSwitchRetry({
        announcedThreadKey,
        routeThreadKey: 'environment-local:thread-b',
      }),
    ).toBe(false)
  })
})

describe('describeProviderSwitchPickerIntent', () =>
{
  const threadInstanceId = ProviderInstanceId.make('codex')

  it('separates instant model changes from confirm-and-wait handoffs', () =>
  {
    expect(
      describeProviderSwitchPickerIntent({ rowInstanceId: threadInstanceId, threadInstanceId }),
    ).toBe('instant')
    expect(
      describeProviderSwitchPickerIntent({
        rowInstanceId: ProviderInstanceId.make('claude'),
        threadInstanceId,
      }),
    ).toBe('handoff')
    expect(
      describeProviderSwitchPickerIntent({
        rowInstanceId: threadInstanceId,
        threadInstanceId: null,
      }),
    ).toBeNull()
  })

  it('explains each intent before the user selects a row', () =>
  {
    expect(providerSwitchPickerIntentCopy('instant').badge).toBe('Instant')
    expect(providerSwitchPickerIntentCopy('instant').description).toContain('right away')
    expect(providerSwitchPickerIntentCopy('handoff').badge).toBe('Confirm & wait')
    expect(providerSwitchPickerIntentCopy('handoff').description).toContain('confirm')
    expect(providerSwitchPickerIntentCopy('handoff').description).toContain('handed off')
  })
})
