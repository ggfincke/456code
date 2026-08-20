// apps/web/src/components/settings/IntegrationsSettings.tsx
// render integration-owned settings

import {
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_VIEWPORT,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  DEFAULT_UNIFIED_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
} from '@t3tools/contracts'
import { PREVIEW_VIEWPORT_PRESETS } from '@t3tools/shared/previewViewport'
import { InfoIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { ScreenRotationIcon } from '~/browser/ScreenRotationIcon'
import { isElectron } from '~/env'
import {
  useClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from '~/hooks/useSettings'

import { Button } from '../ui/button'
import { NumberField, NumberFieldGroup, NumberFieldInput } from '../ui/number-field'
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Switch } from '../ui/switch'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from './settingsLayout'

const FILL_VALUE = 'fill'
const RESPONSIVE_VALUE = 'responsive'
const RESPONSIVE_SEED_SIZE = { width: 1280, height: 800 } as const
const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false }
const APPEARANCE_LABELS: Readonly<Record<PreviewAppearancePreference, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const zoomLabel = (zoomFactor: number) => `${Math.round(zoomFactor * 100)}%`

const viewportSelectValue = (viewport: PreviewViewportSetting): string =>
{
  if (viewport._tag === 'fill') return FILL_VALUE
  if (
    viewport._tag === 'preset' &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === viewport.presetId)
  )
  {
    return viewport.presetId
  }
  return RESPONSIVE_VALUE
}

const viewportSelectLabel = (viewport: PreviewViewportSetting): string =>
{
  const value = viewportSelectValue(viewport)
  if (value === FILL_VALUE) return 'Fill panel'
  if (value === RESPONSIVE_VALUE) return 'Responsive'
  return PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ?? 'Responsive'
}

const isValidDimension = (value: number) =>
  Number.isInteger(value) &&
  value >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
  value <= PREVIEW_VIEWPORT_MAX_DIMENSION

const rotateViewport = (
  viewport: Exclude<PreviewViewportSetting, { readonly _tag: 'fill' }>,
): PreviewViewportSetting => ({
  ...viewport,
  width: viewport.height,
  height: viewport.width,
})

