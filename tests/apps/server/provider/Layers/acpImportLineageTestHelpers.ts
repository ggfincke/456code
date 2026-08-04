// tests/apps/server/provider/Layers/acpImportLineageTestHelpers.ts
// provides shared ACP import lineage adapter assertions

import { assert } from '@effect/vitest'
import type { ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'

import type { ProviderAdapterError } from '../../../../../apps/server/src/provider/Errors.ts'
import type { ProviderAdapterShape } from '../../../../../apps/server/src/provider/Services/ProviderAdapter.ts'

export const STRICT_IMPORT_RESUME_CURSOR = {
  schemaVersion: 1,
  sessionId: 'mock-session-1',
  requireExisting: true,
} as const

export const assertMissingImportedSessionRejected = (
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  threadId: ThreadId,
  error: unknown,
) =>
  Effect.gen(function* ()
  {
    assert.match((error as { _tag: string })._tag, /^ProviderAdapter/)
    assert.isFalse(yield* adapter.hasSession(threadId))
    assert.lengthOf(yield* adapter.listSessions(), 0)
  })

export const assertActiveImportedSessionBlocksFreshStart = (
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  threadId: ThreadId,
  error: unknown,
  importedResumeCursor: unknown,
) =>
  Effect.gen(function* ()
  {
    assert.equal((error as { _tag: string })._tag, 'ProviderAdapterValidationError')
    assert.include(
      (error as { message: string }).message,
      'must be stopped before starting a fresh native session',
    )
    assert.deepStrictEqual(
      (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)?.resumeCursor,
      importedResumeCursor,
    )
  })

export const assertMalformedStrictImportRejected = (
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  threadId: ThreadId,
  error: unknown,
) =>
  Effect.gen(function* ()
  {
    assert.equal((error as { _tag: string })._tag, 'ProviderAdapterValidationError')
    assert.include((error as { message: string }).message, 'valid existing native session id')
    assert.isFalse(yield* adapter.hasSession(threadId))
  })

export const assertInvalidStrictMarkerPreservesActive = (
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  threadId: ThreadId,
  error: unknown,
  activeResumeCursor: unknown,
) =>
  Effect.gen(function* ()
  {
    assert.equal((error as { _tag: string })._tag, 'ProviderAdapterValidationError')
    assert.isTrue(yield* adapter.hasSession(threadId))
    assert.deepStrictEqual(
      (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId)?.resumeCursor,
      activeResumeCursor,
    )
  })

export const assertStrictImportMarkerPreserved = (input: {
  sessionResumeCursor: unknown
  turnResumeCursor: unknown
  listedResumeCursor?: unknown
  expectedCursor?: unknown
}) =>
{
  const expectedCursor = input.expectedCursor ?? STRICT_IMPORT_RESUME_CURSOR
  assert.deepStrictEqual(input.sessionResumeCursor, expectedCursor)
  assert.deepStrictEqual(input.turnResumeCursor, expectedCursor)
  if (input.listedResumeCursor !== undefined)
  {
    assert.deepStrictEqual(input.listedResumeCursor, expectedCursor)
  }
}
