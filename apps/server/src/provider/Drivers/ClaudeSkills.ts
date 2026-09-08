// apps/server/src/provider/Drivers/ClaudeSkills.ts
// discovers Claude skills from the same config boundary as its runtime

// claude Code loads skills from `<config dir>/skills` (user scope) and
// `<cwd>/.claude/skills` (project scope). The user root wins on name
// collisions. `.agents/skills` is a Codex location: the native Claude CLI
// reports a skill found only there as an unknown command, so it is not
// slash-discoverable and must not be offered for guaranteed dispatch.
//
// @module provider/Drivers/ClaudeSkills
import * as NodeOS from 'node:os'

import type { ClaudeSettings, ServerProviderSkill } from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import { fromLenientJson } from '@t3tools/shared/schemaJson'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { parse as parseYamlDocument } from 'yaml'

import { expandHomePath } from '../../pathExpansion.ts'

type ClaudeSkillScope = 'user' | 'project'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

type SkillFrontmatter =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | {
      readonly kind: 'parsed'
      readonly description?: string
      readonly userInvocationOnly?: boolean
      readonly userInvocable?: boolean
    }

// claude accepts YAML 1.1 boolean spellings even though the parser's YAML
// 1.2 core schema leaves some of them as strings or numbers.
function parseFrontmatterBoolean(value: unknown): boolean | undefined
{
  if (typeof value === 'boolean') return value
  if (typeof value === 'number')
  {
    return value === 1 ? true : value === 0 ? false : undefined
  }
  if (typeof value !== 'string') return undefined
  switch (value.trim().toLowerCase())
  {
    case 'true':
    case 'yes':
    case 'on':
    case 'y':
      return true
    case 'false':
    case 'no':
    case 'off':
    case 'n':
      return false
    default:
      return undefined
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter
{
  const match = FRONTMATTER_PATTERN.exec(contents)
  if (!match)
  {
    return { kind: 'missing' }
  }

  let parsed: unknown
  try
  {
    parsed = parseYamlDocument(match[1] ?? '')
  }
  catch
  {
    return { kind: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null)
  {
    return { kind: 'malformed' }
  }

  const record = parsed as Record<string, unknown>
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  return {
    kind: 'parsed',
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record['disable-model-invocation']) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record['user-invocable']) === false
      ? { userInvocable: false }
      : {}),
  }
}

// resolve the administrator policy file that outranks user and project settings.
export function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined
{
  if (platform === 'darwin')
  {
    return '/Library/Application Support/ClaudeCode/managed-settings.json'
  }
  if (platform === 'win32')
  {
    const programData = environment.PROGRAMDATA?.trim()
    return programData ? path.join(programData, 'ClaudeCode', 'managed-settings.json') : undefined
  }
  return '/etc/claude-code/managed-settings.json'
}

// list claude's skill override settings from lowest to highest precedence.
export function skillOverrideSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string>
{
  const managedPath = claudeManagedSettingsPath(path, platform, environment)
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined
  return [
    path.join(configDirPath, 'settings.json'),
    ...(cwd
      ? [
          path.join(cwd, '.claude', 'settings.json'),
          path.join(cwd, '.claude', 'settings.local.json'),
        ]
      : []),
    ...(root ? [path.join(root, '.claude', 'settings.local.json')] : []),
    ...(managedPath ? [managedPath] : []),
  ]
}

// find the nearest git boundary Claude uses for repository-local settings.
const findRepositoryRoot = Effect.fn('findRepositoryRoot')(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path>
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  let current = path.resolve(cwd)
  while (true)
  {
    const isRoot = yield* fileSystem
      .exists(path.join(current, '.git'))
      .pipe(Effect.orElseSucceed(() => false))
    if (isRoot) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
})

const SkillOverrideValue = Schema.Literals(['on', 'name-only', 'user-invocable-only', 'off'])
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
)
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings)

type SkillOverride = {
  readonly enabled: boolean
  readonly userInvocationOnly: boolean
}

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride
{
  switch (value)
  {
    case 'off':
      return { enabled: false, userInvocationOnly: false }
    case 'user-invocable-only':
      return { enabled: true, userInvocationOnly: true }
    case 'on':
    case 'name-only':
      return { enabled: true, userInvocationOnly: false }
  }
}

// merge only complete, valid override maps; malformed files are ignored like Claude.
const readSkillOverrides = Effect.fn('readSkillOverrides')(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyMap<string, SkillOverride>, never, FileSystem.FileSystem | Path.Path>
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const platform = yield* HostProcessPlatform
  const overridesByName = new Map<string, SkillOverride>()
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd)

  for (const settingsPath of skillOverrideSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  ))
  {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined))
    if (contents === undefined) continue

    const parsed = yield* decodeSkillOverrideSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug('claude settings file is unreadable; ignoring skillOverrides', {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    )
    if (!parsed?.skillOverrides) continue

    for (const [name, value] of Object.entries(parsed.skillOverrides))
    {
      overridesByName.set(name, parseSkillOverride(value))
    }
  }

  return overridesByName
})

// resolve the Claude config directory the CLI would use, matching the
// precedence the spawned CLI sees: the instance's `homePath` (exported as
// `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
// already present in the process environment, then `~/.claude`.
const resolveClaudeConfigDirPath = Effect.fn('resolveClaudeConfigDirPath')(function* (
  config: Pick<ClaudeSettings, 'homePath'>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path>
{
  const path = yield* Path.Path
  const homePath = config.homePath.trim()
  if (homePath.length > 0)
  {
    const expandedHomePath = expandHomePath(homePath)
    return cwd ? path.resolve(cwd, expandedHomePath) : path.resolve(expandedHomePath)
  }
  // no tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? ''
  if (environmentConfigDir.length > 0)
  {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir)
  }
  const environmentHome = environment.HOME?.trim() || NodeOS.homedir()
  const resolvedHome = cwd ? path.resolve(cwd, environmentHome) : path.resolve(environmentHome)
  return path.join(resolvedHome, '.claude')
})

// enumerate only native slash-discoverable skill roots. Discovery is
// best-effort, and the higher-precedence user root wins duplicate names.
export const discoverClaudeSkills = Effect.fn('discoverClaudeSkills')(function* (
  config: Pick<ClaudeSettings, 'homePath'>,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path>
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd)
  const skillOverrides = yield* readSkillOverrides(configDirPath, cwd, environment ?? process.env)

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: path.join(configDirPath, 'skills'), scope: 'user' },
    ...(cwd ? [{ directory: path.join(cwd, '.claude', 'skills'), scope: 'project' as const }] : []),
  ]

  const skillsByName = new Map<string, ServerProviderSkill>()
  for (const root of roots)
  {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

    for (const entry of [...entries].sort())
    {
      const skillPath = path.join(root.directory, entry, 'SKILL.md')
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined))
      if (contents === undefined)
      {
        continue
      }

      const frontmatter = parseSkillFrontmatter(contents)
      // malformed frontmatter means the skill won't load in Claude Code
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === 'malformed')
      {
        continue
      }

      // claude resolves the directory name, not a frontmatter `name` alias.
      const name = entry.trim()
      if (!name)
      {
        continue
      }

      if (skillsByName.has(name)) continue

      const override = skillOverrides.get(name)
      const userInvocationOnly =
        (frontmatter.kind === 'parsed' && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true
      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(frontmatter.kind === 'parsed' && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === 'parsed' && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {}),
      })
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name))
})
