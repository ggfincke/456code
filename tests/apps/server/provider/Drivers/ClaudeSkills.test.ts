// tests/apps/server/provider/Drivers/ClaudeSkills.test.ts
// verify claude skills behavior

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { discoverClaudeSkills } from '../../../../../apps/server/src/provider/Drivers/ClaudeSkills.ts'

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
)
{
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const skillDir = path.join(skillsDir, directoryName)
  yield* fs.makeDirectory(skillDir, { recursive: true })
  yield* fs.writeFileString(path.join(skillDir, 'SKILL.md'), contents)
})

it.layer(NodeServices.layer)('discoverClaudeSkills', (it) =>
{
  it.effect('discovers only Claude-native user and project skills', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-skills-' })
      const configDir = path.join(tempDir, 'claude-home')
      const workspace = path.join(tempDir, 'workspace')

      yield* writeSkill(
        path.join(configDir, 'skills'),
        'codex-review',
        [
          '---',
          'name: codex-review',
          'description: Ask Codex for a review.',
          '---',
          '',
          '# Body',
        ].join('\n'),
      )
      yield* writeSkill(
        path.join(workspace, '.agents', 'skills'),
        'review',
        ['---', 'name: review', 'description: Review the changes.', '---'].join('\n'),
      )
      yield* writeSkill(
        path.join(workspace, '.claude', 'skills'),
        'deploy',
        ['---', 'name: deploy', 'description: Deploy the app.', '---', '', '# Deploy'].join('\n'),
      )

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace)

      assert.deepEqual(skills, [
        {
          name: 'codex-review',
          path: path.join(configDir, 'skills', 'codex-review', 'SKILL.md'),
          enabled: true,
          scope: 'user',
          description: 'Ask Codex for a review.',
        },
        {
          name: 'deploy',
          path: path.join(workspace, '.claude', 'skills', 'deploy', 'SKILL.md'),
          enabled: true,
          scope: 'project',
          description: 'Deploy the app.',
        },
      ])
    }),
  )

  it.effect('keeps the user skill when lower-priority roots reuse its name', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-skills-' })
      const configDir = path.join(tempDir, 'claude-home')
      const workspace = path.join(tempDir, 'workspace')

      yield* writeSkill(
        path.join(configDir, 'skills'),
        'deploy',
        ['---', 'name: deploy', 'description: User deploy.', '---'].join('\n'),
      )
      yield* writeSkill(
        path.join(configDir, 'skills'),
        'review',
        ['---', 'name: review', 'description: User review.', '---'].join('\n'),
      )
      yield* writeSkill(
        path.join(workspace, '.agents', 'skills'),
        'deploy',
        ['---', 'name: deploy', 'description: Agents deploy.', '---'].join('\n'),
      )
      yield* writeSkill(
        path.join(workspace, '.agents', 'skills'),
        'review',
        ['---', 'name: review', 'description: Agents review.', '---'].join('\n'),
      )
      yield* writeSkill(
        path.join(workspace, '.claude', 'skills'),
        'review',
        ['---', 'name: review', 'description: Claude review.', '---'].join('\n'),
      )

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace)

      assert.deepEqual(
        skills.map(({ name, description }) => ({ name, description })),
        [
          { name: 'deploy', description: 'User deploy.' },
          { name: 'review', description: 'User review.' },
        ],
      )
    }),
  )

  it.effect('uses the directory name and skips malformed frontmatter', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-skills-' })
      const configDir = path.join(tempDir, 'claude-home')
      const skillsDir = path.join(configDir, 'skills')

      yield* writeSkill(skillsDir, 'no-frontmatter', '# Just a heading\n')
      yield* writeSkill(
        skillsDir,
        'directory-name',
        ['---', 'name: ignored-frontmatter-name', 'description: Directory wins.', '---'].join('\n'),
      )
      yield* writeSkill(skillsDir, 'broken-yaml', '---\nname: [unclosed\n---\n')
      // a stray file (not a directory with SKILL.md) must be skipped.
      yield* fs.makeDirectory(skillsDir, { recursive: true })
      yield* fs.writeFileString(path.join(skillsDir, 'README.md'), 'not a skill')

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined)

      // a skill with no frontmatter falls back to its directory name; a skill
      // whose frontmatter fails to parse is skipped entirely (Claude Code
      // won't load it either).
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ['directory-name', 'no-frontmatter'],
      )
      assert.equal(skills[0]?.description, 'Directory wins.')
      assert.equal(skills[1]?.description, undefined)
    }),
  )

  it.effect('honors CLAUDE_CONFIG_DIR from the environment when homePath is unset', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-skills-' })
      const environmentConfigDir = path.join(tempDir, 'env-config')

      yield* writeSkill(
        path.join(environmentConfigDir, 'skills'),
        'env-skill',
        ['---', 'name: env-skill', 'description: From env config dir.', '---'].join('\n'),
      )

      const skills = yield* discoverClaudeSkills({ homePath: '' }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      })

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ['env-skill'],
      )

      // an explicit homePath wins over the environment variable, matching
      // makeClaudeEnvironment which overwrites CLAUDE_CONFIG_DIR for the CLI.
      const explicitHome = path.join(tempDir, 'explicit-home')
      yield* writeSkill(
        path.join(explicitHome, 'skills'),
        'explicit-skill',
        ['---', 'name: explicit-skill', '---'].join('\n'),
      )
      const explicitSkills = yield* discoverClaudeSkills({ homePath: explicitHome }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      })
      assert.deepEqual(
        explicitSkills.map((skill) => skill.name),
        ['explicit-skill'],
      )
    }),
  )

  it.effect('resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-skills-' })
      const workspace = path.join(tempDir, 'workspace')
      yield* fs.makeDirectory(workspace, { recursive: true })

      // the spawned CLI resolves a relative CLAUDE_CONFIG_DIR against its own
      // cwd (the workspace), so discovery must do the same.
      yield* writeSkill(
        path.join(workspace, 'relative-config', 'skills'),
        'relative-skill',
        ['---', 'name: relative-skill', '---'].join('\n'),
      )

      const skills = yield* discoverClaudeSkills({ homePath: '' }, workspace, {
        CLAUDE_CONFIG_DIR: 'relative-config',
      })

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ['relative-skill'],
      )
      assert.equal(skills[0]?.scope, 'user')
    }),
  )

  it.effect('applies invocation metadata and whole-file skill override validation', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-skills-' })
      const configDir = path.join(tempDir, 'claude-home')
      const skillsDir = path.join(configDir, 'skills')

      yield* writeSkill(
        skillsDir,
        'manual-only',
        ['---', 'disable-model-invocation: yes', 'user-invocable: no', '---', '# Body'].join('\n'),
      )
      yield* writeSkill(skillsDir, 'sibling-off', '# Body\n')
      yield* fs.writeFileString(
        path.join(configDir, 'settings.json'),
        '{ "skillOverrides": { "manual-only": "future-mode", "sibling-off": "off" } }',
      )

      const skills = yield* discoverClaudeSkills({ homePath: configDir })

      assert.deepEqual(
        skills.map(({ name, enabled, userInvocationOnly, userInvocable }) => ({
          name,
          enabled,
          userInvocationOnly,
          userInvocable,
        })),
        [
          {
            name: 'manual-only',
            enabled: true,
            userInvocationOnly: true,
            userInvocable: false,
          },
          {
            name: 'sibling-off',
            enabled: true,
            userInvocationOnly: undefined,
            userInvocable: undefined,
          },
        ],
      )
    }),
  )

  it.effect('lets repository-local settings override nested workspace settings', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-skills-' })
      const configDir = path.join(tempDir, 'claude-home')
      const repository = path.join(tempDir, 'repository')
      const workspace = path.join(repository, 'packages', 'app')

      yield* fs.makeDirectory(path.join(repository, '.git'), { recursive: true })
      yield* writeSkill(path.join(configDir, 'skills'), 'deploy', '# Body\n')
      yield* fs.makeDirectory(path.join(workspace, '.claude'), { recursive: true })
      yield* fs.writeFileString(
        path.join(workspace, '.claude', 'settings.local.json'),
        '{ "skillOverrides": { "deploy": "on" } }',
      )
      yield* fs.makeDirectory(path.join(repository, '.claude'), { recursive: true })
      yield* fs.writeFileString(
        path.join(repository, '.claude', 'settings.local.json'),
        '{ "skillOverrides": { "deploy": "off" } }',
      )

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace)

      assert.equal(skills[0]?.name, 'deploy')
      assert.equal(skills[0]?.enabled, false)
    }),
  )

  it.effect('returns an empty list when no skill roots exist', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-claude-skills-' })

      const skills = yield* discoverClaudeSkills(
        { homePath: path.join(tempDir, 'missing-home') },
        path.join(tempDir, 'missing-workspace'),
      )

      assert.deepEqual(skills, [])
    }),
  )
})
