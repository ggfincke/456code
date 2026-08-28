// apps/server/src/assets/AttachmentUpload.ts
// authenticate bounded pending attachment transfers

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from 'node:crypto'
import * as NodeFS from 'node:fs'
import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  AttachmentCreateUploadUrlInput,
  AttachmentDeleteError,
  AttachmentUploadSigningKeyError,
} from '@t3tools/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import type * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'

import {
  createPendingAttachmentId,
  parsePendingAttachmentId,
  attachmentFileExtension,
} from '../attachments/attachmentStore.ts'
import { inspectManagedFile, isSafeManagedPath } from '../attachments/attachmentFiles.ts'
import { resolveAttachmentRelativePath } from '../attachments/attachmentPaths.ts'
import { inferImageExtension } from '../attachments/imageMime.ts'
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from '../auth/utils.ts'
import * as ServerSecretStore from '../auth/ServerSecretStore.ts'
import { ServerConfig } from '../config.ts'

export const ATTACHMENT_UPLOAD_ROUTE_PREFIX = '/api/attachments/upload'
const SIGNING_SECRET_NAME = 'asset-access-signing-key'
const Claims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal('attachment-upload'),
  type: Schema.Literals(['image', 'file']),
  attachmentId: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
})
export type AttachmentUploadClaims = typeof Claims.Type
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))
const encodeClaims = Schema.encodeSync(Schema.fromJsonString(Claims))
const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput)

const loadSigningSecret = Effect.gen(function* ()
{
  const secretStore = yield* ServerSecretStore.ServerSecretStore
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32)
})

export const issueAttachmentUploadUrl = Effect.fn('AttachmentUpload.issueUrl')(function* (
  input: AttachmentCreateUploadUrlInput,
)
{
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError((cause) => new AttachmentUploadSigningKeyError({ cause })),
  )
  const type = input.type ?? 'image'
  const extension =
    type === 'image'
      ? inferImageExtension({ mimeType: input.mimeType, fileName: input.name })
      : attachmentFileExtension(input.name)
  const attachmentId = createPendingAttachmentId(type, extension)
  const expiresAt = (yield* Clock.currentTimeMillis) + ATTACHMENT_UPLOAD_URL_TTL_MS
  const payload = base64UrlEncode(
    encodeClaims({
      version: 1,
      kind: 'attachment-upload',
      ...input,
      type,
      attachmentId,
      expiresAt,
    }),
  )
  return {
    attachmentId,
    relativeUrl: `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/${payload}.${signPayload(payload, secret)}`,
    expiresAt,
  }
})

export const validateAttachmentUploadToken = Effect.fn('AttachmentUpload.validateToken')(function* (
  token: string,
)
{
  if (token.length > 4096) return null
  const [payload, signature, extra] = token.split('.')
  if (
    !payload ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  )
    return null
  const secret = yield* loadSigningSecret.pipe(Effect.orElseSucceed(() => null))
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return null
  let claims: AttachmentUploadClaims | null = null
  try
  {
    claims = Option.getOrNull(decodeClaims(base64UrlDecodeUtf8(payload)))
  }
  catch
  {
    return null
  }
  if (
    !claims ||
    !isUploadInput(claims) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= (yield* Clock.currentTimeMillis)
  )
    return null
  const pending = parsePendingAttachmentId(claims.attachmentId)
  const extension =
    claims.type === 'image'
      ? inferImageExtension({ mimeType: claims.mimeType, fileName: claims.name })
      : attachmentFileExtension(claims.name)
  return pending?.type === claims.type && pending.extension === extension ? claims : null
})

export type StoreAttachmentUploadResult =
  { readonly ok: true } | { readonly ok: false; readonly status: number; readonly detail: string }

export const storeAttachmentUpload = Effect.fn('AttachmentUpload.store')(function* (
  claims: AttachmentUploadClaims,
  body: Uint8Array | HttpServerRequest.HttpServerRequest['stream'],
): Effect.fn.Return<StoreAttachmentUploadResult, never, ServerConfig | FileSystem.FileSystem>
{
  const pending = parsePendingAttachmentId(claims.attachmentId)
  const extension =
    claims.type === 'image'
      ? inferImageExtension({ mimeType: claims.mimeType, fileName: claims.name })
      : attachmentFileExtension(claims.name)
  if (
    !pending ||
    pending.type !== claims.type ||
    pending.extension !== extension ||
    !isUploadInput(claims) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= (yield* Clock.currentTimeMillis)
  )
    return { ok: false, status: 400, detail: 'Invalid upload claims.' }
  const config = yield* ServerConfig
  const fileSystem = yield* FileSystem.FileSystem
  const relativePath = `${claims.attachmentId}${pending.extension}`
  const partRelativePath = `${relativePath}.${NodeCrypto.randomUUID()}.part`
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath,
  })!
  const partPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: partRelativePath,
  })!
  let received = 0
  const bodyStream = body instanceof Uint8Array ? Stream.make(body) : body
  return yield* Effect.gen(function* ()
  {
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true })
    if (
      !isSafeManagedPath({ attachmentsDir: config.attachmentsDir, relativePath }, true) ||
      !isSafeManagedPath(
        { attachmentsDir: config.attachmentsDir, relativePath: partRelativePath },
        true,
      )
    )
      return { ok: false, status: 400, detail: 'Unsafe upload destination.' } as const
    yield* Stream.run(
      bodyStream.pipe(
        Stream.takeWhile((chunk) =>
        {
          received += chunk.byteLength
          return received <= claims.sizeBytes
        }),
      ),
      fileSystem.sink(partPath, { flag: 'wx' }),
    )
    if (received !== claims.sizeBytes)
      return {
        ok: false,
        status: 400,
        detail: 'Upload body does not match its signed size.',
      } as const
    if (claims.expiresAt <= (yield* Clock.currentTimeMillis))
      return { ok: false, status: 400, detail: 'Upload expired during transfer.' } as const
    if (!isSafeManagedPath({ attachmentsDir: config.attachmentsDir, relativePath }, true))
      return { ok: false, status: 400, detail: 'Unsafe upload destination.' } as const
    // a hard-link publication is atomic and cannot replace bytes behind a live pending id
    yield* fileSystem.link(partPath, finalPath)
    return { ok: true } as const
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({ ok: false, status: 500, detail: 'Failed to persist upload.' } as const),
    ),
    Effect.ensuring(
      Effect.sync(() =>
      {
        if (
          !isSafeManagedPath({
            attachmentsDir: config.attachmentsDir,
            relativePath: partRelativePath,
          })
        )
          return
        // an interrupted transfer may not have created the file
        try
        {
          NodeFS.unlinkSync(partPath)
        }
        catch
        {}
      }),
    ),
  )
})

export const deletePendingAttachment = Effect.fn('AttachmentUpload.deletePending')(function* (
  attachmentId: string,
)
{
  const pending = parsePendingAttachmentId(attachmentId)
  if (!pending) return
  const { attachmentsDir } = yield* ServerConfig
  yield* Effect.try({
    try: () =>
    {
      const relativePath = `${attachmentId}${pending.extension}`
      try
      {
        NodeFS.lstatSync(attachmentsDir)
      }
      catch (cause)
      {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
        throw cause
      }
      if (!isSafeManagedPath({ attachmentsDir, relativePath }, true))
        throw new Error('Unsafe pending attachment path.')
      const file = inspectManagedFile({ attachmentsDir, relativePath })
      if (!file) return
      try
      {
        NodeFS.unlinkSync(file.path)
      }
      catch (cause)
      {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    },
    catch: (cause) => new AttachmentDeleteError({ cause }),
  })
})
