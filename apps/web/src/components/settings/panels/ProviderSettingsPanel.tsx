// apps/web/src/components/settings/panels/ProviderSettingsPanel.tsx
// renders provider instance and model settings
import { useAtomValue } from '@effect/atom-react'
import { safeErrorLogAttributes } from '@t3tools/client-runtime/errors'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ServerSettingsPatch,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from '@t3tools/contracts'
import { DEFAULT_UNIFIED_SETTINGS } from '@t3tools/contracts/settings'
import * as Arr from 'effect/Array'
import * as Equal from 'effect/Equal'
import * as Result from 'effect/Result'
import { LoaderIcon, PlusIcon, RefreshCwIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePrimarySettings, useUpdatePrimarySettings } from '../../../hooks/useSettings'
import { resolveAppModelSelectionState } from '../../../modelSelection'
import { usePrimaryEnvironment } from '../../../state/environments'
import { primaryServerProvidersAtom, serverEnvironment } from '../../../state/server'
import { useAtomCommand } from '../../../state/use-atom-command'
import { getRelativeTimeState } from '../../../timestampFormat'
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from '../../ProviderUpdateLaunchNotification.logic'
import { Button } from '../../ui/button'
import { stackedThreadToast, toastManager } from '../../ui/toast'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'
import { AddProviderInstanceDialog } from '../AddProviderInstanceDialog'
import { ProviderInstanceCard } from '../ProviderInstanceCard'
import { buildProviderInstanceUpdatePatch } from '../SettingsPanels.logic'
import { DRIVER_OPTIONS, getDriverOption } from '../providerDriverMeta'
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsSection,
  useRelativeTimeTick,
} from '../settingsLayout'

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V>
{
  const next = { ...record } as Record<ProviderInstanceId, V>
  delete next[key]
  return next
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
)
{
  return favorites.filter((favorite) => favorite.provider !== instanceId)
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}))

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null })
{
  useRelativeTimeTick()
  const lastCheckedRelative = getRelativeTimeState(lastCheckedAt)

  if (lastCheckedRelative.status === 'missing')
  {
    return null
  }

  if (lastCheckedRelative.status === 'invalid')
  {
    return <span className="text-[11px] text-muted-foreground/50">Checked unavailable</span>
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{' '}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  )
}

