// apps/server/src/provider/Layers/CoralProvider.ts
// build Coral provider snapshots from version probes, fallback models, and bound sessions

import type {
  CoralSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from '@t3tools/contracts'
import { causeErrorTag } from '@t3tools/shared/observability'
import { createModelCapabilities } from '@t3tools/shared/model'
import { resolveSpawnCommand } from '@t3tools/shared/shell'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import {
  buildCoralAcpEnvironment,
  coralModelsFromSessionSetup,
  DEFAULT_CORAL_MODEL,
} from '../acp/CoralAcpSupport.ts'
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from '../providerSnapshot.ts'
import { CORAL_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from '../maintenance/providerMaintenance.ts'
import { HttpClient } from 'effect/unstable/http'

const CORAL_PRESENTATION = {
  displayName: 'Coral',
  capabilities: CORAL_PROVIDER_CAPABILITIES,
  badgeLabel: 'Early Access',
  showInteractionModeToggle: false,
} as const

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
})

const VERSION_PROBE_TIMEOUT_MS = 4_000

const CORAL_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_CORAL_MODEL,
    name: DEFAULT_CORAL_MODEL,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
]

export function coralProviderModelsFromSessionSetup(
  sessionSetupResult: Parameters<typeof coralModelsFromSessionSetup>[0],
): ReadonlyArray<ServerProviderModel>
{
  return coralModelsFromSessionSetup(sessionSetupResult).map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  }))
}

// empty keeps the pre-session fallback so a resume without inventory does not wipe the picker
export function overlayCoralSessionModels<
  Snapshot extends { readonly models: ReadonlyArray<ServerProviderModel> },
>(snapshot: Snapshot, sessionModels: ReadonlyArray<ServerProviderModel>): Snapshot
{
  if (sessionModels.length === 0) return snapshot
  return { ...snapshot, models: sessionModels }
}

export function buildInitialCoralProviderSnapshot(
  coralSettings: CoralSettings,
): Effect.Effect<ServerProviderDraft>
{
  return Effect.gen(function* ()
  {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso)
    if (!coralSettings.enabled)
    {
      return buildServerProvider({
        presentation: CORAL_PRESENTATION,
        enabled: false,
        checkedAt,
        models: CORAL_FALLBACK_MODELS,
        probe: {
          installed: false,
          version: null,
          status: 'warning',
          auth: { status: 'not-applicable' },
          message: 'Coral is disabled in 456code settings.',
        },
      })
    }

    return buildServerProvider({
      presentation: CORAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: CORAL_FALLBACK_MODELS,
      probe: {
        installed: true,
        version: null,
        status: 'warning',
        auth: { status: 'not-applicable' },
        message: 'Checking Coral CLI and Ollama availability...',
      },
    })
  })
}

const runCoralVersionCommand = (coralSettings: CoralSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* ()
  {
    const command = coralSettings.binaryPath || 'coral'
    const spawnCommand = yield* resolveSpawnCommand(command, ['--version'], {
      env: environment,
    })
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    )
  })

export const checkCoralProviderStatus = Effect.fn('checkCoralProviderStatus')(function* (
  coralSettings: CoralSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
>
{
  const checkedAt = DateTime.formatIso(yield* DateTime.now)
  if (!coralSettings.enabled)
  {
    return yield* buildInitialCoralProviderSnapshot(coralSettings)
  }

  const runtimeEnvironment = buildCoralAcpEnvironment(coralSettings, environment)
  const versionResult = yield* runCoralVersionCommand(coralSettings, runtimeEnvironment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  )

  if (Result.isFailure(versionResult))
  {
    const error = versionResult.failure
    yield* Effect.logWarning('Coral CLI health check failed.', {
      errorTag: error._tag,
    })
    return buildServerProvider({
      presentation: CORAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: CORAL_FALLBACK_MODELS,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: 'error',
        auth: { status: 'not-applicable' },
        message: isCommandMissingCause(error)
          ? 'Coral CLI (`coral`) is not installed or not on PATH.'
          : 'Failed to execute the Coral CLI health check.',
      },
    })
  }

  if (Option.isNone(versionResult.success))
  {
    return buildServerProvider({
      presentation: CORAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: CORAL_FALLBACK_MODELS,
      probe: {
        installed: true,
        version: null,
        status: 'error',
        auth: { status: 'not-applicable' },
        message: 'Coral CLI is installed but timed out while running `coral --version`.',
      },
    })
  }

  const versionOutput = versionResult.success.value
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`)
  if (versionOutput.code !== 0)
  {
    yield* Effect.logWarning('Coral CLI version probe exited with a non-zero status.', {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    })
    return buildServerProvider({
      presentation: CORAL_PRESENTATION,
      enabled: true,
      checkedAt,
      models: CORAL_FALLBACK_MODELS,
      probe: {
        installed: true,
        version,
        status: 'error',
        auth: { status: 'not-applicable' },
        message: 'Coral CLI is installed but failed to run.',
      },
    })
  }

  return buildServerProvider({
    presentation: CORAL_PRESENTATION,
    enabled: true,
    checkedAt,
    models: CORAL_FALLBACK_MODELS,
    probe: {
      installed: true,
      version,
      status: 'ready',
      auth: { status: 'not-applicable' },
    },
  })
})

export const enrichCoralSnapshot = (input: {
  readonly snapshot: ServerProvider
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities
  readonly enableProviderUpdateChecks?: boolean
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>
  readonly httpClient: HttpClient.HttpClient
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning('Coral version advisory enrichment failed.', {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  )
