// apps/mobile/src/features/threads/ThreadFeed.tsx
// renders the virtualized mobile thread feed

import { KeyboardAwareLegendList } from '@legendapp/list/keyboard'
import { type LegendListRef } from '@legendapp/list/react-native'
import { HeaderHeightContext } from '@react-navigation/elements'
import { useNavigation } from '@react-navigation/native'
import type { EnvironmentId, MessageId, ThreadId, TurnId } from '@t3tools/contracts'
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from '@t3tools/shared/chatList'
import * as Haptics from 'expo-haptics'
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import {
  Linking,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import ImageViewing from 'react-native-image-viewing'
import {
  useSharedValue,
  withTiming,
  type LayoutAnimationsValues,
  type SharedValue,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { copyTextWithHaptic } from '../../lib/copyTextWithHaptic'
import { useThemeColor } from '../../lib/useThemeColor'
import { type SelectableMarkdownSkill } from '../../native/SelectableMarkdownText'

import { resolveMarkdownLinkPresentation } from '@t3tools/mobile-markdown-text/links'
import { scaledTypographyLineHeight } from '../../lib/appearancePreferences'
import { deriveCenteredContentHorizontalPadding, type LayoutVariant } from '../../lib/layout'
import { scopedThreadKey } from '../../lib/scopedEntities'
import {
  deriveThreadFeedPresentation,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from '../../lib/threadActivity'
import { MOBILE_TYPOGRAPHY } from '../../lib/typography'
import { resolveWorkspaceRelativeFilePath } from '../files/filePath'
import { useAppearancePreferences } from '../settings/appearance/AppearancePreferencesProvider'
import { collapsedWorkLogHeight, WORK_GROUP_TOGGLE_HEIGHT } from './thread-work-log'
import type { ThreadContentPresentation } from './threadContentPresentation'

// animate content shifts only near the live end of the feed
const FEED_ITEM_LAYOUT_DURATION_MS = 180

// min-h-11 plus mb-3
const TURN_FOLD_HEIGHT = 56
// py-1 plus mb-4 around the scaled working label
const WORKING_ROW_VERTICAL_EXTRAS = 24

export interface ThreadFeedProps
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly workspaceRoot?: string | null
  readonly feed: ReadonlyArray<ThreadFeedEntry>
  readonly contentPresentation: ThreadContentPresentation
  readonly agentLabel: string
  readonly latestTurn: ThreadFeedLatestTurn | null
  readonly activeWorkStartedAt: string | null
  readonly listRef: RefObject<LegendListRef | null>
  readonly freeze: SharedValue<boolean>
  readonly anchorMessageId: MessageId | null
  readonly contentInsetEndAdjustment: SharedValue<number>
  readonly contentTopInset?: number
  readonly contentBottomInset?: number
  readonly contentMaxWidth?: number
  readonly layoutVariant?: LayoutVariant
  readonly usesAutomaticContentInsets?: boolean
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>
}

import {
  renderFeedEntry,
  ThreadFeedPlaceholder,
  useMarkdownStyles,
  useReviewCommentColors,
} from './feed/ThreadFeedRows'
export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps)
{
  const navigation = useNavigation()
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const foldSettleFrameRef = useRef<number | null>(null)
  const foldSettleSecondFrameRef = useRef<number | null>(null)
  const disclosureAnchorKeyRef = useRef<string | null>(null)
  const headerMaterialVisibleRef = useRef(false)
  const previousLatestTurnRef = useRef(props.latestTurn)
  const { width: windowWidth } = useWindowDimensions()
  const { appearance } = useAppearancePreferences()
  const [viewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === 'split' ? 0 : windowWidth,
  )
  const [viewportHeight, setViewportHeight] = useState(0)
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false)
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null
    readonly expandedWorkGroups: Record<string, boolean>
    readonly expandedWorkRows: Record<string, boolean>
    readonly expandedTurnIds: ReadonlySet<TurnId>
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  })
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState
  const [expandedImage, setExpandedImage] = useState<{
    uri: string
    headers?: Record<string, string>
  } | null>(null)
  const horizontalPadding = props.layoutVariant === 'split' ? 20 : 16
  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  })
  const contentWidth = Math.max(0, viewportWidth - contentHorizontalPadding * 2)
  const userBubbleMaxWidth = contentWidth * 0.85
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth)
  const insets = useSafeAreaInsets()
  const topContentInset = props.contentTopInset ?? insets.top + 44
  const bottomContentInset = props.contentBottomInset ?? 18
  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === 'ios'
  // with automatic insets the header inset lives in UIKit's adjustedContentInset,
  // which LegendList's JS anchoring math cannot see — it measures the anchored
  // end space from the scroll view's frame top. Fold the header height back into
  // the anchor offset or a just-sent message anchors underneath the header and
  // the oversized end space keeps maintainScrollAtEnd snapping away from earlier
  // messages. Read the context directly (useHeaderHeight throws outside a
  // header-providing screen) and fall back to the standard iOS bar height.
  const navigationHeaderHeight = useContext(HeaderHeightContext)
  const anchorTopInset = usesNativeAutomaticInsets
    ? navigationHeaderHeight || insets.top + 44
    : topContentInset

  const iconSubtleColor = useThemeColor('--color-icon-subtle')
  const userBubbleColor = useThemeColor('--color-user-bubble')
  const onMarkdownLinkPress = useCallback(
    (href: string) =>
    {
      const presentation = resolveMarkdownLinkPresentation(href)
      if (presentation.kind === 'file')
      {
        const relativePath = resolveWorkspaceRelativeFilePath(
          props.workspaceRoot,
          presentation.path,
        )
        if (relativePath)
        {
          void Haptics.selectionAsync()
          navigation.navigate('ThreadFile', {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
            path: relativePath.split('/').filter((segment) => segment.length > 0),
            ...(presentation.line ? { line: String(presentation.line) } : {}),
          })
        }
        return
      }

      if (presentation.href)
      {
        void Linking.openURL(presentation.href)
      }
    },
    [props.environmentId, props.threadId, props.workspaceRoot, navigation],
  )
  const markdownStyles = useMarkdownStyles(onMarkdownLinkPress)
  const reviewCommentColors = useReviewCommentColors()
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // keep row-local interaction props in extraData so disclosures and copy feedback repaint.
  const listAppearanceData = useMemo(
    () => ({
      copiedRowId,
      expandedWorkRows,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      userBubbleColor,
      viewportWidth,
    }),
    [
      copiedRowId,
      expandedWorkRows,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      userBubbleColor,
      viewportWidth,
    ],
  )
  const reportHeaderMaterialVisibility = useCallback(
    (visible: boolean) =>
    {
      if (headerMaterialVisibleRef.current === visible)
      {
        return
      }
      headerMaterialVisibleRef.current = visible
      props.onHeaderMaterialVisibilityChange?.(visible)
    },
    [props.onHeaderMaterialVisibilityChange],
  )
  // start near the live end where layout shifts should animate
  const nearListEnd = useSharedValue(true)

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) =>
    {
      // anchorTopInset, not topContentInset: under automatic insets the list
      // rests at contentOffset.y = -headerHeight (the inset lives only in
      // UIKit's adjustedContentInset, so topContentInset is 0 here). Add the
      // header height back or the material toggles a full header too late.
      reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6)
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      nearListEnd.value =
        contentSize.height - layoutMeasurement.height - contentOffset.y < layoutMeasurement.height
    },
    [reportHeaderMaterialVisibility, anchorTopInset, nearListEnd],
  )

  // keep history corrections instant while smoothing live-end growth
  const feedItemLayoutTransition = useMemo(() =>
  {
    return (values: LayoutAnimationsValues) =>
    {
      'worklet'
      const duration = nearListEnd.value ? FEED_ITEM_LAYOUT_DURATION_MS : 0
      return {
        initialValues: {
          originX: values.currentOriginX,
          originY: values.currentOriginY,
          width: values.currentWidth,
          height: values.currentHeight,
        },
        animations: {
          originX: withTiming(values.targetOriginX, { duration }),
          originY: withTiming(values.targetOriginY, { duration }),
          width: withTiming(values.targetWidth, { duration }),
          height: withTiming(values.targetHeight, { duration }),
        },
      }
    }
  }, [nearListEnd])
  const handleViewportLayout = useCallback((event: LayoutChangeEvent) =>
  {
    const nextWidth = Math.round(event.nativeEvent.layout.width)
    const nextHeight = Math.round(event.nativeEvent.layout.height)
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current))
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current))
  }, [])

  useEffect(() =>
  {
    reportHeaderMaterialVisibility(false)
  }, [props.environmentId, props.threadId, reportHeaderMaterialVisibility])

  const expandedWorkGroupIds = useMemo(() =>
  {
    const ids = new Set<string>()
    for (const [groupId, expanded] of Object.entries(expandedWorkGroups))
    {
      if (expanded)
      {
        ids.add(groupId)
      }
    }
    return ids
  }, [expandedWorkGroups])
  const presentedFeed = useMemo(
    () =>
      deriveThreadFeedPresentation(
        props.feed,
        props.latestTurn,
        expandedTurnIds,
        expandedWorkGroupIds,
        props.activeWorkStartedAt,
      ),
    [
      expandedTurnIds,
      expandedWorkGroupIds,
      props.activeWorkStartedAt,
      props.feed,
      props.latestTurn,
    ],
  )

  // the empty<->filled key below remounts the list, which resets its imperative
  // content-inset override — and useKeyboardChatComposerInset (mounted above
  // the remount boundary) deduplicates by height, so it never re-reports the
  // composer inset to the fresh instance. Without this, the remounted list's
  // initial scroll-to-end computes with a zero end inset and rests one
  // composer-height short of the end. Layout effect: it must land before the
  // list's first positioning tick or the one-shot initial scroll misses it.
  const listMountKey = `${scopedThreadKey(props.environmentId, props.threadId)}:${
    props.feed.length === 0 ? 'empty' : 'filled'
  }`
  useLayoutEffect(() =>
  {
    const bottom = props.contentInsetEndAdjustment.value
    if (bottom > 0)
    {
      props.listRef.current?.reportContentInset({ bottom })
    }
  }, [listMountKey, props.contentInsetEndAdjustment, props.listRef])

  const anchoredEndSpace = useMemo(
    () =>
      resolveChatListAnchoredEndSpace(
        presentedFeed,
        props.anchorMessageId,
        (entry) => (entry.type === 'message' ? entry.id : null),
        { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
      ),
    [presentedFeed, props.anchorMessageId, anchorTopInset],
  )
  const terminalAssistantMessageIds = useMemo(() =>
  {
    const terminalIdsByTurn = new Map<TurnId, string>()
    for (const entry of props.feed)
    {
      if (entry.type === 'message' && entry.message.role === 'assistant' && entry.message.turnId)
      {
        terminalIdsByTurn.set(entry.message.turnId, entry.message.id)
      }
    }
    return new Set(terminalIdsByTurn.values())
  }, [props.feed])
  const unsettledTurnId =
    props.latestTurn &&
    (props.latestTurn.completedAt === null || props.latestTurn.state === 'running')
      ? props.latestTurn.turnId
      : null

  useEffect(() =>
  {
    const previous = previousLatestTurnRef.current
    previousLatestTurnRef.current = props.latestTurn
    if (!props.latestTurn || !previous)
    {
      return
    }
    if (props.latestTurn.turnId === previous.turnId)
    {
      if (previous.state === 'running' && props.latestTurn.state === 'interrupted')
      {
        const interruptedTurnId = props.latestTurn.turnId
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }))
      }
      return
    }
    setInteractionState((current) =>
    {
      if (!current.expandedTurnIds.has(previous.turnId))
      {
        return current
      }
      const next = new Set(current.expandedTurnIds)
      next.delete(previous.turnId)
      return { ...current, expandedTurnIds: next }
    })
  }, [props.latestTurn])

  useEffect(() =>
  {
    return () =>
    {
      if (copyFeedbackTimeoutRef.current)
      {
        clearTimeout(copyFeedbackTimeoutRef.current)
      }
      if (foldSettleFrameRef.current !== null)
      {
        cancelAnimationFrame(foldSettleFrameRef.current)
      }
      if (foldSettleSecondFrameRef.current !== null)
      {
        cancelAnimationFrame(foldSettleSecondFrameRef.current)
      }
    }
  }, [])

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string | null) =>
  {
    disclosureAnchorKeyRef.current = anchorKey
    setDisclosureToggleSettling(true)
    if (foldSettleFrameRef.current !== null)
    {
      cancelAnimationFrame(foldSettleFrameRef.current)
    }
    if (foldSettleSecondFrameRef.current !== null)
    {
      cancelAnimationFrame(foldSettleSecondFrameRef.current)
    }
    foldSettleFrameRef.current = requestAnimationFrame(() =>
    {
      foldSettleSecondFrameRef.current = requestAnimationFrame(() =>
      {
        disclosureAnchorKeyRef.current = null
        setDisclosureToggleSettling(false)
        foldSettleFrameRef.current = null
        foldSettleSecondFrameRef.current = null
      })
    })
  }, [])

  const shouldRestoreVisibleContentPosition = useCallback((entry: ThreadFeedEntry) =>
  {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey
  }, [])

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  )

  const onCopyWorkRow = useCallback((rowId: string, value: string) =>
  {
    copyTextWithHaptic(value, {
      target: 'thread-work-row',
      feedback: 'selection',
    })
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }))
    if (copyFeedbackTimeoutRef.current)
    {
      clearTimeout(copyFeedbackTimeoutRef.current)
    }
    copyFeedbackTimeoutRef.current = setTimeout(() =>
    {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      )
      copyFeedbackTimeoutRef.current = null
    }, 1200)
  }, [])

  const onToggleWorkGroup = useCallback(
    (groupId: string) =>
    {
      suspendEndScrollMaintenanceForDisclosure(`work-toggle:${groupId}`)
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: {
          ...current.expandedWorkGroups,
          [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
        },
      }))
    },
    [suspendEndScrollMaintenanceForDisclosure],
  )

  const onToggleWorkRow = useCallback(
    (rowId: string) =>
    {
      suspendEndScrollMaintenanceForDisclosure(rowId)
      setInteractionState((current) => ({
        ...current,
        expandedWorkRows: {
          ...current.expandedWorkRows,
          [rowId]: !(current.expandedWorkRows[rowId] ?? false),
        },
      }))
    },
    [suspendEndScrollMaintenanceForDisclosure],
  )

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) =>
    {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`)
      setInteractionState((current) =>
      {
        const next = new Set(current.expandedTurnIds)
        if (next.has(turnId))
        {
          next.delete(turnId)
        }
        else
        {
          next.add(turnId)
        }
        return { ...current, expandedTurnIds: next }
      })
    },
    [suspendEndScrollMaintenanceForDisclosure],
  )

  const onPressImage = useCallback((uri: string, headers?: Record<string, string>) =>
  {
    setExpandedImage({ uri, headers })
  }, [])

  // premeasure fixed chrome rows and let messages use per-type estimates
  const workingRowHeight =
    WORKING_ROW_VERTICAL_EXTRAS +
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.label, appearance.baseFontSize)
  const getFixedItemSize = useCallback(
    (entry: ThreadFeedEntry) =>
    {
      switch (entry.type)
      {
        case 'turn-fold':
          return TURN_FOLD_HEIGHT
        case 'work-toggle':
          return WORK_GROUP_TOGGLE_HEIGHT
        case 'working':
          return workingRowHeight
        case 'activity-group':
          // expanded detail rows require measurement
          return entry.activities.some((activity) => expandedWorkRows[activity.id])
            ? undefined
            : collapsedWorkLogHeight(entry.activities, appearance.baseFontSize)
        default:
          return undefined
      }
    },
    [expandedWorkRows, workingRowHeight, appearance.baseFontSize],
  )

  const renderItem = useCallback(
    (info: { item: ThreadFeedEntry; index: number }) =>
      renderFeedEntry(info, {
        environmentId: props.environmentId,
        copiedRowId,
        expandedWorkRows,
        terminalAssistantMessageIds,
        unsettledTurnId,
        onCopyWorkRow,
        onToggleWorkGroup,
        onToggleWorkRow,
        onToggleTurnFold,
        onPressImage,
        onMarkdownLinkPress,
        iconSubtleColor,
        userBubbleColor,
        markdownStyles,
        reviewCommentColors,
        reviewCommentBubbleWidth,
        userBubbleMaxWidth,
        skills: props.skills,
      }),
    [
      copiedRowId,
      expandedWorkRows,
      terminalAssistantMessageIds,
      unsettledTurnId,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      userBubbleMaxWidth,
      onCopyWorkRow,
      onMarkdownLinkPress,
      onPressImage,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkRow,
      props.environmentId,
      props.skills,
    ],
  )

  if (props.contentPresentation.kind === 'unavailable')
  {
    return (
      <ThreadFeedPlaceholder
        title={props.contentPresentation.title}
        detail={props.contentPresentation.detail}
        topInset={topContentInset}
        bottomInset={bottomContentInset}
        horizontalPadding={horizontalPadding}
      />
    )
  }

  return (
    <>
      <View className="flex-1" onLayout={handleViewportLayout}>
        <View className="flex-1">
          <KeyboardAwareLegendList
            ref={props.listRef}
            // the empty<->filled key remounts the list when messages first
            // arrive. LegendList's maintainScrollAtEnd calls scrollToEnd(),
            // which is blind to UIKit's adjustedContentInset — inserting into
            // an already-attached list under a transparent header can pin
            // short content at offset 0 (one header-height too high). A fresh
            // mount positions during attach, where UIKit applies the inset.
            key={listMountKey}
            style={{ flex: 1 }}
            // RN 0.81+ drops touches inside the contentInset area
            // (facebook/react-native#54123); the anchored end space after a send
            // is pure inset, so without this the blank region can't be scrolled.
            applyWorkaroundForContentInsetHitTestBug
            contentInsetAdjustmentBehavior={usesNativeAutomaticInsets ? 'automatic' : 'never'}
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            {...(usesNativeAutomaticInsets
              ? {
                  // do NOT pass a manual `contentInset` here. Like the Home
                  // ScrollView, we rely purely on `contentInsetAdjustmentBehavior:
                  // "automatic"` so UIKit derives the top inset from the transparent
                  // header. A manual contentInset (which LegendList consumes into its
                  // own layout math) collapses the scroll view's adjustedContentInset
                  // top to 0, leaving the iOS 26/27 scroll-edge effect no region to
                  // render into — which is why the header blur was missing on threads.
                  scrollIndicatorInsets: { top: 0, left: 0, right: 0, bottom: 0 },
                }
              : { scrollIndicatorInsets: { top: topContentInset, bottom: 0 } })}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            itemLayoutAnimation={feedItemLayoutTransition}
            // patched LegendList prop (patches/@legendapp__list@3.2.0.patch):
            // lets its scroll math clamp programmatic scrolls to -headerInset
            // instead of 0, so initialScrollAtEnd/maintainScrollAtEnd on short
            // content rest below the transparent header rather than at frame top.
            contentInsetStartAdjustment={usesNativeAutomaticInsets ? anchorTopInset : 0}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            // UIKit's automatic behavior adds the safe-area bottom on top of the
            // raw contentInset the keyboard integration writes. The detail screen
            // under-reports the composer inset by this amount (see
            // ThreadDetailScreen); this tells LegendList's scroll math about the
            // extra so programmatic end scrolls land at the true resting offset.
            contentInsetEndStaticAdjustment={usesNativeAutomaticInsets ? insets.bottom : 0}
            // the keyboard integration's offset math (end pinning, max scroll)
            // must add the same UIKit-added extra, or its keyboard-open end
            // targets land one safe-area short of the true resting offset.
            adjustedInsetCompensation={usesNativeAutomaticInsets ? insets.bottom : 0}
            freeze={props.freeze}
            // animated: on send, the optimistic message's dataChange fires
            // maintainScrollAtEnd before any render-cycle suppression could
            // engage — an instant snap there teleports the feed to the anchor
            // instead of scrolling to it. Keeping it enabled (animated) during
            // anchor scrolls also lets it correct a scroll that landed on a
            // stale end target once the anchor row finishes measuring.
            maintainScrollAtEnd={
              disclosureToggleSettling
                ? false
                : {
                    animated: true,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
            }
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            data={presentedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) =>
              entry.type === 'message' ? `message:${entry.message.role}` : entry.type
            }
            getFixedItemSize={getFixedItemSize}
            // measure rows before they enter the viewport
            drawDistance={500}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior="whenAtEnd"
            // seed the list's scroll math with the real viewport before its own
            // onLayout: the empty->filled remount can then tell at mount that
            // short content underflows the viewport and skip programmatic
            // positioning entirely (any offset write during screen attach races
            // UIKit's adjustedContentInset application and lands high or low).
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            // RN's native scrollTo command clamps targets to a floor of
            // -contentInset.top using the RAW inset — under automatic insets the
            // header inset only exists in adjustedContentInset, so scrolls to
            // negative offsets (content top below the transparent header) get
            // clamped to 0. This prop disables that clamp; UIKit still bounces
            // user overscroll back to the adjusted rest position.
            scrollToOverflowEnabled
            estimatedItemSize={180}
            // bottom-align threads shorter than the viewport
            alignItemsAtEnd
            initialScrollAtEnd
            onScroll={handleScroll}
            scrollEventThrottle={16}
            ListHeaderComponent={
              usesNativeAutomaticInsets ? null : <View style={{ height: topContentInset }} />
            }
            contentContainerStyle={{
              paddingTop: 12,
              paddingHorizontal: contentHorizontalPadding,
            }}
          />
        </View>
        {props.feed.length === 0 &&
        props.activeWorkStartedAt === null &&
        props.contentPresentation.kind === 'ready' ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ThreadFeedPlaceholder
              title="No conversation yet"
              detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
              topInset={topContentInset}
              bottomInset={bottomContentInset}
              horizontalPadding={horizontalPadding}
            />
          </View>
        ) : null}
      </View>

      <ImageViewing
        images={
          expandedImage
            ? [
                {
                  uri: expandedImage.uri,
                  headers: expandedImage.headers,
                },
              ]
            : []
        }
        imageIndex={0}
        visible={expandedImage !== null}
        onRequestClose={() => setExpandedImage(null)}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </>
  )
})
