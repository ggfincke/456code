// tests/apps/mobile/features/threads/sidebar/threadListV2.test.ts
// verifies mobile thread list ordering and status presentation
import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import { threadSearchMatchKey } from '@t3tools/client-runtime/state/thread-search'
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  buildThreadListV2Items,
  resolveThreadListV2Presentation,
  resolveThreadListV2Status,
  sortThreadsForListV2,
} from '../../../../../../apps/mobile/src/features/threads/sidebar/threadListV2'
import { canPinThread } from '../../../../../../apps/mobile/src/features/threads/thread-list-pinning'

const environmentId = EnvironmentId.make('environment-1')

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, 'id' | 'title'>,
): EnvironmentThreadShell
{
  return {
    providerSwitch: null,
    environmentId,
    projectId: ProjectId.make('project-1'),
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
    origin: input.origin ?? null,
  }
}

const NOW = '2026-06-02T00:00:00.000Z'

describe('resolveThreadListV2Status', () =>
{
  it('prioritizes approval over a running session', () =>
  {
    const thread = makeThread({
      id: ThreadId.make('t'),
      title: 't',
      hasPendingApprovals: true,
      session: {
        threadId: ThreadId.make('t'),
        status: 'running',
        providerName: 'Codex',
        providerInstanceId: ProviderInstanceId.make('codex'),
        runtimeMode: 'full-access',
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    })
    expect(resolveThreadListV2Status(thread)).toBe('approval')
  })

  it('resolves ready for quiescent threads', () =>
  {
    expect(resolveThreadListV2Status(makeThread({ id: ThreadId.make('t'), title: 't' }))).toBe(
      'ready',
    )
  })

  it('lets a retained outbox failure override status, subtitle, and accessibility', () =>
  {
    const thread = makeThread({
      id: ThreadId.make('queued-failure'),
      title: 'Deploy release',
      hasPendingApprovals: true,
      session: {
        threadId: ThreadId.make('queued-failure'),
        status: 'running',
        providerName: 'Codex',
        providerInstanceId: ProviderInstanceId.make('codex'),
        runtimeMode: 'full-access',
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    })

    expect(
      resolveThreadListV2Presentation(
        thread,
        'The queued message timed out.',
        'Deploy release, pull request 42 open',
      ),
    ).toEqual({
      status: 'failed',
      failureReason: 'The queued message timed out.',
      accessibilityLabel:
        'Deploy release, pull request 42 open, failed: The queued message timed out.',
    })
  })
})

describe('sortThreadsForListV2', () =>
{
  it('orders by creation time, newest first, ignoring activity', () =>
  {
    const sorted = sortThreadsForListV2([
      { id: 'oldest', createdAt: '2026-06-01T08:00:00.000Z' },
      { id: 'newest', createdAt: '2026-06-01T12:00:00.000Z' },
      { id: 'middle', createdAt: '2026-06-01T10:00:00.000Z' },
    ])
    expect(sorted.map((thread) => thread.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('surfaces a reactivated thread and sinks malformed timestamps', () =>
  {
    const sorted = sortThreadsForListV2([
      {
        id: 'old-reactivated',
        createdAt: '2026-06-01T08:00:00.000Z',
        unsettledAt: '2026-06-01T13:00:00.000Z',
      },
      { id: 'newest', createdAt: '2026-06-01T12:00:00.000Z' },
      { id: 'malformed', createdAt: 'invalid', unsettledAt: 'also-invalid' },
    ])
    expect(sorted.map((thread) => thread.id)).toEqual(['old-reactivated', 'newest', 'malformed'])
  })
})

describe('buildThreadListV2Items', () =>
{
  it('adds scoped content matches without duplicates or changing reentry and settled order', () =>
  {
    const title = makeThread({
      id: ThreadId.make('title'),
      title: 'Needle title',
      createdAt: '2026-06-01T12:00:00.000Z',
    })
    const content = makeThread({
      id: ThreadId.make('content'),
      title: 'Different name',
      unsettledAt: '2026-06-01T13:00:00.000Z',
    })
    const settled = makeThread({
      id: ThreadId.make('settled'),
      title: 'Finished',
      settledOverride: 'settled',
      settledAt: '2026-06-01T15:00:00.000Z',
    })
    const remoteCollision = { ...content, environmentId: EnvironmentId.make('remote') }
    const threads = [title, settled, remoteCollision, content]
    const matchedThreadKeys = new Set(
      [title, content, settled].map((thread) =>
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      ),
    )
    const input = {
      threads,
      environmentId: null,
      searchQuery: 'needle',
      matchedThreadKeys,
      now: NOW,
    }
    const layout = buildThreadListV2Items(input)
    expect(layout.items.map((item) => item.thread)).toEqual([content, title, settled])
    expect(layout.items.map((item) => item.variant)).toEqual(['card', 'card', 'slim'])
    expect(
      buildThreadListV2Items({ ...input, matchedThreadKeys: new Set() }).items.map(
        (item) => item.thread,
      ),
    ).toEqual([title])
    expect(buildThreadListV2Items({ ...input, searchQuery: '' })).toEqual(
      buildThreadListV2Items({ threads, environmentId: null, searchQuery: '', now: NOW }),
    )
  })

  it('hides snoozed threads and counts them — visibility parity with web', () =>
  {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make('active'), title: 'Active' }),
        makeThread({
          id: ThreadId.make('snoozed'),
          title: 'Snoozed',
          snoozedUntil: '2026-06-03T09:00:00.000Z',
          snoozedAt: '2026-06-01T12:00:00.000Z',
        }),
        makeThread({
          id: ThreadId.make('woken'),
          title: 'Woken',
          // wake time already passed: back in the active list.
          snoozedUntil: '2026-06-01T18:00:00.000Z',
          snoozedAt: '2026-06-01T12:00:00.000Z',
        }),
      ],
      environmentId: null,
      searchQuery: '',
      now: NOW,
    })

    // same createdAt -> static sort tiebreaks by id; the point is the woken
    // thread is BACK in the card block and the snoozed one is gone.
    expect(layout.items.map((item) => item.thread.id)).toEqual(['active', 'woken'])
    expect(layout.snoozedCount).toBe(1)
  })

  it('renders pinned threads first and exempts them from settlement', () =>
  {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make('active'), title: 'Active' }),
        makeThread({
          id: ThreadId.make('pinned-settled'),
          title: 'Pinned while settled',
          pinnedAt: '2026-06-01T12:00:00.000Z',
          settledOverride: 'settled',
          settledAt: '2026-06-01T12:00:00.000Z',
        }),
      ],
      environmentId: null,
      searchQuery: '',
      now: NOW,
    })

    expect(layout.items.map((item) => item.thread.id)).toEqual(['pinned-settled', 'active'])
    expect(layout.items.map((item) => item.pinned)).toEqual([true, false])
    expect(layout.items.map((item) => item.variant)).toEqual(['card', 'card'])
    expect(layout.hiddenSettledCount).toBe(0)
  })

  it('keeps imported history-only threads out of pin actions and the pinned block', () =>
  {
    const imported = makeThread({
      id: ThreadId.make('imported-pinned'),
      title: 'Imported history',
      pinnedAt: '2026-06-01T12:00:00.000Z',
      origin: {
        kind: 'imported',
        source: 'codex-cli',
        sourcePath: '/tmp/session.jsonl',
        contentHash: 'hash',
        nativeSessionId: null,
        providerInstanceId: null,
        importedAt: '2026-06-01T11:00:00.000Z',
      },
    })

    expect(canPinThread(imported, true)).toBe(false)
    expect(
      buildThreadListV2Items({
        threads: [imported],
        environmentId: null,
        searchQuery: '',
        now: NOW,
      }).items.map((item) => ({ id: item.thread.id, pinned: item.pinned })),
    ).toEqual([{ id: imported.id, pinned: false }])
  })

  it('hides a snoozed pinned thread and restores it to the pinned block after wake', () =>
  {
    const threads = [
      makeThread({ id: ThreadId.make('active'), title: 'Active' }),
      makeThread({
        id: ThreadId.make('pinned-snoozed'),
        title: 'Pinned and snoozed',
        pinnedAt: '2026-06-01T12:00:00.000Z',
        snoozedUntil: '2026-06-03T09:00:00.000Z',
        snoozedAt: '2026-06-01T11:00:00.000Z',
      }),
    ]

    const whileSnoozed = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: '',
      now: NOW,
    })
    expect(whileSnoozed.items.map((item) => item.thread.id)).toEqual(['active'])
    expect(whileSnoozed.snoozedCount).toBe(1)

    const afterWake = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: '',
      now: '2026-06-03T10:00:00.000Z',
    })
    expect(afterWake.items.map((item) => item.thread.id)).toEqual(['pinned-snoozed', 'active'])
    expect(afterWake.items[0]?.pinned).toBe(true)
    expect(afterWake.snoozedCount).toBe(0)
  })

  it('classifies snooze with the second-precise clock and reports the next wake', () =>
  {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make('just-woke'),
          title: 'Just woke',
          // woke 30s ago: hidden under the minute-floored clock, visible
          // under the precise one.
          snoozedUntil: '2026-06-02T00:00:30.000Z',
          snoozedAt: '2026-06-01T12:00:00.000Z',
        }),
        makeThread({
          id: ThreadId.make('still-snoozed'),
          title: 'Still snoozed',
          snoozedUntil: '2026-06-02T09:00:00.000Z',
          snoozedAt: '2026-06-01T12:00:00.000Z',
        }),
      ],
      environmentId: null,
      searchQuery: '',
      // minute-floored partition clock vs precise snooze clock.
      now: '2026-06-02T00:01:00.000Z',
      snoozeNow: '2026-06-02T00:01:07.500Z',
    })

    expect(layout.items.map((item) => item.thread.id)).toEqual(['just-woke'])
    expect(layout.snoozedCount).toBe(1)
    expect(layout.nextSnoozeWakeAt).toBe('2026-06-02T09:00:00.000Z')
  })

  it('keeps snoozed threads visible on environments without the snooze capability', () =>
  {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make('snoozed'),
          title: 'Snoozed',
          snoozedUntil: '2026-06-03T09:00:00.000Z',
          snoozedAt: '2026-06-01T12:00:00.000Z',
        }),
      ],
      environmentId: null,
      searchQuery: '',
      snoozeEnvironmentIds: new Set(),
      now: NOW,
    })

    expect(layout.items.map((item) => item.thread.id)).toEqual(['snoozed'])
    expect(layout.snoozedCount).toBe(0)
  })

  it('partitions settled threads into a slim tail with one divider', () =>
  {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make('active'), title: 'Active' }),
        makeThread({
          id: ThreadId.make('settled'),
          title: 'Settled',
          settledOverride: 'settled',
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make('settled-2'),
          title: 'Settled 2',
          settledOverride: 'settled',
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: '',
      now: NOW,
    })

    expect(items.map((item) => [item.thread.id, item.variant])).toEqual([
      ['active', 'card'],
      ['settled', 'slim'],
      ['settled-2', 'slim'],
    ])
    expect(items.map((item) => item.showSettledDivider)).toEqual([false, true, false])
    expect(items.map((item) => item.isLast)).toEqual([false, false, true])
  })

  it('keeps merged threads active when merge auto-settle is disabled but still settles closed threads', () =>
  {
    const activityAt = '2026-06-01T20:00:00.000Z'
    const makeIdleTerminalThread = (id: 'merged' | 'closed') =>
      makeThread({
        id: ThreadId.make(id),
        title: id,
        latestUserMessageAt: activityAt,
        latestTurn: {
          turnId: TurnId.make(`${id}-turn`),
          state: 'completed',
          requestedAt: activityAt,
          startedAt: activityAt,
          completedAt: activityAt,
          assistantMessageId: null,
        },
      })
    const { items } = buildThreadListV2Items({
      threads: [makeIdleTerminalThread('merged'), makeIdleTerminalThread('closed')],
      environmentId: null,
      searchQuery: '',
      changeRequestStateByKey: new Map([
        [`${environmentId}:merged`, 'merged'],
        [`${environmentId}:closed`, 'closed'],
      ]),
      autoSettleOnMerge: false,
      now: NOW,
    })

    expect(items.map((item) => [item.thread.id, item.variant])).toEqual([
      ['merged', 'card'],
      ['closed', 'slim'],
    ])
  })

  it('keeps cards in creation order while settled sorts by recency', () =>
  {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make('older-created'),
          title: 'Older',
          createdAt: '2026-06-01T08:00:00.000Z',
          // recent activity must NOT promote it
          updatedAt: NOW,
        }),
        makeThread({
          id: ThreadId.make('newer-created'),
          title: 'Newer',
          createdAt: '2026-06-01T12:00:00.000Z',
        }),
      ],
      environmentId: null,
      searchQuery: '',
      now: NOW,
    })

    expect(items.map((item) => item.thread.id)).toEqual(['newer-created', 'older-created'])
  })

  it('keeps settled threads in the tail and filters by search query', () =>
  {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make('match'), title: 'Fix login bug' }),
        makeThread({ id: ThreadId.make('miss'), title: 'Greeting' }),
        makeThread({
          id: ThreadId.make('settled'),
          title: 'Fix login again',
          settledOverride: 'settled',
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: 'login',
      now: NOW,
    })

    expect(items.map((item) => [item.thread.id, item.variant])).toEqual([
      ['match', 'card'],
      ['settled', 'slim'],
    ])
  })

  it('scopes the flat list to one project', () =>
  {
    const otherProjectId = ProjectId.make('project-2')
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make('included'), title: 'Included' }),
        makeThread({
          id: ThreadId.make('excluded'),
          projectId: otherProjectId,
          title: 'Excluded',
        }),
      ],
      environmentId: null,
      projectRefs: [{ environmentId, projectId: ProjectId.make('project-1') }],
      searchQuery: '',
      now: NOW,
    })

    expect(items.map((item) => item.thread.id)).toEqual(['included'])
  })

  it('scopes the flat list to every environment member of a logical project', () =>
  {
    const remoteEnvironmentId = EnvironmentId.make('environment-remote')
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make('local'), title: 'Local' }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make('remote'),
          title: 'Remote',
        }),
      ],
      environmentId: null,
      projectRefs: [
        { environmentId, projectId: ProjectId.make('project-1') },
        { environmentId: remoteEnvironmentId, projectId: ProjectId.make('project-1') },
      ],
      searchQuery: '',
      now: NOW,
    })

    expect(items.map((item) => item.thread.id)).toEqual(['local', 'remote'])
  })
})

