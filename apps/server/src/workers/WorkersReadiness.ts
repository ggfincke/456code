// apps/server/src/workers/WorkersReadiness.ts
// checks worker-broker disk and inherited provider configuration readiness

import type { WorkersReadinessResult } from '@t3tools/contracts'
import { HostProcessEnvironment } from '@t3tools/shared/hostProcess'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Result from 'effect/Result'

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

  if (!home)
  {
    return {
      stateDir,
      stateDirExists,
      brokerConfigured: false,
      brokerConfigSource: Option.none(),
      message: Option.some('The provider home directory could not be resolved from HOME.'),
    }
  }

  const claudeConfigPath = path.join(home, '.claude.json')
  const codexHome = environment.CODEX_HOME?.trim() || path.join(home, '.codex')
  const codexConfigPath = path.join(codexHome, 'config.toml')
  const configs = yield* Effect.all(
    {
      claude: fileSystem.readFileString(claudeConfigPath).pipe(Effect.result),
      codex: fileSystem.readFileString(codexConfigPath).pipe(Effect.result),
    },
    { concurrency: 2 },
  )

  if (Result.isSuccess(configs.claude))
  {
    const parsed = parseJson(configs.claude.success)
    if (Option.isSome(parsed) && hasClaudeBrokerConfig(parsed.value))
    {
      return {
        stateDir,
        stateDirExists,
        brokerConfigured: true,
        brokerConfigSource: Option.some(claudeConfigPath),
        message: Option.none(),
      }
    }
  }

  if (Result.isSuccess(configs.codex) && hasCodexBrokerConfig(configs.codex.success))
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
      `No worker-broker MCP server was found in '${claudeConfigPath}' or '${codexConfigPath}'.`,
    ),
  }
})
