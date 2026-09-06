// apps/mobile/src/features/settings/SettingsUsageRouteScreen.tsx
// integrates persisted environment selection with provider limits and transcript usage

import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { AsyncResult } from 'effect/unstable/reactivity'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  collectLimitAccounts,
  collectLimitNotices,
  toggleUsageEnvironment,
} from '@t3tools/shared/usageLimits'

import { AppText as Text } from '../../components/AppText'
import { useEnvironments, type EnvironmentPresentation } from '../../state/environments'
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from '../../state/preferences'
import { useEnvironmentQuery } from '../../state/query'
import { serverEnvironment } from '../../state/server'
import { usageEnvironment } from '../../state/usage'
import { useAtomCommand } from '../../state/use-atom-command'
import { UsageLimitsSection } from '../usage/UsageLimitsSection'
import { UsageSummarySection } from '../usage/UsageSummarySection'

const USAGE_WINDOW_DAYS = 30

function initialUsageWindow()
{
  const until = new Date()
  const since = new Date(until.getTime() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000)
  return { since: since.toISOString(), until: until.toISOString() }
}

function EnvironmentSummary({
  environment,
  window,
}: {
  readonly environment: EnvironmentPresentation
  readonly window: ReturnType<typeof initialUsageWindow>
})
{
  const connected = environment.connection.phase === 'connected'
  const query = useEnvironmentQuery(
    connected
      ? usageEnvironment.summary({
          environmentId: environment.environmentId,
          input: window,
        })
      : null,
  )
  return (
    <View className="gap-3">
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        {environment.label}
      </Text>
      <UsageSummarySection
        summary={query.data}
        loading={query.isPending}
        error={connected ? query.error : 'Environment is disconnected.'}
        onRefresh={query.refresh}
      />
    </View>
  )
}

export function SettingsUsageRouteScreen()
{
  const insets = useSafeAreaInsets()
  const { environments, presentationById } = useEnvironments()
  const preferences = useAtomValue(mobilePreferencesAtom)
  const savePreferences = useAtomSet(updateMobilePreferencesAtom)
  const preferencesReady = AsyncResult.isSuccess(preferences) && !preferences.waiting
  const selected = AsyncResult.isSuccess(preferences)
    ? (preferences.value.usageEnvironmentIds ?? null)
    : []
  const selectedEnvironments = environments.filter(
    (environment) => selected === null || selected.includes(environment.environmentId),
  )
  const selectedPresentations = useMemo(
    () =>
      new Map([...presentationById].filter(([id]) => selected === null || selected.includes(id))),
    [presentationById, selected],
  )
  const [usageWindow] = useState(initialUsageWindow)
  const [refreshingLimits, setRefreshingLimits] = useState(false)
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  })
  const accounts = useMemo(
    () => collectLimitAccounts(selectedPresentations),
    [selectedPresentations],
  )
  const notices = useMemo(() => collectLimitNotices(selectedPresentations), [selectedPresentations])

  const refreshLimits = () =>
  {
    if (refreshingLimits) return
    const connected = selectedEnvironments.filter(
      (environment) => environment.connection.phase === 'connected',
    )
    setRefreshingLimits(true)
    void Promise.all(
      connected.map((environment) =>
        refreshProviders({ environmentId: environment.environmentId, input: {} }),
      ),
    ).finally(() => setRefreshingLimits(false))
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-8 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-3">
          <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
            Environments
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={!preferencesReady}
            className="min-h-11 justify-center"
            onPress={() => savePreferences({ usageEnvironmentIds: null })}
          >
            <Text className="text-accent">All environments</Text>
          </Pressable>
          {environments.map((environment) =>
          {
            const checked = selected === null || selected.includes(environment.environmentId)
            return (
              <Pressable
                key={environment.environmentId}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled: !preferencesReady }}
                disabled={!preferencesReady}
                className="min-h-11 flex-row items-center gap-3"
                onPress={() =>
                  savePreferences({
                    usageEnvironmentIds: toggleUsageEnvironment(
                      selected,
                      environments,
                      environment.environmentId,
                    ),
                  })
                }
              >
                <Text className="text-foreground">
                  {checked ? '☑' : '☐'} {environment.label}
                  {environment.connection.phase === 'connected' ? '' : ' (disconnected)'}
                </Text>
              </Pressable>
            )
          })}
          {AsyncResult.isFailure(preferences) ? (
            <Text className="text-destructive">Could not load environment selection.</Text>
          ) : null}
        </View>
        <UsageLimitsSection
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
          />
        ))}
      </ScrollView>
    </View>
  )
}
