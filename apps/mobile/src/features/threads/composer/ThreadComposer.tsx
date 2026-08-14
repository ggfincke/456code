// apps/mobile/src/features/threads/composer/ThreadComposer.tsx
// renders and controls the mobile thread message composer
import {
  CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
  normalizeCollaborationMode,
  type CollaborationMode,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ServerConfig,
  type ServerProviderSkill,
} from '@t3tools/contracts'
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from '@t3tools/shared/composerTrigger'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ActivityIndicator, Image, Platform, Pressable, useColorScheme, View } from 'react-native'
import ImageViewing from 'react-native-image-viewing'
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown } from 'react-native-reanimated'
import { useThemeColor } from '../../../lib/useThemeColor'
import { armAgentAwarenessLiveActivityForLocalWork } from '../../agent-awareness/remoteRegistration'
import { scopedThreadKey } from '../../../lib/scopedEntities'

import { AppText as Text } from '../../../components/AppText'
import { ComposerAttachmentStrip } from '../../../components/ComposerAttachmentStrip'
import {
  ComposerEditor,
  composerEditorCapabilities,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from '../../../components/ComposerEditor'
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
  ComposerToolbarTrigger,
} from '../../../components/ComposerToolbarTrigger'
import { ControlPill, ControlPillMenu } from '../../../components/ControlPill'
import { ProviderIcon } from '../../../components/ProviderIcon'
import type { DraftComposerImageAttachment } from '../../../lib/composerImages'
import { buildModelOptions, groupByProvider } from '../../../lib/modelOptions'
import { useScaledTextRole } from '../../settings/appearance/useScaledTextRole'
import type { RemoteClientConnectionState } from '../../../lib/connection'
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from '@t3tools/shared/searchRanking'
import {
  applyProviderOptionMenuEvent,
  buildProviderOptionMenuActions,
  providerOptionsConfigurationLabel,
  resolveProviderOptionDescriptors,
} from '../../../lib/providerOptions'
import {
  providerSwitchSuppressesStop,
  type ThreadProviderSwitchNotice,
} from '../../../lib/thread-activity/provider-switch'
import { useComposerPathSearch } from '../../../state/use-composer-path-search'
import { ComposerCommandPopover, type ComposerCommandItem } from './ComposerCommandPopover'
import { composerConnectionStatus, type ComposerStatusPillState } from './threadComposerStatus'
import { resolveComposerSubmitHandler } from './threadComposerSubmit'
import { COMPOSER_LAYOUT_TRANSITION, ComposerSurface } from './composerSurface'
export { ComposerSurface } from './composerSurface'

function searchMobileComposerSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  query: string,
): ComposerCommandItem[]
{
  const enabledSkills = skills.filter((s) => s.enabled)
  const normalizedQuery = normalizeSearchQuery(query, {
    trimLeadingPattern: /^\$+/,
  })

  if (!normalizedQuery)
  {
    return enabledSkills.slice(0, 20).map((skill) => ({
      id: `skill:${skill.name}`,
      type: 'skill' as const,
      skill,
      label: skill.displayName ?? skill.name,
      description: skill.shortDescription ?? skill.description ?? '',
    }))
  }

  const ranked: Array<{
    item: (typeof enabledSkills)[number]
    score: number
    tieBreaker: string
  }> = []
  for (const skill of enabledSkills)
  {
    const displayLabel = (skill.displayName ?? skill.name).toLowerCase()
    const scores = [
      scoreQueryMatch({
        value: skill.name.toLowerCase(),
        query: normalizedQuery,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: ['-', '_', '/'],
      }),
      scoreQueryMatch({
        value: displayLabel,
        query: normalizedQuery,
        exactBase: 1,
        prefixBase: 3,
        boundaryBase: 5,
        includesBase: 7,
        fuzzyBase: 110,
      }),
      scoreQueryMatch({
        value: skill.shortDescription?.toLowerCase() ?? '',
        query: normalizedQuery,
        exactBase: 20,
        prefixBase: 22,
        boundaryBase: 24,
        includesBase: 26,
      }),
      scoreQueryMatch({
        value: skill.description?.toLowerCase() ?? '',
        query: normalizedQuery,
        exactBase: 30,
        prefixBase: 32,
        boundaryBase: 34,
        includesBase: 36,
      }),
    ].filter((s): s is number => s !== null)

    if (scores.length > 0)
    {
      insertRankedSearchResult(
        ranked,
        {
          item: skill,
          score: Math.min(...scores),
          tieBreaker: `${displayLabel}\u0000${skill.name}`,
        },
        20,
      )
    }
  }

  return ranked.map(({ item: skill }) => ({
    id: `skill:${skill.name}`,
    type: 'skill' as const,
    skill,
    label: skill.displayName ?? skill.name,
    description: skill.shortDescription ?? skill.description ?? '',
  }))
}

