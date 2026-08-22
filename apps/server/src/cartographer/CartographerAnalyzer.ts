// apps/server/src/cartographer/CartographerAnalyzer.ts
// resolve and serialize workspace Cartographer CLI analysis processes

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeModule from 'node:module'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'

import { CartographerError } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Layer from 'effect/Layer'
import * as Semaphore from 'effect/Semaphore'

import * as ProcessRunner from '../process/processRunner.ts'

// precompiled at module scope so no sync schema call sits inside an effect generator
const decodePackageJsonText = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

const CARTOGRAPHER_PACKAGE_NAME = '@t3tools/cartographer-core'
const CARTOGRAPHER_PACKAGE_JSON = `${CARTOGRAPHER_PACKAGE_NAME}/package.json`
const CARTOGRAPHER_CLI_ENTRY = 'dist/cli/index.js'
const ANALYSIS_TIMEOUT_MS = 120_000
const ANALYSIS_MAX_OUTPUT_BYTES = 1024 * 1024

interface CartographerPackageJson
{
  readonly name?: unknown
  readonly version?: unknown
  readonly bin?: unknown
}

export interface CartographerAnalyzerIdentity
{
  readonly cliPath: string
  readonly fingerprint: string
}

export interface CurrentWorktreeAnalysisInput
{
  readonly root: string
  readonly outDir: string
  readonly signal: AbortSignal
}

export interface ComparisonAnalysisInput
{
  readonly baseRoot: string
  readonly proposedRoot: string
  readonly outDir: string
  readonly baseRef: string
  readonly proposedRef: string
  readonly implementationChangedFileCount: number
}

export interface ComparisonAnalysisResult
{
  readonly process: ProcessRunner.ProcessRunOutput
  readonly fingerprint: string
}

export interface ProjectAtlasBuildInput
{
  readonly root: string
  readonly outDir: string
  readonly signal: AbortSignal
}

export interface ProjectAtlasBuildResult
{
  readonly fingerprint: string
}

export interface CartographerAnalyzerShape
{
  readonly identify: Effect.Effect<CartographerAnalyzerIdentity, CartographerError>
  readonly prepareCurrentWorktree: (
    input: CurrentWorktreeAnalysisInput,
  ) => Effect.Effect<void, CartographerError>
  readonly analyzeTrees: (
    input: ComparisonAnalysisInput,
  ) => Effect.Effect<ComparisonAnalysisResult, CartographerError>
  readonly buildProjectAtlas: (
    input: ProjectAtlasBuildInput,
  ) => Effect.Effect<ProjectAtlasBuildResult, CartographerError>
}

export class CartographerAnalyzer extends Context.Service<
  CartographerAnalyzer,
  CartographerAnalyzerShape
>()('456code/cartographer/CartographerAnalyzer')
{}

export interface CartographerAnalyzerOptions
{
  readonly resolvePackageJson?: () => string | Promise<string>
}

function publicError(failure: CartographerError['failure'], message: string): CartographerError
{
  return new CartographerError({ failure, message })
}

const workspaceRequire = NodeModule.createRequire(import.meta.url)

function resolveWorkspacePackageJson(): string
{
  return workspaceRequire.resolve(CARTOGRAPHER_PACKAGE_JSON)
}

export interface WorkspaceDistributionCapabilities
{
  readonly architectureImpact: boolean
}

// all native architecture surfaces depend on the analyzer CLI, not a browser bundle
export function workspaceDistributionCapabilities(
  options: CartographerAnalyzerOptions = {},
): Effect.Effect<WorkspaceDistributionCapabilities>
{
  return Effect.promise(async () =>
  {
    if (typeof Bun !== 'undefined')
    {
      return { architectureImpact: false }
    }
    try
    {
      const packageJsonPath = await (options.resolvePackageJson?.() ??
        resolveWorkspacePackageJson())
      const packageRoot = NodePath.dirname(NodePath.resolve(packageJsonPath))
      const isRegularFile = async (entry: string): Promise<boolean> =>
      {
        try
        {
          const stat = await NodeFSP.lstat(NodePath.join(packageRoot, entry))
          return stat.isFile() && !stat.isSymbolicLink()
        }
        catch
        {
          return false
        }
      }
      const architectureImpact = await isRegularFile(CARTOGRAPHER_CLI_ENTRY)
      return { architectureImpact }
    }
    catch
    {
      return { architectureImpact: false }
    }
  })
}

function cartographerBin(packageJson: CartographerPackageJson): string | null
{
  if (
    typeof packageJson.bin !== 'object' ||
    packageJson.bin === null ||
    Array.isArray(packageJson.bin)
  )
  {
    return null
  }
  const bin = packageJson.bin as Record<string, unknown>
  return typeof bin.cartographer === 'string' ? bin.cartographer : null
}

