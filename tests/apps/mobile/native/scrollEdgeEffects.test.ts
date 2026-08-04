// tests/apps/mobile/native/scrollEdgeEffects.test.ts
// verify native top scroll edge effect behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  nativeHeaderScrollEdgeEffects,
  nativeTopScrollEdgeEffect,
} from '../../../../apps/mobile/src/native/scrollEdgeEffects'

describe('nativeTopScrollEdgeEffect', () =>
{
  it('uses the automatic native treatment on iOS', () =>
  {
    expect(nativeTopScrollEdgeEffect('ios', '26.5')).toBe('automatic')
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
