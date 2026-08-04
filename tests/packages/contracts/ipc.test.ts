// tests/packages/contracts/ipc.test.ts
// verify desktop environment bootstrap schema behavior

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import { DesktopEnvironmentBootstrapSchema } from '../../../packages/contracts/src/ipc.ts'

describe('DesktopEnvironmentBootstrapSchema', () =>
{
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema)

  it('preserves the concrete running distro separately from the backend id', () =>
  {
    expect(
      decode({
        id: 'wsl:default',
        label: 'WSL (Ubuntu)',
        runningDistro: 'Ubuntu',
        httpBaseUrl: 'http://127.0.0.1:3774/',
        wsBaseUrl: 'ws://127.0.0.1:3774/',
      }),
    ).toEqual({
      id: 'wsl:default',
      label: 'WSL (Ubuntu)',
      runningDistro: 'Ubuntu',
      httpBaseUrl: 'http://127.0.0.1:3774/',
      wsBaseUrl: 'ws://127.0.0.1:3774/',
    })
  })
})
