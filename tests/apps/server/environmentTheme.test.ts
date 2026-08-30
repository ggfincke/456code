// tests/apps/server/environmentTheme.test.ts
// verify guarded palette reads and ordered watcher publication

// @effect-diagnostics nodeBuiltinImport:off - exercise real symlink and fifo file guards
import * as NodeChildProcess from 'node:child_process'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import { assert, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import * as ServerConfig from '../../../apps/server/src/config.ts'
import * as EnvironmentTheme from '../../../apps/server/src/environmentTheme.ts'

const theme = JSON.stringify({
  name: 'Nightfall',
  appearance: 'dark',
  canvas: '#123',
  accent: '#456',
})
const layerFor = (baseDir: string) =>
  EnvironmentTheme.layer.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)))

it.layer(NodeServices.layer)('environment theme', (it) =>
{
  it.effect('guards opened file types and sizes without losing valid published themes', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: '456code-theme-guards-' })
      yield* fs.writeFileString(`${dir}/valid.json`, theme)
      yield* fs.writeFileString(`${dir}/ocean.json`, theme)
      yield* fs.writeFileString(`${dir}/invalid.json`, '{bad')
      yield* fs.writeFileString(`${dir}/colorless.json`, '{"name":"Empty","appearance":"dark"}')
      yield* fs.writeFileString(
        `${dir}/large.json`,
        theme.padEnd(EnvironmentTheme.MAX_THEME_FILE_BYTES + 1),
      )
      yield* fs.makeDirectory(`${dir}/directory.json`)
      yield* fs.symlink(`${dir}/valid.json`, `${dir}/linked.json`)
      if ((yield* HostProcessPlatform) !== 'win32')
      {
        NodeChildProcess.execFileSync('mkfifo', [`${dir}/pipe.json`])
        assert.isNull(EnvironmentTheme.readThemeFileGuarded(`${dir}/pipe.json`, 32768))
      }
      assert.deepEqual(
        (yield* EnvironmentTheme.readPublishedThemes(dir)).map((value) => value.id),
        ['valid'],
      )
    }),
  )

  it.effect('bounds examined files and accepted bytes independently', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: '456code-theme-limits-' })
      const examined = `${root}/examined`
      const accepted = `${root}/accepted`
      yield* fs.makeDirectory(examined)
      yield* fs.makeDirectory(accepted)
      for (let index = 0; index < 32; index++)
        yield* fs.writeFileString(`${examined}/a-${String(index).padStart(2, '0')}.json`, '{')
      yield* fs.writeFileString(`${examined}/z-valid.json`, theme)
      assert.deepEqual(yield* EnvironmentTheme.readPublishedThemes(examined), [])
      yield* fs.writeFileString(`${accepted}/a-invalid.json`, '{'.repeat(32000))
      for (let index = 0; index < 7; index++)
        yield* fs.writeFileString(`${accepted}/theme-${index}.json`, theme.padEnd(32768))
      assert.equal((yield* EnvironmentTheme.readPublishedThemes(accepted)).length, 6)
    }),
  )

  it.effect('serializes the whole refresh and drops queued snapshots already observed', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: '456code-theme-order-' })
      const dir = `${baseDir}/userdata/themes`
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(`${dir}/first.json`, theme)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let block = false
      let reads = 0
      const controlled = {
        ...fs,
        watch: () => Stream.never,
        readDirectory: (path: string) =>
          fs.readDirectory(path).pipe(
            Effect.tap(() =>
              Effect.gen(function* ()
              {
                if (path !== dir || !block) return
                reads++
                if (reads !== 1) return
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }),
            ),
          ),
      }
      yield* Effect.gen(function* ()
      {
        const service = yield* EnvironmentTheme.EnvironmentThemeService
        block = true
        const first = yield* service.current.pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* fs.writeFileString(`${dir}/second.json`, theme)
        const second = yield* service.current.pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        assert.equal(reads, 1)
        yield* Deferred.succeed(release, undefined)
        assert.deepEqual(
          (yield* Fiber.join(first)).map((value) => value.id),
          ['first'],
        )
        assert.deepEqual(
          (yield* Fiber.join(second)).map((value) => value.id),
          ['first', 'second'],
        )

        yield* fs.remove(`${dir}/first.json`)
        const initialSeen = yield* Deferred.make<void>()
        const reader = yield* service.streamChanges.pipe(
          Stream.tap(() => Deferred.succeed(initialSeen, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* Deferred.await(initialSeen)
        yield* Effect.yieldNow
        yield* fs.remove(`${dir}/second.json`)
        yield* service.current
        const observed = yield* Fiber.join(reader)
        assert.deepEqual(
          Array.from(observed).map((set) => set.map((value) => value.id)),
          [['second'], []],
        )
      }).pipe(
        Effect.provide(layerFor(baseDir)),
        Effect.provideService(FileSystem.FileSystem, controlled),
      )
    }),
  )
})

it.live('publishes live atomic file changes and removal without restarting', () =>
  Effect.gen(function* ()
  {
    const fs = yield* FileSystem.FileSystem
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: '456code-theme-watch-' })
    yield* Effect.gen(function* ()
    {
      const service = yield* EnvironmentTheme.EnvironmentThemeService
      const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>()
      yield* service.streamChanges.pipe(
        Stream.runForEach((set) => Queue.offer(seen, set)),
        Effect.forkScoped,
      )
      assert.deepEqual(yield* Queue.take(seen), [])
      yield* fs.writeFileString(`${baseDir}/staged.json`, theme)
      yield* fs.rename(`${baseDir}/staged.json`, `${baseDir}/userdata/themes/nightfall.json`)
      assert.deepEqual(
        (yield* Queue.take(seen)).map((value) => value.id),
        ['nightfall'],
      )
      yield* fs.remove(`${baseDir}/userdata/themes/nightfall.json`)
      assert.deepEqual(yield* Queue.take(seen), [])
    }).pipe(Effect.provide(layerFor(baseDir)), Effect.timeout('5 seconds'))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
