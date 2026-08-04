// apps/web/src/lib/imageCompression.ts
// compresses image attachments for stash and provider byte budgets

// keeps typical retina screenshots legible after re-encoding
const MAX_DIMENSION = 2048
// allows about 975kb of binary data per stashed image
export const MAX_STASH_IMAGE_DATA_URL_CHARS = 1_300_000
// avoid decoding source files large enough to exhaust the tab
export const MAX_COMPRESSIBLE_SOURCE_BYTES = 50 * 1024 * 1024
// reduce quality before resolution to preserve readable ui screenshots
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const
// reduces resolution when the quality floor still exceeds the budget
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const

export interface CompressedStashImage
{
  dataUrl: string
  mimeType: string
  sizeBytes: number
  // distinguishes re-encoded payloads from verbatim storage
  recompressed: boolean
}

// distinguish budget failures from decode failures for caller messaging
export type ImageCompressionFailureReason = 'too-large' | 'unreadable'

export type CompressStashImageResult =
  { ok: true; image: CompressedStashImage } | { ok: false; reason: ImageCompressionFailureReason }

export type CompressImageFileResult =
  | { ok: true; file: File; recompressed: boolean }
  | { ok: false; reason: ImageCompressionFailureReason }

// chunks input to stay below the fromcharcode argument limit
const BASE64_CHUNK_SIZE = 0x8000

function bytesToBase64(bytes: Uint8Array): string
{
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE)
  {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE))
  }
  return btoa(binary)
}

// uses arraybuffer so blob conversion also works in non-dom test runners
async function blobToDataUrl(blob: File | Blob, mimeTypeOverride?: string): Promise<string>
{
  const buffer = await blob.arrayBuffer()
  const mimeType = mimeTypeOverride || blob.type || 'application/octet-stream'
  return `data:${mimeType};base64,${bytesToBase64(new Uint8Array(buffer))}`
}

// approximates decoded bytes from a base64 data url
function dataUrlByteLength(dataUrl: string): number
{
  const commaIndex = dataUrl.indexOf(',')
  const payload = commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

// decode a base64 data url into a file
function dataUrlToFile(dataUrl: string, name: string, mimeType: string): File
{
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1)
  {
    bytes[index] = binary.charCodeAt(index)
  }
  return new File([bytes], name, { type: mimeType })
}

// keep the file extension aligned with its re-encoded container
function fileNameForMimeType(name: string, mimeType: string): string
{
  const extension = mimeType === 'image/webp' ? '.webp' : '.jpg'
  const dotIndex = name.lastIndexOf('.')
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name
  return `${base}${extension}`
}

function canRecompress(): boolean
{
  return (
    typeof createImageBitmap === 'function' &&
    (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined')
  )
}

interface Canvas2D
{
  canvas: OffscreenCanvas | HTMLCanvasElement
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
}

function createCanvas(width: number, height: number): Canvas2D | null
{
  if (typeof OffscreenCanvas === 'function')
  {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return null
    return { canvas, context }
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  return { canvas, context }
}

// prefers webp for smaller transparent output and falls back to jpeg
async function encodeToDataUrl(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
  mimeType: string,
): Promise<{ dataUrl: string; mimeType: string } | null>
{
  if (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement)
  {
    const dataUrl = canvas.toDataURL(mimeType, quality)
    // unsupported encoders silently return png
    if (!dataUrl.startsWith(`data:${mimeType}`)) return null
    return { dataUrl, mimeType }
  }
  const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: mimeType, quality })
  if (blob.type && blob.type !== mimeType) return null
  return { dataUrl: await blobToDataUrl(blob, mimeType), mimeType }
}

