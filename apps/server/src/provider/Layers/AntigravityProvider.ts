// apps/server/src/provider/Layers/AntigravityProvider.ts
// probe antigravity availability and degrade discovery independently

import type {
  AntigravitySettings,
  ModelCapabilities,
  ServerProviderModel,
} from '@t3tools/contracts'
import { createModelCapabilities } from '@t3tools/shared/model'
import { resolveSpawnCommand } from '@t3tools/shared/shell'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_MINIMUM_VERSION,
  isAntigravityVersionSupported,
  parseAntigravityDiscoveryOutput,
} from '../antigravity/AntigravityCli.ts'
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
  spawnAndCollect,
} from '../providerSnapshot.ts'
import { ANTIGRAVITY_PROVIDER_CAPABILITIES } from '../providerCapabilities.ts'

const PRESENTATION = {
  displayName: 'Antigravity',
  capabilities: ANTIGRAVITY_PROVIDER_CAPABILITIES,
  badgeLabel: 'Experimental',
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] })
export const DEFAULT_ANTIGRAVITY_MODEL = ANTIGRAVITY_DEFAULT_MODEL

function parseAntigravityVersion(output: string): string | null
{
  // preserve prerelease identifiers so the minimum-version gate can reject
  // 1.1.15-beta instead of treating it as the stable 1.1.15 release.
  const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/)
  return match?.[1] ?? null
}

function opaqueModels(
  models: ReadonlyArray<string>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel>
{
  const discovered = new Set(models.map((model) => model.trim()).filter(Boolean))
  const ordered = [DEFAULT_ANTIGRAVITY_MODEL, ...discovered]
  for (const model of customModels.map((candidate) => candidate.trim()).filter(Boolean))
  {
    if (!ordered.includes(model)) ordered.push(model)
  }
  return ordered.map((model) => ({
    slug: model,
    name: model === DEFAULT_ANTIGRAVITY_MODEL ? 'Antigravity default' : model,
    isCustom: model !== DEFAULT_ANTIGRAVITY_MODEL && !discovered.has(model),
    capabilities: EMPTY_CAPABILITIES,
  }))
}

function fallbackModels(settings: AntigravitySettings): ReadonlyArray<ServerProviderModel>
{
  return opaqueModels([], settings.customModels)
}

const run = (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv,
  args: ReadonlyArray<string>,
) =>
  Effect.gen(function* ()
  {
    const command = settings.binaryPath || 'agy'
    const resolved = yield* resolveSpawnCommand(command, args, { env: environment })
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
        stdin: 'ignore',
      }),
    )
  })

export const buildInitialAntigravityProviderSnapshot = Effect.fn(
  'buildInitialAntigravityProviderSnapshot',
)(function* (settings: AntigravitySettings): Effect.fn.Return<ServerProviderDraft>
{
  const checkedAt = DateTime.formatIso(yield* DateTime.now)
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: fallbackModels(settings),
    probe: {
      installed: settings.enabled,
      version: null,
      status: settings.enabled ? 'warning' : 'warning',
      auth: { status: 'unknown' },
      message: settings.enabled
        ? 'Checking Antigravity CLI availability...'
        : 'Antigravity is disabled in 456code settings.',
    },
  })
})

