// tests/apps/web/components/settings/ProviderInstanceCard.test.ts
// verify derive provider models for display behavior

import { describe, expect, it } from 'vite-plus/test'
import type { ServerProviderModel } from '@t3tools/contracts'

import { deriveProviderModelsForDisplay } from '../../../../../apps/web/src/components/settings/ProviderInstanceCard'

describe('deriveProviderModelsForDisplay', () =>
{
  it('uses current config custom models instead of stale live custom rows', () =>
  {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: 'server-model',
        name: 'Server Model',
        isCustom: false,
        capabilities: null,
      },
      {
        slug: 'removed-custom',
        name: 'Removed Custom',
        isCustom: true,
        capabilities: null,
      },
      {
        slug: 'kept-custom',
        name: 'Kept Custom',
        isCustom: true,
        capabilities: null,
      },
    ]

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ['kept-custom'],
        customModelMetadata: {
          'kept-custom': { name: 'Current configured name' },
          orphan: { name: 'Orphan' },
        },
      }).map((model) => ({ slug: model.slug, name: model.name })),
    ).toEqual([
      { slug: 'server-model', name: 'Server Model' },
      { slug: 'kept-custom', name: 'Current configured name' },
    ])
  })
})
