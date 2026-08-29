// tests/apps/server/cli/theme.test.ts
// verify sparse theme selection and guarded publication rollback

// @effect-diagnostics nodeBuiltinImport:off - inspect native atomic replacement at its publication seam
import * as NodeFS from 'node:fs'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import { vi } from 'vite-plus/test'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import * as TestConsole from 'effect/testing/TestConsole'
import { Command } from 'effect/unstable/cli'
import { themeCommand } from '../../../../apps/server/src/cli/theme.ts'

vi.mock('node:fs', async (importOriginal) =>
{
  const actual = await importOriginal<typeof NodeFS>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const theme = JSON.stringify({
  name: 'Nightfall',
  appearance: 'dark',
  canvas: '#123',
  accent: '#456',
})
const sparseSettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeSettingsJson = Schema.decodeUnknownEffect(sparseSettingsJson)
const encodeSettingsJson = Schema.encodeEffect(sparseSettingsJson)
const runTheme = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(themeCommand, { version: '0.0.0' })(args).pipe(
    Effect.provide(
      Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), TestConsole.layer),
    ),
  )
const readSettings = (path: string) =>
  Effect.gen(function* ()
  {
    const fs = yield* FileSystem.FileSystem
    return yield* decodeSettingsJson(yield* fs.readFileString(path))
  })
const denied = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: 'PermissionDenied',
    module: 'FileSystem',
    method,
    pathOrDescriptor: path,
  })

