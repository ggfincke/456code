// tests/apps/server/cartographer/ProposalGenerationService.test.ts
// verifies exact bounded proposal-tree analysis and visible lifecycle freshness

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTimersPromises from 'node:timers/promises'
import * as NodeUtil from 'node:util'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import {
  EnvironmentId,
  ProjectId,
  ProposalGenerationId,
  ProposalId,
  ProposalRevisionId,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect } from 'vite-plus/test'

import * as ServerConfig from '../../../../apps/server/src/config.ts'
import * as ArchitectureAdmissionRepository from '../../../../apps/server/src/architecture/ArchitectureAdmissionRepository.ts'
import * as CartographerAnalyzer from '../../../../apps/server/src/cartographer/CartographerAnalyzer.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as ProcessRunner from '../../../../apps/server/src/process/processRunner.ts'
import * as ProposalGenerationService from '../../../../apps/server/src/proposal/ProposalGenerationService.ts'
import * as ProposalService from '../../../../apps/server/src/proposal/ProposalService.ts'

const execFile = NodeUtil.promisify(NodeChildProcess.execFile)

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string>
{
  const result = await execFile('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
  return result.stdout.trim()
}

async function initializeRepository(): Promise<string>
{
  const cwd = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), '456code-proposal-generation-workspace-'),
  )
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'generation-test@example.com'])
  await git(cwd, ['config', 'user.name', 'Generation Test'])
  const submoduleRoot = NodePath.join(cwd, 'submodule')
  await NodeFSP.mkdir(submoduleRoot)
  await git(submoduleRoot, ['init'])
  await git(submoduleRoot, ['config', 'user.email', 'generation-test@example.com'])
  await git(submoduleRoot, ['config', 'user.name', 'Generation Test'])
  await NodeFSP.writeFile(NodePath.join(submoduleRoot, 'nested.txt'), 'submodule-base\n')
  await git(submoduleRoot, ['add', '.'])
  await git(submoduleRoot, ['commit', '-m', 'submodule initial'])
  await NodeFSP.writeFile(
    NodePath.join(cwd, '.gitattributes'),
    'target.txt filter=sentinel text eol=crlf\n',
  )
  await NodeFSP.writeFile(NodePath.join(cwd, 'target.txt'), 'committed-base\n')
  await git(cwd, ['add', '.'])
  await git(cwd, ['commit', '-m', 'initial'])
  await git(cwd, ['config', 'filter.sentinel.clean', 'false'])
  await git(cwd, ['config', 'filter.sentinel.smudge', 'false'])
  await git(cwd, ['config', 'filter.sentinel.required', 'true'])
  await NodeFSP.writeFile(NodePath.join(cwd, 'target.txt'), Buffer.from('working-base\r\n'))
  return cwd
}

