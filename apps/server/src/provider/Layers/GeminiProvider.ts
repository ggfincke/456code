// apps/server/src/provider/Layers/GeminiProvider.ts
// build Gemini provider snapshots from version probes, fallback models, and bound sessions

import type {
  GeminiSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAccountUsage,
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

import { buildGeminiAcpEnvironment, geminiModelsFromSessionSetup } from '../acp/GeminiAcpSupport.ts'
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from '../providerSnapshot.ts'
import { GEMINI_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from '../maintenance/providerMaintenance.ts'
import { HttpClient } from 'effect/unstable/http'

const GEMINI_PRESENTATION = {
  displayName: 'Gemini',
  capabilities: GEMINI_PROVIDER_CAPABILITIES,
  showInteractionModeToggle: false,
} as const

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
})

const VERSION_PROBE_TIMEOUT_MS = 4_000

const GEMINI_ACCOUNT_USAGE = {
  status: 'unavailable',
  message:
    'Gemini account limits aren’t available through this integration. Check /stats in Gemini CLI.',
} as const satisfies ServerProviderAccountUsage

export const DEFAULT_GEMINI_MODEL = 'auto'

const GEMINI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: 'auto',
    name: 'Gemini Auto',
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: 'flash',
    name: 'Gemini Flash',
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: 'pro',
    name: 'Gemini Pro',
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
]

export function geminiProviderModelsFromSessionSetup(
  sessionSetupResult: Parameters<typeof geminiModelsFromSessionSetup>[0],
): ReadonlyArray<ServerProviderModel>
{
  return geminiModelsFromSessionSetup(sessionSetupResult).map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  }))
}

export function overlayGeminiSessionModels<
  Snapshot extends { readonly models: ReadonlyArray<ServerProviderModel> },
>(snapshot: Snapshot, sessionModels: ReadonlyArray<ServerProviderModel>): Snapshot
{
  return sessionModels.length === 0 ? snapshot : { ...snapshot, models: sessionModels }
}

function geminiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel>
{
  return providerModelsFromSettings(GEMINI_BUILT_IN_MODELS, customModels ?? [], EMPTY_CAPABILITIES)
}

export function buildInitialGeminiProviderSnapshot(
  geminiSettings: GeminiSettings,
): Effect.Effect<ServerProviderDraft>
{
  return Effect.gen(function* ()
  {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso)
    const models = geminiModelsFromSettings(geminiSettings.customModels)

    if (!geminiSettings.enabled)
    {
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: 'warning',
          auth: { status: 'unknown' },
          message: 'Gemini is disabled in 456code settings.',
        },
      })
    }

    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      accountUsage: GEMINI_ACCOUNT_USAGE,
      probe: {
        installed: true,
        version: null,
        status: 'warning',
        auth: { status: 'unknown' },
        message: 'Checking Gemini CLI availability...',
      },
    })
  })
}

const runGeminiVersionCommand = (geminiSettings: GeminiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* ()
  {
    const command = geminiSettings.binaryPath || 'gemini'
    const spawnCommand = yield* resolveSpawnCommand(command, ['--version'], {
      env: environment,
      extendEnv: false,
    })
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        extendEnv: false,
        shell: spawnCommand.shell,
      }),
    )
  })

export const checkGeminiProviderStatus = Effect.fn('checkGeminiProviderStatus')(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
>
{
  const checkedAt = DateTime.formatIso(yield* DateTime.now)
  if (!geminiSettings.enabled)
  {
    return yield* buildInitialGeminiProviderSnapshot(geminiSettings)
  }

  // status probes never inherit ambient API keys; bound instances provide their
  // own sanitized environment and ACP owns authentication on real sessions.
  const runtimeEnvironment = buildGeminiAcpEnvironment(environment)
  const versionResult = yield* runGeminiVersionCommand(geminiSettings, runtimeEnvironment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  )

  if (Result.isFailure(versionResult))
  {
    const error = versionResult.failure
    yield* Effect.logWarning('Gemini CLI health check failed.', {
      errorTag: error._tag,
    })
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: geminiModelsFromSettings(geminiSettings.customModels),
      accountUsage: GEMINI_ACCOUNT_USAGE,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: 'error',
        auth: { status: 'unknown' },
        message: isCommandMissingCause(error)
          ? 'Gemini CLI (`gemini`) is not installed or not on PATH.'
          : 'Failed to execute the Gemini CLI health check.',
      },
    })
  }

  if (Option.isNone(versionResult.success))
  {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: geminiModelsFromSettings(geminiSettings.customModels),
      accountUsage: GEMINI_ACCOUNT_USAGE,
      probe: {
        installed: true,
        version: null,
        status: 'error',
        auth: { status: 'unknown' },
        message: 'Gemini CLI is installed but timed out while running `gemini --version`.',
      },
    })
  }

  const versionOutput = versionResult.success.value
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`)
  if (versionOutput.code !== 0)
  {
    yield* Effect.logWarning('Gemini CLI version probe exited with a non-zero status.', {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    })
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: geminiModelsFromSettings(geminiSettings.customModels),
      accountUsage: GEMINI_ACCOUNT_USAGE,
      probe: {
        installed: true,
        version,
        status: 'error',
        auth: { status: 'unknown' },
        message: 'Gemini CLI is installed but failed to run.',
      },
    })
  }

  return buildServerProvider({
    presentation: GEMINI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: geminiModelsFromSettings(geminiSettings.customModels),
    accountUsage: GEMINI_ACCOUNT_USAGE,
    probe: {
      installed: true,
      version,
      status: 'ready',
      auth: { status: 'unknown' },
    },
  })
})

export const enrichGeminiSnapshot = (input: {
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
      Effect.logWarning('Gemini version advisory enrichment failed.', {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  )
