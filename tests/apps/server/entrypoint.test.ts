// tests/apps/server/entrypoint.test.ts
// verify ESM entrypoint detection across supported Node runtimes

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

import { assert, describe, it } from '@effect/vitest'

import { isEntrypoint } from '../../../apps/server/src/entrypoint.ts'

const makeTempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), '456code-entrypoint-'))

describe('isEntrypoint', () =>
{
  it('uses the runtime answer when import.meta.main is available', () =>
  {
    assert.isTrue(
      isEntrypoint({
        moduleUrl: 'file:///somewhere/bin.mjs',
        entryPath: '/elsewhere/other.mjs',
        runtimeMain: true,
      }),
    )
    assert.isFalse(
      isEntrypoint({
        moduleUrl: 'file:///somewhere/bin.mjs',
        entryPath: '/somewhere/bin.mjs',
        runtimeMain: false,
      }),
    )
  })

  it('matches the entrypoint path when import.meta.main is unavailable', () =>
  {
    const directory = makeTempDir()
    const entry = NodePath.join(directory, 'bin.mjs')
    NodeFS.writeFileSync(entry, '')

    assert.isTrue(
      isEntrypoint({
        moduleUrl: NodeURL.pathToFileURL(entry).href,
        entryPath: entry,
        runtimeMain: undefined,
      }),
    )
  })

  it('matches a symlinked npm-style entrypoint', () =>
  {
    const directory = makeTempDir()
    const realEntry = NodePath.join(directory, 'bin.mjs')
    const linkedEntry = NodePath.join(directory, '456code')
    NodeFS.writeFileSync(realEntry, '')
    NodeFS.symlinkSync(realEntry, linkedEntry)

    assert.isTrue(
      isEntrypoint({
        moduleUrl: NodeURL.pathToFileURL(realEntry).href,
        entryPath: linkedEntry,
        runtimeMain: undefined,
      }),
    )
  })

  it('rejects an imported module that is not the entrypoint', () =>
  {
    const directory = makeTempDir()
    const entry = NodePath.join(directory, 'bin.mjs')
    const imported = NodePath.join(directory, 'cli.mjs')
    NodeFS.writeFileSync(entry, '')
    NodeFS.writeFileSync(imported, '')

    assert.isFalse(
      isEntrypoint({
        moduleUrl: NodeURL.pathToFileURL(imported).href,
        entryPath: entry,
        runtimeMain: undefined,
      }),
    )
  })

  it('rejects a missing entrypoint argument', () =>
  {
    assert.isFalse(
      isEntrypoint({
        moduleUrl: 'file:///somewhere/bin.mjs',
        entryPath: undefined,
        runtimeMain: undefined,
      }),
    )
  })
})
