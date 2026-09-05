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

