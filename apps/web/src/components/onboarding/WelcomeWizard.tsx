// apps/web/src/components/onboarding/WelcomeWizard.tsx
// guides first-run provider setup and bounded history import

import {
  type ExecutionEnvironmentPlatformOs,
  type ServerProvider,
  type ServerSettings,
} from '@t3tools/contracts'
import { CheckCircle2Icon, CircleAlertIcon, DownloadIcon, LoaderIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useImportSessions } from '../../hooks/useImportSessions'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { useCompleteOnboarding } from '../../onboarding/firstRun'
import {
  getOnboardingProviderState,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from '../../onboarding/providerReadiness.logic'
import {
  groupOnboardingImportCandidates,
  recentOnboardingImportCandidateKeys,
} from '../../onboarding/projectImport.logic'
import { candidateKey, importRequestItemForCandidate } from '../settings/ImportSessionsPanel.logic'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'

export interface WelcomeWizardProps
{
  readonly providers: ReadonlyArray<ServerProvider>
  readonly settings: ServerSettings
  readonly platform: ExecutionEnvironmentPlatformOs
  readonly onPrepareTerminal?: (input: {
    readonly command: string
    readonly providerInstanceId: string
  }) => Promise<void>
  readonly onFinished?: () => void
}

function providerForDriver(
  providers: ReadonlyArray<ServerProvider>,
  driver: 'claudeAgent' | 'codex',
): ServerProvider | undefined
{
  return providers
    .filter((provider) => provider.driver === driver)
    .toSorted(
      (left, right) =>
        Number(getOnboardingProviderState(right) === 'ready') -
        Number(getOnboardingProviderState(left) === 'ready'),
    )[0]
}

export function WelcomeWizard({
  providers,
  settings,
  platform,
  onPrepareTerminal,
  onFinished,
}: WelcomeWizardProps)
{
  const completeOnboarding = useCompleteOnboarding()
  const imports = useImportSessions()
  const [step, setStep] = useState<'providers' | 'import'>('providers')
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const [standaloneCommand, setStandaloneCommand] = useState<string | null>(null)
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: 'setup command',
    onError: () =>
      setSetupMessage('Clipboard access failed. Select the command and copy it manually.'),
  })

  useEffect(() =>
  {
    if (step === 'import')
    {
      void imports.scan()
    }
  }, [imports.scan, step])

  useEffect(() =>
  {
    if (imports.scanResult === null) return
    setSelectedKeys(recentOnboardingImportCandidateKeys(imports.scanResult.candidates))
  }, [imports.scanResult])

  const groups = useMemo(
    () => groupOnboardingImportCandidates(imports.scanResult?.candidates ?? []),
    [imports.scanResult?.candidates],
  )
  const selectedItems = useMemo(
    () =>
      (imports.scanResult?.candidates ?? []).flatMap((candidate) =>
      {
        if (!selectedKeys.has(candidateKey(candidate))) return []
        const item = importRequestItemForCandidate(
          candidate,
          candidate.providerInstanceIds[0] ?? null,
        )
        return item === null ? [] : [item]
      }),
    [imports.scanResult?.candidates, selectedKeys],
  )

  const finish = () =>
  {
    completeOnboarding()
    onFinished?.()
  }

  const prepareProvider = async (provider: ServerProvider) =>
  {
    const state = getOnboardingProviderState(provider)
    const driver =
      provider.driver === 'claudeAgent'
        ? 'claudeAgent'
        : provider.driver === 'codex'
          ? 'codex'
          : null
    if (driver === null) return
    const command =
      state === 'install'
        ? resolveOnboardingProviderInstallCommand(driver, platform)
        : resolveOnboardingProviderLoginCommand(provider, settings, platform)
    if (onPrepareTerminal === undefined)
    {
      setStandaloneCommand(command)
      setSetupMessage('Copy this command into a terminal, review it, then run it yourself.')
      return
    }
    setStandaloneCommand(null)
    setSetupMessage(null)
    try
    {
      await onPrepareTerminal({ command, providerInstanceId: provider.instanceId })
      setSetupMessage('The command is ready in the project terminal. Review it, then press Return.')
    }
    catch (error)
    {
      setSetupMessage(error instanceof Error ? error.message : 'Could not prepare the terminal.')
    }
  }

  if (step === 'providers')
  {
    const providerRows = (['claudeAgent', 'codex'] as const).map((driver) => ({
      driver,
      provider: providerForDriver(providers, driver),
    }))
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
        <div className="space-y-2">
          <p className="text-sm font-medium text-primary">Welcome to 456code</p>
          <h1 className="text-2xl font-semibold tracking-tight">Connect an agent</h1>
          <p className="text-sm text-muted-foreground">
            Use an existing Codex or Claude installation, or prepare the official standalone
            installer for your terminal. 456code never runs the installer automatically.
          </p>
        </div>
        <div className="divide-y rounded-xl border bg-card">
          {providerRows.map(({ driver, provider }) =>
          {
            const state = getOnboardingProviderState(provider)
            const label = driver === 'claudeAgent' ? 'Claude' : 'Codex'
            return (
              <div key={driver} className="flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{label}</span>
                    <Badge variant={state === 'ready' ? 'success' : 'secondary'}>
                      {state === 'ready'
                        ? 'Ready'
                        : state === 'install'
                          ? 'Not installed'
                          : state === 'signIn'
                            ? 'Sign in'
                            : state === 'disabled'
                              ? 'Disabled'
                              : state === 'attention'
                                ? 'Needs attention'
                                : 'Checking'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {provider?.message ?? 'Waiting for the server provider check.'}
                  </p>
                </div>
                {provider &&
                (state === 'install' || state === 'signIn' || state === 'attention') ? (
                  <Button variant="outline" onClick={() => void prepareProvider(provider)}>
                    {state === 'install' ? 'Prepare install' : 'Prepare sign-in'}
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
        {setupMessage ? (
          <p role="status" className="text-sm text-muted-foreground">
            {setupMessage}
          </p>
        ) : null}
        {standaloneCommand ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2">
            <code className="min-w-0 flex-1 select-all overflow-x-auto px-1 text-xs">
              {standaloneCommand}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyToClipboard(standaloneCommand, undefined)}
            >
              {isCopied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <Button variant="ghost" onClick={finish}>
            Skip setup
          </Button>
          <Button onClick={() => setStep('import')}>Continue</Button>
        </div>
      </section>
    )
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="space-y-2">
        <p className="text-sm font-medium text-primary">Project history</p>
        <h1 className="text-2xl font-semibold tracking-tight">Import recent conversations</h1>
        <p className="text-sm text-muted-foreground">
          Sessions are read from this environment and grouped by repository. You can stop safely
          between bounded import batches.
        </p>
      </div>
      <div aria-live="polite" className="text-sm text-muted-foreground">
        {imports.isScanning ? 'Scanning for local sessions…' : null}
        {imports.scanError ? `Scan failed: ${imports.scanError}` : null}
        {imports.importProgress
          ? `${imports.importProgress.completed} of ${imports.importProgress.total} processed.`
          : null}
        {imports.importResult
          ? `${imports.importResult.imported.length} imported, ${imports.importResult.skipped.length} skipped, ${imports.importResult.failed.length} failed.`
          : null}
      </div>
      <div className="max-h-96 space-y-4 overflow-y-auto pr-1">
        {groups.map((group) => (
          <fieldset key={group.key} className="rounded-xl border bg-card p-3">
            <legend className="px-1 text-sm font-medium">{group.title}</legend>
            <div className="mt-2 space-y-1">
              {group.candidates.map((candidate) =>
              {
                const key = candidateKey(candidate)
                const checked = selectedKeys.has(key)
                return (
                  <label
                    key={key}
                    className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={imports.isImporting || candidate.providerInstanceIds.length === 0}
                      onCheckedChange={(nextChecked) =>
                      {
                        setSelectedKeys((current) =>
                        {
                          const next = new Set(current)
                          if (nextChecked) next.add(key)
                          else next.delete(key)
                          return next
                        })
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {candidate.title ?? candidate.sourcePath}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {candidate.cwd ?? 'No recorded directory'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
        {!imports.isScanning && groups.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No importable Codex or Claude sessions were found.
          </div>
        ) : null}
      </div>
      {imports.importError ? (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <CircleAlertIcon className="size-4" aria-hidden />
          {imports.importError}
        </p>
      ) : imports.importResult && imports.importResult.failed.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2Icon className="size-4" aria-hidden />
          Import finished.
        </p>
      ) : null}
      <div className="flex justify-between gap-3">
        <Button variant="ghost" onClick={() => setStep('providers')} disabled={imports.isImporting}>
          Back
        </Button>
        <div className="flex gap-2">
          {!imports.importResult && !imports.isImporting ? (
            <Button variant="ghost" onClick={finish}>
              Continue without importing
            </Button>
          ) : null}
          {imports.isImporting ? (
            <Button variant="outline" onClick={imports.cancelImport}>
              Stop after this batch
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={imports.isScanning || imports.isImporting}
            onClick={() => void imports.scan()}
          >
            {imports.isScanning ? <LoaderIcon className="animate-spin" /> : null}
            Scan again
          </Button>
          {imports.importResult ? (
            <Button onClick={finish}>Done</Button>
          ) : (
            <Button
              disabled={selectedItems.length === 0 || imports.isImporting}
              onClick={() => void imports.importSelected({ items: selectedItems })}
            >
              <DownloadIcon />
              Import selected
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
