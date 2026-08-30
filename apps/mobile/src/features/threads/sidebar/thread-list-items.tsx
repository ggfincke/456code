// apps/mobile/src/features/threads/sidebar/thread-list-items.tsx
// render thread list items

import { useRecyclingState } from '@legendapp/list/react-native'
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from '@t3tools/client-runtime/state/shell'
import type { MenuAction } from '@react-native-menu/menu'
import { SymbolView } from '../../../components/AppSymbol'
import { memo, useCallback, useMemo, type ComponentProps } from 'react'
import { Pressable, useColorScheme, useWindowDimensions, View } from 'react-native'
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable'
import Svg, { Circle, Path } from 'react-native-svg'

import { AppText as Text } from '../../../components/AppText'
import { ControlPillMenu } from '../../../components/ControlPill'
import { ProjectFavicon } from '../../../components/ProjectFavicon'
import { cn } from '../../../lib/cn'
import { relativeTime } from '../../../lib/time'
import { useNowMinute } from '../../../lib/useNowMinute'
import { useThemeColor } from '../../../lib/useThemeColor'
import type { PendingNewTask } from '../../../state/use-pending-new-tasks'
import { useThreadOutboxFailureReason } from '../../../state/use-thread-outbox'
import { useThreadPr, type ThreadPr } from '../../../state/use-thread-pr'
import type { HomeGroupDisplayAction } from '../../home/homeListItems'
import { ThreadSwipeable } from '../../home/thread-swipe-actions'
import { resolveThreadStatus } from '../threadPresentation'
import type { EnvironmentThreadSearchMatch } from '@t3tools/client-runtime/state/thread-search'
import { ThreadSearchMatchExcerpt } from './thread-search-match'

// shared presentation for the thread lists: the compact (phone) Home list and
// the iPad sidebar render the SAME items — group headers with collapse,
// thread rows with status/PR/subtitle, and show-more rows — differing only in
// metrics and chrome via `variant`.
export type ThreadListVariant = 'compact' | 'sidebar'

// left inset that aligns compact secondary rows with the title column.
export const THREAD_LIST_COMPACT_INSET = 20
const SIDEBAR_ROW_RADIUS = 12

function pullRequestTintColor(
  state: ThreadPr['state'],
  colorScheme: ReturnType<typeof useColorScheme>,
)
{
  const dark = colorScheme === 'dark'
  switch (state)
  {
    case 'open':
      return dark ? '#34d399' : '#059669'
    case 'merged':
      return dark ? '#a78bfa' : '#7c3aed'
    case 'closed':
      return dark ? '#a1a1aa' : '#71717a'
  }
}

function PullRequestIcon(props: { readonly size: number; readonly color: string })
{
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={18} cy={18} r={3} />
      <Circle cx={6} cy={6} r={3} />
      <Path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <Path d="M6 9v12" />
    </Svg>
  )
}

// ─── Project group header ─────────────────────────────────────────────

