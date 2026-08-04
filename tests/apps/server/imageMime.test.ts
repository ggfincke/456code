import { describe, expect, it } from 'vite-plus/test'

import { inferImageExtension, parseBase64DataUrl } from '../../../apps/server/src/imageMime.ts'

describe('imageMime', () =>
{
  it('parses representative base64 data URLs', () =>
  {
    expect(parseBase64DataUrl('data:image/png;charset=utf-8;base64,SGVs bG8=\n')).toEqual({
      mimeType: 'image/png',
      base64: 'SGVsbG8=',
    })
    expect(parseBase64DataUrl('DATA:IMAGE/PNG;BASE64,SGVsbA==')).toEqual({
      mimeType: 'image/png',
      base64: 'SGVsbA==',
    })
  })

  it.each([
    'data:image/png;charset=utf-8,hello',
    'data:;base64,SGVsbG8=',
    'data:image/png;base64,SGVs!bG8=',
    'data:image/png;base64,SGV=bG8=',
    'data:image/png;base64,SGVsbG8',
    'data:image/png;base64,',
  ])('rejects malformed data URL %s', (input) =>
  {
    expect(parseBase64DataUrl(input)).toBeNull()
  })

  it('parses a multi-megabyte payload from a deep call stack', () =>
  {
    // Regression: matching the payload with a regex borrowed the JS call
    // stack, so a ~10 MB image parsed inside fiber execution threw
    // "RangeError: Maximum call stack size exceeded".
    const dataUrl = `data:image/png;base64,${'A'.repeat(14_000_000)}`
    const atDepth = (depth: number): ReturnType<typeof parseBase64DataUrl> =>
      depth === 0 ? parseBase64DataUrl(dataUrl) : atDepth(depth - 1)
    const findMaxDepth = (depth: number): number =>
    {
      try
      {
        return findMaxDepth(depth + 1)
      }
      catch
      {
        return depth
      }
    }
    const result = atDepth(Math.floor(findMaxDepth(0) * 0.85))
    expect(result?.mimeType).toBe('image/png')
    expect(result?.base64.length).toBe(14_000_000)
  })

  it('does not read inherited keys from mime extension map', () =>
  {
    expect(inferImageExtension({ mimeType: 'constructor' })).toBe('.bin')
  })
})
