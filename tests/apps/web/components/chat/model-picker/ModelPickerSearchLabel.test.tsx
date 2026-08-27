// tests/apps/web/components/chat/model-picker/ModelPickerSearchLabel.test.tsx
// verifies the model search field exposes a programmatic accessible name

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import {
  ModelPickerContent,
  MODEL_SEARCH_INPUT_LABEL,
  groupLegacyModels,
} from '../../../../../../apps/web/src/components/chat/model-picker/ModelPickerContent'
import { deriveProviderInstanceEntries } from '../../../../../../apps/web/src/providerInstances'

const CODEX_INSTANCE = ProviderInstanceId.make('codex')

const codexSnapshot = {
  instanceId: CODEX_INSTANCE,
  driver: ProviderDriverKind.make('codex'),
  enabled: true,
  installed: true,
  version: null,
  status: 'ready',
  auth: { status: 'authenticated' },
  checkedAt: '2026-08-02T00:00:00.000Z',
  models: [],
} as unknown as ServerProvider

describe('model picker search field', () =>
{
  it('partitions explicit legacy rows without dropping models or changing within-group order', () =>
  {
    const models = [
      { slug: 'older-favorite', isLegacy: true },
      { slug: 'future' },
      { slug: 'current', isLegacy: false },
      { slug: 'older', isLegacy: true },
    ]
    expect(groupLegacyModels(models)).toEqual([models[1], models[2], models[0], models[3]])
  })

  it('names the search combobox for assistive tech, not just its placeholder', () =>
  {
    const markup = renderToStaticMarkup(
      <ModelPickerContent
        activeInstanceId={CODEX_INSTANCE}
        model="gpt-5.4"
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([codexSnapshot])}
        modelOptionsByInstance={new Map()}
        terminalOpen={false}
        onInstanceModelChange={() =>
        {}}
      />,
    )

    expect(markup).toContain(`aria-label="${MODEL_SEARCH_INPUT_LABEL}"`)
  })
})