export const ThreadListGroupHeader = memo(function ThreadListGroupHeader(props: {
  readonly variant: ThreadListVariant
  readonly project: EnvironmentProject
  readonly title: string
  readonly threadCount: number
  readonly collapsed: boolean
  readonly isFirst: boolean
  readonly groupKey: string
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void
  // project a quick new thread should target; null hides the button.
  readonly newThreadTarget?: EnvironmentProject | null
  readonly onNewThread?: (project: EnvironmentProject) => void
})
{
  const iconMutedColor = useThemeColor('--color-icon-muted')
  const { groupKey, onGroupAction, onNewThread } = props
  const newThreadTarget = props.newThreadTarget ?? null
  const compact = props.variant === 'compact'
  const handleToggle = useCallback(
    () => onGroupAction(groupKey, 'toggle-collapsed'),
    [groupKey, onGroupAction],
  )
  const handleNewThread = useCallback(() =>
  {
    if (newThreadTarget)
    {
      onNewThread?.(newThreadTarget)
    }
  }, [newThreadTarget, onNewThread])
  const showNewThreadButton = onNewThread !== undefined && newThreadTarget !== null

  // the new-thread button is a SIBLING of the collapse toggle, not a child:
  // nested touchables are unreachable to VoiceOver/TalkBack (the parent
  // swallows focus). Row padding lives on the container (explicit styles —
  // dynamic padding classes on Pressable did not apply reliably) so both
  // children share one centerline; hitSlop restores the padded tap area.
  const verticalHitSlop = { top: props.isFirst ? 8 : 24, bottom: 12 }
  return (
    <View
      className={compact ? 'flex-row items-center bg-screen' : 'flex-row items-center'}
      style={{
        minHeight: compact ? 44 : 36,
        paddingLeft: compact ? 20 : 12,
        // compact right padding centers the 20pt plus glyph on the thread
        // rows' trailing chevron column (18 + 13/2 ≈ 24.5 from the edge).
        paddingRight: compact ? 14 : 12,
        paddingBottom: compact ? 12 : 8,
        paddingTop: props.isFirst ? (compact ? 8 : 4) : compact ? 24 : 20,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        accessibilityLabel={`${props.title}, ${props.threadCount} threads`}
        accessibilityHint={props.collapsed ? 'Expands the project' : 'Collapses the project'}
        className={
          compact ? 'flex-1 flex-row items-center gap-2.5' : 'flex-1 flex-row items-center gap-2'
        }
        hitSlop={{ ...verticalHitSlop, left: compact ? 20 : 12 }}
        onPress={handleToggle}
      >
        <ProjectFavicon
          environmentId={props.project.environmentId}
          size={compact ? 22 : 18}
          projectTitle={props.project.title}
          workspaceRoot={props.project.workspaceRoot}
        />
        <Text
          className={
            compact
              ? 'flex-shrink text-base font-sans-bold tracking-[0.2px] text-foreground-muted'
              : 'flex-shrink text-sm font-sans-bold tracking-[0.2px] text-foreground-muted'
          }
          numberOfLines={1}
        >
          {props.title}
        </Text>
        <Text
          className={
            compact
              ? 'flex-1 text-sm font-sans-medium text-foreground-tertiary'
              : 'flex-1 text-xs font-sans-medium text-foreground-tertiary'
          }
        >
          {props.threadCount}
        </Text>
      </Pressable>
      {showNewThreadButton ? (
        <Pressable
          accessibilityLabel={`Create new thread in ${props.title}`}
          accessibilityRole="button"
          hitSlop={{ ...verticalHitSlop, left: 10, right: 14 }}
          onPress={handleNewThread}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingLeft: 12 })}
        >
          <SymbolView
            name="plus"
            size={compact ? 20 : 16}
            tintColor={iconMutedColor}
            type="monochrome"
            weight="medium"
          />
        </Pressable>
      ) : null}
    </View>
  )
})

// ─── Show more / show less row ────────────────────────────────────────

export const ThreadListShowMoreRow = memo(function ThreadListShowMoreRow(props: {
  readonly variant: ThreadListVariant
  readonly hiddenCount: number
  readonly canShowLess: boolean
  readonly groupKey: string
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void
})
{
  const iconSubtleColor = useThemeColor('--color-icon-subtle')
  const showsMore = props.hiddenCount > 0
  const compact = props.variant === 'compact'
  const { groupKey, onGroupAction } = props
  const handleShowMore = useCallback(
    () => onGroupAction(groupKey, 'show-more'),
    [groupKey, onGroupAction],
  )
  const handleShowLess = useCallback(
    () => onGroupAction(groupKey, 'show-less'),
    [groupKey, onGroupAction],
  )

  const button = (label: string, icon: 'chevron.down' | 'chevron.up', onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === 'Show more' ? 'Show more threads' : 'Show fewer threads'}
      className="rounded-full bg-subtle"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.6 : 1,
        paddingHorizontal: compact ? 14 : 12,
        paddingVertical: compact ? 7 : 6,
        borderCurve: 'continuous',
      })}
    >
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name={icon}
          size={10}
          tintColor={iconSubtleColor}
          type="monochrome"
          weight="semibold"
        />
        <Text
          className={
            compact
              ? 'text-sm font-sans-medium text-foreground-muted'
              : 'text-xs font-sans-medium text-foreground-muted'
          }
        >
          {label}
        </Text>
      </View>
    </Pressable>
  )

  return (
    <View
      className={
        compact ? 'flex-row items-center gap-2.5 bg-screen' : 'flex-row items-center gap-2'
      }
      style={{
        paddingLeft: compact ? THREAD_LIST_COMPACT_INSET : 12,
        paddingRight: compact ? 18 : 12,
        paddingVertical: compact ? 12 : 8,
      }}
    >
      {showsMore ? button('Show more', 'chevron.down', handleShowMore) : null}
      {props.canShowLess ? button('Show less', 'chevron.up', handleShowLess) : null}
    </View>
  )
})

