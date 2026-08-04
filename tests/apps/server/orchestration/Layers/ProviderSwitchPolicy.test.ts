// tests/apps/server/orchestration/Layers/ProviderSwitchPolicy.test.ts
// verifies provider-switch compaction policy and handoff delivery

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type ProviderSession,
  ThreadId,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { prepareProviderInputWithHandoff } from '../../../../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts'
import {
  PROVIDER_SWITCH_COMPACTION_PROMPT,
  resolveProviderSwitchCompactionModel,
} from '../../../../../apps/server/src/orchestration/Layers/ProviderSwitchPolicy.ts'

const pendingHandoff = {
  text: 'Prior work changed apps/server/src/example.ts.',
  fromInstanceId: ProviderInstanceId.make('codex'),
  fromModel: 'gpt-5-codex',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function providerSession(sessionId: string): ProviderSession
{
  return {
    provider: ProviderDriverKind.make('claudeAgent'),
    providerInstanceId: ProviderInstanceId.make('claude-work'),
    status: 'ready',
    runtimeMode: 'approval-required',
    threadId: ThreadId.make('thread-1'),
    resumeCursor: { sessionId },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('resolveProviderSwitchCompactionModel', () =>
{
  it('selects the canonical Claude compaction model from the standard catalog', () =>
  {
    expect(
      resolveProviderSwitchCompactionModel({
        driverKind: ProviderDriverKind.make('claudeAgent'),
        currentModel: 'claude-opus-5',
        availableModels: ['claude-opus-5', 'claude-sonnet-5'],
      }),
    ).toBe('claude-sonnet-5')
  })

  it.each([
    {
      driverKind: ProviderDriverKind.make('grok'),
      currentModel: 'grok-build',
      availableModels: ['grok-build'],
    },
    {
      driverKind: ProviderDriverKind.make('cursor'),
      currentModel: 'auto',
      availableModels: ['auto', 'composer-2'],
    },
  ])('keeps the current model for $driverKind', (input) =>
  {
    expect(resolveProviderSwitchCompactionModel(input)).toBe(input.currentModel)
  })

  it('falls back to the current model when the candidate is absent', () =>
  {
    expect(
      resolveProviderSwitchCompactionModel({
        driverKind: ProviderDriverKind.make('claudeAgent'),
        currentModel: 'claude-opus-5',
        availableModels: ['claude-opus-5'],
      }),
    ).toBe('claude-opus-5')
  })

  it('preserves the Codex compaction candidate', () =>
  {
    expect(
      resolveProviderSwitchCompactionModel({
        driverKind: ProviderDriverKind.make('codex'),
        currentModel: 'gpt-5.6-sol',
        availableModels: ['gpt-5.6-sol', 'gpt-5.6-luna'],
      }),
    ).toBe('gpt-5.6-luna')
  })
})

describe('provider switch handoff', () =>
{
  // soft product pin for handoff topics — wording edits here are intentional contract changes
  it('keeps the successor handoff topic contract', () =>
  {
    expect(PROVIDER_SWITCH_COMPACTION_PROMPT).toEqual(
      [
        'Produce a complete handoff summary for a successor agent.',
        'Intent and decisions: state the user goal, constraints, and decisions.',
        'Workspace: state the current working directory and repo state, including branch and an uncommitted-change summary.',
        'Open requests: include pending approvals or user-input requests and their exact content.',
        'Execution: include in-flight or recently failed tool calls and their outcomes.',
        'Plan and mode: state whether the proposed plan is accepted or pending, plus the current interaction and runtime modes.',
        'Completed effects: list completed work and files changed; explicitly instruct the successor not to redo completed work.',
        'Next work: state unresolved work and distinguish proposed actions from completed tool effects.',
        'Return only the handoff summary.',
      ].join(' '),
    )
  })

  it('does not prepend again after a failed turn on the same persisted provider session', () =>
  {
    const session = providerSession('session-1')
    const firstSend = prepareProviderInputWithHandoff({
      messageText: 'continue the implementation',
      pendingHandoff,
      activities: [],
      session,
    })
    expect(firstSend.providerInput?.match(/<prior-conversation-handoff/g)).toHaveLength(1)
    expect(firstSend.deliveryMarker).toBeDefined()

    const persistedActivity = JSON.parse(
      JSON.stringify({
        kind: 'provider.handoff.delivered',
        payload: {
          type: 'provider.handoff.delivered',
          ...firstSend.deliveryMarker,
        },
      }),
    ) as Pick<OrchestrationThreadActivity, 'kind' | 'payload'>
    const retryOnSameSession = prepareProviderInputWithHandoff({
      messageText: 'retry after failure',
      pendingHandoff,
      activities: [persistedActivity],
      session,
    })
    expect(retryOnSameSession.providerInput).toBe('retry after failure')
    expect(retryOnSameSession.deliveryMarker).toBeUndefined()

    const retryOnFreshSession = prepareProviderInputWithHandoff({
      messageText: 'retry after session loss',
      pendingHandoff,
      activities: [persistedActivity],
      session: providerSession('session-2'),
    })
    expect(retryOnFreshSession.providerInput?.match(/<prior-conversation-handoff/g)).toHaveLength(1)
    expect(retryOnFreshSession.deliveryMarker).toBeDefined()
  })

  it('deduplicates handoff delivery across compatible configured instances', () =>
  {
    const crossInstanceHandoff = {
      text: 'Continue from the durable summary.',
      fromInstanceId: ProviderInstanceId.make('codex-a'),
      fromModel: 'gpt-5-codex',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const continuationIdentity = {
      driverKind: ProviderDriverKind.make('codex'),
      continuationKey: 'codex:home:/shared-codex',
    }
    const session = (instanceId: string): ProviderSession => ({
      provider: ProviderDriverKind.make('codex'),
      providerInstanceId: ProviderInstanceId.make(instanceId),
      status: 'ready',
      runtimeMode: 'full-access',
      threadId: ThreadId.make('thread-handoff-identity'),
      resumeCursor: { sessionId: 'native-session-1' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const first = prepareProviderInputWithHandoff({
      messageText: 'Continue.',
      pendingHandoff: crossInstanceHandoff,
      activities: [],
      session: session('codex-a'),
      continuationIdentity,
    })
    expect(first.deliveryMarker).toBeDefined()
    const retried = prepareProviderInputWithHandoff({
      messageText: 'Continue.',
      pendingHandoff: crossInstanceHandoff,
      activities: [
        {
          kind: 'provider.handoff.delivered',
          payload: { type: 'provider.handoff.delivered', ...first.deliveryMarker },
        },
      ],
      session: session('codex-b'),
      continuationIdentity,
    })

    expect(retried).toEqual({ providerInput: 'Continue.', deliveryMarker: undefined })
  })
})
