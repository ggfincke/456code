// tests/apps/web/lib/imageCompression.test.ts
// verifies image compression budgets and fallbacks

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  compressImageForStash,
  compressImageToByteLimit,
  isHeicImageFile,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  MAX_STASH_IMAGE_DATA_URL_CHARS,
  prepareImageForAttachment,
} from '../../../../apps/web/src/lib/imageCompression'

const mocks = vi.hoisted(() => ({
  heicTo: vi.fn(),
}))

vi.mock('heic-to/csp', () => ({
  heicTo: mocks.heicTo,
}))

// stubbed canvas output exercises budgets without a native codec

const originalCreateImageBitmap = globalThis.createImageBitmap
const originalOffscreenCanvas = globalThis.OffscreenCanvas

function makeFile(sizeBytes: number, type = 'image/png'): File
{
  return new File([new Uint8Array(sizeBytes).fill(7)], 'shot.png', { type })
}

function makeHeicFile(options?: {
  name?: string
  type?: string
  width?: number
  height?: number
  lastModified?: number
  brand?: string
}): File
{
  const encoder = new TextEncoder()
  const makeBox = (name: string, ...contents: Uint8Array[]): Uint8Array =>
  {
    const contentSize = contents.reduce((size, content) => size + content.length, 0)
    const bytes = new Uint8Array(8 + contentSize)
    new DataView(bytes.buffer).setUint32(0, bytes.length)
    bytes.set(encoder.encode(name), 4)
    let offset = 8
    for (const content of contents)
    {
      bytes.set(content, offset)
      offset += content.length
    }
    return bytes
  }

  const dimensions = new Uint8Array(12)
  const view = new DataView(dimensions.buffer)
  view.setUint32(4, options?.width ?? 4000)
  view.setUint32(8, options?.height ?? 3000)
  const properties = makeBox('iprp', makeBox('ipco', makeBox('ispe', dimensions)))
  const brand = encoder.encode(options?.brand ?? 'heic')
  const fileType = makeBox('ftyp', brand, new Uint8Array(4))
  const metadata = makeBox('meta', new Uint8Array(4), properties)

  return new File(
    [fileType.buffer as ArrayBuffer, metadata.buffer as ArrayBuffer],
    options?.name ?? 'photo.heic',
    {
      type: options?.type ?? 'image/heic',
      ...(options?.lastModified === undefined ? {} : { lastModified: options.lastModified }),
    },
  )
}

// stubs bitmap and canvas output sizes without a native codec
function stubCanvasPipeline(
  sizeForQuality: (quality: number) => number,
  options?: { supportsWebp?: boolean },
)
{
  const supportsWebp = options?.supportsWebp ?? true
  const close = vi.fn()
  const fillRect = vi.fn()
  const candidateArrayBuffer = vi.fn()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 4000, height: 3000, close })),
  )
  vi.stubGlobal(
    'OffscreenCanvas',
    class
    {
      constructor(
        public width: number,
        public height: number,
      )
      {}
      getContext()
      {
        return {
          fillStyle: '',
          fillRect,
          drawImage: vi.fn(),
        }
      }
      async convertToBlob({ type, quality }: { type: string; quality: number })
      {
        const resolvedType = type === 'image/webp' && !supportsWebp ? 'image/png' : type
        const blob = new Blob([new Uint8Array(sizeForQuality(quality))], { type: resolvedType })
        const originalArrayBuffer = blob.arrayBuffer.bind(blob)
        vi.spyOn(blob, 'arrayBuffer').mockImplementation(async () =>
        {
          candidateArrayBuffer()
          return originalArrayBuffer()
        })
        return blob
      }
    },
  )
  return { candidateArrayBuffer, close, fillRect }
}

afterEach(() =>
{
  mocks.heicTo.mockReset()
  vi.unstubAllGlobals()
  globalThis.createImageBitmap = originalCreateImageBitmap
  globalThis.OffscreenCanvas = originalOffscreenCanvas
})

