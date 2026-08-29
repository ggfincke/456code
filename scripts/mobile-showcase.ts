#!/usr/bin/env node
// scripts/mobile-showcase.ts
// run the mobile showcase repository workflow

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator automation uses Node subprocess and timing APIs directly.
import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeNet from 'node:net'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'

import showcaseConfig, {
  type ShowcaseAppearance,
  type ShowcaseConfig,
  type ShowcaseDevice,
  type ShowcaseIosDevice,
  SHOWCASE_SCENES,
  type ShowcaseScene,
} from './mobile-showcase.config.ts'
import {
  SHOWCASE_ENVIRONMENTS,
  SHOWCASE_PROJECTS,
  seedShowcaseEnvironment,
} from './mobile-showcase-environment.ts'
import {
  normalizeStorePng,
  showcaseCaptureDirectory,
  validateStoreAsset,
  validateStoreAssetCount,
} from './lib/showcase-assets.ts'
import {
  parsePairingCredentialOutput,
  parseShowcaseCliArgs,
  planShowcaseCaptures,
  selectLanIpv4Address,
  type ShowcaseCapture,
} from './lib/showcase-plan.ts'

export {
  normalizeStorePng,
  readPngDimensions,
  readPngMetadata,
  showcaseCaptureDirectory,
  validateStoreAsset,
  validateStoreAssetCount,
} from './lib/showcase-assets.ts'
export {
  parsePairingCredentialOutput,
  parseShowcaseCliArgs,
  planShowcaseCaptures,
  selectLanIpv4Address,
  showcaseSceneUrl,
  type ShowcaseCapture,
} from './lib/showcase-plan.ts'

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..')
const MOBILE_ROOT = NodePath.join(REPO_ROOT, 'apps/mobile')
const IOS_BUNDLE_ID = 'com.ggfincke.code456.dev'
const IOS_READY_FILENAME = 'Code456ShowcaseReadyScene'
const SERVER_HOST = '0.0.0.0'
const IOS_SIMULATOR_ARCH = NodeProcess.arch === 'arm64' ? 'arm64' : 'x86_64'
const IOS_APP_PATH = NodePath.join(
  MOBILE_ROOT,
  '.showcase/ios-derived-data/Build/Products/Debug-iphonesimulator/456codeDev.app',
)
const MOBILE_BUILD_ENV = {
  ...NodeProcess.env,
  APP_VARIANT: 'development',
  EXPO_NO_GIT_STATUS: '1',
  NODE_ENV: 'development',
}

interface IosCaptureCleanup
{
  readonly udid: string
  readonly startedByRunner: boolean
  readonly createdByRunner: boolean
}

function lanIpv4Address(): string
{
  const address = selectLanIpv4Address(
    Object.values(NodeOS.networkInterfaces()).flatMap((addresses) => addresses ?? []),
  )
  if (!address)
  {
    throw new Error('No LAN IPv4 address is available for the iOS Simulator to reach Metro.')
  }
  return address
}

async function finalizeCapture(destination: string, device: ShowcaseDevice): Promise<void>
{
  const normalized = normalizeStorePng(await NodeFSP.readFile(destination))
  await NodeFSP.writeFile(destination, normalized)
  const metadata = validateStoreAsset(device.storeAsset, normalized, NodePath.basename(destination))
  NodeProcess.stdout.write(
    `Captured ${NodePath.relative(REPO_ROOT, destination)} (${metadata.width}×${metadata.height}, 24-bit RGB, validated for ${device.storeAsset.store})\n`,
  )
}

async function validateCaptureSet(
  capture: ShowcaseCapture,
  outputDirectory: string,
  requireMinimum: boolean,
): Promise<void>
{
  const directory = showcaseCaptureDirectory(outputDirectory, capture)
  const files = (await NodeFSP.readdir(directory)).filter((file) => file.endsWith('.png')).sort()
  const expectedFiles = capture.scenes.map((scene) => `${scene}.png`).sort()
  const missingFiles = expectedFiles.filter((file) => !files.includes(file))
  if (missingFiles.length > 0)
  {
    throw new Error(`${capture.device.id} is missing ${missingFiles.join(', ')} in ${directory}.`)
  }
  validateStoreAssetCount(capture.device.storeAsset, files.length, requireMinimum)
  for (const file of files)
  {
    const bytes = await NodeFSP.readFile(NodePath.join(directory, file))
    validateStoreAsset(capture.device.storeAsset, bytes, `${capture.device.id}/${file}`)
  }
  NodeProcess.stdout.write(
    `Validated ${files.length} upload-ready ${capture.device.storeAsset.store} screenshots in ${NodePath.relative(REPO_ROOT, directory)}/\n`,
  )
}

