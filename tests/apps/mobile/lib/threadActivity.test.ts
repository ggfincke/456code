// tests/apps/mobile/lib/threadActivity.test.ts
// verifies mobile thread feed ordering and presentation
import { describe, expect, it } from 'vite-plus/test'

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from '@t3tools/contracts'

import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from '../../../../apps/mobile/src/lib/threadActivity'

function makeActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, 'id' | 'kind' | 'summary' | 'createdAt'>,
): OrchestrationThreadActivity
{
  return {
    tone: 'info',
    payload: {},
    turnId: null,
    ...input,
  }
}

function makeThread(
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, 'id' | 'projectId' | 'title'>,
): OrchestrationThread
{
  return {
    providerSwitch: null,
    modelSelection: { instanceId: ProviderInstanceId.make('codex'), model: 'gpt-5.4' },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    orchestratePlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...input,
    origin: input.origin ?? null,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  }
}

describe('buildThreadFeed', () =>
{
  it('reuses unchanged feed and presentation rows during an assistant text update', () =>
  {
    const completedTurnId = TurnId.make('completed-turn')
    const activeTurnId = TurnId.make('active-turn')
    const thread = makeThread({
      id: ThreadId.make('feed-reuse'),
      projectId: ProjectId.make('project-1'),
      title: 'Feed reuse',
      messages: [
        {
          id: MessageId.make('completed-message'),
          role: 'assistant',
          text: 'Completed response',
          turnId: completedTurnId,
          streaming: false,
          createdAt: '2026-04-01T00:00:01.000Z',
          updatedAt: '2026-04-01T00:00:01.000Z',
        },
        {
          id: MessageId.make('streaming-message'),
          role: 'assistant',
          text: 'Current response',
          turnId: activeTurnId,
          streaming: true,
          createdAt: '2026-04-01T00:00:05.000Z',
          updatedAt: '2026-04-01T00:00:05.000Z',
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make('completed-tool-1'),
          kind: 'tool.completed',
          tone: 'tool',
          summary: 'Read files',
          createdAt: '2026-04-01T00:00:02.000Z',
          turnId: completedTurnId,
          payload: { title: 'Read files', status: 'completed' },
        }),
        makeActivity({
          id: EventId.make('completed-tool-2'),
          kind: 'tool.completed',
          tone: 'tool',
          summary: 'Checked files',
          createdAt: '2026-04-01T00:00:03.000Z',
          turnId: completedTurnId,
          payload: { title: 'Checked files', status: 'completed' },
        }),
        makeActivity({
          id: EventId.make('active-tool'),
          kind: 'tool.updated',
          tone: 'tool',
          summary: 'Run checks',
          createdAt: '2026-04-01T00:00:04.000Z',
          turnId: activeTurnId,
          payload: { title: 'Run checks', status: 'inProgress' },
        }),
      ],
    })

    const latestTurn = {
      turnId: activeTurnId,
      state: 'running' as const,
      startedAt: '2026-04-01T00:00:04.000Z',
      completedAt: null,
    }
    const expandedTurns = new Set([completedTurnId])
    const expandedGroups = new Set(['completed-tool-1'])
    const previousFeed = buildThreadFeed(thread)
    const previousRows = deriveThreadFeedPresentation(
      previousFeed,
      latestTurn,
      expandedTurns,
      expandedGroups,
    )
    const updatedMessage = {
      ...thread.messages[1]!,
      text: 'Current response with more text',
      updatedAt: '2026-04-01T00:00:06.000Z',
    }
    const nextFeed = buildThreadFeed({
      messages: [thread.messages[0]!, updatedMessage],
      activities: thread.activities,
    })
    const nextRows = deriveThreadFeedPresentation(
      nextFeed,
      latestTurn,
      expandedTurns,
      new Set(['completed-tool-1', 'unrelated-group']),
    )

    expect(nextFeed).toHaveLength(previousFeed.length)
    expect(nextRows).toHaveLength(previousRows.length)
    for (const [before, after] of [
      [previousFeed, nextFeed],
      [previousRows, nextRows],
    ] as const)
    {
      for (const [index, row] of after.entries())
      {
        if (row.id === updatedMessage.id)
        {
          expect(row).not.toBe(before[index])
          expect(row).toMatchObject({ message: updatedMessage })
        }
        else
        {
          expect(row).toBe(before[index])
        }
      }
    }
    expect(nextRows.some((row) => row.type === 'turn-fold')).toBe(true)
    expect(nextRows.some((row) => row.type === 'work-toggle')).toBe(true)
  })

  it('regroups cached activities for message changes and pagination', () =>
  {
    const messages = [2, 4].map((second) => ({
      id: MessageId.make(`message-${second}`),
      role: 'assistant' as const,
      text: second === 2 ? '' : 'Response',
      streaming: false,
      turnId: null,
      createdAt: `2026-04-01T00:00:0${second}.000Z`,
      updatedAt: `2026-04-01T00:00:0${second}.000Z`,
    }))
    const thread = makeThread({
      id: ThreadId.make('feed-regroup'),
      projectId: ProjectId.make('project-1'),
      title: 'Feed grouping',
      messages,
      activities: [1, 3, 5].map((second) =>
        makeActivity({
          id: EventId.make(`work-${second}`),
          kind: 'runtime.warning',
          summary: `Notice ${second}`,
          createdAt: `2026-04-01T00:00:0${second}.000Z`,
        }),
      ),
    })

    const initial = buildThreadFeed(thread)
    expect(initial.map((row) => row.id)).toEqual(['work-1', 'message-4', 'work-5'])
    const split = buildThreadFeed({
      messages: [{ ...messages[0]!, text: 'Now visible' }, messages[1]!],
      activities: thread.activities,
    })
    expect(split.map((row) => row.id)).toEqual([
      'work-1',
      'message-2',
      'work-3',
      'message-4',
      'work-5',
    ])
    expect(split[0]).not.toBe(initial[0])
    expect(split.at(-1)).toBe(initial.at(-1))
    expect(initial[0]).toMatchObject({ activities: [{ id: 'work-1' }, { id: 'work-3' }] })

    const reordered = buildThreadFeed({
      messages: [messages[0]!, { ...messages[1]!, createdAt: '2026-04-01T00:00:06.000Z' }],
      activities: thread.activities,
    })
    expect(reordered.map((row) => row.id)).toEqual(['work-1', 'message-4'])
    expect(reordered[0]).toMatchObject({
      activities: [{ id: 'work-1' }, { id: 'work-3' }, { id: 'work-5' }],
    })

    const olderMessage = {
      ...messages[1]!,
      id: MessageId.make('older-message'),
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    const page = buildThreadFeed(thread, { loadedMessages: [messages[1]!] })
    expect(page.map((row) => row.id)).toEqual(['message-4', 'work-5'])
    const prepended = buildThreadFeed(thread, { loadedMessages: [olderMessage, ...messages] })
    expect(prepended.map((row) => row.id)).toEqual([
      'older-message',
      'work-1',
      'message-4',
      'work-5',
    ])
    expect(prepended.at(-1)).toBe(page.at(-1))
  })

  it('drops wire-only runtime warnings while keeping actionable warnings', () =>
  {
    const thread = makeThread({
      id: ThreadId.make('thread-warning-noise'),
      projectId: ProjectId.make('project-1'),
      title: 'Warning noise',
      activities: [
        makeActivity({
          id: EventId.make('warning-noise'),
          kind: 'runtime.warning',
          summary: "Claude system message 'background_tasks_changed' (no displayable text content)",
          createdAt: '2026-04-01T00:00:02.000Z',
        }),
        makeActivity({
          id: EventId.make('warning-signal'),
          kind: 'runtime.warning',
          summary: 'Reconnecting... 2/5',
          createdAt: '2026-04-01T00:00:03.000Z',
        }),
      ],
    })

    expect(buildThreadFeed(thread)).toMatchObject([
      { type: 'activity-group', activities: [{ id: 'warning-signal', icon: 'warning' }] },
    ])
  })

  it('keeps historic work entries attributed to their turns', () =>
  {
    const thread = makeThread({
      id: ThreadId.make('thread-1'),
      projectId: ProjectId.make('project-1'),
      title: 'Runtime warning thread',
      latestTurn: {
        turnId: TurnId.make('turn-latest'),
        state: 'running',
        requestedAt: '2026-04-01T00:00:00.000Z',
        startedAt: '2026-04-01T00:00:01.000Z',
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make('activity-old'),
          kind: 'runtime.warning',
          summary: 'Runtime warning',
          createdAt: '2026-04-01T00:00:02.000Z',
          turnId: TurnId.make('turn-old'),
          payload: {
            message: 'Old warning',
          },
        }),
        makeActivity({
          id: EventId.make('activity-latest'),
          kind: 'runtime.warning',
          summary: 'Runtime warning',
          createdAt: '2026-04-01T00:00:03.000Z',
          turnId: TurnId.make('turn-latest'),
          payload: {
            message: 'Latest warning',
          },
        }),
      ],
    })

    const feed = buildThreadFeed(thread)
    expect(feed).toMatchObject([
      {
        type: 'activity-group',
        turnId: 'turn-old',
        activities: [{ id: 'activity-old', turnId: 'turn-old' }],
      },
      {
        type: 'activity-group',
        turnId: 'turn-latest',
        activities: [{ id: 'activity-latest', turnId: 'turn-latest' }],
      },
    ])
  })

  it('collapses matching tool lifecycle rows like desktop', () =>
  {
    const thread = makeThread({
      id: ThreadId.make('thread-2'),
      projectId: ProjectId.make('project-1'),
      title: 'Collapsed tools',
      latestTurn: {
        turnId: TurnId.make('turn-1'),
        state: 'completed',
        requestedAt: '2026-04-01T00:00:00.000Z',
        startedAt: '2026-04-01T00:00:01.000Z',
        completedAt: '2026-04-01T00:00:03.000Z',
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make('tool-updated'),
          kind: 'tool.updated',
          tone: 'tool',
          summary: 'Run tests',
          createdAt: '2026-04-01T00:00:01.000Z',
          turnId: TurnId.make('turn-1'),
          payload: {
            title: 'Run tests',
            itemType: 'command_execution',
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
        makeActivity({
          id: EventId.make('tool-completed'),
          kind: 'tool.completed',
          tone: 'tool',
          summary: 'Run tests completed',
          createdAt: '2026-04-01T00:00:02.000Z',
          turnId: TurnId.make('turn-1'),
          payload: {
            title: 'Run tests',
            itemType: 'command_execution',
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
      ],
    })

    const feed = buildThreadFeed(thread)
    const group = feed[0]

    expect(group).toMatchObject({
      type: 'activity-group',
    })
    if (!group || group.type !== 'activity-group')
    {
      return
    }

    expect(group.activities).toHaveLength(1)
    expect(group.activities[0]).toMatchObject({
      id: 'tool-updated',
      createdAt: '2026-04-01T00:00:02.000Z',
      turnId: 'turn-1',
      summary: 'Run tests',
      detail: 'bun run test',
      canExpand: true,
      icon: 'command',
      toolLike: true,
      status: 'success',
    })
    expect(group.activities[0]?.getFullDetail()).toBe("/bin/zsh -lc 'bun run test'")
    expect(group.activities[0]?.getCopyText()).toBe(
      "Run tests\nbun run test\n/bin/zsh -lc 'bun run test'",
    )
  })

  it('keeps MCP inputs available to expanded mobile work rows', () =>
  {
    const turnId = TurnId.make('turn-mcp')
    const thread = makeThread({
      id: ThreadId.make('thread-mcp'),
      projectId: ProjectId.make('project-1'),
      title: 'Expandable MCP call',
      latestTurn: {
        turnId,
        state: 'completed',
        requestedAt: '2026-04-01T00:00:00.000Z',
        startedAt: '2026-04-01T00:00:01.000Z',
        completedAt: '2026-04-01T00:00:03.000Z',
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make('mcp-completed'),
          kind: 'tool.completed',
          tone: 'tool',
          summary: 'Call repository tool',
          createdAt: '2026-04-01T00:00:02.000Z',
          turnId,
          payload: {
            title: 'Call repository tool',
            itemType: 'mcp_tool_call',
            detail: 'repository.search',
            status: 'completed',
            data: {
              item: {
                server: 'repository',
                tool: 'search',
                arguments: { query: 'work log' },
              },
            },
          },
        }),
      ],
    })

    const group = buildThreadFeed(thread)[0]
    expect(group).toMatchObject({ type: 'activity-group' })
    if (!group || group.type !== 'activity-group')
    {
      return
    }

    expect(group.activities[0]?.icon).toBe('wrench')
    expect(group.activities[0]?.getFullDetail()).toContain('"query": "work log"')
    expect(group.activities[0]?.getFullDetail()).toContain('repository.search')
  })

  it('defers large tool output expansion until a work row is opened or copied', () =>
  {
    let serializedToolOutputs = 0
    const activities = Array.from({ length: 5_000 }, (_, index) =>
      makeActivity({
        id: EventId.make(`large-tool-${index}`),
        kind: 'tool.completed',
        tone: 'tool',
        summary: `Tool ${index}`,
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
        payload: {
          title: `Tool ${index}`,
          itemType: 'mcp_tool_call',
          status: 'completed',
          data: {
            item: {
              toJSON: () =>
              {
                serializedToolOutputs += 1
                return { output: 'x'.repeat(32_768) }
              },
            },
          },
        },
      }),
    )
    const thread = makeThread({
      id: ThreadId.make('thread-large-tools'),
      projectId: ProjectId.make('project-1'),
      title: 'Large tools',
      activities,
    })

    const feed = buildThreadFeed(thread)
    expect(serializedToolOutputs).toBe(0)

    const group = feed[0]
    expect(group).toMatchObject({ type: 'activity-group' })
    if (!group || group.type !== 'activity-group')
    {
      return
    }

    expect(group.activities).toHaveLength(5_000)
    expect(group.activities[0]?.getFullDetail()).toContain('"output"')
    expect(serializedToolOutputs).toBe(1)
    expect(group.activities[0]?.getCopyText()).toContain('"output"')
    expect(serializedToolOutputs).toBe(1)
  })

  it('keeps the first and terminal assistant messages visible around settled work', () =>
  {
    const turnId = TurnId.make('turn-1')
    const thread = makeThread({
      id: ThreadId.make('thread-3'),
      projectId: ProjectId.make('project-1'),
      title: 'Folded work',
      latestTurn: {
        turnId,
        state: 'completed',
        requestedAt: '2026-04-01T00:00:00.000Z',
        startedAt: '2026-04-01T00:00:01.000Z',
        completedAt: '2026-04-01T00:00:18.000Z',
        assistantMessageId: MessageId.make('assistant-final'),
      },
      messages: [
        {
          id: MessageId.make('assistant-first'),
          role: 'assistant',
          text: 'Synthetic deployment checklist\n1. Confirm the deployment is ready.',
          turnId,
          streaming: false,
          createdAt: '2026-04-01T00:00:02.000Z',
          updatedAt: '2026-04-01T00:00:03.000Z',
        },
        {
          id: MessageId.make('assistant-final'),
          role: 'assistant',
          text: 'Done.',
          turnId,
          streaming: false,
          createdAt: '2026-04-01T00:00:17.000Z',
          updatedAt: '2026-04-01T00:00:18.000Z',
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make('tool-completed'),
          kind: 'tool.completed',
          tone: 'tool',
          summary: 'Read files',
          createdAt: '2026-04-01T00:00:05.000Z',
          turnId,
          payload: {
            title: 'Read files',
            itemType: 'file_read',
            status: 'completed',
          },
        }),
      ],
    })

    const feed = buildThreadFeed(thread)
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())
    expect(collapsed.map((entry) => entry.id)).toEqual([
      'assistant-first',
      'turn-fold:turn-1',
      'assistant-final',
    ])
    expect(collapsed[1]).toMatchObject({
      type: 'turn-fold',
      label: 'Worked for 17s',
      expanded: false,
    })

    const expanded = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set([turnId]))
    expect(expanded.map((entry) => entry.id)).toEqual([
      'assistant-first',
      'turn-fold:turn-1',
      'tool-completed',
      'assistant-final',
    ])
  })

  it('folds assistant messages between the first and terminal messages', () =>
  {
    const turnId = TurnId.make('turn-1')
    const thread = makeThread({
      id: ThreadId.make('thread-middle-message'),
      projectId: ProjectId.make('project-1'),
      title: 'Bounded narration',
      latestTurn: {
        turnId,
        state: 'completed',
        requestedAt: '2026-04-01T00:00:00.000Z',
        startedAt: '2026-04-01T00:00:01.000Z',
        completedAt: '2026-04-01T00:00:06.000Z',
        assistantMessageId: MessageId.make('assistant-final'),
      },
      messages: [
        {
          id: MessageId.make('assistant-first'),
          role: 'assistant',
          text: 'The main result is ready.',
          turnId,
          streaming: false,
          createdAt: '2026-04-01T00:00:01.000Z',
          updatedAt: '2026-04-01T00:00:02.000Z',
        },
        {
          id: MessageId.make('assistant-middle'),
          role: 'assistant',
          text: 'I am checking one more detail.',
          turnId,
          streaming: false,
          createdAt: '2026-04-01T00:00:03.000Z',
          updatedAt: '2026-04-01T00:00:04.000Z',
        },
        {
          id: MessageId.make('assistant-final'),
          role: 'assistant',
          text: 'Verification finished.',
          turnId,
          streaming: false,
          createdAt: '2026-04-01T00:00:05.000Z',
          updatedAt: '2026-04-01T00:00:06.000Z',
        },
      ],
    })

    const feed = buildThreadFeed(thread)
    const rows = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())

    expect(rows.map((entry) => entry.id)).toEqual([
      'assistant-first',
      'turn-fold:turn-1',
      'assistant-final',
    ])
  })

  it('measures a steer-superseded turn from its user boundary through trailing work', () =>
  {
    const firstTurnId = TurnId.make('turn-1')
    const secondTurnId = TurnId.make('turn-2')
    const thread = makeThread({
      id: ThreadId.make('thread-steered'),
      projectId: ProjectId.make('project-1'),
      title: 'Steered work',
      latestTurn: {
        turnId: secondTurnId,
        state: 'running',
        requestedAt: '2026-04-01T00:00:14.000Z',
        startedAt: '2026-04-01T00:00:14.000Z',
        completedAt: null,
        assistantMessageId: MessageId.make('assistant-next'),
      },
      messages: [
        {
          id: MessageId.make('user-1'),
          role: 'user',
          text: 'Do it once more.',
          turnId: null,
          streaming: false,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
        {
          id: MessageId.make('assistant-commentary'),
          role: 'assistant',
          text: 'Kicking off call 1.',
          turnId: firstTurnId,
          streaming: false,
          createdAt: '2026-04-01T00:00:09.000Z',
          updatedAt: '2026-04-01T00:00:09.000Z',
        },
        {
          id: MessageId.make('user-2'),
          role: 'user',
          text: 'Actually do 15.',
          turnId: null,
          streaming: false,
          createdAt: '2026-04-01T00:00:14.000Z',
          updatedAt: '2026-04-01T00:00:14.000Z',
        },
        {
          id: MessageId.make('assistant-next'),
          role: 'assistant',
          text: 'One down - adjusting.',
          turnId: secondTurnId,
          streaming: true,
          createdAt: '2026-04-01T00:00:17.000Z',
          updatedAt: '2026-04-01T00:00:17.000Z',
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make('work-1'),
          kind: 'tool.completed',
          tone: 'tool',
          summary: 'Ran command',
          createdAt: '2026-04-01T00:00:12.000Z',
          turnId: firstTurnId,
          payload: {
            title: 'Ran command',
            itemType: 'command_execution',
            status: 'completed',
          },
        }),
      ],
    })

    const feed = buildThreadFeed(thread)
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())
    expect(collapsed.find((entry) => entry.type === 'turn-fold')).toMatchObject({
      turnId: firstTurnId,
      label: 'Worked for 12s',
    })
  })

  it('keeps an active turn expanded and classifies error-shaped tool output', () =>
  {
    const turnId = TurnId.make('turn-running')
    const thread = makeThread({
      id: ThreadId.make('thread-4'),
      projectId: ProjectId.make('project-1'),
      title: 'Running work',
      latestTurn: {
        turnId,
        state: 'running',
        requestedAt: '2026-04-01T00:00:00.000Z',
        startedAt: '2026-04-01T00:00:01.000Z',
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make('tool-failed'),
          kind: 'tool.completed',
          tone: 'tool',
          summary: 'Run command',
          createdAt: '2026-04-01T00:00:05.000Z',
          turnId,
          payload: {
            title: 'Run command',
            itemType: 'command_execution',
            detail: 'zsh: command not found: nope',
            status: 'completed',
          },
        }),
      ],
    })

    const feed = buildThreadFeed(thread)
    expect(deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())).toEqual(feed)
    expect(feed[0]).toMatchObject({
      type: 'activity-group',
      activities: [{ status: 'failure' }],
    })
  })

  it('appends active work as a normal timeline row', () =>
  {
    const startedAt = '2026-04-01T00:00:01.000Z'
    const presented = deriveThreadFeedPresentation([], null, new Set(), new Set(), startedAt)

    expect(presented).toEqual([
      {
        type: 'working',
        id: 'working-indicator-row',
        createdAt: startedAt,
      },
    ])
    expect(deriveThreadFeedPresentation(presented, null, new Set())).toEqual([])
  })

  it('models work-log overflow as list rows', () =>
  {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity['status'] = 'success',
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      turnId: null,
      summary: `Tool ${id}`,
      detail: null,
      canExpand: false,
      getFullDetail: () => null,
      getCopyText: () => id,
      icon: 'command',
      toolLike: true,
      status,
    })
    const feed: ThreadFeedEntry[] = [
      {
        type: 'activity-group',
        id: 'work-group-1',
        createdAt: '2026-04-01T00:00:01.000Z',
        turnId: null,
        activities: [
          activity('activity-1', '2026-04-01T00:00:01.000Z'),
          activity('activity-neutral', '2026-04-01T00:00:02.000Z', 'neutral'),
          activity('activity-2', '2026-04-01T00:00:03.000Z'),
          activity('activity-3', '2026-04-01T00:00:04.000Z'),
        ],
      },
    ]

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set())
    const repeatedCollapsed = deriveThreadFeedPresentation(feed, null, new Set())
    expect(collapsed.map((entry) => entry.id)).toEqual(['activity-3', 'work-toggle:work-group-1'])
    expect(repeatedCollapsed[0]).toBe(collapsed[0])
    expect(repeatedCollapsed[1]).toBe(collapsed[1])
    expect(collapsed[1]).toMatchObject({
      type: 'work-toggle',
      groupId: 'work-group-1',
      hiddenCount: 2,
      expanded: false,
    })

    const expanded = deriveThreadFeedPresentation(feed, null, new Set(), new Set(['work-group-1']))
    expect(expanded[0]).not.toBe(collapsed[0])
    expect(expanded.map((entry) => entry.id)).toEqual([
      'activity-1',
      'activity-2',
      'activity-3',
      'work-toggle:work-group-1',
    ])
    expect(expanded.at(-1)).toMatchObject({
      type: 'work-toggle',
      expanded: true,
    })
  })
})