export const checkAntigravityProviderStatus = Effect.fn('checkAntigravityProviderStatus')(
  function* (
    settings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner>
  {
    const checkedAt = DateTime.formatIso(yield* DateTime.now)
    if (!settings.enabled) return yield* buildInitialAntigravityProviderSnapshot(settings)

    const versionProbe = yield* run(settings, environment, ['--version']).pipe(
      Effect.timeoutOption('4 seconds'),
      Effect.result,
    )
    if (Result.isFailure(versionProbe))
    {
      const error = versionProbe.failure
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels(settings),
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: 'error',
          auth: { status: 'unknown' },
          message: isCommandMissingCause(error)
            ? 'Antigravity CLI (`agy`) is not installed or not on PATH.'
            : 'Failed to execute the Antigravity CLI version probe.',
        },
      })
    }
    if (Option.isNone(versionProbe.success))
    {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels(settings),
        probe: {
          installed: true,
          version: null,
          status: 'error',
          auth: { status: 'unknown' },
          message: 'Antigravity CLI timed out while reporting its version.',
        },
      })
    }

    const versionResult = Option.getOrThrow(versionProbe.success)
    const version = parseAntigravityVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
    if (versionResult.code !== 0 || !isAntigravityVersionSupported(version))
    {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels(settings),
        probe: {
          installed: true,
          version,
          status: 'error',
          auth: { status: 'unknown' },
          message: `Antigravity CLI ${version ?? 'without a version'} is too old; ${ANTIGRAVITY_MINIMUM_VERSION} or newer is required.`,
        },
      })
    }

    const helpProbe = yield* run(settings, environment, ['--help']).pipe(
      Effect.timeoutOption('4 seconds'),
      Effect.result,
    )
    if (
      Result.isFailure(helpProbe) ||
      Option.isNone(helpProbe.success) ||
      Option.getOrThrow(helpProbe.success).code !== 0 ||
      !['--input-format', '--output-format'].every((flag) =>
        `${Option.getOrThrow(helpProbe.success).stdout}\n${Option.getOrThrow(helpProbe.success).stderr}`.includes(
          flag,
        ),
      )
    )
    {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels(settings),
        probe: {
          installed: true,
          version,
          status: 'error',
          auth: { status: 'unknown' },
          message: 'Antigravity CLI does not expose the required stream-json flags.',
        },
      })
    }

    const modelProbe = yield* run(settings, environment, [
      '--output-format',
      'json',
      'models',
    ]).pipe(Effect.timeoutOption('4 seconds'), Effect.result)
    const agentProbe = yield* run(settings, environment, [
      '--output-format',
      'json',
      'agents',
    ]).pipe(Effect.timeoutOption('4 seconds'), Effect.result)
    const models =
      Result.isSuccess(modelProbe) &&
      Option.isSome(modelProbe.success) &&
      modelProbe.success.value.code === 0
        ? parseAntigravityDiscoveryOutput(modelProbe.success.value.stdout, 'models')
        : undefined
    const agents =
      Result.isSuccess(agentProbe) &&
      Option.isSome(agentProbe.success) &&
      agentProbe.success.value.code === 0
        ? parseAntigravityDiscoveryOutput(agentProbe.success.value.stdout, 'agents')
        : undefined
    const configuredAgent = settings.agent.trim()
    const invalidConfiguredAgent =
      configuredAgent.length > 0 && agents !== undefined && !agents.includes(configuredAgent)
    const discoveryWarning =
      models === undefined || agents === undefined
        ? 'Antigravity model or agent discovery was unavailable; using degraded provider metadata.'
        : undefined
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models:
        models === undefined
          ? fallbackModels(settings)
          : opaqueModels(models, settings.customModels),
      probe: {
        installed: true,
        version,
        status: invalidConfiguredAgent ? 'error' : discoveryWarning ? 'warning' : 'ready',
        auth: { status: 'unknown' },
        ...(invalidConfiguredAgent
          ? { message: `Configured Antigravity agent '${configuredAgent}' is unavailable.` }
          : discoveryWarning
            ? { message: discoveryWarning }
            : {}),
      },
    })
  },
)

// return an inventory only after a successful exact discovery command.
export const discoverAntigravityAgents = Effect.fn('discoverAntigravityAgents')(function* (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ReadonlyArray<string> | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner
>
{
  const result = yield* run(settings, environment, ['--output-format', 'json', 'agents']).pipe(
    Effect.timeoutOption('4 seconds'),
    Effect.result,
  )
  if (
    Result.isFailure(result) ||
    Option.isNone(result.success) ||
    result.success.value.code !== 0
  )
  {
    return undefined
  }
  return parseAntigravityDiscoveryOutput(result.success.value.stdout, 'agents')
})

export function validateAntigravityAgent(
  requestedAgent: string | undefined,
  discoveredAgents: ReadonlyArray<string> | undefined,
): string | undefined
{
  if (!requestedAgent || !discoveredAgents) return requestedAgent
  return discoveredAgents.includes(requestedAgent) ? requestedAgent : undefined
}
