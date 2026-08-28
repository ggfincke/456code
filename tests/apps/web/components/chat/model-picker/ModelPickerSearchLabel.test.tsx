// tests/apps/web/components/chat/model-picker/ModelPickerSearchLabel.test.tsx
// verifies the model search field exposes a programmatic accessible name

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from '@t3tools/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vite-plus/test'

import {
  ModelPickerContent,
  MODEL_SEARCH_INPUT_LABEL,
  groupLegacyModels,
  shouldIncludeModelPickerOption,
} from '../../../../../../apps/web/src/components/chat/model-picker/ModelPickerContent'
import { deriveProviderInstanceEntries } from '../../../../../../apps/web/src/providerInstances'
import { ProviderModelPicker } from '../../../../../../apps/web/src/components/chat/model-picker/ProviderModelPicker'

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
  it('exposes only the active unavailable row without widening disabled or unavailable instance access', () =>
  {
    const instanceId = ProviderInstanceId.make('opencode-work')
    const [entry] = deriveProviderInstanceEntries([
      {
        ...codexSnapshot,
        instanceId,
        driver: ProviderDriverKind.make('opencode'),
        status: 'error',
      },
    ])
    const option = { slug: 'vendor/saved', name: 'vendor/saved', isUnavailable: true }
    const input = { entry: entry!, option, activeInstanceId: instanceId, activeModel: option.slug }
    expect(shouldIncludeModelPickerOption(input)).toBe(true)
    expect(
      shouldIncludeModelPickerOption({ ...input, option: { slug: 'other', name: 'Other' } }),
    ).toBe(false)
    expect(shouldIncludeModelPickerOption({ ...input, activeInstanceId: CODEX_INSTANCE })).toBe(
      false,
    )
    expect(shouldIncludeModelPickerOption({ ...input, entry: { ...entry!, enabled: false } })).toBe(
      false,
    )
    expect(
      shouldIncludeModelPickerOption({ ...input, entry: { ...entry!, isAvailable: false } }),
    ).toBe(false)
    const markup = renderToStaticMarkup(
      <ProviderModelPicker
        activeInstanceId={instanceId}
        model={option.slug}
        lockedProvider={null}
        instanceEntries={[entry!]}
        modelOptionsByInstance={new Map([[instanceId, [option, { slug: 'other', name: 'Other' }]]])}
        onInstanceModelChange={() =>
        {}}
      />,
    )
    expect(markup).toContain('vendor/saved (Unavailable)')
    expect(markup).toContain('Unavailable</span>')
  })

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
