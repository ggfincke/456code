// apps/web/src/components/settings/UsageSettingsPanel.tsx
// integrate selected-environment limits, transcript usage, and independently persisted prices

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EnvironmentId } from '@t3tools/contracts'
import {
  collectLimitAccounts,
  collectLimitNotices,
  toggleUsageEnvironment,
} from '@t3tools/shared/usageLimits'
import { useEnvironments, type EnvironmentPresentation } from '../../state/environments'
import { useEnvironmentQuery } from '../../state/query'
import { serverEnvironment } from '../../state/server'
import { usageEnvironment } from '../../state/usage'
import { useAtomCommand } from '../../state/use-atom-command'
import { UsageLimitsView } from '../usage/UsageLimitsView'
import { UsagePriceOverridesEditor } from '../usage/UsagePriceOverridesEditor'
import {
  writeUsagePrice,
  type UsagePriceEdits,
  type UsagePriceTarget,
} from '../usage/usagePriceTargets'
import { UsageSummaryView } from '../usage/UsageSummaryView'
import { Button } from '../ui/button'
import { SettingsPageContainer, SettingsSection } from './settingsLayout'

function initialUsageWindow()
{
  const until = new Date()
  const since = new Date(until.getTime() - 30 * 24 * 60 * 60 * 1_000)
  return { since: since.toISOString(), until: until.toISOString() }
}

function EnvironmentSummary({
  environment,
  window,
  onModels,
}: {
  environment: EnvironmentPresentation
  window: ReturnType<typeof initialUsageWindow>
  onModels: (id: EnvironmentId, models: readonly string[]) => void
})
{
  const query = useEnvironmentQuery(
    environment.connection.phase === 'connected'
      ? usageEnvironment.summary({ environmentId: environment.environmentId, input: window })
      : null,
  )
  useEffect(() =>
  {
    onModels(environment.environmentId, query.data?.buckets.map((bucket) => bucket.model) ?? [])
  }, [environment.environmentId, query.data, onModels])
  return (
    <section aria-label={`${environment.label} usage`}>
      <h2 className="mb-3 font-medium">{environment.label}</h2>
      <UsageSummaryView
        summary={query.data}
        loading={query.isPending}
        error={
          environment.connection.phase === 'connected'
            ? query.error
            : 'Environment is disconnected.'
        }
        onRefresh={query.refresh}
      />
    </section>
  )
}

export function UsageSettingsPanel()
{
  const { environments, presentationById } = useEnvironments()
  const [selected, setSelected] = useState<readonly EnvironmentId[] | null>(null)
  const selectedEnvironments = useMemo(
    () =>
      environments.filter(
        (environment) => selected === null || selected.includes(environment.environmentId),
      ),
    [environments, selected],
  )
  const selectedPresentations = useMemo(
    () =>
      new Map([...presentationById].filter(([id]) => selected === null || selected.includes(id))),
    [presentationById, selected],
  )
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false })
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  })
  const [usageWindow] = useState(initialUsageWindow)
  const [refreshingLimits, setRefreshingLimits] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [results, setResults] = useState<
    ReadonlyMap<
      EnvironmentId,
      { error: string | null; model: string; edits: UsagePriceEdits | null }
    >
  >(new Map())
  const [transcriptModels, setTranscriptModels] = useState<
    ReadonlyMap<EnvironmentId, readonly string[]>
  >(new Map())
  const onModels = useCallback((id: EnvironmentId, models: readonly string[]) =>
  {
    setTranscriptModels((current) => new Map(current).set(id, models))
  }, [])
  const targets = useMemo(
    (): readonly UsagePriceTarget[] =>
      selectedEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        prices: environment.serverConfig?.settings.usagePriceOverrides ?? null,
        unavailable:
          environment.connection.phase !== 'connected'
            ? 'Environment is disconnected.'
            : environment.serverConfig === null
              ? 'Environment settings are not loaded.'
              : null,
      })),
    [selectedEnvironments],
  )
  const models = useMemo(
    () => [
      ...new Set(
        selectedEnvironments.flatMap((environment) => [
          ...(transcriptModels.get(environment.environmentId) ?? []),
          ...(environment.serverConfig?.providers ?? [])
            .filter((provider) => provider.driver === 'codex' || provider.driver === 'claudeAgent')
            .flatMap((provider) => provider.models.map((model) => model.slug))
            .filter((model) => model !== 'auto' && model !== 'default'),
        ]),
      ),
    ],
    [selectedEnvironments, transcriptModels],
  )
  const accounts = useMemo(
    () => collectLimitAccounts(selectedPresentations),
    [selectedPresentations],
  )
  const notices = useMemo(() => collectLimitNotices(selectedPresentations), [selectedPresentations])
  const save = async (
    writeTargets: readonly UsagePriceTarget[],
    model: string,
    edits: UsagePriceEdits | null,
  ): Promise<boolean> =>
  {
    if (savingRef.current || writeTargets.length === 0) return false
    savingRef.current = true
    setSaving(true)
    let failed = false
    try
    {
      await writeUsagePrice({
        targets: writeTargets,
        model,
        edits,
        write: updateSettings,
        onResult: (id, error) =>
        {
          if (error !== null) failed = true
          setResults((current) => new Map(current).set(id, { error, model, edits }))
        },
      })
      return !failed
    }
    finally
    {
      savingRef.current = false
      setSaving(false)
    }
  }
  const refreshLimits = () =>
  {
    if (refreshingLimits) return
    setRefreshingLimits(true)
    void Promise.all(
      selectedEnvironments
        .filter((environment) => environment.connection.phase === 'connected')
        .map((environment) =>
          refreshProviders({ environmentId: environment.environmentId, input: {} }),
        ),
    ).finally(() => setRefreshingLimits(false))
  }
  return (
    <SettingsPageContainer>
      <SettingsSection id="usage-environments" title="Environments">
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" disabled={saving} onClick={() => setSelected(null)}>
            All environments
          </Button>
          {environments.map((environment) => (
            <label key={environment.environmentId} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={saving}
                checked={selected === null || selected.includes(environment.environmentId)}
                onChange={() =>
                  setSelected((current) =>
                    toggleUsageEnvironment(current, environments, environment.environmentId),
                  )
                }
              />
              {environment.label}
              {environment.connection.phase === 'connected' ? '' : ' (disconnected)'}
            </label>
          ))}
        </div>
      </SettingsSection>
      <UsageLimitsView
        accounts={accounts}
        notices={notices}
        refreshing={refreshingLimits}
        onRefresh={refreshLimits}
      />
      {selectedEnvironments.map((environment) => (
        <EnvironmentSummary
          key={environment.environmentId}
          environment={environment}
          window={usageWindow}
          onModels={onModels}
        />
      ))}
      <UsagePriceOverridesEditor
        models={models}
        targets={targets}
        saving={saving}
        onUpdate={(model, edits) => save(targets, model, edits)}
      />
      <div aria-live="polite" className="space-y-2 text-sm">
        {targets.map((target) =>
        {
          const result = results.get(target.environmentId)
          return result ? (
            <div key={target.environmentId}>
              {target.label} ({result.model}):{' '}
              {result.error ?? 'Saved. Refresh usage totals to apply.'}
              {result.error ? (
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void save([target], result.model, result.edits)}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null
        })}
      </div>
    </SettingsPageContainer>
  )
}