describe('compressImageForStash', () =>
{
  it('stores a small image verbatim without re-encoding', async () =>
  {
    const bitmapSpy = vi.fn()
    vi.stubGlobal('createImageBitmap', bitmapSpy)

    const result = await compressImageForStash(makeFile(1024))

    expect(result.ok).toBe(true)
    expect(result.ok && result.image.recompressed).toBe(false)
    expect(result.ok && result.image.mimeType).toBe('image/png')
    expect(result.ok && result.image.dataUrl.startsWith('data:image/png')).toBe(true)
    // untouched payloads must not pay for a decode
    expect(bitmapSpy).not.toHaveBeenCalled()
  })

  it('re-encodes an oversized image to WebP within the budget', async () =>
  {
    // the first quality step is under budget
    const { close, fillRect } = stubCanvasPipeline(() => 120_000)

    const result = await compressImageForStash(makeFile(4_000_000))

    expect(result.ok).toBe(true)
    expect(result.ok && result.image.recompressed).toBe(true)
    expect(result.ok && result.image.mimeType).toBe('image/webp')
    expect(result.ok && result.image.dataUrl.length <= MAX_STASH_IMAGE_DATA_URL_CHARS).toBe(true)
    // sizebytes describes the encoded payload rather than the original
    expect(result.ok && result.image.sizeBytes).toBeLessThan(4_000_000)
    // webp keeps alpha without a white matte
    expect(fillRect).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('falls back to JPEG with a white matte when WebP encoding is unavailable', async () =>
  {
    const { fillRect } = stubCanvasPipeline(() => 120_000, { supportsWebp: false })

    const result = await compressImageForStash(makeFile(4_000_000))

    expect(result.ok && result.image.recompressed).toBe(true)
    expect(result.ok && result.image.mimeType).toBe('image/jpeg')
    // jpeg needs a white matte for transparent regions
    expect(fillRect).toHaveBeenCalled()
  })

  it('steps quality down until the encoded image fits', async () =>
  {
    // only the lowest quality step fits the budget
    const { close } = stubCanvasPipeline((quality) => (quality <= 0.68 ? 400_000 : 3_000_000))

    const result = await compressImageForStash(makeFile(9_000_000))

    expect(result.ok && result.image.recompressed).toBe(true)
    expect(result.ok && result.image.dataUrl.length <= MAX_STASH_IMAGE_DATA_URL_CHARS).toBe(true)
    expect(close).toHaveBeenCalled()
  })

  it('reports too-large when even the smallest encoding overflows the budget', async () =>
  {
    const { candidateArrayBuffer, close } = stubCanvasPipeline(() => 8_000_000)

    const result = await compressImageForStash(makeFile(9_000_000))

    expect(result).toEqual({ ok: false, reason: 'too-large' })
    // reject oversized candidates before allocating base64 payloads
    expect(candidateArrayBuffer).not.toHaveBeenCalled()
    // the give-up path still releases the bitmap
    expect(close).toHaveBeenCalled()
  })

  it('reports too-large for an oversized image when the browser cannot re-encode', async () =>
  {
    vi.stubGlobal('createImageBitmap', undefined)
    vi.stubGlobal('OffscreenCanvas', undefined)

    expect(await compressImageForStash(makeFile(4_000_000))).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })

  it('reports unreadable when the image fails to decode', async () =>
  {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () =>
      {
        throw new Error('corrupt image')
      }),
    )
    vi.stubGlobal(
      'OffscreenCanvas',
      class
      {
        getContext()
        {
          return null
        }
      },
    )

    expect(await compressImageForStash(makeFile(4_000_000))).toEqual({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('compressImageToByteLimit passes small files through byte-for-byte', async () =>
  {
    const bitmapSpy = vi.fn()
    vi.stubGlobal('createImageBitmap', bitmapSpy)

    const original = makeFile(1024)
    const result = await compressImageToByteLimit(original, 10 * 1024 * 1024)

    expect(result.ok).toBe(true)
    expect(result.ok && result.recompressed).toBe(false)
    // pass-through keeps the same file object
    expect(result.ok && result.file).toBe(original)
    expect(bitmapSpy).not.toHaveBeenCalled()
  })

  it('compressImageToByteLimit re-encodes an oversized file under the byte cap', async () =>
  {
    stubCanvasPipeline(() => 200_000)

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000)

    expect(result.ok).toBe(true)
    expect(result.ok && result.recompressed).toBe(true)
    expect(result.ok && result.file.type).toBe('image/webp')
    // the re-encoded name matches the new container
    expect(result.ok && result.file.name).toBe('shot.webp')
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000)
  })

  it('compressImageToByteLimit refuses sources above the decode-safety ceiling', async () =>
  {
    const bitmapSpy = vi.fn()
    vi.stubGlobal('createImageBitmap', bitmapSpy)

    const result = await compressImageToByteLimit(
      makeFile(MAX_COMPRESSIBLE_SOURCE_BYTES + 1),
      10 * 1024 * 1024,
    )

    expect(result).toEqual({ ok: false, reason: 'too-large' })
    // the ceiling prevents decoding unsafe source sizes
    expect(bitmapSpy).not.toHaveBeenCalled()
  })

  it('compressImageToByteLimit reports too-large when no encoding fits', async () =>
  {
    const { close } = stubCanvasPipeline(() => 3_000_000)

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000)

    expect(result).toEqual({ ok: false, reason: 'too-large' })
    expect(close).toHaveBeenCalled()
  })

  it('shrinks below the source size when the image is already under MAX_DIMENSION', async () =>
  {
    // a small but dense source only fits after a real downscale
    let smallestRequested = Number.POSITIVE_INFINITY
    const close = vi.fn()
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 800, height: 600, close })),
    )
    vi.stubGlobal(
      'OffscreenCanvas',
      class
      {
        constructor(
          public width: number,
          public height: number,
        )
        {
          smallestRequested = Math.min(smallestRequested, width)
        }
        getContext()
        {
          return { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
        }
        async convertToBlob({ type }: { type: string; quality: number })
        {
          // only a genuinely downscaled pass fits
          const size = smallestRequested < 800 ? 100_000 : 5_000_000
          return new Blob([new Uint8Array(size)], { type })
        }
      },
    )

    const result = await compressImageForStash(makeFile(4_000_000))

    expect(result.ok).toBe(true)
    // fallback passes scale from the bitmap rather than a fixed ceiling
    expect(smallestRequested).toBeLessThan(800)
  })
})

