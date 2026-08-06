// apps/server/src/workers/WorkersReadiness.ts
// checks worker-broker disk and inherited provider configuration readiness

import type { WorkersReadinessResult } from '@t3tools/contracts'
import { HostProcessEnvironment } from '@t3tools/shared/hostProcess'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'

import { ServerSettingsService } from '../serverSettings.ts'

const BROKER_NAME_PATTERN = /^worker[-_ ]?broker$/i
const CODEX_BROKER_SECTION_PATTERN = /^\s*\[mcp_servers\.(["']?)([^\]"']+)\1\]\s*$/gm

function hasClaudeBrokerConfig(value: unknown): boolean
{
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const servers = (value as { readonly mcpServers?: unknown }).mcpServers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return false
  return Object.keys(servers).some((name) => BROKER_NAME_PATTERN.test(name.trim()))
}

function parseJson(text: string): Option.Option<unknown>
{
  try
  {
    return Option.some(JSON.parse(text) as unknown)
  }
  catch
  {
    return Option.none()
  }
}

function hasCodexBrokerConfig(value: string): boolean
{
  for (const match of value.matchAll(CODEX_BROKER_SECTION_PATTERN))
  {
    const name = match[2]
    if (name !== undefined && BROKER_NAME_PATTERN.test(name.trim())) return true
  }
  return false
}

function configHomePath(value: unknown): string | undefined
{
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const homePath = (value as { readonly homePath?: unknown }).homePath
  if (typeof homePath !== 'string') return undefined
  const trimmed = homePath.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function resolveConfigDirectory(path: Path.Path, directory: string, home?: string): string
{
  const expanded =
    home && directory === '~'
      ? home
      : home && directory.startsWith('~/')
        ? path.join(home, directory.slice(2))
        : directory
  return path.resolve(expanded)
}

export const readWorkersReadiness = Effect.fn('WorkersReadiness.read')(function* (
  stateDir: string,
)
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const environment = yield* HostProcessEnvironment
  const stateDirExists = yield* fileSystem
    .exists(stateDir)
    .pipe(Effect.orElseSucceed(() => false as boolean))
  const home = environment.HOME?.trim()
  const settingsService = yield* Effect.serviceOption(ServerSettingsService)
  const settings = Option.isSome(settingsService)
    ? yield* settingsService.value.getSettings.pipe(Effect.option)
    : Option.none()
  const configuredClaudeHomes = Option.isSome(settings)
    ? [
        settings.value.providers.claudeAgent.homePath.trim(),
        ...Object.values(settings.value.providerInstances).flatMap((instance) =>
          instance.driver === 'claudeAgent'
            ? [
                configHomePath(instance.config) ?? '',
                ...(instance.environment ?? [])
                  .filter((entry) => entry.name === 'CLAUDE_CONFIG_DIR')
                  .map((entry) => entry.value.trim()),
              ]
            : [],
        ),
      ].filter((value) => value.length > 0)
    : []
  const claudeConfigPaths = Array.from(
    new Set(
      [environment.CLAUDE_CONFIG_DIR?.trim(), ...configuredClaudeHomes, home]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .map((directory) =>
          path.join(resolveConfigDirectory(path, directory, home), '.claude.json'),
        ),
    ),
  )
  const codexHome = environment.CODEX_HOME?.trim() || (home ? path.join(home, '.codex') : null)
  const codexConfigPath = codexHome ? path.join(codexHome, 'config.toml') : null

  if (claudeConfigPaths.length === 0 && codexConfigPath === null)
  {
    return {
      stateDir,
      stateDirExists,
      brokerConfigured: false,
      brokerConfigSource: Option.none(),
      message: Option.some('The provider configuration directories could not be resolved.'),
    }
  }

  const claudeConfigs = yield* Effect.forEach(
    claudeConfigPaths,
    (configPath) =>
      fileSystem.readFileString(configPath).pipe(
        Effect.result,
        Effect.map((result) => ({ configPath, result })),
      ),
    { concurrency: 'unbounded' },
  )
  for (const config of claudeConfigs)
  {
    if (Result.isFailure(config.result)) continue
    const parsed = parseJson(config.result.success)
    if (Option.isSome(parsed) && hasClaudeBrokerConfig(parsed.value))
    {
      return {
        stateDir,
        stateDirExists,
        brokerConfigured: true,
        brokerConfigSource: Option.some(config.configPath),
        message: Option.none(),
      }
    }
  }

  const codexConfig =
    codexConfigPath === null
      ? null
      : yield* fileSystem.readFileString(codexConfigPath).pipe(Effect.result)
  if (
    codexConfigPath !== null &&
    codexConfig !== null &&
    Result.isSuccess(codexConfig) &&
    hasCodexBrokerConfig(codexConfig.success)
  )
  {
    return {
      stateDir,
      stateDirExists,
      brokerConfigured: true,
      brokerConfigSource: Option.some(codexConfigPath),
      message: Option.none(),
    }
  }

  return {
    stateDir,
    stateDirExists,
    brokerConfigured: false,
    brokerConfigSource: Option.none(),
    message: Option.some(
      `No worker-broker MCP server was found in ${[
        ...claudeConfigPaths,
        ...(codexConfigPath === null ? [] : [codexConfigPath]),
      ]
        .map((configPath) => `'${configPath}'`)
        .join(' or ')}.`,
    ),
  }
})
