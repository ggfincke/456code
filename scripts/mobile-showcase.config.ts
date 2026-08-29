// scripts/mobile-showcase.config.ts
// run the mobile showcase repository workflow

import { SHOWCASE_SCENES, type ShowcaseScene } from './mobile-showcase-environment.ts'

export { SHOWCASE_SCENES }
export type { ShowcaseScene }

export type ShowcaseAppearance = 'light' | 'dark'

export interface ShowcaseStoreAssetSpec
{
  readonly store: 'apple'
  // device directory relative to ShowcaseConfig.outputDirectory.
  readonly directory: string
  readonly width: number
  readonly height: number
  readonly minimumUploadCount: number
  readonly maximumUploadCount: number
}

export interface ShowcaseIosDevice
{
  readonly id: string
  readonly platform: 'ios'
  // exact name from `xcrun simctl list devices available`.
  readonly simulator: string
  // device type used to create a disposable simulator when the named one is absent.
  readonly simulatorDeviceType?: string
  // appearance used when the CLI does not pass --appearance.
  readonly appearance: ShowcaseAppearance
  readonly scenes: ReadonlyArray<ShowcaseScene>
  readonly storeAsset: ShowcaseStoreAssetSpec
}

export type ShowcaseDevice = ShowcaseIosDevice

export interface ShowcaseConfig
{
  readonly outputDirectory: string
  readonly metroPort: number
  readonly settleDelayMs: number
  readonly devices: ReadonlyArray<ShowcaseDevice>
}

// the defaults cover every App Store Connect upload slot used by the mobile
// app. Edit this matrix (or pass --device / --scene) without
// changing the runner. Every target declares and validates its exact upload
// dimensions so SDK or simulator changes cannot silently produce invalid files.
const config: ShowcaseConfig = {
  outputDirectory: 'artifacts/app-store/screenshots',
  // dedicated port so the harness cannot attach to a normal mobile dev server
  // (or a second worktree) and capture the wrong bundle.
  metroPort: 8199,
  settleDelayMs: 2_500,
  devices: [
    {
      id: 'iphone-6.9',
      platform: 'ios',
      simulator: 'iPhone 17 Pro Max',
      simulatorDeviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max',
      appearance: 'dark',
      scenes: ['thread', 'terminal', 'review', 'threads', 'environments'],
      storeAsset: {
        store: 'apple',
        directory: 'apple/iphone-6.9',
        width: 1320,
        height: 2868,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
    {
      id: 'iphone-6.5',
      platform: 'ios',
      simulator: 'T3 Showcase iPhone 14 Plus',
      simulatorDeviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-14-Plus',
      appearance: 'dark',
      scenes: ['thread', 'terminal', 'review', 'threads', 'environments'],
      storeAsset: {
        store: 'apple',
        directory: 'apple/iphone-6.5',
        width: 1284,
        height: 2778,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
    {
      id: 'ipad-13',
      platform: 'ios',
      simulator: 'iPad Pro 13-inch (M5)',
      simulatorDeviceType: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-16GB',
      appearance: 'dark',
      scenes: ['thread', 'terminal', 'review', 'threads', 'environments'],
      storeAsset: {
        store: 'apple',
        directory: 'apple/ipad-13',
        width: 2064,
        height: 2752,
        minimumUploadCount: 1,
        maximumUploadCount: 10,
      },
    },
  ],
}

export default config
