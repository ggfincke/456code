// tests/apps/server/assets/AttachmentUpload.test.ts
// verify signed bounded uploads, immutable identities, and pending deletion

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it, expect } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import { attachmentUploadRouteLayer } from '../../../../apps/server/src/http.ts'
import {
  issueAttachmentUploadUrl,
  validateAttachmentUploadToken,
  storeAttachmentUpload,
  deletePendingAttachment,
} from '../../../../apps/server/src/assets/AttachmentUpload.ts'
import { ServerConfig } from '../../../../apps/server/src/config.ts'
import * as ServerSecretStore from '../../../../apps/server/src/auth/ServerSecretStore.ts'
import {
  createAttachmentId,
  parsePendingAttachmentId,
} from '../../../../apps/server/src/attachments/attachmentStore.ts'

const config = ServerConfig.layerTest(process.cwd(), { prefix: 't3-upload-test-' })
const TestLayer = Layer.mergeAll(config, ServerSecretStore.layer.pipe(Layer.provide(config))).pipe(
  Layer.provideMerge(NodeServices.layer),
)
const mint = Effect.gen(function* ()
{
  const url = yield* issueAttachmentUploadUrl({
    type: 'file',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4,
  })
  const token = url.relativeUrl.split('/').at(-1)!
  const claims = yield* validateAttachmentUploadToken(token)
  if (!claims) throw new Error('Fixture token was rejected.')
  return { url, token, claims }
})