// ─── Queued delivery failure ──────────────────────────────────────────

// one presentation for queued work that gave up: a failed pending task and a
// thread holding a failed queued message read the same way in the list.
function QueuedFailurePill()
{
  return (
    <View className="rounded-full bg-adaptive-rose-500-a12-a16 px-1.5 py-0.5">
      <Text className="text-3xs font-sans-bold text-adaptive-rose-700-300">Failed</Text>
    </View>
  )
}

// the failure reason replaces the row subtitle: it is the one thing the user
// needs before deciding to edit, retry, or delete the row.
function QueuedFailureSubtitle(props: { readonly compact: boolean; readonly reason: string })
{
  const dangerColor = useThemeColor('--color-danger-foreground')
  return (
    <View className="mt-px flex-row items-center gap-1.5">
      <SymbolView
        name="exclamationmark.triangle"
        size={10}
        tintColor={dangerColor}
        type="monochrome"
      />
      <Text
        className={cn('shrink text-danger-foreground', props.compact ? 'text-sm' : 'text-xs')}
        numberOfLines={1}
      >
        {props.reason}
      </Text>
    </View>
  )
}

// ─── Pending task row ─────────────────────────────────────────────────

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: 'delete', title: 'Delete', image: 'trash', attributes: { destructive: true } },
]

// how a queued creation reads in the list. A row that exhausted delivery is the
// only place the outbox surfaces that outcome, and "Pending" there reads as
// "still on its way" — so a failed row is labelled as failed, carries its
// reason, and says both in the accessible name.
export function describePendingTaskStatus(pendingTask: PendingNewTask): {
  readonly failed: boolean
  readonly badge: string
  readonly reason: string | null
  readonly accessibilityLabel: string
}
{
  const failure = pendingTask.message.failure
  if (failure === undefined)
  {
    return {
      failed: false,
      badge: 'Pending',
      reason: null,
      accessibilityLabel: `${pendingTask.title}, pending`,
    }
  }
  const reason = failure.reason.trim()
  const resolvedReason = reason.length > 0 ? reason : 'The queued task could not be created.'
  return {
    failed: true,
    badge: 'Failed',
    reason: resolvedReason,
    accessibilityLabel: `${pendingTask.title}, failed: ${resolvedReason}`,
  }
}

