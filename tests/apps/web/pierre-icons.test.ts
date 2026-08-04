// tests/apps/web/pierre-icons.test.ts
// verify pierre file icons behavior

import { assert, describe, it } from 'vite-plus/test'

import {
  hasSpecificPierreIconForFileName,
  resolvePierreIconForEntry,
  syntheticFileNameForLanguageId,
} from '../../../apps/web/src/pierre-icons'

describe('Pierre file icons', () =>
{
  it('extends Pierre with a T3-specific exact filename icon', () =>
  {
    assert.equal(
      resolvePierreIconForEntry('package.json', 'file')?.name,
      't3-file-icon-package-json',
    )
  })

  it('aliases lockfile names onto the shared pnpm sprite', () =>
  {
    assert.equal(resolvePierreIconForEntry('pnpm-lock.yaml', 'file')?.name, 't3-file-icon-pnpm')
  })

  it('uses the Pierre default icon for unknown file types', () =>
  {
    assert.equal(resolvePierreIconForEntry('artifact.unknown-ext', 'file')?.token, 'default')
    assert.isFalse(hasSpecificPierreIconForFileName('artifact.unknown-ext'))
  })

  it('leaves directory rendering to the shared folder fallback', () =>
  {
    assert.isNull(resolvePierreIconForEntry('packages/client-runtime', 'directory'))
  })

  it('normalizes common markdown fence language aliases', () =>
  {
    assert.equal(syntheticFileNameForLanguageId('typescript'), 'file.ts')
    assert.equal(syntheticFileNameForLanguageId('shellscript'), 'file.sh')
  })
})
