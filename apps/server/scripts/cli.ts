#!/usr/bin/env node
// apps/server/scripts/cli.ts
// run the cli repository workflow

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Logger from 'effect/Logger'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { Command, Flag } from 'effect/unstable/cli'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import cartographerCorePackageJson from '../../../packages/cartographer-core/package.json' with { type: 'json' }
import {
  DEVELOPMENT_ICON_OVERRIDES,
  resolveWebAssetBrandForPackageVersion,
  resolveWebIconOverrides,
} from '../../../scripts/lib/brand-assets.ts'
import {
  assertPackedServerArchive,
  stageServerPublishPackage,
} from '../../../scripts/lib/server-publish-package.ts'
import { fromYaml } from '@t3tools/shared/schemaYaml'
import { resolveSpawnCommand } from '@t3tools/shared/shell'
import serverPackageJson from '../package.json' with { type: 'json' }
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliPackOutputError,
  ServerCliPublishIconSourceMissingError,
  ServerCliPublishIconTargetMissingError,
} from './cliErrors.ts'

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
type WorkspaceConfig = typeof WorkspaceConfig.Type
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig))

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL('../../..', import.meta.url))),
)

const readWorkspaceConfig = Effect.fn('readWorkspaceConfig')(function* ()
{
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const repoRoot = yield* RepoRoot
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, 'pnpm-workspace.yaml'))
  return yield* decodeWorkspaceConfig(workspaceYaml)
})

const runCommand = Effect.fn('runCommand')(function* (command: ChildProcess.StandardCommand)
{
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(command)
  const exitCode = yield* child.exitCode

  if (exitCode !== 0)
  {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    })
  }
})

const preparePublishIcons = Effect.fn('preparePublishIcons')(function* (
  repoRoot: string,
  serverDir: string,
  version: string,
)
{
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const brand = resolveWebAssetBrandForPackageVersion(version)
  const icons = resolveWebIconOverrides(brand, 'dist/client').map((override) => ({
    sourcePath: path.join(repoRoot, override.sourceRelativePath),
    targetPath: path.join(serverDir, override.targetRelativePath),
    targetRelativePath: override.targetRelativePath,
  }))

  for (const icon of icons)
  {
    if (!(yield* fs.exists(icon.sourcePath)))
    {
      return yield* new ServerCliPublishIconSourceMissingError({ sourcePath: icon.sourcePath })
    }
    if (!(yield* fs.exists(icon.targetPath)))
    {
      return yield* new ServerCliPublishIconTargetMissingError({ targetPath: icon.targetPath })
    }
  }

  return yield* Effect.forEach(icons, (icon) =>
    fs.readFile(icon.sourcePath).pipe(Effect.map((publish) => ({ ...icon, publish }))),
  )
})

const applyDevelopmentIconOverrides = Effect.fn('applyDevelopmentIconOverrides')(function* (
  repoRoot: string,
  serverDir: string,
)
{
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem

  for (const override of DEVELOPMENT_ICON_OVERRIDES)
  {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath)
    const targetPath = path.join(serverDir, override.targetRelativePath)

    if (!(yield* fs.exists(sourcePath)))
    {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath })
    }
    if (!(yield* fs.exists(targetPath)))
    {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath })
    }

    yield* fs.copyFile(sourcePath, targetPath)
  }

  yield* Effect.log('[cli] Applied development icon overrides to dist/client')
})

// build subcommand

const buildCmd = Command.make(
  'build',
  {
    verbose: Flag.boolean('verbose').pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* ()
    {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const repoRoot = yield* RepoRoot
      const serverDir = path.join(repoRoot, 'apps/server')

      yield* Effect.log('[cli] Running tsdown...')
      yield* runCommand(
        ChildProcess.make(process.execPath, ['--run', 'build:bundle'], {
          cwd: serverDir,
          stdout: config.verbose ? 'inherit' : 'ignore',
          stderr: 'inherit',
          shell: false,
        }),
      )

      const webDist = path.join(repoRoot, 'apps/web/dist')
      const clientTarget = path.join(serverDir, 'dist/client')

      if (yield* fs.exists(webDist))
      {
        yield* fs.copy(webDist, clientTarget)
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir)
        yield* Effect.log('[cli] Bundled web app into dist/client')
      }
      else
      {
        yield* Effect.logWarning('[cli] Web dist not found — skipping client bundle.')
      }
    }),
).pipe(Command.withDescription('Build the server package (tsdown + bundle web client).'))

// publish subcommand

interface PublishCommandConfig
{
  readonly access: string
  readonly tag: string
  readonly provenance: boolean
  readonly dryRun: boolean
  readonly verbose: boolean
}

const createNpmPublishArgs = (
  config: PublishCommandConfig,
  archivePath: string,
): ReadonlyArray<string> =>
{
  const args = ['publish', archivePath, '--access', config.access, '--tag', config.tag]

  if (config.provenance) args.push('--provenance')
  if (config.dryRun) args.push('--dry-run')
  if (!config.verbose) args.push('--loglevel', 'error')

  return args
}

