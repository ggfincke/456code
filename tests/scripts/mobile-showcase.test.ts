// tests/scripts/mobile-showcase.test.ts
// verify mobile showcase behavior

import { assert, it } from '@effect/vitest'
import { PNG } from 'pngjs'

import showcaseConfig, {
  type ShowcaseConfig,
  type ShowcaseStoreAssetSpec,
} from '../../scripts/mobile-showcase.config.ts'
import {
  normalizeStorePng,
  parseShowcaseCliArgs,
  parsePairingCredentialOutput,
  planShowcaseCaptures,
  readPngDimensions,
  readPngMetadata,
  selectLanIpv4Address,
  showcaseCaptureDirectory,
  validateStoreAsset,
  validateStoreAssetCount,
} from '../../scripts/mobile-showcase.ts'

const appleSpec: ShowcaseStoreAssetSpec = {
  store: 'apple',
  directory: 'apple/iphone-test',
  width: 1284,
  height: 2778,
  minimumUploadCount: 1,
  maximumUploadCount: 10,
}

const config: ShowcaseConfig = {
  outputDirectory: 'artifacts',
  metroPort: 8199,
  settleDelayMs: 1,
  devices: [
    {
      id: 'phone',
      platform: 'ios',
      simulator: 'iPhone Test',
      appearance: 'dark',
      scenes: ['thread', 'review'],
      storeAsset: appleSpec,
    },
  ],
}

it('parses repeatable capture filters', () =>
{
  const options = parseShowcaseCliArgs([
    '--platform',
    'ios',
    '--device',
    'phone',
    '--scene',
    'review',
    '--appearance',
    'both',
    '--skip-build',
    '--validate-only',
  ])
  assert.deepStrictEqual([...options.platforms], ['ios'])
  assert.deepStrictEqual([...options.deviceIds], ['phone'])
  assert.deepStrictEqual([...options.scenes], ['review'])
  assert.deepStrictEqual([...options.appearances], ['light', 'dark'])
  assert.equal(options.skipBuild, true)
  assert.equal(options.validateOnly, true)
})

it('rejects unsupported system appearances', () =>
{
  assert.throws(
    () => parseShowcaseCliArgs(['--appearance', 'sepia']),
    /Unsupported appearance 'sepia'/u,
  )
})

it('plans only scenes supported by each selected device', () =>
{
  const options = parseShowcaseCliArgs(['--platform', 'ios', '--scene', 'review'])
  const captures = planShowcaseCaptures(config, options)
  assert.deepStrictEqual(
    captures.map((capture) => ({
      id: capture.device.id,
      appearance: capture.appearance,
      scenes: capture.scenes,
    })),
    [{ id: 'phone', appearance: 'dark', scenes: ['review'] }],
  )
})

it('expands both appearances into independent upload-ready directories', () =>
{
  const options = parseShowcaseCliArgs(['--device', 'phone', '--appearance', 'both'])
  const captures = planShowcaseCaptures(config, options)

  assert.deepStrictEqual(
    captures.map((capture) => ({
      appearance: capture.appearance,
      directory: showcaseCaptureDirectory('/captures', capture),
    })),
    [
      { appearance: 'light', directory: '/captures/apple/iphone-test/light' },
      { appearance: 'dark', directory: '/captures/apple/iphone-test/dark' },
    ],
  )
})

it('rejects unknown devices instead of silently capturing another target', () =>
{
  const options = parseShowcaseCliArgs(['--device', 'missing'])
  assert.throws(() => planShowcaseCaptures(config, options), /Unknown device 'missing'/u)
})

it('reads captured PNG dimensions from the IHDR header', () =>
{
  const bytes = new Uint8Array(26)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, 1320)
  view.setUint32(20, 2868)
  view.setUint8(24, 8)
  view.setUint8(25, 2)
  assert.deepStrictEqual(readPngDimensions(bytes), { width: 1320, height: 2868 })
  assert.deepStrictEqual(readPngMetadata(bytes), {
    width: 1320,
    height: 2868,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  })
})

function rgbaPng(width: number, height: number): Buffer
{
  const png = new PNG({ width, height })
  png.data.fill(255)
  return PNG.sync.write(png)
}

it('converts simulator RGBA captures to upload-safe 24-bit RGB PNGs', () =>
{
  const normalized = normalizeStorePng(rgbaPng(2, 3))
  assert.deepStrictEqual(readPngMetadata(normalized), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  })
})

it('validates exact Apple upload assets', () =>
{
  const apple = normalizeStorePng(rgbaPng(appleSpec.width, appleSpec.height))
  assert.equal(validateStoreAsset(appleSpec, apple).width, 1284)
})

it('rejects wrong dimensions and alpha-bearing PNGs', () =>
{
  const wrongSize = normalizeStorePng(rgbaPng(1242, 2688))
  assert.throws(() => validateStoreAsset(appleSpec, wrongSize), /requires 1284×2778/u)
  assert.throws(() => validateStoreAsset(appleSpec, rgbaPng(1284, 2778)), /without alpha/u)
})

it('enforces store screenshot count limits', () =>
{
  assert.doesNotThrow(() => validateStoreAssetCount(appleSpec, 5, true))
  assert.throws(() => validateStoreAssetCount(appleSpec, 0, true), /requires at least 1/u)
  assert.throws(() => validateStoreAssetCount(appleSpec, 11, false), /allows at most 10/u)
})

it('configures every default device with an exact upload-ready store target', () =>
{
  assert.deepStrictEqual(
    showcaseConfig.devices.map((device) => [
      device.id,
      device.storeAsset.directory,
      device.storeAsset.width,
      device.storeAsset.height,
    ]),
    [
      ['iphone-6.9', 'apple/iphone-6.9', 1320, 2868],
      ['iphone-6.5', 'apple/iphone-6.5', 1284, 2778],
      ['ipad-13', 'apple/ipad-13', 2064, 2752],
    ],
  )
})

it('selects a reachable LAN IPv4 address', () =>
{
  assert.equal(
    selectLanIpv4Address([
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '169.254.2.4', family: 'IPv4', internal: false },
      { address: '192.168.1.80', family: 'IPv4', internal: false },
    ]),
    '192.168.1.80',
  )
})

it('reads multiline JSON from the pairing CLI', () =>
{
  assert.equal(
    parsePairingCredentialOutput('server log\n{\n  "credential": "PAIR-ME"\n}\n'),
    'PAIR-ME',
  )
})
