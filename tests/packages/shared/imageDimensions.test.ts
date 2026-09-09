// tests/packages/shared/imageDimensions.test.ts
// verify bounded metadata decoding and malformed-header fallback

import { describe, expect, it } from 'vite-plus/test'
import { readImageDimensions } from '@t3tools/shared/imageDimensions'

describe('readImageDimensions', () =>
{
  it('reads common header shapes without decoding pixels and rejects truncated or zero sizes', () =>
  {
    const png = new Uint8Array(33)
    png.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
    png.set([0x49, 0x48, 0x44, 0x52], 12)
    const view = new DataView(png.buffer)
    view.setUint32(8, 13)
    view.setUint32(16, 480)
    view.setUint32(20, 180)
    expect(readImageDimensions(png)).toEqual({ width: 480, height: 180 })
    expect(readImageDimensions(png.subarray(0, 23))).toBeNull()
    view.setUint32(16, 0)
    expect(readImageDimensions(png)).toBeNull()
    const gif = Uint8Array.from([71, 73, 70, 56, 57, 97, 32, 3, 88, 2, 0, 0, 0])
    expect(readImageDimensions(gif)).toEqual({ width: 800, height: 600 })
    const jpeg = Uint8Array.from([255, 216, 255, 192, 0, 11, 8, 1, 44, 2, 88, 1, 1, 17, 0])
    expect(readImageDimensions(jpeg)).toEqual({ width: 600, height: 300 })
    expect(
      readImageDimensions(Uint8Array.from([255, 216, 255, 225, 0, 1, 0, 0, 0, 0, 0])),
    ).toBeNull()
    expect(
      readImageDimensions(new TextEncoder().encode('<svg width="800" height="600"/>')),
    ).toBeNull()
  })

  it('omits forged signatures, undersized chunks, and extreme layout hints', () =>
  {
    const png = new Uint8Array(33)
    png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    const data = new DataView(png.buffer)
    data.setUint32(16, 480)
    data.setUint32(20, 180)
    expect(readImageDimensions(png)).toEqual({ width: 480, height: 180 })
    png[7] = 0
    expect(readImageDimensions(png)).toBeNull()
    png[7] = 10
    data.setUint32(16, 0xffff_ffff)
    expect(readImageDimensions(png)).toBeNull()
    expect(readImageDimensions(new TextEncoder().encode('GIF8xx1234567'))).toBeNull()

    const webp = new Uint8Array(30)
    webp.set(new TextEncoder().encode('RIFF'), 0)
    webp.set(new TextEncoder().encode('WEBPVP8 '), 8)
    const webpData = new DataView(webp.buffer)
    webpData.setUint32(4, 22, true)
    webpData.setUint32(16, 10, true)
    webpData.setUint16(26, 480, true)
    webpData.setUint16(28, 180, true)
    expect(readImageDimensions(webp)).toBeNull()
    webp.set([0x9d, 0x01, 0x2a], 23)
    expect(readImageDimensions(webp)).toEqual({ width: 480, height: 180 })
    webpData.setUint32(16, 1, true)
    expect(readImageDimensions(webp)).toBeNull()
    webp.set(new TextEncoder().encode('VP8L'), 12)
    webpData.setUint32(16, 5, true)
    expect(readImageDimensions(webp)).toBeNull()
  })
})
