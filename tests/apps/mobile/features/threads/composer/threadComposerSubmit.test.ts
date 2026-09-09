// tests/apps/mobile/features/threads/composer/threadComposerSubmit.test.ts
// protects immediate compaction from delayed or context-bearing submission

import { describe, expect, it } from 'vite-plus/test'
import { canSubmitManualCompaction } from '../../../../../../apps/mobile/src/features/threads/composer/threadComposerSubmit'

describe('manual compaction submission', () =>
{
  it('requires an exact context-free command on an idle connected session', () =>
  {
    const ready = {
      text: '/compact',
      attachmentCount: 0,
      connected: true,
      busy: false,
      queuedCount: 0,
      blocked: false,
      hasSession: true,
      supported: true,
    }
    expect(canSubmitManualCompaction(ready)).toBe(true)
    expect(canSubmitManualCompaction({ ...ready, connected: false })).toBe(false)
    expect(canSubmitManualCompaction({ ...ready, queuedCount: 1 })).toBe(false)
    expect(canSubmitManualCompaction({ ...ready, busy: true })).toBe(false)
    expect(canSubmitManualCompaction({ ...ready, attachmentCount: 1 })).toBe(false)
    expect(canSubmitManualCompaction({ ...ready, text: '/compact explain this' })).toBe(false)
    expect(canSubmitManualCompaction({ ...ready, supported: false })).toBe(false)
  })
})
