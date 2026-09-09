// tests/apps/mobile/features/threads/sidebar/threadDragGap.test.ts
// protects drag destinations from leaving the arranged task list

import { describe, expect, it } from 'vite-plus/test'
import { resolveThreadDragDestination } from '../../../../../../apps/mobile/src/features/threads/sidebar/threadDragGap'

describe('thread drag destination', () =>
{
  it('moves by row distance and clamps drags beyond both list edges', () =>
  {
    expect(resolveThreadDragDestination(2, 56, 56, 5)).toBe(3)
    expect(resolveThreadDragDestination(2, -1000, 56, 5)).toBe(0)
    expect(resolveThreadDragDestination(2, 1000, 56, 5)).toBe(4)
  })
})