describe('HEIC attachment preparation', () =>
{
  it('recognizes only supported HEIC and HEIF mime or generic extension combinations', () =>
  {
    expect(isHeicImageFile({ name: 'photo.bin', type: 'image/heic' })).toBe(true)
    expect(isHeicImageFile({ name: 'photo.bin', type: 'image/heif' })).toBe(true)
    expect(isHeicImageFile({ name: 'IMG_1234.HEIC', type: '' })).toBe(true)
    expect(isHeicImageFile({ name: 'photo.heif', type: 'application/octet-stream' })).toBe(true)
    expect(isHeicImageFile({ name: 'photo.heic', type: 'image/heic-sequence' })).toBe(false)
    expect(isHeicImageFile({ name: 'photo.heic', type: 'image/png' })).toBe(false)
  })

  it('converts one HEIC photo to a named JPEG with its original modification time', async () =>
  {
    const original = makeHeicFile({ name: 'IMG_1234.HEIC', type: '', lastModified: 123 })
    mocks.heicTo.mockResolvedValueOnce(
      new Blob([new Uint8Array([4, 5, 6, 7])], { type: 'image/jpeg' }),
    )

    const result = await prepareImageForAttachment(original, 1024)

    expect(mocks.heicTo).toHaveBeenCalledWith({
      blob: original,
      type: 'image/jpeg',
      quality: 0.92,
    })
    expect(result.ok && result.file.name).toBe('IMG_1234.jpg')
    expect(result.ok && result.file.type).toBe('image/jpeg')
    expect(result.ok && result.file.size).toBe(4)
    expect(result.ok && result.file.lastModified).toBe(123)
    expect(result.ok && result.recompressed).toBe(true)
  })

  it('keeps an oversized converted photo as JPEG while shrinking it', async () =>
  {
    const original = makeHeicFile({ name: 'photo.heif', type: 'image/heif', lastModified: 456 })
    mocks.heicTo.mockResolvedValueOnce(
      new Blob([new Uint8Array(2_000_000)], { type: 'image/jpeg' }),
    )
    const { fillRect } = stubCanvasPipeline(() => 200_000)

    const result = await prepareImageForAttachment(original, 1_000_000)

    expect(result.ok && result.file.name).toBe('photo.jpg')
    expect(result.ok && result.file.type).toBe('image/jpeg')
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000)
    expect(result.ok && result.file.lastModified).toBe(456)
    expect(fillRect).toHaveBeenCalled()
  })

  it('uses original HEIC size for safety when its JPEG intermediate expands', async () =>
  {
    const original = makeHeicFile()
    mocks.heicTo.mockResolvedValueOnce(
      new Blob([new Uint8Array(MAX_COMPRESSIBLE_SOURCE_BYTES + 1)], { type: 'image/jpeg' }),
    )
    const { close } = stubCanvasPipeline(() => 200_000)

    const result = await prepareImageForAttachment(original, 1_000_000)

    expect(result.ok && result.file.type).toBe('image/jpeg')
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000)
    expect(close).toHaveBeenCalled()
  })

  it.each([
    { label: '24 MP', width: 5712, height: 4284 },
    { label: '48 MP', width: 8064, height: 6048 },
  ])('accepts $label HEIC photos', async ({ width, height }) =>
  {
    const original = makeHeicFile({ width, height })
    mocks.heicTo.mockResolvedValueOnce(new Blob(['jpeg'], { type: 'image/jpeg' }))

    const result = await prepareImageForAttachment(original, 1024)

    expect(result.ok && result.file.type).toBe('image/jpeg')
    expect(mocks.heicTo).toHaveBeenCalledOnce()
  })

  it('rejects oversized HEIC dimensions before loading the decoder', async () =>
  {
    const original = makeHeicFile({ width: 16_000, height: 4001 })

    expect(await prepareImageForAttachment(original, 1024)).toEqual({
      ok: false,
      reason: 'too-large',
    })
    expect(mocks.heicTo).not.toHaveBeenCalled()
  })

  it('rejects malformed and sequence HEIC metadata before loading the decoder', async () =>
  {
    const malformed = new File([new Uint8Array([1, 2, 3])], 'broken.heic', {
      type: 'image/heic',
    })
    const sequence = makeHeicFile({ brand: 'hevc' })

    expect(await prepareImageForAttachment(malformed, 1024)).toEqual({
      ok: false,
      reason: 'unreadable',
    })
    expect(await prepareImageForAttachment(sequence, 1024)).toEqual({
      ok: false,
      reason: 'unreadable',
    })
    expect(mocks.heicTo).not.toHaveBeenCalled()
  })

  it('requires exactly one non-empty JPEG decoder result', async () =>
  {
    const original = makeHeicFile()
    mocks.heicTo.mockResolvedValueOnce([
      new Blob(['one'], { type: 'image/jpeg' }),
      new Blob(['two'], { type: 'image/jpeg' }),
    ])

    expect(await prepareImageForAttachment(original, 1024)).toEqual({
      ok: false,
      reason: 'unreadable',
    })

    mocks.heicTo.mockResolvedValueOnce(new Blob([], { type: 'image/jpeg' }))
    expect(await prepareImageForAttachment(original, 1024)).toEqual({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('rejects unsafe sources and inspects at most one MiB before decoding', async () =>
  {
    const unsafe = new File(['photo'], 'large.heic', { type: 'image/heic' })
    Object.defineProperty(unsafe, 'size', { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 })
    expect(await prepareImageForAttachment(unsafe, 1024)).toEqual({
      ok: false,
      reason: 'too-large',
    })

    const original = makeHeicFile()
    const slice = vi.spyOn(original, 'slice')
    mocks.heicTo.mockResolvedValueOnce(new Blob(['jpeg'], { type: 'image/jpeg' }))
    await prepareImageForAttachment(original, 1024)

    expect(slice).toHaveBeenCalledWith(0, 1024 * 1024)
    expect(mocks.heicTo).toHaveBeenCalledOnce()
  })

  it('reports decoder failures and preserves ordinary supported images', async () =>
  {
    const broken = makeHeicFile()
    mocks.heicTo.mockRejectedValueOnce(new Error('Invalid HEIC image'))
    expect(await prepareImageForAttachment(broken, 1024)).toEqual({
      ok: false,
      reason: 'unreadable',
    })

    const ordinary = makeFile(1024)
    const result = await prepareImageForAttachment(ordinary, 2048)
    expect(result.ok && result.file).toBe(ordinary)
    expect(result.ok && result.recompressed).toBe(false)
  })
})
