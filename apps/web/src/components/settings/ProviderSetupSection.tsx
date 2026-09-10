// apps/web/src/components/settings/ProviderSetupSection.tsx
// manage official Antigravity setup from provider settings

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from '@t3tools/client-runtime/state/runtime'
import {
  type AntigravityOfficialRuntime,
  type EnvironmentId,
  type ProviderAuthFlowState,
  type ProviderInstanceId,
  type ServerProvider,
} from '@t3tools/contracts'
import { useRef, useState } from 'react'

import { writeTextToClipboard } from '../../hooks/useCopyToClipboard'
import { ensureLocalApi } from '../../localApi'
import { useEnvironmentQuery } from '../../state/query'
import { serverEnvironment } from '../../state/server'
import { useAtomCommand } from '../../state/use-atom-command'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const

export function readAntigravityOfficialRuntime(config: unknown): AntigravityOfficialRuntime
{
  if (config !== null && typeof config === 'object' && 'officialRuntime' in config)
  {
    const runtime = config.officialRuntime
    if (
      runtime !== null &&
      typeof runtime === 'object' &&
      'mode' in runtime &&
      runtime.mode === 'custom' &&
      'executablePath' in runtime &&
      typeof runtime.executablePath === 'string' &&
      runtime.executablePath.trim().length > 0
    )
    {
      return { mode: 'custom', executablePath: runtime.executablePath.trim() }
    }
  }
  return { mode: 'managed' }
}

export function withAntigravityOfficialRuntime(
  config: unknown,
  runtime: AntigravityOfficialRuntime,
): Record<string, unknown>
{
  const current = config !== null && typeof config === 'object' ? config : {}
  return { ...current, officialRuntime: runtime }
}

