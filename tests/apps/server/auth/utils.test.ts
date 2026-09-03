// tests/apps/server/auth/utils.test.ts
// verify derive auth client metadata behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  deriveAuthClientMetadata,
  resolveLegacySessionCookieName,
  resolveSessionCookieName,
} from '../../../../apps/server/src/auth/utils.ts'

describe('session cookie isolation', () =>
{
  it('isolates loopback web servers by port and state directory', () =>
  {
    const first = resolveSessionCookieName({
      mode: 'web',
      port: 5775,
      host: '127.0.0.1',
      instanceKey: '/tmp/t3-agent-one',
      environmentId: 'environment-one',
      development: true,
    })
    const second = resolveSessionCookieName({
      mode: 'web',
      port: 5775,
      host: '127.0.0.1',
      instanceKey: '/tmp/t3-agent-two',
      environmentId: 'environment-two',
      development: true,
    })

    expect(first).toMatch(/^t3_session_5775_[a-f0-9]{12}$/)
    expect(second).toMatch(/^t3_session_5775_[a-f0-9]{12}$/)
    expect(first).not.toBe(second)
  })

  it('keys remote production cookies only by persisted environment identity', () =>
  {
    const original = resolveSessionCookieName({
      mode: 'web',
      port: 3773,
      host: '192.168.1.50',
      instanceKey: '/srv/t3-one',
      environmentId: 'environment-one',
      development: false,
    })
    const moved = resolveSessionCookieName({
      mode: 'web',
      port: 5775,
      host: '0.0.0.0',
      instanceKey: '/srv/t3-moved',
      environmentId: 'environment-one',
      development: false,
    })
    const other = resolveSessionCookieName({
      mode: 'web',
      port: 3773,
      host: '192.168.1.50',
      instanceKey: '/srv/t3-one',
      environmentId: 'environment-two',
      development: false,
    })

    expect(original).toMatch(/^t3_session_[a-f0-9]{12}$/)
    expect(moved).toBe(original)
    expect(other).not.toBe(original)
  })

  it('retains desktop port scoping', () =>
  {
    expect(
      resolveSessionCookieName({
        mode: 'desktop',
        port: 3773,
        host: '127.0.0.1',
        instanceKey: '/tmp/desktop',
        environmentId: 'environment-one',
        development: true,
      }),
    ).toBe('t3_session_3773')
  })

  it('keeps wildcard development servers state scoped', () =>
  {
    expect(
      resolveSessionCookieName({
        mode: 'web',
        port: 5775,
        host: '0.0.0.0',
        instanceKey: '/tmp/t3-wildcard-dev',
        environmentId: 'environment-one',
        development: true,
      }),
    ).toMatch(/^t3_session_5775_[a-f0-9]{12}$/)
  })

  it('offers the legacy cookie only to remote production web servers', () =>
  {
    expect(
      resolveLegacySessionCookieName({
        mode: 'web',
        host: '192.168.1.50',
        development: false,
      }),
    ).toBe('t3_session')
    expect(
      resolveLegacySessionCookieName({
        mode: 'web',
        host: '127.0.0.1',
        development: false,
      }),
    ).toBeUndefined()
    expect(
      resolveLegacySessionCookieName({
        mode: 'desktop',
        host: '192.168.1.50',
        development: false,
      }),
    ).toBeUndefined()
  })
})

describe('deriveAuthClientMetadata', () =>
{
  it('labels Electron user agents as Electron instead of Chrome', () =>
  {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) 456code/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36',
        },
        source: {
          remoteAddress: '::ffff:127.0.0.1',
        },
      } as never,
    })

    expect(metadata).toMatchObject({
      browser: 'Electron',
      deviceType: 'desktop',
      ipAddress: '127.0.0.1',
      os: 'macOS',
    })
  })

  it('applies client-presented display identity without replacing transport metadata', () =>
  {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36',
        },
        source: {
          remoteAddress: '::ffff:192.168.213.72',
        },
      } as never,
      presented: {
        label: '456code Mobile',
        deviceType: 'mobile',
        os: 'iOS',
      },
    })

    expect(metadata).toMatchObject({
      label: '456code Mobile',
      browser: 'Electron',
      deviceType: 'mobile',
      ipAddress: '192.168.213.72',
      os: 'iOS',
    })
    expect(metadata.userAgent).toContain('Electron/36.3.2')
  })
})
