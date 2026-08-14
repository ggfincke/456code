// tests/apps/server/proposal/ProposalImplementationAttemptService.test.ts
// verifies exact proposal implementation classification and durable idempotency

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeCrypto from 'node:crypto'

import { it } from '@effect/vitest'
import {
  EnvironmentId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProposalGitObjectOid,
  ProposalId,
  ProposalRevisionId,
  ProposalSha256,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type Proposal,
  type ProposalNormalizedOperation,
  type ProposalRevision,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { describe, expect } from 'vite-plus/test'

import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as ProcessRunner from '../../../../apps/server/src/process/processRunner.ts'
import {
  ProposalImplementationAttemptService,
  classifyImplementationAttempt,
  layer as implementationAttemptLayer,
  type ActualTreeEntry,
} from '../../../../apps/server/src/proposal/ProposalImplementationAttemptService.ts'
import * as ProposalService from '../../../../apps/server/src/proposal/ProposalService.ts'

const sourceThreadId = ThreadId.make('thread-source')
const implementationThreadId = ThreadId.make('thread-implementation')
const implementationTurnId = TurnId.make('turn-implementation')
const proposalId = ProposalId.make('proposal-attempt')
const revisionId = ProposalRevisionId.make('proposal-attempt-revision-1')
const planId = OrchestrationProposedPlanId.make('plan-attempt')
const beforeOid = ProposalGitObjectOid.make('1'.repeat(40))
const afterOid = ProposalGitObjectOid.make('2'.repeat(40))
const proposedTreeOid = ProposalGitObjectOid.make('3'.repeat(40))
const baselineTreeOid = ProposalGitObjectOid.make('4'.repeat(40))
const actualTreeOid = ProposalGitObjectOid.make('5'.repeat(40))
const sha256 = ProposalSha256.make('a'.repeat(64))
const createdAt = '2026-07-27T12:00:00.000Z'

const modifyOperation: ProposalNormalizedOperation = {
  _tag: 'modify',
  path: 'src/feature.ts',
  before: {
    sha256,
    byteLength: 6,
    gitBlobOid: beforeOid,
    mode: '100644',
  },
  after: {
    sha256,
    byteLength: 5,
    gitBlobOid: afterOid,
    mode: '100644',
  },
}

const proposal: Proposal = {
  proposalId,
  environmentId: EnvironmentId.make('environment-attempt'),
  projectId: ProjectId.make('project-attempt'),
  sourceThreadId,
  producer: {
    providerSessionId: 'provider-session-attempt',
    providerInstanceId: ProviderInstanceId.make('codex-attempt'),
  },
  repository: {
    _tag: 'local-git',
    canonicalKey: `local-git:${NodeCrypto.createHash('sha256')
      .update('/workspace/.git')
      .digest('hex')}`,
  },
  worktree: {
    rootPath: '/workspace',
    gitDir: '/workspace/.git',
    gitCommonDir: '/workspace/.git',
  },
  latestRevision: 1,
  createdAt,
  updatedAt: createdAt,
}

const revision: ProposalRevision = {
  proposalId,
  revisionId,
  revision: 1,
  baseSnapshot: {
    headCommitOid: beforeOid,
    workingTreeOid: baselineTreeOid,
    retainedRef: 'refs/t3/proposals/attempt/base',
    fileCount: 1,
    byteCount: 6,
    policy: {
      version: 'v1',
      trackedContent: 'working-tree-bytes',
      untrackedContent: 'include-unignored',
      ignoredContent: 'omit',
      staging: 'flattened',
      submodules: 'reject-dirty',
    },
  },
  proposedTreeOid,
  proposedRetainedRef: 'refs/t3/proposals/attempt/proposed',
  manifest: {
    version: 'v1',
    operations: [modifyOperation],
    operationCount: 1,
    changedFileCount: 1,
    changedContentBytes: 5,
  },
  manifestSha256: sha256,
  diffSha256: sha256,
  diffByteLength: 10,
  planId,
  createdAt,
}

const findLatestByPlanInputs: Array<{
  readonly sourceThreadId: ThreadId
  readonly planId: OrchestrationProposedPlanId
  readonly createdAtOrBefore?: string
}> = []

function processOutput(stdout: string)
{
  return {
    stdout,
    stderr: '',
    code: 0 as never,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

function makeProcessRunnerLayer(options: { readonly dirtySubmodule?: boolean } = {})
{
  return Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
      {
        const cwd = input.args[1] ?? input.cwd ?? ''
        const args = input.args.slice(2)
        const otherWorktree = cwd.startsWith('/other-worktree')
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
        {
          return Effect.succeed(processOutput(otherWorktree ? '/other-worktree' : '/workspace'))
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-dir')
        {
          return Effect.succeed(
            processOutput(otherWorktree ? '/workspace/.git/worktrees/other' : '.git'),
          )
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-common-dir')
        {
          return Effect.succeed(processOutput('/workspace/.git'))
        }
        if (args.length === 1 && args[0] === 'remote')
        {
          return Effect.succeed(processOutput(''))
        }
        if (args[0] === 'ls-files' && args[1] === '--stage')
        {
          return Effect.succeed(
            processOutput(
              options.dirtySubmodule === true ? `160000 ${beforeOid} 0\tsubmodule\0` : '',
            ),
          )
        }
        if (args[0] === 'status')
        {
          return Effect.succeed(
            processOutput(options.dirtySubmodule === true ? ' M submodule\0' : ''),
          )
        }
        if (args[0] === 'ls-tree')
        {
          const treeOid = args[2]
          return Effect.succeed(
            processOutput(
              `100644 blob ${treeOid === baselineTreeOid ? beforeOid : afterOid}\tsrc/feature.ts\0`,
            ),
          )
        }
        const treeish = args.at(-1)
        return Effect.succeed(
          processOutput(treeish?.includes('actual') ? actualTreeOid : baselineTreeOid),
        )
      },
    }),
  )
}

const processRunnerLayer = makeProcessRunnerLayer()

const proposalServiceLayer = Layer.succeed(
  ProposalService.ProposalService,
  ProposalService.ProposalService.of({
    upsert: () => Effect.die('upsert is not used by this test'),
    list: () => Effect.die('list is not used by this test'),
    get: () =>
      Effect.succeed({
        proposal,
        revision,
        revisions: [revision],
      }),
    diff: () => Effect.die('diff is not used by this test'),
    narrative: () => Effect.die('narrative is not used by this test'),
    findLatestByPlan: (input) =>
      Effect.sync(() =>
      {
        findLatestByPlanInputs.push(input)
        return input.planId === planId ? { proposal, revision } : null
      }),
    findByOrchestrateRevision: () => Effect.succeed(null),
  }),
)

const TestLayer = implementationAttemptLayer.pipe(
  Layer.provide(proposalServiceLayer),
  Layer.provide(processRunnerLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
)

const DirtySubmoduleTestLayer = implementationAttemptLayer.pipe(
  Layer.provide(proposalServiceLayer),
  Layer.provide(makeProcessRunnerLayer({ dirtySubmodule: true })),
  Layer.provideMerge(SqlitePersistenceMemory),
)

const seedProposal = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO proposal_blobs (sha256, content, byte_length, created_at)
    VALUES (${sha256}, ${new Uint8Array()}, 0, ${createdAt})
    ON CONFLICT(sha256) DO NOTHING
  `
  yield* sql`
    INSERT INTO proposals (
      proposal_id,
      environment_id,
      project_id,
      source_thread_id,
      producer_session_id,
      producer_instance_id,
      repository_identity_json,
      worktree_root_path,
      worktree_git_dir,
      worktree_git_common_dir,
      created_at,
      updated_at
    )
    VALUES (
      ${proposalId},
      ${proposal.environmentId},
      ${proposal.projectId},
      ${sourceThreadId},
      ${proposal.producer.providerSessionId},
      ${proposal.producer.providerInstanceId},
      ${JSON.stringify(proposal.repository)},
      ${proposal.worktree.rootPath},
      ${proposal.worktree.gitDir},
      ${proposal.worktree.gitCommonDir},
      ${createdAt},
      ${createdAt}
    )
    ON CONFLICT(proposal_id) DO NOTHING
  `
  yield* sql`
    INSERT INTO proposal_revisions (
      revision_id,
      proposal_id,
      revision,
      head_commit_oid,
      base_tree_oid,
      base_retained_ref,
      base_file_count,
      base_byte_count,
      snapshot_policy_json,
      proposed_tree_oid,
      proposed_retained_ref,
      manifest_json,
      manifest_sha256,
      diff_sha256,
      diff_byte_length,
      narrative_sha256,
      narrative_byte_length,
      plan_id,
      plan_markdown_sha256,
      created_at
    )
    VALUES (
      ${revisionId},
      ${proposalId},
      1,
      ${beforeOid},
      ${baselineTreeOid},
      ${revision.baseSnapshot.retainedRef},
      1,
      6,
      ${JSON.stringify(revision.baseSnapshot.policy)},
      ${proposedTreeOid},
      ${revision.proposedRetainedRef},
      ${JSON.stringify(revision.manifest)},
      ${sha256},
      ${sha256},
      10,
      NULL,
      NULL,
      ${planId},
      NULL,
      ${createdAt}
    )
    ON CONFLICT(revision_id) DO NOTHING
  `
})

describe('classifyImplementationAttempt', () =>
{
  it('reports matched only for the exact proposed tree', () =>
  {
    const result = classifyImplementationAttempt({
      proposedTreeOid,
      actualTreeOid: proposedTreeOid,
      operations: [modifyOperation],
      baselineEntries: new Map([['src/feature.ts', { oid: beforeOid, mode: '100644' }]]),
      actualEntries: new Map([['src/feature.ts', { oid: afterOid, mode: '100644' }]]),
    })

    expect(result).toEqual({
      outcome: 'matched',
      matchedOperationCount: 1,
      intendedOperationCount: 1,
    })
  })

  it('reports partial when at least one normalized operation is realized exactly', () =>
  {
    const deleteOperation: ProposalNormalizedOperation = {
      _tag: 'delete',
      path: 'src/remove.ts',
      before: {
        sha256,
        byteLength: 5,
        gitBlobOid: beforeOid,
        mode: '100644',
      },
    }
    const entries = new Map<string, ActualTreeEntry>([
      ['src/feature.ts', { oid: afterOid, mode: '100644' }],
      ['src/remove.ts', { oid: beforeOid, mode: '100644' }],
    ])
    const baselineEntries = new Map<string, ActualTreeEntry>([
      ['src/feature.ts', { oid: beforeOid, mode: '100644' }],
      ['src/remove.ts', { oid: beforeOid, mode: '100644' }],
    ])

    expect(
      classifyImplementationAttempt({
        proposedTreeOid,
        actualTreeOid,
        operations: [modifyOperation, deleteOperation],
        baselineEntries,
        actualEntries: entries,
      }),
    ).toEqual({
      outcome: 'partial',
      matchedOperationCount: 1,
      intendedOperationCount: 2,
    })
  })

  it('reports divergent when no normalized operation is realized', () =>
  {
    const renameOperation: ProposalNormalizedOperation = {
      _tag: 'rename',
      fromPath: 'src/from.ts',
      toPath: 'src/to.ts',
      before: {
        sha256,
        byteLength: 5,
        gitBlobOid: beforeOid,
        mode: '100644',
      },
      after: {
        sha256,
        byteLength: 5,
        gitBlobOid: afterOid,
        mode: '100644',
      },
    }
    const entries = new Map<string, ActualTreeEntry>([
      ['src/feature.ts', { oid: beforeOid, mode: '100644' }],
      ['src/from.ts', { oid: beforeOid, mode: '100644' }],
      ['src/to.ts', { oid: afterOid, mode: '100644' }],
    ])
    const baselineEntries = new Map<string, ActualTreeEntry>([
      ['src/feature.ts', { oid: beforeOid, mode: '100644' }],
      ['src/from.ts', { oid: beforeOid, mode: '100644' }],
    ])

    expect(
      classifyImplementationAttempt({
        proposedTreeOid,
        actualTreeOid,
        operations: [modifyOperation, renameOperation],
        baselineEntries,
        actualEntries: entries,
      }),
    ).toEqual({
      outcome: 'divergent',
      matchedOperationCount: 0,
      intendedOperationCount: 2,
    })
  })

  it('does not credit intended states that were already satisfied at baseline', () =>
  {
    const operations: ReadonlyArray<ProposalNormalizedOperation> = [
      {
        _tag: 'add',
        path: 'src/add.ts',
        after: {
          sha256,
          byteLength: 5,
          gitBlobOid: afterOid,
          mode: '100644',
        },
      },
      modifyOperation,
      {
        _tag: 'delete',
        path: 'src/delete.ts',
        before: {
          sha256,
          byteLength: 5,
          gitBlobOid: beforeOid,
          mode: '100644',
        },
      },
      {
        _tag: 'rename',
        fromPath: 'src/from.ts',
        toPath: 'src/to.ts',
        before: {
          sha256,
          byteLength: 5,
          gitBlobOid: beforeOid,
          mode: '100644',
        },
        after: {
          sha256,
          byteLength: 5,
          gitBlobOid: afterOid,
          mode: '100644',
        },
      },
    ]
    const alreadySatisfied = new Map<string, ActualTreeEntry>([
      ['src/add.ts', { oid: afterOid, mode: '100644' }],
      ['src/feature.ts', { oid: afterOid, mode: '100644' }],
      ['src/to.ts', { oid: afterOid, mode: '100644' }],
    ])

    expect(
      classifyImplementationAttempt({
        proposedTreeOid,
        actualTreeOid: proposedTreeOid,
        operations,
        baselineEntries: alreadySatisfied,
        actualEntries: alreadySatisfied,
      }),
    ).toEqual({
      outcome: 'divergent',
      matchedOperationCount: 0,
      intendedOperationCount: 4,
    })
  })
})

it.layer(TestLayer)('ProposalImplementationAttemptService', (it) =>
{
  it.effect('persists one attempt per turn and completes it once', () =>
    Effect.gen(function* ()
    {
      const service = yield* ProposalImplementationAttemptService
      const sql = yield* SqlClient.SqlClient
      findLatestByPlanInputs.length = 0
      yield* seedProposal
      const beginInput = {
        implementationThreadId,
        implementationTurnId,
        cwd: '/workspace',
        baselineCheckpointRef: 'refs/t3/checkpoints/baseline',
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId,
        },
        createdAt,
      } as const

      const firstPending = yield* service.begin(beginInput)
      const repeatedPending = yield* service.begin(beginInput)
      expect(firstPending?.attemptId).toBe(repeatedPending?.attemptId)
      expect(firstPending?.implementationTurnId).toBe(implementationTurnId)
      expect(firstPending?.baselineTreeOid).toBe(baselineTreeOid)
      expect(findLatestByPlanInputs).toEqual([
        {
          sourceThreadId,
          planId,
          createdAtOrBefore: createdAt,
        },
      ])

      const firstCompleted = yield* service.complete({
        implementationThreadId,
        implementationTurnId,
        cwd: '/workspace',
        actualCheckpointRef: 'refs/t3/checkpoints/actual',
        completedAt: '2026-07-27T12:05:00.000Z',
      })
      const repeatedCompleted = yield* service.complete({
        implementationThreadId,
        implementationTurnId,
        cwd: '/workspace',
        actualCheckpointRef: 'refs/t3/checkpoints/actual-replayed',
        completedAt: '2026-07-27T12:10:00.000Z',
      })

      expect(firstCompleted).toEqual(repeatedCompleted)
      expect(firstCompleted?.outcome).toBe('partial')
      expect(firstCompleted?.matchedOperationCount).toBe(1)
      expect(firstCompleted?.actualTreeOid).toBe(actualTreeOid)
      expect(firstCompleted?.completedAt).toBe('2026-07-27T12:05:00.000Z')

      const latest = yield* service.latestForProposal({
        sourceThreadId,
        proposalId,
        revision: 1,
      })
      const wrongSource = yield* service.latestForProposal({
        sourceThreadId: ThreadId.make('thread-other'),
        proposalId,
      })
      expect(latest?.attemptId).toBe(firstCompleted?.attemptId)
      expect(wrongSource).toBeNull()

      const unlinked = yield* service.begin({
        implementationThreadId,
        implementationTurnId: TurnId.make('turn-without-linked-proposal'),
        cwd: '/workspace',
        baselineCheckpointRef: 'refs/t3/checkpoints/unlinked',
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: OrchestrationProposedPlanId.make('plan-without-proposal'),
        },
        createdAt,
      })
      expect(unlinked).toBeNull()

      const countRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM proposal_implementation_attempts
      `
      expect(countRows[0]?.count).toBe(1)
    }),
  )

  it.effect('rejects another worktree of the same repository before persisting', () =>
    Effect.gen(function* ()
    {
      const service = yield* ProposalImplementationAttemptService
      const sql = yield* SqlClient.SqlClient
      yield* seedProposal
      const turnId = TurnId.make('turn-other-worktree')

      const rejected = yield* service
        .begin({
          implementationThreadId,
          implementationTurnId: turnId,
          cwd: '/other-worktree',
          baselineCheckpointRef: 'refs/t3/checkpoints/baseline',
          sourceProposedPlan: {
            threadId: sourceThreadId,
            planId,
          },
          createdAt,
        })
        .pipe(Effect.flip)

      expect(rejected.detail).toContain('persisted repository and worktree identity')
      const countRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM proposal_implementation_attempts
        WHERE implementation_thread_id = ${implementationThreadId}
          AND implementation_turn_id = ${turnId}
      `
      expect(countRows[0]?.count).toBe(0)
    }),
  )

  it.effect('rejects completion from a different cwd and leaves the attempt pending', () =>
    Effect.gen(function* ()
    {
      const service = yield* ProposalImplementationAttemptService
      const sql = yield* SqlClient.SqlClient
      yield* seedProposal
      const turnId = TurnId.make('turn-completion-cwd-mismatch')
      yield* service.begin({
        implementationThreadId,
        implementationTurnId: turnId,
        cwd: '/workspace',
        baselineCheckpointRef: 'refs/t3/checkpoints/baseline',
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId,
        },
        createdAt,
      })

      const rejected = yield* service
        .complete({
          implementationThreadId,
          implementationTurnId: turnId,
          cwd: '/other-worktree',
          actualCheckpointRef: 'refs/t3/checkpoints/actual',
          completedAt: '2026-07-27T12:05:00.000Z',
        })
        .pipe(Effect.flip)

      expect(rejected.detail).toContain('persisted repository and worktree identity')
      const rows = yield* sql<{
        readonly actualTreeOid: string | null
        readonly outcome: string
      }>`
        SELECT
          actual_tree_oid AS "actualTreeOid",
          outcome
        FROM proposal_implementation_attempts
        WHERE implementation_thread_id = ${implementationThreadId}
          AND implementation_turn_id = ${turnId}
      `
      expect(rows).toEqual([{ actualTreeOid: null, outcome: 'pending' }])
    }),
  )
})

it.layer(DirtySubmoduleTestLayer)('proposal attempt snapshot policy', (it) =>
{
  it.effect('rejects a dirty submodule before persisting an attempt', () =>
    Effect.gen(function* ()
    {
      const service = yield* ProposalImplementationAttemptService
      const sql = yield* SqlClient.SqlClient
      yield* seedProposal
      const turnId = TurnId.make('turn-dirty-submodule')

      const rejected = yield* service
        .begin({
          implementationThreadId,
          implementationTurnId: turnId,
          cwd: '/workspace',
          baselineCheckpointRef: 'refs/t3/checkpoints/baseline',
          sourceProposedPlan: {
            threadId: sourceThreadId,
            planId,
          },
          createdAt,
        })
        .pipe(Effect.flip)

      expect(rejected.detail).toBe(
        'Dirty submodules are unsupported by proposal snapshot policy v1.',
      )
      const countRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM proposal_implementation_attempts
        WHERE implementation_thread_id = ${implementationThreadId}
          AND implementation_turn_id = ${turnId}
      `
      expect(countRows[0]?.count).toBe(0)
    }),
  )
})
