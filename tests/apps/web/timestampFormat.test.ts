// tests/apps/web/timestampFormat.test.ts
// verify relative expiry labels behavior

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  formatRelativeTimeUntilLabel,
  getRelativeTimeState,
} from '../../../apps/web/src/timestampFormat'

describe('relative expiry labels', () =>
{
  beforeEach(() =>
  {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T12:00:00.000Z'))
  })

  afterEach(() =>
  {
    vi.useRealTimers()
  })

  it.each([
    {
      label: 'expired instant',
      instant: '2026-04-07T11:59:00.000Z',
      until: 'Expired',
      expiresIn: 'Expired',
    },
    {
      label: 'sub-minute remainder',
      instant: '2026-04-07T12:00:45.000Z',
      until: '45s left',
      expiresIn: 'Expires in 45s',
    },
    {
      label: 'minutes under one hour',
      instant: '2026-04-07T12:15:00.000Z',
      until: '15m left',
      expiresIn: 'Expires in 15m',
    },
    {
      label: 'hours remaining',
      instant: '2026-04-07T18:00:00.000Z',
      until: '6h left',
      expiresIn: 'Expires in 6h',
    },
    {
      label: 'minutes and seconds under one hour',
      instant: '2026-04-07T12:04:12.000Z',
      until: '4m left',
      expiresIn: 'Expires in 4m 12s',
    },
    {
      label: 'hours with minute and second remainder',
      instant: '2026-04-07T14:02:03.000Z',
      until: '2h left',
      expiresIn: 'Expires in 2h 2m 3s',
    },
  ])('formats $label', ({ instant, until, expiresIn }) =>
  {
    expect(formatRelativeTimeUntilLabel(instant)).toBe(until)
    expect(formatExpiresInLabel(instant)).toBe(expiresIn)
  })
})

describe('invalid timestamp inputs', () =>
{
  it('distinguishes missing and invalid relative time state', () =>
  {
    expect(getRelativeTimeState(null)).toEqual({ status: 'missing' })
    expect(getRelativeTimeState('not-a-date')).toEqual({ status: 'invalid' })
  })
})

describe('getRelativeTimeState', () =>
{
  beforeEach(() =>
  {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T12:00:00.000Z'))
  })

  afterEach(() =>
  {
    vi.useRealTimers()
  })

  it('returns relative parts for valid timestamps', () =>
  {
    expect(getRelativeTimeState('2026-04-07T11:45:00.000Z')).toEqual({
      status: 'relative',
      value: '15m',
      suffix: 'ago',
    })
  })
})

describe('formatElapsedDurationLabel', () =>
{
  beforeEach(() =>
  {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T12:00:00.000Z'))
  })

  afterEach(() =>
  {
    vi.useRealTimers()
  })

  it('returns just now when the instant is current or in the future', () =>
  {
    expect(formatElapsedDurationLabel('2026-04-07T12:00:00.000Z')).toBe('just now')
    expect(formatElapsedDurationLabel('2026-04-07T12:01:00.000Z')).toBe('just now')
  })

  it('formats seconds, minutes, hours, and days', () =>
  {
    expect(formatElapsedDurationLabel('2026-04-07T11:59:45.000Z')).toBe('15s')
    expect(formatElapsedDurationLabel('2026-04-07T11:45:00.000Z')).toBe('15m')
    expect(formatElapsedDurationLabel('2026-04-07T06:00:00.000Z')).toBe('6h')
    expect(formatElapsedDurationLabel('2026-04-03T12:00:00.000Z')).toBe('4d')
  })
})
