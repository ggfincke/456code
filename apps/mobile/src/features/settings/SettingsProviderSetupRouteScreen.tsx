// apps/mobile/src/features/settings/SettingsProviderSetupRouteScreen.tsx
// manage official Antigravity setup on a selected environment

import { useAtomValue } from '@effect/atom-react'
import type { StaticScreenProps } from '@react-navigation/native'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import { EnvironmentId, ProviderInstanceId, type ProviderAuthFlowState } from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import { useCallback, useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText'
import { ProviderIcon } from '../../components/ProviderIcon'
import { cn } from '../../lib/cn'
import { copyTextWithHaptic } from '../../lib/copyTextWithHaptic'
import { tryOpenExternalUrl } from '../../lib/openExternalUrl'
import { NativeStackScreenOptions } from '../../native/StackHeader'
import { useEnvironments } from '../../state/environments'
import { serverEnvironment } from '../../state/server'
import { useEnvironmentQuery } from '../../state/query'
import { useAtomCommand } from '../../state/use-atom-command'
import { antigravityInstancePatch, readAntigravityOfficialRuntime } from './provider-setup-state'

export type ProviderSetupRouteParams = {
  readonly environmentId: EnvironmentId
  readonly instanceId: ProviderInstanceId
}

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const
const isEnvironmentId = Schema.is(EnvironmentId)
const isProviderInstanceId = Schema.is(ProviderInstanceId)

function SetupButton(props: {
  readonly label: string
  readonly disabled?: boolean
  readonly primary?: boolean
  readonly destructive?: boolean
  readonly onPress: () => void
})
{
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        'min-h-11 items-center justify-center rounded-[14px] border border-input-border bg-input px-4 py-3 active:opacity-70 disabled:opacity-40',
        props.primary && 'border-primary bg-primary',
      )}
    >
      <Text
        className={cn(
          'text-base font-sans-bold text-foreground',
          props.primary && 'text-primary-foreground',
          props.destructive && 'text-adaptive-rose-500-400',
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  )
}

export function SettingsProviderSetupRouteScreen({
  route,
}: StaticScreenProps<ProviderSetupRouteParams>)
{
  if (
    !isEnvironmentId(route.params?.environmentId) ||
    !isProviderInstanceId(route.params?.instanceId)
  )
  {
    return (
      <View className="flex-1 bg-sheet p-5">
        <Text className="text-base text-foreground">This provider link is not valid.</Text>
      </View>
    )
  }
  return (
    <ProviderSetupScreen
      key={`${route.params.environmentId}:${route.params.instanceId}`}
      {...route.params}
    />
  )
}

