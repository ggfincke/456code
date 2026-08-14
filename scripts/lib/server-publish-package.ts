// scripts/lib/server-publish-package.ts
// stage the npm server package with its private Cartographer runtime

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

import { resolveCatalogDependencies } from './resolve-catalog.ts'

export const CARTOGRAPHER_CORE_PACKAGE_NAME = '@t3tools/cartographer-core'
export const SERVER_PUBLISH_REPOSITORY_URL = 'https://github.com/ggfincke/456code'

interface RepositoryManifest
{
  readonly type: string
  readonly url: string
  readonly directory: string
}

export interface ServerPublishSourceManifest
{
  readonly name: string
  readonly license?: string
  readonly repository: RepositoryManifest
  readonly bin: Readonly<Record<string, string>>
  readonly type: string
  readonly version: string
  readonly engines: Readonly<Record<string, string>>
  readonly files: ReadonlyArray<string>
  readonly dependencies: Readonly<Record<string, string>>
}

export interface CartographerCorePublishSourceManifest
{
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly license?: string
  readonly bin: Readonly<Record<string, string>>
  readonly type: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly engines: Readonly<Record<string, string>>
}

export interface ServerPublishPackageManifest
{
  readonly name: string
  readonly license?: string
  readonly repository: RepositoryManifest
  readonly bin: Readonly<Record<string, string>>
  readonly type: string
  readonly version: string
  readonly engines: Readonly<Record<string, string>>
  readonly files: ReadonlyArray<string>
  readonly dependencies: Readonly<Record<string, string>>
  readonly bundleDependencies: ReadonlyArray<string>
}

export interface CartographerCorePublishPackageManifest
{
  readonly name: string
  readonly version: string
  readonly private: true
  readonly description?: string
  readonly license?: string
  readonly bin: Readonly<Record<string, string>>
  readonly type: string
  readonly files: ReadonlyArray<string>
  readonly exports: Readonly<Record<string, unknown>>
  readonly dependencies: Readonly<Record<string, string>>
  readonly engines: Readonly<Record<string, string>>
}

export interface CreateServerPublishManifestOptions
{
  readonly version: string
  readonly serverManifest: ServerPublishSourceManifest
  readonly cartographerCoreManifest: CartographerCorePublishSourceManifest
  readonly workspaceCatalog: Readonly<Record<string, string>>
}

export interface StageServerPublishPackageOptions extends CreateServerPublishManifestOptions
{
  readonly repoRoot: string
  readonly stageDirectory: string
  readonly cartographerDependencyClosureDirectory: string
}

export interface StagedServerPublishPackage
{
  readonly stageDirectory: string
  readonly packageJsonPath: string
  readonly cartographerCoreDirectory: string
}

interface InstalledPackageManifest
{
  readonly name: string
  readonly version: string
}

const CARTOGRAPHER_CORE_PUBLISH_EXPORTS = {
  './package.json': './package.json',
  '.': {
    types: './dist/index.d.ts',
    import: './dist/index.js',
  },
  './contracts': {
    types: './dist/contracts/index.d.ts',
    import: './dist/contracts/index.js',
  },
  './server': {
    types: './dist/server.d.ts',
    import: './dist/server.js',
  },
} as const

export function createCartographerCorePublishManifest(
  sourceManifest: CartographerCorePublishSourceManifest,
  workspaceCatalog: Readonly<Record<string, string>>,
): CartographerCorePublishPackageManifest
{
  if (sourceManifest.name !== CARTOGRAPHER_CORE_PACKAGE_NAME)
  {
    throw new Error(
      `Expected Cartographer core package name '${CARTOGRAPHER_CORE_PACKAGE_NAME}', received '${sourceManifest.name}'.`,
    )
  }

  return {
    name: sourceManifest.name,
    version: sourceManifest.version,
    private: true,
    ...(sourceManifest.description === undefined
      ? {}
      : { description: sourceManifest.description }),
    ...(sourceManifest.license === undefined ? {} : { license: sourceManifest.license }),
    bin: sourceManifest.bin,
    type: sourceManifest.type,
    files: ['dist', 'LICENSE'],
    exports: CARTOGRAPHER_CORE_PUBLISH_EXPORTS,
    dependencies: resolveCatalogDependencies(
      { ...sourceManifest.dependencies },
      { ...workspaceCatalog },
      'packages/cartographer-core',
    ),
    engines: sourceManifest.engines,
  }
}

