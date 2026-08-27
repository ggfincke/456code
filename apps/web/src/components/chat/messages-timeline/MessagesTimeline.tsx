// apps/web/src/components/chat/messages-timeline/MessagesTimeline.tsx
// renders virtualized thread timeline rows and shared row interactions
import { LegendList, type LegendListRef } from '@legendapp/list/react'
import { parseScopedThreadKey } from '@t3tools/client-runtime/environment'
import {
  type EnvironmentId,
  type MessageId,
  type ServerProviderSkill,
  type TurnId,
} from '@t3tools/contracts'
import { type TimestampFormat } from '@t3tools/contracts/settings'
import { resolveChatListAnchoredEndSpace } from '@t3tools/shared/chatList'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { cn } from '~/lib/utils'
import { deriveTimelineEntries } from '../../../session-logic'
import { type TurnDiffSummary } from '../../../types'
import { ExpandedImagePreview } from '../ExpandedImagePreview'
import {
  deriveTimelineMinimapItems,
  resolveTimelineRowHeight,
  resolveTimelineRowTop,
  TimelineMinimap,
} from './TimelineMinimap'
import {
  TimelineRowActivityCtx,
  TimelineRowContent,
  TimelineRowCtx,
  type TimelineRowActivityState,
  type TimelineRowSharedState,
} from './TimelineRows'
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHitStripWidth,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
  type TimelineLatestTurn,
} from './MessagesTimeline.logic'
import { shouldKeepTimelineEndVisibleAfterOverlayGrowth } from './timelineScrollAnchoring'

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />
const TIMELINE_LIST_FADE_HEADER = <div className="h-10 sm:h-12" />
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>> = []

// props (public API)

interface MessagesTimelineProps
{
  isWorking: boolean
  activeTurnInProgress: boolean
  activeTurnStartedAt: string | null
  listRef: React.RefObject<LegendListRef | null>
  timelineEntries: ReturnType<typeof deriveTimelineEntries>
  latestTurn: TimelineLatestTurn | null
  runningTurnId: TurnId | null
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>
  routeThreadKey: string
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void
  revertTurnCountByUserMessageId: Map<MessageId, number>
  canRevertConversation: boolean
  onRevertUserMessage: (messageId: MessageId) => void
  isRevertingCheckpoint: boolean
  onImageExpand: (preview: ExpandedImagePreview) => void
  activeThreadEnvironmentId: EnvironmentId
  markdownCwd: string | undefined
  resolvedTheme: 'light' | 'dark'
  timestampFormat: TimestampFormat
  workspaceRoot: string | undefined
  skills?: ReadonlyArray<Pick<ServerProviderSkill, 'name' | 'displayName'>>
  anchorMessageId: MessageId | null
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void
  contentInsetEndAdjustment: number
  followingEnd: boolean
  onIsAtEndChange: (isAtEnd: boolean) => void
  onManualNavigation: () => void
  hideEmptyPlaceholder?: boolean
  topFadeEnabled?: boolean
  orchestratePlanActions?: TimelineRowSharedState['orchestratePlanActions'] | undefined
}

