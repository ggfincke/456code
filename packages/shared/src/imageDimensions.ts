// packages/shared/src/imageDimensions.ts
// read bounded image headers without decoding pixel data

/**
 * Reads pixel dimensions from the header bytes of a PNG, JPEG, GIF, or WebP
 * file so a client can reserve its box before the bytes arrive. Unsupported,
 * malformed, truncated, or oversized headers yield null. This is a bounded
 * layout hint reader, not validation of the complete image or its pixel data.
 */
export interface ImageDimensions
{
  readonly width: number
  readonly height: number
}

// jpeg frame headers can follow several 64 kib metadata segments; stop after this bound
export const IMAGE_DIMENSIONS_HEADER_BYTES = 256 * 1024

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null
{
  const header = bytes.subarray(0, IMAGE_DIMENSIONS_HEADER_BYTES)
  const dimensions = readPng(header) ?? readGif(header) ?? readWebp(header) ?? readJpeg(header)
  // larger images remain usable; omit their speculative layout hint until the client decodes them
  return dimensions &&
    Number.isSafeInteger(dimensions.width) &&
    Number.isSafeInteger(dimensions.height) &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width <= 32_768 &&
    dimensions.height <= 32_768 &&
    dimensions.width * dimensions.height <= 100_000_000
    ? dimensions
    : null
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

function readPng(bytes: Uint8Array): ImageDimensions | null
{
  if (bytes.length < 33) return null
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  )
  {
    return null
  }
  const data = view(bytes)
  if (data.getUint32(8) !== 13) return null
  return { width: data.getUint32(16), height: data.getUint32(20) }
}

function readGif(bytes: Uint8Array): ImageDimensions | null
{
  if (bytes.length < 13) return null
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null
  const data = view(bytes)
  return { width: data.getUint16(6, true), height: data.getUint16(8, true) }
}

function readWebp(bytes: Uint8Array): ImageDimensions | null
{
  if (bytes.length < 20) return null
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  )
  {
    return null
  }
  const data = view(bytes)
  const chunkSize = data.getUint32(16, true)
  if (data.getUint32(4, true) < 12 + chunkSize + (chunkSize & 1)) return null
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  switch (chunk)
  {
    case 'VP8 ':
      if (
        bytes.length < 30 ||
        chunkSize < 10 ||
        (bytes[20]! & 1) !== 0 ||
        bytes[23] !== 0x9d ||
        bytes[24] !== 0x01 ||
        bytes[25] !== 0x2a
      )
        return null
      // lossy: 14-bit dimensions after the 3-byte frame tag and 3-byte start code.
      return {
        width: data.getUint16(26, true) & 0x3fff,
        height: data.getUint16(28, true) & 0x3fff,
      }
    case 'VP8L':
    {
      if (bytes.length < 25 || chunkSize < 5 || bytes[20] !== 0x2f) return null
      // lossless: width-1 in bits 0-13 and height-1 in bits 14-27 of the
      // 32 bits after the signature byte.
      const packed = data.getUint32(21, true)
      if (packed >>> 29 !== 0) return null
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
    }
    case 'VP8X':
      if (bytes.length < 30 || chunkSize !== 10) return null
      // extended: 24-bit canvas dimensions minus one.
      return {
        width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1,
        height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1,
      }
    default:
      return null
  }
}

function readJpeg(bytes: Uint8Array): ImageDimensions | null
{
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const data = view(bytes)
  let offset = 2
  let rotated = false
  while (offset + 9 <= bytes.length)
  {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    // padding bytes between segments.
    if (marker === 0xff)
    {
      offset += 1
      continue
    }
    // start-of-frame markers carry the dimensions; skip the arithmetic-coding
    // and Huffman-table markers that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
    {
      const length = data.getUint16(offset + 2)
      if (offset + 10 > bytes.length || length < 8 || offset + 2 + length > bytes.length)
        return null
      const components = bytes[offset + 9]!
      if (components === 0 || length !== 8 + 3 * components) return null
      const height = data.getUint16(offset + 5)
      const width = data.getUint16(offset + 7)
      return rotated ? { width: height, height: width } : { width, height }
    }
    if (marker === 0xd9 || marker === 0xda) return null
    // tEM and the restart markers stand alone, with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
    {
      offset += 2
      continue
    }
    const length = data.getUint16(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) return null
    // viewers apply the EXIF orientation before display, so a phone photo
    // stored on its side takes the swapped size on screen.
    if (marker === 0xe1 && !rotated)
    {
      rotated = exifOrientationSwapsAxes(bytes, offset + 4, offset + 2 + length)
    }
    offset += 2 + length
  }
  return null
}

// exif orientations 5-8 swap axes; start identifies the app1 payload
function exifOrientationSwapsAxes(bytes: Uint8Array, start: number, end: number): boolean
{
  end = Math.min(end, bytes.length)
  // "Exif\0\0" then a TIFF header: byte order, 0x2a, and the IFD0 offset.
  if (
    end - start < 14 ||
    String.fromCharCode(...bytes.subarray(start, start + 4)) !== 'Exif' ||
    bytes[start + 4] !== 0 ||
    bytes[start + 5] !== 0
  )
  {
    return false
  }
  const tiff = start + 6
  const data = view(bytes)
  const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
  if (!littleEndian && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return false
  if (data.getUint16(tiff + 2, littleEndian) !== 42) return false
  const ifd = tiff + data.getUint32(tiff + 4, littleEndian)
  if (ifd + 2 > end) return false
  const entries = data.getUint16(ifd, littleEndian)
  for (let i = 0; i < entries; i += 1)
  {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return false
    if (data.getUint16(entry, littleEndian) === 0x0112)
    {
      const orientation = data.getUint16(entry + 8, littleEndian)
      return orientation >= 5 && orientation <= 8
    }
  }
  return false
}
