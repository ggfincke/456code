// tests/packages/shared/previewViewport.test.ts
// verify preview viewport behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  PREVIEW_VIEWPORT_PRESETS,
  previewViewportLabel,
  previewViewportPresetOrientation,
  resolvePreviewViewport,
} from '../../../packages/shared/src/previewViewport.ts'

describe('previewViewport', () =>
{
  it('resolves fill and exact freeform viewports', () =>
  {
    expect(resolvePreviewViewport({ mode: 'fill' })).toEqual({ _tag: 'fill' })
    expect(resolvePreviewViewport({ mode: 'freeform', width: 1024, height: 768 })).toEqual({
      _tag: 'freeform',
      width: 1024,
      height: 768,
    })
  })

  it('resolves device presets in either orientation', () =>
  {
    expect(resolvePreviewViewport({ mode: 'preset', preset: 'iphone-12-pro' })).toEqual({
      _tag: 'preset',
      width: 390,
      height: 844,
      presetId: 'iphone-12-pro',
    })
    expect(
      resolvePreviewViewport({
        mode: 'preset',
        preset: 'iphone-12-pro',
        orientation: 'landscape',
      }),
    ).toEqual({
      _tag: 'preset',
      width: 844,
      height: 390,
      presetId: 'iphone-12-pro',
    })
  })

  it('keeps the Chrome standard device catalog endpoints in order', () =>
  {
    expect(PREVIEW_VIEWPORT_PRESETS).toHaveLength(17)
    expect(PREVIEW_VIEWPORT_PRESETS[0]).toMatchObject({ id: 'iphone-se', label: 'iPhone SE' })
    expect(PREVIEW_VIEWPORT_PRESETS.at(-1)).toMatchObject({
      id: 'nest-hub-max',
      label: 'Nest Hub Max',
    })
  })

  it('formats settings for compact UI', () =>
  {
    expect(previewViewportLabel({ _tag: 'fill' })).toBe('Fill panel')
    expect(previewViewportLabel({ _tag: 'freeform', width: 393, height: 852 })).toBe('393 × 852')
    expect(previewViewportPresetOrientation({ _tag: 'freeform', width: 852, height: 393 })).toBe(
      'landscape',
    )
  })
})
