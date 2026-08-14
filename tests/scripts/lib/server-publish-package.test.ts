// tests/scripts/lib/server-publish-package.test.ts
// verify the staged npm package carries its private Cartographer runtime

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { assert, it } from '@effect/vitest'

import {
  assertPackedServerArchive,
  stageServerPublishPackage,
  type CartographerCorePublishPackageManifest,
  type ServerPublishPackageManifest,
} from '../../../scripts/lib/server-publish-package.ts'

function readJson<T>(path: string): T
{
  return JSON.parse(NodeFS.readFileSync(path, 'utf8')) as T
}

it('packs a concrete private Cartographer runtime inside the public server artifact', () =>
{
  const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), '456code-publish-stage-'))

  try
  {
    const serverDist = NodePath.join(repoRoot, 'apps/server/dist')
    const coreRoot = NodePath.join(repoRoot, 'packages/cartographer-core')
    const coreDist = NodePath.join(coreRoot, 'dist')
    const stageDirectory = NodePath.join(repoRoot, 'stage')
    const packDirectory = NodePath.join(repoRoot, 'packed')
    const dependencyClosureDirectory = NodePath.join(repoRoot, 'core-dependencies')

    NodeFS.mkdirSync(NodePath.join(serverDist, 'client'), { recursive: true })
    NodeFS.writeFileSync(NodePath.join(serverDist, 'bin.mjs'), 'export {}\n')
    NodeFS.writeFileSync(NodePath.join(serverDist, 'client/index.html'), '<!doctype html>\n')
    for (const relativePath of [
      'index.js',
      'contracts/index.js',
      'server.js',
      'cli/index.js',
      'mcp/bin.js',
      'mcp/server.js',
    ])
    {
      const target = NodePath.join(coreDist, relativePath)
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true })
      NodeFS.writeFileSync(target, 'export {}\n')
      NodeFS.writeFileSync(target.replace(/\.js$/u, '.d.ts'), 'export {}\n')
    }
    NodeFS.writeFileSync(NodePath.join(coreRoot, 'LICENSE'), 'MIT\n')

    for (const [dependencyName, manifest] of Object.entries({
      '@modelcontextprotocol/sdk': { name: '@modelcontextprotocol/sdk', version: '1.29.0' },
      'dependency-cruiser': { name: 'dependency-cruiser', version: '18.1.1' },
      typescript: { name: '@typescript/typescript6', version: '6.0.2' },
      zod: { name: 'zod', version: '4.4.3' },
    }))
    {
      const dependencyDirectory = NodePath.join(
        dependencyClosureDirectory,
        ...dependencyName.split('/'),
      )
      NodeFS.mkdirSync(dependencyDirectory, { recursive: true })
      NodeFS.writeFileSync(
        NodePath.join(dependencyDirectory, 'package.json'),
        `${JSON.stringify(manifest)}\n`,
      )
    }

    const staged = stageServerPublishPackage({
      repoRoot,
      stageDirectory,
      version: '9.9.9-test.0',
      serverManifest: {
        name: '456code',
        license: 'MIT',
        repository: {
          type: 'git',
          url: 'https://github.com/ggfincke/456code',
          directory: 'apps/server',
        },
        bin: { '456code': './dist/bin.mjs' },
        type: 'module',
        version: '0.0.0',
        engines: { node: '>=24.10' },
        files: ['dist'],
        dependencies: {
          '@t3tools/cartographer-core': 'workspace:*',
          effect: 'catalog:',
        },
      },
      cartographerCoreManifest: {
        name: '@t3tools/cartographer-core',
        version: '0.1.0',
        description: 'Local-first repository graph and architecture atlas.',
        license: 'MIT',
        bin: {
          cartographer: './dist/cli/index.js',
          'cartographer-mcp': './dist/mcp/bin.js',
        },
        type: 'module',
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.29.0',
          'dependency-cruiser': '^18.0.0',
          typescript: 'catalog:',
          zod: '^4.4.3',
        },
        engines: { node: '>=24.10' },
      },
      workspaceCatalog: {
        effect: '^3.19.0',
        typescript: 'npm:@typescript/typescript6@6.0.2',
      },
      cartographerDependencyClosureDirectory: dependencyClosureDirectory,
    })

    const serverManifest = readJson<ServerPublishPackageManifest>(staged.packageJsonPath)
    assert.equal(serverManifest.version, '9.9.9-test.0')
    assert.equal(serverManifest.repository.url, 'https://github.com/ggfincke/456code')
    assert.equal(serverManifest.dependencies['@t3tools/cartographer-core'], '0.1.0')
    assert.equal(serverManifest.dependencies.effect, '^3.19.0')
    assert.deepEqual(serverManifest.bundleDependencies, ['@t3tools/cartographer-core'])

    const coreManifest = readJson<CartographerCorePublishPackageManifest>(
      NodePath.join(staged.cartographerCoreDirectory, 'package.json'),
    )
    assert.equal(coreManifest.private, true)
    assert.equal(coreManifest.bin['cartographer-mcp'], './dist/mcp/bin.js')
    assert.deepEqual(coreManifest.dependencies, {
      '@modelcontextprotocol/sdk': '1.29.0',
      'dependency-cruiser': '18.1.1',
      typescript: 'npm:@typescript/typescript6@6.0.2',
      zod: '4.4.3',
    })
    assert.isUndefined(coreManifest.exports['./browser'])

    NodeFS.mkdirSync(packDirectory)
    NodeChildProcess.execFileSync('npm', ['pack', '--pack-destination', packDirectory], {
      cwd: stageDirectory,
      stdio: 'pipe',
    })
    const archives = NodeFS.readdirSync(packDirectory).filter((entry) => entry.endsWith('.tgz'))
    assert.equal(archives.length, 1)
    assertPackedServerArchive(NodePath.join(packDirectory, archives[0]!))
  }
  finally
  {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true })
  }
})