function ProviderSetupScreen({ environmentId, instanceId }: ProviderSetupRouteParams)
{
  const insets = useSafeAreaInsets()
  const { presentationById } = useEnvironments()
  const environment = presentationById.get(environmentId)
  const environmentLabel = environment?.entry.target.label ?? 'this environment'
  const isConnected = environment?.connection.phase === 'connected'
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId))
  const provider = config?.providers.find((item) => item.instanceId === instanceId)
  const [authFlow, setAuthFlow] = useState<ProviderAuthFlowState | null>(null)
  const authQuery = useEnvironmentQuery(
    authFlow?.flowId
      ? serverEnvironment.providerAuthFlow({
          environmentId,
          input: { instanceId, flowId: authFlow.flowId },
        })
      : null,
  )
  const installQuery = useEnvironmentQuery(
    provider?.setup?.canInstall
      ? serverEnvironment.providerInstallState({ environmentId, input: { instanceId } })
      : null,
  )
  const auth = authQuery.data ?? authFlow
  const installation = installQuery.data
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, COMMAND_OPTIONS)
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, COMMAND_OPTIONS)
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, COMMAND_OPTIONS)
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, COMMAND_OPTIONS)
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, COMMAND_OPTIONS)
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, COMMAND_OPTIONS)
  const removeInstall = useAtomCommand(serverEnvironment.removeProviderInstall, COMMAND_OPTIONS)
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, COMMAND_OPTIONS)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const currentInstanceConfig =
    config?.settings.providerInstances[instanceId]?.config ??
    (instanceId === 'antigravity' ? config?.settings.providers.antigravity : undefined)
  const runtime = readAntigravityOfficialRuntime(currentInstanceConfig)
  const runtimePath = customPath || (runtime.mode === 'custom' ? runtime.executablePath : '')
  const authActive =
    auth?.phase === 'starting' || auth?.phase === 'waiting' || auth?.phase === 'verifying'
  const installActive =
    installation?.phase === 'downloading' ||
    installation?.phase === 'extracting' ||
    installation?.phase === 'verifying'
  const installed =
    provider?.installed === true ||
    (runtime.mode === 'managed' && installation?.installedVersion != null)
  const controlsDisabled = busy || !isConnected

  const perform = useCallback(
    async <A, E>(
      command: () => Promise<AtomCommandResult<A, E>>,
      failureMessage: string,
    ): Promise<A | null> =>
    {
      if (busyRef.current || !isConnected) return null
      busyRef.current = true
      setBusy(true)
      setError(null)
      try
      {
        const result = await command()
        if (result._tag === 'Failure')
        {
          if (!isAtomCommandInterrupted(result))
          {
            const failure = squashAtomCommandFailure(result)
            setError(failure instanceof Error ? failure.message : failureMessage)
          }
          return null
        }
        return result.value
      }
      catch
      {
        setError(failureMessage)
        return null
      }
      finally
      {
        busyRef.current = false
        setBusy(false)
      }
    },
    [isConnected],
  )

  const updateProvider = (input: Parameters<typeof antigravityInstancePatch>[2]) =>
  {
    if (!config || !provider) return
    const patch = antigravityInstancePatch(config.settings, provider, input)
    if (!patch) return
    void perform(
      () => updateSettings({ environmentId, input: { patch } }),
      'Could not update Antigravity settings.',
    )
  }

  const target = { environmentId, input: { instanceId } }
  const title = provider?.displayName ?? 'Antigravity'
  const authorizationUrl = auth?.phase === 'waiting' ? auth.authorizationUrl : null

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          title,
        }}
      />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-5 pt-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center gap-3 rounded-[20px] bg-card p-4">
          <ProviderIcon provider="antigravity" size={28} />
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-sans-bold text-foreground">{title}</Text>
            <Text className="text-sm text-foreground-muted">{environmentLabel}</Text>
          </View>
        </View>

        {!isConnected ? (
          <Text className="text-base text-foreground">
            Reconnect to this environment to continue setup.
          </Text>
        ) : null}

        {config && provider?.driver === 'antigravity' ? (
          <>
            <View className="gap-3 rounded-[20px] bg-card p-4">
              <Text className="text-lg font-sans-bold text-foreground">Runtime</Text>
              <Text className="text-sm text-foreground-muted">
                {runtime.mode === 'managed'
                  ? 'Managed official runtime'
                  : `Custom executable: ${runtime.executablePath}`}
              </Text>
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <SetupButton
                    label="Managed"
                    primary={runtime.mode === 'managed'}
                    disabled={controlsDisabled}
                    onPress={() => updateProvider({ officialRuntime: { mode: 'managed' } })}
                  />
                </View>
                <View className="flex-1">
                  <SetupButton
                    label="Use custom path"
                    primary={runtime.mode === 'custom'}
                    disabled={controlsDisabled || runtimePath.trim().length === 0}
                    onPress={() =>
                      updateProvider({
                        officialRuntime: {
                          mode: 'custom',
                          executablePath: runtimePath.trim(),
                        },
                      })
                    }
                  />
                </View>
              </View>
              <TextInput
                accessibilityLabel="Antigravity custom executable path"
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-12 rounded-[14px] border border-input-border bg-input px-3 py-3 text-base text-foreground"
                editable={!controlsDisabled}
                onChangeText={setCustomPath}
                placeholder="/path/to/antigravity-acp"
                value={runtimePath}
              />
              <SetupButton
                label={provider.enabled ? 'Disable Antigravity' : 'Enable Antigravity'}
                disabled={controlsDisabled}
                onPress={() => updateProvider({ enabled: !provider.enabled })}
              />
            </View>

            {runtime.mode === 'managed' ? (
              <View className="gap-3 rounded-[20px] bg-card p-4">
                <Text className="text-lg font-sans-bold text-foreground">Installation</Text>
                <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                  {installation?.phase === 'downloading'
                    ? `Downloading ${Math.round(installation.downloadedBytes / 1_048_576)}${installation.totalBytes === null ? '' : ` of ${Math.round(installation.totalBytes / 1_048_576)}`} MB.`
                    : installActive
                      ? `${installation?.phase === 'extracting' ? 'Extracting' : 'Verifying'} Antigravity.`
                      : installed
                        ? 'The official runtime is installed.'
                        : 'Install the official runtime before signing in.'}
                </Text>
                {installActive && installation?.operationId ? (
                  <SetupButton
                    label="Cancel installation"
                    disabled={controlsDisabled}
                    onPress={() =>
                      void perform(
                        () =>
                          cancelInstall({
                            environmentId,
                            input: { instanceId, operationId: installation.operationId! },
                          }),
                        'Could not cancel the installation.',
                      )
                    }
                  />
                ) : provider.setup?.canInstall ? (
                  <SetupButton
                    label={installed ? 'Reinstall Antigravity' : 'Install Antigravity'}
                    primary={!installed}
                    disabled={controlsDisabled || authActive}
                    onPress={() =>
                      void perform(() => startInstall(target), 'Could not start the installation.')
                    }
                  />
                ) : null}
                {installation?.canRemove && !installActive ? (
                  <SetupButton
                    label="Remove managed runtime"
                    destructive
                    disabled={controlsDisabled || authActive}
                    onPress={() =>
                      Alert.alert(
                        'Remove the Antigravity runtime?',
                        'Google sign-in and thread history will be kept.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: () =>
                              void perform(
                                () => removeInstall(target),
                                'Could not remove the installation.',
                              ),
                          },
                        ],
                      )
                    }
                  />
                ) : null}
              </View>
            ) : null}

            <View className="gap-3 rounded-[20px] bg-card p-4">
              <Text className="text-lg font-sans-bold text-foreground">
                Personal Google account
              </Text>
              <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
                {provider.auth.status === 'authenticated'
                  ? 'Signed in. Credentials stay on this environment.'
                  : (auth?.message ?? 'Sign in with the Google account you use for Antigravity.')}
              </Text>
              {authorizationUrl ? (
                <>
                  <SetupButton
                    label="Open Google sign-in"
                    primary
                    disabled={controlsDisabled}
                    onPress={() => void tryOpenExternalUrl(authorizationUrl, 'provider-auth')}
                  />
                  <SetupButton
                    label="Copy sign-in link"
                    disabled={controlsDisabled}
                    onPress={() =>
                      copyTextWithHaptic(authorizationUrl, { target: 'provider-sign-in-link' })
                    }
                  />
                  <TextInput
                    accessibilityLabel="Google sign-in return URL"
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect={false}
                    className="min-h-12 rounded-[14px] border border-input-border bg-input px-3 py-3 text-base text-foreground"
                    editable={!controlsDisabled}
                    keyboardType="url"
                    onChangeText={setCallbackUrl}
                    placeholder="http://127.0.0.1:.../"
                    textContentType="none"
                    value={callbackUrl}
                  />
                  <SetupButton
                    label="Complete sign-in"
                    primary
                    disabled={controlsDisabled || callbackUrl.trim().length === 0 || !auth?.flowId}
                    onPress={() =>
                      {
                      const flowId = auth?.flowId
                      const submittedUrl = callbackUrl.trim()
                      if (!flowId || submittedUrl.length === 0) return
                      setCallbackUrl('')
                      void perform(
                        () =>
                          completeAuth({
                            environmentId,
                            input: { instanceId, flowId, callbackUrl: submittedUrl },
                          }),
                        'Could not complete Google sign-in.',
                      ).then((flow) => flow && setAuthFlow(flow))
                    }}
                  />
                </>
              ) : null}
              {authActive && auth?.flowId ? (
                <SetupButton
                  label="Cancel sign-in"
                  disabled={controlsDisabled}
                  onPress={() =>
                    void perform(
                      () =>
                        cancelAuth({
                          environmentId,
                          input: { instanceId, flowId: auth.flowId! },
                        }),
                      'Could not cancel Google sign-in.',
                    ).then((flow) => flow && setAuthFlow(flow))
                  }
                />
              ) : provider.auth.status === 'authenticated' ? (
                <SetupButton
                  label="Sign out of Google"
                  destructive
                  disabled={controlsDisabled}
                  onPress={() =>
                    Alert.alert(
                      'Sign out of Google?',
                      'This stops Antigravity sessions. Thread history and files will be kept.',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Sign out',
                          style: 'destructive',
                          onPress: () =>
                            void perform(
                              () => logoutAuth(target),
                              'Could not sign out of Google.',
                            ).then((result) =>
                              {
                              if (result) setAuthFlow(null)
                            }),
                        },
                      ],
                    )
                  }
                />
              ) : provider.setup?.canAuthenticate ? (
                <SetupButton
                  label="Sign in with Google"
                  primary
                  disabled={controlsDisabled || !provider.enabled || !installed || installActive}
                  onPress={() =>
                    void perform(() => startAuth(target), 'Could not start Google sign-in.').then(
                      (flow) => flow && setAuthFlow(flow),
                    )
                  }
                />
              ) : null}
            </View>
          </>
        ) : config ? (
          <Text className="text-base text-foreground">
            This provider is not available on this environment.
          </Text>
        ) : (
          <Text className="text-base text-foreground">Loading provider settings.</Text>
        )}

        {error || authQuery.error || installQuery.error ? (
          <Text accessibilityRole="alert" className="text-base text-adaptive-rose-500-400">
            {error ?? authQuery.error ?? installQuery.error}
          </Text>
        ) : null}
        {busy ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            Waiting for the environment.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  )
}