// MessagesTimeline — list owner

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  latestTurn,
  runningTurnId,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  canRevertConversation,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  followingEnd,
  onIsAtEndChange,
  onManualNavigation,
  hideEmptyPlaceholder = false,
  topFadeEnabled = false,
  orchestratePlanActions,
}: MessagesTimelineProps)
{
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(new Set())
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set())
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>())

  const onToggleTurnFold = useCallback((turnId: TurnId) =>
  {
    setExpandedTurnIds((existing) =>
    {
      const next = new Set(existing)
      if (next.has(turnId))
      {
        next.delete(turnId)
      }
      else
      {
        next.add(turnId)
      }
      return next
    })
  }, [])
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorElement?: HTMLElement) =>
    {
      const anchorBottomBeforeToggle = anchorElement?.getBoundingClientRect().bottom ?? null

      flushSync(() =>
      {
        setExpandedWorkGroupIds((existing) =>
        {
          const next = new Set(existing)
          if (next.has(groupId))
          {
            next.delete(groupId)
          }
          else
          {
            next.add(groupId)
          }
          return next
        })
      })

      if (anchorBottomBeforeToggle === null || !anchorElement)
      {
        return
      }

      const delta = anchorElement.getBoundingClientRect().bottom - anchorBottomBeforeToggle
      if (Math.abs(delta) < 0.5)
      {
        return
      }

      const list = listRef.current
      const currentScroll = list?.getState?.().scroll
      if (list && typeof currentScroll === 'number')
      {
        list.scrollToOffset({ offset: currentScroll + delta, animated: false })
      }
    },
    [listRef],
  )

  // an in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  const previousLatestTurnRef = useRef(latestTurn)
  useEffect(() =>
  {
    const previous = previousLatestTurnRef.current
    previousLatestTurnRef.current = latestTurn
    if (!latestTurn || previous?.turnId === undefined)
    {
      return
    }
    if (latestTurn.turnId === previous.turnId)
    {
      if (previous.state === 'running' && latestTurn.state === 'interrupted')
      {
        setExpandedTurnIds((existing) =>
        {
          const next = new Set(existing)
          next.add(latestTurn.turnId)
          return next
        })
      }
      return
    }
    setExpandedTurnIds((existing) =>
    {
      if (!existing.has(previous.turnId))
      {
        return existing
      }
      const next = new Set(existing)
      next.delete(previous.turnId)
      return next
    })
  }, [latestTurn])

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        runningTurnId,
        expandedTurnIds,
        expandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      latestTurn,
      runningTurnId,
      expandedTurnIds,
      expandedWorkGroupIds,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  )
  const rows = useStableRows(rawRows)
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows])
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  )
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false)
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0)
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) =>
    {
      if (anchorMessageId !== null && info.anchorIndex !== undefined)
      {
        onAnchorReady(anchorMessageId, info.anchorIndex)
      }
    },
    [anchorMessageId, onAnchorReady],
  )
  const handleAnchorSizeChanged = useCallback(
    (size: number) =>
    {
      if (anchorMessageId !== null)
      {
        onAnchorSizeChanged(anchorMessageId, size)
      }
    },
    [anchorMessageId, onAnchorSizeChanged],
  )
  const anchoredEndSpace = useMemo(() =>
  {
    const config = resolveChatListAnchoredEndSpace(rows, anchorMessageId, (row) =>
      row.kind === 'message' && row.message.role === 'user' ? row.message.id : null,
    )
    return config
      ? { ...config, onReady: handleAnchorReady, onSizeChanged: handleAnchorSizeChanged }
      : undefined
  }, [anchorMessageId, handleAnchorReady, handleAnchorSizeChanged, rows])
  const previousContentInsetEndAdjustmentRef = useRef(contentInsetEndAdjustment)
  useLayoutEffect(() =>
  {
    const previousOverlayHeight = previousContentInsetEndAdjustmentRef.current
    previousContentInsetEndAdjustmentRef.current = contentInsetEndAdjustment
    if (
      shouldKeepTimelineEndVisibleAfterOverlayGrowth({
        previousOverlayHeight,
        overlayHeight: contentInsetEndAdjustment,
        followingEnd,
      })
    )
    {
      void listRef.current?.scrollToEnd?.({ animated: false })
    }
  }, [contentInsetEndAdjustment, followingEnd, listRef])

  const handleScroll = useCallback(() =>
  {
    const state = listRef.current?.getState?.()
    const isAtEnd = resolveTimelineIsAtEnd(state)
    if (isAtEnd !== undefined)
    {
      onIsAtEndChange(isAtEnd)
    }
    if (!state || minimapItems.length === 0)
    {
      return
    }

    const scrollTop = state.scroll ?? 0
    const scrollBottom = scrollTop + (state.scrollLength ?? 0)

    for (const item of minimapItems)
    {
      const strip = minimapStripMap.get(item.id)
      if (!strip)
      {
        continue
      }

      const rowTop = resolveTimelineRowTop(state, item.rowIndex)
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex)
      const inView =
        rowTop !== null && rowTop < scrollBottom && rowTop + Math.max(1, rowHeight ?? 1) > scrollTop

      strip.dataset.inView = inView ? 'true' : 'false'
    }
  }, [listRef, minimapItems, minimapStripMap, onIsAtEndChange])

  useEffect(() =>
  {
    const frame = requestAnimationFrame(handleScroll)
    return () => cancelAnimationFrame(frame)
  }, [handleScroll, rows.length])

  useEffect(() =>
  {
    if (!timelineViewportElement)
    {
      return
    }

    const measure = () =>
    {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth)
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      )
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth))
    }

    const frame = requestAnimationFrame(measure)

    const observer = new ResizeObserver(measure)
    observer.observe(timelineViewportElement)

    return () =>
    {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [timelineViewportElement, rows.length])

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      threadRef: parseScopedThreadKey(routeThreadKey),
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      canRevertConversation,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      orchestratePlanActions,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      canRevertConversation,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      orchestratePlanActions,
    ],
  )
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      activeTurnInProgress,
      latestTurnId: latestTurn?.turnId ?? null,
    }),
    [activeTurnInProgress, isRevertingCheckpoint, isWorking, latestTurn?.turnId],
  )

  // stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div
        // rows holding an orchestrate plan card lift the clip so the card
        // alone can break out to the container width; prose keeps its measure
        className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip has-[[data-orchestrate-plan]]:overflow-x-visible"
        data-timeline-root="true"
      >
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  )

  if (rows.length === 0 && !isWorking)
  {
    if (hideEmptyPlaceholder)
    {
      return null
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    )
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div ref={setTimelineViewportElement} className="@container relative h-full min-h-0">
          <LegendList<MessagesTimelineRow>
            ref={listRef}
            data={rows}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            initialScrollAtEnd
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            maintainScrollAtEnd={
              anchoredEndSpace
                ? false
                : {
                    animated: false,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
            }
            maintainVisibleContentPosition={{
              data: true,
              size: false,
            }}
            onScroll={handleScroll}
            className={cn(
              'scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5',
              topFadeEnabled && 'chat-timeline-scroll-fade',
            )}
            ListHeaderComponent={topFadeEnabled ? TIMELINE_LIST_FADE_HEADER : TIMELINE_LIST_HEADER}
            ListFooterComponent={TIMELINE_LIST_FOOTER}
          />
          <TimelineMinimap
            items={minimapItems}
            hasPersistentGutter={minimapHasPersistentGutter}
            hitStripWidth={minimapHitStripWidth}
            stripMap={minimapStripMap}
            onSelect={(item) =>
            {
              onManualNavigation()
              void listRef.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              })
            }}
          />
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  )
})

function keyExtractor(item: MessagesTimelineRow)
{
  return item.id
}

function getItemType(item: MessagesTimelineRow)
{
  return item.kind === 'message' ? `message:${item.message.role}` : item.kind
}

// reuse stable row references so LegendList can skip unchanged rows
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[]
{
  const previousState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  })

  return useMemo(() =>
  {
    const nextState = computeStableMessagesTimelineRows(rows, previousState.current)
    previousState.current = nextState
    return nextState.result
  }, [rows])
}
