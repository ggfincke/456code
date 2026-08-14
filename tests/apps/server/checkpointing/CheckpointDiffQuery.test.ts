// tests/apps/server/checkpointing/CheckpointDiffQuery.test.ts
// verifies checkpoint diff query identity and revision-range behavior

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import {
  CheckpointRef,
  type OrchestrateRunExecution,
  ProjectId,
  ThreadId,
  TurnId,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as Scope from 'effect/Scope'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import { describe, expect } from 'vite-plus/test'

import {
  CheckpointIdentityResolver,
  layer as CheckpointIdentityLayer,
  type RecordedCheckpointIdentity,
} from '../../../../apps/server/src/checkpointing/CheckpointIdentity.ts'
import { checkpointRefForThreadTurn } from '../../../../apps/server/src/checkpointing/Utils.ts'
import * as CheckpointDiffQueryLayers from '../../../../apps/server/src/orchestration/Layers/CheckpointDiffQuery.ts'
import * as CheckpointDiffQuery from '../../../../apps/server/src/orchestration/Services/CheckpointDiffQuery.ts'
import * as ProjectionSnapshotQuery from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import {
  CheckpointRunExecutionHeadUnavailableError,
  CheckpointThreadNotFoundError,
} from '../../../../apps/server/src/orchestration/Errors.ts'
import * as ServerConfig from '../../../../apps/server/src/config.ts'
import * as GitVcsDriver from '../../../../apps/server/src/vcs/GitVcsDriver.ts'
import * as VcsProcess from '../../../../apps/server/src/vcs/VcsProcess.ts'
import { makeProjectionSnapshotQueryStub } from '../projectionSnapshotQueryTestHelpers.ts'

interface ReadRangeCall
{
  readonly from: RecordedCheckpointIdentity
  readonly to: RecordedCheckpointIdentity
  readonly currentRoot: string | null
}

interface GitExecuteCall
{
  readonly cwd: string
  readonly args: ReadonlyArray<string>
}

function unsupported<A>(): Effect.Effect<A>
{
  return Effect.die(new Error('Unsupported checkpoint identity call in test'))
}

function makeLayer(input: {
  readonly query: ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']
  readonly readRangeCalls: Array<ReadRangeCall>
  readonly executeCalls: Array<GitExecuteCall>
  readonly diff?: string
})
{
  const identityLayer = Layer.succeed(
    CheckpointIdentityResolver,
    CheckpointIdentityResolver.of({
      resolveCapture: unsupported,
      resolveRead: unsupported,
      resolveDestructive: unsupported,
      resolveRepositoryRevision: unsupported,
      resolveRepositoryObjectRevision: unsupported,
      resolveReadRange: (range) =>
        Effect.sync(() =>
        {
          input.readRangeCalls.push(range)
          return {
            cwd: '/canonical/repository',
            repositoryCommonDir: '/canonical/repository/.git',
            fromCommitOid: range.from.checkpointCommitOid ?? 'legacy-from-oid',
            toCommitOid: range.to.checkpointCommitOid ?? 'legacy-to-oid',
          }
        }),
    }),
  )
  const gitLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
    execute: (request) =>
      Effect.sync(() =>
      {
        input.executeCalls.push({ cwd: request.cwd, args: request.args })
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: input.diff ?? 'diff patch',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      }),
  })
  return CheckpointDiffQueryLayers.layer.pipe(
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, input.query)),
    Layer.provideMerge(identityLayer),
    Layer.provideMerge(gitLayer),
  )
}

function runGit(cwd: string, args: ReadonlyArray<string>): string
{
  return NodeChildProcess.execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim()
}

function commitFile(cwd: string, contents: string, message: string): string
{
  NodeFS.writeFileSync(NodePath.join(cwd, 'tracked.txt'), contents, 'utf8')
  runGit(cwd, ['add', 'tracked.txt'])
  runGit(cwd, ['commit', '-m', message])
  return runGit(cwd, ['rev-parse', 'HEAD'])
}

function initializeRepository(cwd: string): string
{
  NodeFS.mkdirSync(cwd, { recursive: true })
  runGit(cwd, ['init', '--initial-branch=main'])
  runGit(cwd, ['config', 'user.email', 'checkpoint-diff@example.com'])
  runGit(cwd, ['config', 'user.name', 'Checkpoint Diff Test'])
  return commitFile(cwd, 'base\n', 'Base')
}

function makeFixtureRoot(): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
>
{
  return Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: 'checkpoint-run-diff-' })
  })
}

function makeRealGitLayer(query: ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service'])
{
  return CheckpointDiffQueryLayers.layer.pipe(
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, query)),
    Layer.provideMerge(CheckpointIdentityLayer),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: 't3-checkpoint-run-diff-test-',
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  )
}

