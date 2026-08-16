// tests/apps/web/lib/timestampFormat.test.ts
// verify timestamp formatting behavior

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  formatDayAwareTimestamp,
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  formatRelativeTimeUntilLabel,
  formatShortTimestamp,
  getRelativeTimeState,
  resolveTimestampLocale,
} from '../../../../apps/web/src/lib/timestampFormat'

describe('resolveTimestampLocale', () =>
{
  it('uses valid host tags and falls back for missing or invalid tags', () =>
  {
    expect(resolveTimestampLocale(' en-GB ')).toBe('en-GB')
    expect(resolveTimestampLocale(null)).toBeUndefined()
    expect(resolveTimestampLocale('   ')).toBeUndefined()
    expect(resolveTimestampLocale('not a locale')).toBeUndefined()
    expect(resolveTimestampLocale('en_GB')).toBeUndefined()
  })
})

describe('formatDayAwareTimestamp', () =>
{
  // local-time constructors keep these calendar boundaries stable in every test timezone.
  const iso = (year: number, month: number, day: number, hour: number, minute: number) =>
    new Date(year, month, day, hour, minute).toISOString()
  const shortTime = (isoDate: string) => formatShortTimestamp(isoDate, '12-hour')
  const now = new Date(2026, 7, 14, 12).getTime()

  const today = iso(2026, 7, 14, 9, 30)
  const yesterday = iso(2026, 7, 13, 23, 30)
  const sameYear = iso(2026, 7, 12, 12, 34)
  const priorYear = iso(2025, 11, 31, 18, 0)

  it.each([
    {
      label: 'today as time only',
      isoDate: today,
      nowMs: now,
      expected: shortTime(today),
    },
    {
      label: 'the previous calendar day just after midnight',
      isoDate: yesterday,
      nowMs: new Date(2026, 7, 14, 0, 30).getTime(),
      expected: `yesterday at ${shortTime(yesterday)}`,
    },
    {
      label: 'an older date in the same year',
      isoDate: sameYear,
      nowMs: now,
      expected: `${new Intl.DateTimeFormat(undefined, {
        month: 'numeric',
        day: 'numeric',
      }).format(new Date(sameYear))} ${shortTime(sameYear)}`,
    },
    {
      label: 'a date in another year',
      isoDate: priorYear,
      nowMs: now,
      expected: `${new Intl.DateTimeFormat(undefined, {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(priorYear))} ${shortTime(priorYear)}`,
    },
    {
      label: 'invalid input as an empty label',
      isoDate: 'not-a-date',
      nowMs: now,
      expected: '',
    },
  ])('formats $label', ({ isoDate, nowMs, expected }) =>
  {
    expect(formatDayAwareTimestamp(isoDate, '12-hour', nowMs)).toBe(expected)
  })

  it('uses the host locale for both the numeric date and time', async () =>
  {
    vi.stubGlobal('window', {
      desktopBridge: { getSystemLocale: () => 'en-GB' },
    })
    vi.resetModules()

    try
    {
      const { formatDayAwareTimestamp: formatWithHostLocale } =
        await import('../../../../apps/web/src/lib/timestampFormat')
      const messageAt = iso(2026, 7, 12, 15, 44)

      expect(formatWithHostLocale(messageAt, 'locale', now)).toBe('12/08 15:44')
    }
    finally
    {
      vi.unstubAllGlobals()
    }
  })
})

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
