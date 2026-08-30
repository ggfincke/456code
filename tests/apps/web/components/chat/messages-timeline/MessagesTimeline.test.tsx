// tests/apps/web/components/chat/messages-timeline/MessagesTimeline.test.tsx
// verify messages timeline behavior

import { CheckpointRef, EnvironmentId, MessageId, TurnId } from '@t3tools/contracts'
import { createRef, type ReactNode, type Ref } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import type { LegendListRef } from '@legendapp/list/react'

vi.mock('@legendapp/list/react', async () =>
{
  const legendListTestId = 'legend-list'

  const LegendList = (props: {
    data: Array<{ id: string }>
    keyExtractor: (item: { id: string }) => string
    renderItem: (args: { item: { id: string } }) => ReactNode
    ListHeaderComponent?: ReactNode
    ListFooterComponent?: ReactNode
    anchoredEndSpace?: {
      anchorIndex: number
      anchorMaxSize?: number
      anchorOffset?: number
      onReady?: (info: { anchorIndex: number }) => void
      onSizeChanged?: (size: number) => void
    }
    contentInsetEndAdjustment?: number
    className?: string
    maintainScrollAtEnd?:
      | boolean
      | {
          animated?: boolean
          on?: {
            dataChange?: boolean
            itemLayout?: boolean
            layout?: boolean
          }
        }
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean
          size?: boolean
          shouldRestorePosition?: (item: { id: string }) => boolean
        }
    ref?: Ref<LegendListRef>
  }) =>
  {
    if (props.anchoredEndSpace)
    {
      props.anchoredEndSpace.onSizeChanged?.(240)
      props.anchoredEndSpace.onReady?.({ anchorIndex: props.anchoredEndSpace.anchorIndex })
    }
    return (
      <div
        data-testid={legendListTestId}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-anchor-max-size={props.anchoredEndSpace?.anchorMaxSize}
        data-anchor-offset={props.anchoredEndSpace?.anchorOffset}
        data-anchor-on-ready={Boolean(props.anchoredEndSpace?.onReady)}
        data-content-inset-end={props.contentInsetEndAdjustment}
        data-class-name={props.className}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? 'enabled' : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === 'object'
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === 'object'
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === 'object'
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === 'object'
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === 'object'
            ? 'object'
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === 'object'
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === 'object'
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    )
  }

  return { LegendList }
})

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null }
  renderCustomHeader?: (fileDiff: {
    name?: string | null
    prevName?: string | null
  }) => React.ReactNode
})
{
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? 'diff'}
    </div>
  )
}

vi.mock('@pierre/diffs/react', () =>
{
  return { FileDiff: MockFileDiff }
})

function matchMedia()
{
  return {
    matches: false,
    addEventListener: () =>
    {},
    removeEventListener: () =>
    {},
  }
}

let MessagesTimeline: typeof import('../../../../../../apps/web/src/components/chat/MessagesTimeline').MessagesTimeline
let subagentMetadataLabel: typeof import('../../../../../../apps/web/src/components/chat/messages-timeline/WorkTimelineRows').subagentMetadataLabel

beforeAll(async () =>
{
  const classList = {
    add: () =>
    {},
    remove: () =>
    {},
    toggle: () =>
    {},
    contains: () => false,
  }

  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () =>
    {},
    removeItem: () =>
    {},
    clear: () =>
    {},
  })
  vi.stubGlobal('window', {
    matchMedia,
    addEventListener: () =>
    {},
    removeEventListener: () =>
    {},
    requestAnimationFrame: (callback: FrameRequestCallback) =>
    {
      callback(0)
      return 0
    },
    cancelAnimationFrame: () =>
    {},
    desktopBridge: undefined,
  })
  vi.stubGlobal('document', {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  })

  ;({ MessagesTimeline } =
    await import('../../../../../../apps/web/src/components/chat/MessagesTimeline'))
  ;({ subagentMetadataLabel } =
    await import('../../../../../../apps/web/src/components/chat/messages-timeline/WorkTimelineRows'))
}, 30_000)

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make('environment-local')
const MESSAGE_CREATED_AT = '2026-03-17T19:12:28.000Z'

