// apps/web/src/components/settings/ConnectionsSettings.logic.ts
// derive connections settings presentation behavior

import type { DesktopBridge, DesktopWslState } from '@t3tools/contracts'

type WslEnableBridge = Pick<DesktopBridge, 'setWslBackendEnabled' | 'setWslDistro' | 'setWslOnly'>

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge
  readonly mode: 'both' | 'wsl-only'
  readonly nextDistro: string | null
  readonly persistedDistro: string | null
}): Promise<DesktopWslState>
{
  const { bridge, mode, nextDistro, persistedDistro } = input

  // stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === 'wsl-only')
  if (persistedDistro !== nextDistro)
  {
    await bridge.setWslDistro(nextDistro)
  }
  return await bridge.setWslBackendEnabled(true)
}
