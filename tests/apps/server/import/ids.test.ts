// tests/apps/server/import/ids.test.ts
// verifies stable deterministic identifiers for transcript imports

import { describe, expect, it } from '@effect/vitest'

import {
  deterministicId,
  deterministicSortableMessageId,
} from '../../../../apps/server/src/import/continuation/ids.ts'

describe('deterministicId', () =>
{
  it('is stable, discriminator-sensitive, and uuid-shaped', () =>
  {
    const first = deterministicId('content-hash', 'message', 'user', 4)
    const repeated = deterministicId('content-hash', 'message', 'user', 4)
    const different = deterministicId('content-hash', 'message', 'assistant', 4)

    expect(repeated).toBe(first)
    expect(different).not.toBe(first)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('deterministicSortableMessageId', () =>
{
  it('is stable and sorts record indexes lexicographically', () =>
  {
    const ids = [10, 2, 1].map((index) =>
      deterministicSortableMessageId('content-hash', 'user', index),
    )

    expect(deterministicSortableMessageId('content-hash', 'user', 2)).toBe(ids[1])
    expect(ids.toSorted()).toEqual([ids[2], ids[1], ids[0]])
    expect(ids[1]).toMatch(/^imp-00000002-[0-9a-f]{16}$/)
  })
})
