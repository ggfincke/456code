// scripts/lib/desktop-build-helpers.ts
// pure desktop artifact staging and brand/channel resolution helpers

import * as Schema from 'effect/Schema'

import {
  BRAND_ASSET_PATHS,
  resolveWebAssetBrandForChannel,
  type WebAssetBrand,
} from './brand-assets.ts'

export const BuildPlatform = Schema.Literals(['mac', 'linux', 'win'])
export const BuildArch = Schema.Literals(['arm64', 'x64', 'universal'])

export const STAGE_INSTALL_ARGS = ['install', '--prod'] as const
export const DESKTOP_ASAR_UNPACK = ['node_modules/@ff-labs/fff-bin-*/**/*'] as const

export interface DesktopBuildIconAssets
{
  readonly macIconPng: string
  readonly linuxIconPng: string
  readonly windowsIconIco: string
}

export interface StageWorkspaceConfig
{
  readonly supportedArchitectures: {
    readonly os: ReadonlyArray<string>
    readonly cpu: ReadonlyArray<string>
    readonly libc?: ReadonlyArray<string>
  }
  readonly allowBuilds?: Record<string, boolean>
  readonly patchedDependencies?: Record<string, string>
  readonly overrides?: Record<string, string>
}

export function resolveFffNativeDependencies(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
  version: string,
): Record<string, string>
{
  const architectures = arch === 'universal' ? (['arm64', 'x64'] as const) : [arch]

  if (platform === 'mac')
  {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    )
  }

  if (platform === 'win')
  {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    )
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ['gnu', 'musl'].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  )
}

export function createStageWorkspaceConfig(input: {
  readonly platform: typeof BuildPlatform.Type
  readonly arch: typeof BuildArch.Type
  readonly allowBuilds?: Record<string, boolean>
  readonly patchedDependencies?: Record<string, string>
  readonly overrides?: Record<string, string>
}): StageWorkspaceConfig
{
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input
  const hostOs = platform === 'mac' ? 'darwin' : platform === 'win' ? 'win32' : 'linux'
  const hostCpu = arch === 'universal' ? ['arm64', 'x64'] : [arch]
  // linux AppImages and Windows WSL backends both execute a Linux/glibc Node
  // process that loads Linux-native optional deps at runtime (e.g.
  // @yuuang/ffi-rs-linux-x64-gnu). Keep libc explicit so pnpm includes those
  // optional packages in the staged production install.
  const supportedArchitectures =
    platform === 'linux'
      ? {
          os: [hostOs],
          cpu: hostCpu,
          libc: ['glibc'],
        }
      : platform === 'win'
        ? {
            os: Array.from(new Set([hostOs, 'linux'])),
            cpu: hostCpu,
            libc: ['glibc'],
          }
        : {
            os: [hostOs],
            cpu: hostCpu,
          }

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  }
}

function getPatchedDependencyPackageName(patchKey: string): string
{
  const versionSeparator = patchKey.lastIndexOf('@')
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string>
{
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  )
}

export function resolveDesktopUpdateChannel(version: string): 'latest' | 'nightly'
{
  return /-nightly\.\d{8}\.\d+$/.test(version) ? 'nightly' : 'latest'
}

export function resolveDesktopWebAssetBrand(version: string, isLocalBuild: boolean): WebAssetBrand
{
  if (isLocalBuild)
  {
    return 'development'
  }

  return resolveWebAssetBrandForChannel(resolveDesktopUpdateChannel(version))
}

export function resolveDesktopBuildIconAssets(
  version: string,
  isLocalBuild: boolean,
): DesktopBuildIconAssets
{
  // local wins over the version channel: the point of the ocean mark is telling
  // a self-built app apart in the Dock, including when the version says nightly
  if (isLocalBuild)
  {
    return {
      macIconPng: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    }
  }

  if (resolveDesktopUpdateChannel(version) === 'nightly')
  {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    }
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  }
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string
{
  return `http://localhost:${mockUpdateServerPort ?? 3000}`
}

// electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string
{
  const trimmed = packageManager.trim()
  const versionSeparator = trimmed.lastIndexOf('@')
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1)
  {
    return trimmed
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`
}

export function resolveDesktopProductName(version: string, productName = '456code'): string
{
  return resolveDesktopUpdateChannel(version) === 'nightly' ? '456code (Nightly)' : productName
}
