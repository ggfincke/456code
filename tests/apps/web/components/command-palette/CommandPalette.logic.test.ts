// tests/apps/web/components/command-palette/CommandPalette.logic.test.ts
// verifies command palette derivation and actions

import { describe, expect, it, vi } from 'vite-plus/test'
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import type { Thread } from '../../../../../apps/web/src/types'
import {
  browseInputEndPaddingClass,
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  filterPinnedBrowseEntries,
  filterCommandPaletteGroups,
  type CommandPaletteGroup,
} from '../../../../../apps/web/src/components/command-palette/CommandPalette.logic'

describe('browseInputEndPaddingClass', () =>
{
  it.each([
    {
      input: { willCreateProjectPath: true, hasHighlightedBrowseItem: false },
      expected: '*:data-[slot=autocomplete-input]:pe-38!',
    },
    {
      input: { willCreateProjectPath: false, hasHighlightedBrowseItem: true },
      expected: '*:data-[slot=autocomplete-input]:pe-30!',
    },
    {
      input: { willCreateProjectPath: false, hasHighlightedBrowseItem: false },
      expected: '*:data-[slot=autocomplete-input]:pe-24!',
    },
  ])('reserves end padding for the browse action', ({ input, expected }) =>
  {
    expect(browseInputEndPaddingClass(input)).toBe(expected)
  })
})

describe('filterPinnedBrowseEntries', () =>
{
  it('keeps sibling folders visible and matches the pinned folder using platform casing', () =>
  {
    const posixEntries = [
      { name: 'repo', fullPath: '/projects/repo' },
      { name: 'work', fullPath: '/projects/work' },
    ]
    expect(
      filterPinnedBrowseEntries({
        browseEntries: posixEntries,
        browseFilterQuery: 'repo',
        highlightedItemValue: 'browse:/projects/work',
        pinnedDirectoryName: 'repo',
        caseSensitive: true,
      }),
    ).toMatchObject({
      filteredEntries: posixEntries,
      exactEntry: posixEntries[0],
      highlightedEntry: posixEntries[1],
    })

    const windowsEntries = [
      { name: 'Repo', fullPath: 'C:\\projects\\Repo' },
      { name: 'work', fullPath: 'C:\\projects\\work' },
    ]
    expect(
      filterPinnedBrowseEntries({
        browseEntries: windowsEntries,
        browseFilterQuery: 'repo',
        highlightedItemValue: null,
        pinnedDirectoryName: 'repo',
        caseSensitive: false,
      }),
    ).toMatchObject({ filteredEntries: windowsEntries, exactEntry: windowsEntries[0] })
  })
})

describe('enumerateCommandPaletteItems', () =>
{
  it('assigns positional jump shortcuts to the first nine displayed items', () =>
  {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: 'action' as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: 'chat.new' as const,
      run: async () => undefined,
    }))

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      'thread.jump.1',
      'thread.jump.2',
      'thread.jump.3',
      'thread.jump.4',
      'thread.jump.5',
      'thread.jump.6',
      'thread.jump.7',
      'thread.jump.8',
      'thread.jump.9',
      undefined,
    ])
  })
})

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make('environment-local')
const PROJECT_ID = ProjectId.make('project-1')

function makeThread(overrides: Partial<Thread> = {}): Thread
{
  return {
    id: ThreadId.make('thread-1'),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: 'Thread',
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5' },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    session: null,
    messages: [],
    proposedPlans: [],
    orchestratePlans: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: '2026-03-01T00:00:00.000Z',
    latestTurn: null,
    providerSwitch: null,
    branch: null,
    worktreePath: null,
    checkpoints: [],
    activities: [],
    ...overrides,
  }
}

describe('buildThreadActionItems', () =>
{
  it('includes content-only conversations once while ranking title matches first and preserving navigation', async () =>
  {
    const runThread = vi.fn(
      async (_thread: { environmentId: EnvironmentId; id: ThreadId }) => undefined,
    )
    const items = buildThreadActionItems({
      threads: [
        makeThread({ id: ThreadId.make('content'), title: 'Unrelated title' }),
        makeThread({ id: ThreadId.make('title'), title: 'Needle task' }),
      ],
      projectTitleById: new Map([[PROJECT_ID, 'Project']]),
      sortOrder: 'updated_at',
      icon: null,
      runThread,
      getContentMatch: () => ({
        source: 'user',
        snippet: 'Clipped message excerpt',
        query: 'needle',
      }),
    })
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: 'needle',
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    })
    expect(groups[0]?.items.map((item) => item.value)).toEqual(['thread:title', 'thread:content'])
    expect(groups[0]?.items[1]?.threadContentMatch?.snippet).toBe('Clipped message excerpt')
    await items.find((item) => item.value === 'thread:content')!.run()
    expect(runThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: LOCAL_ENVIRONMENT_ID, id: 'content' }),
    )
  })

  it('orders threads by most recent activity and formats timestamps from updatedAt', () =>
  {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))

    try
    {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make('thread-older'),
            title: 'Older thread',
            updatedAt: '2026-03-24T12:00:00.000Z',
          }),
          makeThread({
            id: ThreadId.make('thread-newer'),
            title: 'Newer thread',
            createdAt: '2026-03-20T00:00:00.000Z',
            updatedAt: '2026-03-20T00:00:00.000Z',
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, 'Project']]),
        sortOrder: 'updated_at',
        icon: null,
        runThread: async (_thread) => undefined,
      })

      expect(items.map((item) => item.value)).toEqual([
        'thread:thread-older',
        'thread:thread-newer',
      ])
      expect(items[0]?.timestamp).toBe('1d ago')
      expect(items[1]?.timestamp).toBe('5d ago')
    }
    finally
    {
      vi.useRealTimers()
    }
  })

  it('ranks thread title matches ahead of contextual project-name matches', () =>
  {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make('thread-context-match'),
          title: 'Fix navbar spacing',
          updatedAt: '2026-03-20T00:00:00.000Z',
        }),
        makeThread({
          id: ThreadId.make('thread-title-match'),
          title: 'Project kickoff notes',
          createdAt: '2026-03-02T00:00:00.000Z',
          updatedAt: '2026-03-19T00:00:00.000Z',
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, 'Project']]),
      sortOrder: 'updated_at',
      icon: null,
      runThread: async (_thread) => undefined,
    })

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: 'project',
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.value).toBe('threads-search')
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      'thread:thread-title-match',
      'thread:thread-context-match',
    ])
  })

  it('preserves thread project-name matches when there is no stronger title match', () =>
  {
    const group: CommandPaletteGroup = {
      value: 'threads-search',
      label: 'Threads',
      items: [
        {
          kind: 'action',
          value: 'thread:project-context-only',
          searchTerms: ['Fix navbar spacing', 'Project'],
          title: 'Fix navbar spacing',
          description: 'Project',
          icon: null,
          run: async () => undefined,
        },
      ],
    }

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: 'project',
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.items.map((item) => item.value)).toEqual(['thread:project-context-only'])
  })

  it('filters archived threads out of thread search items', () =>
  {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make('thread-active'),
          title: 'Active thread',
          createdAt: '2026-03-02T00:00:00.000Z',
          updatedAt: '2026-03-19T00:00:00.000Z',
        }),
        makeThread({
          id: ThreadId.make('thread-archived'),
          title: 'Archived thread',
          archivedAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T00:00:00.000Z',
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, 'Project']]),
      sortOrder: 'updated_at',
      icon: null,
      runThread: async (_thread) => undefined,
    })

    expect(items.map((item) => item.value)).toEqual(['thread:thread-active'])
  })
})