function printUsage(config: ShowcaseConfig): void
{
  NodeProcess.stdout.write(`App screenshot showcase

Usage:
  pnpm --filter @t3tools/mobile screenshots [options]

Options:
  --platform ios              Capture iOS
  --device <id>              Capture one configured device (repeatable)
  --scene <name>             Capture one scene (repeatable)
  --appearance light|dark|both
                             Override the configured appearance
  --skip-build               Reuse the existing simulator app
  --skip-metro               Reuse an already running showcase Metro server
  --keep-running             Leave simulators and Metro running after capture
  --validate-only            Validate existing upload assets without capturing
  --list                     Print this help and the configured matrix

Scenes: ${SHOWCASE_SCENES.join(', ')}

Configured devices:
${config.devices
  .map(
    (device) =>
      `  ${device.id.padEnd(18)} ${device.platform.padEnd(8)} ${device.simulator} -> ${device.storeAsset.directory}/{light|dark} (${device.storeAsset.width}×${device.storeAsset.height}, default ${device.appearance}) [${device.scenes.join(', ')}]`,
  )
  .join('\n')}
`)
}

function spawnProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions = {},
): NodeChildProcess.ChildProcess
{
  return NodeChildProcess.spawn(command, args, {
    cwd: REPO_ROOT,
    env: NodeProcess.env,
    stdio: 'inherit',
    ...options,
  })
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions = {},
): Promise<void>
{
  await new Promise<void>((resolve, reject) =>
  {
    const child = spawnProcess(command, args, options)
    child.once('error', reject)
    child.once('exit', (code, signal) =>
    {
      if (code === 0)
      {
        resolve()
      }
      else
      {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed ${signal ? `with signal ${signal}` : `with code ${String(code)}`}.`,
          ),
        )
      }
    })
  })
}

async function commandOutput(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.ExecFileOptions = {},
): Promise<string>
{
  return await new Promise<string>((resolve, reject) =>
  {
    NodeChildProcess.execFile(
      command,
      [...args],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options },
      (error, stdout) =>
      {
        if (error) reject(error)
        else resolve(String(stdout))
      },
    )
  })
}

function delay(milliseconds: number): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function stopProcess(child: NodeChildProcess.ChildProcess): Promise<void>
{
  if (child.exitCode !== null || child.signalCode !== null) return

  const exited = new Promise<void>((resolve) =>
  {
    child.once('exit', () => resolve())
  })
  child.kill('SIGTERM')
  await Promise.race([exited, delay(5_000)])
  if (child.exitCode !== null || child.signalCode !== null) return

  child.kill('SIGKILL')
  await Promise.race([exited, delay(1_000)])
}

async function waitForPort(port: number, label = 'Process', timeoutMs = 60_000): Promise<void>
{
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline)
  {
    const open = await new Promise<boolean>((resolve) =>
    {
      const socket = NodeNet.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () =>
      {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.setTimeout(500, () =>
      {
        socket.destroy()
        resolve(false)
      })
    })
    if (open) return
    await delay(500)
  }
  throw new Error(`${label} did not begin listening on port ${port} within ${timeoutMs}ms.`)
}

async function reserveAvailablePort(): Promise<number>
{
  return await new Promise<number>((resolve, reject) =>
  {
    const server = NodeNet.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () =>
    {
      const address = server.address()
      if (!address || typeof address === 'string')
      {
        server.close()
        reject(new Error('Could not reserve a local port for the showcase environment.'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function createShowcaseShell(baseDir: string): Promise<string>
{
  const shellPath = NodePath.join(baseDir, 'showcase-shell')
  await NodeFSP.writeFile(
    shellPath,
    `#!/bin/sh
if [ "$1" = "-ilc" ] || [ "$1" = "-lic" ]; then
  exec /bin/sh -c "$2"
fi
exec /bin/cat
`,
    { mode: 0o755 },
  )
  return shellPath
}

async function createShowcaseLabelProbe(baseDir: string, label: string): Promise<string>
{
  const binDirectory = NodePath.join(baseDir, 'showcase-bin')
  await NodeFSP.mkdir(binDirectory, { recursive: true })
  const probeScript = `#!/bin/sh
if [ "$1" = "--get" ] && [ "$2" = "ComputerName" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
if [ "$1" = "--pretty" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
exit 1
`
  await Promise.all(
    ['scutil', 'hostnamectl'].map((executable) =>
      NodeFSP.writeFile(NodePath.join(binDirectory, executable), probeScript, { mode: 0o755 }),
    ),
  )
  return binDirectory
}

function startShowcaseServer(
  baseDir: string,
  workspaceRoot: string,
  port: number,
  shellPath: string,
  labelProbeDirectory: string,
): NodeChildProcess.ChildProcess
{
  return spawnProcess(
    'node',
    [
      'apps/server/src/bin.ts',
      'serve',
      '--host',
      SERVER_HOST,
      '--port',
      String(port),
      '--base-dir',
      baseDir,
      '--no-browser',
      '--log-level',
      'error',
      workspaceRoot,
    ],
    {
      env: {
        ...NodeProcess.env,
        PATH: `${labelProbeDirectory}:${NodeProcess.env.PATH ?? ''}`,
        SHELL: shellPath,
      },
    },
  )
}

async function issuePairingCredential(baseDir: string): Promise<string>
{
  const output = await commandOutput(
    'node',
    ['apps/server/src/bin.ts', 'auth', 'pairing', 'create', '--base-dir', baseDir, '--json'],
    { env: { ...NodeProcess.env, NO_COLOR: '1' } },
  )
  return parsePairingCredentialOutput(output)
}

function buildShowcasePairingUrl(host: string, port: number, credential: string): string
{
  const url = new URL(`http://${host}:${port}/`)
  url.hash = new URLSearchParams([['token', credential]]).toString()
  return url.toString()
}

function startMetro(config: ShowcaseConfig): NodeChildProcess.ChildProcess
{
  return spawnProcess(
    'pnpm',
    ['exec', 'expo', 'start', '--dev-client', '--port', String(config.metroPort)],
    {
      cwd: MOBILE_ROOT,
      env: {
        ...MOBILE_BUILD_ENV,
        EXPO_PUBLIC_SHOWCASE: '1',
      },
    },
  )
}

async function warmMetroBundle(
  platform: ShowcaseDevice['platform'],
  host: string,
  config: ShowcaseConfig,
): Promise<void>
{
  const url = `http://${host}:${config.metroPort}/index.bundle?platform=${platform}&dev=true&minify=false`
  await runCommand('curl', ['--fail', '--silent', '--show-error', '--output', '/dev/null', url])
}

async function buildIos(): Promise<string>
{
  const derivedData = NodePath.join(MOBILE_ROOT, '.showcase/ios-derived-data')
  await runCommand('pnpm', ['exec', 'expo', 'prebuild', '--clean', '--platform', 'ios'], {
    cwd: MOBILE_ROOT,
    env: MOBILE_BUILD_ENV,
  })
  await runCommand(
    'xcodebuild',
    [
      '-workspace',
      NodePath.join(MOBILE_ROOT, 'ios/456codeDev.xcworkspace'),
      '-scheme',
      '456codeDev',
      '-configuration',
      'Debug',
      '-sdk',
      'iphonesimulator',
      '-derivedDataPath',
      derivedData,
      '-quiet',
      `ARCHS=${IOS_SIMULATOR_ARCH}`,
      'ONLY_ACTIVE_ARCH=YES',
      'build',
    ],
    { cwd: MOBILE_ROOT, env: MOBILE_BUILD_ENV },
  )
  return IOS_APP_PATH
}

async function existingArtifact(path: string): Promise<string | null>
{
  return await NodeFSP.access(path).then(
    () => path,
    () => null,
  )
}

interface SimctlDevice
{
  readonly name: string
  readonly udid: string
  readonly state: 'Booted' | 'Shutdown' | string
  readonly isAvailable: boolean
}

async function findIosSimulator(name: string): Promise<SimctlDevice | null>
{
  const parsed = JSON.parse(
    await commandOutput('xcrun', ['simctl', 'list', 'devices', 'available', '-j']),
  ) as {
    readonly devices: Readonly<Record<string, ReadonlyArray<SimctlDevice>>>
  }
  const candidates = Object.entries(parsed.devices)
    .filter(([runtime]) => runtime.includes('iOS'))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.isAvailable && device.name === name)
  return candidates.at(-1) ?? null
}

async function ensureIosSimulator(device: ShowcaseIosDevice): Promise<{
  readonly simulator: SimctlDevice
  readonly createdByRunner: boolean
}>
{
  const existing = await findIosSimulator(device.simulator)
  if (existing) return { simulator: existing, createdByRunner: false }
  if (!device.simulatorDeviceType)
  {
    throw new Error(
      `iOS simulator '${device.simulator}' is not installed and has no simulatorDeviceType configured.`,
    )
  }
  const udid = (
    await commandOutput('xcrun', ['simctl', 'create', device.simulator, device.simulatorDeviceType])
  ).trim()
  if (!udid) throw new Error(`Could not create iOS simulator '${device.simulator}'.`)
  return {
    simulator: {
      name: device.simulator,
      udid,
      state: 'Shutdown',
      isAvailable: true,
    },
    createdByRunner: true,
  }
}

async function normalizeIosSimulator(appearance: ShowcaseAppearance, udid: string): Promise<void>
{
  await runCommand('xcrun', ['simctl', 'ui', udid, 'appearance', appearance])
  await runCommand('xcrun', [
    'simctl',
    'status_bar',
    udid,
    'override',
    '--time',
    '9:41',
    '--batteryState',
    'charged',
    '--batteryLevel',
    '100',
    '--wifiBars',
    '3',
    '--cellularBars',
    '4',
  ])
}

async function iosAppContainer(udid: string): Promise<string>
{
  return (
    await commandOutput('xcrun', ['simctl', 'get_app_container', udid, IOS_BUNDLE_ID, 'data'])
  ).trim()
}

async function waitForIosShowcaseScene(
  udid: string,
  scene: ShowcaseScene,
  timeoutMs = 90_000,
): Promise<void>
{
  const readyPath = NodePath.join(await iosAppContainer(udid), 'Library/Caches', IOS_READY_FILENAME)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline)
  {
    const readyScene = await NodeFSP.readFile(readyPath, 'utf8').catch(() => '')
    if (readyScene.trim() === scene) return
    await delay(500)
  }
  throw new Error(`iOS showcase scene '${scene}' did not render within ${timeoutMs}ms.`)
}

async function captureIos(
  capture: ShowcaseCapture & { readonly device: ShowcaseIosDevice },
  appPath: string | null,
  outputDirectory: string,
  config: ShowcaseConfig,
  metroHost: string,
  pairingUrls: ReadonlyArray<string>,
  registerCleanup: (cleanup: IosCaptureCleanup) => void,
): Promise<void>
{
  const { simulator, createdByRunner } = await ensureIosSimulator(capture.device)
  const startedByRunner = simulator.state !== 'Booted'
  registerCleanup({ udid: simulator.udid, startedByRunner, createdByRunner })
  if (!startedByRunner)
  {
    // clear transient SpringBoard state (permission prompts, stale URL-open
    // confirmations, keyboards) without erasing the developer's simulator.
    await runCommand('xcrun', ['simctl', 'shutdown', simulator.udid])
  }
  await runCommand('xcrun', ['simctl', 'boot', simulator.udid])
  await runCommand('xcrun', ['simctl', 'bootstatus', simulator.udid, '-b'])
  await normalizeIosSimulator(capture.appearance, simulator.udid)
  if (appPath)
  {
    await runCommand('xcrun', ['simctl', 'uninstall', simulator.udid, IOS_BUNDLE_ID]).catch(
      () => undefined,
    )
    await runCommand('xcrun', ['simctl', 'install', simulator.udid, appPath])
  }

  for (const [key, value] of [
    ['EXDevMenuIsOnboardingFinished', 'true'],
    ['EXDevMenuShowFloatingActionButton', 'false'],
    ['EXDevMenuShowsAtLaunch', 'false'],
  ] as const)
  {
    await runCommand('xcrun', [
      'simctl',
      'spawn',
      simulator.udid,
      'defaults',
      'write',
      IOS_BUNDLE_ID,
      key,
      '-bool',
      value,
    ])
  }

  const metroUrl = `http://${metroHost}:${config.metroPort}?disableOnboarding=1`
  const scenePath = NodePath.join(
    await iosAppContainer(simulator.udid),
    'Library/Caches/Code456ShowcaseScene',
  )
  const readyPath = NodePath.join(
    await iosAppContainer(simulator.udid),
    'Library/Caches',
    IOS_READY_FILENAME,
  )
  const firstScene = capture.scenes[0] ?? 'threads'
  const launchShowcaseApp = async (terminateRunningProcess: boolean) =>
  {
    await runCommand('xcrun', [
      'simctl',
      'launch',
      ...(terminateRunningProcess ? ['--terminate-running-process'] : []),
      simulator.udid,
      IOS_BUNDLE_ID,
      '--initialUrl',
      metroUrl,
      '--showcasePairingUrl',
      JSON.stringify(pairingUrls),
      '--showcaseScene',
      firstScene,
    ])
  }
  await NodeFSP.rm(readyPath, { force: true })
  await NodeFSP.writeFile(scenePath, firstScene)
  await launchShowcaseApp(false)
  for (const [sceneIndex, scene] of capture.scenes.entries())
  {
    if (sceneIndex > 0) await NodeFSP.rm(readyPath, { force: true })
    await NodeFSP.writeFile(scenePath, scene)
    if (sceneIndex === 0)
    {
      for (let attempt = 0; attempt < 2; attempt += 1)
      {
        const isLastAttempt = attempt === 1
        try
        {
          // a freshly installed Expo development build can spend well over 30s
          // applying an already-bundled update after it reaches 100%. Killing it
          // at that point sends the next capture back to the dev launcher.
          await waitForIosShowcaseScene(simulator.udid, scene, 120_000)
          break
        }
        catch (error)
        {
          if (isLastAttempt) throw error
          await launchShowcaseApp(true)
        }
      }
    }
    else
    {
      await waitForIosShowcaseScene(simulator.udid, scene)
    }
    await delay(scene === 'review' ? Math.max(config.settleDelayMs, 8_000) : config.settleDelayMs)
    const destination = NodePath.join(
      showcaseCaptureDirectory(outputDirectory, capture),
      `${scene}.png`,
    )
    await runCommand('xcrun', ['simctl', 'io', simulator.udid, 'screenshot', destination])
    await finalizeCapture(destination, capture.device)
  }
}

async function main(): Promise<void>
{
  const options = parseShowcaseCliArgs(NodeProcess.argv.slice(2))
  if (options.list)
  {
    printUsage(showcaseConfig)
    return
  }
  const captures = planShowcaseCaptures(showcaseConfig, options)
  const outputDirectory = NodePath.resolve(REPO_ROOT, showcaseConfig.outputDirectory)
  if (options.validateOnly)
  {
    for (const capture of captures)
    {
      await validateCaptureSet(
        capture,
        outputDirectory,
        capture.scenes.length === capture.device.scenes.length,
      )
    }
    return
  }
  const metroHost = lanIpv4Address()
  await NodeFSP.mkdir(outputDirectory, { recursive: true })
  for (const capture of captures)
  {
    const directory = showcaseCaptureDirectory(outputDirectory, capture)
    await NodeFSP.rm(directory, { recursive: true, force: true })
    await NodeFSP.mkdir(directory, { recursive: true })
  }

  const showcaseRootDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), 't3-mobile-showcase-'),
  )
  const showcaseServers: NodeChildProcess.ChildProcess[] = []
  const showcaseEnvironments: Array<{
    readonly baseDir: string
    readonly environmentId: string
    readonly label: string
    readonly port: number
  }> = []
  let metro: NodeChildProcess.ChildProcess | null = null
  const iosCleanups: IosCaptureCleanup[] = []

  try
  {
    for (const environment of SHOWCASE_ENVIRONMENTS)
    {
      const projectId = environment.projectIds[0]
      const project = SHOWCASE_PROJECTS.find((candidate) => candidate.id === projectId)
      if (!project) throw new Error(`Showcase environment '${environment.id}' has no project.`)

      const baseDir = NodePath.join(showcaseRootDir, 'environments', environment.id)
      const workspaceRoot = NodePath.join(baseDir, 'workspace', project.directory)
      const port = await reserveAvailablePort()
      await NodeFSP.mkdir(workspaceRoot, { recursive: true })
      const shellPath = await createShowcaseShell(baseDir)
      const labelProbeDirectory = await createShowcaseLabelProbe(baseDir, environment.label)
      const server = startShowcaseServer(
        baseDir,
        workspaceRoot,
        port,
        shellPath,
        labelProbeDirectory,
      )
      showcaseServers.push(server)
      await waitForPort(port, `${environment.label} server`)
      await seedShowcaseEnvironment({ baseDir, projectIds: environment.projectIds })
      const environmentId = (
        await NodeFSP.readFile(NodePath.join(baseDir, 'userdata', 'environment-id'), 'utf8')
      ).trim()
      if (!environmentId)
      {
        throw new Error(`${environment.label} did not persist an environment id.`)
      }
      showcaseEnvironments.push({ baseDir, environmentId, label: environment.label, port })
    }

    if (!options.skipMetro)
    {
      metro = startMetro(showcaseConfig)
      await waitForPort(showcaseConfig.metroPort, 'Metro')
      await warmMetroBundle('ios', metroHost, showcaseConfig)
    }

    const iosAppPath = options.skipBuild ? await existingArtifact(IOS_APP_PATH) : await buildIos()

    for (const capture of captures)
    {
      const pairingUrls = await Promise.all(
        showcaseEnvironments.map(async (environment) =>
        {
          const credential = await issuePairingCredential(environment.baseDir)
          return buildShowcasePairingUrl('127.0.0.1', environment.port, credential)
        }),
      )
      await captureIos(
        capture as ShowcaseCapture & { readonly device: ShowcaseIosDevice },
        iosAppPath,
        outputDirectory,
        showcaseConfig,
        metroHost,
        pairingUrls,
        (cleanup) => iosCleanups.push(cleanup),
      )
      await validateCaptureSet(
        capture,
        outputDirectory,
        capture.scenes.length === capture.device.scenes.length,
      )
    }

    NodeProcess.stdout.write(
      `\nDone. Upload-ready screenshots are in ${NodePath.relative(REPO_ROOT, outputDirectory)}/apple/.\n`,
    )
    if (options.keepRunning)
    {
      const serverSummary = showcaseEnvironments
        .map((environment) => `${environment.label}:${environment.port}`)
        .join(', ')
      NodeProcess.stdout.write(
        `Showcase environments kept at ${showcaseRootDir} (${serverSummary}).\n`,
      )
    }
  }
  finally
  {
    if (options.keepRunning)
    {
      metro?.unref()
      for (const server of showcaseServers) server.unref()
    }
    else
    {
      for (const cleanup of iosCleanups)
      {
        if (cleanup.startedByRunner || cleanup.createdByRunner)
        {
          await runCommand('xcrun', ['simctl', 'shutdown', cleanup.udid]).catch(() => undefined)
        }
        if (cleanup.createdByRunner)
        {
          await runCommand('xcrun', ['simctl', 'delete', cleanup.udid]).catch(() => undefined)
        }
      }
      await Promise.all([
        ...(metro ? [stopProcess(metro)] : []),
        ...showcaseServers.map((server) => stopProcess(server)),
      ])
      await NodeFSP.rm(showcaseRootDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
    }
  }
}

if (import.meta.main)
{
  void main().catch((error: unknown) =>
  {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    NodeProcess.exit(1)
  })
}
