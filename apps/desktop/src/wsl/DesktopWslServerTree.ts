// apps/desktop/src/wsl/DesktopWslServerTree.ts
// materialize the packaged Windows server tree for WSL

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import * as DesktopEnvironment from '../app/DesktopEnvironment.ts'

export type WslServerTreeResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly reason: string; readonly fatal: boolean }

const MARKER_FILE_NAME = '456code-wsl-server-tree.json'
const PAYLOAD_DIGEST_FILE_NAME = 'server.asar.sha256'
const COPY_CONCURRENCY = 8
const PAYLOAD_DIGEST_PATTERN = /^[0-9a-f]{64}$/u

const Marker = Schema.Struct({
  payloadDigest: Schema.String,
  appVersion: Schema.String,
})
const decodeMarker = Schema.decodeUnknownEffect(Schema.fromJsonString(Marker))
const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(Marker))

export class DesktopWslServerTreeExtractError extends Schema.TaggedErrorClass<DesktopWslServerTreeExtractError>()(
  'DesktopWslServerTreeExtractError',
  {
    targetDir: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to extract the WSL server tree to ${this.targetDir}.`
  }
}

export class DesktopWslServerTreeDigestError extends Schema.TaggedErrorClass<DesktopWslServerTreeDigestError>()(
  'DesktopWslServerTreeDigestError',
  {
    digestPath: Schema.String,
    value: Schema.String,
  },
)
{
  override get message(): string
  {
    return `Invalid server payload digest at ${this.digestPath}.`
  }
}

export class DesktopWslServerTree extends Context.Service<
  DesktopWslServerTree,
  {
    // returns a real directory containing apps/server/dist and node_modules
    readonly ensure: Effect.Effect<WslServerTreeResult>
  }
>()('@t3tools/desktop/wsl/DesktopWslServerTree')
{}

export const forEachBoundedTree = <Node, E, R>(
  roots: ReadonlyArray<Node>,
  visit: (node: Node) => Effect.Effect<ReadonlyArray<Node>, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* ()
  {
    const pending = [...roots]
    while (pending.length > 0)
    {
      const batch = pending.splice(-COPY_CONCURRENCY)
      const children = yield* Effect.forEach(batch, visit, {
        concurrency: COPY_CONCURRENCY,
      })
      for (const entries of children)
      {
        pending.push(...entries)
      }
    }
  })

interface CopyTreeEntry
{
  readonly sourcePath: string
  readonly targetPath: string
}

const copyTree = (
  fs: FileSystem.FileSystem,
  join: (first: string, ...rest: ReadonlyArray<string>) => string,
  from: string,
  to: string,
): Effect.Effect<void, PlatformError.PlatformError> =>
  forEachBoundedTree<CopyTreeEntry, PlatformError.PlatformError, never>(
    [{ sourcePath: from, targetPath: to }],
    ({ sourcePath, targetPath }) =>
      Effect.gen(function* ()
      {
        const info = yield* fs.stat(sourcePath)
        if (info.type === 'Directory')
        {
          yield* fs.makeDirectory(targetPath, { recursive: true })
          const entries = yield* fs.readDirectory(sourcePath)
          return entries.map((entry) => ({
            sourcePath: join(sourcePath, entry),
            targetPath: join(targetPath, entry),
          }))
        }
        if (info.type === 'File')
        {
          const bytes = yield* fs.readFile(sourcePath)
          yield* fs.writeFile(targetPath, bytes)
        }
        return []
      }),
  )

export const make = Effect.gen(function* ()
{
  const environment = yield* DesktopEnvironment.DesktopEnvironment
  const fs = yield* FileSystem.FileSystem
  const join = environment.path.join
  const needsExtraction = environment.isPackaged && environment.platform === 'win32'
  const treeRoot = join(environment.stateDir, 'wsl-server-tree')
  const digestPath = join(environment.resourcesPath, PAYLOAD_DIGEST_FILE_NAME)
  const gate = yield* Semaphore.make(1)

  const readPayloadDigest = fs.readFileString(digestPath).pipe(
    Effect.map((raw) => raw.trim().toLowerCase()),
    Effect.flatMap((payloadDigest) =>
      PAYLOAD_DIGEST_PATTERN.test(payloadDigest)
        ? Effect.succeed(payloadDigest)
        : Effect.fail(new DesktopWslServerTreeDigestError({ digestPath, value: payloadDigest })),
    ),
  )

  const ensure: Effect.Effect<WslServerTreeResult> = gate
    .withPermits(1)(
      Effect.gen(function* ()
      {
        if (!needsExtraction)
        {
          return { ok: true, root: environment.serverRoot } as const
        }

        const payloadDigestResult = yield* readPayloadDigest.pipe(
          Effect.match({
            onFailure: (cause) => ({ _tag: 'Failure', cause }) as const,
            onSuccess: (payloadDigest) => ({ _tag: 'Success', payloadDigest }) as const,
          }),
        )
        if (payloadDigestResult._tag === 'Failure')
        {
          return {
            ok: false,
            reason: `WSL server payload identity could not be read from ${digestPath}: ${String(payloadDigestResult.cause)}`,
            fatal: false,
          } as const
        }

        const payloadDigest = payloadDigestResult.payloadDigest
        const targetDir = join(treeRoot, payloadDigest)
        const markerPath = join(targetDir, MARKER_FILE_NAME)
        const markerMatches = fs.readFileString(markerPath).pipe(
          Effect.flatMap(decodeMarker),
          Effect.map((marker) => marker.payloadDigest === payloadDigest),
          Effect.orElseSucceed(() => false),
        )
        const sweepStale = Effect.gen(function* ()
        {
          const entries = yield* fs.readDirectory(treeRoot).pipe(Effect.orElseSucceed(() => []))
          yield* Effect.forEach(
            entries.filter((entry) => entry !== payloadDigest),
            (entry) =>
              fs
                .remove(join(treeRoot, entry), { recursive: true, force: true })
                .pipe(Effect.ignore),
            { discard: true },
          )
        })

        if (yield* markerMatches)
        {
          yield* sweepStale
          return { ok: true, root: targetDir } as const
        }

        const extract = Effect.gen(function* ()
        {
          yield* fs.makeDirectory(treeRoot, { recursive: true })
          const partialDir = yield* fs.makeTempDirectory({
            directory: treeRoot,
            prefix: `.${payloadDigest}.extract-`,
          })
          yield* Effect.gen(function* ()
          {
            yield* copyTree(fs, join, environment.serverRoot, partialDir)
            const markerJson = yield* encodeMarker({
              payloadDigest,
              appVersion: environment.appVersion,
            })
            yield* fs.writeFileString(join(partialDir, MARKER_FILE_NAME), `${markerJson}\n`)
            yield* fs.remove(targetDir, { recursive: true, force: true }).pipe(Effect.ignore)
            yield* fs.rename(partialDir, targetDir)
          }).pipe(
            Effect.ensuring(
              fs.remove(partialDir, { recursive: true, force: true }).pipe(Effect.ignore),
            ),
          )
        }).pipe(
          Effect.mapError((cause) => new DesktopWslServerTreeExtractError({ targetDir, cause })),
        )

        const result = yield* extract.pipe(
          Effect.map(() => ({ ok: true, root: targetDir }) as const),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false,
              reason: `WSL server files could not be extracted to ${targetDir}: ${error.message}`,
              fatal: false,
            } as const),
          ),
        )
        if (result.ok)
        {
          yield* sweepStale
        }
        return result
      }),
    )
    .pipe(Effect.withSpan('desktop.wslServerTree.ensure'))

  return DesktopWslServerTree.of({ ensure })
})

export const layer = Layer.effect(DesktopWslServerTree, make)

export const layerTest = (result?: WslServerTreeResult) =>
  Layer.effect(
    DesktopWslServerTree,
    Effect.gen(function* ()
    {
      const environment = yield* DesktopEnvironment.DesktopEnvironment
      return DesktopWslServerTree.of({
        ensure: Effect.succeed(result ?? { ok: true, root: environment.appRoot }),
      })
    }),
  )