const publishCmd = Command.make(
  'publish',
  {
    tag: Flag.string('tag').pipe(Flag.withDefault('latest')),
    access: Flag.string('access').pipe(Flag.withDefault('public')),
    appVersion: Flag.string('app-version').pipe(Flag.optional),
    provenance: Flag.boolean('provenance').pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean('dry-run').pipe(Flag.withDefault(false)),
    verbose: Flag.boolean('verbose').pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* ()
    {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const repoRoot = yield* RepoRoot
      const serverDir = path.join(repoRoot, 'apps/server')

      // assert build assets exist
      for (const relPath of [
        'apps/server/dist/bin.mjs',
        'apps/server/dist/client/index.html',
        'packages/cartographer-core/dist/index.js',
        'packages/cartographer-core/dist/contracts/index.js',
        'packages/cartographer-core/dist/server.js',
        'packages/cartographer-core/dist/cli/index.js',
        'packages/cartographer-core/dist/mcp/bin.js',
        'packages/cartographer-core/dist/mcp/server.js',
      ])
      {
        const abs = path.join(repoRoot, relPath)
        if (!(yield* fs.exists(abs)))
        {
          return yield* new ServerCliBuildAssetMissingError({ assetPath: abs })
        }
      }

      const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version)
      const workspaceConfig = yield* readWorkspaceConfig()
      const publishRoot = yield* fs.makeTempDirectoryScoped({ prefix: '456code-npm-publish-' })
      const stageDirectory = path.join(publishRoot, 'package')
      const packDirectory = path.join(publishRoot, 'packed')
      const cartographerDeployDirectory = path.join(publishRoot, 'cartographer-core-deploy')
      const icons = yield* preparePublishIcons(repoRoot, serverDir, version)

      const deployArgs = [
        '--config.node-linker=hoisted',
        '--config.allow-unused-patches=true',
        '--ignore-scripts',
        '--frozen-lockfile',
        '--filter',
        cartographerCorePackageJson.name,
        'deploy',
        '--prod',
        '--legacy',
        cartographerDeployDirectory,
      ]
      const deployCommand = yield* resolveSpawnCommand('pnpm', deployArgs)
      yield* Effect.log('[cli] Staging the lockfile-backed Cartographer dependency closure')
      yield* runCommand(
        ChildProcess.make(deployCommand.command, deployCommand.args, {
          cwd: repoRoot,
          stdout: config.verbose ? 'inherit' : 'ignore',
          stderr: 'inherit',
          shell: deployCommand.shell,
        }),
      )

      stageServerPublishPackage({
        repoRoot,
        stageDirectory,
        version,
        serverManifest: serverPackageJson,
        cartographerCoreManifest: cartographerCorePackageJson,
        workspaceCatalog: workspaceConfig.catalog ?? {},
        cartographerDependencyClosureDirectory: path.join(
          cartographerDeployDirectory,
          'node_modules',
        ),
      })
      for (const icon of icons)
      {
        yield* fs.writeFile(path.join(stageDirectory, icon.targetRelativePath), icon.publish)
      }
      yield* Effect.log('[cli] Staged package metadata, Cartographer runtime, and publish icons')

      yield* fs.makeDirectory(packDirectory, { recursive: true })
      const packArgs = [
        'pack',
        '--pack-destination',
        packDirectory,
        ...(config.verbose ? [] : ['--loglevel', 'error']),
      ]
      const packCommand = yield* resolveSpawnCommand('npm', packArgs)
      yield* Effect.log(`[cli] Running: npm ${packArgs.join(' ')}`)
      yield* runCommand(
        ChildProcess.make(packCommand.command, packCommand.args, {
          cwd: stageDirectory,
          stdout: config.verbose ? 'inherit' : 'ignore',
          stderr: 'inherit',
          shell: packCommand.shell,
        }),
      )

      const archiveFiles = (yield* fs.readDirectory(packDirectory)).filter((entry) =>
        entry.endsWith('.tgz'),
      )
      if (archiveFiles.length !== 1)
      {
        return yield* new ServerCliPackOutputError({ packDirectory, archiveFiles })
      }
      const archivePath = path.join(packDirectory, archiveFiles[0]!)
      assertPackedServerArchive(archivePath)

      const smokeScript = path.join(repoRoot, 'scripts/smoke-packed-cli.ts')
      yield* Effect.log('[cli] Validating the exact packed archive in clean npm and pnpm consumers')
      yield* runCommand(
        ChildProcess.make(process.execPath, [smokeScript, '--archive', archivePath], {
          cwd: repoRoot,
          stdout: config.verbose ? 'inherit' : 'ignore',
          stderr: 'inherit',
          shell: false,
        }),
      )
      yield* Effect.log('[cli] Exact packed archive validation passed')

      const publishArgs = createNpmPublishArgs(config, archivePath)
      const publishCommand = yield* resolveSpawnCommand('npm', publishArgs)
      yield* Effect.log(`[cli] Running: npm ${publishArgs.join(' ')}`)
      yield* runCommand(
        ChildProcess.make(publishCommand.command, publishCommand.args, {
          cwd: publishRoot,
          stdout: config.verbose ? 'inherit' : 'ignore',
          stderr: 'inherit',
          shell: publishCommand.shell,
        }),
      )
      yield* Effect.log(
        config.dryRun ? '[cli] npm publish dry run passed' : '[cli] npm publish passed',
      )
    }),
).pipe(Command.withDescription('Publish the server package to npm.'))

// root command

const cli = Command.make('cli').pipe(
  Command.withDescription('T3 server build & publish CLI.'),
  Command.withSubcommands([buildCmd, publishCmd]),
)

Command.run(cli, { version: '0.0.0' }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
)
