// tests/apps/server/provider/Drivers/OpenCodeDriver.test.ts
// verifies OpenCode workspace skill loading routes through the owned SDK server

import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { makeOpenCodeWorkspaceSkillsLoader } from '../../../../../apps/server/src/provider/Drivers/OpenCodeDriver.ts'
import type {
  OpenCodeRuntimeShape,
  OpenCodeServerConnection,
  OpenCodeServerProcess,
} from '../../../../../apps/server/src/provider/opencodeRuntime.ts'

type WorkspaceSkillsLoaderInput = Parameters<typeof makeOpenCodeWorkspaceSkillsLoader>[0]
type SdkClient = ReturnType<OpenCodeRuntimeShape['createOpenCodeSdkClient']>

const makeServerConnection = (input: {
  readonly url: string
  readonly serverPassword?: string
  readonly external: boolean
}): OpenCodeServerConnection => ({
  ...input,
  version: '1.15.13',
  exitCode: null,
})

const makeServerProcess = (input: {
  readonly url: string
  readonly serverPassword?: string
}): OpenCodeServerProcess => ({
  ...input,
  version: '1.15.13',
  isRunning: Effect.succeed(true),
  exitCode: Effect.never,
})

it.effect('reuses the instance server owner for local workspace skills', () =>
{
  const clientInputs: Array<Parameters<OpenCodeRuntimeShape['createOpenCodeSdkClient']>[0]> = []
  let ownerBorrows = 0
  const runtime: WorkspaceSkillsLoaderInput['runtime'] = {
    connectToOpenCodeServer: () => Effect.die('local workspaces must not connect a second server'),
    createOpenCodeSdkClient: (input) =>
    {
      clientInputs.push(input)
      return {} as SdkClient
    },
    loadOpenCodeSkills: () =>
      Effect.succeed([
        { name: 'large-catalog', location: '/workspace/.opencode/skills/large/SKILL.md' },
      ]),
  }
  const serverOwner: WorkspaceSkillsLoaderInput['serverOwner'] = {
    withServer: (use) =>
    {
      ownerBorrows += 1
      return use(
        makeServerProcess({
          url: 'http://127.0.0.1:4301',
          serverPassword: 'owned-password',
        }),
      )
    },
  }
  const loadSkills = makeOpenCodeWorkspaceSkillsLoader({
    settings: { binaryPath: 'opencode', serverUrl: '', serverPassword: '' },
    environment: { T3_SELECTED_INSTANCE: 'local' },
    runtime,
    serverOwner,
  })

  return Effect.gen(function* ()
  {
    const skills = yield* loadSkills('/workspace/local')

    expect(ownerBorrows).toBe(1)
    expect(clientInputs).toEqual([
      {
        baseUrl: 'http://127.0.0.1:4301',
        directory: '/workspace/local',
        serverPassword: 'owned-password',
      },
    ])
    expect(skills.map((skill) => skill.name)).toEqual(['large-catalog'])
  })
})

it.effect('connects directly for configured external workspace skills', () =>
{
  const connections: Array<Parameters<OpenCodeRuntimeShape['connectToOpenCodeServer']>[0]> = []
  const clientInputs: Array<Parameters<OpenCodeRuntimeShape['createOpenCodeSdkClient']>[0]> = []
  let ownerBorrows = 0
  const runtime: WorkspaceSkillsLoaderInput['runtime'] = {
    connectToOpenCodeServer: (input) =>
      Effect.sync(() =>
      {
        connections.push(input)
        return makeServerConnection({
          url: input.serverUrl ?? 'https://opencode.example',
          ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
          external: true,
        })
      }),
    createOpenCodeSdkClient: (input) =>
    {
      clientInputs.push(input)
      return {} as SdkClient
    },
    loadOpenCodeSkills: () => Effect.succeed([]),
  }
  const serverOwner: WorkspaceSkillsLoaderInput['serverOwner'] = {
    withServer: (use) =>
    {
      ownerBorrows += 1
      return use(makeServerProcess({ url: 'http://127.0.0.1:4301' }))
    },
  }
  const environment = { PATH: '/selected/bin', T3_SELECTED_INSTANCE: 'external' }
  const loadSkills = makeOpenCodeWorkspaceSkillsLoader({
    settings: {
      binaryPath: '/selected/bin/opencode',
      serverUrl: 'https://opencode.example',
      serverPassword: 'external-password',
    },
    environment,
    runtime,
    serverOwner,
  })

  return Effect.gen(function* ()
  {
    yield* loadSkills('/workspace/external')

    expect(ownerBorrows).toBe(0)
    expect(connections).toEqual([
      {
        binaryPath: '/selected/bin/opencode',
        directory: '/workspace/external',
        serverUrl: 'https://opencode.example',
        serverPassword: 'external-password',
        environment,
      },
    ])
    expect(clientInputs).toEqual([
      {
        baseUrl: 'https://opencode.example',
        directory: '/workspace/external',
        serverPassword: 'external-password',
      },
    ])
  })
})