export function createServerPublishManifest(
  options: CreateServerPublishManifestOptions,
): ServerPublishPackageManifest
{
  const dependencies = resolveCatalogDependencies(
    { ...options.serverManifest.dependencies },
    { ...options.workspaceCatalog },
    'apps/server',
  )

  dependencies[CARTOGRAPHER_CORE_PACKAGE_NAME] = options.cartographerCoreManifest.version

  return {
    name: options.serverManifest.name,
    ...(options.serverManifest.license === undefined
      ? {}
      : { license: options.serverManifest.license }),
    repository: {
      ...options.serverManifest.repository,
      url: SERVER_PUBLISH_REPOSITORY_URL,
    },
    bin: options.serverManifest.bin,
    type: options.serverManifest.type,
    version: options.version,
    engines: options.serverManifest.engines,
    files: options.serverManifest.files,
    dependencies,
    bundleDependencies: [CARTOGRAPHER_CORE_PACKAGE_NAME],
  }
}

function readInstalledPackageManifest(
  cartographerCoreDirectory: string,
  dependencyName: string,
): InstalledPackageManifest
{
  const manifestPath = NodePath.join(
    cartographerCoreDirectory,
    'node_modules',
    ...dependencyName.split('/'),
    'package.json',
  )
  const value = JSON.parse(
    NodeFS.readFileSync(manifestPath, 'utf8'),
  ) as Partial<InstalledPackageManifest>

  if (typeof value.name !== 'string' || typeof value.version !== 'string')
  {
    throw new Error(`Installed Cartographer dependency has invalid metadata: ${manifestPath}`)
  }

  return value as InstalledPackageManifest
}

function pinInstalledDependency(
  dependencyName: string,
  sourceSpec: string,
  installed: InstalledPackageManifest,
): string
{
  if (sourceSpec.startsWith('npm:'))
  {
    const versionSeparator = sourceSpec.lastIndexOf('@')
    const packageName = sourceSpec.slice('npm:'.length, versionSeparator)
    if (versionSeparator <= 'npm:'.length || installed.name !== packageName)
    {
      throw new Error(
        `Installed Cartographer dependency '${dependencyName}' does not match alias '${sourceSpec}'.`,
      )
    }
    return `npm:${packageName}@${installed.version}`
  }

  if (installed.name !== dependencyName)
  {
    throw new Error(
      `Installed Cartographer dependency '${dependencyName}' resolved to '${installed.name}'.`,
    )
  }
  return installed.version
}

export function pinStagedCartographerDependencyVersions(
  cartographerCoreDirectory: string,
  dependencies: Readonly<Record<string, string>>,
): Record<string, string>
{
  return Object.fromEntries(
    Object.entries(dependencies).map(([dependencyName, sourceSpec]) =>
    {
      const installed = readInstalledPackageManifest(cartographerCoreDirectory, dependencyName)
      return [dependencyName, pinInstalledDependency(dependencyName, sourceSpec, installed)]
    }),
  )
}

