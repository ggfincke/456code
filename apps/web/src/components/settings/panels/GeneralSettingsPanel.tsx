// apps/web/src/components/settings/panels/GeneralSettingsPanel.tsx
// renders general settings and restores application defaults
import { useAtomValue } from '@effect/atom-react'
import {
  type DesktopUpdateChannel,
  ProviderDriverKind,
  type SidebarProjectGroupingMode,
} from '@t3tools/contracts'
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_GLASS_OPACITY,
  MIN_GLASS_OPACITY,
  type ProviderUsageDisplayMode,
} from '@t3tools/contracts/settings'
import { createModelSelection } from '@t3tools/shared/model'
import { Link } from '@tanstack/react-router'
import * as Duration from 'effect/Duration'
import * as Equal from 'effect/Equal'
import type { CSSProperties } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from '../../../branding'
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from '../../../components/desktopUpdate.logic'
import { isElectron } from '../../../env'
import { usePrimarySettings, useUpdatePrimarySettings } from '../../../hooks/useSettings'
import { useTheme } from '../../../hooks/useTheme'
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from '../../../hostedPairing'
import { ensureLocalApi, readLocalApi } from '../../../localApi'
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from '../../../modelSelection'
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from '../../../providerInstances'
import { useDesktopUpdateState } from '../../../state/desktopUpdate'
import { primaryServerObservabilityAtom, primaryServerProvidersAtom } from '../../../state/server'
import { ProviderModelPicker } from '../../chat/ProviderModelPicker'
import { TraitsPicker } from '../../chat/TraitsPicker'
import { Button } from '../../ui/button'
import { DraftInput } from '../../ui/draft-input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { stackedThreadToast, toastManager } from '../../ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'
import {
  formatDiagnosticsDescription,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
} from '../SettingsPanels.logic'
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from '../settingsLayout'

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make('codex')

const THEME_OPTIONS = [
  {
    value: 'system',
    label: 'System',
  },
  {
    value: 'light',
    label: 'Light',
  },
  {
    value: 'dark',
    label: 'Dark',
  },
  {
    value: 'ocean',
    label: 'Ocean',
  },
] as const

const TIMESTAMP_FORMAT_LABELS = {
  locale: 'System default',
  '12-hour': '12-hour',
  '24-hour': '24-hour',
} as const

const PROVIDER_USAGE_DISPLAY_LABELS = {
  'percent-left': 'Percent left',
  'percent-used': 'Percent used',
} satisfies Record<ProviderUsageDisplayMode, string>

function AboutVersionTitle()
{
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  )
}

function AboutVersionSection()
{
  const updateState = useDesktopUpdateState()
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false)

  const hasDesktopBridge = typeof window !== 'undefined' && Boolean(window.desktopBridge)
  const selectedUpdateChannel = updateState?.channel ?? 'latest'
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) =>
    {
      const bridge = window.desktopBridge
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== 'function' ||
        channel === selectedUpdateChannel
      )
      {
        return
      }

      setIsChangingUpdateChannel(true)
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) =>
        {
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: 'Could not change update track',
              description: error instanceof Error ? error.message : 'Update track change failed.',
            }),
          )
        })
        .finally(() =>
        {
          setIsChangingUpdateChannel(false)
        })
    },
    [selectedUpdateChannel],
  )

  const handleButtonClick = useCallback(() =>
  {
    const bridge = window.desktopBridge
    if (!bridge) return

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : 'none'

    if (action === 'download')
    {
      void bridge.downloadUpdate().catch((error: unknown) =>
      {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not download update',
            description: error instanceof Error ? error.message : 'Download failed.',
          }),
        )
      })
      return
    }

    if (action === 'install')
    {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
          navigator.platform,
        ),
      )
      if (!confirmed) return
      void bridge.installUpdate().catch((error: unknown) =>
      {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not install update',
            description: error instanceof Error ? error.message : 'Install failed.',
          }),
        )
      })
      return
    }

    if (typeof bridge.checkForUpdate !== 'function') return
    void bridge
      .checkForUpdate()
      .then((result) =>
      {
        if (!result.checked)
        {
          toastManager.add(
            stackedThreadToast({
              type: 'error',
              title: 'Could not check for updates',
              description:
                result.state.message ?? 'Automatic updates are not available in this build.',
            }),
          )
        }
      })
      .catch((error: unknown) =>
      {
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: 'Could not check for updates',
            description: error instanceof Error ? error.message : 'Update check failed.',
          }),
        )
      })
  }, [updateState])

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : 'none'
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null
  const buttonDisabled =
    action === 'none' ? !canCheckForUpdate(updateState) : isDesktopUpdateButtonDisabled(updateState)

  const actionLabel: Record<string, string> = { download: 'Download', install: 'Install' }
  const statusLabel: Record<string, string> = {
    checking: 'Checking…',
    downloading: 'Downloading…',
    'up-to-date': 'Up to Date',
  }
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ''] ?? 'Check for Updates'
  const description =
    action === 'download' || action === 'install'
      ? 'Update available.'
      : 'Current version of the application.'

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === 'install' ? 'default' : 'outline'}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="Update track"
          description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) =>
                {
                handleUpdateChannelChange(value as DesktopUpdateChannel)
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label="Update track"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === 'nightly' ? 'Nightly' : 'Stable'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stable
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          title="Update track"
          description="Switches the hosted app release channel."
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) =>
                {
                if (value === selectedHostedAppChannel) return
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                )
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Update track">
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Latest
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  )
}