// scales and encodes a bitmap until it fits the storage budget
async function encodeWithinBudget(
  bitmap: ImageBitmap,
  maxDimension: number,
  budgetChars: number,
): Promise<{ dataUrl: string; mimeType: string } | null>
{
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const target = createCanvas(width, height)
  if (!target) return null

  // probe webp before drawing because jpeg needs a white matte
  const probe = await encodeToDataUrl(target.canvas, QUALITY_STEPS[0], 'image/webp')
  const mimeType = probe ? 'image/webp' : 'image/jpeg'

  if (mimeType === 'image/jpeg')
  {
    target.context.fillStyle = '#ffffff'
    target.context.fillRect(0, 0, width, height)
  }
  target.context.drawImage(bitmap, 0, 0, width, height)

  let smallest: { dataUrl: string; mimeType: string } | null = null
  for (const quality of QUALITY_STEPS)
  {
    const encoded = await encodeToDataUrl(target.canvas, quality, mimeType)
    if (!encoded) break
    if (smallest === null || encoded.dataUrl.length < smallest.dataUrl.length)
    {
      smallest = encoded
    }
    if (encoded.dataUrl.length <= budgetChars)
    {
      return encoded
    }
  }
  return smallest
}

type ReencodeResult =
  | { ok: true; dataUrl: string; mimeType: string }
  | { ok: false; reason: ImageCompressionFailureReason }

// decode once and try each quality and resolution step against the budget
async function reencodeWithinBudget(file: File, budgetChars: number): Promise<ReencodeResult>
{
  if (!canRecompress())
  {
    return { ok: false, reason: 'too-large' }
  }

  let bitmap: ImageBitmap
  try
  {
    bitmap = await createImageBitmap(file)
  }
  catch
  {
    return { ok: false, reason: 'unreadable' }
  }

  try
  {
    // each fallback pass shrinks relative to the bounded source dimension
    const baseDimension = Math.min(MAX_DIMENSION, Math.max(bitmap.width, bitmap.height))
    // distinguishes encoder failures from valid output that remains too large
    let encodeFailed = false
    for (const dimensionScale of [1, ...FALLBACK_SCALE_STEPS])
    {
      const targetDimension = Math.max(1, Math.round(baseDimension * dimensionScale))
      let encoded: { dataUrl: string; mimeType: string } | null
      try
      {
        encoded = await encodeWithinBudget(bitmap, targetDimension, budgetChars)
      }
      catch
      {
        // smaller fallback scales may recover from canvas or codec allocation failures
        encodeFailed = true
        continue
      }
      encodeFailed = false
      if (encoded && encoded.dataUrl.length <= budgetChars)
      {
        return { ok: true, dataUrl: encoded.dataUrl, mimeType: encoded.mimeType }
      }
    }
    return { ok: false, reason: encodeFailed ? 'unreadable' : 'too-large' }
  }
  finally
  {
    bitmap.close()
  }
}

// preserve small stash images and re-encode only when storage requires it
export async function compressImageForStash(
  file: File,
  budgetChars: number = MAX_STASH_IMAGE_DATA_URL_CHARS,
): Promise<CompressStashImageResult>
{
  let originalDataUrl: string
  try
  {
    originalDataUrl = await blobToDataUrl(file)
  }
  catch
  {
    return { ok: false, reason: 'unreadable' }
  }
  if (originalDataUrl.length <= budgetChars)
  {
    return {
      ok: true,
      image: {
        dataUrl: originalDataUrl,
        mimeType: file.type,
        sizeBytes: file.size,
        recompressed: false,
      },
    }
  }
  const reencoded = await reencodeWithinBudget(file, budgetChars)
  if (!reencoded.ok)
  {
    return reencoded
  }
  return {
    ok: true,
    image: {
      dataUrl: reencoded.dataUrl,
      mimeType: reencoded.mimeType,
      sizeBytes: dataUrlByteLength(reencoded.dataUrl),
      recompressed: true,
    },
  }
}

// pass through small files and re-encode safe oversized sources to the byte cap
export async function compressImageToByteLimit(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult>
{
  if (file.size <= maxBytes)
  {
    return { ok: true, file, recompressed: false }
  }
  if (file.size > MAX_COMPRESSIBLE_SOURCE_BYTES)
  {
    return { ok: false, reason: 'too-large' }
  }
  // base64 expands three bytes to four chars; floor for a conservative cap
  const budgetChars = Math.floor(maxBytes / 3) * 4
  const reencoded = await reencodeWithinBudget(file, budgetChars)
  if (!reencoded.ok)
  {
    return reencoded
  }
  return {
    ok: true,
    file: dataUrlToFile(
      reencoded.dataUrl,
      fileNameForMimeType(file.name || 'image', reencoded.mimeType),
      reencoded.mimeType,
    ),
    recompressed: true,
  }
}
