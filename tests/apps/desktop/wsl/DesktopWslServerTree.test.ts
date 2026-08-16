// tests/apps/desktop/wsl/DesktopWslServerTree.test.ts
// verify digest-keyed WSL server tree extraction

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as PlatformError from 'effect/PlatformError'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'

import * as DesktopConfig from '../../../../apps/desktop/src/app/DesktopConfig.ts'
import * as DesktopEnvironment from '../../../../apps/desktop/src/app/DesktopEnvironment.ts'
import * as DesktopWslServerTree from '../../../../apps/desktop/src/wsl/DesktopWslServerTree.ts'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

const environmentLayer = (input: {
  readonly baseDir: string
  readonly resourcesPath: string
  readonly appVersion?: string
  readonly isPackaged?: boolean
}) =>
  DesktopEnvironment.layer({
    dirname: '/repo/apps/desktop/src',
    homeDirectory: input.baseDir,
    platform: 'win32',
    processArch: 'x64',
    appVersion: input.appVersion ?? '1.2.3',
    appPath: '/repo/resources/app.asar',
    isPackaged: input.isPackaged ?? true,
    resourcesPath: input.resourcesPath,
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: input.baseDir,
          T3CODE_MODE: 'desktop',
        }),
      ),
    ),
  )

const withTempDir = <A, E, R>(
  run: (tempDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  FileSystem.FileSystem | Exclude<R, Scope.Scope>
> =>
  Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: '456code-wsl-server-tree-test-',
    })
    return yield* run(tempDir)
  }).pipe(Effect.scoped)

const ensureWith = (input: {
  readonly baseDir: string
  readonly resourcesPath: string
  readonly appVersion?: string
  readonly isPackaged?: boolean
}) =>
  Effect.gen(function* ()
  {
    const tree = yield* DesktopWslServerTree.DesktopWslServerTree
    return yield* tree.ensure
  }).pipe(
    Effect.provide(DesktopWslServerTree.layer.pipe(Layer.provideMerge(environmentLayer(input)))),
  )

const stagePayload = Effect.fn('test.stageWslServerPayload')(function* (
  resourcesPath: string,
  digest: string,
  contents: string,
)
{
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const serverRoot = path.join(resourcesPath, 'server.asar')
  yield* fileSystem.makeDirectory(path.join(serverRoot, 'apps/server/dist'), {
    recursive: true,
  })
  yield* fileSystem.makeDirectory(
    path.join(serverRoot, 'node_modules/@t3tools/cartographer-core'),
    { recursive: true },
  )
  yield* fileSystem.writeFileString(path.join(serverRoot, 'apps/server/dist/bin.mjs'), contents)
  yield* fileSystem.writeFileString(
    path.join(serverRoot, 'node_modules/@t3tools/cartographer-core/package.json'),
    '{}',
  )
  yield* fileSystem.writeFileString(path.join(resourcesPath, 'server.asar.sha256'), `${digest}\n`)
})

