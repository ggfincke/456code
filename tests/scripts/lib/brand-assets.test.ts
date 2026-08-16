// tests/scripts/lib/brand-assets.test.ts
// verify brand assets behavior

import { describe, expect, it } from 'vite-plus/test'

import {
  BRAND_ASSET_PATHS,
  DEVELOPMENT_PUBLIC_ICON_OVERRIDES,
  resolveWebIconOverrides,
} from '../../../scripts/lib/brand-assets.ts'

describe('brand-assets', () =>
{
  it('maps production and development web icon overrides', () =>
  {
    expect(resolveWebIconOverrides('production', 'dist/client')).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFaviconIco,
        targetRelativePath: 'dist/client/favicon.ico',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        targetRelativePath: 'dist/client/favicon-16x16.png',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        targetRelativePath: 'dist/client/favicon-32x32.png',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
        targetRelativePath: 'dist/client/apple-touch-icon.png',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebIcon192Png,
        targetRelativePath: 'dist/client/icon-192x192.png',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.productionWebIcon512Png,
        targetRelativePath: 'dist/client/icon-512x512.png',
      },
    ])

    expect(DEVELOPMENT_PUBLIC_ICON_OVERRIDES).toEqual([
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFaviconIco,
        targetRelativePath: 'apps/web/public/favicon.ico',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
        targetRelativePath: 'apps/web/public/favicon-16x16.png',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
        targetRelativePath: 'apps/web/public/favicon-32x32.png',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
        targetRelativePath: 'apps/web/public/apple-touch-icon.png',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebIcon192Png,
        targetRelativePath: 'apps/web/public/icon-192x192.png',
      },
      {
        sourceRelativePath: BRAND_ASSET_PATHS.developmentWebIcon512Png,
        targetRelativePath: 'apps/web/public/icon-512x512.png',
      },
    ])
  })

  it('maps hosted nightly web assets to nightly icons', () =>
  {
    expect(resolveWebIconOverrides('nightly', 'apps/web/dist')).toContainEqual({
      sourceRelativePath: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      targetRelativePath: 'apps/web/dist/favicon.ico',
    })
  })
})
