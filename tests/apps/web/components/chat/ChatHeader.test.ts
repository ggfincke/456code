// tests/apps/web/components/chat/ChatHeader.test.ts
// verify should show open in picker behavior

import { EnvironmentId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { shouldShowOpenInPicker } from '../../../../../apps/web/src/components/chat/ChatHeader'

describe('shouldShowOpenInPicker', () =>
{
  const primaryEnvironmentId = EnvironmentId.make('environment-primary')

  it('shows the picker for projects in the primary environment', () =>
  {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: 'codething-mvp',
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: 'local-exec',
      }),
    ).toBe(true)
  })

  it('shows the unavailable state when a remote environment has no ssh route', () =>
  {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: 'codething-mvp',
        activeThreadEnvironmentId: EnvironmentId.make('environment-remote'),
        primaryEnvironmentId: null,
        remoteOpenMode: 'remote-unavailable',
      }),
    ).toBe(true)
  })

  it('shows the picker for remote environments with editor links', () =>
  {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: 'codething-mvp',
        activeThreadEnvironmentId: EnvironmentId.make('environment-remote'),
        primaryEnvironmentId,
        remoteOpenMode: 'remote-links',
      }),
    ).toBe(true)
  })

  it('hides the picker for non-primary local environments', () =>
  {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: 'codething-mvp',
        activeThreadEnvironmentId: EnvironmentId.make('environment-wsl'),
        primaryEnvironmentId,
        remoteOpenMode: 'local-exec',
      }),
    ).toBe(false)
  })

  it('hides the picker when there is no active project', () =>
  {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: 'remote-links',
      }),
    ).toBe(false)
  })
})
