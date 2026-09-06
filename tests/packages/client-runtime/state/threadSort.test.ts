// tests/packages/client-runtime/state/threadSort.test.ts
// verify sort threads behavior

import { describe, expect, it } from 'vite-plus/test'

import { ProjectId } from '@t3tools/contracts'

import {
  activeThreadAnchorTimestampMs,
  getLatestThreadForProject,
  planActiveThreadMove,
  planActiveThreadReorder,
  sortActiveThreadsByOrderKey,
  sortThreads,
  type ThreadSortInput,
} from '../../../../packages/client-runtime/src/state/threadSort.ts'

type TestThread = { readonly id: string } & ThreadSortInput

type ProjectThread = TestThread & {
  readonly projectId: ProjectId
  readonly archivedAt: string | null
}

const PROJECT_ID = ProjectId.make('project-1')

describe('activeThreadAnchorTimestampMs', () =>
{
  it('uses the newest valid creation or re-entry timestamp', () =>
  {
    expect(
      activeThreadAnchorTimestampMs({
        createdAt: '2026-03-09T10:00:00.000Z',
        unsettledAt: '2026-03-09T12:00:00.000Z',
      }),
    ).toBe(Date.parse('2026-03-09T12:00:00.000Z'))
    expect(
      activeThreadAnchorTimestampMs({
        createdAt: '2026-03-09T10:00:00.000Z',
        unsettledAt: 'malformed',
      }),
    ).toBe(Date.parse('2026-03-09T10:00:00.000Z'))
    expect(activeThreadAnchorTimestampMs({ createdAt: 'malformed', unsettledAt: null })).toBe(
      Number.NEGATIVE_INFINITY,
    )
    expect(
      activeThreadAnchorTimestampMs({ createdAt: '1960-01-01T00:00:00.000Z', unsettledAt: null }),
    ).toBe(Date.parse('1960-01-01T00:00:00.000Z'))
  })
})

function makeThread(overrides: Partial<TestThread> = {}): TestThread
{
  return {
    id: 'thread-1',
    createdAt: '2026-03-09T10:00:00.000Z',
    updatedAt: '2026-03-09T10:00:00.000Z',
    messages: [],
    latestUserMessageAt: null,
    ...overrides,
  }
}

function makeProjectThread(overrides: Partial<ProjectThread> = {}): ProjectThread
{
  return {
    ...makeThread(),
    projectId: PROJECT_ID,
    archivedAt: null,
    ...overrides,
  }
}

