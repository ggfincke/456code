// apps/server/src/provider/Drivers/ClaudeHome.ts
// resolves Claude runtime homes and source-bound continuation identities
import * as NodeOS from 'node:os'

import { ProviderDriverKind, type ClaudeSettings } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { expandHomePath } from '../../pathExpansion.ts'
import {
  canonicalFileContinuationIdentity,
  resolveClaudeProjectsRoot,
} from '../continuationIdentity.ts'

export const resolveClaudeHomePath = Effect.fn('resolveClaudeHomePath')(function* (
  config: Pick<ClaudeSettings, 'homePath'>,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path>
{
  const path = yield* Path.Path
  const homePath = config.homePath.trim()
  const configuredPath = homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir()
  return cwd === undefined ? path.resolve(configuredPath) : path.resolve(cwd, configuredPath)
})

export const makeClaudeEnvironment = Effect.fn('makeClaudeEnvironment')(function* (
  config: Pick<ClaudeSettings, 'homePath'>,
  baseEnv?: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path>
{
  const resolvedBaseEnv = baseEnv ?? process.env
  const homePath = config.homePath.trim()
  if (homePath.length === 0)
  {
    const configuredEnvironmentPath = resolvedBaseEnv.CLAUDE_CONFIG_DIR?.trim() ?? ''
    if (configuredEnvironmentPath.length > 0)
    {
      return {
        ...resolvedBaseEnv,
        CLAUDE_CONFIG_DIR:
          cwd === undefined
            ? (yield* Path.Path).resolve(configuredEnvironmentPath)
            : (yield* Path.Path).resolve(cwd, configuredEnvironmentPath),
      }
    }
    const configuredHomePath = resolvedBaseEnv.HOME?.trim() ?? ''
    const path = yield* Path.Path
    if (configuredHomePath.length === 0 || path.isAbsolute(configuredHomePath))
    {
      return resolvedBaseEnv
    }
    return {
      ...resolvedBaseEnv,
      HOME:
        cwd === undefined
          ? path.resolve(configuredHomePath)
          : path.resolve(cwd, configuredHomePath),
    }
  }
  const resolvedHomePath = yield* resolveClaudeHomePath(config, cwd)
  return {
    ...resolvedBaseEnv,
    // isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  }
})

export const makeClaudeContinuationGroupKey = Effect.fn('makeClaudeContinuationGroupKey')(
  function* (
    config: Pick<ClaudeSettings, 'homePath'>,
    environment?: NodeJS.ProcessEnv,
    cwd?: string,
  ): Effect.fn.Return<string, never, FileSystem.FileSystem>
  {
    const identity = yield* canonicalFileContinuationIdentity(
      ProviderDriverKind.make('claudeAgent'),
      resolveClaudeProjectsRoot(config, {
        ...(environment === undefined ? {} : { environment }),
        ...(cwd === undefined ? {} : { cwd }),
      }),
    )
    return identity.continuationKey
  },
)

export const makeClaudeCapabilitiesCacheKey = Effect.fn('makeClaudeCapabilitiesCacheKey')(
  function* (
    config: Pick<ClaudeSettings, 'binaryPath' | 'homePath'>,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path>
  {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, cwd)
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ''}`
  },
)
