// tests/apps/web/lib/versionSkew.test.ts
// verify version skew behavior

import { EnvironmentId } from '@t3tools/contracts'
import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('../../../../apps/web/src/lib/branding/branding', () => ({
  APP_VERSION: '2.1.111-nightly.20260826.10',
}))

import { APP_VERSION } from '../../../../apps/web/src/lib/branding/branding'
import {
  appendVersionMismatchHint,
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  serverUpdateGuidance,
} from '../../../../apps/web/src/lib/versionSkew'

describe('versionSkew', () =>
{
  it('does not warn when versions match', () =>
  {
    expect(resolveVersionMismatch(APP_VERSION)).toBeNull()
  })

  it('warns only when the server is behind', () =>
  {
    expect(resolveVersionMismatch('2.1.110')).toEqual({
      clientVersion: APP_VERSION,
      serverVersion: '2.1.110',
      hint: 'Version mismatch. Try syncing the client and server to the same 456code version.',
    })
    expect(resolveVersionMismatch('2.1.112')).toBeNull()
  })

  it('compares nightly sequence numbers within the same release', () =>
  {
    expect(resolveVersionMismatch('2.1.111-nightly.20260826.9')).toMatchObject({
      serverVersion: '2.1.111-nightly.20260826.9',
    })
    expect(resolveVersionMismatch('2.1.111-nightly.20260826.11')).toBeNull()
    expect(resolveVersionMismatch('2.1.111')).toBeNull()
  })

  it('reads the server version from config descriptors', () =>
  {
    expect(
      resolveServerConfigVersionMismatch({
        environment: {
          environmentId: EnvironmentId.make('environment-1'),
          label: 'Remote',
          platform: {
            os: 'darwin',
            arch: 'arm64',
          },
          serverVersion: '2.1.110',
          capabilities: {
            repositoryIdentity: true,
          },
        },
      }),
    ).toMatchObject({
      serverVersion: '2.1.110',
    })
  })

  it('keys dismissals by environment, client version, and server version', () =>
  {
    const environmentId = EnvironmentId.make('environment-dismissal')
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: '2.1.110',
    })

    expect(key).toBe(`${environmentId}:${APP_VERSION}:2.1.110`)
    expect(isVersionMismatchDismissed(key)).toBe(false)

    dismissVersionMismatch(key)

    expect(isVersionMismatchDismissed(key)).toBe(true)
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: '9.9.10',
        }),
      ),
    ).toBe(false)
  })

  it('appends a hint to connection errors when versions differ', () =>
  {
    const mismatch = resolveVersionMismatch('2.1.110')

    expect(appendVersionMismatchHint('Socket closed.', mismatch)).toBe(
      'Socket closed. Hint: Version mismatch. Try syncing the client and server to the same 456code version.',
    )
  })

  it('reads desktop-managed update capabilities from config descriptors', () =>
  {
    expect(
      resolveServerSelfUpdateCapability({
        environment: {
          environmentId: EnvironmentId.make('environment-desktop'),
          label: 'Desktop',
          platform: { os: 'darwin', arch: 'arm64' },
          serverVersion: '9.9.9',
          capabilities: {
            repositoryIdentity: true,
            serverSelfUpdate: 'desktop-managed',
          },
        },
      }),
    ).toBe('desktop-managed')
    expect(resolveServerSelfUpdateCapability(null)).toBeNull()
  })

  it('matches version-drift guidance to the advertised update path', () =>
  {
    expect(serverUpdateGuidance('respawn', 'Remote server')).toBe(
      'Update the Remote server so they stay in sync.',
    )
    expect(serverUpdateGuidance('desktop-managed', 'Desktop server')).toBe(
      'The Desktop server is run by the 456code desktop app on its machine — update the desktop app there to sync them.',
    )
    expect(serverUpdateGuidance(null, 'Local server')).toBe(
      'Relaunch the Local server with the copied command to sync them.',
    )
  })
})
