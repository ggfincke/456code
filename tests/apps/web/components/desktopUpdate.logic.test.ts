// tests/apps/web/components/desktopUpdate.logic.test.ts
// verify desktop update button state behavior

import { describe, expect, it } from 'vite-plus/test'
import type { DesktopUpdateActionResult, DesktopUpdateState } from '@t3tools/contracts'

import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from '../../../../apps/web/src/components/desktopUpdate.logic'

const baseState: DesktopUpdateState = {
  enabled: true,
  status: 'idle',
  channel: 'latest',
  currentVersion: '1.0.0',
  hostArch: 'x64',
  appArch: 'x64',
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
}

describe('desktop update button state', () =>
{
  it('shows a download action when an update is available', () =>
  {
    const state: DesktopUpdateState = {
      ...baseState,
      status: 'available',
      availableVersion: '1.1.0',
    }
    expect(shouldShowDesktopUpdateButton(state)).toBe(true)
    expect(resolveDesktopUpdateButtonAction(state)).toBe('download')
  })

  it('keeps retry action available after a download error', () =>
  {
    const state: DesktopUpdateState = {
      ...baseState,
      status: 'error',
      availableVersion: '1.1.0',
      message: 'network timeout',
      errorContext: 'download',
      canRetry: true,
    }
    expect(shouldShowDesktopUpdateButton(state)).toBe(true)
    expect(resolveDesktopUpdateButtonAction(state)).toBe('download')
    expect(getDesktopUpdateButtonTooltip(state)).toContain('Click to retry')
  })

  it('keeps install action available after an install error', () =>
  {
    const state: DesktopUpdateState = {
      ...baseState,
      status: 'error',
      downloadedVersion: '1.1.0',
      availableVersion: '1.1.0',
      message: 'shutdown timeout',
      errorContext: 'install',
      canRetry: true,
    }
    expect(shouldShowDesktopUpdateButton(state)).toBe(true)
    expect(resolveDesktopUpdateButtonAction(state)).toBe('install')
    expect(getDesktopUpdateButtonTooltip(state)).toContain('Click to retry')
  })

  it('prefers install when a downloaded version already exists', () =>
  {
    const state: DesktopUpdateState = {
      ...baseState,
      status: 'available',
      availableVersion: '1.1.0',
      downloadedVersion: '1.1.0',
    }
    expect(resolveDesktopUpdateButtonAction(state)).toBe('install')
  })

  it('hides the button for non-actionable check errors', () =>
  {
    const state: DesktopUpdateState = {
      ...baseState,
      status: 'error',
      message: 'network unavailable',
      errorContext: 'check',
      canRetry: true,
    }
    expect(shouldShowDesktopUpdateButton(state)).toBe(false)
    expect(resolveDesktopUpdateButtonAction(state)).toBe('none')
  })

  it('disables the button while downloading', () =>
  {
    const state: DesktopUpdateState = {
      ...baseState,
      status: 'downloading',
      availableVersion: '1.1.0',
      downloadPercent: 42.5,
    }
    expect(shouldShowDesktopUpdateButton(state)).toBe(true)
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true)
    expect(getDesktopUpdateButtonTooltip(state)).toContain('42%')
  })
})

describe('getDesktopUpdateActionError', () =>
{
  it('returns user-visible message for accepted failed attempts', () =>
  {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: 'available',
        availableVersion: '1.1.0',
        message: 'checksum mismatch',
        errorContext: 'download',
        canRetry: true,
      },
    }
    expect(getDesktopUpdateActionError(result)).toBe('checksum mismatch')
  })

  it('ignores messages for non-accepted attempts', () =>
  {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: 'error',
        message: 'background failure',
        errorContext: 'check',
        canRetry: false,
      },
    }
    expect(getDesktopUpdateActionError(result)).toBeNull()
  })

  it('ignores messages for successful attempts', () =>
  {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: 'downloaded',
        downloadedVersion: '1.1.0',
        availableVersion: '1.1.0',
        message: null,
        errorContext: null,
        canRetry: true,
      },
    }
    expect(getDesktopUpdateActionError(result)).toBeNull()
  })
})

describe('desktop update UI helpers', () =>
{
  it('toasts only for actionable updater errors', () =>
  {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: 'checksum mismatch' },
      }),
    ).toBe(true)
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: null },
      }),
    ).toBe(false)
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: { ...baseState, message: 'checksum mismatch' },
      }),
    ).toBe(false)
  })

  it('shows Apple Silicon warning copy and versioned install confirmation', () =>
  {
    const idle: DesktopUpdateState = {
      ...baseState,
      hostArch: 'arm64',
      appArch: 'x64',
      runningUnderArm64Translation: true,
    }
    const available: DesktopUpdateState = {
      ...idle,
      status: 'available',
      availableVersion: '1.1.0',
    }

    expect(shouldShowArm64IntelBuildWarning(idle)).toBe(true)
    expect(getArm64IntelBuildWarningDescription(idle)).toContain('Apple Silicon')
    expect(getArm64IntelBuildWarningDescription(available)).toContain(
      'Download the available update',
    )
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: '1.1.0',
        downloadedVersion: '1.1.1',
      }),
    ).toContain('Install update 1.1.1 and restart 456code?')
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain('Install update and restart 456code?')
  })

  it('warns Windows users about silent install and keeps that warning platform-specific', () =>
  {
    const versions = {
      availableVersion: '1.1.0',
      downloadedVersion: '1.1.0',
    }
    const windows = getDesktopUpdateInstallConfirmationMessage(versions, 'Win32')
    const mac = getDesktopUpdateInstallConfirmationMessage(versions, 'MacIntel')

    expect(windows).toContain('may remain closed for several minutes')
    expect(windows).toContain('will reopen automatically')
    expect(mac).not.toContain('may remain closed for several minutes')
  })
})

describe('canCheckForUpdate', () =>
{
  it.each([
    { label: 'null state', state: null },
    {
      label: 'updates disabled',
      state: { ...baseState, enabled: false, status: 'disabled' as const },
    },
    { label: 'checking', state: { ...baseState, status: 'checking' as const } },
    {
      label: 'downloading',
      state: { ...baseState, status: 'downloading' as const, downloadPercent: 50 },
    },
    {
      label: 'downloaded',
      state: {
        ...baseState,
        status: 'downloaded' as const,
        availableVersion: '1.1.0',
        downloadedVersion: '1.1.0',
      },
    },
  ])('returns false for $label', ({ state }) =>
  {
    expect(canCheckForUpdate(state)).toBe(false)
  })

  it.each([
    { label: 'idle', state: { ...baseState, status: 'idle' as const } },
    { label: 'up-to-date', state: { ...baseState, status: 'up-to-date' as const } },
    {
      label: 'available',
      state: { ...baseState, status: 'available' as const, availableVersion: '1.1.0' },
    },
    {
      label: 'error (retry)',
      state: {
        ...baseState,
        status: 'error' as const,
        errorContext: 'check' as const,
        message: 'network',
      },
    },
  ])('returns true for $label', ({ state }) =>
  {
    expect(canCheckForUpdate(state)).toBe(true)
  })
})

describe('getDesktopUpdateButtonTooltip', () =>
{
  it("returns 'Up to date' for non-actionable states", () =>
  {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: 'idle' })).toBe('Up to date')
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: 'up-to-date' })).toBe('Up to date')
  })
})