describe('DesktopWslServerTree', () =>
{
  it.effect('bounds nested extraction work to eight concurrent entries', () =>
    Effect.gen(function* ()
    {
      const active = yield* Ref.make(0)
      const maxActive = yield* Ref.make(0)
      const visited = yield* Ref.make(0)

      yield* DesktopWslServerTree.forEachBoundedTree([{ depth: 0 }], (node) =>
        Effect.acquireUseRelease(
          Effect.gen(function* ()
          {
            const current = yield* Ref.updateAndGet(active, (count) => count + 1)
            yield* Ref.update(maxActive, (maximum) => Math.max(maximum, current))
            yield* Ref.update(visited, (count) => count + 1)
          }),
          () =>
            Effect.gen(function* ()
            {
              yield* Effect.yieldNow
              return node.depth === 3
                ? []
                : Array.from({ length: 8 }, () => ({ depth: node.depth + 1 }))
            }),
          () => Ref.update(active, (count) => count - 1),
        ),
      )

      assert.equal(yield* Ref.get(active), 0)
      assert.equal(yield* Ref.get(maxActive), 8)
      assert.equal(yield* Ref.get(visited), 585)
    }),
  )

  it.effect('returns the checkout server root unchanged in development', () =>
    withTempDir((tempDir) =>
      Effect.gen(function* ()
      {
        const path = yield* Path.Path
        const result = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: tempDir,
          isPackaged: false,
        })

        assert.isTrue(result.ok)
        assert.equal(
          result.ok ? result.root : '',
          path.resolve('/repo/apps/desktop/src', '../../..'),
        )
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('extracts the full server and Cartographer tree under its payload digest', () =>
    withTempDir((tempDir) =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const resourcesPath = path.join(tempDir, 'resources')
        yield* fileSystem.makeDirectory(resourcesPath, { recursive: true })
        yield* stagePayload(resourcesPath, DIGEST_A, 'server-entry')

        const result = yield* ensureWith({ baseDir: tempDir, resourcesPath })

        assert.isTrue(result.ok)
        const root = result.ok ? result.root : ''
        assert.include(root, path.join('wsl-server-tree', DIGEST_A))
        assert.equal(
          yield* fileSystem.readFileString(path.join(root, 'apps/server/dist/bin.mjs')),
          'server-entry',
        )
        assert.isTrue(
          yield* fileSystem.exists(
            path.join(root, 'node_modules/@t3tools/cartographer-core/package.json'),
          ),
        )
        const marker = yield* fileSystem.readFileString(
          path.join(root, '456code-wsl-server-tree.json'),
        )
        assert.include(marker, `"payloadDigest":"${DIGEST_A}"`)
        assert.include(marker, '"appVersion":"1.2.3"')
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('serializes concurrent callers and reuses one completed extraction', () =>
    withTempDir((tempDir) =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const resourcesPath = path.join(tempDir, 'resources')
        yield* fileSystem.makeDirectory(resourcesPath, { recursive: true })
        yield* stagePayload(resourcesPath, DIGEST_A, 'first')

        const results = yield* Effect.gen(function* ()
        {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree
          return yield* Effect.all([tree.ensure, tree.ensure], { concurrency: 'unbounded' })
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provideMerge(environmentLayer({ baseDir: tempDir, resourcesPath })),
            ),
          ),
        )

        assert.isTrue(results.every((result) => result.ok))
        const roots = results.flatMap((result) => (result.ok ? [result.root] : []))
        assert.lengthOf(new Set(roots), 1)

        yield* fileSystem.writeFileString(
          path.join(resourcesPath, 'server.asar/apps/server/dist/bin.mjs'),
          'changed-with-same-digest',
        )
        const reused = yield* ensureWith({ baseDir: tempDir, resourcesPath })
        assert.equal(
          yield* fileSystem.readFileString(
            path.join(reused.ok ? reused.root : '', 'apps/server/dist/bin.mjs'),
          ),
          'first',
        )
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('re-extracts same-version builds when their payload digest changes', () =>
    withTempDir((tempDir) =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const resourcesPath = path.join(tempDir, 'resources')
        yield* fileSystem.makeDirectory(resourcesPath, { recursive: true })
        yield* stagePayload(resourcesPath, DIGEST_A, 'old')
        const first = yield* ensureWith({ baseDir: tempDir, resourcesPath })
        assert.isTrue(first.ok)

        yield* stagePayload(resourcesPath, DIGEST_B, 'new')
        const second = yield* ensureWith({ baseDir: tempDir, resourcesPath })
        assert.isTrue(second.ok)
        assert.include(second.ok ? second.root : '', DIGEST_B)
        assert.equal(
          yield* fileSystem.readFileString(
            path.join(second.ok ? second.root : '', 'apps/server/dist/bin.mjs'),
          ),
          'new',
        )

        const treeRoot = path.join(tempDir, 'userdata', 'wsl-server-tree')
        assert.isFalse(yield* fileSystem.exists(path.join(treeRoot, DIGEST_A)))
        assert.isTrue(yield* fileSystem.exists(path.join(treeRoot, DIGEST_B)))
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('fails retryably and leaves no partial tree for invalid payload metadata', () =>
    withTempDir((tempDir) =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const resourcesPath = path.join(tempDir, 'resources')
        yield* fileSystem.makeDirectory(resourcesPath, { recursive: true })
        yield* fileSystem.writeFileString(
          path.join(resourcesPath, 'server.asar.sha256'),
          'not-a-digest\n',
        )

        const result = yield* ensureWith({ baseDir: tempDir, resourcesPath })

        assert.isFalse(result.ok)
        if (!result.ok)
        {
          assert.include(result.reason, 'payload identity could not be read')
          assert.isFalse(result.fatal)
        }
        const treeRoot = path.join(tempDir, 'userdata', 'wsl-server-tree')
        assert.deepEqual(
          yield* fileSystem.readDirectory(treeRoot).pipe(Effect.orElseSucceed(() => [])),
          [],
        )
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