export function useSettingsRestore(onRestored?: () => void)
{
  const { theme, setTheme } = useTheme()
  const settings = usePrimarySettings()
  const updateSettings = useUpdatePrimarySettings()

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  )

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== 'system' ? ['Theme'] : []),
      ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ['Glass opacity'] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ['Time format']
        : []),
      ...(settings.providerUsageDisplayMode !== DEFAULT_UNIFIED_SETTINGS.providerUsageDisplayMode
        ? ['Usage display']
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ['Visible threads']
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ['Project Grouping']
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ['Word wrap'] : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ['Diff whitespace changes']
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ['Auto-open task panel']
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ['Assistant output']
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ['Provider update checks']
        : []),
      ...(Duration.toMillis(settings.automaticGitFetchInterval) !==
      Duration.toMillis(DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval)
        ? ['Automatic Git fetch interval']
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ['New thread mode']
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ['New worktrees start from origin']
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ['Add project base directory']
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ['Archive confirmation']
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ['Delete confirmation']
        : []),
      ...(isTextGenerationModelDirty ? ['Text generation model'] : []),
    ],
    [
      isTextGenerationModelDirty,
      settings.autoOpenPlanSidebar,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.diffIgnoreWhitespace,
      settings.glassOpacity,
      settings.automaticGitFetchInterval,
      settings.enableAssistantStreaming,
      settings.enableProviderUpdateChecks,
      settings.sidebarProjectGroupingMode,
      settings.sidebarThreadPreviewCount,
      settings.providerUsageDisplayMode,
      settings.timestampFormat,
      settings.wordWrap,
      theme,
    ],
  )

  const restoreDefaults = useCallback(async () =>
  {
    if (changedSettingLabels.length === 0) return
    const api = readLocalApi()
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ['Restore default settings?', `This will reset: ${changedSettingLabels.join(', ')}.`].join(
        '\n',
      ),
    )
    if (!confirmed) return

    setTheme('system')
    updateSettings({
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      providerUsageDisplayMode: DEFAULT_UNIFIED_SETTINGS.providerUsageDisplayMode,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    })
    onRestored?.()
  }, [changedSettingLabels, onRestored, setTheme, updateSettings])

  return {
    changedSettingLabels,
    restoreDefaults,
  }
}