describe('buildThreadListV2Items settled paging', () =>
{
  it('caps the settled tail at settledLimit and reports the hidden count', () =>
  {
    const threads = [
      makeThread({ id: ThreadId.make('active'), title: 'Active' }),
      ...Array.from({ length: 4 }, (_, index) =>
        makeThread({
          id: ThreadId.make(`settled-${index}`),
          title: `Settled ${index}`,
          settledOverride: 'settled',
          settledAt: NOW,
          latestUserMessageAt: `2026-06-01T0${index}:00:00.000Z`,
          // a turn adopted the message (same requestedAt): without it the
          // thread reads as a queued turn start, which never settles.
          latestTurn: {
            turnId: TurnId.make(`turn-${index}`),
            state: 'completed',
            requestedAt: `2026-06-01T0${index}:00:00.000Z`,
            startedAt: `2026-06-01T0${index}:00:00.000Z`,
            completedAt: `2026-06-01T0${index}:10:00.000Z`,
            assistantMessageId: null,
          },
        }),
      ),
    ]

    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: '',
      settledLimit: 2,
      now: NOW,
    })

    expect(layout.hiddenSettledCount).toBe(2)
    expect(layout.items.filter((item) => item.variant === 'slim')).toHaveLength(2)
    // most recent settled first — the hidden ones are the oldest.
    expect(layout.items.map((item) => item.thread.id)).toEqual(['active', 'settled-3', 'settled-2'])
  })
})