function BrowserViewportSetting({ disabled }: { readonly disabled: boolean })
{
  const viewport = useClientSettings((settings) => settings.browserDefaultViewport)
  const updateSettings = useUpdatePrimarySettings()
  const sized = viewport._tag === 'fill' ? null : viewport
  const presentedSize = {
    width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
    height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
  }

  const selectViewport = (value: string | null) =>
  {
    if (value === FILL_VALUE)
    {
      updateSettings({ browserDefaultViewport: FILL_PREVIEW_VIEWPORT })
      return
    }
    if (value === RESPONSIVE_VALUE)
    {
      updateSettings({ browserDefaultViewport: { _tag: 'freeform', ...presentedSize } })
      return
    }
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value)
    if (!preset) return
    updateSettings({
      browserDefaultViewport: {
        _tag: 'preset',
        width: preset.width,
        height: preset.height,
        presetId: preset.id,
      },
    })
  }

  const commitDimension = (axis: 'width' | 'height', value: number | null) =>
  {
    if (value === null || !isValidDimension(value)) return
    const next = { ...presentedSize, [axis]: value }
    if (next.width * next.height > PREVIEW_VIEWPORT_MAX_AREA) return
    if (sized && next.width === sized.width && next.height === sized.height) return
    updateSettings({ browserDefaultViewport: { _tag: 'freeform', ...next } })
  }

  return (
    <SettingsRow
      title="Default viewport"
      description="The viewport new browser tabs use for both you and agents."
      resetAction={
        !disabled && viewport._tag !== DEFAULT_BROWSER_VIEWPORT._tag ? (
          <SettingResetButton
            label="default browser viewport"
            onClick={() => updateSettings({ browserDefaultViewport: DEFAULT_BROWSER_VIEWPORT })}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Select
            value={viewportSelectValue(viewport)}
            onValueChange={selectViewport}
            disabled={disabled}
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-44"
              aria-label="Default browser viewport"
            >
              <SelectValue>{viewportSelectLabel(viewport)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-64">
              <SelectItem value={FILL_VALUE}>Fill panel</SelectItem>
              <SelectItem value={RESPONSIVE_VALUE}>Responsive</SelectItem>
              <SelectGroup>
                <SelectGroupLabel>Devices</SelectGroupLabel>
                {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    <span className="flex w-full items-center justify-between gap-5">
                      <span>{preset.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {preset.detail}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>

          {sized ? (
            <div className="flex min-w-0 items-center gap-1">
              <NumberField
                value={presentedSize.width}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension('width', value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport width" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">×</span>
              <NumberField
                value={presentedSize.height}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension('height', value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport height" />
                </NumberFieldGroup>
              </NumberField>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={`Rotate to ${presentedSize.height >= presentedSize.width ? 'landscape' : 'portrait'}`}
                      onClick={() =>
                        updateSettings({ browserDefaultViewport: rotateViewport(sized) })
                      }
                    >
                      <ScreenRotationIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Rotate</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      }
    />
  )
}

function BrowserZoomSetting({ disabled }: { readonly disabled: boolean })
{
  const zoomFactor = useClientSettings((settings) => settings.browserDefaultZoomFactor)
  const updateSettings = useUpdatePrimarySettings()
  return (
    <SettingsRow
      title="Default zoom"
      description="Page zoom applied to new browser tabs."
      resetAction={
        !disabled && zoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
          <SettingResetButton
            label="default browser zoom"
            onClick={() =>
              updateSettings({ browserDefaultZoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={String(zoomFactor)}
          onValueChange={(value) =>
          {
            const next = PREVIEW_ZOOM_LEVELS.find((level) => String(level) === value)
            if (next !== undefined) updateSettings({ browserDefaultZoomFactor: next })
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser zoom">
            <SelectValue>{zoomLabel(zoomFactor)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {PREVIEW_ZOOM_LEVELS.map((level) => (
              <SelectItem hideIndicator key={level} value={String(level)}>
                {zoomLabel(level)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  )
}

function BrowserAppearanceSetting({ disabled }: { readonly disabled: boolean })
{
  const appearance = useClientSettings((settings) => settings.browserDefaultAppearance)
  const updateSettings = useUpdatePrimarySettings()
  return (
    <SettingsRow
      title="Default appearance"
      description="The color scheme pages are told to prefer."
      resetAction={
        !disabled && appearance !== DEFAULT_PREVIEW_APPEARANCE ? (
          <SettingResetButton
            label="default browser appearance"
            onClick={() => updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={appearance}
          onValueChange={(value) =>
          {
            if (value === 'system' || value === 'light' || value === 'dark')
            {
              updateSettings({ browserDefaultAppearance: value })
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser appearance">
            <SelectValue>{APPEARANCE_LABELS[appearance]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(APPEARANCE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  )
}

function AgentBrowserAccessSetting()
{
  const settings = usePrimarySettings()
  const updateSettings = useUpdatePrimarySettings()
  return (
    <SettingsRow
      title="Agent browser access"
      description="Let agents open and control browser previews. Your own browser panel is unaffected."
      status={
        settings.enableAgentBrowserAccess
          ? undefined
          : 'Applies to newly started sessions; running agents keep their current tools.'
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label="agent browser access"
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(checked) =>
            updateSettings({ enableAgentBrowserAccess: Boolean(checked) })
          }
          aria-label="Allow agent browser access"
        />
      }
    />
  )
}

function BrowserAutoShowSetting({ disabled }: { readonly disabled: boolean })
{
  const autoShow = useClientSettings((settings) => settings.browserAutoShowFloatingPreview)
  const updateSettings = useUpdatePrimarySettings()
  return (
    <SettingsRow
      title="Auto-show browser panel"
      description="Reveal the browser when an agent opens it unless the agent explicitly asks not to."
      resetAction={
        !disabled && autoShow !== DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW ? (
          <SettingResetButton
            label="auto-show browser panel"
            onClick={() =>
              updateSettings({
                browserAutoShowFloatingPreview: DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          disabled={disabled}
          checked={autoShow}
          onCheckedChange={(checked) =>
            updateSettings({ browserAutoShowFloatingPreview: Boolean(checked) })
          }
          aria-label="Auto-show browser panel"
        />
      }
    />
  )
}

function DesktopOnlyBrowserDefaults({ children }: { readonly children: ReactNode })
{
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 py-1.5">
      <div className="flex items-start gap-2 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>Browser defaults are available in the desktop app.</p>
      </div>
      <div className="[&_h3]:opacity-64 [&_p]:opacity-64">{children}</div>
    </div>
  )
}

export function IntegrationsSettingsPanel()
{
  const previewDefaultsDisabled = !isElectron
  const previewDefaults = (
    <>
      <BrowserViewportSetting disabled={previewDefaultsDisabled} />
      <BrowserZoomSetting disabled={previewDefaultsDisabled} />
      <BrowserAppearanceSetting disabled={previewDefaultsDisabled} />
      <BrowserAutoShowSetting disabled={previewDefaultsDisabled} />
    </>
  )

  return (
    <SettingsPageContainer>
      <SettingsSection id="browser" title="Browser">
        <AgentBrowserAccessSetting />
        {previewDefaultsDisabled ? (
          <DesktopOnlyBrowserDefaults>{previewDefaults}</DesktopOnlyBrowserDefaults>
        ) : (
          previewDefaults
        )}
      </SettingsSection>
    </SettingsPageContainer>
  )
}