function useEnvironment(values: Readonly<Record<string, string>>)
{
  return Effect.acquireRelease(
    Effect.sync(() =>
    {
      const previous = new Map<string, string | undefined>()
      for (const [name, value] of Object.entries(values))
      {
        previous.set(name, process.env[name])
        process.env[name] = value
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() =>
      {
        for (const [name, value] of previous)
        {
          if (value === undefined)
          {
            delete process.env[name]
          }
          else
          {
            process.env[name] = value
          }
        }
      }),
  )
}

function sha256(value: string | Uint8Array): string
{
  return NodeCrypto.createHash('sha256').update(value).digest('hex')
}

async function pathExists(path: string): Promise<boolean>
{
  return NodeFSP.access(path).then(
    () => true,
    () => false,
  )
}

async function fingerprintDist(distRoot: string, version: string): Promise<string>
{
  const entries = (await NodeFSP.readdir(distRoot, { recursive: true })).sort()
  const parts: Buffer[] = []
  for (const entry of entries)
  {
    const absolutePath = NodePath.join(distRoot, entry)
    if (!(await NodeFSP.stat(absolutePath)).isFile()) continue
    const bytes = await NodeFSP.readFile(absolutePath)
    const normalizedPath = entry.split(NodePath.sep).join('/')
    parts.push(Buffer.from(`${normalizedPath}\0${bytes.byteLength}\0`, 'utf8'), bytes)
  }
  return `@t3tools/cartographer-core@${version}:dist-sha256:${sha256(Buffer.concat(parts))}`
}

const leaseProposalAdmission = Effect.fn('leaseProposalAdmission')(function* (input: {
  readonly admissionKey: string
  readonly threadId: ThreadId
  readonly proposalId: ProposalId
  readonly revisionId: ProposalRevisionId
  readonly revision: number
  readonly analyzerFingerprint: string
})
{
  const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
  yield* repository.enqueue({
    admissionKey: input.admissionKey,
    target: {
      _tag: 'proposal-verified',
      version: 1,
      threadId: input.threadId,
      proposalId: input.proposalId,
      revisionId: input.revisionId,
      revision: input.revision,
      analyzerFingerprint: input.analyzerFingerprint,
    },
    now: '2026-08-20T12:00:00.000Z',
  })
  const leased = yield* repository.leaseForExplicitStart({
    admissionKey: input.admissionKey,
    ownerId: 'proposal-generation-test-worker',
    leaseExpiresAt: '2099-08-20T12:00:30.000Z',
    now: '2026-08-20T12:00:01.000Z',
  })
  if (leased === null)
  {
    return yield* Effect.die(`expected admission ${input.admissionKey} to be leaseable`)
  }
  return {
    admissionId: leased.admissionId,
    ownerId: 'proposal-generation-test-worker',
    leaseEpoch: leased.leaseEpoch,
  }
})

describe('ProposalGenerationService', () =>
{
  it.effect('analyzes retained trees through durable admissions and reports drift', () =>
    Effect.gen(function* ()
    {
      const workspaceRoot = yield* Effect.promise(initializeRepository)
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-proposal-generation-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )

      const analyzerDistRoot = NodePath.join(baseDir, 'cartographer', 'dist')
      const analyzerPackageJsonPath = NodePath.join(baseDir, 'cartographer', 'package.json')
      const analyzerPath = NodePath.join(analyzerDistRoot, 'cli', 'index.js')
      const analyzerDependencyPath = NodePath.join(analyzerDistRoot, 'runtime.js')
      const badIdentityMarker = NodePath.join(baseDir, 'report-bad-analyzer-identity')
      const analyzerLifecycleLog = NodePath.join(baseDir, 'analyzer-lifecycle.ndjson')
      const analyzerSource = [
        'import { access, appendFile, readFile, writeFile } from "node:fs/promises"',
        'import { createHash } from "node:crypto"',
        'import { setTimeout as delay } from "node:timers/promises"',
        'const args = process.argv.slice(2)',
        "if (args[0] !== 'analyze-trees') process.exit(64)",
        'const baseRoot = args[1]',
        'const proposedRoot = args[2]',
        'const flag = (name) => args[args.indexOf(name) + 1]',
        "const out = flag('--out')",
        "const analyzerVersion = flag('--analyzer-version')",
        "const implementationChangedFileCount = Number(flag('--implementation-changed-file-count'))",
        "const sha256 = (value) => createHash('sha256').update(value).digest('hex')",
        'const lifecycleLog = process.env.T3_TEST_CARTOGRAPHER_ANALYZER_LOG',
        "await appendFile(lifecycleLog, `${JSON.stringify({ event: 'start', out })}\\n`)",
        'await delay(Number(process.env.T3_TEST_CARTOGRAPHER_ANALYZER_DELAY_MS || 0))',
        'const badIdentity = await access(process.env.T3_TEST_CARTOGRAPHER_BAD_IDENTITY_FILE).then(() => true, () => false)',
        "const baseContent = await readFile(`${baseRoot}/target.txt`, 'utf8')",
        "const proposedContent = await readFile(`${proposedRoot}/target.txt`, 'utf8')",
        "const baseGraph = JSON.stringify({ repoRoot: '.', content: baseContent, gitRef: flag('--base-ref') })",
        "const proposedGraph = JSON.stringify({ repoRoot: '.', content: proposedContent, gitRef: flag('--proposed-ref') })",
        'const impact = JSON.stringify({',
        "  baseGeneratedAt: '2026-08-07T12:00:00.000Z',",
        "  headGeneratedAt: '2026-08-07T12:00:00.000Z',",
        "  baseGitRef: flag('--base-ref'),",
        "  headGitRef: flag('--proposed-ref'),",
        "  addedNodes: baseContent === proposedContent ? [] : ['target.txt'],",
        '  removedNodes: [],',
        '  addedEdges: [],',
        '  removedEdges: [],',
        '  movedNodes: [],',
        '  moveFlows: [],',
        '  movedEdges: 0,',
        '  apiChanges: [],',
        '  newViolations: [],',
        '  resolvedViolations: [],',
        '  changed: baseContent !== proposedContent',
        '})',
        'const impactProjection = JSON.stringify({',
        '  version: 1,',
        "  kind: 'impact-diff',",
        "  authority: 'verified',",
        "  resultState: 'no-impact',",
        "  generatedAt: '2026-08-07T12:00:00.000Z',",
        '  analyzerFingerprint: analyzerVersion,',
        "  baseGitRef: flag('--base-ref'),",
        "  headGitRef: flag('--proposed-ref'),",
        '  baseGraphDigest: `sha256:${sha256(baseGraph)}`,',
        '  headGraphDigest: `sha256:${sha256(proposedGraph)}`,',
        '  rawImpactDigest: `sha256:${sha256(impact)}`,',
        '  implementationChangedFileCount,',
        "  lens: 'structure',",
        "  semanticLevel: 'files',",
        '  breadcrumbs: [],',
        "  layoutVersion: 'semantic-impact-v1',",
        '  totals: {',
        '    nodes: { total: 0, returned: 0, omitted: 0 },',
        '    edges: { total: 0, returned: 0, omitted: 0 },',
        '    evidence: { total: 0, returned: 0, omitted: 0 },',
        '    changedFiles: { total: implementationChangedFileCount, returned: 0, omitted: implementationChangedFileCount }',
        '  },',
        '  nodes: [],',
        '  edges: [],',
        '  evidence: []',
        '})',
        'await writeFile(`${out}/base.graph.json`, baseGraph)',
        'await writeFile(`${out}/proposed.graph.json`, proposedGraph)',
        'await writeFile(`${out}/impact.json`, impact)',
        'await writeFile(`${out}/impact-projection.json`, impactProjection)',
        "await appendFile(lifecycleLog, `${JSON.stringify({ event: 'end', out })}\\n`)",
        'console.log(JSON.stringify({',
        "  type: 'cartographer.analysis-ready',",
        '  version: 2,',
        "  analyzerVersion: badIdentity ? 'sha256:wrong-analyzer' : analyzerVersion,",
        "  baseGraph: 'base.graph.json',",
        "  proposedGraph: 'proposed.graph.json',",
        "  impact: 'impact.json',",
        "  impactProjection: 'impact-projection.json'",
        '}))',
        '',
      ].join('\n')
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(NodePath.dirname(analyzerPath), { recursive: true })
        await Promise.all([
          NodeFSP.writeFile(analyzerPath, analyzerSource),
          NodeFSP.writeFile(analyzerDependencyPath, 'runtime-v1\n'),
          NodeFSP.writeFile(
            analyzerPackageJsonPath,
            JSON.stringify({
              name: '@t3tools/cartographer-core',
              version: '0.1.0-test',
              bin: { cartographer: './dist/cli/index.js' },
            }),
          ),
        ])
      })
      yield* useEnvironment({
        T3_TEST_CARTOGRAPHER_ANALYZER_LOG: analyzerLifecycleLog,
        T3_TEST_CARTOGRAPHER_BAD_IDENTITY_FILE: badIdentityMarker,
        T3_TEST_CARTOGRAPHER_ANALYZER_DELAY_MS: '350',
      })

      const AnalyzerLayer = Layer.effect(
        CartographerAnalyzer.CartographerAnalyzer,
        CartographerAnalyzer.make({ resolvePackageJson: () => analyzerPackageJsonPath }),
      ).pipe(Layer.provide(ProcessRunner.layer))
      const TestLayer = ProposalGenerationService.layer.pipe(
        Layer.provideMerge(ProposalService.layer),
        Layer.provideMerge(ProcessRunner.layer),
        Layer.provideMerge(AnalyzerLayer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      )

      yield* Effect.gen(function* ()
      {
        const proposals = yield* ProposalService.ProposalService
        const generations = yield* ProposalGenerationService.ProposalGenerationService
        const sql = yield* SqlClient.SqlClient
        const config = yield* ServerConfig.ServerConfig
        const threadId = ThreadId.make('thread-generation-exact')
        const proposalId = ProposalId.make('proposal-generation-exact')
        const revision = yield* proposals.upsert({
          proposalId,
          environmentId: EnvironmentId.make('environment-generation-exact'),
          projectId: ProjectId.make('project-generation-exact'),
          sourceThreadId: threadId,
          producer: {
            providerSessionId: 'provider-session-generation-exact',
            providerInstanceId: ProviderInstanceId.make('codex-generation'),
          },
          verifiedAnalyzerFingerprint: 'cartographer:0.1.0-test',
          cwd: workspaceRoot,
          changes: {
            _tag: 'typed',
            operations: [
              {
                _tag: 'modify',
                path: 'target.txt',
                beforeSha256: sha256('working-base\r\n') as never,
                content: { encoding: 'utf8', data: 'proposed-exact\r\n' },
              },
            ],
          },
        })

        const analyzerFingerprint = yield* Effect.promise(() =>
          fingerprintDist(analyzerDistRoot, '0.1.0-test'),
        )
        const initialAdmissionKey = `proposal-verified:${revision.revisionId}:${analyzerFingerprint}`
        const initialAdmissionLease = yield* leaseProposalAdmission({
          admissionKey: initialAdmissionKey,
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          analyzerFingerprint,
        })
        const initialStart = {
          threadId,
          proposalId,
          revision: 1,
          revisionId: revision.revisionId,
          analyzerFingerprint,
          admissionKey: initialAdmissionKey,
          leaseFence: initialAdmissionLease,
        }
        const first = yield* generations.startAdmitted(initialStart)
        expect(['queued', 'preparing', 'analyzing']).toContain(first.state)
        const second = yield* generations.startAdmitted(initialStart)
        expect(['queued', 'preparing', 'analyzing']).toContain(second.state)
        expect(second.generationId).toBe(first.generationId)

        const waitForTerminal = Effect.fn('ProposalGenerationService.test.waitForTerminal')(
          function* (generationThreadId: ThreadId, generationId: ProposalGenerationId)
          {
            for (let attempt = 0; attempt < 240; attempt += 1)
            {
              const generation = yield* generations.get({
                threadId: generationThreadId,
                generationId,
              })
              if (
                generation.state === 'ready' ||
                generation.state === 'failed' ||
                generation.state === 'cancelled' ||
                generation.state === 'abandoned'
              )
              {
                return generation
              }
              yield* Effect.promise(() => NodeTimersPromises.setTimeout(25))
            }
            return yield* Effect.die(`generation ${generationId} did not terminate`)
          },
        )
        const startNewAttempt = Effect.fn('ProposalGenerationService.test.startNewAttempt')(
          function* (input: {
            readonly threadId: ThreadId
            readonly proposalId: ProposalId
            readonly revisionId: ProposalRevisionId
            readonly revision: number
            readonly suffix: string
          })
          {
            const admissionKey = `proposal-verified:${input.revisionId}:${analyzerFingerprint}:${input.suffix}`
            const leaseFence = yield* leaseProposalAdmission({
              admissionKey,
              threadId: input.threadId,
              proposalId: input.proposalId,
              revisionId: input.revisionId,
              revision: input.revision,
              analyzerFingerprint,
            })
            return yield* generations.startAdmitted({
              threadId: input.threadId,
              proposalId: input.proposalId,
              revision: input.revision,
              revisionId: input.revisionId,
              analyzerFingerprint,
              admissionKey,
              leaseFence,
              forceNewAttempt: true,
            })
          },
        )

        const ready = yield* waitForTerminal(threadId, second.generationId)
        expect(ready.state).toBe('ready')
        expect(ready.authority).toBe('authoritative')
        expect(ready.freshness).toBe('fresh')
        expect(ready.workspaceSnapshotTreeOid).toBe(revision.baseSnapshot.workingTreeOid)
        expect(ready.analyzerVersion).toBe(analyzerFingerprint)
        expect(ready.baseGraphArtifact).toBeTruthy()
        expect(ready.proposedGraphArtifact).toBeTruthy()
        expect(ready.impactArtifact).toBeTruthy()
        expect(ready.impactProjectionArtifact).toBeTruthy()
        const admittedReuse = yield* generations.startAdmitted({
          threadId,
          proposalId,
          revision: 1,
          revisionId: revision.revisionId,
          analyzerFingerprint: ready.analyzerVersion,
          admissionKey: initialAdmissionKey,
          leaseFence: initialAdmissionLease,
        })
        expect(admittedReuse.generationId).toBe(ready.generationId)
        expect(admittedReuse.state).toBe('ready')
        const forcedRetry = yield* generations.startAdmitted({
          threadId,
          proposalId,
          revision: 1,
          revisionId: revision.revisionId,
          analyzerFingerprint: ready.analyzerVersion,
          admissionKey: initialAdmissionKey,
          leaseFence: initialAdmissionLease,
          forceNewAttempt: true,
        })
        expect(forcedRetry.generationId).not.toBe(ready.generationId)
        expect((yield* waitForTerminal(threadId, forcedRetry.generationId)).state).toBe('ready')
        expect((yield* generations.get({ threadId, generationId: ready.generationId })).state).toBe(
          'ready',
        )
        const fingerprintMismatch = yield* generations
          .startAdmitted({
            threadId,
            proposalId,
            revision: 1,
            revisionId: revision.revisionId,
            analyzerFingerprint: 'cartographer:stale-admission',
            admissionKey: `proposal-verified:${revision.revisionId}:cartographer:stale-admission`,
            leaseFence: initialAdmissionLease,
          })
          .pipe(Effect.flip)
        expect(fingerprintMismatch).toMatchObject({ failure: 'analysis-failed' })
        const revisionMismatch = yield* generations
          .startAdmitted({
            threadId,
            proposalId,
            revision: 1,
            revisionId: ProposalRevisionId.make('revision-wrong-exact-identity'),
            analyzerFingerprint: ready.analyzerVersion,
            admissionKey: 'proposal-verified:revision-wrong-exact-identity:cartographer:test',
            leaseFence: initialAdmissionLease,
          })
          .pipe(Effect.flip)
        expect(revisionMismatch).toMatchObject({ failure: 'scope-mismatch' })

        expect((yield* generations.latest({ threadId, proposalId }))?.generationId).toBe(
          forcedRetry.generationId,
        )

        const artifactRoot = NodePath.join(
          config.stateDir,
          'cartographer',
          'generations',
          second.generationId,
        )
        const architectureTarget = yield* generations.resolveArchitectureTarget(
          threadId,
          second.generationId,
        )
        expect(architectureTarget.proposedRoot).toBe(NodePath.join(artifactRoot, 'proposed'))
        expect(NodePath.basename(architectureTarget.baseGraphPath)).toMatch(
          /^base\.graph\.[0-9a-f]{64}\.json$/u,
        )
        expect(NodePath.basename(architectureTarget.proposedGraphPath)).toMatch(
          /^proposed\.graph\.[0-9a-f]{64}\.[0-9a-f]{64}\.json$/u,
        )
        expect(NodePath.basename(architectureTarget.impactPath)).toMatch(
          /^impact\.graph-diff-v1\.[0-9a-f]{64}\.json$/u,
        )
        const nativeImpact = yield* generations.resolveImpactTarget(threadId, second.generationId)
        expect(nativeImpact).toMatchObject({
          diff: { changed: true, addedNodes: ['target.txt'] },
          projection: { version: 1 },
        })
        const baseGraph = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(architectureTarget.baseGraphPath, 'utf8')),
        ) as { readonly content: string; readonly gitRef: string }
        const proposedGraph = JSON.parse(
          yield* Effect.promise(() =>
            NodeFSP.readFile(architectureTarget.proposedGraphPath, 'utf8'),
          ),
        ) as { readonly content: string; readonly gitRef: string }
        expect(baseGraph).toEqual({
          repoRoot: '.',
          content: 'working-base\r\n',
          gitRef: revision.baseSnapshot.workingTreeOid,
        })
        expect(proposedGraph).toEqual({
          repoRoot: '.',
          content: 'proposed-exact\r\n',
          gitRef: revision.proposedTreeOid,
        })
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(artifactRoot, 'proposed', 'target.txt'), 'utf8'),
          ),
        ).toBe('proposed-exact\r\n')
        const originalBaseGraphBytes = yield* Effect.promise(() =>
          NodeFSP.readFile(architectureTarget.baseGraphPath),
        )
        yield* Effect.promise(() =>
          NodeFSP.writeFile(architectureTarget.baseGraphPath, '{"gitRef":"tampered"}'),
        )
        expect(
          (yield* generations.resolveImpactTarget(threadId, second.generationId)).diff?.changed,
        ).toBe(true)
        expect(
          (yield* generations
            .resolveArchitectureTarget(threadId, second.generationId)
            .pipe(Effect.flip)).failure,
        ).toBe('generation_not_found')
        yield* Effect.promise(() =>
          NodeFSP.writeFile(architectureTarget.baseGraphPath, originalBaseGraphBytes),
        )
        const originalImpactBytes = yield* Effect.promise(() =>
          NodeFSP.readFile(architectureTarget.impactPath),
        )
        yield* Effect.promise(() =>
          NodeFSP.writeFile(architectureTarget.impactPath, '{"changed":true}'),
        )
        expect(
          (yield* generations.resolveImpactTarget(threadId, second.generationId).pipe(Effect.flip))
            .failure,
        ).toBe('generation_not_found')
        yield* Effect.promise(() =>
          NodeFSP.writeFile(architectureTarget.impactPath, originalImpactBytes),
        )

        const proposedTargetPath = NodePath.join(artifactRoot, 'proposed', 'target.txt')
        yield* Effect.promise(() => NodeFSP.writeFile(proposedTargetPath, 'tampered-root\n'))
        expect(
          (yield* generations
            .resolveArchitectureTarget(threadId, second.generationId)
            .pipe(Effect.flip)).failure,
        ).toBe('generation_not_found')
        yield* Effect.promise(() =>
          NodeFSP.writeFile(proposedTargetPath, Buffer.from('proposed-exact\r\n')),
        )
        expect(
          (yield* generations.resolveArchitectureTarget(threadId, second.generationId)).generation
            .generationId,
        ).toBe(second.generationId)

        const proposedRetainedCommitOid = yield* Effect.promise(() =>
          git(workspaceRoot, ['rev-parse', revision.proposedRetainedRef]),
        )
        const baseRetainedCommitOid = yield* Effect.promise(() =>
          git(workspaceRoot, ['rev-parse', revision.baseSnapshot.retainedRef]),
        )
        yield* Effect.promise(() =>
          git(workspaceRoot, ['update-ref', revision.proposedRetainedRef, baseRetainedCommitOid]),
        )
        expect(
          (yield* generations
            .resolveArchitectureTarget(threadId, second.generationId)
            .pipe(Effect.flip)).failure,
        ).toBe('generation_not_found')
        const movedRefGeneration = yield* startNewAttempt({
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          suffix: 'moved-ref',
        })
        const movedRefFailure = yield* waitForTerminal(threadId, movedRefGeneration.generationId)
        yield* Effect.promise(() =>
          git(workspaceRoot, [
            'update-ref',
            revision.proposedRetainedRef,
            proposedRetainedCommitOid,
          ]),
        )
        expect(movedRefFailure.state).toBe('failed')
        expect(movedRefFailure.errorCode).toBe('materialization-failed')
        expect(
          yield* Effect.promise(() =>
            pathExists(
              NodePath.join(
                config.stateDir,
                'cartographer',
                'generations',
                movedRefGeneration.generationId,
              ),
            ),
          ),
        ).toBe(false)

        yield* Effect.promise(() =>
          git(workspaceRoot, ['update-ref', '-d', revision.proposedRetainedRef]),
        )
        const missingRefGeneration = yield* startNewAttempt({
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          suffix: 'missing-ref',
        })
        const missingRefFailure = yield* waitForTerminal(
          threadId,
          missingRefGeneration.generationId,
        )
        yield* Effect.promise(() =>
          git(workspaceRoot, [
            'update-ref',
            revision.proposedRetainedRef,
            proposedRetainedCommitOid,
          ]),
        )
        expect(missingRefFailure).toMatchObject({
          state: 'failed',
          errorCode: 'materialization-failed',
        })

        yield* Effect.promise(() => NodeFSP.writeFile(badIdentityMarker, ''))
        const failedGeneration = yield* startNewAttempt({
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          suffix: 'bad-analyzer-identity',
        })
        const failed = yield* waitForTerminal(threadId, failedGeneration.generationId)
        yield* Effect.promise(() => NodeFSP.rm(badIdentityMarker, { force: true }))
        expect(failed.state).toBe('failed')
        expect(failed.errorCode).toBe('analysis-failed')
        const retryAdmissionKey = `proposal-verified:${revision.revisionId}:${ready.analyzerVersion}:retry-test`
        const retryAdmissionLease = yield* leaseProposalAdmission({
          admissionKey: retryAdmissionKey,
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          analyzerFingerprint: ready.analyzerVersion,
        })
        const admittedRetry = yield* generations.startAdmitted({
          threadId,
          proposalId,
          revision: 1,
          revisionId: revision.revisionId,
          analyzerFingerprint: ready.analyzerVersion,
          admissionKey: retryAdmissionKey,
          leaseFence: retryAdmissionLease,
        })
        expect(admittedRetry.generationId).not.toBe(failed.generationId)
        expect(['queued', 'preparing', 'analyzing', 'ready']).toContain(admittedRetry.state)
        expect((yield* waitForTerminal(threadId, admittedRetry.generationId)).state).toBe('ready')

        const cancelledAdmissionKey = `proposal-verified:${revision.revisionId}:${ready.analyzerVersion}:cancelled-before-start`
        const cancelledAdmissionLease = yield* leaseProposalAdmission({
          admissionKey: cancelledAdmissionKey,
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          analyzerFingerprint: ready.analyzerVersion,
        })
        const admissionRepository =
          yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
        yield* admissionRepository.cancelThread({
          threadId,
          now: '2026-08-20T12:00:02.000Z',
        })
        const cancelledBeforeStart = yield* generations
          .startAdmitted({
            threadId,
            proposalId,
            revision: 1,
            revisionId: revision.revisionId,
            analyzerFingerprint: ready.analyzerVersion,
            admissionKey: cancelledAdmissionKey,
            leaseFence: cancelledAdmissionLease,
          })
          .pipe(Effect.flip)
        expect(cancelledBeforeStart).toMatchObject({ failure: 'scope-mismatch' })
        const cancelledRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM proposal_generations
          WHERE architecture_admission_key = ${cancelledAdmissionKey}
        `
        expect(cancelledRows[0]?.count).toBe(0)

        const sentinelGenerationId = ProposalGenerationId.make('generation-legacy-sentinel')
        yield* sql`
          INSERT INTO proposal_generations (
            generation_id,
            proposal_id,
            revision_id,
            revision,
            thread_id,
            state,
            authority,
            workspace_snapshot_tree_oid,
            analyzer_version,
            artifact_root,
            base_graph_path,
            proposed_graph_path,
            impact_path,
            architecture_admission_key,
            error_code,
            created_at,
            updated_at
          )
          VALUES (
            ${sentinelGenerationId},
            ${proposalId},
            ${revision.revisionId},
            1,
            ${threadId},
            'failed',
            'authoritative',
            ${revision.baseSnapshot.workingTreeOid},
            'resolve-on-lease',
            ${NodePath.join(config.stateDir, 'cartographer', 'generations', sentinelGenerationId)},
            NULL,
            NULL,
            NULL,
            NULL,
            'analysis-failed',
            '2026-08-20T12:00:03.000Z',
            '2026-08-20T12:00:03.000Z'
          )
        `
        expect(
          (yield* generations.get({ threadId, generationId: sentinelGenerationId }))
            .analyzerVersion,
        ).toBe('resolve-on-lease')
        const sentinelAdmissionKey = `proposal-verified:${revision.revisionId}:resolve-on-lease`
        const sentinelLease = yield* leaseProposalAdmission({
          admissionKey: sentinelAdmissionKey,
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          analyzerFingerprint: 'resolve-on-lease',
        })
        const sentinelStart = yield* generations
          .startAdmitted({
            threadId,
            proposalId,
            revision: 1,
            revisionId: revision.revisionId,
            analyzerFingerprint: 'resolve-on-lease',
            admissionKey: sentinelAdmissionKey,
            leaseFence: sentinelLease,
          })
          .pipe(Effect.flip)
        expect(sentinelStart).toMatchObject({ failure: 'analysis-failed' })
        yield* sql`
          DELETE FROM proposal_generations
          WHERE generation_id = ${sentinelGenerationId}
        `
        expect(
          yield* Effect.promise(() =>
            pathExists(
              NodePath.join(
                config.stateDir,
                'cartographer',
                'generations',
                failedGeneration.generationId,
              ),
            ),
          ),
        ).toBe(false)
        expect(yield* Effect.promise(() => pathExists(artifactRoot))).toBe(true)

        const deletionRaceThreadId = ThreadId.make('thread-generation-deletion-race')
        const deletionRaceProposalId = ProposalId.make('proposal-generation-deletion-race')
        const deletionRaceRevision = yield* proposals.upsert({
          proposalId: deletionRaceProposalId,
          environmentId: EnvironmentId.make('environment-generation-exact'),
          projectId: ProjectId.make('project-generation-exact'),
          sourceThreadId: deletionRaceThreadId,
          producer: {
            providerSessionId: 'provider-session-generation-deletion-race',
            providerInstanceId: ProviderInstanceId.make('codex-generation'),
          },
          verifiedAnalyzerFingerprint: 'cartographer:0.1.0-test',
          cwd: workspaceRoot,
          changes: {
            _tag: 'typed',
            operations: [
              {
                _tag: 'modify',
                path: 'target.txt',
                beforeSha256: sha256('working-base\r\n') as never,
                content: { encoding: 'utf8', data: 'proposed-deletion-race\r\n' },
              },
            ],
          },
        })
        const deletionRaceAdmissionKey = `proposal-verified:${deletionRaceRevision.revisionId}:${analyzerFingerprint}:deletion-race`
        const deletionRaceLease = yield* leaseProposalAdmission({
          admissionKey: deletionRaceAdmissionKey,
          threadId: deletionRaceThreadId,
          proposalId: deletionRaceProposalId,
          revisionId: deletionRaceRevision.revisionId,
          revision: 1,
          analyzerFingerprint,
        })
        const deletionRaceStart = {
          threadId: deletionRaceThreadId,
          proposalId: deletionRaceProposalId,
          revisionId: deletionRaceRevision.revisionId,
          revision: 1,
          analyzerFingerprint,
          admissionKey: deletionRaceAdmissionKey,
          leaseFence: deletionRaceLease,
          forceNewAttempt: true,
        }
        const racingStart = yield* generations.startAdmitted(deletionRaceStart).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: 'failure' as const, error }),
            onSuccess: (generation) => ({ _tag: 'success' as const, generation }),
          }),
          Effect.forkScoped,
        )
        yield* generations.cancelThread(deletionRaceThreadId)
        const racingStartResult = yield* Fiber.join(racingStart)
        if (racingStartResult._tag === 'success')
        {
          const cancelled = yield* waitForTerminal(
            deletionRaceThreadId,
            racingStartResult.generation.generationId,
          )
          expect(cancelled.state).toBe('cancelled')
          expect(cancelled.errorCode).toBe('thread-deleted')
        }
        else
        {
          expect(racingStartResult.error._tag).toBe('ProposalGenerationError')
          if (racingStartResult.error._tag === 'ProposalGenerationError')
          {
            expect(racingStartResult.error.failure).toBe('scope-mismatch')
          }
        }
        const racingRows = yield* sql<{ readonly state: string }>`
          SELECT state
          FROM proposal_generations
          WHERE thread_id = ${deletionRaceThreadId}
        `
        expect(racingRows.every((row) => row.state === 'cancelled' || row.state === 'failed')).toBe(
          true,
        )
        const racingRestart = yield* generations.startAdmitted(deletionRaceStart).pipe(Effect.flip)
        expect(racingRestart._tag).toBe('ProposalGenerationError')

        const deletionAdmissionKey = `proposal-verified:${revision.revisionId}:${analyzerFingerprint}:cancel-thread`
        const deletionLease = yield* leaseProposalAdmission({
          admissionKey: deletionAdmissionKey,
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          analyzerFingerprint,
        })
        const deletionStart = {
          threadId,
          proposalId,
          revisionId: revision.revisionId,
          revision: 1,
          analyzerFingerprint,
          admissionKey: deletionAdmissionKey,
          leaseFence: deletionLease,
          forceNewAttempt: true,
        }
        const deletionGeneration = yield* generations.startAdmitted(deletionStart)
        yield* generations.cancelThread(threadId)
        const deletionCancelled = yield* waitForTerminal(threadId, deletionGeneration.generationId)
        expect(deletionCancelled.state).toBe('cancelled')
        expect(deletionCancelled.errorCode).toBe('thread-deleted')
        expect(
          yield* Effect.promise(() =>
            pathExists(
              NodePath.join(
                config.stateDir,
                'cartographer',
                'generations',
                deletionGeneration.generationId,
              ),
            ),
          ),
        ).toBe(false)
        const deletedThreadRestart = yield* generations
          .startAdmitted(deletionStart)
          .pipe(Effect.flip)
        expect(deletedThreadRestart._tag).toBe('ProposalGenerationError')
        if (deletedThreadRestart._tag !== 'ProposalGenerationError')
        {
          return yield* Effect.die('deleted generation restart returned the wrong error type')
        }
        expect(deletedThreadRestart.failure).toBe('scope-mismatch')

        yield* Effect.promise(() => NodeFSP.writeFile(analyzerDependencyPath, 'runtime-v2\n'))
        expect(
          (yield* generations.get({ threadId, generationId: second.generationId })).freshness,
        ).toBe('analyzer-changed')
        yield* Effect.promise(() => NodeFSP.writeFile(analyzerDependencyPath, 'runtime-v1\n'))

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, 'submodule', 'nested.txt'),
            'submodule-drift\n',
          ),
        )
        expect(
          (yield* generations.get({ threadId, generationId: second.generationId })).freshness,
        ).toBe('worktree-changed')
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, 'submodule', 'nested.txt'),
            'submodule-base\n',
          ),
        )

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, 'target.txt'),
            Buffer.from('worktree-drift\r\n'),
          ),
        )
        expect(
          (yield* generations.get({ threadId, generationId: second.generationId })).freshness,
        ).toBe('worktree-changed')
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, 'target.txt'),
            Buffer.from('working-base\r\n'),
          ),
        )

        yield* Effect.promise(() =>
          git(workspaceRoot, ['commit', '--allow-empty', '-m', 'move head']),
        )
        expect(
          (yield* generations.get({ threadId, generationId: second.generationId })).freshness,
        ).toBe('base-changed')

        const concurrencyInputs: Array<{
          readonly threadId: ThreadId
          readonly proposalId: ProposalId
          readonly revisionId: ProposalRevisionId
        }> = []
        for (let index = 0; index < 3; index += 1)
        {
          const concurrentThreadId = ThreadId.make(`thread-generation-concurrency-${index}`)
          const concurrentProposalId = ProposalId.make(`proposal-generation-concurrency-${index}`)
          const concurrentRevision = yield* proposals.upsert({
            proposalId: concurrentProposalId,
            environmentId: EnvironmentId.make('environment-generation-exact'),
            projectId: ProjectId.make('project-generation-exact'),
            sourceThreadId: concurrentThreadId,
            producer: {
              providerSessionId: `provider-session-generation-concurrency-${index}`,
              providerInstanceId: ProviderInstanceId.make('codex-generation'),
            },
            verifiedAnalyzerFingerprint: 'cartographer:0.1.0-test',
            cwd: workspaceRoot,
            changes: {
              _tag: 'typed',
              operations: [
                {
                  _tag: 'modify',
                  path: 'target.txt',
                  beforeSha256: sha256('working-base\r\n') as never,
                  content: {
                    encoding: 'utf8',
                    data: `proposed-concurrent-${index}\r\n`,
                  },
                },
              ],
            },
          })
          concurrencyInputs.push({
            threadId: concurrentThreadId,
            proposalId: concurrentProposalId,
            revisionId: concurrentRevision.revisionId,
          })
        }
        yield* Effect.promise(() => NodeFSP.writeFile(analyzerLifecycleLog, ''))
        const concurrentStarts = yield* Effect.all(
          concurrencyInputs.map((input, index) =>
            startNewAttempt({
              ...input,
              revision: 1,
              suffix: `concurrent-${index}`,
            }),
          ),
          { concurrency: 'unbounded' },
        )
        const concurrentTerminals = yield* Effect.all(
          concurrentStarts.map((generation, index) =>
            waitForTerminal(concurrencyInputs[index]!.threadId, generation.generationId),
          ),
          { concurrency: 'unbounded' },
        )
        expect(concurrentTerminals.map((generation) => generation.state)).toEqual([
          'ready',
          'ready',
          'ready',
        ])
        const analyzerLifecycle = (yield* Effect.promise(() =>
          NodeFSP.readFile(analyzerLifecycleLog, 'utf8'),
        ))
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                readonly event: 'start' | 'end'
                readonly out: string
              },
          )
        let activeAnalyzerCount = 0
        let maximumAnalyzerCount = 0
        for (const event of analyzerLifecycle)
        {
          activeAnalyzerCount += event.event === 'start' ? 1 : -1
          maximumAnalyzerCount = Math.max(maximumAnalyzerCount, activeAnalyzerCount)
          expect(activeAnalyzerCount).toBeGreaterThanOrEqual(0)
        }
        expect(maximumAnalyzerCount).toBe(1)
        expect(activeAnalyzerCount).toBe(0)

        const abandonedId = ProposalGenerationId.make('generation-startup-abandoned')
        const olderAbandonedId = ProposalGenerationId.make('generation-startup-abandoned-older')
        const abandonedArtifactRoot = NodePath.join(
          config.stateDir,
          'cartographer',
          'generations',
          abandonedId,
        )
        const olderAbandonedArtifactRoot = NodePath.join(
          config.stateDir,
          'cartographer',
          'generations',
          olderAbandonedId,
        )
        yield* Effect.promise(async () =>
        {
          await Promise.all([
            NodeFSP.mkdir(abandonedArtifactRoot, { recursive: true }),
            NodeFSP.mkdir(olderAbandonedArtifactRoot, { recursive: true }),
          ])
          await Promise.all([
            NodeFSP.writeFile(NodePath.join(abandonedArtifactRoot, 'partial.json'), '{}'),
            NodeFSP.writeFile(NodePath.join(olderAbandonedArtifactRoot, 'partial.json'), '{}'),
          ])
        })
        const createdAt = '2026-01-01T00:00:00.000Z'
        yield* sql`
          INSERT INTO proposal_generations (
            generation_id,
            proposal_id,
            revision_id,
            revision,
            thread_id,
            state,
            authority,
            workspace_snapshot_tree_oid,
            analyzer_version,
            artifact_root,
            base_graph_path,
            proposed_graph_path,
            impact_path,
            error_code,
            created_at,
            updated_at
          )
          VALUES (
            ${abandonedId},
            ${proposalId},
            ${revision.revisionId},
            ${revision.revision},
            ${threadId},
            'analyzing',
            'authoritative',
            ${revision.baseSnapshot.workingTreeOid},
            ${ready.analyzerVersion},
            ${abandonedArtifactRoot},
            NULL,
            NULL,
            NULL,
            NULL,
            ${createdAt},
            ${createdAt}
          )
        `
        const expiredId = ProposalGenerationId.make('generation-retention-expired')
        const expiredArtifactRoot = NodePath.join(
          config.stateDir,
          'cartographer',
          'generations',
          expiredId,
        )
        const orphanArtifactRoot = NodePath.join(
          config.stateDir,
          'cartographer',
          'generations',
          'generation-retention-orphan',
        )
        const retentionOld = '2020-01-01T00:00:00.000Z'
        yield* Effect.promise(async () =>
        {
          await Promise.all([
            NodeFSP.mkdir(expiredArtifactRoot, { recursive: true }),
            NodeFSP.mkdir(orphanArtifactRoot, { recursive: true }),
          ])
          await Promise.all([
            NodeFSP.utimes(expiredArtifactRoot, 1_600_000_000, 1_600_000_000),
            NodeFSP.utimes(orphanArtifactRoot, 1_600_000_000, 1_600_000_000),
          ])
        })
        yield* sql`
          INSERT INTO proposal_generations (
            generation_id,
            proposal_id,
            revision_id,
            revision,
            thread_id,
            state,
            authority,
            workspace_snapshot_tree_oid,
            analyzer_version,
            artifact_root,
            base_graph_path,
            proposed_graph_path,
            impact_path,
            error_code,
            created_at,
            updated_at
          )
          SELECT
            ${olderAbandonedId},
            proposal_id,
            revision_id,
            revision,
            thread_id,
            'abandoned',
            authority,
            workspace_snapshot_tree_oid,
            analyzer_version,
            ${olderAbandonedArtifactRoot},
            NULL,
            NULL,
            NULL,
            'server-restarted',
            ${retentionOld},
            ${retentionOld}
          FROM proposal_generations
          WHERE generation_id = ${abandonedId}
        `
        yield* sql`
          UPDATE proposal_generations
          SET created_at = ${retentionOld}, updated_at = ${retentionOld}
          WHERE generation_id = ${second.generationId}
        `
        yield* sql`
          INSERT INTO proposal_generations (
            generation_id,
            proposal_id,
            revision_id,
            revision,
            thread_id,
            state,
            authority,
            workspace_snapshot_tree_oid,
            analyzer_version,
            artifact_root,
            base_graph_path,
            proposed_graph_path,
            impact_path,
            error_code,
            created_at,
            updated_at
          )
          VALUES (
            ${expiredId},
            ${proposalId},
            ${revision.revisionId},
            ${revision.revision},
            ${threadId},
            'failed',
            'authoritative',
            ${revision.baseSnapshot.workingTreeOid},
            ${ready.analyzerVersion},
            ${expiredArtifactRoot},
            NULL,
            NULL,
            NULL,
            'analysis-failed',
            ${retentionOld},
            ${retentionOld}
          )
        `
        // it.effect's TestClock starts at epoch 0; pin a fixed present so the
        // 24h retention cutoff lands after the 2020 seeded timestamps
        yield* TestClock.setTime(Date.UTC(2026, 0, 1))
        const recovered = yield* ProposalGenerationService.make
        const abandoned = yield* recovered.get({ threadId, generationId: abandonedId })
        expect(abandoned.state).toBe('abandoned')
        expect(abandoned.errorCode).toBe('server-restarted')
        expect(yield* Effect.promise(() => pathExists(abandonedArtifactRoot))).toBe(false)
        expect(yield* Effect.promise(() => pathExists(olderAbandonedArtifactRoot))).toBe(false)
        expect(yield* Effect.promise(() => pathExists(artifactRoot))).toBe(true)
        expect(yield* Effect.promise(() => pathExists(expiredArtifactRoot))).toBe(false)
        expect(yield* Effect.promise(() => pathExists(orphanArtifactRoot))).toBe(false)
        expect(
          yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM proposal_generations
            WHERE generation_id IN (${expiredId}, ${olderAbandonedId})
          `,
        ).toEqual([{ count: 0 }])
        expect((yield* recovered.get({ threadId, generationId: second.generationId })).state).toBe(
          'ready',
        )

        yield* Effect.promise(async () =>
        {
          await NodeFSP.mkdir(abandonedArtifactRoot, { recursive: true })
          await NodeFSP.writeFile(NodePath.join(abandonedArtifactRoot, 'stale-partial.json'), '{}')
        })
        yield* TestClock.setTime(Date.UTC(2026, 0, 3))
        const beyondGrace = yield* ProposalGenerationService.make
        const retainedRestart = yield* beyondGrace.get({ threadId, generationId: abandonedId })
        expect(retainedRestart.state).toBe('abandoned')
        expect(retainedRestart.errorCode).toBe('server-restarted')
        const latestDurable = yield* beyondGrace.latest({
          threadId,
          proposalId,
          revision: revision.revision,
        })
        expect(latestDurable?.generationId).not.toBe(abandonedId)
        expect(
          yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM proposal_generations
            WHERE generation_id = ${latestDurable?.generationId ?? ''}
              AND architecture_admission_key IS NOT NULL
          `,
        ).toEqual([{ count: 1 }])
        expect(yield* Effect.promise(() => pathExists(abandonedArtifactRoot))).toBe(false)
      }).pipe(Effect.provide(TestLayer))
    }),
  )

  it.effect('abandons an in-flight generation when its service scope closes', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const workspaceRoot = yield* Effect.promise(initializeRepository)
        const baseDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-proposal-generation-state-')),
        )
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all([
              NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
              NodeFSP.rm(baseDir, { recursive: true, force: true }),
            ]),
          ).pipe(Effect.ignore),
        )
        const firstAnalyzerStarted = yield* Deferred.make<void>()
        const releaseFirstAnalyzer = yield* Deferred.make<void>()
        let analysisCallCount = 0
        const analyzer = CartographerAnalyzer.CartographerAnalyzer.of({
          identify: Effect.succeed({
            cliPath: '/test/cartographer',
            fingerprint: 'analyzer-restart-test-v1',
          }),
          prepareCurrentWorktree: () => Effect.die('unexpected prepareCurrentWorktree'),
          buildProjectAtlas: () => Effect.die('unexpected buildProjectAtlas'),
          analyzeTrees: () =>
            Effect.gen(function* ()
            {
              analysisCallCount += 1
              if (analysisCallCount === 1)
              {
                yield* Deferred.succeed(firstAnalyzerStarted, undefined)
                yield* Deferred.await(releaseFirstAnalyzer).pipe(Effect.uninterruptible)
              }
              return yield* Effect.never
            }),
        })
        const TestLayer = ProposalGenerationService.layer.pipe(
          Layer.provideMerge(ProposalService.layer),
          Layer.provideMerge(ProcessRunner.layer),
          Layer.provideMerge(Layer.succeed(CartographerAnalyzer.CartographerAnalyzer, analyzer)),
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
          Layer.provideMerge(NodeServices.layer),
        )

        yield* Effect.gen(function* ()
        {
          const proposals = yield* ProposalService.ProposalService
          const threadId = ThreadId.make('thread-generation-server-restart')
          const proposalId = ProposalId.make('proposal-generation-server-restart')
          const revision = yield* proposals.upsert({
            proposalId,
            environmentId: EnvironmentId.make('environment-generation-server-restart'),
            projectId: ProjectId.make('project-generation-server-restart'),
            sourceThreadId: threadId,
            producer: {
              providerSessionId: 'provider-session-generation-server-restart',
              providerInstanceId: ProviderInstanceId.make('codex-generation'),
            },
            verifiedAnalyzerFingerprint: 'analyzer-restart-test-v1',
            cwd: workspaceRoot,
            changes: {
              _tag: 'typed',
              operations: [
                {
                  _tag: 'modify',
                  path: 'target.txt',
                  beforeSha256: sha256('working-base\r\n') as never,
                  content: { encoding: 'utf8', data: 'proposed-server-restart\r\n' },
                },
              ],
            },
          })

          const analyzerFingerprint = 'analyzer-restart-test-v1'
          const firstAdmissionKey = `proposal-verified:${revision.revisionId}:${analyzerFingerprint}:first`
          const secondAdmissionKey = `proposal-verified:${revision.revisionId}:${analyzerFingerprint}:second`
          const rejectedAdmissionKey = `proposal-verified:${revision.revisionId}:${analyzerFingerprint}:closed`
          const firstLease = yield* leaseProposalAdmission({
            admissionKey: firstAdmissionKey,
            threadId,
            proposalId,
            revisionId: revision.revisionId,
            revision: 1,
            analyzerFingerprint,
          })
          const secondLease = yield* leaseProposalAdmission({
            admissionKey: secondAdmissionKey,
            threadId,
            proposalId,
            revisionId: revision.revisionId,
            revision: 1,
            analyzerFingerprint,
          })
          const rejectedLease = yield* leaseProposalAdmission({
            admissionKey: rejectedAdmissionKey,
            threadId,
            proposalId,
            revisionId: revision.revisionId,
            revision: 1,
            analyzerFingerprint,
          })

          const serviceScope = yield* Scope.make('sequential')
          yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void))
          const generations = yield* ProposalGenerationService.make.pipe(
            Effect.provideService(Scope.Scope, serviceScope),
          )
          const first = yield* generations.startAdmitted({
            threadId,
            proposalId,
            revision: 1,
            revisionId: revision.revisionId,
            analyzerFingerprint,
            admissionKey: firstAdmissionKey,
            leaseFence: firstLease,
          })
          yield* Deferred.await(firstAnalyzerStarted)
          const secondStart = yield* generations
            .startAdmitted({
              threadId,
              proposalId,
              revision: 1,
              revisionId: revision.revisionId,
              analyzerFingerprint,
              admissionKey: secondAdmissionKey,
              leaseFence: secondLease,
              forceNewAttempt: true,
            })
            .pipe(Effect.forkScoped)
          let admittedGenerationId: ProposalGenerationId | null = null
          for (let attempt = 0; attempt < 200; attempt += 1)
          {
            const latest = yield* generations.latest({ threadId, proposalId, revision: 1 })
            if (latest !== null && latest.generationId !== first.generationId)
            {
              admittedGenerationId = latest.generationId
              break
            }
            yield* Effect.promise(() => NodeTimersPromises.setTimeout(5))
          }
          if (admittedGenerationId === null)
          {
            return yield* Effect.die('concurrent generation was not admitted')
          }
          const closeService = yield* Scope.close(serviceScope, Exit.void).pipe(
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.succeed(releaseFirstAnalyzer, undefined)
          const second = yield* Fiber.join(secondStart)
          yield* Fiber.join(closeService)

          expect(second.generationId).toBe(admittedGenerationId)
          const superseded = yield* generations.get({
            threadId,
            generationId: first.generationId,
          })
          expect(superseded.state).toBe('cancelled')
          expect(superseded.errorCode).toBe('superseded')

          const abandoned = yield* generations.get({
            threadId,
            generationId: second.generationId,
          })
          expect(abandoned.state).toBe('abandoned')
          expect(abandoned.errorCode).toBe('server-restarted')
          expect(
            yield* Effect.promise(() =>
              pathExists(
                NodePath.join(baseDir, 'cartographer', 'generations', second.generationId),
              ),
            ),
          ).toBe(false)
          const rejected = yield* generations
            .startAdmitted({
              threadId,
              proposalId,
              revision: 1,
              revisionId: revision.revisionId,
              analyzerFingerprint,
              admissionKey: rejectedAdmissionKey,
              leaseFence: rejectedLease,
              forceNewAttempt: true,
            })
            .pipe(Effect.flip)
          expect(rejected._tag).toBe('ProposalGenerationError')
          if (rejected._tag !== 'ProposalGenerationError')
          {
            throw new Error('expected proposal generation failure')
          }
          expect(rejected.failure).toBe('process-failed')
          expect(
            (yield* generations.latest({ threadId, proposalId, revision: 1 }))?.generationId,
          ).toBe(second.generationId)
        }).pipe(Effect.provide(TestLayer))
      }),
    ),
  )
})