export function ProviderSettingsPanel()
{
  const settings = usePrimarySettings()
  const updateSettings = useUpdatePrimarySettings()
  const serverProviders = useAtomValue(primaryServerProvidersAtom)
  const primaryEnvironment = usePrimaryEnvironment()
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  })
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  })
  const persistProviderSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  })
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false)
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false)
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set())
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({})
  const refreshingRef = useRef(false)
  const providerInstancesRef = useRef(settings.providerInstances)

  useEffect(() =>
  {
    providerInstancesRef.current = settings.providerInstances
  }, [settings.providerInstances])

  const updateProviderSettings = useCallback(
    async (patch: ServerSettingsPatch): Promise<void> =>
    {
      const previousProviderInstances = providerInstancesRef.current
      const nextProviderInstances = patch.providerInstances
      if (nextProviderInstances)
      {
        providerInstancesRef.current = nextProviderInstances
      }
      if (!primaryEnvironment)
      {
        providerInstancesRef.current = previousProviderInstances
        throw new Error('The primary environment is not connected.')
      }
      const result = await persistProviderSettings({
        environmentId: primaryEnvironment.environmentId,
        input: { patch },
      })
      if (result._tag === 'Failure')
      {
        if (providerInstancesRef.current === nextProviderInstances)
        {
          providerInstancesRef.current = previousProviderInstances
        }
        throw squashAtomCommandFailure(result)
      }
    },
    [persistProviderSettings, primaryEnvironment],
  )
  const reportProviderSettingsFailure = (error: unknown) =>
  {
    toastManager.add({
      type: 'error',
      title: 'Could not update provider settings',
      description: error instanceof Error ? error.message : 'Update failed.',
    })
  }

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  )
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  )
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== 'cursor' ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make('cursor')),
      ),
  )
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders)
  const textGenInstanceId = textGenerationModelSelection.instanceId
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null

  const refreshProviders = useCallback(() =>
  {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setIsRefreshingProviders(true)
    if (!primaryEnvironment)
    {
      refreshingRef.current = false
      setIsRefreshingProviders(false)
      return
    }
    void (async () =>
    {
      const result = await refreshServerProviders({
        environmentId: primaryEnvironment.environmentId,
        input: {},
      })
      refreshingRef.current = false
      setIsRefreshingProviders(false)
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        console.warn('Failed to refresh providers', {
          operation: 'refresh-providers',
          environmentId: primaryEnvironment.environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        })
      }
    })()
  }, [primaryEnvironment, refreshServerProviders])

  const runProviderUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) =>
    {
      if (!primaryEnvironment) return
      let started = false
      setUpdatingProviderDrivers((previous) =>
      {
        if (previous.has(candidate.driver))
        {
          return previous
        }
        started = true
        const next = new Set(previous)
        next.add(candidate.driver)
        return next
      })
      if (!started)
      {
        return
      }

      const result = await updateProvider({
        environmentId: primaryEnvironment.environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
        },
      })
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        toastManager.add(
          stackedThreadToast({
            type: 'error',
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}`,
            description:
              error instanceof Error
                ? error.message
                : 'The provider update command could not be started.',
          }),
        )
      }
      setUpdatingProviderDrivers((previous) =>
      {
        if (!previous.has(candidate.driver))
        {
          return previous
        }
        const next = new Set(previous)
        next.delete(candidate.driver)
        return next
      })
    },
    [primaryEnvironment, updateProvider],
  )

  interface InstanceRow
  {
    readonly instanceId: ProviderInstanceId
    readonly instance: ProviderInstanceConfig
    readonly driver: ProviderDriverKind
    readonly isDefault: boolean
    readonly isDirty?: boolean
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >()
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {}))
  {
    const driver = instance.driver
    const list = instancesByDriver.get(driver) ?? []
    list.push([rawId as ProviderInstanceId, instance])
    instancesByDriver.set(driver, list)
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  )

  const rows: InstanceRow[] = []
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  )

  for (const providerSettings of visibleProviderSettings)
  {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers]
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >
    const driver = providerSettings.provider
    const defaultInstanceId = defaultInstanceIdForDriver(driver)
    const explicitInstance = settings.providerInstances?.[defaultInstanceId]
    const legacyConfig = legacyProviders[providerSettings.provider]!
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!
    const { enabled: legacyEnabled, ...legacyConfigRest } = legacyConfig
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyEnabled,
        config: legacyConfigRest,
      } satisfies ProviderInstanceConfig)
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig)
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    })
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? [])
    {
      if (id === defaultInstanceId) continue
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false })
    }
  }
  for (const [driver, list] of instancesByDriver)
  {
    if (visibleDriverKinds.has(driver)) continue
    for (const [id, instance] of list)
    {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      })
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]['textGenerationModelSelection']
    },
  ) =>
  {
    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        providers: settings.providers,
        providerInstances: providerInstancesRef.current,
      },
      instanceId: row.instanceId,
      instance: next,
      driver: row.driver,
      isDefault: row.isDefault,
      textGenerationModelSelection: options?.textGenerationModelSelection,
    })
    void updateProviderSettings(patch).catch(reportProviderSettingsFailure)
  }

  const deleteProviderInstance = (id: ProviderInstanceId) =>
  {
    const providerInstances = withoutProviderInstanceKey(providerInstancesRef.current, id)
    void updateProviderSettings({ providerInstances }).catch(reportProviderSettingsFailure)
    updateSettings({
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
    })
  }

  const addProviderInstance = useCallback(
    async (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) =>
    {
      await updateProviderSettings({
        providerInstances: {
          ...providerInstancesRef.current,
          [instanceId]: instance,
        },
      })
    },
    [updateProviderSettings],
  )

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>
      readonly modelOrder: ReadonlyArray<string>
    },
  ) =>
  {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))]
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))]
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId)
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    })
  }

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) =>
  {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) =>
        {
          const trimmedSlug = slug.trim()
          return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid
        }),
      ),
    ]
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    })
  }

  const resetDefaultInstance = (driverKind: ProviderDriverKind) =>
  {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers]
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind)
    const defaultLegacyProvider = defaultLegacyProviders[driverKind]
    if (defaultLegacyProvider === undefined) return
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    })
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="settings-providers"
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider instance"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider instance</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label="Refresh provider status"
                  >
                    {isRefreshingProviders ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {rows.map((row) =>
        {
          const driverOption = getDriverOption(row.driver)
          const liveProvider = serverProviders.find(
            (candidate) => candidate.instanceId === row.instanceId,
          )
          const updateCandidate = liveProvider
            ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
            : undefined
          const isDriverUpdateRunning =
            updateCandidate !== undefined &&
            (updatingProviderDrivers.has(updateCandidate.driver) ||
              serverProviders.some(
                (provider) =>
                  provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
              ))
          const showInlineUpdateButton =
            updateCandidate !== undefined &&
            hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders)
          const canRunInlineUpdate =
            updateCandidate !== undefined &&
            canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
            !updatingProviderDrivers.has(updateCandidate.driver)
          const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          }
          const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
            favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
          )
          const resetLabel = driverOption?.label ?? String(row.driver)
          const headerAction =
            row.isDefault && row.isDirty ? (
              <SettingResetButton
                label={`${resetLabel} provider settings`}
                onClick={() => resetDefaultInstance(row.driver)}
              />
            ) : null
          return (
            <ProviderInstanceCard
              key={row.instanceId}
              instanceId={row.instanceId}
              instance={row.instance}
              driverOption={driverOption}
              liveProvider={liveProvider}
              isExpanded={openInstanceDetails[row.instanceId] ?? false}
              onExpandedChange={(open) =>
                setOpenInstanceDetails((existing) => ({
                  ...existing,
                  [row.instanceId]: open,
                }))
              }
              onUpdate={(next) =>
              {
                const wasEnabled = resolveProviderInstanceEnabled(row.instance)
                const isDisabling = next.enabled === false && wasEnabled
                const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId
                if (shouldClearTextGen)
                {
                  updateProviderInstance(row, next, {
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  })
                }
                else
                {
                  updateProviderInstance(row, next)
                }
              }}
              onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
              headerAction={headerAction}
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              onHiddenModelsChange={(hiddenModels) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  hiddenModels,
                })
              }
              onFavoriteModelsChange={(favoriteModels) =>
                updateProviderFavoriteModels(row.instanceId, favoriteModels)
              }
              onModelOrderChange={(modelOrder) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  modelOrder,
                })
              }
              onRunUpdate={
                showInlineUpdateButton && updateCandidate
                  ? () =>
                    {
                      if (!canRunInlineUpdate)
                        {
                        return
                      }
                      void runProviderUpdate(updateCandidate)
                    }
                  : undefined
              }
              isUpdating={showInlineUpdateButton ? isDriverUpdateRunning : undefined}
            />
          )
        })}
      </SettingsSection>

      {isAddInstanceDialogOpen ? (
        <AddProviderInstanceDialog
          open
          onOpenChange={setIsAddInstanceDialogOpen}
          onAdd={addProviderInstance}
        />
      ) : null}
    </SettingsPageContainer>
  )
}
