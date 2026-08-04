// tests/apps/mobile/features/threads/ThreadComposer.test.ts
// verifies imported-session composer notices remain visible and non-actionable

import { describe, expect, it } from 'vite-plus/test'

import { composerConnectionStatus } from '../../../../../apps/mobile/src/features/threads/threadComposerStatus.ts'

describe('mobile thread composer status', () =>
{
  it('uses a dedicated blocked notice for imported first-turn continuation', () =>
  {
    const label =
      'Continue this imported session in the web app after reviewing its provider continuation.'

    expect(
      composerConnectionStatus({
        connectionError: null,
        connectionState: 'connected',
        environmentLabel: 'Local',
        sendBlockedReason: label,
        threadSyncPhase: null,
      }),
    ).toEqual({
      kind: 'blocked',
      label,
    })
  })
})
