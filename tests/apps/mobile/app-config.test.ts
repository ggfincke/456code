// tests/apps/mobile/app-config.test.ts
// verify iOS-only Expo variants and local module manifests

// @effect-diagnostics nodeBuiltinImport:off - Tests inspect repository-owned JSON manifests directly.
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const originalAppVariant = process.env.APP_VARIANT

afterEach(() =>
{
  vi.resetModules()
  if (originalAppVariant === undefined)
  {
    delete process.env.APP_VARIANT
  }
  else
  {
    process.env.APP_VARIANT = originalAppVariant
  }
})

describe.each([
  ['development', '456code Dev', 'code456-dev', 'com.ggfincke.code456.dev'],
  ['preview', '456code Preview', 'code456-preview', 'com.ggfincke.code456.preview'],
  ['production', '456code', 'code456', 'com.ggfincke.code456'],
] as const)('%s Expo variant', (variant, name, scheme, bundleIdentifier) =>
{
  it('keeps the iOS identity and excludes other native platforms', async () =>
  {
    process.env.APP_VARIANT = variant
    vi.resetModules()

    const { default: config } = await import('../../../apps/mobile/app.config.ts')

    expect(config).toMatchObject({
      name,
      scheme,
      platforms: ['ios'],
      ios: {
        bundleIdentifier,
        supportsTablet: true,
      },
      extra: { appVariant: variant },
    })
    expect(config.plugins).toContain('./plugins/withIosPodsDeploymentTargetFloor.cjs')
  })
})

it('registers every local Expo module for Apple only', () =>
{
  const modulesRoot = NodeURL.fileURLToPath(
    new URL('../../../apps/mobile/modules', import.meta.url),
  )
  const manifests = NodeFS.readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => NodePath.join(modulesRoot, entry.name, 'expo-module.config.json'))
    .filter((path) => NodeFS.existsSync(path))

  expect(manifests.length).toBeGreaterThan(0)
  for (const path of manifests)
  {
    const manifest = JSON.parse(NodeFS.readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(manifest.platforms, NodePath.relative(modulesRoot, path)).toEqual(['apple'])
  }
})
