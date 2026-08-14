// apps/desktop/src/settings/DesktopSettingsModel.ts
// define desktop settings values and defaults

import type { DesktopServerExposureMode, DesktopUpdateChannel } from '@t3tools/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { resolveDefaultDesktopUpdateChannel } from '../updates/updateChannels.ts'
import { isValidDistroName } from '../wsl/wslPathParsing.ts'

export interface DesktopSettings
{
  readonly mainWindowBounds: DesktopWindowBounds | null
  readonly mainWindowMaximized: boolean
  readonly serverExposureMode: DesktopServerExposureMode
  readonly tailscaleServeEnabled: boolean
  readonly tailscaleServePort: number
  readonly updateChannel: DesktopUpdateChannel
  readonly updateChannelConfiguredByUser: boolean
  // was a "local" | "wsl" swap mode in an earlier iteration of the WSL
  // integration. We now run Windows and WSL backends side by side, so the
  // setting is just whether the WSL backend should be running alongside the
  // primary. Persisted documents that still carry the legacy `wslMode: "wsl"`
  // value are migrated to `wslBackendEnabled: true` on load.
  readonly wslBackendEnabled: boolean
  readonly wslDistro: string | null
  // when true (and wslBackendEnabled is also true) the desktop runs only
  // the WSL backend as the primary, and the Windows-side Node backend is
  // not started. Designed for users who develop entirely inside WSL and
  // don't want a second backend process running. Defaults to false so
  // existing setups stay on the parallel-backends behavior. Changing
  // this requires a desktop restart because the pool's primary spec is
  // chosen once at layer init.
  readonly wslOnly: boolean
}

export interface DesktopSettingsChange
{
  readonly settings: DesktopSettings
  readonly changed: boolean
}

export const DEFAULT_TAILSCALE_SERVE_PORT = 443
const MIN_MAIN_WINDOW_SIZE = {
  width: 840,
  height: 620,
} as const
export const DesktopWindowBoundsSchema = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.width)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.height)),
})
export type DesktopWindowBounds = typeof DesktopWindowBoundsSchema.Type
export const DEFAULT_MAIN_WINDOW_SIZE = {
  width: 1100,
  height: 780,
} as const

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  mainWindowBounds: null,
  mainWindowMaximized: false,
  serverExposureMode: 'local-only',
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  updateChannel: 'latest',
  updateChannelConfiguredByUser: false,
  wslBackendEnabled: false,
  wslDistro: null,
  wslOnly: false,
}

const decodeDesktopWindowBounds = Schema.decodeUnknownOption(DesktopWindowBoundsSchema)

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings
{
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  }
}

export function normalizeTailscaleServePort(value: unknown): number
{
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : DEFAULT_TAILSCALE_SERVE_PORT
}

export function normalizeWslDistro(value: unknown): string | null
{
  return typeof value === 'string' && isValidDistroName(value) ? value : null
}

export function normalizeMainWindowBounds(value: unknown): DesktopWindowBounds | null
{
  return Option.getOrNull(decodeDesktopWindowBounds(value))
}