// cheap stand-in for the content digest over the same file set: path, size, and modification time.
// any rebuild or in-place edit moves it, so it decides when a memoized fingerprint may be reused
async function distSignature(distRoot: string): Promise<string>
{
  const entries = (await NodeFSP.readdir(distRoot, { recursive: true })).toSorted()
  const signature = NodeCrypto.createHash('sha256')
  for (const entry of entries)
  {
    const absolutePath = NodePath.join(distRoot, entry)
    const stat = await NodeFSP.lstat(absolutePath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    const normalizedPath = entry.split(NodePath.sep).join('/')
    signature.update(`${normalizedPath}\0${stat.size}\0${stat.mtimeNs}\0`)
  }
  return signature.digest('hex')
}

async function fingerprintDist(distRoot: string): Promise<string>
{
  const entries = (await NodeFSP.readdir(distRoot, { recursive: true })).toSorted()
  const digest = NodeCrypto.createHash('sha256')
  let fileCount = 0
  for (const entry of entries)
  {
    const absolutePath = NodePath.join(distRoot, entry)
    const stat = await NodeFSP.lstat(absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    const bytes = await NodeFSP.readFile(absolutePath)
    const normalizedPath = entry.split(NodePath.sep).join('/')
    digest.update(`${normalizedPath}\0${bytes.byteLength}\0`)
    digest.update(bytes)
    fileCount += 1
  }
  if (fileCount === 0)
  {
    throw new Error('Cartographer dist is empty')
  }
  return digest.digest('hex')
}

// shared by the server service and installed-artifact acceptance so the package
// metadata, asar fs traversal, and memoized fingerprint contract stay identical
export function createCartographerAnalyzerIdentifier(
  options: CartographerAnalyzerOptions = {},
): () => Promise<CartographerAnalyzerIdentity>
{
  const resolvePackageJson = options.resolvePackageJson ?? resolveWorkspacePackageJson
  let identifiedAnalyzer: {
    readonly signature: string
    readonly version: string
    readonly identity: CartographerAnalyzerIdentity
  } | null = null

  return async () =>
  {
    const packageJsonPath = NodePath.resolve(await resolvePackageJson())
    const packageJsonStat = await NodeFSP.lstat(packageJsonPath)
    if (!packageJsonStat.isFile() || packageJsonStat.isSymbolicLink())
    {
      throw new Error('Cartographer package.json is not a regular file')
    }
    const packageRoot = await NodeFSP.realpath(NodePath.dirname(packageJsonPath))
    const packageJson = decodePackageJsonText(
      await NodeFSP.readFile(packageJsonPath, 'utf8'),
    ) as CartographerPackageJson
    const bin = cartographerBin(packageJson)
    if (
      packageJson.name !== CARTOGRAPHER_PACKAGE_NAME ||
      typeof packageJson.version !== 'string' ||
      packageJson.version.length === 0 ||
      bin !== `./${CARTOGRAPHER_CLI_ENTRY}`
    )
    {
      throw new Error('Cartographer package metadata is incompatible')
    }
    const cliPath = NodePath.join(packageRoot, CARTOGRAPHER_CLI_ENTRY)
    const cliStat = await NodeFSP.lstat(cliPath)
    if (!cliStat.isFile() || cliStat.isSymbolicLink())
    {
      throw new Error('Cartographer CLI entry is not a regular file')
    }
    const distRoot = NodePath.join(packageRoot, 'dist')
    const signature = await distSignature(distRoot)
    const memoized = identifiedAnalyzer
    // the fingerprint embeds the package version, which lives outside dist and
    // therefore has to remain part of the memo key
    if (
      memoized !== null &&
      memoized.signature === signature &&
      memoized.version === packageJson.version &&
      memoized.identity.cliPath === cliPath
    )
    {
      return memoized.identity
    }
    const distDigest = await fingerprintDist(distRoot)
    const identity: CartographerAnalyzerIdentity = {
      cliPath,
      fingerprint: `${CARTOGRAPHER_PACKAGE_NAME}@${packageJson.version}:dist-sha256:${distDigest}`,
    }
    identifiedAnalyzer = { signature, version: packageJson.version, identity }
    return identity
  }
}

function awaitAbort(signal: AbortSignal): Effect.Effect<never, CartographerError>
{
  return Effect.tryPromise({
    try: (effectSignal) =>
      new Promise<never>((_resolve, reject) =>
      {
        const cleanup = () =>
        {
          signal.removeEventListener('abort', abort)
          effectSignal.removeEventListener('abort', interrupt)
        }
        const abort = () =>
        {
          cleanup()
          reject(new Error('Cartographer analysis was cancelled'))
        }
        const interrupt = () =>
        {
          cleanup()
          reject(new Error('Cartographer abort wait was interrupted'))
        }
        if (signal.aborted)
        {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
        effectSignal.addEventListener('abort', interrupt, { once: true })
      }),
    catch: () => publicError('context_start_failed', 'Architecture preparation was cancelled.'),
  })
}

export const make = Effect.fn('CartographerAnalyzer.make')(function* (
  options: CartographerAnalyzerOptions = {},
)
{
  const processRunner = yield* ProcessRunner.ProcessRunner
  const buildSemaphore = yield* Semaphore.make(1)
  const identifyAnalyzer = createCartographerAnalyzerIdentifier(options)

  const identify: CartographerAnalyzerShape['identify'] = Effect.tryPromise({
    try: identifyAnalyzer,
    catch: (cause) => ({
      cause,
      error: publicError(
        'unsupported',
        'Architecture analysis is unavailable because its workspace distribution is missing.',
      ),
    }),
  }).pipe(
    Effect.tapError(({ cause }) =>
      Effect.logWarning('workspace Cartographer CLI resolution failed', { cause }),
    ),
    Effect.mapError(({ error }) => error),
  )

  const runChild = Effect.fn('CartographerAnalyzer.runChild')(function* (
    input: ProcessRunner.ProcessRunInput,
    signal?: AbortSignal,
  )
  {
    const run = buildSemaphore.withPermit(
      processRunner
        .run(input)
        .pipe(
          Effect.mapError(() =>
            publicError('context_start_failed', 'Architecture analysis could not be started.'),
          ),
        ),
    )
    return yield* Effect.suspend(() =>
      signal === undefined ? run : Effect.raceFirst(run, awaitAbort(signal)),
    )
  })

  const prepareCurrentWorktree: CartographerAnalyzerShape['prepareCurrentWorktree'] = Effect.fn(
    'CartographerAnalyzer.prepareCurrentWorktree',
  )(function* (input)
  {
    const analyzer = yield* identify
    const result = yield* runChild(
      {
        command: NodeProcess.execPath,
        args: [
          analyzer.cliPath,
          'build',
          input.root,
          '--scope',
          '.',
          '--out',
          input.outDir,
          '--no-history',
        ],
        cwd: input.root,
        timeout: ANALYSIS_TIMEOUT_MS,
        maxOutputBytes: ANALYSIS_MAX_OUTPUT_BYTES,
      },
      input.signal,
    )
    if (result.code !== 0)
    {
      return yield* publicError(
        'snapshot_failed',
        'Architecture analysis could not build the repository snapshot.',
      )
    }
  })

  const analyzeTrees: CartographerAnalyzerShape['analyzeTrees'] = Effect.fn(
    'CartographerAnalyzer.analyzeTrees',
  )(function* (input)
  {
    const analyzer = yield* identify
    const process = yield* runChild({
      command: NodeProcess.execPath,
      args: [
        analyzer.cliPath,
        'analyze-trees',
        input.baseRoot,
        input.proposedRoot,
        '--out',
        input.outDir,
        '--base-ref',
        input.baseRef,
        '--proposed-ref',
        input.proposedRef,
        '--analyzer-version',
        analyzer.fingerprint,
        '--implementation-changed-file-count',
        String(input.implementationChangedFileCount),
      ],
      cwd: input.outDir,
      timeout: ANALYSIS_TIMEOUT_MS,
      maxOutputBytes: ANALYSIS_MAX_OUTPUT_BYTES,
    })
    if (process.code !== 0)
    {
      return yield* publicError(
        'snapshot_failed',
        'Architecture analysis could not build the proposal comparison.',
      )
    }
    return { process, fingerprint: analyzer.fingerprint }
  })

  const buildProjectAtlas: CartographerAnalyzerShape['buildProjectAtlas'] = Effect.fn(
    'CartographerAnalyzer.buildProjectAtlas',
  )(function* (input)
  {
    const analyzer = yield* identify
    const process = yield* runChild(
      {
        command: NodeProcess.execPath,
        args: [analyzer.cliPath, 'build', '--scope', '.', '--out', input.outDir, '--no-history'],
        cwd: input.root,
        timeout: ANALYSIS_TIMEOUT_MS,
        maxOutputBytes: ANALYSIS_MAX_OUTPUT_BYTES,
      },
      input.signal,
    )
    if (process.code !== 0)
    {
      return yield* publicError(
        'context_start_failed',
        'Architecture analysis could not rebuild the Repository Map.',
      )
    }
    return { fingerprint: analyzer.fingerprint }
  })

  return CartographerAnalyzer.of({
    identify,
    prepareCurrentWorktree,
    analyzeTrees,
    buildProjectAtlas,
  })
})

export const layer = Layer.effect(CartographerAnalyzer, make())
