// scripts/windows-desktop-packaged-smoke.mjs
// smoke-test native and Cartographer modules from an installed Windows sidecar

import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import * as NodeUtil from 'node:util'
import * as ElectronOriginalFS from 'original-fs'

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile)
const CARTOGRAPHER_CLI_TIMEOUT_MS = 120_000

async function writeStandardOutput(output)
{
  await new Promise((resolve, reject) =>
  {
    process.stdout.write(output, (error) =>
    {
      if (error)
      {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function writeSuccessMarker(successMarkerPath, payload)
{
  const successMarkerTempPath = `${successMarkerPath}.tmp`
  try
  {
    await NodeFSP.writeFile(successMarkerTempPath, payload, {
      encoding: 'utf8',
      flag: 'wx',
    })
    await NodeFSP.rename(successMarkerTempPath, successMarkerPath)
  }
  catch (error)
  {
    await NodeFSP.rm(successMarkerTempPath, { force: true })
    throw error
  }
}

async function waitForParentShutdown()
{
  await new Promise(() =>
  {
    setInterval(() => Date.now(), 60_000)
  })
}

async function exerciseCartographerCli(cliPath)
{
  const fixtureRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), '456code-cartographer-smoke-'),
  )
  try
  {
    const sourceDir = NodePath.join(fixtureRoot, 'src')
    const outputDir = NodePath.join(fixtureRoot, 'cartographer-output')
    await NodeFSP.mkdir(sourceDir)
    await NodeFSP.writeFile(
      NodePath.join(sourceDir, 'index.ts'),
      "// src/index.ts\n// exercise the installed Cartographer dependency graph\n\nimport { answer } from './value.js'\n\nexport const doubled = answer * 2\n",
    )
    await NodeFSP.writeFile(
      NodePath.join(sourceDir, 'value.ts'),
      '// src/value.ts\n// provide the imported fixture value\n\nexport const answer = 42\n',
    )
    await NodeFSP.writeFile(
      NodePath.join(fixtureRoot, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2022',
            strict: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      )}\n`,
    )

    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }
    delete childEnv.ELECTRON_NO_ASAR
    delete childEnv.NODE_OPTIONS
    try
    {
      await execFileAsync(
        process.execPath,
        [
          '--no-global-search-paths',
          cliPath,
          'build',
          fixtureRoot,
          '--scope',
          '.',
          '--out',
          outputDir,
          '--no-history',
        ],
        {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: childEnv,
          maxBuffer: 1024 * 1024,
          timeout: CARTOGRAPHER_CLI_TIMEOUT_MS,
          windowsHide: true,
        },
      )
    }
    catch (error)
    {
      const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
      const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
      throw new Error(`Installed Cartographer CLI build failed:\n${stderr}${stdout}`, {
        cause: error,
      })
    }

    const graph = JSON.parse(await NodeFSP.readFile(NodePath.join(outputDir, 'graph.json'), 'utf8'))
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    {
      throw new Error('Installed Cartographer CLI produced an invalid graph.json')
    }
    const nodeIds = new Set(graph.nodes.map((node) => node.id))
    if (!nodeIds.has('src/index.ts') || !nodeIds.has('src/value.ts') || graph.edges.length < 1)
    {
      throw new Error(
        `Installed Cartographer graph missed the fixture dependency: nodes=${JSON.stringify([...nodeIds])}, edges=${String(graph.edges.length)}`,
      )
    }
    return { nodes: graph.nodes.length, edges: graph.edges.length }
  }
  finally
  {
    await NodeFSP.rm(fixtureRoot, { recursive: true, force: true })
  }
}

const appDir = process.argv[2]
const successMarkerPath = process.argv[3]
if (!appDir || !successMarkerPath)
{
  throw new Error(
    'Usage: windows-desktop-packaged-smoke.mjs <installed-app-directory> <success-marker-path>',
  )
}

const resourcesDir = NodePath.join(appDir, 'resources')
const serverAsarPath = NodePath.join(resourcesDir, 'server.asar')
const expectedDigest = (
  await NodeFSP.readFile(NodePath.join(resourcesDir, 'server.asar.sha256'), 'utf8')
).trim()
const digest = NodeCrypto.createHash('sha256')
for await (const chunk of ElectronOriginalFS.createReadStream(serverAsarPath))
{
  digest.update(chunk)
}
const actualDigest = digest.digest('hex')
if (actualDigest !== expectedDigest)
{
  throw new Error(
    `server.asar digest mismatch: expected ${expectedDigest}, received ${actualDigest}`,
  )
}

const cartographerPackageRoot = NodePath.join(
  serverAsarPath,
  'node_modules/@t3tools/cartographer-core',
)
const cartographer = await import(
  NodeURL.pathToFileURL(NodePath.join(cartographerPackageRoot, 'dist/server.js')).href
)
if (Object.keys(cartographer).length === 0)
{
  throw new Error('Cartographer server module loaded without exports')
}
const serverBundle = await import(
  NodeURL.pathToFileURL(NodePath.join(serverAsarPath, 'apps/server/dist/bin.mjs')).href
)
if (typeof serverBundle.createCartographerAnalyzerIdentifier !== 'function')
{
  throw new Error('Packaged server does not expose Cartographer distribution identification')
}
const identifyCartographer = serverBundle.createCartographerAnalyzerIdentifier()
const cartographerIdentity = await identifyCartographer()
const cartographerGraph = await exerciseCartographerCli(cartographerIdentity.cliPath)

const nodePty = await import(
  NodeURL.pathToFileURL(NodePath.join(serverAsarPath, 'node_modules/node-pty/lib/index.js')).href
)
const spawnPty = nodePty.spawn ?? nodePty.default?.spawn
if (typeof spawnPty !== 'function')
{
  throw new Error('node-pty did not expose its spawn function')
}
const ptyOutput = await new Promise((resolve, reject) =>
{
  let output = ''
  const timeout = setTimeout(() =>
  {
    terminal.kill()
    reject(new Error('node-pty smoke timed out'))
  }, 15_000)
  const terminal = spawnPty('cmd.exe', ['/d', '/s', '/c', 'echo 456code-pty-ok'], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: appDir,
    env: process.env,
  })
  terminal.onData((chunk) =>
  {
    output += chunk
  })
  terminal.onExit(({ exitCode }) =>
  {
    clearTimeout(timeout)
    if (exitCode !== 0)
    {
      reject(new Error(`node-pty smoke exited ${String(exitCode)}: ${output}`))
      return
    }
    resolve(output)
  })
})
if (!ptyOutput.includes('456code-pty-ok'))
{
  throw new Error(`node-pty smoke did not return its marker: ${ptyOutput}`)
}

const { FileFinder } = await import(
  NodeURL.pathToFileURL(
    NodePath.join(serverAsarPath, 'node_modules/@ff-labs/fff-node/dist/src/index.js'),
  ).href
)
const probeRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-fff-smoke-'))
let fileFinder
try
{
  const result = FileFinder.create({
    basePath: probeRoot,
    frecencyDbPath: NodePath.join(probeRoot, 'frecency.mdb'),
    historyDbPath: NodePath.join(probeRoot, 'history.mdb'),
    disableWatch: true,
    disableMmapCache: true,
    disableContentIndexing: true,
  })
  if (!result.ok)
  {
    throw new Error(result.error)
  }
  fileFinder = result.value
}
finally
{
  try
  {
    fileFinder?.destroy()
  }
  finally
  {
    await NodeFSP.rm(probeRoot, { recursive: true, force: true })
  }
}

const successPayload = `${JSON.stringify({
  serverAsarDigest: actualDigest,
  cartographer: {
    fingerprint: cartographerIdentity.fingerprint,
    exports: Object.keys(cartographer).length,
    graph: cartographerGraph,
  },
  pty: 'ok',
  fff: 'ok',
})}\n`
await writeStandardOutput(successPayload)
await writeSuccessMarker(successMarkerPath, successPayload)
await waitForParentShutdown()
