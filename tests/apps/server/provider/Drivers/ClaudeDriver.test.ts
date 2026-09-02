// tests/apps/server/provider/Drivers/ClaudeDriver.test.ts
// verifies exact-workspace skill discovery without mutating the machine snapshot

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import { ProviderInstanceId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { HttpClient } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process'

import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { ServerSettingsService } from '../../../../../apps/server/src/serverSettings.ts'
import { ClaudeDriver } from '../../../../../apps/server/src/provider/Drivers/ClaudeDriver.ts'
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from '../../../../../apps/server/src/provider/Layers/ProviderEventLoggers.ts'

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: '456code-claude-driver-workspace-',
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die('Workspace discovery must not make an HTTP request')),
    ),
  ),
)

it.layer(testLayer)('ClaudeDriver workspace snapshots', (it) =>
{
  it.effect('isolates two project skill catalogs and leaves the machine snapshot unchanged', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: '456code-claude-workspaces-' })
      const home = path.join(temp, 'claude-home')
      const projects = [path.join(temp, 'project-a'), path.join(temp, 'project-b')]
      for (const [index, project] of projects.entries())
      {
        const directory = path.join(project, '.claude', 'skills', `project-${index}`)
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* fs.writeFileString(
          path.join(directory, 'SKILL.md'),
          `---\nname: project-${index}\ndescription: Project-specific skill.\n---\n`,
        )
      }
      const userDirectory = path.join(home, 'skills', 'shared')
      yield* fs.makeDirectory(userDirectory, { recursive: true })
      yield* fs.writeFileString(
        path.join(userDirectory, 'SKILL.md'),
        '---\nname: shared\ndescription: User skill.\n---\n',
      )
      const config = {
        ...ClaudeDriver.defaultConfig(),
        binaryPath: path.join(temp, 'missing-claude'),
        homePath: home,
      }
      const instance = yield* ClaudeDriver.create({
        instanceId: ProviderInstanceId.make('claude-workspace-test'),
        displayName: 'Claude workspace fixture',
        enabled: true,
        environment: [],
        config,
      })
      const before = yield* instance.snapshot.getSnapshot
      assert.isDefined(instance.snapshotForCwd)
      const first = yield* instance.snapshotForCwd!(projects[0]!)
      const second = yield* instance.snapshotForCwd!(projects[1]!)
      assert.deepEqual(first.skills.map((skill) => skill.name).sort(), ['project-0', 'shared'])
      assert.deepEqual(second.skills.map((skill) => skill.name).sort(), ['project-1', 'shared'])
      assert.strictEqual(first.instanceId, instance.instanceId)
      assert.deepEqual((yield* instance.snapshot.getSnapshot).skills, before.skills)

      const disabled = yield* ClaudeDriver.create({
        instanceId: ProviderInstanceId.make('claude-disabled-workspace-test'),
        displayName: undefined,
        enabled: false,
        environment: [],
        config,
      })
      assert.deepEqual(
        yield* disabled.snapshotForCwd!(projects[0]!),
        yield* disabled.snapshot.getSnapshot,
      )
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.never),
      ),
      Effect.scoped,
    ),
  )
})