it.layer(TestLayer)('AttachmentUpload', (it) =>
{
  it.effect('enforces signed Content-Length at the actual HTTP route before consuming bytes', () =>
    Effect.gen(function* ()
    {
      const { url } = yield* mint
      const handler = yield* HttpRouter.toHttpEffect(attachmentUploadRouteLayer)
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`http://localhost${url.relativeUrl}`, {
              method: 'POST',
              headers: { 'content-length': '5' },
              body: new Uint8Array([1, 2, 3, 4]),
            }),
          ),
        ),
      )
      expect(response.status).toBe(400)
      const accepted = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`http://localhost${url.relativeUrl}`, {
              method: 'POST',
              headers: { 'content-length': '4' },
              body: new Uint8Array([1, 2, 3, 4]),
            }),
          ),
        ),
      )
      expect(accepted.status).toBe(204)
    }),
  )
  it.effect(
    'binds signed metadata, rejects forged/expired grants, and never overwrites a reused id',
    () =>
      Effect.gen(function* ()
      {
        const { token, claims } = yield* mint
        expect(yield* validateAttachmentUploadToken(`${token}x`)).toBeNull()
        expect(
          yield* storeAttachmentUpload(
            { ...claims, attachmentId: '../escape' },
            Uint8Array.of(1, 2, 3, 4),
          ),
        ).toMatchObject({ ok: false })
        expect(
          yield* storeAttachmentUpload(
            { ...claims, name: 'different.zip' },
            Uint8Array.of(1, 2, 3, 4),
          ),
        ).toMatchObject({ ok: false })
        expect(
          yield* storeAttachmentUpload(
            { ...claims, sizeBytes: 50 * 1024 * 1024 + 1 },
            Uint8Array.of(1, 2, 3, 4),
          ),
        ).toMatchObject({ ok: false })
        expect(
          yield* storeAttachmentUpload(
            claims,
            Stream.make(Uint8Array.of(1, 2), Uint8Array.of(3, 4)),
          ),
        ).toEqual({ ok: true })
        expect(yield* storeAttachmentUpload(claims, Uint8Array.of(9, 9, 9, 9))).toMatchObject({
          ok: false,
        })
        const { attachmentsDir } = yield* ServerConfig
        const fs = yield* FileSystem.FileSystem
        expect([...(yield* fs.readFile(`${attachmentsDir}/${claims.attachmentId}.pdf`))]).toEqual([
          1, 2, 3, 4,
        ])
        expect(
          (yield* fs.readDirectory(attachmentsDir)).some((entry) => entry.endsWith('.part')),
        ).toBe(false)
        yield* TestClock.setTime(claims.expiresAt)
        expect(yield* validateAttachmentUploadToken(token)).toBeNull()
      }),
  )

  it.effect('rejects short and overrun streams, cleans partials, and expires during transfer', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const { attachmentsDir } = yield* ServerConfig
      for (const bytes of [Uint8Array.of(1), Uint8Array.of(1, 2, 3, 4, 5)])
      {
        const { claims } = yield* mint
        expect(yield* storeAttachmentUpload(claims, Stream.make(bytes))).toMatchObject({
          ok: false,
          status: 400,
        })
        expect(yield* fs.exists(`${attachmentsDir}/${claims.attachmentId}.pdf`)).toBe(false)
      }
      const { claims } = yield* mint
      const expiring = Stream.make(Uint8Array.of(1, 2, 3, 4)).pipe(
        Stream.tap(() => TestClock.setTime(claims.expiresAt)),
      )
      expect(yield* storeAttachmentUpload(claims, expiring)).toMatchObject({ ok: false })
      expect(yield* fs.exists(`${attachmentsDir}/${claims.attachmentId}.pdf`)).toBe(false)
      expect((yield* fs.readDirectory(attachmentsDir)).some((name) => name.endsWith('.part'))).toBe(
        false,
      )
      const interrupted = yield* mint
      const started = yield* Deferred.make<void>()
      const body = Stream.concat(
        Stream.make(Uint8Array.of(1, 2)).pipe(
          Stream.tap(() => Deferred.succeed(started, undefined)),
        ),
        Stream.never,
      )
      const transfer = yield* Effect.forkChild(storeAttachmentUpload(interrupted.claims, body))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(transfer)
      expect(yield* fs.exists(`${attachmentsDir}/${interrupted.claims.attachmentId}.pdf`)).toBe(
        false,
      )
      expect((yield* fs.readDirectory(attachmentsDir)).some((name) => name.endsWith('.part'))).toBe(
        false,
      )
    }),
  )

  it.effect(
    'keeps accepted files outside pending delete authority and rejects symlink destinations',
    () =>
      Effect.gen(function* ()
      {
        const { claims } = yield* mint
        const fs = yield* FileSystem.FileSystem
        const { attachmentsDir } = yield* ServerConfig
        yield* fs.makeDirectory(attachmentsDir, { recursive: true })
        const acceptedId = createAttachmentId('pending-legacy-thread', '.pdf')!
        const acceptedPath = `${attachmentsDir}/${acceptedId}.pdf`
        yield* fs.writeFileString(acceptedPath, 'keep')
        yield* deletePendingAttachment(acceptedId)
        expect(yield* fs.readFileString(acceptedPath)).toBe('keep')
        const pendingPath = `${attachmentsDir}/${claims.attachmentId}${parsePendingAttachmentId(claims.attachmentId)!.extension}`
        yield* fs.symlink(acceptedPath, pendingPath)
        expect(yield* storeAttachmentUpload(claims, Uint8Array.of(1, 2, 3, 4))).toMatchObject({
          ok: false,
        })
        expect((yield* Effect.exit(deletePendingAttachment(claims.attachmentId)))._tag).toBe(
          'Failure',
        )
        expect(yield* fs.readFileString(acceptedPath)).toBe('keep')
        yield* fs.remove(pendingPath)
        yield* deletePendingAttachment(claims.attachmentId)
        yield* deletePendingAttachment(claims.attachmentId)
        const config = yield* ServerConfig
        yield* deletePendingAttachment(claims.attachmentId).pipe(
          Effect.provideService(ServerConfig, {
            ...config,
            attachmentsDir: `${attachmentsDir}/missing-root`,
          }),
        )
      }),
  )
})