// height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
// exported so the parent can compute feed overlap / content insets.
export const COMPOSER_COLLAPSED_CHROME = 60

// height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
// used by the parent to compute the larger feed bottom inset when the composer is focused.
export const COMPOSER_EXPANDED_CHROME = 174

export interface ThreadComposerProps
{
  readonly draftMessage: string
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>
  readonly placeholder: string
  readonly contentMaxWidth?: number
  readonly bottomInset?: number
  readonly connectionState: RemoteClientConnectionState
  readonly connectionError: string | null
  readonly environmentLabel: string | null
  // message sync phase for the selected thread (drives the status pill):
  // "loading" = first fetch, nothing to show yet; "syncing" = cached messages
  // are on screen while they reconcile with the server.
  readonly threadSyncPhase?: 'loading' | 'syncing' | null
  readonly selectedThread: OrchestrationThreadShell
  readonly serverConfig: ServerConfig | null
  readonly queueCount: number
  readonly queueFailureReason: string | null
  readonly activeThreadBusy: boolean
  readonly sendBlockedReason: string | null
  readonly providerSwitchActive: boolean
  readonly providerSwitchNotice: ThreadProviderSwitchNotice | null
  readonly environmentId: EnvironmentId
  readonly projectCwd: string | null
  readonly editorRef?: RefObject<ComposerEditorHandle | null>
  readonly onChangeDraftMessage: (value: string) => void
  readonly onPickDraftImages: () => Promise<void>
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>
  readonly onRemoveDraftImage: (imageId: string) => void
  readonly onStopThread: () => void
  readonly onSendMessage: () => Promise<MessageId | null>
  readonly onDiscardQueuedMessage: () => void
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void
  readonly onUpdateInteractionMode: (interactionMode: CollaborationMode) => void
  readonly onRetryProviderSwitch: () => void
  readonly onDismissProviderSwitchNotice: () => void
  readonly onReconnectEnvironment: () => void
  readonly onExpandedChange?: (expanded: boolean) => void
}

const ComposerConnectionStatusPill = memo(function ComposerConnectionStatusPill(props: {
  readonly onPress: () => void
  readonly status: ComposerStatusPillState
})
{
  if (props.status.kind === 'blocked')
  {
    return (
      <Animated.View
        className="absolute inset-x-0 bottom-full items-center pb-2"
        entering={FadeInDown.duration(180)}
        exiting={FadeOutDown.duration(140)}
        pointerEvents="box-none"
      >
        <View
          accessibilityLiveRegion="polite"
          className="max-w-full flex-row items-center gap-2 rounded-2xl bg-white/95 px-3 py-2 shadow-sm dark:bg-neutral-900/95"
        >
          <View className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          <Text className="max-w-[300px] text-sm font-sans-bold leading-snug text-foreground">
            {props.status.label}
          </Text>
        </View>
      </Animated.View>
    )
  }

  const isReconnecting = props.status.kind !== 'unavailable'

  return (
    <Animated.View
      className="absolute inset-x-0 bottom-full items-center pb-2"
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="button"
        onPress={props.onPress}
        className="max-w-full flex-row items-center gap-2 rounded-full bg-white/90 px-3 py-2 shadow-sm active:opacity-70 dark:bg-neutral-900/90"
      >
        {isReconnecting ? (
          <ActivityIndicator size="small" color="#8e8e93" />
        ) : (
          <View className="h-2 w-2 rounded-full bg-red-500" />
        )}
        <Text
          className="max-w-[260px] text-sm font-sans-bold leading-snug text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </Pressable>
    </Animated.View>
  )
})