it.layer(NodeServices.layer)('theme cli', (it) =>
{
  it.effect(
    'preserves sparse unknown settings, explicit path precedence, and repeat-set generations',
    () =>
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: '456code-theme-cli-' })
        const base = `${root}/explicit`
        const settingsPath = `${base}/userdata/settings.json`
        const retained = { enableProviderUpdateChecks: false, futureSetting: { nested: true } }
        yield* fs.makeDirectory(`${base}/userdata`, { recursive: true })
        yield* fs.writeFileString(settingsPath, yield* encodeSettingsJson(retained))
        const env = { T3CODE_HOME: `${root}/from-env` }
        yield* runTheme(['set', 'ocean', '--base-dir', base], env)
        const first = yield* readSettings(settingsPath)
        yield* runTheme(['set', 'ocean', '--base-dir', base], env)
        const second = yield* readSettings(settingsPath)
        assert.equal(second.defaultTheme, 'ocean')
        assert.notEqual(second.defaultThemeSetAt, first.defaultThemeSetAt)
        assert.equal(yield* fs.exists(`${root}/from-env`), false)
        yield* runTheme(['show', '--base-dir', base], env)
        yield* runTheme(['clear', '--base-dir', base], env)
        assert.deepEqual(yield* readSettings(settingsPath), retained)
        yield* runTheme(['set', 'dark'], env)
        assert.equal(
          (yield* readSettings(`${root}/from-env/userdata/settings.json`)).defaultTheme,
          'dark',
        )
      }),
  )

  it.effect('publishes atomically and restores only its own entry after settings failure', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const base = yield* fs.makeTempDirectoryScoped({ prefix: '456code-theme-rollback-' })
      const source = `${base}/nightfall.json`
      const dir = `${base}/userdata/themes`
      const destination = `${dir}/nightfall.json`
      const settingsPath = `${base}/userdata/settings.json`
      yield* fs.writeFileString(source, theme)
      yield* runTheme(['set', source, '--base-dir', base])
      assert.equal(yield* fs.readFileString(destination), theme)
      const previousSettings = yield* fs.readFileString(settingsPath)
      const replacement = theme.replace('Nightfall', 'Replacement')
      yield* fs.writeFileString(source, replacement)
      const nativeFs = yield* Effect.promise(() => vi.importActual<typeof NodeFS>('node:fs'))
      const nativeRename = nativeFs.renameSync
      let atomicReplacements = 0
      const rename = vi.mocked(NodeFS.renameSync).mockImplementation((from, to) =>
      {
        if (String(from).startsWith(`${destination}.staging-`) && to === destination)
        {
          assert.equal(NodeFS.readFileSync(destination, 'utf8'), theme)
          atomicReplacements++
        }
        nativeRename(from, to)
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => rename.mockRestore()))
      for (const replaceConcurrently of [false, true])
      {
        const controlled = {
          ...fs,
          rename: (from: string, to: string) =>
            to === settingsPath
              ? Effect.gen(function* ()
                {
                  if (replaceConcurrently)
                    {
                    yield* fs.writeFileString(`${base}/other.json`, 'concurrent owner')
                    yield* fs.rename(`${base}/other.json`, destination)
                  }
                  return yield* denied('rename', to)
                })
              : fs.rename(from, to),
        }
        const failure = yield* runTheme(['set', source, '--base-dir', base]).pipe(
          Effect.provideService(FileSystem.FileSystem, controlled),
          Effect.flip,
        )
        assert.equal(failure._tag, 'ThemeSettingsWriteError')
        assert.equal(
          yield* fs.readFileString(destination),
          replaceConcurrently ? 'concurrent owner' : theme,
        )
        assert.equal(yield* fs.readFileString(settingsPath), previousSettings)
        assert.deepEqual(yield* fs.readDirectory(dir), ['nightfall.json'])
      }
      assert.equal(atomicReplacements, 2)
      yield* fs.makeDirectory(`${dir}/blocked.json`)
      const blocked = yield* runTheme(['set', source, '--id', 'blocked', '--base-dir', base]).pipe(
        Effect.flip,
      )
      assert.equal(blocked._tag, 'ThemePublishError')
      assert.equal((yield* fs.stat(`${dir}/blocked.json`)).type, 'Directory')
      assert.deepEqual((yield* fs.readDirectory(dir)).toSorted(), [
        'blocked.json',
        'nightfall.json',
      ])
      assert.equal(yield* fs.readFileString(settingsPath), previousSettings)
    }),
  )

  it.effect('rolls back publication excluded by the same examined-file and total-byte limits', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: '456code-theme-cap-' })
      for (const limit of ['count', 'bytes'])
      {
        const base = `${root}/${limit}`
        const dir = `${base}/userdata/themes`
        const source = `${base}/z-last.json`
        yield* fs.makeDirectory(dir, { recursive: true })
        const count = limit === 'count' ? 32 : 6
        for (let index = 0; index < count; index++)
          yield* fs.writeFileString(
            `${dir}/a-${String(index).padStart(2, '0')}.json`,
            limit === 'count' ? theme : theme.padEnd(32768),
          )
        yield* fs.writeFileString(source, theme)
        const failure = yield* runTheme(['set', source, '--base-dir', base]).pipe(Effect.flip)
        assert.equal(failure._tag, 'ThemePublishError')
        assert.equal(yield* fs.exists(`${dir}/z-last.json`), false)
        assert.equal(yield* fs.exists(`${base}/userdata/settings.json`), false)
        assert.equal((yield* fs.readDirectory(dir)).length, count)
      }
    }),
  )

  it.effect(
    'preserves unreadable or malformed settings and restores a publish interrupted before selection',
    () =>
      Effect.gen(function* ()
      {
        const fs = yield* FileSystem.FileSystem
        const base = yield* fs.makeTempDirectoryScoped({ prefix: '456code-theme-interrupt-' })
        const dir = `${base}/userdata/themes`
        const source = `${base}/nightfall.json`
        const destination = `${dir}/nightfall.json`
        const settingsPath = `${base}/userdata/settings.json`
        yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(source, theme)
        yield* fs.writeFileString(destination, 'prior entry')
        yield* fs.writeFileString(settingsPath, '{broken')
        assert.equal(
          (yield* runTheme(['set', source, '--base-dir', base]).pipe(Effect.flip))._tag,
          'ThemeSettingsMalformedError',
        )
        const unreadable = {
          ...fs,
          readFileString: (path: string) =>
            path === settingsPath
              ? Effect.fail(denied('readFileString', path))
              : fs.readFileString(path),
        }
        assert.equal(
          (yield* runTheme(['set', source, '--base-dir', base]).pipe(
            Effect.provideService(FileSystem.FileSystem, unreadable),
            Effect.flip,
          ))._tag,
          'ThemeSettingsUnreadableError',
        )
        assert.equal(yield* fs.readFileString(settingsPath), '{broken')
        assert.equal(yield* fs.readFileString(destination), 'prior entry')
        yield* fs.writeFileString(settingsPath, '{}')
        const writing = yield* Deferred.make<void>()
        const paused = {
          ...fs,
          rename: (from: string, to: string) =>
            to === settingsPath
              ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))
              : fs.rename(from, to),
        }
        const fiber = yield* runTheme(['set', source, '--base-dir', base]).pipe(
          Effect.provideService(FileSystem.FileSystem, paused),
          Effect.forkScoped,
        )
        yield* Deferred.await(writing)
        yield* Fiber.interrupt(fiber)
        assert.equal(yield* fs.readFileString(destination), 'prior entry')
        assert.equal(yield* fs.readFileString(settingsPath), '{}')
        assert.deepEqual(yield* fs.readDirectory(dir), ['nightfall.json'])
      }),
  )
})