// a queued new task waiting in the outbox for its environment to reconnect.
// tapping reopens the new-task composer with everything prefilled; the row
// disappears once the task is delivered and the real thread arrives.
export const PendingTaskListRow = memo(function PendingTaskListRow(props: {
  readonly variant: ThreadListVariant
  readonly pendingTask: PendingNewTask
  readonly environmentLabel: string | null
  readonly isLast: boolean
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void
})
{
  const compact = props.variant === 'compact'
  const separatorColor = useThemeColor('--color-separator')
  const iconSubtleColor = useThemeColor('--color-icon-subtle')
  const mutedColor = useThemeColor('--color-foreground-muted')
  const pressedBackgroundColor = useThemeColor('--color-subtle')

  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props
  const timestamp = relativeTime(pendingTask.message.createdAt)
  const status = describePendingTaskStatus(pendingTask)
  const subtitleParts = [props.environmentLabel, pendingTask.creation.branch].filter(
    (part): part is string => Boolean(part),
  )
  const accessibilityHint = status.failed
    ? 'Opens the failed task for editing, or long press to delete it'
    : 'Opens the queued task for editing'

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) =>
    {
      if (nativeEvent.event === 'delete') onDeletePendingTask(pendingTask)
    },
    [onDeletePendingTask, pendingTask],
  )

  const statusPill = status.failed ? (
    <QueuedFailurePill />
  ) : (
    <View className="rounded-full bg-adaptive-zinc-500-a12-a16 px-1.5 py-0.5">
      <Text className="text-3xs font-sans-bold text-adaptive-zinc-600-300">{status.badge}</Text>
    </View>
  )

  const subtitleRow = status.reason ? (
    <QueuedFailureSubtitle compact={compact} reason={status.reason} />
  ) : subtitleParts.length > 0 ? (
    <View className="mt-px flex-row items-center gap-1.5">
      <SymbolView
        name="tray.and.arrow.up"
        size={10}
        tintColor={compact ? iconSubtleColor : mutedColor}
        type="monochrome"
      />
      <Text
        className={
          compact ? 'shrink text-sm text-foreground-muted' : 'shrink text-xs text-foreground-muted'
        }
        numberOfLines={1}
      >
        {subtitleParts.join(' · ')}
      </Text>
    </View>
  ) : null

  const rowContent = compact ? (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={status.accessibilityLabel}
      accessibilityRole="button"
      className="bg-screen"
      onPress={() => onSelectPendingTask(pendingTask)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          paddingLeft: THREAD_LIST_COMPACT_INSET,
          paddingRight: 18,
          paddingTop: 10,
        }}
      >
        <View
          style={{
            gap: 3,
            borderBottomWidth: props.isLast ? 0 : 1,
            borderBottomColor: separatorColor,
            paddingBottom: 10,
          }}
        >
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-lg font-sans-bold text-foreground" numberOfLines={1}>
              {pendingTask.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
              <SymbolView
                name="chevron.right"
                size={13}
                tintColor={iconSubtleColor}
                type="monochrome"
              />
            </View>
          </View>
          {subtitleRow}
        </View>
      </View>
    </Pressable>
  ) : (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={status.accessibilityLabel}
      accessibilityRole="button"
      onPress={() => onSelectPendingTask(pendingTask)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? pressedBackgroundColor : 'transparent',
        borderRadius: SIDEBAR_ROW_RADIUS,
        cursor: 'pointer',
        minHeight: 64,
        justifyContent: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
      })}
    >
      <View className="gap-[3px]">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-base font-sans-medium text-foreground" numberOfLines={1}>
            {pendingTask.title}
          </Text>
          <View className="flex-row items-center gap-2">
            {statusPill}
            <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={1}>
              {timestamp}
            </Text>
          </View>
        </View>
        {subtitleRow}
      </View>
    </Pressable>
  )

  return (
    <ControlPillMenu
      actions={PENDING_TASK_MENU_ACTIONS}
      onPressAction={handleMenuAction}
      shouldOpenOnLongPress
    >
      {rowContent}
    </ControlPillMenu>
  )
})

// ─── Thread row ───────────────────────────────────────────────────────

const THREAD_ROW_MENU_ACTIONS: MenuAction[] = [
  { id: 'archive', title: 'Archive', image: 'archivebox' },
  { id: 'delete', title: 'Delete', image: 'trash', attributes: { destructive: true } },
]

