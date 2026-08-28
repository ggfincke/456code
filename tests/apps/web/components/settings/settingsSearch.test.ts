// tests/apps/web/components/settings/settingsSearch.test.ts
// protect normalized settings matches and current navigation targets

import { describe, expect, it } from 'vite-plus/test'

import {
  searchSettings,
  SETTINGS_ANCHORS,
  type SettingsSearchItem,
} from '../../../../../apps/web/src/components/settings/settingsSearch'

describe('searchSettings', () =>
{
  it('lists thread confirmations in panel order with the unpin anchor', () =>
  {
    expect(searchSettings('confirmation').map((item) => item.id)).toEqual([
      'unpin-confirmation',
      'archive-confirmation',
      'delete-confirmation',
    ])
    expect(searchSettings('unpin')[0]).toMatchObject({
      to: '/settings/general',
      anchorId: 'settings-unpin-confirmation',
    })
  })

  it('folds case, accents and whitespace without returning matches for an empty query', () =>
  {
    expect(searchSettings('  THÈME  ').map((item) => item.id)).toContain('theme')
    expect(searchSettings('  TIME   format ').map((item) => item.id)).toEqual(['time-format'])
    expect(searchSettings(' \t ')).toEqual([])
    expect(searchSettings('not a real setting')).toEqual([])
  })

  it('ranks title matches before keyword matches while preserving catalog order', () =>
  {
    const items: ReadonlyArray<SettingsSearchItem> = [
      { id: 'keyword', title: 'Appearance', to: '/settings/general', keywords: ['theme'] },
      { id: 'title', title: 'Theme', to: '/settings/general', keywords: ['theme'] },
      { id: 'another-title', title: 'Theme colors', to: '/settings/general' },
    ]
    expect(searchSettings('thème', items).map((item) => item.id)).toEqual([
      'title',
      'another-title',
      'keyword',
    ])
  })

  it('targets the current Integrations, Diagnostics and Connections panels', () =>
  {
    expect(searchSettings('viewport')).toContainEqual(
      expect.objectContaining({ to: '/settings/integrations', anchorId: 'browser' }),
    )
    expect(searchSettings('diagnostics')[0]).toMatchObject({ to: '/settings/diagnostics' })
    expect(searchSettings('authorized clients')[0]).toMatchObject({
      to: '/settings/connections',
      anchorId: SETTINGS_ANCHORS.connectionsAuthorizedClients,
    })
    expect(searchSettings('remote environments')[0]).toMatchObject({
      to: '/settings/connections',
      anchorId: SETTINGS_ANCHORS.connectionsRemoteEnvironments,
    })
  })
})