function buildProps()
{
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: 'environment-local:thread-1',
    onOpenTurnDiff: () =>
    {},
    revertTurnCountByUserMessageId: new Map(),
    canRevertConversation: true,
    onRevertUserMessage: () =>
    {},
    isRevertingCheckpoint: false,
    onImageExpand: () =>
    {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: 'light' as const,
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

function buildLongUserMessageText(tail = 'deep hidden detail only after expand')
{
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${'verbose prompt content '.repeat(8).trim()}`,
  ).join('\n')
}

function buildUserTimelineEntry(text: string)
{
  return {
    id: 'entry-1',
    kind: 'message' as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make('message-1'),
      role: 'user' as const,
      text,
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  }
}

function buildAssistantTimelineEntry(text: string)
{
  const entry = buildUserTimelineEntry(text)
  return {
    ...entry,
    message: {
      ...entry.message,
      role: 'assistant' as const,
    },
  }
}

describe('MessagesTimeline', () =>
{
  it('renders known files as downloads and never previews unknown attachment bytes', () =>
  {
    const entry = buildUserTimelineEntry('Mixed attachments')
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            ...entry,
            message: {
              ...entry.message,
              attachments: [
                {
                  type: 'image',
                  id: 'image',
                  name: 'photo.png',
                  mimeType: 'image/png',
                  sizeBytes: 3,
                  previewUrl: 'https://assets.test/photo.png',
                },
                {
                  type: 'file',
                  id: 'file',
                  name: 'notes.pdf',
                  mimeType: 'application/pdf',
                  sizeBytes: 4,
                  previewUrl: 'https://assets.test/notes.pdf',
                  downloadable: true,
                },
                {
                  type: 'future',
                  id: 'unknown',
                  name: 'opaque.bin',
                  mimeType: 'application/octet-stream',
                  sizeBytes: 5,
                },
              ],
            },
          },
        ]}
      />,
    )
    expect(markup).toContain('src="https://assets.test/photo.png"')
    expect(markup).toContain('href="https://assets.test/notes.pdf"')
    expect(markup).not.toContain('src="https://assets.test/notes.pdf"')
    expect(markup).toContain('opaque.bin')
    expect(markup).toContain('Unsupported attachment')
  })

  it('keeps the composer inset on the list without shrinking the minimap', () =>
  {
    const timelineEntries = Array.from({ length: 5 }, (_, index) =>
    {
      const entry = buildUserTimelineEntry(`Prompt ${index + 1}`)
      return {
        ...entry,
        id: `entry-${index + 1}`,
        message: {
          ...entry.message,
          id: MessageId.make(`message-${index + 1}`),
        },
      }
    })
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        contentInsetEndAdjustment={144}
        timelineEntries={timelineEntries}
      />,
    )

    expect(markup).toContain('data-content-inset-end="144"')
    expect(markup).toMatch(
      /class="[^"]*inset-y-0[^"]*" data-testid="timeline-minimap" data-persistent-gutter="false"/,
    )
    expect(markup).not.toContain('style="bottom:144px"')
  })

  it('uses the larger leading inset only when the top fade is enabled', () =>
  {
    const timelineEntries = [buildUserTimelineEntry('Hello')]

    const compactMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} />,
    )
    const fadedMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} topFadeEnabled />,
    )

    expect(compactMarkup).toContain('class="h-3 sm:h-4"')
    expect(compactMarkup).not.toContain('chat-timeline-scroll-fade')
    expect(fadedMarkup).toContain('class="h-10 sm:h-12"')
    expect(fadedMarkup).toContain('chat-timeline-scroll-fade')
  })

  it('keeps assistant changed-files headers sticky below the thread header', () =>
  {
    const assistantMessageId = MessageId.make('message-assistant-with-files')
    const turnId = TurnId.make('turn-with-files')
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        latestTurn={{
          turnId,
          state: 'completed',
          startedAt: MESSAGE_CREATED_AT,
          completedAt: MESSAGE_CREATED_AT,
        }}
        timelineEntries={[
          {
            id: 'entry-assistant-with-files',
            kind: 'message',
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: assistantMessageId,
              role: 'assistant',
              text: 'Updated the fixture.',
              turnId,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.make('checkpoint-with-files'),
                status: 'ready',
                files: [{ path: 'README.md', kind: 'modified', additions: 2, deletions: 1 }],
                assistantMessageId,
                completedAt: MESSAGE_CREATED_AT,
              },
            ],
          ])
        }
      />,
    )

    expect(markup).toContain('sticky top-2 z-10')
    expect(markup).not.toContain('self-start')
    expect(markup).toContain('whitespace-nowrap')
    expect(markup).toContain('!size-[22px]')
    expect(markup).toContain('size-3')
    expect(markup).toContain('aria-label="Collapse all folders"')
    expect(markup).toContain('aria-label="Open diff"')
    expect(markup).toContain('1 changed file')
  })

  it('uses LegendList isNearEnd when deciding whether the live edge is visible', async () =>
  {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapHitStripWidth,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapInteractiveWidth,
      resolveTimelineMinimapTopPercent,
    } = await import('../../../../../../apps/web/src/components/chat/MessagesTimeline.logic')

    expect(resolveTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false })).toBe(true)
    expect(resolveTimelineIsAtEnd({ isNearEnd: false, isAtEnd: true })).toBe(false)
    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true)
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined()

    expect(resolveTimelineMinimapHeightStyle(5)).toBe('min(32px, calc(100vh - 18rem))')
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50)
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50)
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100)
    expect(resolveTimelineMinimapHasPersistentGutter(832)).toBe(false)
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false)
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true)

    // no usable gutter (zoomed in / narrow pane): the strip must go inert
    // instead of overlaying the centered content column.
    expect(resolveTimelineMinimapHitStripWidth(768)).toBe(0)
    expect(resolveTimelineMinimapHitStripWidth(792)).toBe(0)
    // partial gutter: strip shrinks to what fits between the viewport edge
    // and the content column.
    expect(resolveTimelineMinimapHitStripWidth(820)).toBe(14)
    // full gutter: unchanged 40px-wide strip.
    expect(resolveTimelineMinimapHitStripWidth(872)).toBe(40)
    expect(resolveTimelineMinimapHitStripWidth(1400)).toBe(40)
    expect(resolveTimelineMinimapHitStripWidth(0)).toBe(0)
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN)).toBe(0)

    // the collapsed target stays narrow, but an open preview keeps its full
    // 20rem width plus the 2rem offset from the minimap rail interactive.
    expect(resolveTimelineMinimapInteractiveWidth(0, false)).toBe(0)
    expect(resolveTimelineMinimapInteractiveWidth(14, false)).toBe(14)
    expect(resolveTimelineMinimapInteractiveWidth(40, false)).toBe(40)
    expect(resolveTimelineMinimapInteractiveWidth(0, true)).toBe('22rem')
    expect(resolveTimelineMinimapInteractiveWidth(14, true)).toBe('22rem')
    expect(resolveTimelineMinimapInteractiveWidth(40, true)).toBe('22rem')
  })

  it('anchors a sent attachment message using its measured height', () =>
  {
    const onAnchorReady = vi.fn()
    const onAnchorSizeChanged = vi.fn()
    const firstEntry = buildUserTimelineEntry('First prompt.')
    const secondEntry = {
      ...buildUserTimelineEntry('Newest prompt.'),
      id: 'entry-2',
      message: {
        ...buildUserTimelineEntry('Newest prompt.').message,
        id: MessageId.make('message-2'),
        attachments: [
          {
            type: 'image' as const,
            id: 'attachment-1',
            name: 'screenshot.png',
            mimeType: 'image/png',
            sizeBytes: 1,
            previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
          },
        ],
      },
    }
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={firstEntry.message.id}
        onAnchorReady={onAnchorReady}
        onAnchorSizeChanged={onAnchorSizeChanged}
        contentInsetEndAdjustment={144}
        timelineEntries={[firstEntry, secondEntry]}
      />,
    )

    expect(markup).toContain('data-anchor-index="0"')
    expect(markup).toContain('data-anchor-offset="16"')
    expect(markup).toContain('data-anchor-on-ready="true"')
    expect(markup).not.toContain('data-anchor-max-size=')
    expect(markup).toContain('data-content-inset-end="144"')
    expect(markup).toContain('[overflow-anchor:none]')
    expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"')
    expect(markup).toContain('data-maintain-visible-content-position="object"')
    expect(markup).toContain('data-maintain-visible-content-position-data="true"')
    expect(markup).toContain('data-maintain-visible-content-position-size="false"')
    expect(onAnchorReady).toHaveBeenCalledOnce()
    expect(onAnchorReady).toHaveBeenCalledWith(firstEntry.message.id, 0)
    expect(onAnchorSizeChanged).toHaveBeenCalledWith(firstEntry.message.id, 240)
  })

  it('renders collapse controls for long user messages', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    )

    expect(markup).toContain('Show full message')
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"')
    expect(markup).toContain('data-maintain-scroll-at-end-animated="false"')
    expect(markup).toContain('data-maintain-scroll-at-end-data-change="true"')
    expect(markup).toContain('data-maintain-scroll-at-end-item-layout="true"')
    expect(markup).toContain('data-maintain-scroll-at-end-layout="true"')
    expect(markup).toContain('data-user-message-collapsed="true"')
    expect(markup).toContain('data-user-message-fade="true"')
    expect(markup).toContain('data-user-message-footer="true"')
  })

  it('does not render collapse controls for short user messages', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry('Short prompt.')]}
      />,
    )

    expect(markup).not.toContain('Show full message')
    expect(markup).toContain('data-user-message-collapsible="false"')
    expect(markup).toContain('rounded-2xl bg-accent p-3')
  })

  it('hides rollback controls when the provider reports rollback as unsupported', () =>
  {
    const entry = buildUserTimelineEntry('Do not offer rollback.')
    const revertTurnCountByUserMessageId = new Map([[entry.message.id, 1]])
    const supportedMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[entry]}
        revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
      />,
    )
    const unsupportedMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[entry]}
        revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
        canRevertConversation={false}
      />,
    )

    expect(supportedMarkup).toContain('aria-label="Revert to this message"')
    expect(unsupportedMarkup).not.toContain('aria-label="Revert to this message"')
  })

  it('preserves XML-like tags as inert source text in user messages', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '<global-agent scope="workspace"><nested>inside</nested></global-agent>',
          ),
        ]}
      />,
    )

    expect(markup).toContain(
      '&lt;global-agent scope=&quot;workspace&quot;&gt;&lt;nested&gt;inside&lt;/nested&gt;&lt;/global-agent&gt;',
    )
    expect(markup).not.toMatch(/<global-agent(?:\s|>)/i)
  })

  it('continues to render sanitized supported HTML in assistant messages', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry('<details><summary>More</summary>Details</details>'),
        ]}
      />,
    )

    expect(markup).toContain('data-markdown-details=""')
    expect(markup).not.toContain('&lt;details&gt;')
  })

  it('renders inline terminal labels with the composer chip UI', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              '',
              '<terminal_context>',
              '- Terminal 1 lines 1-5:',
              '  1 | julius@mac effect-http-ws-cli % bun i',
              '  2 | bun install v1.3.9 (cf6cdbbb)',
              '</terminal_context>',
            ].join('\n'),
          ),
        ]}
      />,
    )

    expect(markup).toContain('Terminal 1 lines 1-5')
    expect(markup).toContain('lucide-terminal')
    expect(markup).toContain('yoo what&#x27;s</p>')
    expect(markup).toContain('<span aria-hidden="true"> </span>')
    expect(markup).toContain('Show full message')
  }, 20_000)

  it('renders chips for standalone element-pick context messages', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              '<element_context>',
              '- <SubmitButton> (Button.tsx:12):',
              '  url: https://example.com/dashboard',
              '  selector: button.submit',
              '  source: /repo/src/Button.tsx:12:5',
              '  html:',
              '  <button class="submit">Save</button>',
              '</element_context>',
            ].join('\n'),
          ),
        ]}
      />,
    )

    expect(markup).toContain('SubmitButton')
    expect(markup).not.toContain('&lt;element_context')
    expect(markup).not.toContain('<element_context')
  })

  it('keeps the copy button for collapsed long user messages', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    )

    expect(markup).toContain('aria-label="Copy link"')
    expect(markup).toContain('data-user-message-collapsed="true"')
    expect(markup).toContain('data-user-message-footer="true"')
  })

  it('renders context compaction entries in the normal work log', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: 'entry-1',
            kind: 'work',
            createdAt: '2026-03-17T19:12:28.000Z',
            entry: {
              id: 'work-1',
              createdAt: '2026-03-17T19:12:28.000Z',
              label: 'Context compacted',
              tone: 'info',
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('Context compacted')
    expect(markup).toContain('Work Log')
  })

  it('formats model and effort metadata for collab agent rows', () =>
  {
    expect(
      subagentMetadataLabel({
        id: 'work-collab-model',
        createdAt: MESSAGE_CREATED_AT,
        label: 'Spawn agent',
        tone: 'tool',
        itemType: 'collab_agent_tool_call',
        toolCallId: 'collab-model',
        toolLifecycleStatus: 'completed',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }),
    ).toBe('gpt-5.6-sol · high')
  })

  it('summarizes changed files in one line', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: 'entry-1',
            kind: 'work',
            createdAt: '2026-03-17T19:12:28.000Z',
            entry: {
              id: 'work-1',
              createdAt: '2026-03-17T19:12:28.000Z',
              label: 'Updated files',
              tone: 'tool',
              changedFiles: ['C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts'],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    )

    expect(markup).toContain('Changed 1 file')
    expect(markup).not.toContain('C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts')
  })

  it('renders the animated one-line label for a live tool group', () =>
  {
    const turnId = TurnId.make('turn-live')
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: 'running',
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: 'entry-live',
            kind: 'work',
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: 'work-live',
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: 'call-live',
              label: 'Run tests',
              tone: 'tool',
              itemType: 'command_execution',
              command: 'pnpm test',
              toolLifecycleStatus: 'inProgress',
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('Working for')
    expect(markup).toContain('Running pnpm')
    expect(markup).toContain('live-activity-focus')
    const liveButtonMarkup = markup.match(
      /<button[^>]*group\/live-work[^>]*>[\s\S]*?<\/button>/,
    )?.[0]
    expect(liveButtonMarkup).toBeDefined()
    expect(liveButtonMarkup).not.toContain('<div')
    expect(liveButtonMarkup).toContain('<span')
  })

  it('keeps an earlier tool failure visible while the next grouped tool is running', () =>
  {
    const turnId = TurnId.make('turn-live-failure')
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: 'running',
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: 'entry-failed',
            kind: 'work',
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: 'work-failed',
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: 'call-failed',
              label: 'Lint failed',
              tone: 'tool',
              itemType: 'command_execution',
              command: 'pnpm lint',
              toolLifecycleStatus: 'failed',
            },
          },
          {
            id: 'entry-running',
            kind: 'work',
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: 'work-running',
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: 'call-running',
              label: 'Run tests',
              tone: 'tool',
              itemType: 'command_execution',
              command: 'vp test run',
              toolLifecycleStatus: 'inProgress',
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('Running vp')
    expect(markup).toContain('aria-label="Running vp, tool call failed"')
    expect(markup).toContain('aria-label="Tool call failed"')
    expect(markup).not.toContain('text-destructive')
  })

  it('shows compact Thinking only while active work has no visible content', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        timelineEntries={[]}
      />,
    )

    expect(markup).toContain('Working for')
    expect(markup).toContain('Thinking')
    expect(markup).toContain('live-activity-focus')
  })

  it('does not infer rendered failure chrome from command text alone', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: 'entry-command-text',
            kind: 'work',
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: 'work-command-text',
              createdAt: MESSAGE_CREATED_AT,
              label: 'Ran command',
              tone: 'tool',
              itemType: 'command_execution',
              command: 'printf "exit code 1"',
              toolLifecycleStatus: 'completed',
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('Ran 1 command')
    expect(markup).not.toContain('tool call failed')
  })

  it('renders review comment contexts as structured cards instead of raw tags', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: 'entry-1',
            kind: 'message',
            createdAt: '2026-03-17T19:12:28.000Z',
            message: {
              id: MessageId.make('message-2'),
              role: 'user',
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                'Wadduo',
                '```diff',
                '@@ -0,0 +47,2 @@',
                '+  it("keeps valid zero-usage snapshots", () => {',
                '+    expect(snapshot).not.toBeNull();',
                '```',
                '</review_comment>',
              ].join('\n'),
              turnId: null,
              createdAt: '2026-03-17T19:12:28.000Z',
              updatedAt: '2026-03-17T19:12:28.000Z',
              streaming: false,
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('contextWindow.test.ts')
    expect(markup).toContain('Wadduo')
    expect(markup).toContain('data-testid="file-diff"')
    expect(markup).not.toContain('>Review comment<')
    expect(markup).not.toContain('&lt;review_comment')
    expect(markup).not.toContain('&lt;/review_comment&gt;')
  })

  it('renders file review comments as source code instead of diffs', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: 'entry-1',
            kind: 'message',
            createdAt: '2026-03-17T19:12:28.000Z',
            message: {
              id: MessageId.make('message-source-comment'),
              role: 'user',
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                'Clarify this.',
                '```md',
                '# Plan',
                '- Step one',
                '```',
                '</review_comment>',
              ].join('\n'),
              turnId: null,
              createdAt: '2026-03-17T19:12:28.000Z',
              updatedAt: '2026-03-17T19:12:28.000Z',
              streaming: false,
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('plan.md')
    expect(markup).toContain('Clarify this.')
    expect(markup).toContain('# Plan')
    expect(markup).not.toContain('data-testid="file-diff"')
  })

  it('keeps a failed command group summary neutral and semantically recognizable', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={(['completed', 'failed'] as const).map((status, index) => ({
          id: `entry-command-${index}`,
          kind: 'work' as const,
          createdAt: MESSAGE_CREATED_AT,
          entry: {
            id: `work-command-${index}`,
            createdAt: MESSAGE_CREATED_AT,
            label: index === 0 ? 'Run tests' : 'Run lint',
            tone: 'tool' as const,
            itemType: 'command_execution' as const,
            toolLifecycleStatus: status,
          },
        }))}
      />,
    )

    expect(markup).toContain('Ran 2 commands')
    expect(markup).toContain('lucide-terminal')
    expect(markup).toContain('tool call failed')
    expect(markup).not.toContain('lucide-x')
    expect(markup).not.toContain('text-destructive')
  })

  it('keeps hidden failure groups on their neutral disclosure chevron', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: 'entry-hidden-failure',
            kind: 'work',
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: 'work-hidden-failure',
              createdAt: MESSAGE_CREATED_AT,
              label: 'Run lint',
              tone: 'tool',
              toolLifecycleStatus: 'failed',
            },
          },
          {
            id: 'entry-visible-info',
            kind: 'work',
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: 'work-visible-info',
              createdAt: MESSAGE_CREATED_AT,
              label: 'Status updated',
              tone: 'info',
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('previous log entry, includes a failure')
    expect(markup).toContain('lucide-chevron-down')
    expect(markup).not.toContain('lucide-x')
    expect(markup).not.toContain('text-destructive')
  })

  it.each(['runtime.error', 'provider.turn.start.failed', 'runtime.warning'])(
    'preserves explicit severity styling for %s',
    (sourceActivityKind) =>
    {
      const warning = sourceActivityKind === 'runtime.warning'
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          timelineEntries={[
            {
              id: 'entry-status',
              kind: 'work',
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: 'work-status',
                createdAt: MESSAGE_CREATED_AT,
                label: 'Status updated',
                tone: 'info',
              },
            },
            {
              id: 'entry-severe',
              kind: 'work',
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: 'work-severe',
                createdAt: MESSAGE_CREATED_AT,
                label: warning ? 'Reconnecting... 2/5' : 'Provider failed',
                tone: warning ? 'info' : 'error',
                sourceActivityKind,
              },
            },
          ]}
        />,
      )

      expect(markup).toContain(warning ? 'text-warning' : 'text-destructive')
      if (warning) expect(markup).not.toContain('text-destructive')
    },
  )

  it('renders a muted failure marker for failed tool lifecycle entries', () =>
  {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: 'entry-info',
            kind: 'work',
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: 'work-info',
              createdAt: MESSAGE_CREATED_AT,
              label: 'Status updated',
              tone: 'info',
            },
          },
          {
            id: 'entry-1',
            kind: 'work',
            createdAt: '2026-03-17T19:12:28.000Z',
            entry: {
              id: 'work-1',
              createdAt: '2026-03-17T19:12:28.000Z',
              label: 'Glob',
              tone: 'tool',
              toolLifecycleStatus: 'failed',
              detail: 'No files found',
            },
          },
        ]}
      />,
    )

    expect(markup).toContain('lucide-x')
    expect(markup).toContain('aria-label="Tool call failed"')
    expect(markup).not.toContain('text-destructive')
  })
})