describe('sortThreads', () =>
{
  it('ignores malformed re-entry dates and breaks invalid timestamp ties by id', () =>
  {
    const invalidThread = {
      createdAt: 'invalid-created-at',
      updatedAt: 'invalid-updated-at',
      latestUserMessageAt: 'invalid-message-at',
      unsettledAt: 'invalid-reentry-at',
    }
    const threads = [
      makeThread({ id: 'invalid-a', ...invalidThread }),
      makeThread({
        id: 'valid',
        createdAt: '1960-01-01T00:00:00.000Z',
        updatedAt: '1960-01-02T00:00:00.000Z',
        unsettledAt: 'invalid-reentry-at',
      }),
      makeThread({ id: 'invalid-z', ...invalidThread }),
    ]

    expect(sortThreads(threads, 'updated_at').map((thread) => thread.id)).toEqual([
      'valid',
      'invalid-z',
      'invalid-a',
    ])
    expect(sortThreads(threads.toReversed(), 'updated_at').map((thread) => thread.id)).toEqual([
      'valid',
      'invalid-z',
      'invalid-a',
    ])
  })

  it('falls back to updatedAt and createdAt when latestUserMessageAt is invalid and there are no messages', () =>
  {
    const sorted = sortThreads(
      [
        makeThread({
          id: 'thread-1',
          latestUserMessageAt: 'not-a-date',
          createdAt: '2026-03-09T10:00:00.000Z',
          updatedAt: '2026-03-09T10:05:00.000Z',
        }),
        makeThread({
          id: 'thread-2',
          latestUserMessageAt: 'still-not-a-date',
          createdAt: 'invalid-created-at',
          updatedAt: 'invalid-updated-at',
        }),
        makeThread({
          id: 'thread-3',
          latestUserMessageAt: 'invalid-latest-user-message-at',
          createdAt: '2026-03-09T10:06:00.000Z',
          updatedAt: 'invalid-updated-at',
        }),
      ],
      'updated_at',
    )

    expect(sorted.map((thread) => thread.id)).toEqual(['thread-3', 'thread-1', 'thread-2'])
  })

  it('falls back to the latest valid user message when latestUserMessageAt is invalid', () =>
  {
    const sorted = sortThreads(
      [
        makeThread({
          id: 'thread-1',
          latestUserMessageAt: 'invalid-latest-user-message-at',
          updatedAt: '2026-03-09T10:00:00.000Z',
          messages: [
            { role: 'user', createdAt: '2026-03-09T10:05:00.000Z' },
            { role: 'assistant', createdAt: '2026-03-09T10:30:00.000Z' },
            { role: 'user', createdAt: '2026-03-09T10:20:00.000Z' },
          ],
        }),
        makeThread({
          id: 'thread-2',
          createdAt: '2026-03-09T10:15:00.000Z',
          updatedAt: '2026-03-09T10:15:00.000Z',
        }),
      ],
      'updated_at',
    )

    expect(sorted.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2'])
  })

  it('sorts threads by the latest user message in recency mode', () =>
  {
    const sorted = sortThreads(
      [
        makeThread({
          id: 'thread-1',
          updatedAt: '2026-03-09T10:10:00.000Z',
          messages: [{ role: 'user', createdAt: '2026-03-09T10:01:00.000Z' }],
        }),
        makeThread({
          id: 'thread-2',
          createdAt: '2026-03-09T10:05:00.000Z',
          updatedAt: '2026-03-09T10:05:00.000Z',
          messages: [{ role: 'user', createdAt: '2026-03-09T10:06:00.000Z' }],
        }),
      ],
      'updated_at',
    )

    expect(sorted.map((thread) => thread.id)).toEqual(['thread-2', 'thread-1'])
  })

  it('falls back to thread timestamps when there is no user message', () =>
  {
    const sorted = sortThreads(
      [
        makeThread({
          id: 'thread-1',
          updatedAt: '2026-03-09T10:01:00.000Z',
          messages: [{ role: 'assistant', createdAt: '2026-03-09T10:02:00.000Z' }],
        }),
        makeThread({
          id: 'thread-2',
          createdAt: '2026-03-09T10:05:00.000Z',
          updatedAt: '2026-03-09T10:05:00.000Z',
          messages: [],
        }),
      ],
      'updated_at',
    )

    expect(sorted.map((thread) => thread.id)).toEqual(['thread-2', 'thread-1'])
  })

  it('falls back to createdAt when updatedAt is invalid', () =>
  {
    const sorted = sortThreads(
      [
        makeThread({
          id: 'thread-1',
          createdAt: '2026-03-09T10:00:00.000Z',
          updatedAt: 'invalid-date',
          messages: [],
        }),
        makeThread({
          id: 'thread-2',
          createdAt: '2026-03-09T09:00:00.000Z',
          updatedAt: '2026-03-09T09:30:00.000Z',
          messages: [],
        }),
      ],
      'updated_at',
    )

    expect(sorted.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2'])
  })

  it('can sort threads by createdAt when configured', () =>
  {
    const sorted = sortThreads(
      [
        makeThread({
          id: 'thread-1',
          createdAt: '2026-03-09T10:05:00.000Z',
          updatedAt: '2026-03-09T10:05:00.000Z',
        }),
        makeThread({
          id: 'thread-2',
          createdAt: '2026-03-09T10:00:00.000Z',
          updatedAt: '2026-03-09T10:10:00.000Z',
        }),
      ],
      'created_at',
    )

    expect(sorted.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2'])
  })

  it('uses updatedAt as a fallback for created_at sorting when createdAt is invalid', () =>
  {
    const sorted = sortThreads(
      [
        makeThread({
          id: 'thread-1',
          createdAt: 'invalid-date',
          updatedAt: '2026-03-09T10:05:00.000Z',
        }),
        makeThread({
          id: 'thread-2',
          createdAt: '2026-03-09T10:00:00.000Z',
          updatedAt: '2026-03-09T10:10:00.000Z',
        }),
      ],
      'created_at',
    )

    expect(sorted.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2'])
  })
})

describe('manual active ordering', () =>
{
  it('keeps new and reopened rows ahead of the arranged run', () =>
  {
    const threads = [
      { id: 'arranged-last', createdAt: '2026-01-03T00:00:00.000Z', activeOrderKey: 't' },
      { id: 'new', createdAt: '2026-01-05T00:00:00.000Z', activeOrderKey: null },
      {
        id: 'reopened',
        createdAt: '2026-01-01T00:00:00.000Z',
        unsettledAt: '2026-01-06T00:00:00.000Z',
        activeOrderKey: null,
      },
      { id: 'arranged-first', createdAt: '2026-01-04T00:00:00.000Z', activeOrderKey: 'f' },
    ]

    expect(sortActiveThreadsByOrderKey(threads).map((thread) => thread.id)).toEqual([
      'reopened',
      'new',
      'arranged-first',
      'arranged-last',
    ])
  })

  it('uses one assignment between keyed neighbors and respects hidden reserved keys', () =>
  {
    const assignments = planActiveThreadReorder({
      orderedIds: ['first', 'moved', 'last'],
      keysById: new Map([
        ['first', 'f'],
        ['moved', null],
        ['last', 't'],
        ['hidden', 'n'],
      ]),
      movedId: 'moved',
    })

    expect(assignments).toHaveLength(1)
    expect(assignments[0]?.id).toBe('moved')
    expect(assignments[0]?.orderKey).not.toBe('n')
    expect(assignments[0]!.orderKey > 'f').toBe(true)
    expect(assignments[0]!.orderKey < 't').toBe(true)
  })

  it('materializes keyless rows once and supports bounded move actions', () =>
  {
    const orderedIds = Array.from({ length: 1_200 }, (_, index) => String(index)).toReversed()
    const keysById = new Map(orderedIds.map((id) => [id, null]))
    const assignments = planActiveThreadReorder({
      orderedIds,
      keysById,
      movedId: orderedIds[0]!,
    })
    const assignedKeys = new Map(
      assignments.map((assignment) => [assignment.id, assignment.orderKey]),
    )
    const sorted = sortActiveThreadsByOrderKey(
      orderedIds.map((id) => ({
        id,
        createdAt: '2026-01-01T00:00:00.000Z',
        activeOrderKey: assignedKeys.get(id),
      })),
    )
    expect(sorted.map((thread) => thread.id)).toEqual(orderedIds)

    const move = planActiveThreadMove({
      orderedIds: ['a', 'b'],
      keysById: new Map([
        ['a', 'f'],
        ['b', 't'],
      ]),
      movedId: 'b',
      direction: 'up',
    })
    expect(move).toHaveLength(1)
    expect(move?.[0]?.id).toBe('b')
  })
})

describe('getLatestThreadForProject', () =>
{
  it('returns the latest active thread for a project', () =>
  {
    const latestThread = getLatestThreadForProject(
      [
        makeProjectThread({
          id: 'thread-1',
          createdAt: '2026-03-09T10:00:00.000Z',
          updatedAt: '2026-03-09T10:01:00.000Z',
          archivedAt: null,
        }),
        makeProjectThread({
          id: 'thread-2',
          createdAt: '2026-03-09T10:05:00.000Z',
          updatedAt: '2026-03-09T10:10:00.000Z',
          archivedAt: '2026-03-10T00:00:00.000Z',
        }),
        makeProjectThread({
          id: 'thread-3',
          createdAt: '2026-03-09T10:06:00.000Z',
          updatedAt: '2026-03-09T10:06:00.000Z',
          archivedAt: null,
        }),
      ],
      PROJECT_ID,
      'updated_at',
    )

    expect(latestThread?.id).toBe('thread-3')
  })
})
