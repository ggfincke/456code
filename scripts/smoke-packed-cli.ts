#!/usr/bin/env node
// scripts/smoke-packed-cli.ts
// verify the exact packed 456code artifact in clean consumers

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off globalDate:off globalFetch:off
import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeNet from 'node:net'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import * as NodeReadline from 'node:readline'
import * as NodeTimers from 'node:timers'
import { prepareSpawnCommandForPlatform } from '@t3tools/shared/shell'

const SERVER_PACKAGE_NAME = '456code'
const CORE_PACKAGE_NAME = '@t3tools/cartographer-core'
const EXPECTED_REPOSITORY_URL = 'https://github.com/ggfincke/456code'
const EXPECTED_MCP_TOOLS = [
  'graph_repo',
  'graph_diff',
  'list_snapshots',
  'blast_radius',
  'annotate_files',
  'propose_patch',
  'get_patch',
  'list_patches',
] as const
const CORE_REQUIRED_FILES = [
  'LICENSE',
  'package.json',
  'dist/server.js',
  'dist/server.d.ts',
  'dist/cli/index.js',
  'dist/mcp/bin.js',
  'dist/mcp/server.js',
] as const

interface PackageManifest
{
  readonly name?: unknown
  readonly version?: unknown
  readonly url?: unknown
  readonly repository?: unknown
  readonly bin?: unknown
  readonly dependencies?: unknown
  readonly optionalDependencies?: unknown
  readonly peerDependencies?: unknown
  readonly overrides?: unknown
  readonly bundleDependencies?: unknown
  readonly target?: unknown
}

interface PackedCliSmokeOptions
{
  readonly archive: string
}

interface PosixProcessTableEntry
{
  readonly processId: number
  readonly processGroupId: number
}

function readJson(path: string): unknown
{
  return JSON.parse(NodeFS.readFileSync(path, 'utf8')) as unknown
}

