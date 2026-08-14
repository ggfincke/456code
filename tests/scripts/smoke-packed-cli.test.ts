// tests/scripts/smoke-packed-cli.test.ts
// verify packed CLI release-contract validation

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { afterEach, describe, it } from 'vite-plus/test'

import {
  assertInstalledCoreLayout,
  assertPackedServerManifest,
  canTreatProcessGroupSignalErrorAsExit,
} from '../../scripts/smoke-packed-cli.ts'

const tempRoots: string[] = []

function makeTempRoot(): string
{
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), '456code-packed-cli-test-'))
  tempRoots.push(root)
  return root
}

function validServerManifest(): Record<string, unknown>
{
  return {
    name: '456code',
    version: '1.2.3',
    repository: {
      type: 'git',
      url: 'https://github.com/ggfincke/456code',
    },
    bin: { '456code': './dist/bin.mjs' },
    dependencies: { '@t3tools/cartographer-core': '0.1.0', effect: '^3.0.0' },
    bundleDependencies: ['@t3tools/cartographer-core'],
    overrides: { effect: '^3.0.0' },
  }
}

afterEach(() =>
{
  for (const root of tempRoots.splice(0))
  {
    NodeFS.rmSync(root, { recursive: true, force: true })
  }
})

describe('packed CLI release contract', () =>
{
  it('accepts an exact bundled Cartographer dependency and canonical repository', () =>
  {
    NodeAssert.equal(assertPackedServerManifest(validServerManifest()), '0.1.0')
  })

  it('rejects local dependency protocols before publish', () =>
  {
    const manifest = validServerManifest()
    manifest.dependencies = { '@t3tools/cartographer-core': 'workspace:*' }
    NodeAssert.throws(
      () => assertPackedServerManifest(manifest),
      /exact version|local-only dependency protocol/u,
    )
  })

  it('requires every bundled core runtime sibling to be a real file', () =>
  {
    const serverRoot = makeTempRoot()
    const coreRoot = NodePath.join(serverRoot, 'node_modules', '@t3tools', 'cartographer-core')
    const files = [
      'LICENSE',
      'dist/server.js',
      'dist/server.d.ts',
      'dist/cli/index.js',
      'dist/mcp/bin.js',
      'dist/mcp/server.js',
    ]
    for (const relativePath of files)
    {
      const filePath = NodePath.join(coreRoot, relativePath)
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true })
      NodeFS.writeFileSync(filePath, '')
    }
    NodeFS.writeFileSync(
      NodePath.join(coreRoot, 'package.json'),
      `${JSON.stringify({
        name: '@t3tools/cartographer-core',
        version: '0.1.0',
        bin: { 'cartographer-mcp': './dist/mcp/bin.js' },
        dependencies: { zod: '^4.0.0' },
      })}\n`,
    )
    const zodManifest = NodePath.join(coreRoot, 'node_modules/zod/package.json')
    NodeFS.mkdirSync(NodePath.dirname(zodManifest), { recursive: true })
    NodeFS.writeFileSync(zodManifest, '{}\n')

    NodeAssert.equal(assertInstalledCoreLayout(serverRoot, '0.1.0'), coreRoot)
    NodeFS.rmSync(NodePath.join(coreRoot, 'dist/mcp/server.js'))
    NodeAssert.throws(
      () => assertInstalledCoreLayout(serverRoot, '0.1.0'),
      /dist\/mcp\/server\.js/u,
    )
  })

  it('softens process-group errors only when exit is definitive', () =>
  {
    const childProcessId = 123
    NodeAssert.equal(canTreatProcessGroupSignalErrorAsExit('ESRCH', childProcessId, []), true)
    NodeAssert.equal(canTreatProcessGroupSignalErrorAsExit('EPERM', childProcessId, []), true)
    NodeAssert.equal(
      canTreatProcessGroupSignalErrorAsExit('EPERM', childProcessId, [
        { processId: childProcessId, processGroupId: childProcessId },
      ]),
      false,
    )
    NodeAssert.equal(
      canTreatProcessGroupSignalErrorAsExit('EPERM', childProcessId, [
        { processId: 456, processGroupId: childProcessId },
      ]),
      false,
    )
    NodeAssert.equal(canTreatProcessGroupSignalErrorAsExit('EACCES', childProcessId, []), false)
  })
})
