// tests/scripts/lib/resolve-catalog.test.ts
// verify resolve catalog behavior

import { assert, it } from '@effect/vitest'

import {
  CatalogDependencyResolutionError,
  resolveCatalogDependencies,
} from '../../../scripts/lib/resolve-catalog.ts'

it('reports unresolved catalog dependencies with lookup context', () =>
{
  try
  {
    resolveCatalogDependencies({ effect: 'catalog:runtime' }, {}, 'apps/server')
    assert.fail('Expected catalog resolution to fail.')
  }
  catch (error)
  {
    assert.instanceOf(error, CatalogDependencyResolutionError)
    assert.equal(error.workspacePackage, 'apps/server')
    assert.equal(error.dependencyName, 'effect')
    assert.equal(error.catalogSpec, 'catalog:runtime')
    assert.equal(error.catalogKey, 'runtime')
  }
})