export function GeneralSettingsPanel()
{
  const { theme, setTheme } = useTheme()
  const settings = usePrimarySettings()
  const updateSettings = useUpdatePrimarySettings()
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  )
  const observability = useAtomValue(primaryServerObservabilityAtom)
  const serverProviders = useAtomValue(primaryServerProvidersAtom)
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY)
  const glassOpacitySliderStyle = {
    '--glass-slider-progress': `${glassOpacityRatio * 100}%`,
    '--glass-slider-fill-offset': `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  })

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders)
  const textGenInstanceId = textGenerationModelSelection.instanceId
  const textGenModel = textGenerationModelSelection.model
  const textGenModelOptions = textGenerationModelSelection.options
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  )
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  )
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  )
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  )

  return (
    <SettingsPageContainer>
      <SettingsSection title="General">
        <SettingsRow
          title="Theme"
          description="Choose how 456code looks across the app."
          resetAction={
            theme !== 'system' ? (
              <SettingResetButton label="theme" onClick={() => setTheme('system')} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) =>
              {
                if (
                  value === 'system' ||
                  value === 'light' ||
                  value === 'dark' ||
                  value === 'ocean'
                )
                {
                  setTheme(value)
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? 'System'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Glass opacity"
          description="Control how transparent glass surfaces are. Higher values make menus, dialogs, and the composer more solid."
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="glass opacity"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="Glass opacity"
                className="glass-opacity-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) =>
                {
                  const glassOpacity = Number(event.currentTarget.value)
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  )
                  {
                    updateSettings({ glassOpacity })
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        <SettingsRow
          title="Project Grouping"
          description="Combine matching repositories across environments."
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="project grouping"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) =>
              {
                if (!checked && settings.sidebarProjectGroupingMode !== 'separate')
                {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode)
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                })
              }}
              aria-label="Project Grouping"
            />
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) =>
              {
                if (value === 'locale' || value === '12-hour' || value === '24-hour')
                {
                  updateSettings({ timestampFormat: value })
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS['12-hour']}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS['24-hour']}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Usage display"
          description="Show provider limits as the percentage left or the percentage used."
          resetAction={
            settings.providerUsageDisplayMode !==
            DEFAULT_UNIFIED_SETTINGS.providerUsageDisplayMode ? (
              <SettingResetButton
                label="usage display"
                onClick={() =>
                  updateSettings({
                    providerUsageDisplayMode: DEFAULT_UNIFIED_SETTINGS.providerUsageDisplayMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.providerUsageDisplayMode}
              onValueChange={(value) =>
              {
                if (value === 'percent-left' || value === 'percent-used')
                {
                  updateSettings({ providerUsageDisplayMode: value })
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Provider usage display">
                <SelectValue>
                  {PROVIDER_USAGE_DISPLAY_LABELS[settings.providerUsageDisplayMode]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="percent-left">
                  {PROVIDER_USAGE_DISPLAY_LABELS['percent-left']}
                </SelectItem>
                <SelectItem hideIndicator value="percent-used">
                  {PROVIDER_USAGE_DISPLAY_LABELS['percent-used']}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Word wrap"
          description="Wrap long lines in code blocks, tables, diffs, and file previews by default."
          resetAction={
            settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
              <SettingResetButton
                label="word wrapping"
                onClick={() =>
                  updateSettings({
                    wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.wordWrap}
              onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
              aria-label="Wrap code, tables, diffs, and file previews by default"
            />
          }
        />

        <SettingsRow
          title="Hide whitespace changes"
          description="Set whether the diff panel ignores whitespace-only edits by default."
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="diff whitespace changes"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="Hide whitespace changes by default"
            />
          }
        />

        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          title="Provider update checks"
          description="Check installed provider CLIs for newer available versions."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check provider versions"
            />
          }
        />

        <SettingsRow
          title="Auto-open task panel"
          description="Open the right-side plan and task panel automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open task panel"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task panel automatically"
            />
          }
        />

        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ||
            settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                    newWorktreesStartFromOrigin:
                      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) =>
              {
                if (value === 'local' || value === 'worktree')
                {
                  updateSettings({ defaultThreadEnvMode: value })
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === 'worktree' ? 'New worktree' : 'Local'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Local
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        {settings.defaultThreadEnvMode === 'worktree' ? (
          <SettingsRow
            className="bg-muted/20 sm:pl-9"
            title="Start from origin"
            description="Creates the worktree from the latest matching branch on origin instead of your local branch."
            resetAction={
              settings.newWorktreesStartFromOrigin !==
              DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
                <SettingResetButton
                  label="new worktrees start from origin"
                  onClick={() =>
                    updateSettings({
                      newWorktreesStartFromOrigin:
                        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.newWorktreesStartFromOrigin}
                onCheckedChange={(checked) =>
                  updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
                }
                aria-label="Start new worktrees from origin by default"
              />
            }
          />
        ) : null}

        <SettingsRow
          title="Add project starts in"
          description='Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />

        <SettingsRow
          title="Archive confirmation"
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        <SettingsRow
          title="Text generation model"
          description="Default model for generated text like thread titles and source control content. Source control settings can override it with a dedicated source control writer model."
          resetAction={
            isTextGenerationModelDirty ? (
              <SettingResetButton
                label="text generation model"
                onClick={() =>
                  updateSettings({
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                lockedProvider={null}
                instanceEntries={textGenerationModelInstanceEntries}
                modelOptionsByInstance={textGenerationModelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) =>
                {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      serverProviders,
                    ),
                  })
                }}
              />
              <TraitsPicker
                provider={textGenProvider}
                models={
                  // use the exact instance's models (rather than the
                  // first-kind-match) so a custom text-gen instance like
                  // `codex_personal` gets its own model list, not the
                  // default Codex one.
                  textGenInstanceEntry?.models ?? []
                }
                model={textGenModel}
                prompt=""
                onPromptChange={() =>
                {}}
                modelOptions={textGenModelOptions}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) =>
                {
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(
                          textGenInstanceId,
                          textGenModel,
                          nextOptions,
                        ),
                      },
                      serverProviders,
                    ),
                  })
                }}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="About">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
          />
        )}
        <SettingsRow
          title="Diagnostics"
          description={diagnosticsDescription}
          control={
            <Button render={<Link to="/settings/diagnostics" />} size="xs" variant="outline">
              View diagnostics
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  )
}