export function ProviderSetupSection(props: {
  readonly environmentId: EnvironmentId
  readonly environmentLabel: string
  readonly instanceId: ProviderInstanceId
  readonly provider: ServerProvider | undefined
  readonly config: unknown
  readonly enabled: boolean
  readonly onEnable: () => void
  readonly onConfigChange: (config: Record<string, unknown>) => void
})
{
  const runtime = readAntigravityOfficialRuntime(props.config)
  const [customPathDraft, setCustomPathDraft] = useState(
    runtime.mode === 'custom' ? runtime.executablePath : '',
  )
  const [authFlow, setAuthFlow] = useState<ProviderAuthFlowState | null>(null)
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [callbackUrl, setCallbackUrl] = useState('')
  const pendingRef = useRef(false)
  const provider = props.provider
  const target = { environmentId: props.environmentId, input: { instanceId: props.instanceId } }
  const installQuery = useEnvironmentQuery(
    provider?.setup?.canInstall === true ? serverEnvironment.providerInstallState(target) : null,
  )
  const authQuery = useEnvironmentQuery(
    authFlow?.flowId
      ? serverEnvironment.providerAuthFlow({
          environmentId: props.environmentId,
          input: { instanceId: props.instanceId, flowId: authFlow.flowId },
        })
      : null,
  )
  const currentAuth = authQuery.data ?? authFlow
  const installation = installQuery.data
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, COMMAND_OPTIONS)
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, COMMAND_OPTIONS)
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, COMMAND_OPTIONS)
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, COMMAND_OPTIONS)
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, COMMAND_OPTIONS)
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, COMMAND_OPTIONS)
  const removeInstall = useAtomCommand(serverEnvironment.removeProviderInstall, COMMAND_OPTIONS)
  const authActive =
    currentAuth?.phase === 'starting' ||
    currentAuth?.phase === 'waiting' ||
    currentAuth?.phase === 'verifying'
  const installActive =
    installation?.phase === 'downloading' ||
    installation?.phase === 'extracting' ||
    installation?.phase === 'verifying'
  const managed = runtime.mode === 'managed'
  const installed =
    provider?.installed === true || (managed && installation?.installedVersion != null)
  const authenticated = provider?.auth.status === 'authenticated'
  const installationStatusMessage =
    installation?.phase === 'downloading'
      ? `Downloading ${(installation.downloadedBytes / 1_000_000).toFixed(1)} MB${installation.totalBytes === null ? '' : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)} MB`}.`
      : installActive
        ? `${installation?.phase === 'extracting' ? 'Extracting' : 'Verifying'} Antigravity.`
        : installed
          ? `Antigravity is available${provider?.version ? ` (${provider.version})` : ''}.`
          : managed
            ? 'Install the managed runtime before signing in.'
            : 'The custom executable is not available.'

  async function runCommand<A, E>(
    label: string,
    command: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<A | null>
  {
    if (pendingRef.current) return null
    pendingRef.current = true
    setPendingLabel(label)
    setError(null)
    try
    {
      const result = await command()
      if (result._tag === 'Failure')
      {
        if (!isAtomCommandInterrupted(result))
        {
          const failure = squashAtomCommandFailure(result)
          setError(failure instanceof Error ? failure.message : 'Provider setup failed.')
        }
        return null
      }
      return result.value
    }
    catch
    {
      setError('Provider setup failed.')
      return null
    }
    finally
    {
      pendingRef.current = false
      setPendingLabel(null)
    }
  }

  const startSignIn = async () =>
  {
    const flow = await runCommand('Starting Google sign-in', () => startAuth(target))
    if (flow)
    {
      setAuthFlow(flow)
      setCallbackUrl('')
    }
  }

  const completeSignIn = async () =>
  {
    const flowId = currentAuth?.flowId
    const submittedUrl = callbackUrl.trim()
    if (!flowId || submittedUrl.length === 0) return
    setCallbackUrl('')
    const flow = await runCommand('Checking Google sign-in', () =>
      completeAuth({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId, flowId, callbackUrl: submittedUrl },
      }),
    )
    if (flow) setAuthFlow(flow)
  }

  const authorizationUrl = currentAuth?.phase === 'waiting' ? currentAuth.authorizationUrl : null
  const disabled = pendingLabel !== null

  return (
    <section aria-label="Antigravity setup" className="grid gap-4 border-t border-border/60 pt-4">
      <div className="grid gap-2">
        <p className="text-xs font-medium text-foreground">Official runtime</p>
        <p className="text-xs text-muted-foreground">
          Antigravity runs on {props.environmentLabel}. Managed mode downloads the reviewed official
          ACP runtime; custom mode uses an executable already present there.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant={managed ? 'default' : 'outline'}
            onClick={() =>
              props.onConfigChange(
                withAntigravityOfficialRuntime(props.config, { mode: 'managed' }),
              )
            }
          >
            Managed
          </Button>
          <Button
            size="xs"
            variant={managed ? 'outline' : 'default'}
            disabled={customPathDraft.trim().length === 0}
            onClick={() =>
              props.onConfigChange(
                withAntigravityOfficialRuntime(props.config, {
                  mode: 'custom',
                  executablePath: customPathDraft.trim(),
                }),
              )
            }
          >
            Use custom path
          </Button>
        </div>
        <Input
          aria-label="Antigravity custom executable path"
          value={customPathDraft}
          placeholder="/path/to/antigravity-acp"
          spellCheck={false}
          onChange={(event) => setCustomPathDraft(event.target.value)}
        />
      </div>

      {!props.enabled ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Enable Antigravity before installing or signing in.</span>
          <Button size="xs" variant="outline" onClick={props.onEnable}>
            Enable Antigravity
          </Button>
        </div>
      ) : provider?.setup === undefined ? (
        <p className="text-xs text-muted-foreground">
          Update this environment to install Antigravity and sign in with Google here.
        </p>
      ) : (
        <>
          <div className="grid gap-2">
            <p className="text-xs font-medium text-foreground">Installation</p>
            <p role="status" className="text-xs text-muted-foreground">
              {installationStatusMessage}
            </p>
            {installation?.message && installation.message !== installationStatusMessage ? (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {installation.message}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {managed && installActive && installation?.operationId ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void runCommand('Cancelling installation', () =>
                      cancelInstall({
                        environmentId: props.environmentId,
                        input: {
                          instanceId: props.instanceId,
                          operationId: installation.operationId!,
                        },
                      }),
                    )
                  }
                >
                  Cancel installation
                </Button>
              ) : managed && provider.setup.canInstall ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled || authActive}
                  onClick={() =>
                    void runCommand('Starting installation', () => startInstall(target))
                  }
                >
                  {installed ? 'Reinstall Antigravity' : 'Install Antigravity'}
                </Button>
              ) : null}
              {managed && installation?.canRemove && !installActive ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled || authActive}
                  onClick={() =>
                    void runCommand('Removing installation', () => removeInstall(target))
                  }
                >
                  Remove managed runtime
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium text-foreground">Personal Google account</p>
            <p role="status" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {authenticated
                ? 'Signed in with Google.'
                : (currentAuth?.message ??
                  'Sign in with the Google account you use for Antigravity.')}
            </p>
            {authorizationUrl ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void ensureLocalApi().shell.openExternal(authorizationUrl)}
                  >
                    Open sign-in page
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void writeTextToClipboard(authorizationUrl, 'Google sign-in link')
                    }
                  >
                    Copy sign-in link
                  </Button>
                </div>
                <form
                  className="grid gap-2"
                  onSubmit={(event) =>
                    {
                    event.preventDefault()
                    void completeSignIn()
                  }}
                >
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`antigravity-callback-${props.instanceId}`}
                  >
                    If the final localhost page does not load, paste its full URL here.
                  </label>
                  <Input
                    id={`antigravity-callback-${props.instanceId}`}
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={callbackUrl}
                    maxLength={16_384}
                    onChange={(event) => setCallbackUrl(event.target.value)}
                  />
                  <Button
                    className="w-fit"
                    size="xs"
                    variant="outline"
                    type="submit"
                    disabled={disabled || callbackUrl.trim().length === 0}
                  >
                    Continue
                  </Button>
                </form>
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {authActive && currentAuth?.flowId ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    void runCommand('Cancelling Google sign-in', () =>
                      cancelAuth({
                        environmentId: props.environmentId,
                        input: { instanceId: props.instanceId, flowId: currentAuth.flowId! },
                      }),
                    ).then((flow) => flow && setAuthFlow(flow))
                  }
                >
                  Cancel sign-in
                </Button>
              ) : authenticated ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void runCommand('Signing out', () => logoutAuth(target)).then((result) =>
                      {
                      if (result) setAuthFlow(null)
                    })
                  }
                >
                  Sign out of Google
                </Button>
              ) : provider.setup.canAuthenticate ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled || !installed || installActive}
                  onClick={() => void startSignIn()}
                >
                  Sign in with Google
                </Button>
              ) : null}
            </div>
          </div>
        </>
      )}

      {pendingLabel ? (
        <p role="status" className="text-xs">
          {pendingLabel}.
        </p>
      ) : null}
      {error || installQuery.error || authQuery.error ? (
        <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
          {error ?? installQuery.error ?? authQuery.error}
        </p>
      ) : null}
    </section>
  )
}