// the thread's single provider-switch surface: an in-flight switch says it
// cannot be cancelled, and an outcome stays on screen until dismissed so a
// completion or a failure is never only a work-log row.
const ComposerProviderSwitchNotice = memo(function ComposerProviderSwitchNotice(props: {
  readonly notice: ThreadProviderSwitchNotice
  readonly onRetry: () => void
  readonly onDismiss: () => void
})
{
  const { notice } = props
  const isFailure = notice.kind === 'failed'

  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      className="pb-2"
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(120)}
    >
      <View
        className={
          isFailure
            ? 'flex-row items-start gap-3 rounded-2xl bg-danger px-3 py-2'
            : 'flex-row items-start gap-3 rounded-2xl bg-subtle px-3 py-2'
        }
      >
        {notice.kind === 'switching' ? <ActivityIndicator size="small" color="#8e8e93" /> : null}
        <View className="min-w-0 flex-1">
          <Text
            className={
              isFailure
                ? 'text-xs font-sans-bold leading-snug text-danger-foreground'
                : 'text-xs font-sans-bold leading-snug text-foreground'
            }
          >
            {notice.label}
          </Text>
          {notice.kind === 'switching' ? (
            <Text className="pt-0.5 text-2xs leading-snug text-foreground-muted">
              {notice.detail}
            </Text>
          ) : null}
          {isFailure && notice.detail !== null ? (
            <Text className="pt-0.5 text-2xs leading-snug text-foreground-muted">
              {notice.detail}
            </Text>
          ) : null}
        </View>
        {isFailure && notice.retrySelection !== null ? (
          <Pressable
            accessibilityLabel="Retry provider switch"
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onRetry}
          >
            <Text className="text-xs font-sans-bold text-danger-foreground">Retry</Text>
          </Pressable>
        ) : null}
        {notice.kind === 'switching' ? null : (
          <Pressable
            accessibilityLabel="Dismiss provider switch notice"
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onDismiss}
          >
            <Text className="text-xs font-sans-bold text-foreground-muted">Dismiss</Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  )
})

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps)
{
  const isDarkMode = useColorScheme() === 'dark'
  const foregroundColor = useThemeColor('--color-foreground')
  const bodyText = useScaledTextRole('body')
  const fallbackInputRef = useRef<ComposerEditorHandle>(null)
  const inputRef = props.editorRef ?? fallbackInputRef
  const [isFocused, setIsFocused] = useState(false)
  const wasExpandedBeforePreviewRef = useRef(false)
  const inFlightThreadIdsRef = useRef(new Set<string>())
  const { onExpandedChange } = props

  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null)
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0
  const isExpanded = isFocused

  const onPressImage = useCallback(
    (uri: string) =>
    {
      wasExpandedBeforePreviewRef.current = isFocused
      setPreviewImageUri(uri)
    },
    [isFocused],
  )

  const closePreview = useCallback(() =>
  {
    setPreviewImageUri(null)
    if (wasExpandedBeforePreviewRef.current)
    {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [inputRef])

  const handleFocus = useCallback(() =>
  {
    setIsFocused(true)
    onExpandedChange?.(true)
  }, [onExpandedChange])

  const handleBlur = useCallback(() =>
  {
    setIsFocused(false)
    onExpandedChange?.(false)
  }, [onExpandedChange])
  // a switch leaves the session running (old provider compacting) or briefly
  // null; neither is a stoppable turn, so the stop affordance stays hidden.
  const showStopAction = !providerSwitchSuppressesStop({
    sessionStatus: props.selectedThread.session?.status,
    providerSwitchActive: props.providerSwitchActive,
  })

  const currentModelSelection = props.selectedThread.modelSelection
  const selectedRuntimeMode = props.selectedThread.runtimeMode
  const selectedInteractionMode = useMemo(
    () =>
      normalizeCollaborationMode(
        props.selectedThread.interactionMode ?? 'default',
        props.selectedThread.orchestrate,
      ),
    [props.selectedThread.interactionMode, props.selectedThread.orchestrate],
  )
  const connectionStatus = composerConnectionStatus({
    connectionError: props.connectionError,
    connectionState: props.connectionState,
    environmentLabel: props.environmentLabel,
    sendBlockedReason: props.sendBlockedReason,
    threadSyncPhase: props.threadSyncPhase,
  })
  const toolbarFadeOpaque = isDarkMode ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)'
  const toolbarFadeTransparent = isDarkMode ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)'
  const selectedProviderStatus = useMemo(() =>
  {
    if (!props.serverConfig) return null
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    )
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId])
  const providerCapabilities =
    selectedProviderStatus?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
  const currentRuntimeMode = providerCapabilities.supportedRuntimeModes.includes(
    selectedRuntimeMode,
  )
    ? selectedRuntimeMode
    : (providerCapabilities.supportedRuntimeModes[0] ?? 'approval-required')
  const showPlanMode = providerCapabilities.supportedInteractionModes.includes('plan')
  const showOrchestrate =
    providerCapabilities.orchestrateInstructionDelivery !== 'unsupported' &&
    providerCapabilities.orchestrateBaseModes.includes(selectedInteractionMode.baseMode)
  const currentInteractionMode = normalizeCollaborationMode(
    showPlanMode && selectedInteractionMode.baseMode === 'plan' ? 'plan' : 'default',
    showOrchestrate && selectedInteractionMode.orchestrate,
  )
  const providerRejectsActiveInput =
    props.activeThreadBusy && providerCapabilities.activeTurnInput === 'unsupported'
  const canSend = hasContent && props.sendBlockedReason === null && !providerRejectsActiveInput
  const sendLabel =
    props.sendBlockedReason !== null
      ? 'Sending blocked'
      : providerRejectsActiveInput
        ? 'Wait for the current turn'
        : props.connectionState !== 'connected' || props.activeThreadBusy || props.queueCount > 0
          ? 'Queue'
          : 'Send'
  const providerSkills = useMemo(
    () =>
      (selectedProviderStatus?.skills ?? []).filter(
        (skill) => skill.name.toLowerCase() !== 'orchestrate',
      ),
    [selectedProviderStatus],
  )
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, currentModelSelection),
    [props.serverConfig, currentModelSelection],
  )

  // ── Trigger detection ────────────────────────────────────
  const [composerSelection, setComposerSelection] = useState(() => ({
    start: props.draftMessage.length,
    end: props.draftMessage.length,
  }))

  const handleSelectionChange = useCallback((selection: ComposerEditorSelection) =>
  {
    setComposerSelection(selection)
  }, [])
  useEffect(() =>
  {
    const end = props.draftMessage.length
    setComposerSelection((selection) =>
    {
      const start = Math.min(selection.start, end)
      const selectionEnd = Math.min(selection.end, end)
      if (start === selection.start && selectionEnd === selection.end)
      {
        return selection
      }
      return { start, end: selectionEnd }
    })
  }, [props.draftMessage.length])

  const composerTrigger = useMemo<ComposerTrigger | null>(() =>
  {
    if (composerSelection.start !== composerSelection.end)
    {
      return null
    }
    return detectComposerTrigger(props.draftMessage, composerSelection.end)
  }, [composerSelection, props.draftMessage])
  const pathSearch = useComposerPathSearch({
    environmentId: props.environmentId,
    cwd: composerTrigger?.kind === 'path' ? props.projectCwd : null,
    query: composerTrigger?.kind === 'path' ? composerTrigger.query : null,
  })

  const composerMenuItems: ComposerCommandItem[] = useMemo(() =>
  {
    if (!composerTrigger) return []

    if (composerTrigger.kind === 'slash-command')
    {
      const q = composerTrigger.query.toLowerCase()
      const allBuiltIn = [
        {
          id: 'cmd:model',
          type: 'slash-command' as const,
          command: 'model',
          label: '/model',
          description: 'Switch model',
        },
        {
          id: 'cmd:plan',
          type: 'slash-command' as const,
          command: 'plan',
          label: '/plan',
          description: 'Switch to plan mode',
        },
        {
          id: 'cmd:orchestrate',
          type: 'slash-command' as const,
          command: 'orchestrate',
          label: '/orchestrate',
          description: 'Enable orchestration',
        },
        {
          id: 'cmd:default',
          type: 'slash-command' as const,
          command: 'default',
          label: '/default',
          description: 'Switch to default mode',
        },
      ]
      const builtIn = allBuiltIn.filter(
        (item) =>
          item.command.includes(q) &&
          (item.command !== 'plan' || showPlanMode) &&
          (item.command !== 'orchestrate' || showOrchestrate),
      )

      const collidingSkillNames = new Set(
        providerSkills.filter((skill) => skill.enabled).map((skill) => skill.name.toLowerCase()),
      )

      const providerCommands: ComposerCommandItem[] = []
      for (const cmd of selectedProviderStatus?.slashCommands ?? [])
      {
        if (collidingSkillNames.has(cmd.name.toLowerCase())) continue
        if (!cmd.name.toLowerCase().includes(q)) continue
        providerCommands.push({
          id: `pcmd:${cmd.name}`,
          type: 'provider-slash-command' as const,
          command: cmd,
          label: `/${cmd.name}`,
          description: cmd.description ?? '',
        })
      }

      const skillItems = searchMobileComposerSkills(providerSkills, composerTrigger.query)

      return [...builtIn, ...providerCommands, ...skillItems]
    }

    if (composerTrigger.kind === 'slash-model')
    {
      const query = composerTrigger.query.toLowerCase()
      return modelOptions
        .filter((option) => `${option.label} ${option.providerLabel}`.toLowerCase().includes(query))
        .map((option) => ({
          id: `model:${option.key}`,
          type: 'model' as const,
          selection: option.selection,
          label: option.label,
          description: option.providerLabel,
        }))
    }

    if (composerTrigger.kind === 'skill')
    {
      return searchMobileComposerSkills(providerSkills, composerTrigger.query)
    }

    if (composerTrigger.kind === 'path')
    {
      return pathSearch.entries.map((entry) =>
      {
        const parts = entry.path.split('/')
        return {
          id: `path:${entry.path}`,
          type: 'path' as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
        }
      })
    }

    return []
  }, [
    composerTrigger,
    modelOptions,
    pathSearch.entries,
    providerSkills,
    selectedProviderStatus,
    showOrchestrate,
    showPlanMode,
  ])

  // ── Handle command selection ──────────────────────────────
  const {
    onChangeDraftMessage,
    onUpdateInteractionMode,
    onUpdateModelSelection,
    draftMessage,
    onSendMessage,
  } = props

  const handleSend = useCallback(async () =>
  {
    if (props.sendBlockedReason !== null || providerRejectsActiveInput)
    {
      return
    }
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id)
    if (inFlightThreadIdsRef.current.has(threadKey)) return
    inFlightThreadIdsRef.current.add(threadKey)
    try
    {
      await onSendMessage()
      // defer live activity work until queued-message feedback is visible
      armAgentAwarenessLiveActivityForLocalWork({
        environmentId: props.environmentId,
        threadId: props.selectedThread.id,
        threadTitle: props.selectedThread.title,
        projectTitle: props.environmentLabel ?? '456code',
      })
    }
    finally
    {
      inFlightThreadIdsRef.current.delete(threadKey)
    }
  }, [
    onSendMessage,
    props.environmentId,
    props.environmentLabel,
    props.sendBlockedReason,
    props.selectedThread.id,
    props.selectedThread.title,
    providerRejectsActiveInput,
  ])
  const handleCommandSelect = useCallback(
    (item: ComposerCommandItem) =>
    {
      if (!composerTrigger) return

      if (item.type === 'model')
      {
        const result = replaceTextRange(
          draftMessage,
          composerTrigger.rangeStart,
          composerTrigger.rangeEnd,
          '',
        )
        setComposerSelection({ start: result.cursor, end: result.cursor })
        onChangeDraftMessage(result.text)
        onUpdateModelSelection(item.selection)
        return
      }

      if (
        item.type === 'slash-command' &&
        (item.command === 'plan' || item.command === 'orchestrate' || item.command === 'default')
      )
      {
        if (item.command === 'plan' && !showPlanMode) return
        if (item.command === 'orchestrate' && !showOrchestrate) return
        const result = replaceTextRange(
          draftMessage,
          composerTrigger.rangeStart,
          composerTrigger.rangeEnd,
          '',
        )
        setComposerSelection({ start: result.cursor, end: result.cursor })
        onChangeDraftMessage(result.text)
        onUpdateInteractionMode(
          item.command === 'default'
            ? { baseMode: 'default', orchestrate: false }
            : item.command === 'plan'
              ? { ...currentInteractionMode, baseMode: 'plan' }
              : { ...currentInteractionMode, orchestrate: true },
        )
        return
      }

      let replacement = ''
      if (item.type === 'path')
      {
        replacement = `${serializeComposerFileLink(item.path)} `
      }
      else if (item.type === 'skill')
      {
        replacement = `$${item.skill.name} `
      }
      else if (item.type === 'slash-command')
      {
        replacement = `/${item.command} `
      }
      else if (item.type === 'provider-slash-command')
      {
        replacement = `/${item.command.name} `
      }

      const result = replaceTextRange(
        draftMessage,
        composerTrigger.rangeStart,
        composerTrigger.rangeEnd,
        replacement,
      )
      setComposerSelection({ start: result.cursor, end: result.cursor })
      onChangeDraftMessage(result.text)
    },
    [
      composerTrigger,
      currentInteractionMode,
      draftMessage,
      onChangeDraftMessage,
      onUpdateInteractionMode,
      onUpdateModelSelection,
      showOrchestrate,
      showPlanMode,
    ],
  )

  // ── Model menu ───────────────────────────────────────────
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions])
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null
  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  )
  const configurationLabel = useMemo(
    () => providerOptionsConfigurationLabel(providerOptionDescriptors),
    [providerOptionDescriptors],
  )
  const modelMenuActions = useMemo(
    () =>
      providerGroups.map((group) => ({
        id: `provider:${group.providerKey}`,
        title: group.providerLabel,
        subtitle: group.models.find(
          (model) =>
            model.selection.instanceId === currentModelSelection.instanceId &&
            model.selection.model === currentModelSelection.model,
        )?.label,
        subactions: group.models.map((option) => ({
          id: `model:${option.key}`,
          title: option.label,
          state:
            option.selection.instanceId === currentModelSelection.instanceId &&
            option.selection.model === currentModelSelection.model
              ? ('on' as const)
              : undefined,
        })),
      })),
    [providerGroups, currentModelSelection],
  )

  // ── Options menu ─────────────────────────────────────────
  const optionsMenuActions = useMemo(
    () => [
      ...buildProviderOptionMenuActions(providerOptionDescriptors),
      {
        id: 'options-runtime',
        title: 'Runtime',
        subtitle:
          currentRuntimeMode === 'approval-required'
            ? 'Approve actions'
            : currentRuntimeMode === 'auto-accept-edits'
              ? 'Auto-accept edits'
              : currentRuntimeMode === 'auto'
                ? 'Auto'
                : 'Full access',
        subactions: [
          { id: 'options:runtime:approval-required', title: 'Approve actions' },
          { id: 'options:runtime:auto-accept-edits', title: 'Auto-accept edits' },
          { id: 'options:runtime:auto', title: 'Auto' },
          { id: 'options:runtime:full-access', title: 'Full access' },
        ]
          .filter((option) =>
            providerCapabilities.supportedRuntimeModes.includes(
              option.id.replace('options:runtime:', '') as RuntimeMode,
            ),
          )
          .map((option) =>
          {
            const value = option.id.replace('options:runtime:', '')
            return {
              id: option.id,
              title: option.title,
              state: currentRuntimeMode === value ? ('on' as const) : undefined,
            }
          }),
      },
      ...(showPlanMode || showOrchestrate
        ? [
            {
              id: 'options-interaction',
              title: 'Interaction',
              subtitle: `${currentInteractionMode.baseMode === 'plan' ? 'Plan' : 'Default'}${
                currentInteractionMode.orchestrate ? ' + Orchestrate' : ''
              }`,
              subactions: [
                {
                  id: 'options:interaction:default',
                  title: 'Default',
                  state:
                    currentInteractionMode.baseMode === 'default' ? ('on' as const) : undefined,
                },
                ...(showPlanMode
                  ? [
                      {
                        id: 'options:interaction:plan',
                        title: 'Plan',
                        state:
                          currentInteractionMode.baseMode === 'plan' ? ('on' as const) : undefined,
                      },
                    ]
                  : []),
                ...(showOrchestrate
                  ? [
                      {
                        id: 'options:interaction:orchestrate',
                        title: 'Orchestrate',
                        state: currentInteractionMode.orchestrate ? ('on' as const) : undefined,
                      },
                    ]
                  : []),
              ],
            },
          ]
        : []),
    ],
    [
      currentInteractionMode,
      currentRuntimeMode,
      providerCapabilities.supportedRuntimeModes,
      providerOptionDescriptors,
      showOrchestrate,
      showPlanMode,
    ],
  )

  // ── Menu handlers ────────────────────────────────────────
  function handleModelMenuAction(event: string)
  {
    if (!event.startsWith('model:'))
    {
      return
    }
    const modelKey = event.slice('model:'.length)
    const option = modelOptions.find((o) => o.key === modelKey)
    if (option)
    {
      props.onUpdateModelSelection(option.selection)
    }
  }

  function handleOptionsMenuAction(event: string)
  {
    const providerOptions = applyProviderOptionMenuEvent(providerOptionDescriptors, event)
    if (providerOptions)
    {
      props.onUpdateModelSelection({
        ...currentModelSelection,
        options: providerOptions,
      })
      return
    }
    if (event.startsWith('options:runtime:'))
    {
      const runtimeMode = event.slice('options:runtime:'.length) as RuntimeMode
      if (!providerCapabilities.supportedRuntimeModes.includes(runtimeMode)) return
      props.onUpdateRuntimeMode(runtimeMode)
      return
    }
    if (event.startsWith('options:interaction:'))
    {
      const value = event.slice('options:interaction:'.length)
      if (value === 'plan' && !showPlanMode) return
      if (value === 'orchestrate' && !showOrchestrate) return
      props.onUpdateInteractionMode(
        value === 'orchestrate'
          ? { ...currentInteractionMode, orchestrate: !currentInteractionMode.orchestrate }
          : {
              ...currentInteractionMode,
              baseMode: value === 'plan' ? 'plan' : 'default',
            },
      )
    }
  }

  return (
    <Animated.View
      className="px-4"
      layout={COMPOSER_LAYOUT_TRANSITION}
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
        experimental_backgroundImage: isDarkMode
          ? 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0.9) 100%)'
          : 'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.6) 55%, rgba(255,255,255,0.9) 100%)',
      }}
    >
      <Animated.View
        className="relative w-full self-center"
        layout={COMPOSER_LAYOUT_TRANSITION}
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {composerTrigger && composerMenuItems.length > 0 ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={composerMenuItems}
              triggerKind={composerTrigger.kind}
              isLoading={pathSearch.isPending}
              onSelect={handleCommandSelect}
            />
          </View>
        ) : null}

        {connectionStatus ? (
          <ComposerConnectionStatusPill
            status={connectionStatus}
            onPress={props.onReconnectEnvironment}
          />
        ) : null}

        {props.providerSwitchNotice ? (
          <ComposerProviderSwitchNotice
            notice={props.providerSwitchNotice}
            onRetry={props.onRetryProviderSwitch}
            onDismiss={props.onDismissProviderSwitchNotice}
          />
        ) : null}

        <ComposerSurface
          isDarkMode={isDarkMode}
          style={
            isExpanded
              ? {
                  borderRadius: 20,
                  overflow: 'hidden' as const,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                }
              : {
                  borderRadius: 999,
                  overflow: 'hidden' as const,
                  flexDirection: 'row' as const,
                  alignItems: 'center' as const,
                  paddingLeft: 18,
                  paddingRight: 5,
                  paddingVertical: 5,
                }
          }
        >
          {/* Attachment strip — inside the card, above the text input */}
          {isExpanded ? (
            <Animated.View
              className={props.draftAttachments.length > 0 ? 'pb-2.5' : undefined}
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(120)}
            >
              <ComposerAttachmentStrip
                attachments={props.draftAttachments}
                onRemove={props.onRemoveDraftImage}
                onPressImage={onPressImage}
              />
            </Animated.View>
          ) : null}

          <View className={isExpanded ? undefined : 'min-w-0 flex-1'}>
            <ComposerEditor
              ref={inputRef}
              multiline
              value={props.draftMessage}
              skills={selectedProviderStatus?.skills ?? []}
              selection={composerSelection}
              onChangeText={props.onChangeDraftMessage}
              onSelectionChange={handleSelectionChange}
              onPasteImages={(uris) => void props.onNativePasteImages(uris)}
              placeholder={props.placeholder}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onSubmit={resolveComposerSubmitHandler(composerEditorCapabilities, handleSend)}
              scrollEnabled={isExpanded}
              // android: collapsed single line centers natively (gravity) in
              // a pill-height box matching the send button; iOS keeps insets.
              singleLineCentered={!isExpanded}
              contentInsetVertical={isExpanded || Platform.OS === 'android' ? 0 : 6}
              style={
                isExpanded
                  ? {
                      minHeight: 80,
                      maxHeight: 160,
                      paddingHorizontal: 4,
                      paddingVertical: 4,
                    }
                  : {
                      height: 36,
                    }
              }
              textStyle={{
                ...bodyText,
                color: foregroundColor,
              }}
            />
          </View>
          {!isExpanded && props.draftAttachments.length > 0 ? (
            <View className="flex-row gap-1 pl-1">
              {props.draftAttachments.slice(0, 3).map((image) => (
                <Pressable key={image.id} onPress={() => onPressImage(image.previewUri)}>
                  <Image
                    source={{ uri: image.previewUri }}
                    className="size-[30px] rounded-lg bg-subtle"
                    resizeMode="cover"
                  />
                </Pressable>
              ))}
              {props.draftAttachments.length > 3 ? (
                <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                  <Text className="text-foreground-muted text-2xs font-sans-bold">
                    +{props.draftAttachments.length - 3}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {!isExpanded ? (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(100)}>
              {showStopAction ? (
                <ControlPill icon="stop.fill" variant="danger" onPress={props.onStopThread} />
              ) : (
                <ControlPill
                  icon="arrow.up"
                  variant="primary"
                  disabled={!canSend}
                  onPress={handleSend}
                />
              )}
            </Animated.View>
          ) : null}
        </ComposerSurface>

        {isExpanded ? (
          // toolbar row — matches draft page layout (expanded only)
          <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
            <ComposerToolbarRow paddingBottom={8} paddingHorizontal={0} paddingTop={8}>
              <ComposerToolbarScroller
                fadeOpaque={toolbarFadeOpaque}
                fadeTransparent={toolbarFadeTransparent}
              >
                <ComposerToolbarButton
                  accessibilityLabel="Add attachment"
                  icon="plus"
                  onPress={() => void props.onPickDraftImages()}
                  showChevron={false}
                />
                <ControlPillMenu
                  actions={modelMenuActions}
                  onPressAction={({ nativeEvent }) => handleModelMenuAction(nativeEvent.event)}
                >
                  <ComposerToolbarTrigger
                    accessibilityLabel="Model"
                    iconNode={
                      <ProviderIcon provider={currentModelOption?.providerDriver} size={16} />
                    }
                    label={currentModelOption?.label ?? currentModelSelection.model}
                  />
                </ControlPillMenu>
                <ControlPillMenu
                  actions={optionsMenuActions}
                  onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
                >
                  <ComposerToolbarTrigger
                    accessibilityLabel="Configuration"
                    icon="slider.horizontal.3"
                    label={configurationLabel}
                  />
                </ControlPillMenu>
                {showStopAction ? (
                  <ComposerToolbarButton
                    accessibilityLabel="Stop"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                    showChevron={false}
                  />
                ) : null}
              </ComposerToolbarScroller>
              <ComposerToolbarButton
                accessibilityLabel={sendLabel}
                icon="arrow.up"
                variant="primary"
                disabled={!canSend}
                onPress={handleSend}
                showChevron={false}
              />
            </ComposerToolbarRow>
          </Animated.View>
        ) : null}

        {props.queueFailureReason !== null ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <View className="flex-row items-start gap-3 pt-2">
              <Text className="flex-1 text-xs text-danger-foreground">
                Queued message failed: {props.queueFailureReason}
              </Text>
              <Pressable
                accessibilityLabel="Discard failed queued message"
                accessibilityRole="button"
                hitSlop={8}
                onPress={props.onDiscardQueuedMessage}
              >
                <Text className="text-xs font-sans-bold text-danger-foreground">Discard</Text>
              </Pressable>
            </View>
          </Animated.View>
        ) : props.queueCount > 0 ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <Text className="pt-2 text-xs text-foreground-muted">
              {props.queueCount} queued message{props.queueCount === 1 ? '' : 's'} will send
              automatically.
            </Text>
          </Animated.View>
        ) : null}
      </Animated.View>

      <ImageViewing
        images={previewImageUri ? [{ uri: previewImageUri }] : []}
        imageIndex={0}
        visible={previewImageUri !== null}
        onRequestClose={closePreview}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </Animated.View>
  )
})
