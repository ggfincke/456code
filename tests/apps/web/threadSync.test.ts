// tests/apps/web/threadSync.test.ts
// covers thread detail synchronization phases

import { describe, expect, it } from 'vite-plus/test'

import { resolveThreadSyncPhase, threadSyncLabel } from '../../../apps/web/src/threadSync'

describe('resolveThreadSyncPhase', () =>
{
  it('loads when only shell data is available', () =>
  {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: 'synchronizing',
      }),
    ).toBe('loading')
  })

  it('syncs when cached detail is already visible', () =>
  {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: 'cached',
      }),
    ).toBe('syncing')
  })

  it('does not report a sync phase without a shell or after going live', () =>
  {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: 'empty',
      }),
    ).toBeNull()
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: 'live',
      }),
    ).toBeNull()
  })
})

describe('threadSyncLabel', () =>
{
  it('uses the same loading and syncing language as mobile', () =>
  {
    expect(threadSyncLabel('loading')).toBe('Loading messages...')
    expect(threadSyncLabel('syncing')).toBe('Syncing messages...')
  })
})