function authoritativeIdentity(input: {
  readonly threadId: ThreadId
  readonly turnCount: number
  readonly commitOid: string
}): RecordedCheckpointIdentity
{
  return {
    checkpointTurnCount: input.turnCount,
    checkpointRef: checkpointRefForThreadTurn(input.threadId, input.turnCount),
    checkpointCaptureRoot: '/capture/worktree',
    checkpointRepositoryCommonDir: '/capture/repository/.git',
    checkpointCommitOid: input.commitOid,
  }
}

function runExecution(input: {
  readonly threadId: ThreadId
  readonly repositoryRoot: string
  readonly repositoryCommonDir: string
  readonly baseOid: string
  readonly observedHeadOid: string | null
}): OrchestrateRunExecution
{
  return {
    threadId: input.threadId,
    runId: 'run-exact-diff',
    planRevision: 1,
    sourceTurnId: TurnId.make('turn-exact-diff'),
    sourceSequence: 10,
    repositoryRoot: input.repositoryRoot,
    repositoryCommonDir: input.repositoryCommonDir,
    baseOid: input.baseOid,
    lifecycle: 'active',
    availability: 'unavailable',
    integrationRoot: null,
    integrationCommonDir: null,
    integrationBranch: null,
    integrationOid: input.observedHeadOid,
    observedHeadOid: input.observedHeadOid,
    finalHeadOid: null,
    closeReason: null,
    current: true,
    admittedAt: '2026-08-09T03:00:00.000Z',
    updatedAt: '2026-08-09T03:01:00.000Z',
    terminalAt: null,
    jobs: [],
  }
}

