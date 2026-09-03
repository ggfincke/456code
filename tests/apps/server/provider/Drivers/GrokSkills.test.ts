// tests/apps/server/provider/Drivers/GrokSkills.test.ts
// verifies Grok workspace skill decoding and probe ownership

import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { ChildProcessSpawner } from 'effect/unstable/process'

import {
  discoverGrokSkills,
  parseGrokInspectSkills,
} from '../../../../../apps/server/src/provider/Drivers/GrokSkills.ts'

const inspectPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills })

describe('parseGrokInspectSkills', () =>
{
  it('maps inspect entries onto provider skills, sorted by name', () =>
  {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: 'writing-docs',
          description: 'Write user docs.',
          source: { type: 'user', path: '/home/dev/.grok/skills/writing-docs/SKILL.md' },
          userInvocable: true,
        },
        {
          name: 'deploy',
          description: 'Deploy the app.',
          source: {
            type: 'plugin',
            path: '/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md',
          },
          userInvocable: true,
        },
      ]),
    )

    expect(skills).toEqual([
      {
        name: 'deploy',
        description: 'Deploy the app.',
        path: '/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md',
        scope: 'plugin',
        enabled: true,
      },
      {
        name: 'writing-docs',
        description: 'Write user docs.',
        path: '/home/dev/.grok/skills/writing-docs/SKILL.md',
        scope: 'user',
        enabled: true,
      },
    ])
  })

  it('preserves non-user-invocable skills without offering them', () =>
  {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: 'internal-helper',
          source: { type: 'bundled', path: '/opt/grok/bundled/skills/internal-helper/SKILL.md' },
          userInvocable: false,
        },
      ]),
    )

    expect(skills).toEqual([
      {
        name: 'internal-helper',
        path: '/opt/grok/bundled/skills/internal-helper/SKILL.md',
        scope: 'bundled',
        enabled: false,
      },
    ])
  })

  it.effect('spawns in the configured cwd and rejects a failed probe', () =>
  {
    const spawnCwds: Array<string | undefined> = []
    const selectedEnvironmentValues: Array<string | undefined> = []
    let exitCode = 0
    const spawner = ChildProcessSpawner.make((command) =>
    {
      if (command._tag === 'StandardCommand')
      {
        spawnCwds.push(command.options.cwd)
        selectedEnvironmentValues.push(command.options.env?.T3_SELECTED_INSTANCE)
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(
            Stream.make(
              inspectPayload([
                {
                  name: 'kept',
                  source: {
                    type: 'project',
                    path: '/workspaces/demo/.grok/skills/kept/SKILL.md',
                  },
                },
              ]),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      )
    })
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)

    return Effect.gen(function* ()
    {
      const skills = yield* discoverGrokSkills(
        { binaryPath: 'grok' },
        { PATH: process.env.PATH, T3_SELECTED_INSTANCE: 'selected' },
        '/workspaces/demo',
      ).pipe(Effect.provide(spawnerLayer))

      expect(spawnCwds).toEqual(['/workspaces/demo'])
      expect(selectedEnvironmentValues).toEqual(['selected'])
      expect(skills.map((skill) => skill.name)).toEqual(['kept'])

      exitCode = 1
      const failed = yield* discoverGrokSkills({ binaryPath: 'grok' }).pipe(
        Effect.result,
        Effect.provide(spawnerLayer),
      )
      expect(failed._tag).toBe('Failure')
    })
  })
})