function packageManifest(value: unknown, label: string): PackageManifest
{
  NodeAssert.ok(typeof value === 'object' && value !== null, `${label} must be an object`)
  return value as PackageManifest
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>>
{
  NodeAssert.ok(typeof value === 'object' && value !== null, `${label} must be an object`)
  for (const [name, specifier] of Object.entries(value))
  {
    NodeAssert.equal(typeof specifier, 'string', `${label}.${name} must be a string`)
  }
  return value as Readonly<Record<string, string>>
}

function assertNoLocalDependencyProtocols(value: unknown, path: string): void
{
  if (typeof value === 'string')
  {
    NodeAssert.doesNotMatch(
      value,
      /^(?:file|link|workspace):/u,
      `${path} retains a local-only dependency protocol`,
    )
    return
  }
  if (Array.isArray(value))
  {
    value.forEach((entry, index) => assertNoLocalDependencyProtocols(entry, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object' && value !== null)
  {
    for (const [key, entry] of Object.entries(value))
    {
      assertNoLocalDependencyProtocols(entry, `${path}.${key}`)
    }
  }
}

export function assertPackedServerManifest(value: unknown): string
{
  const manifest = packageManifest(value, 'packed 456code package.json')
  NodeAssert.equal(manifest.name, SERVER_PACKAGE_NAME, 'packed package name changed')
  NodeAssert.equal(typeof manifest.version, 'string', 'packed package version is missing')
  NodeAssert.ok((manifest.version as string).length > 0, 'packed package version must not be empty')

  const repository = packageManifest(manifest.repository, 'packed package repository')
  NodeAssert.equal(
    repository.url,
    EXPECTED_REPOSITORY_URL,
    'packed package repository URL is not the canonical 456code repository',
  )

  const bins = stringRecord(manifest.bin, 'packed package bin')
  NodeAssert.equal(bins[SERVER_PACKAGE_NAME], './dist/bin.mjs', 'packed CLI bin changed')

  const dependencies = stringRecord(manifest.dependencies, 'packed package dependencies')
  const coreVersion = dependencies[CORE_PACKAGE_NAME]
  NodeAssert.equal(typeof coreVersion, 'string', 'packed package is missing Cartographer core')
  NodeAssert.match(
    coreVersion!,
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u,
    'packed Cartographer core dependency must use an exact version',
  )
  NodeAssert.deepEqual(
    manifest.bundleDependencies,
    [CORE_PACKAGE_NAME],
    'packed package must bundle exactly Cartographer core',
  )

  for (const [field, entries] of [
    ['dependencies', manifest.dependencies],
    ['optionalDependencies', manifest.optionalDependencies],
    ['peerDependencies', manifest.peerDependencies],
    ['overrides', manifest.overrides],
  ] as const)
  {
    assertNoLocalDependencyProtocols(entries, `packed package ${field}`)
  }

  return coreVersion!
}

export function assertInstalledCoreLayout(serverRoot: string, expectedVersion: string): string
{
  const coreRoot = NodePath.join(serverRoot, 'node_modules', ...CORE_PACKAGE_NAME.split('/'))
  const coreStat = NodeFS.lstatSync(coreRoot)
  NodeAssert.ok(coreStat.isDirectory(), 'bundled Cartographer core is not a directory')
  NodeAssert.ok(!coreStat.isSymbolicLink(), 'bundled Cartographer core must not be a symlink')

  for (const relativePath of CORE_REQUIRED_FILES)
  {
    const filePath = NodePath.join(coreRoot, relativePath)
    const fileStat = NodeFS.lstatSync(filePath)
    NodeAssert.ok(fileStat.isFile(), `bundled Cartographer core file is missing: ${relativePath}`)
    NodeAssert.ok(
      !fileStat.isSymbolicLink(),
      `bundled Cartographer core file must not be a symlink: ${relativePath}`,
    )
  }

  const coreManifest = packageManifest(
    readJson(NodePath.join(coreRoot, 'package.json')),
    'bundled Cartographer core package.json',
  )
  NodeAssert.equal(coreManifest.name, CORE_PACKAGE_NAME, 'bundled core package name changed')
  NodeAssert.equal(
    coreManifest.version,
    expectedVersion,
    'bundled core version does not match the outer exact dependency',
  )
  assertNoLocalDependencyProtocols(coreManifest.dependencies, 'bundled core dependencies')

  const coreDependencies = stringRecord(coreManifest.dependencies, 'bundled core dependencies')
  for (const dependency of Object.keys(coreDependencies))
  {
    const packagePathParts = [...dependency.split('/'), 'package.json']
    let current = coreRoot
    let resolved = false
    while (true)
    {
      if (NodeFS.existsSync(NodePath.join(current, 'node_modules', ...packagePathParts)))
      {
        resolved = true
        break
      }
      const parent = NodePath.dirname(current)
      if (parent === current)
      {
        break
      }
      current = parent
    }
    NodeAssert.ok(resolved, `bundled core runtime dependency is unresolved: ${dependency}`)
  }

  return coreRoot
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// classifies process-group signal errors without hiding a live, inaccessible child
export function canTreatProcessGroupSignalErrorAsExit(
  errorCode: unknown,
  childProcessId: number,
  processTable: ReadonlyArray<PosixProcessTableEntry>,
): boolean
{
  if (errorCode === 'ESRCH')
  {
    return true
  }
  if (errorCode !== 'EPERM')
  {
    return false
  }
  return !processTable.some(
    (entry) => entry.processId === childProcessId || entry.processGroupId === childProcessId,
  )
}

// snapshots pid+group membership so a raced EPERM needs independent exit proof
function readPosixProcessTable(): ReadonlyArray<PosixProcessTableEntry>
{
  const result = NodeChildProcess.spawnSync('ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error)
  {
    throw result.error
  }
  NodeAssert.equal(result.status, 0, `process-table inspection failed:\n${result.stderr}`)

  const entries: PosixProcessTableEntry[] = []
  for (const line of result.stdout.split('\n'))
  {
    const trimmed = line.trim()
    if (trimmed.length === 0)
    {
      continue
    }
    const fields = trimmed.split(/\s+/u)
    NodeAssert.equal(fields.length, 2, `unexpected process-table row: ${trimmed}`)
    const processId = Number(fields[0])
    const processGroupId = Number(fields[1])
    NodeAssert.ok(
      Number.isSafeInteger(processId) && processId > 0,
      `invalid process ID in process-table row: ${trimmed}`,
    )
    NodeAssert.ok(
      Number.isSafeInteger(processGroupId) && processGroupId > 0,
      `invalid process group ID in process-table row: ${trimmed}`,
    )
    entries.push({ processId, processGroupId })
  }
  return entries
}

function executable(name: 'npm' | 'pnpm'): string
{
  return NodeProcess.platform === 'win32' ? `${name}.cmd` : name
}

function runChecked(
  label: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): string
{
  const spawnCommand = prepareSpawnCommandForPlatform(command, args, NodeProcess.platform)
  const result = NodeChildProcess.spawnSync(spawnCommand.command, spawnCommand.args, {
    cwd,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
    shell: spawnCommand.shell,
    windowsHide: true,
  })
  if (result.error)
  {
    throw result.error
  }
  NodeAssert.equal(
    result.status,
    0,
    `${label} failed${result.signal ? ` on ${result.signal}` : ''}:\n` +
      `${result.stderr}${result.stdout}`,
  )
  return result.stdout
}

async function makeConsumer(owner: string, packageManager: 'npm' | 'pnpm'): Promise<string>
{
  const consumer = NodePath.join(owner, `${packageManager}-consumer`)
  await NodeFSP.mkdir(consumer, { recursive: true })
  await NodeFSP.writeFile(
    NodePath.join(consumer, 'package.json'),
    `${JSON.stringify({ name: `${SERVER_PACKAGE_NAME}-${packageManager}-smoke`, private: true, type: 'module' }, null, 2)}\n`,
  )
  return consumer
}

function installArchive(packageManager: 'npm' | 'pnpm', consumer: string, archive: string): void
{
  const args =
    packageManager === 'npm'
      ? ['install', '--no-save', '--no-audit', '--no-fund', archive]
      : ['add', '--save-prod', '--ignore-scripts', archive]
  runChecked(`${packageManager} clean consumer install`, executable(packageManager), args, consumer)
}

function inspectInstalledPackage(consumer: string): { serverRoot: string; coreRoot: string }
{
  const serverRoot = NodePath.join(consumer, 'node_modules', SERVER_PACKAGE_NAME)
  const serverManifestPath = NodePath.join(serverRoot, 'package.json')
  for (const relativePath of ['package.json', 'dist/bin.mjs', 'dist/client/index.html'])
  {
    const filePath = NodePath.join(serverRoot, relativePath)
    const fileStat = NodeFS.lstatSync(filePath)
    NodeAssert.ok(fileStat.isFile(), `installed 456code file is missing: ${relativePath}`)
  }
  const expectedCoreVersion = assertPackedServerManifest(readJson(serverManifestPath))
  const coreRoot = assertInstalledCoreLayout(serverRoot, expectedCoreVersion)
  return { serverRoot, coreRoot }
}

function probeCoreServerExport(serverRoot: string): void
{
  runChecked(
    'bundled Cartographer server export import',
    NodeProcess.execPath,
    [
      '--input-type=module',
      '-e',
      `const server = await import('${CORE_PACKAGE_NAME}/server')
if (typeof server.graphContentDigest !== 'function') throw new Error('server facade lacks graphContentDigest')`,
    ],
    serverRoot,
  )
}

async function waitForCleanExit(
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  label: string,
): Promise<void>
{
  if (child.exitCode !== null)
  {
    NodeAssert.equal(child.exitCode, 0, `${label} exited unsuccessfully`)
    return
  }
  if (child.signalCode !== null)
  {
    throw new Error(`${label} exited on signal ${child.signalCode}`)
  }

  await new Promise<void>((resolve, reject) =>
  {
    const timeout = NodeTimers.setTimeout(() =>
    {
      child.kill('SIGTERM')
      reject(new Error(`${label} did not close after stdin ended`))
    }, 5_000)

    child.once('error', (error) =>
    {
      NodeTimers.clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) =>
    {
      NodeTimers.clearTimeout(timeout)
      if (signal !== null)
      {
        reject(new Error(`${label} exited on signal ${signal}`))
        return
      }
      if (code !== 0)
      {
        reject(new Error(`${label} exited with code ${code}`))
        return
      }
      resolve()
    })
  })
}

async function probeInstalledMcpShim(serverRoot: string, coreRoot: string): Promise<void>
{
  const coreManifest = packageManifest(
    readJson(NodePath.join(coreRoot, 'package.json')),
    'bundled Cartographer core package.json',
  )
  const bins = stringRecord(coreManifest.bin, 'bundled Cartographer core bin')
  const mcpBins = Object.entries(bins).filter(([, target]) => target === './dist/mcp/bin.js')
  NodeAssert.equal(mcpBins.length, 1, 'bundled core must declare one MCP executable bin')
  const mcpBinName = mcpBins[0]![0]
  const shimPath = NodePath.join(
    serverRoot,
    'node_modules',
    '.bin',
    NodeProcess.platform === 'win32' ? `${mcpBinName}.cmd` : mcpBinName,
  )
  NodeAssert.ok(NodeFS.existsSync(shimPath), 'installed Cartographer MCP package shim is missing')

  const spawnCommand = prepareSpawnCommandForPlatform(shimPath, [], NodeProcess.platform)
  const child = NodeChildProcess.spawn(spawnCommand.command, spawnCommand.args, {
    cwd: serverRoot,
    shell: spawnCommand.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  const stdout = NodeReadline.createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  const lines = stdout[Symbol.asyncIterator]()

  const send = (message: Record<string, unknown>): void =>
  {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const readResponse = async (expectedId: number): Promise<Record<string, unknown>> =>
  {
    const read = async (): Promise<Record<string, unknown>> =>
    {
      while (true)
      {
        const line = await lines.next()
        if (line.done)
        {
          throw new Error(
            `installed MCP shim closed before response ${expectedId}: ${stderr.join('').trim()}`,
          )
        }
        if (line.value.trim() === '')
        {
          continue
        }
        const message: unknown = JSON.parse(line.value)
        if (!isRecord(message) || message.id !== expectedId)
        {
          continue
        }
        if ('error' in message)
        {
          throw new Error(`MCP request ${expectedId} failed: ${JSON.stringify(message.error)}`)
        }
        return message
      }
    }

    let timeout: NodeJS.Timeout | undefined
    try
    {
      return await Promise.race([
        read(),
        new Promise<never>((_resolve, reject) =>
        {
          timeout = NodeTimers.setTimeout(
            () => reject(new Error(`installed MCP shim timed out on response ${expectedId}`)),
            10_000,
          )
        }),
      ])
    }
    finally
    {
      if (timeout !== undefined)
      {
        NodeTimers.clearTimeout(timeout)
      }
    }
  }

  try
  {
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: '456code-packed-cli-smoke', version: '1.0.0' },
      },
    })
    const initializeResponse = await readResponse(1)
    NodeAssert.ok(isRecord(initializeResponse.result), 'MCP initialize returned no result')

    send({ method: 'notifications/initialized', params: {} })
    send({ id: 2, method: 'tools/list', params: {} })
    const toolsResponse = await readResponse(2)
    NodeAssert.ok(isRecord(toolsResponse.result), 'MCP tools/list returned no result')
    NodeAssert.ok(Array.isArray(toolsResponse.result.tools), 'MCP tools/list returned no tools')
    const toolNames = toolsResponse.result.tools.map((tool) =>
    {
      NodeAssert.ok(isRecord(tool) && typeof tool.name === 'string', 'MCP returned a bad tool')
      return tool.name
    })
    NodeAssert.deepEqual(toolNames, EXPECTED_MCP_TOOLS)

    child.stdin.end()
    await waitForCleanExit(child, 'installed Cartographer MCP shim')
  }
  finally
  {
    stdout.close()
    if (child.exitCode === null && child.signalCode === null)
    {
      child.kill('SIGTERM')
    }
  }
}

async function probeCoreCli(coreRoot: string, owner: string): Promise<void>
{
  const fixture = NodePath.join(owner, 'cartographer-fixture')
  const output = NodePath.join(owner, 'cartographer-output')
  await NodeFSP.mkdir(NodePath.join(fixture, 'src'), { recursive: true })
  await NodeFSP.writeFile(
    NodePath.join(fixture, 'src/index.ts'),
    '// src/index.ts\n// tiny packed Cartographer smoke fixture\n\nexport const packed = true\n',
  )

  const cliPath = NodePath.join(coreRoot, 'dist/cli/index.js')
  runChecked(
    'bundled Cartographer CLI build',
    NodeProcess.execPath,
    [cliPath, 'build', fixture, '--out', output],
    fixture,
  )
  NodeAssert.ok(
    NodeFS.statSync(NodePath.join(output, 'graph.json')).isFile(),
    'bundled Cartographer CLI did not produce graph.json',
  )

  const queryOutput = runChecked(
    'bundled Cartographer Architecture query',
    NodeProcess.execPath,
    [cliPath, 'blast-radius', fixture, '--out', output, '--target', 'src/index.ts'],
    fixture,
  )
  const query = packageManifest(JSON.parse(queryOutput) as unknown, 'Architecture query result')
  NodeAssert.equal(query.target, 'src/index.ts', 'Architecture query targeted the wrong file')
}

async function reserveLoopbackPort(): Promise<number>
{
  const server = NodeNet.createServer()
  await new Promise<void>((resolve, reject) =>
  {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  NodeAssert.ok(address && typeof address !== 'string', 'failed to reserve a loopback port')
  await new Promise<void>((resolve, reject) =>
  {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}

async function stopProcess(child: NodeChildProcess.ChildProcess): Promise<void>
{
  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) =>
    {
      let timeout: NodeJS.Timeout
      const onExit = (): void =>
      {
        NodeTimers.clearTimeout(timeout)
        resolve(true)
      }
      timeout = NodeTimers.setTimeout(() =>
      {
        child.off('exit', onExit)
        resolve(false)
      }, timeoutMs)
      child.once('exit', onExit)
    })

  if (NodeProcess.platform === 'win32')
  {
    if (child.exitCode !== null || child.signalCode !== null)
    {
      return
    }
    NodeAssert.equal(typeof child.pid, 'number', 'installed server process has no PID')
    const forcedExit = waitForExit(5_000)
    runChecked(
      'stop installed 456code process tree',
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      NodeProcess.cwd(),
    )
    NodeAssert.ok(await forcedExit, 'installed 456code process tree did not stop')
    return
  }

  NodeAssert.equal(typeof child.pid, 'number', 'installed server process has no PID')
  const processGroupId = -child.pid!
  const signalProcessGroup = (signal: NodeJS.Signals | 0): boolean =>
  {
    try
    {
      NodeProcess.kill(processGroupId, signal)
      return true
    }
    catch (error)
    {
      const errorCode = isRecord(error) ? error.code : undefined
      const processTable = errorCode === 'EPERM' ? readPosixProcessTable() : []
      if (canTreatProcessGroupSignalErrorAsExit(errorCode, child.pid!, processTable))
      {
        return false
      }
      throw error
    }
  }
  const waitForProcessGroupExit = async (timeoutMs: number): Promise<boolean> =>
  {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline)
    {
      if (!signalProcessGroup(0))
      {
        return true
      }
      await new Promise((resolve) => NodeTimers.setTimeout(resolve, 50))
    }
    return !signalProcessGroup(0)
  }

  if (!signalProcessGroup('SIGTERM'))
  {
    return
  }
  if (await waitForProcessGroupExit(5_000))
  {
    return
  }
  signalProcessGroup('SIGKILL')
  NodeAssert.ok(
    await waitForProcessGroupExit(5_000),
    'installed 456code process tree did not stop after SIGKILL',
  )
}

async function probeInstalledServer(
  consumer: string,
  serverRoot: string,
  owner: string,
): Promise<void>
{
  const port = await reserveLoopbackPort()
  const baseDir = NodePath.join(owner, 'server-home')
  const serverManifest = packageManifest(
    readJson(NodePath.join(serverRoot, 'package.json')),
    'installed 456code package.json',
  )
  const serverBins = stringRecord(serverManifest.bin, 'installed 456code bin')
  const serverBinName = Object.entries(serverBins).find(
    ([, target]) => target === './dist/bin.mjs',
  )?.[0]
  NodeAssert.equal(typeof serverBinName, 'string', 'installed 456code executable bin is missing')
  const serverArgs = [
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--base-dir',
    baseDir,
    '--no-browser',
  ]
  const serverShim = NodePath.join(
    consumer,
    'node_modules',
    '.bin',
    NodeProcess.platform === 'win32' ? `${serverBinName}.cmd` : serverBinName!,
  )
  NodeAssert.ok(NodeFS.existsSync(serverShim), 'installed 456code package shim is missing')
  const spawnCommand = prepareSpawnCommandForPlatform(serverShim, serverArgs, NodeProcess.platform)
  const output: string[] = []
  const child = NodeChildProcess.spawn(spawnCommand.command, spawnCommand.args, {
    cwd: owner,
    env: {
      ...NodeProcess.env,
      CI: '1',
      NO_COLOR: '1',
      T3CODE_LOG_LEVEL: 'Error',
    },
    detached: NodeProcess.platform !== 'win32',
    shell: spawnCommand.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()))

  try
  {
    const deadline = Date.now() + 45_000
    let lastError: unknown
    while (Date.now() < deadline)
    {
      if (child.exitCode !== null || child.signalCode !== null)
      {
        throw new Error(
          `installed 456code exited before serving HTTP (${child.exitCode ?? child.signalCode}):\n${output.join('')}`,
        )
      }
      try
      {
        const abortController = new AbortController()
        const requestTimeout = NodeTimers.setTimeout(() => abortController.abort(), 2_000)
        try
        {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: abortController.signal,
          })
          const body = await response.text()
          if (response.status === 200 && /<!doctype html>/iu.test(body))
          {
            return
          }
          lastError = new Error(`expected HTTP 200 with packaged HTML, received ${response.status}`)
        }
        finally
        {
          NodeTimers.clearTimeout(requestTimeout)
        }
      }
      catch (error)
      {
        lastError = error
      }
      await new Promise((resolve) => NodeTimers.setTimeout(resolve, 150))
    }
    throw new Error(
      `installed 456code did not serve packaged HTTP within 45s: ${String(lastError)}\n${output.join('')}`,
    )
  }
  finally
  {
    await stopProcess(child)
  }
}

export function parsePackedCliSmokeArgs(args: ReadonlyArray<string>): PackedCliSmokeOptions
{
  NodeAssert.equal(args[0], '--archive', 'usage: smoke-packed-cli --archive <absolute-tgz>')
  NodeAssert.equal(args.length, 2, 'usage: smoke-packed-cli --archive <absolute-tgz>')
  const archive = args[1]!
  NodeAssert.ok(NodePath.isAbsolute(archive), '--archive must be an absolute path')
  NodeAssert.ok(archive.endsWith('.tgz'), '--archive must point to a .tgz file')
  const archiveStat = NodeFS.lstatSync(archive)
  NodeAssert.ok(archiveStat.isFile(), '--archive must point to a regular file')
  NodeAssert.ok(!archiveStat.isSymbolicLink(), '--archive must not be a symlink')
  return { archive }
}

export async function smokePackedCli(options: PackedCliSmokeOptions): Promise<void>
{
  const owner = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-packed-cli-'))
  try
  {
    const npmConsumer = await makeConsumer(owner, 'npm')
    installArchive('npm', npmConsumer, options.archive)
    const npmInstall = inspectInstalledPackage(npmConsumer)
    probeCoreServerExport(npmInstall.serverRoot)
    await probeInstalledMcpShim(npmInstall.serverRoot, npmInstall.coreRoot)
    await probeCoreCli(npmInstall.coreRoot, owner)
    await probeInstalledServer(npmConsumer, npmInstall.serverRoot, owner)

    const pnpmConsumer = await makeConsumer(owner, 'pnpm')
    installArchive('pnpm', pnpmConsumer, options.archive)
    const pnpmInstall = inspectInstalledPackage(pnpmConsumer)
    probeCoreServerExport(pnpmInstall.serverRoot)

    NodeProcess.stdout.write('Packed 456code CLI smoke passed for npm and pnpm consumers.\n')
  }
  finally
  {
    await NodeFSP.rm(owner, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

if (import.meta.main)
{
  smokePackedCli(parsePackedCliSmokeArgs(NodeProcess.argv.slice(2))).catch((error: unknown) =>
  {
    NodeProcess.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    NodeProcess.exit(1)
  })
}
