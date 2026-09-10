// tests/apps/server/provider/antigravityRelease.test.ts
// verify exact official Antigravity ACP 1.1.1 release pins

import { describe, expect, it } from '@effect/vitest'

import {
  ANTIGRAVITY_RELEASE_VERSION,
  resolveAntigravityReleaseAsset,
} from '../../../../apps/server/src/provider/antigravityRelease.ts'

describe('antigravityRelease', () =>
{
  it('pins every reviewed official archive and its exact executable pair', () =>
  {
    expect(ANTIGRAVITY_RELEASE_VERSION).toBe('agy_acp_server_1.1.1')
    expect(resolveAntigravityReleaseAsset('darwin', 'arm64')).toEqual({
      version: 'agy_acp_server_1.1.1',
      url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip',
      sha256: 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189',
      archiveBytes: 316_014_828,
      executable: { name: 'agy_acp_server.par', bytes: 802_163_856 },
      harness: { name: 'localharness_external', bytes: 116_766_704 },
    })
    expect(resolveAntigravityReleaseAsset('linux', 'x64')).toEqual({
      version: 'agy_acp_server_1.1.1',
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip',
      sha256: '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df',
      archiveBytes: 681_969_407,
      executable: { name: 'agy_acp_server.par', bytes: 1_880_360_328 },
      harness: { name: 'localharness_external', bytes: 128_966_920 },
    })
    expect(resolveAntigravityReleaseAsset('linux', 'arm64')).toEqual({
      version: 'agy_acp_server_1.1.1',
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip',
      sha256: 'ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398',
      archiveBytes: 656_572_786,
      executable: { name: 'agy_acp_server.par', bytes: 1_862_073_131 },
      harness: { name: 'localharness_external', bytes: 122_158_704 },
    })
    expect(resolveAntigravityReleaseAsset('win32', 'x64')).toEqual({
      version: 'agy_acp_server_1.1.1',
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip',
      sha256: '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8',
      archiveBytes: 468_238_392,
      executable: { name: 'agy_acp_server.exe', bytes: 430_801_616 },
      harness: { name: 'localharness_external.exe', bytes: 130_971_800 },
    })
    expect(resolveAntigravityReleaseAsset('win32', 'arm64')).toEqual({
      version: 'agy_acp_server_1.1.1',
      url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip',
      sha256: '35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc',
      archiveBytes: 468_521_191,
      executable: { name: 'agy_acp_server.exe', bytes: 435_075_816 },
      harness: { name: 'localharness_external.exe', bytes: 122_455_704 },
    })
    expect(resolveAntigravityReleaseAsset('darwin', 'x64')).toBeNull()
  })
})