export function stageServerPublishPackage(
  options: StageServerPublishPackageOptions,
): StagedServerPublishPackage
{
  const serverDistSource = NodePath.join(options.repoRoot, 'apps/server/dist')
  const cartographerCoreRoot = NodePath.join(options.repoRoot, 'packages/cartographer-core')
  const cartographerCoreDistSource = NodePath.join(cartographerCoreRoot, 'dist')
  const cartographerCoreLicenseSource = NodePath.join(cartographerCoreRoot, 'LICENSE')
  const packageJsonPath = NodePath.join(options.stageDirectory, 'package.json')
  const cartographerCoreDirectory = NodePath.join(
    options.stageDirectory,
    'node_modules',
    '@t3tools',
    'cartographer-core',
  )

  NodeFS.mkdirSync(options.stageDirectory, { recursive: true })
  NodeFS.cpSync(serverDistSource, NodePath.join(options.stageDirectory, 'dist'), {
    recursive: true,
  })
  NodeFS.mkdirSync(cartographerCoreDirectory, { recursive: true })
  NodeFS.cpSync(cartographerCoreDistSource, NodePath.join(cartographerCoreDirectory, 'dist'), {
    recursive: true,
  })
  NodeFS.copyFileSync(
    cartographerCoreLicenseSource,
    NodePath.join(cartographerCoreDirectory, 'LICENSE'),
  )
  NodeFS.cpSync(
    options.cartographerDependencyClosureDirectory,
    NodePath.join(cartographerCoreDirectory, 'node_modules'),
    { recursive: true },
  )

  const serverManifest = createServerPublishManifest(options)
  const unresolvedCartographerCoreManifest = createCartographerCorePublishManifest(
    options.cartographerCoreManifest,
    options.workspaceCatalog,
  )
  const cartographerCoreManifest: CartographerCorePublishPackageManifest = {
    ...unresolvedCartographerCoreManifest,
    dependencies: pinStagedCartographerDependencyVersions(
      cartographerCoreDirectory,
      unresolvedCartographerCoreManifest.dependencies,
    ),
  }

  NodeFS.writeFileSync(packageJsonPath, `${JSON.stringify(serverManifest, null, 2)}\n`)
  NodeFS.writeFileSync(
    NodePath.join(cartographerCoreDirectory, 'package.json'),
    `${JSON.stringify(cartographerCoreManifest, null, 2)}\n`,
  )

  return {
    stageDirectory: options.stageDirectory,
    packageJsonPath,
    cartographerCoreDirectory,
  }
}

const REQUIRED_PACKED_CARTOGRAPHER_FILES = [
  'package/node_modules/@t3tools/cartographer-core/package.json',
  'package/node_modules/@t3tools/cartographer-core/dist/index.js',
  'package/node_modules/@t3tools/cartographer-core/dist/contracts/index.js',
  'package/node_modules/@t3tools/cartographer-core/dist/server.js',
  'package/node_modules/@t3tools/cartographer-core/dist/cli/index.js',
  'package/node_modules/@t3tools/cartographer-core/dist/mcp/bin.js',
  'package/node_modules/@t3tools/cartographer-core/dist/mcp/server.js',
  'package/node_modules/@t3tools/cartographer-core/node_modules/@modelcontextprotocol/sdk/package.json',
  'package/node_modules/@t3tools/cartographer-core/node_modules/dependency-cruiser/package.json',
  'package/node_modules/@t3tools/cartographer-core/node_modules/typescript/package.json',
  'package/node_modules/@t3tools/cartographer-core/node_modules/zod/package.json',
] as const

export function assertPackedServerArchive(archivePath: string): void
{
  const result = NodeChildProcess.spawnSync('tar', ['-tf', archivePath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })

  if (result.error)
  {
    throw result.error
  }
  if (result.status !== 0)
  {
    throw new Error(`Unable to inspect packed server archive: ${result.stderr}`)
  }

  const archiveEntries = new Set(result.stdout.split(/\r?\n/u).filter(Boolean))
  const missingFiles = REQUIRED_PACKED_CARTOGRAPHER_FILES.filter(
    (entry) => !archiveEntries.has(entry),
  )
  if (missingFiles.length > 0)
  {
    throw new Error(
      `Packed server archive is missing its Cartographer runtime: ${missingFiles.join(', ')}`,
    )
  }
}