describe('CheckpointDiffQueryLayers.layer', () =>
{
  it.effect('uses the narrow full-thread context and diffs its recorded OIDs', () =>
    Effect.gen(function* ()
    {
      const projectId = ProjectId.make('project-full-thread')
      const threadId = ThreadId.make('thread-full-thread')
      const from = authoritativeIdentity({ threadId, turnCount: 0, commitOid: 'from-oid' })
      const to = authoritativeIdentity({ threadId, turnCount: 4, commitOid: 'to-oid' })
      let broadLookupCalls = 0
      let narrowLookupCalls = 0
      const readRangeCalls: Array<ReadRangeCall> = []
      const executeCalls: Array<GitExecuteCall> = []
      const layer = makeLayer({
        readRangeCalls,
        executeCalls,
        diff: 'full thread diff patch',
        query: makeProjectionSnapshotQueryStub({
          getThreadCheckpointContext: () =>
            Effect.sync(() =>
            {
              broadLookupCalls += 1
              return Option.none()
            }),
          getFullThreadDiffContext: () =>
            Effect.sync(() =>
            {
              narrowLookupCalls += 1
              return Option.some({
                threadId,
                projectId,
                workspaceRoot: '/workspace',
                worktreePath: '/selected/worktree',
                latestCheckpointTurnCount: 4,
                fromCheckpointIdentity: from,
                toCheckpointIdentity: to,
              })
            }),
        }),
      })

      const result = yield* Effect.gen(function* ()
      {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        })
      }).pipe(Effect.provide(layer))

      expect(broadLookupCalls).toBe(0)
      expect(narrowLookupCalls).toBe(1)
      expect(readRangeCalls).toEqual([{ from, to, currentRoot: '/selected/worktree' }])
      expect(executeCalls).toEqual([
        {
          cwd: '/canonical/repository',
          args: [
            'diff',
            '--patch',
            '--no-color',
            '--no-ext-diff',
            '--no-textconv',
            '--ignore-all-space',
            'from-oid',
            'to-oid',
          ],
        },
      ])
      expect(result).toEqual({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 4,
        diff: 'full thread diff patch',
      })
    }),
  )

  it.effect('passes the durable turn-zero identity into a turn diff', () =>
    Effect.gen(function* ()
    {
      const projectId = ProjectId.make('project-turn-zero')
      const threadId = ThreadId.make('thread-turn-zero')
      const baseline = authoritativeIdentity({
        threadId,
        turnCount: 0,
        commitOid: 'baseline-oid',
      })
      const target = authoritativeIdentity({ threadId, turnCount: 1, commitOid: 'target-oid' })
      const readRangeCalls: Array<ReadRangeCall> = []
      const executeCalls: Array<GitExecuteCall> = []
      const layer = makeLayer({
        readRangeCalls,
        executeCalls,
        query: makeProjectionSnapshotQueryStub({
          getThreadCheckpointContext: () =>
            Effect.succeed(
              Option.some({
                threadId,
                projectId,
                workspaceRoot: '/selected/worktree',
                worktreePath: null,
                baselineCheckpointIdentity: baseline,
                checkpoints: [
                  {
                    turnId: TurnId.make('turn-1'),
                    checkpointTurnCount: 1,
                    checkpointRef: CheckpointRef.make(target.checkpointRef),
                    status: 'ready',
                    files: [],
                    assistantMessageId: null,
                    completedAt: '2026-01-01T00:00:00.000Z',
                    checkpointCaptureRoot: target.checkpointCaptureRoot,
                    checkpointRepositoryCommonDir: target.checkpointRepositoryCommonDir,
                    checkpointCommitOid: target.checkpointCommitOid,
                  },
                ],
              }),
            ),
        }),
      })

      const result = yield* Effect.gen(function* ()
      {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        })
      }).pipe(Effect.provide(layer))

      expect(readRangeCalls).toEqual([
        { from: baseline, to: target, currentRoot: '/selected/worktree' },
      ])
      expect(executeCalls[0]?.args).toEqual([
        'diff',
        '--patch',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-all-space',
        'baseline-oid',
        'target-oid',
      ])
      expect(result.diff).toBe('diff patch')
    }),
  )

  it.effect('resolves authoritative captures without a current workspace root', () =>
    Effect.gen(function* ()
    {
      const projectId = ProjectId.make('project-capture-only')
      const threadId = ThreadId.make('thread-capture-only')
      const from = authoritativeIdentity({ threadId, turnCount: 0, commitOid: 'from-oid' })
      const to = authoritativeIdentity({ threadId, turnCount: 2, commitOid: 'to-oid' })
      const readRangeCalls: Array<ReadRangeCall> = []
      const executeCalls: Array<GitExecuteCall> = []
      const layer = makeLayer({
        readRangeCalls,
        executeCalls,
        query: makeProjectionSnapshotQueryStub({
          getFullThreadDiffContext: () =>
            Effect.succeed(
              Option.some({
                threadId,
                projectId,
                // mixed-version projection rows may omit the current path while
                // the authoritative capture root remains independently usable
                workspaceRoot: null as unknown as string,
                worktreePath: null,
                latestCheckpointTurnCount: 2,
                fromCheckpointIdentity: from,
                toCheckpointIdentity: to,
              }),
            ),
        }),
      })

      const result = yield* Effect.gen(function* ()
      {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 2,
        })
      }).pipe(Effect.provide(layer))

      expect(readRangeCalls).toEqual([{ from, to, currentRoot: null }])
      expect(executeCalls).toHaveLength(1)
      expect(result.diff).toBe('diff patch')
    }),
  )

  it.effect('diffs the captured base and observed OIDs instead of the later live HEAD', () =>
    Effect.gen(function* ()
    {
      const fixtureRoot = yield* makeFixtureRoot()
      const repositoryRoot = NodePath.join(fixtureRoot, 'repository')
      const baseOid = initializeRepository(repositoryRoot)
      const observedHeadOid = commitFile(repositoryRoot, 'captured\n', 'Captured head')
      commitFile(repositoryRoot, 'later live head\n', 'Later live head')
      const canonicalRoot = NodeFS.realpathSync(repositoryRoot)
      const commonDir = NodeFS.realpathSync(NodePath.join(repositoryRoot, '.git'))
      const threadId = ThreadId.make('thread-exact-run-diff')
      const execution = runExecution({
        threadId,
        repositoryRoot: canonicalRoot,
        repositoryCommonDir: commonDir,
        baseOid,
        observedHeadOid,
      })
      const query = makeProjectionSnapshotQueryStub({
        getOrchestrateRunExecution: () => Effect.succeed(Option.some(execution)),
      })

      const result = yield* Effect.gen(function* ()
      {
        const diffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery
        return yield* diffQuery.getRunExecutionDiffV1({
          threadId,
          runId: execution.runId,
          planRevision: execution.planRevision,
          ignoreWhitespace: false,
        })
      }).pipe(Effect.provide(makeRealGitLayer(query)))

      expect(result).toMatchObject({
        threadId,
        runId: execution.runId,
        planRevision: execution.planRevision,
        baseSha: baseOid,
        headSha: observedHeadOid,
        finalized: false,
      })
      expect(result.diff).toContain('+captured')
      expect(result.diff).not.toContain('later live head')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect(
    'rehydrates a terminal exact diff from the common object database after path reuse',
    () =>
      Effect.gen(function* ()
      {
        const fixtureRoot = yield* makeFixtureRoot()
        const repositoryRoot = NodePath.join(fixtureRoot, 'repository')
        const sourceRoot = NodePath.join(fixtureRoot, 'source-worktree')
        const integrationRoot = NodePath.join(fixtureRoot, 'integration-worktree')
        const baseOid = initializeRepository(repositoryRoot)
        runGit(repositoryRoot, ['branch', 'source', baseOid])
        runGit(repositoryRoot, ['worktree', 'add', sourceRoot, 'source'])
        runGit(repositoryRoot, ['worktree', 'add', '-b', 'integration', integrationRoot, baseOid])
        const finalHeadOid = commitFile(integrationRoot, 'retained result\n', 'Retained result')
        const canonicalSourceRoot = NodeFS.realpathSync(sourceRoot)
        const canonicalIntegrationRoot = NodeFS.realpathSync(integrationRoot)
        const commonDir = NodeFS.realpathSync(NodePath.join(repositoryRoot, '.git'))
        const threadId = ThreadId.make('thread-terminal-pruned-run-diff')
        const execution: OrchestrateRunExecution = {
          ...runExecution({
            threadId,
            repositoryRoot: canonicalSourceRoot,
            repositoryCommonDir: commonDir,
            baseOid,
            observedHeadOid: finalHeadOid,
          }),
          lifecycle: 'completed',
          availability: 'unavailable',
          integrationRoot: canonicalIntegrationRoot,
          integrationCommonDir: commonDir,
          integrationBranch: 'integration',
          integrationOid: finalHeadOid,
          finalHeadOid,
          closeReason: 'Completed before cleanup.',
          terminalAt: '2026-08-09T03:01:00.000Z',
        }

        runGit(repositoryRoot, ['worktree', 'remove', '--force', sourceRoot])
        runGit(repositoryRoot, ['worktree', 'remove', '--force', integrationRoot])
        runGit(repositoryRoot, ['branch', '-D', 'source'])
        runGit(repositoryRoot, ['branch', '-D', 'integration'])

        // reuse the old integration path for a different repository. The exact
        // read must reject that tree and use only the persisted common-dir/OIDs.
        initializeRepository(integrationRoot)
        commitFile(integrationRoot, 'replacement result\n', 'Replacement result')
        const query = makeProjectionSnapshotQueryStub({
          getOrchestrateRunExecution: () => Effect.succeed(Option.some(execution)),
        })

        // constructing the query layer after cleanup models a process restart:
        // no live resolver state or worktree path survives from the capture.
        const result = yield* Effect.gen(function* ()
        {
          const diffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery
          return yield* diffQuery.getRunExecutionDiffV1({
            threadId,
            runId: execution.runId,
            planRevision: execution.planRevision,
            ignoreWhitespace: false,
          })
        }).pipe(Effect.provide(makeRealGitLayer(query)))

        expect(result).toMatchObject({
          lifecycle: 'completed',
          availability: 'unavailable',
          baseSha: baseOid,
          headSha: finalHeadOid,
          finalized: true,
        })
        expect(result.diff).toContain('+retained result')
        expect(result.diff).not.toContain('replacement result')
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('returns a typed error when the exact execution has no observed or final head', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('thread-exact-run-no-head')
      const execution = runExecution({
        threadId,
        repositoryRoot: '/repo',
        repositoryCommonDir: '/repo/.git',
        baseOid: 'base-oid',
        observedHeadOid: null,
      })
      const readRangeCalls: Array<ReadRangeCall> = []
      const executeCalls: Array<GitExecuteCall> = []
      const layer = makeLayer({
        readRangeCalls,
        executeCalls,
        query: makeProjectionSnapshotQueryStub({
          getOrchestrateRunExecution: () => Effect.succeed(Option.some(execution)),
        }),
      })

      const error = yield* Effect.gen(function* ()
      {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery
        return yield* query.getRunExecutionDiffV1({
          threadId,
          runId: execution.runId,
          planRevision: execution.planRevision,
        })
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toBeInstanceOf(CheckpointRunExecutionHeadUnavailableError)
      expect(readRangeCalls).toEqual([])
      expect(executeCalls).toEqual([])
    }),
  )

  it.effect('fails before resolving identity when the thread is missing', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('thread-missing')
      const readRangeCalls: Array<ReadRangeCall> = []
      const executeCalls: Array<GitExecuteCall> = []
      const layer = makeLayer({
        readRangeCalls,
        executeCalls,
        query: makeProjectionSnapshotQueryStub({
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
      })

      const error = yield* Effect.gen(function* ()
      {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        })
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toBeInstanceOf(CheckpointThreadNotFoundError)
      expect(readRangeCalls).toEqual([])
      expect(executeCalls).toEqual([])
    }),
  )
})
