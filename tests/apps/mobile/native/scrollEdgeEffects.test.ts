import { describe, expect, it } from 'vite-plus/test'

import {
  nativeHeaderScrollEdgeEffects,
  nativeTopScrollEdgeEffect,
} from '../../../../apps/mobile/src/native/scrollEdgeEffects'

describe('nativeTopScrollEdgeEffect', () =>
{
  it.each([
    { platform: 'ios', version: '26.5', expected: 'automatic' },
    { platform: 'android', version: 27, expected: 'automatic' },
  ])('uses the automatic native treatment on $platform', ({ platform, version, expected }) =>
  {
    expect(nativeTopScrollEdgeEffect(platform, version)).toBe(expected)
  })
})

describe('nativeHeaderScrollEdgeEffects', () =>
{
  it('keeps non-top header edges hidden while applying the platform top effect', () =>
  {
    expect(nativeHeaderScrollEdgeEffects('ios', '27.0')).toEqual({
      top: 'automatic',
      bottom: 'hidden',
      left: 'hidden',
      right: 'hidden',
    })
  })
})
