// apps/web/src/components/settings/ArchitectureAutoAnalysisSettings.tsx
// configures automatic architecture analysis for ready task checkpoints
import {
  type ArchitectureAutoAnalysis,
  DEFAULT_UNIFIED_SETTINGS,
} from '@t3tools/contracts/settings'

import { usePrimarySettings, useUpdatePrimarySettings } from '../../hooks/useSettings'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select'
import { SettingResetButton } from './settingsLayout'

const ARCHITECTURE_AUTO_ANALYSIS_LABELS = {
  off: 'Off',
  'on-demand': 'On demand',
  auto: 'Automatic',
} satisfies Record<ArchitectureAutoAnalysis, string>

const ARCHITECTURE_AUTO_ANALYSIS_MODES = Object.keys(
  ARCHITECTURE_AUTO_ANALYSIS_LABELS,
) as ArchitectureAutoAnalysis[]

export function ArchitectureAutoAnalysisSettings()
{
  const mode = usePrimarySettings((settings) => settings.architectureAutoAnalysis)
  const updateSettings = useUpdatePrimarySettings()
  const defaultMode = DEFAULT_UNIFIED_SETTINGS.architectureAutoAnalysis
  const canReset = mode !== defaultMode

  return (
    <div className="grid gap-3 border-t border-border/60 pt-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="text-xs font-medium text-foreground">Architecture analysis</span>
            <span
              className={
                canReset
                  ? 'inline-flex size-5 shrink-0 items-center justify-center opacity-100'
                  : 'pointer-events-none inline-flex size-5 shrink-0 items-center justify-center opacity-0'
              }
              aria-hidden={!canReset}
            >
              {canReset ? (
                <SettingResetButton
                  label="architecture analysis mode"
                  onClick={() => updateSettings({ architectureAutoAnalysis: defaultMode })}
                />
              ) : null}
            </span>
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Off and On demand both disable automatic analysis in this version. Manual architecture
            analysis from Diff remains available in every mode.
          </p>
        </div>
        <Select
          value={mode}
          onValueChange={(value) =>
          {
            updateSettings({ architectureAutoAnalysis: value as ArchitectureAutoAnalysis })
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full shrink-0 sm:w-36"
            aria-label="Architecture analysis mode"
          >
            <SelectValue>{ARCHITECTURE_AUTO_ANALYSIS_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {ARCHITECTURE_AUTO_ANALYSIS_MODES.map((candidate) => (
              <SelectItem key={candidate} hideIndicator value={candidate}>
                {ARCHITECTURE_AUTO_ANALYSIS_LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  )
}
