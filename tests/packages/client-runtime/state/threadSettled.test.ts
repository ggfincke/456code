// tests/packages/client-runtime/state/threadSettled.test.ts
// verifies thread settlement state transitions

import {
  ApprovalRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  canSettle,
  changeRequestAutoSettles,
  effectiveSettled,
  hasQueuedTurnStart,
  threadLastActivityAt,
  type ChangeRequestStateLike,
} from '../../../../packages/client-runtime/src/state/threadSettled.ts'

const NOW = '2026-04-10T00:00:00.000Z'
const FRESH = '2026-04-09T00:00:00.000Z'
const STALE = '2026-04-06T23:59:59.999Z'

describe('changeRequestAutoSettles', () =>
{
  it.each([
    ['open', true, false],
    ['merged', true, true],
    ['merged', false, false],
    ['closed', false, true],
  ] as const)('state=%s autoSettleOnMerge=%s returns %s', (state, enabled, expected) =>
  {
    expect(changeRequestAutoSettles({ state }, { autoSettleOnMerge: enabled })).toBe(expected)
  })
})

function makeShell(input: {
  readonly settledOverride?: 'settled' | 'active' | null
  readonly activityAt: string | null
  readonly sessionStatus?: 'starting' | 'running'
  readonly pending?: 'approval' | 'user-input'
  readonly approvalStatus?: 'responding' | 'unknown'
}): OrchestrationThreadShell
{
  const threadId = ThreadId.make('thread-1')
  return {
    id: threadId,
    projectId: ProjectId.make('project-1'),
    title: 'Thread',
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn:
      input.activityAt === null
        ? null
        : {
            turnId: TurnId.make('turn-1'),
            state: 'completed',
            requestedAt: input.activityAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
    providerSwitch: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: NOW,
    archivedAt: null,
    origin: null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledOverride === 'settled' ? NOW : null,
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: 'Codex',
            runtimeMode: 'full-access',
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
    latestUserMessageAt: null,
    hasPendingApprovals: input.pending === 'approval',
    hasPendingUserInput: input.pending === 'user-input',
    hasActionableProposedPlan: false,
    ...(input.approvalStatus === undefined
      ? {}
      : {
          approvalOutcomes: [
            {
              requestId: ApprovalRequestId.make('approval-1'),
              status: input.approvalStatus,
              decision: null,
              updatedAt: NOW,
            },
          ],
        }),
  }
}

describe('threadLastActivityAt', () =>
{
  it('returns the latest real user or turn activity and ignores thread/session updates', () =>
  {
    const shell = makeShell({ activityAt: null, sessionStatus: 'running' })
    const withActivity: OrchestrationThreadShell = {
      ...shell,
      latestUserMessageAt: '2026-04-04T00:00:00.000Z',
      latestTurn: {
        turnId: TurnId.make('turn-1'),
        state: 'completed',
        requestedAt: '2026-04-03T00:00:00.000Z',
        startedAt: '2026-04-05T00:00:00.000Z',
        completedAt: '2026-04-06T00:00:00.000Z',
        assistantMessageId: null,
      },
    }

    expect(threadLastActivityAt(withActivity)).toBe('2026-04-06T00:00:00.000Z')
    expect(threadLastActivityAt(shell)).toBeNull()
  })
})

describe('effectiveSettled', () =>
{
  const truthTable = [
    {
      label: 'override settled with no blockers',
      settledOverride: 'settled' as const,
      changeRequestState: undefined,
      activityAt: FRESH,
      running: false,
      pending: undefined,
      expected: true,
    },
    {
      label: 'active pin suppresses merged PR auto-settle',
      settledOverride: 'active' as const,
      changeRequestState: 'merged' as const,
      activityAt: STALE,
      running: false,
      pending: undefined,
      expected: false,
    },
    {
      label: 'active pin suppresses stale inactivity auto-settle',
      settledOverride: 'active' as const,
      changeRequestState: undefined,
      activityAt: STALE,
      running: false,
      pending: undefined,
      expected: false,
    },
    {
      label: 'merged PR auto-settles when unblocked',
      settledOverride: null,
      changeRequestState: 'merged' as const,
      activityAt: FRESH,
      running: false,
      pending: undefined,
      expected: true,
    },
    {
      label: 'stale inactivity auto-settles without CR signal',
      settledOverride: null,
      changeRequestState: undefined,
      activityAt: STALE,
      running: false,
      pending: undefined,
      expected: true,
    },
    {
      label: 'fresh activity stays active without override or CR',
      settledOverride: null,
      changeRequestState: undefined,
      activityAt: FRESH,
      running: false,
      pending: undefined,
      expected: false,
    },
    {
      label: 'running session blocks settled override',
      settledOverride: 'settled' as const,
      changeRequestState: undefined,
      activityAt: STALE,
      running: true,
      pending: undefined,
      expected: false,
    },
    {
      label: 'pending approval blocks auto-settle',
      settledOverride: null,
      changeRequestState: 'merged' as const,
      activityAt: STALE,
      running: false,
      pending: 'approval' as const,
      expected: false,
    },
    {
      label: 'pending user-input blocks settled override',
      settledOverride: 'settled' as const,
      changeRequestState: undefined,
      activityAt: FRESH,
      running: false,
      pending: 'user-input' as const,
      expected: false,
    },
    {
      label: 'open CR with stale activity stays active',
      settledOverride: null,
      changeRequestState: 'open' as const,
      activityAt: STALE,
      running: false,
      pending: undefined,
      expected: false,
    },
    {
      label: 'no activity without CR or override stays active',
      settledOverride: null,
      changeRequestState: undefined,
      activityAt: null,
      running: false,
      pending: undefined,
      expected: false,
    },
  ] as const

  it.each(truthTable)(
    '$label',
    ({ settledOverride, changeRequestState, activityAt, running, pending, expected }) =>
    {
      const shell = makeShell({
        settledOverride,
        activityAt,
        ...(running ? { sessionStatus: 'running' as const } : {}),
        ...(pending === undefined ? {} : { pending }),
      })
      const changeRequestOptions =
        changeRequestState === undefined
          ? {}
          : { changeRequest: { state: changeRequestState as ChangeRequestStateLike } }

      expect(
        effectiveSettled(shell, {
          now: NOW,
          autoSettleAfterDays: 3,
          ...changeRequestOptions,
        }),
      ).toBe(expected)
    },
  )

  it('treats closed change requests like merged ones', () =>
  {
    const shell = makeShell({ activityAt: null })
    expect(
      effectiveSettled(shell, {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequest: { state: 'closed' },
      }),
    ).toBe(true)
  })

  it('does not re-settle a warm thread on the merge signal: a message sent in a settled thread keeps it active until idle', () =>
  {
    // the merge signal never clears, so without the idle guard a follow-up
    // message would un-settle the row only until its turn completed, then
    // snap straight back into the settled tail.
    const justActive = makeShell({ activityAt: '2026-04-09T23:30:00.000Z' })
    // the idle gate is strict: activity exactly one hour old is still warm.
    const boundary = makeShell({ activityAt: '2026-04-09T23:00:00.000Z' })
    const idle = makeShell({ activityAt: '2026-04-09T22:59:59.999Z' })

    for (const changeRequestState of ['merged', 'closed'] as const)
    {
      expect(
        effectiveSettled(justActive, {
          now: NOW,
          autoSettleAfterDays: null,
          changeRequest: { state: changeRequestState },
        }),
      ).toBe(false)
      expect(
        effectiveSettled(boundary, {
          now: NOW,
          autoSettleAfterDays: null,
          changeRequest: { state: changeRequestState },
        }),
      ).toBe(false)
      expect(
        effectiveSettled(idle, {
          now: NOW,
          autoSettleAfterDays: null,
          changeRequest: { state: changeRequestState },
        }),
      ).toBe(true)
    }
  })

  it('re-settles a terminal-PR follow-up after one hour for state-only and timestamp inputs', () =>
  {
    const shell = makeShell({ activityAt: '2026-04-09T23:30:00.000Z' })
    const changeRequestInputs = [
      { changeRequestState: 'merged' as const },
      {
        changeRequest: {
          state: 'merged' as const,
          // the terminal observation predates the follow-up, as web snapshots commonly do.
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      },
    ]

    for (const changeRequestInput of changeRequestInputs)
    {
      const options = { autoSettleAfterDays: null, ...changeRequestInput }
      expect(effectiveSettled(shell, { ...options, now: NOW })).toBe(false)
      expect(effectiveSettled(shell, { ...options, now: '2026-04-10T00:30:00.001Z' })).toBe(true)
    }
  })

  it('can keep an idle merged PR active without disabling closed-PR settling', () =>
  {
    const idle = makeShell({ activityAt: '2026-04-09T22:59:59.999Z' })
    const options = { now: NOW, autoSettleAfterDays: null, autoSettleOnMerge: false }

    expect(effectiveSettled(idle, { ...options, changeRequest: { state: 'merged' } })).toBe(false)
    expect(effectiveSettled(idle, { ...options, changeRequest: { state: 'closed' } })).toBe(true)
  })

  it('never settles a starting session, even with a settled override', () =>
  {
    const shell = makeShell({
      settledOverride: 'settled',
      activityAt: STALE,
      sessionStatus: 'starting',
    })
    expect(
      effectiveSettled(shell, {
        now: NOW,
        autoSettleAfterDays: 3,
        changeRequest: { state: 'merged' },
      }),
    ).toBe(false)
  })

  it.each(['responding', 'unknown'] as const)(
    'blocks settling for %s outcomes even when the shell pending flag is clear',
    (approvalStatus) =>
    {
      const shell = makeShell({
        settledOverride: 'settled',
        activityAt: STALE,
        approvalStatus,
      })

      expect(shell.hasPendingApprovals).toBe(false)
      expect(canSettle(shell, { now: NOW })).toBe(false)
      expect(
        effectiveSettled(shell, {
          now: NOW,
          autoSettleAfterDays: 3,
          changeRequest: { state: 'merged' },
        }),
      ).toBe(false)
    },
  )

  it('keeps a new turn active from queued through starting and running', () =>
  {
    const requestedAt = '2026-04-09T12:00:00.000Z'
    const transitionNow = '2026-04-09T12:00:30.000Z'
    const base = makeShell({
      settledOverride: null,
      activityAt: STALE,
    })
    const queued: OrchestrationThreadShell = {
      ...base,
      latestUserMessageAt: requestedAt,
      latestTurn: null,
      session: null,
    }
    const starting: OrchestrationThreadShell = {
      ...queued,
      session: {
        threadId: queued.id,
        status: 'starting',
        providerName: 'Codex',
        runtimeMode: 'full-access',
        activeTurnId: null,
        lastError: null,
        updatedAt: requestedAt,
      },
    }
    const running: OrchestrationThreadShell = {
      ...starting,
      session: {
        ...starting.session!,
        status: 'running',
        activeTurnId: TurnId.make('turn-new'),
      },
    }

    for (const shell of [queued, starting, running])
    {
      expect(
        effectiveSettled(shell, {
          now: transitionNow,
          autoSettleAfterDays: 3,
          changeRequest: { state: 'merged' },
        }),
      ).toBe(false)
    }
  })

  it('uses a strict inactivity boundary and honors a null threshold', () =>
  {
    const boundary = makeShell({
      activityAt: '2026-04-07T00:00:00.000Z',
    })
    const stale = makeShell({ activityAt: STALE })

    expect(effectiveSettled(boundary, { now: NOW, autoSettleAfterDays: 3 })).toBe(false)
    expect(effectiveSettled(stale, { now: NOW, autoSettleAfterDays: null })).toBe(false)
  })
})

describe('hasQueuedTurnStart', () =>
{
  const QUEUED_AT = '2026-04-09T12:00:00.000Z'
  // within the adoption grace window of the queued message.
  const JUST_AFTER = { now: '2026-04-09T12:00:30.000Z' }

  it('flags a user message no turn has picked up, within the grace window', () =>
  {
    const noTurn = { latestUserMessageAt: QUEUED_AT, latestTurn: null, session: null }
    expect(hasQueuedTurnStart(noTurn, JUST_AFTER)).toBe(true)

    const staleTurn = {
      ...makeShell({ activityAt: FRESH }),
      latestUserMessageAt: QUEUED_AT,
    }
    expect(hasQueuedTurnStart(staleTurn, JUST_AFTER)).toBe(true)
  })

  it('expires after the grace window: an unadopted message is a failed start, not queued work', () =>
  {
    const noTurn = { latestUserMessageAt: QUEUED_AT, latestTurn: null, session: null }
    expect(hasQueuedTurnStart(noTurn, { now: '2026-04-09T12:03:00.000Z' })).toBe(false)
    // historical shells (e.g. from servers that never carried latestTurn)
    // must never read as queued.
    expect(hasQueuedTurnStart(noTurn, { now: NOW })).toBe(false)
  })

  it('clears once a turn adopts the message or the start fails', () =>
  {
    const adopted = {
      ...makeShell({ activityAt: QUEUED_AT }),
      latestUserMessageAt: QUEUED_AT,
    }
    expect(hasQueuedTurnStart(adopted, JUST_AFTER)).toBe(false)

    const failed = makeShell({ activityAt: FRESH })
    const failedShell = {
      ...failed,
      latestUserMessageAt: QUEUED_AT,
      session: {
        threadId: failed.id,
        status: 'error' as const,
        providerName: 'Codex',
        runtimeMode: 'full-access' as const,
        activeTurnId: null,
        lastError: 'boom',
        updatedAt: NOW,
      },
    }
    expect(hasQueuedTurnStart(failedShell, JUST_AFTER)).toBe(false)
  })

  it('is quiet without user messages', () =>
  {
    expect(hasQueuedTurnStart(makeShell({ activityAt: FRESH }), JUST_AFTER)).toBe(false)
  })

  it('bounds the grace window in both directions: a future-stamped message is skew, not queued work', () =>
  {
    // message timestamps originate on other devices; a clock an hour ahead
    // must not hold the queued state for the whole skew.
    const skewed = {
      latestUserMessageAt: '2026-04-09T13:00:00.000Z',
      latestTurn: null,
      session: null,
    }
    expect(hasQueuedTurnStart(skewed, { now: '2026-04-09T12:00:00.000Z' })).toBe(false)
    // a small negative age (within the grace window) still reads as queued.
    const slightlyAhead = {
      latestUserMessageAt: '2026-04-09T12:00:30.000Z',
      latestTurn: null,
      session: null,
    }
    expect(hasQueuedTurnStart(slightlyAhead, { now: '2026-04-09T12:00:00.000Z' })).toBe(true)
  })
})

describe('canSettle', () =>
{
  it('allows settling when no activity blockers hold', () =>
  {
    expect(canSettle(makeShell({ activityAt: FRESH }), { now: NOW })).toBe(true)
  })

  it.each([
    ['a starting session', { sessionStatus: 'starting' as const }],
    ['a running session', { sessionStatus: 'running' as const }],
    ['a pending approval', { pending: 'approval' as const }],
    ['pending user input', { pending: 'user-input' as const }],
  ])('blocks settling for %s', (_label, blocker) =>
  {
    expect(canSettle(makeShell({ activityAt: FRESH, ...blocker }), { now: NOW })).toBe(false)
  })

  it('blocks settling a queued turn start, only within the grace window', () =>
  {
    const queued = {
      ...makeShell({ activityAt: FRESH }),
      latestUserMessageAt: '2026-04-09T12:00:00.000Z',
    }
    const justAfter = '2026-04-09T12:00:30.000Z'
    expect(canSettle(queued, { now: justAfter })).toBe(false)
    // effectiveSettled must agree: queued work never auto-settles either,
    // even with a merged PR.
    expect(
      effectiveSettled(queued, {
        now: justAfter,
        autoSettleAfterDays: 3,
        changeRequest: { state: 'merged' },
      }),
    ).toBe(false)
    // past the window the message is a failed/stale start: settleable again.
    expect(canSettle(queued, { now: NOW })).toBe(true)
  })

  it('lets a server-accepted settle overrule the clock-derived queued blocker', () =>
  {
    // the settle action ran with wall-clock `now` (past the grace window);
    // the list partition re-evaluates with a minute-floored `now` that is
    // still INSIDE the window. settledAt >= message time proves the server
    // already adjudicated this exact message, so the row must not snap back
    // to active until the coarser clock catches up.
    const messageAt = '2026-04-09T12:00:00.000Z'
    const flooredNow = '2026-04-09T12:01:00.000Z'
    const base = makeShell({ settledOverride: 'settled', activityAt: null })
    const settledAfterMessage = {
      ...base,
      latestUserMessageAt: messageAt,
      settledAt: '2026-04-09T12:02:10.000Z',
    }
    expect(hasQueuedTurnStart(settledAfterMessage, { now: flooredNow })).toBe(true)
    expect(effectiveSettled(settledAfterMessage, { now: flooredNow, autoSettleAfterDays: 3 })).toBe(
      true,
    )

    // a message NEWER than settledAt is genuinely new work: still blocked
    // until the server's auto-unsettle lands.
    const messageAfterSettle = {
      ...base,
      latestUserMessageAt: '2026-04-09T12:03:00.000Z',
      settledAt: '2026-04-09T12:02:10.000Z',
    }
    expect(
      effectiveSettled(messageAfterSettle, {
        now: '2026-04-09T12:03:30.000Z',
        autoSettleAfterDays: 3,
      }),
    ).toBe(false)
  })
})
