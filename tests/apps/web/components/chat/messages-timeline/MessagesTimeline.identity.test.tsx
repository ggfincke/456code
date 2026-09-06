// tests/apps/web/components/chat/messages-timeline/MessagesTimeline.identity.test.tsx
// verifies stable mounted timeline route references

// @vitest-environment happy-dom

import { EnvironmentId, MessageId } from '@t3tools/contracts'
import { act, createRef, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { LegendListRef } from '@legendapp/list/react'

const observed = vi.hoisted(() => ({ threadRefs: [] as unknown[] }))

vi.mock('@legendapp/list/react', () =>
{
  return {
    LegendList: (props: {
      readonly data: ReadonlyArray<{ readonly id: string }>
      readonly keyExtractor: (item: { readonly id: string }) => string
      readonly renderItem: (args: { readonly item: { readonly id: string } }) => ReactNode
    }) => (
      <div>
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
      </div>
    ),
  }
})

vi.mock(
  '../../../../../../apps/web/src/components/chat/messages-timeline/TimelineRows',
  async () =>
  {
    const React = await import('react')
    const TimelineRowCtx = React.createContext<{ readonly threadRef: unknown } | null>(null)
    const TimelineRowActivityCtx = React.createContext<unknown>(null)
    return {
      TimelineRowCtx,
      TimelineRowActivityCtx,
      TimelineRowContent: () =>
      {
        observed.threadRefs.push(React.useContext(TimelineRowCtx)?.threadRef)
        return null
      },
    }
  },
)

vi.mock('../../../../../../apps/web/src/components/chat/messages-timeline/TimelineMinimap', () => ({
  deriveTimelineMinimapItems: () => [],
  resolveTimelineRowHeight: () => 0,
  resolveTimelineRowTop: () => 0,
  TimelineMinimap: () => null,
}))

import { MessagesTimeline } from '../../../../../../apps/web/src/components/chat/messages-timeline/MessagesTimeline'

const roots: Array<ReturnType<typeof createRoot>> = []

afterEach(async () =>
{
  observed.threadRefs.length = 0
  await act(async () =>
  {
    for (const root of roots.splice(0))
    {
      root.unmount()
    }
  })
})

function buildProps(
  routeThreadKey: string,
  resolvedTheme: 'light' | 'dark',
  messageText = 'Ready.',
)
{
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    timelineEntries: [
      {
        id: 'entry-1',
        kind: 'message' as const,
        createdAt: '2026-09-05T12:00:00.000Z',
        message: {
          id: MessageId.make('message-1'),
          role: 'assistant' as const,
          text: messageText,
          turnId: null,
          createdAt: '2026-09-05T12:00:00.000Z',
          updatedAt: '2026-09-05T12:00:00.000Z',
          streaming: false,
        },
      },
    ],
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey,
    onOpenTurnDiff: () =>
    {},
    revertTurnCountByUserMessageId: new Map(),
    canRevertConversation: true,
    onRevertUserMessage: () =>
    {},
    isRevertingCheckpoint: false,
    onImageExpand: () =>
    {},
    activeThreadEnvironmentId: EnvironmentId.make('environment-local'),
    markdownCwd: undefined,
    resolvedTheme,
    timestampFormat: 'locale' as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () =>
    {},
    onAnchorSizeChanged: () =>
    {},
    contentInsetEndAdjustment: 0,
    followingEnd: true,
    onIsAtEndChange: () =>
    {},
    onManualNavigation: () =>
    {},
  }
}

describe('MessagesTimeline route identity', () =>
{
  it('keeps the parsed thread reference stable across unrelated mounted rerenders', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () =>
    {
      root.render(<MessagesTimeline {...buildProps('environment-local:thread-1', 'light')} />)
    })
    const firstThreadRef = observed.threadRefs.at(-1)
    expect(firstThreadRef).toEqual({
      environmentId: 'environment-local',
      threadId: 'thread-1',
    })

    await act(async () =>
    {
      root.render(
        <MessagesTimeline
          {...buildProps('environment-local:thread-1', 'dark', 'Ready with more detail.')}
        />,
      )
    })
    expect(observed.threadRefs.at(-1)).toBe(firstThreadRef)

    await act(async () =>
    {
      root.render(<MessagesTimeline {...buildProps('environment-local:thread-2', 'dark')} />)
    })
    expect(observed.threadRefs.at(-1)).not.toBe(firstThreadRef)
  })
})