export const ThreadListRow = memo(function ThreadListRow(props: {
  readonly variant: ThreadListVariant
  readonly thread: EnvironmentThreadShell
  readonly environmentLabel: string | null
  readonly projectCwd: string | null
  readonly isLast: boolean
  readonly searchMatch?: EnvironmentThreadSearchMatch | null
  readonly searchQuery?: string
  // sidebar only: the thread currently open in the detail pane.
  readonly selected?: boolean
  // defaults to window width minus compact margins.
  readonly fullSwipeWidth?: number
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void
  readonly onSwipeableClose: (methods: SwipeableMethods) => void
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >['simultaneousWithExternalGesture']
})
{
  const { width: windowWidth } = useWindowDimensions()
  const colorScheme = useColorScheme()
  const compact = props.variant === 'compact'
  const selected = props.selected === true
  // recycling-safe: resets when the list container is reused for another
  // thread, so a hover highlight can't leak across rows.
  const [hovered, setHovered] = useRecyclingState(false)

  const separatorColor = useThemeColor('--color-separator')
  const iconSubtleColor = useThemeColor('--color-icon-subtle')
  const screenColor = useThemeColor('--color-screen')
  const drawerColor = useThemeColor('--color-drawer')
  const pressedBackgroundColor = useThemeColor('--color-subtle')
  const selectedBackgroundColor = useThemeColor('--color-user-bubble')

  const { thread, onSelectThread, onArchiveThread, onDeleteThread } = props
  // subscribed per row rather than passed down: useNowMinute is one module
  // timer fanned out through useSyncExternalStore, so a row costs a Set entry
  // while a prop would re-render the whole list on every tick.
  const nowMinute = useNowMinute()
  const status = resolveThreadStatus(thread, { nowMs: Date.parse(`${nowMinute}:00.000Z`) })
  const pr = useThreadPr(thread, props.projectCwd)
  // a queued message that exhausted delivery reports here: the thread may never
  // be opened, and the composer detail surface is only visible once it is.
  const queuedFailureReason = useThreadOutboxFailureReason(thread.environmentId, thread.id)
  const timestamp = relativeTime(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)
  const searchLabel = props.searchMatch
    ? `, ${props.searchMatch.source === 'user' ? 'You' : 'Agent'}: ${props.searchMatch.snippet}`
    : ''
  const prAccessibilityLabel =
    (pr ? `${thread.title}, ${pr.accessibilityLabel}` : thread.title) + searchLabel
  const threadAccessibilityLabel =
    queuedFailureReason === null
      ? prAccessibilityLabel
      : `${prAccessibilityLabel}, failed: ${queuedFailureReason}`
  const subtitleParts = [props.environmentLabel, thread.branch].filter((part): part is string =>
    Boolean(part),
  )

  const backgroundColor = compact ? screenColor : drawerColor
  const effectivePressedBackground = selected ? 'rgba(255,255,255,0.16)' : pressedBackgroundColor
  const effectiveStatus =
    selected && status
      ? { ...status, pillClassName: 'bg-white/20', textClassName: 'text-white' }
      : status

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread])
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread])
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `Archive ${thread.title}`,
      icon: 'archivebox' as const,
      label: 'Archive',
      onPress: handleArchive,
    }),
    [handleArchive, thread.title],
  )
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) =>
    {
      if (nativeEvent.event === 'archive') handleArchive()
      if (nativeEvent.event === 'delete') handleDelete()
    },
    [handleArchive, handleDelete],
  )

  // a failed queued message outranks the live status pill: it is the state the
  // user has to act on, and the row is the only place it is announced.
  const statusPill =
    queuedFailureReason !== null ? (
      <QueuedFailurePill />
    ) : effectiveStatus ? (
      <View className={`${effectiveStatus.pillClassName} rounded-full px-1.5 py-0.5`}>
        <Text className={`text-3xs font-sans-bold ${effectiveStatus.textClassName}`}>
          {effectiveStatus.label}
        </Text>
      </View>
    ) : null

  const metadataRow =
    queuedFailureReason !== null ? (
      <QueuedFailureSubtitle compact={compact} reason={queuedFailureReason} />
    ) : subtitleParts.length > 0 || pr !== null ? (
      <View className="mt-px flex-row items-center gap-1.5">
        {subtitleParts.length > 0 ? (
          <>
            <Text
              className={cn(
                'shrink',
                compact ? 'text-sm text-foreground-muted' : 'text-xs',
                !compact &&
                  (selected ? 'text-user-bubble-foreground-muted' : 'text-foreground-muted'),
              )}
              numberOfLines={1}
            >
              {subtitleParts.join(' · ')}
            </Text>
          </>
        ) : null}
        {pr !== null ? (
          <View className="flex-row items-center gap-0.5">
            <PullRequestIcon
              size={compact ? 13 : 11}
              color={selected ? '#ffffff' : pullRequestTintColor(pr.state, colorScheme)}
            />
            <Text
              className={`${compact ? 'text-sm' : 'text-xs'} font-sans-medium ${
                selected ? 'text-white' : pr.textClassName
              }`}
            >
              {pr.label}
            </Text>
          </View>
        ) : null}
      </View>
    ) : null

  const subtitleRow = (
    <>
      {props.searchMatch ? (
        <ThreadSearchMatchExcerpt
          match={props.searchMatch}
          query={props.searchQuery ?? ''}
          compact={compact}
          selected={selected}
        />
      ) : null}
      {metadataRow}
    </>
  )

  const rowContent = (close: () => void) =>
    compact ? (
      <Pressable
        accessibilityHint="Swipe left for archive and delete actions"
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        className="bg-screen"
        onPress={() =>
          {
          close()
          onSelectThread(thread)
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View
          style={{
            paddingLeft: THREAD_LIST_COMPACT_INSET,
            paddingRight: 18,
            paddingTop: 10,
          }}
        >
          <View
            style={{
              gap: 3,
              borderBottomWidth: props.isLast ? 0 : 1,
              borderBottomColor: separatorColor,
              paddingBottom: 10,
            }}
          >
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 text-lg font-sans-bold text-foreground" numberOfLines={1}>
                {thread.title}
              </Text>
              <View className="flex-row items-center gap-2">
                {statusPill}
                <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
                <SymbolView
                  name="chevron.right"
                  size={13}
                  tintColor={iconSubtleColor}
                  type="monochrome"
                />
              </View>
            </View>
            {subtitleRow}
          </View>
        </View>
      </Pressable>
    ) : (
      <Pressable
        accessibilityHint="Opens the thread"
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() =>
          {
          close()
          onSelectThread(thread)
        }}
        style={({ pressed }) => ({
          backgroundColor: selected
            ? selectedBackgroundColor
            : pressed || hovered
              ? effectivePressedBackground
              : backgroundColor,
          borderRadius: SIDEBAR_ROW_RADIUS,
          cursor: 'pointer',
          minHeight: 64,
          justifyContent: 'center',
          paddingHorizontal: 12,
          paddingVertical: 10,
        })}
      >
        <View className="gap-[3px]">
          <View className="flex-row items-center justify-between gap-2">
            <Text
              className={cn(
                'flex-1 text-base font-sans-medium',
                selected ? 'text-user-bubble-foreground' : 'text-foreground',
              )}
              numberOfLines={1}
            >
              {thread.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              <Text
                className={cn(
                  'text-xs tabular-nums',
                  selected ? 'text-user-bubble-foreground-muted' : 'text-foreground-muted',
                )}
                numberOfLines={1}
              >
                {timestamp}
              </Text>
            </View>
          </View>
          {subtitleRow}
        </View>
      </Pressable>
    )

  return (
    <ThreadSwipeable
      backgroundColor={backgroundColor}
      containerStyle={
        compact ? undefined : { borderRadius: SIDEBAR_ROW_RADIUS, overflow: 'hidden' }
      }
      enableTrackpadSwipe
      fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
      onDelete={handleDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={primaryAction}
      resetKey={`${thread.environmentId}:${thread.id}`}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={thread.title}
    >
      {(close) => (
        // messages-style row actions on long-press using a real
        // UIContextMenuInteraction with the row as the zoom preview (needs the
        // patched @react-native-menu, see
        // patches/@react-native-menu__menu@2.0.0.patch — in long-press mode the
        // interaction is hosted by the component view and the underlying
        // UIButton passes touches through, so row taps and swipes keep working).
        <ControlPillMenu
          actions={THREAD_ROW_MENU_ACTIONS}
          onPressAction={handleMenuAction}
          shouldOpenOnLongPress
        >
          {rowContent(close)}
        </ControlPillMenu>
      )}
    </ThreadSwipeable>
  )
})
