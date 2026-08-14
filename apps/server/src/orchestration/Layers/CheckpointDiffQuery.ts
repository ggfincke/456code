// apps/server/src/orchestration/Layers/CheckpointDiffQuery.ts
// implements orchestration checkpoint diff queries

// provides read-only diff operations across checkpoint snapshots used by
// orchestration APIs.
//
// @module CheckpointDiffQuery
import {
  type OrchestrationCheckpointSummary,
  OrchestrationGetRunExecutionDiffV1Result,
  OrchestrationGetRunDiffResult,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

import {
  CheckpointIdentityResolver,
  type RecordedCheckpointIdentity,
  type ResolvedRepositoryRevision,
} from '../../checkpointing/CheckpointIdentity.ts'
import { checkpointRefForThreadTurn } from '../../checkpointing/Utils.ts'
import * as GitVcsDriver from '../../vcs/GitVcsDriver.ts'
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointRunBaseUnavailableError,
  CheckpointRunIntegrationUnavailableError,
  CheckpointRunExecutionHeadUnavailableError,
  CheckpointRunExecutionNotFoundError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from '../Errors.ts'
import { CheckpointDiffQuery } from '../Services/CheckpointDiffQuery.ts'
import * as ProjectionSnapshotQuery from '../Services/ProjectionSnapshotQuery.ts'

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult)
const isRunDiffResult = Schema.is(OrchestrationGetRunDiffResult)
const isRunExecutionDiffResult = Schema.is(OrchestrationGetRunExecutionDiffV1Result)

// matches the checkpoint diff cap in GitVcsDriver rather than the far smaller
// range-context cap, because a run's whole integration branch is the point
const RUN_DIFF_MAX_OUTPUT_BYTES = 10_000_000
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000

function identityFromSummary(checkpoint: {
  readonly checkpointRef: OrchestrationCheckpointSummary['checkpointRef']
  readonly checkpointTurnCount: OrchestrationCheckpointSummary['checkpointTurnCount']
  readonly checkpointCaptureRoot?: string | null | undefined
  readonly checkpointRepositoryCommonDir?: string | null | undefined
  readonly checkpointCommitOid?: string | null | undefined
}): RecordedCheckpointIdentity
{
  return {
    checkpointRef: checkpoint.checkpointRef,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointCaptureRoot: checkpoint.checkpointCaptureRoot ?? null,
    checkpointRepositoryCommonDir: checkpoint.checkpointRepositoryCommonDir ?? null,
    checkpointCommitOid: checkpoint.checkpointCommitOid ?? null,
  }
}

// every getRunDiff exit path goes through here, so a shape that cannot satisfy
// the RPC contract never leaves the query layer. returns null when it does not
function buildRunDiffResult(
  threadId: ThreadId,
  fields: {
    readonly diff: string
    readonly branch: string | null
    readonly baseSha: string | null
    readonly headSha: string | null
    readonly truncated: boolean
  },
): OrchestrationGetRunDiffResult | null
{
  const result: OrchestrationGetRunDiffResult = {
    threadId,
    diff: fields.diff,
    branch: fields.branch,
    baseSha: fields.baseSha,
    headSha: fields.headSha,
    ...(fields.truncated ? { truncated: true } : {}),
  }
  return isRunDiffResult(result) ? result : null
}

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId
    readonly fromTurnCount: number
    readonly toTurnCount: number
  },
  diff: string,
): OrchestrationGetTurnDiffResultType
{
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  }
}

export const make = Effect.gen(function* ()
{
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
  const checkpointIdentity = yield* CheckpointIdentityResolver
  // the run diff is a plain revision-range diff in a tree the checkpoint store
  // never captured into, so it goes to git directly. CheckpointReactor already
  // reaches for raw git the same way when it resolves a worktree's branch
  const git = yield* GitVcsDriver.GitVcsDriver

  const diffCheckpointOids = Effect.fn('CheckpointDiffQuery.diffCheckpointOids')(function* (input: {
    readonly operation: string
    readonly cwd: string
    readonly fromCommitOid: string
    readonly toCommitOid: string
    readonly ignoreWhitespace: boolean
  })
  {
    const result = yield* git.execute({
      operation: input.operation,
      cwd: input.cwd,
      args: [
        'diff',
        '--patch',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        ...(input.ignoreWhitespace ? ['--ignore-all-space'] : []),
        input.fromCommitOid,
        input.toCommitOid,
      ],
      maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
    })
    return result.stdout
  })

  const getTurnDiff: CheckpointDiffQuery['Service']['getTurnDiff'] = Effect.fn('getTurnDiff')(
    function* (input)
    {
      const operation = 'CheckpointDiffQuery.getTurnDiff'
      const ignoreWhitespace = input.ignoreWhitespace ?? true
      yield* Effect.annotateCurrentSpan({
        'checkpoint.thread_id': input.threadId,
        'checkpoint.from_turn_count': input.fromTurnCount,
        'checkpoint.to_turn_count': input.toTurnCount,
        'checkpoint.ignore_whitespace': ignoreWhitespace,
      })

      if (input.fromTurnCount === input.toTurnCount)
      {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: '',
        }
        if (!isTurnDiffResult(emptyDiff))
        {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          })
        }
        return emptyDiff
      }

      const threadContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(input.threadId)
        .pipe(Effect.withSpan('checkpoint.turnDiff.lookupContext'))
      if (Option.isNone(threadContext))
      {
        return yield* new CheckpointThreadNotFoundError({
          operation,
          threadId: input.threadId,
        })
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      )
      if (input.toTurnCount > maxTurnCount)
      {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        })
      }

      const currentRoot =
        threadContext.value.worktreePath ?? threadContext.value.workspaceRoot ?? null

      const fromCheckpoint =
        input.fromTurnCount === 0
          ? (threadContext.value.baselineCheckpointIdentity ?? {
              checkpointTurnCount: 0,
              checkpointRef: checkpointRefForThreadTurn(input.threadId, 0),
              checkpointCaptureRoot: null,
              checkpointRepositoryCommonDir: null,
              checkpointCommitOid: null,
            })
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )
      if (!fromCheckpoint)
      {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: 'from',
        })
      }

      const toCheckpoint = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )
      if (!toCheckpoint)
      {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: 'to',
        })
      }

      const resolvedRange = yield* checkpointIdentity.resolveReadRange({
        from: identityFromSummary(fromCheckpoint),
        to: identityFromSummary(toCheckpoint),
        currentRoot,
      })
      const diff = yield* diffCheckpointOids({
        operation,
        cwd: resolvedRange.cwd,
        fromCommitOid: resolvedRange.fromCommitOid,
        toCommitOid: resolvedRange.toCommitOid,
        ignoreWhitespace,
      }).pipe(Effect.withSpan('checkpoint.turnDiff.diffCheckpointOids'))

      const turnDiff = buildTurnDiffResult(input, diff)
      if (!isTurnDiffResult(turnDiff))
      {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        })
      }

      return turnDiff
    },
  )

  const getFullThreadDiff: CheckpointDiffQuery['Service']['getFullThreadDiff'] = Effect.fn(
    'CheckpointDiffQuery.getFullThreadDiff',
  )(function* (input)
  {
    const operation = 'CheckpointDiffQuery.getFullThreadDiff'
    const ignoreWhitespace = input.ignoreWhitespace ?? true
    yield* Effect.annotateCurrentSpan({
      'checkpoint.thread_id': input.threadId,
      'checkpoint.from_turn_count': 0,
      'checkpoint.to_turn_count': input.toTurnCount,
      'checkpoint.ignore_whitespace': ignoreWhitespace,
      'checkpoint.diff_kind': 'full-thread',
    })

    if (input.toTurnCount === 0)
    {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        '',
      )
      if (!isTurnDiffResult(emptyDiff))
      {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        })
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult
    }

    const threadContext = yield* projectionSnapshotQuery
      .getFullThreadDiffContext(input.threadId, input.toTurnCount)
      .pipe(Effect.withSpan('checkpoint.fullThread.lookupContext'))

    if (Option.isNone(threadContext))
    {
      return yield* new CheckpointThreadNotFoundError({
        operation,
        threadId: input.threadId,
      })
    }

    if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount)
    {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation,
        threadId: input.threadId,
        requestedTurnCount: input.toTurnCount,
        availableTurnCount: threadContext.value.latestCheckpointTurnCount,
      })
    }

    const currentRoot =
      threadContext.value.worktreePath ?? threadContext.value.workspaceRoot ?? null

    const toCheckpointIdentity =
      threadContext.value.toCheckpointIdentity ??
      (threadContext.value.toCheckpointRef
        ? {
            checkpointTurnCount: input.toTurnCount,
            checkpointRef: threadContext.value.toCheckpointRef,
            checkpointCaptureRoot: null,
            checkpointRepositoryCommonDir: null,
            checkpointCommitOid: null,
          }
        : null)
    if (!toCheckpointIdentity)
    {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: 'to',
      })
    }

    const fromCheckpointIdentity = threadContext.value.fromCheckpointIdentity ?? {
      checkpointTurnCount: 0,
      checkpointRef: checkpointRefForThreadTurn(input.threadId, 0),
      checkpointCaptureRoot: null,
      checkpointRepositoryCommonDir: null,
      checkpointCommitOid: null,
    }
    const resolvedRange = yield* checkpointIdentity.resolveReadRange({
      from: fromCheckpointIdentity,
      to: toCheckpointIdentity,
      currentRoot,
    })
    const diff = yield* diffCheckpointOids({
      operation,
      cwd: resolvedRange.cwd,
      fromCommitOid: resolvedRange.fromCommitOid,
      toCommitOid: resolvedRange.toCommitOid,
      ignoreWhitespace,
    }).pipe(Effect.withSpan('checkpoint.fullThread.diffCheckpointOids'))

    const turnDiff = buildTurnDiffResult(
      {
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
      },
      diff,
    )
    if (!isTurnDiffResult(turnDiff))
    {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      })
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult
  })

  const getRunDiff: CheckpointDiffQuery['Service']['getRunDiff'] = Effect.fn(
    'CheckpointDiffQuery.getRunDiff',
  )(function* (input)
  {
    const operation = 'CheckpointDiffQuery.getRunDiff'
    const ignoreWhitespace = input.ignoreWhitespace ?? true
    yield* Effect.annotateCurrentSpan({
      'checkpoint.thread_id': input.threadId,
      'checkpoint.ignore_whitespace': ignoreWhitespace,
      'checkpoint.diff_kind': 'run',
    })

    const threadShell = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.withSpan('checkpoint.runDiff.lookupThread'))
    if (Option.isNone(threadShell))
    {
      return yield* new CheckpointThreadNotFoundError({
        operation,
        threadId: input.threadId,
      })
    }

    const runWorktreePath = threadShell.value.orchestrateRunWorktreePath ?? null
    const recordedBranch = threadShell.value.orchestrateRunBranch ?? null

    const emptyRunDiff = (branch: string | null) =>
      buildRunDiffResult(input.threadId, {
        diff: '',
        branch,
        baseSha: null,
        headSha: null,
        truncated: false,
      })

    // most threads never adopt a run tree, so "nothing to diff" is an ordinary
    // empty answer rather than a failure the client has to render as an error
    if (runWorktreePath === null)
    {
      const empty = emptyRunDiff(recordedBranch)
      if (empty === null)
      {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        })
      }
      return empty
    }

    // the adopted tree can be pruned while the thread sits idle and the
    // reconciler only releases the recorded path at the next turn boundary. git
    // answers "not a repository" instead of failing loudly, and a vanished cwd
    // does not even spawn, so both have to be caught here
    const runToplevel = yield* git
      .execute({
        operation,
        cwd: runWorktreePath,
        args: ['rev-parse', '--show-toplevel'],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null))
    if (runToplevel === null || runToplevel.exitCode !== 0)
    {
      return yield* new CheckpointRunIntegrationUnavailableError({
        operation,
        threadId: input.threadId,
        worktreePath: runWorktreePath,
      })
    }

    const headRefResult = yield* git
      .execute({
        operation,
        cwd: runWorktreePath,
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null))
    const headRefName = headRefResult?.exitCode === 0 ? headRefResult.stdout.trim() : ''
    // a literal 'HEAD' is git's answer for a detached head, which is not a
    // branch name and must not be fed to the base-branch ladder as one
    const branch =
      recordedBranch ?? (headRefName.length > 0 && headRefName !== 'HEAD' ? headRefName : null)

    const headShaResult = yield* git
      .execute({
        operation,
        cwd: runWorktreePath,
        args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null))
    const headSha =
      headShaResult !== null && headShaResult.exitCode === 0 ? headShaResult.stdout.trim() : ''
    // an unborn branch has committed nothing, so there is a tree but no range
    if (headSha.length === 0)
    {
      const empty = emptyRunDiff(branch)
      if (empty === null)
      {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        })
      }
      return empty
    }

    const baseRef = yield* git.resolveBaseBranch(runWorktreePath, branch ?? 'HEAD')
    if (baseRef === null)
    {
      return yield* new CheckpointRunBaseUnavailableError({
        operation,
        threadId: input.threadId,
        branch,
        detail: 'No base branch resolved for the run integration tree.',
      })
    }

    // merge-base rather than the base tip, so rebasing the run branch or moving
    // the base forward both keep the answer at "what the run added"
    const mergeBaseResult = yield* git.execute({
      operation,
      cwd: runWorktreePath,
      args: ['merge-base', baseRef, headSha],
      allowNonZeroExit: true,
    })
    const baseSha = mergeBaseResult.exitCode === 0 ? mergeBaseResult.stdout.trim() : ''
    // a shallow clone can put the fork point below the boundary and merge-base
    // then fails outright. reporting that beats falling back to the base tip: a
    // silently wrong run diff is the exact failure this query exists to kill
    if (baseSha.length === 0)
    {
      const detail = mergeBaseResult.stderr.trim()
      return yield* new CheckpointRunBaseUnavailableError({
        operation,
        threadId: input.threadId,
        branch,
        detail: detail.length > 0 ? detail : `No merge base between ${baseRef} and HEAD.`,
      })
    }

    // explicit shas on both sides instead of `${baseRef}...HEAD`, so the reported
    // baseSha and headSha describe exactly the range in the returned patch and a
    // commit landing between the two reads cannot desync them
    const patch = yield* git
      .execute({
        operation,
        cwd: runWorktreePath,
        args: [
          'diff',
          '--patch',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          ...(ignoreWhitespace ? ['--ignore-all-space'] : []),
          baseSha,
          headSha,
        ],
        maxOutputBytes: RUN_DIFF_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      })
      .pipe(Effect.withSpan('checkpoint.runDiff.diffRange'))

    const runDiff = buildRunDiffResult(input.threadId, {
      diff: patch.stdout,
      branch,
      baseSha,
      headSha,
      truncated: patch.stdoutTruncated,
    })
    if (runDiff === null)
    {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      })
    }
    return runDiff
  })

  const getRunExecutionDiffV1: CheckpointDiffQuery['Service']['getRunExecutionDiffV1'] = Effect.fn(
    'CheckpointDiffQuery.getRunExecutionDiffV1',
  )(function* (input)
  {
    const operation = 'CheckpointDiffQuery.getRunExecutionDiffV1' as const
    const executionOption = yield* projectionSnapshotQuery.getOrchestrateRunExecution(input)
    if (Option.isNone(executionOption))
    {
      return yield* new CheckpointRunExecutionNotFoundError({
        operation,
        threadId: input.threadId,
        runId: input.runId,
        planRevision: input.planRevision,
      })
    }
    const execution = executionOption.value
    const headOid = execution.finalHeadOid ?? execution.observedHeadOid
    if (headOid === null)
    {
      return yield* new CheckpointRunExecutionHeadUnavailableError({
        operation,
        threadId: input.threadId,
        runId: input.runId,
        planRevision: input.planRevision,
      })
    }

    // repositoryRoot is the capture anchor. A verified sibling integration
    // root may keep the same object database readable after that worktree is
    // pruned, but only after the same common-dir and exact OID proof succeeds
    const resolveHeadAt = (cwd: string) =>
      checkpointIdentity.resolveRepositoryRevision({
        cwd,
        revision: headOid,
        expectedRepositoryCommonDir: execution.repositoryCommonDir,
        expectedCommitOid: headOid,
      })
    const candidateRoots = [execution.repositoryRoot, execution.integrationRoot].filter(
      (candidate, index, candidates): candidate is string =>
        candidate !== null && candidates.indexOf(candidate) === index,
    )
    let resolvedHead: ResolvedRepositoryRevision | null = null
    for (const candidateRoot of candidateRoots)
    {
      const candidate = yield* resolveHeadAt(candidateRoot).pipe(Effect.result)
      if (Result.isSuccess(candidate))
      {
        resolvedHead = candidate.success
        break
      }
    }

    let diffCwd: string
    let gitDirArgs: ReadonlyArray<string>
    if (resolvedHead === null)
    {
      const objectHead = yield* checkpointIdentity.resolveRepositoryObjectRevision({
        repositoryCommonDir: execution.repositoryCommonDir,
        revision: headOid,
        expectedCommitOid: headOid,
      })
      yield* checkpointIdentity.resolveRepositoryObjectRevision({
        repositoryCommonDir: objectHead.repositoryCommonDir,
        revision: execution.baseOid,
        expectedCommitOid: execution.baseOid,
      })
      diffCwd = objectHead.repositoryCommonDir
      gitDirArgs = ['--git-dir', objectHead.repositoryCommonDir]
    }
    else
    {
      yield* checkpointIdentity.resolveRepositoryRevision({
        cwd: resolvedHead.cwd,
        revision: execution.baseOid,
        expectedRepositoryCommonDir: execution.repositoryCommonDir,
        expectedCommitOid: execution.baseOid,
      })
      diffCwd = resolvedHead.cwd
      gitDirArgs = []
    }

    const patch = yield* git.execute({
      operation,
      cwd: diffCwd,
      args: [
        ...gitDirArgs,
        'diff',
        '--patch',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        ...((input.ignoreWhitespace ?? true) ? ['--ignore-all-space'] : []),
        execution.baseOid,
        headOid,
      ],
      maxOutputBytes: RUN_DIFF_MAX_OUTPUT_BYTES,
      appendTruncationMarker: true,
    })
    const result = {
      threadId: input.threadId,
      runId: input.runId,
      planRevision: input.planRevision,
      lifecycle: execution.lifecycle,
      availability: execution.availability,
      diff: patch.stdout,
      branch: execution.integrationBranch,
      baseSha: execution.baseOid,
      headSha: headOid,
      finalized: execution.finalHeadOid !== null,
      ...(patch.stdoutTruncated ? { truncated: true } : {}),
    }
    if (!isRunExecutionDiffResult(result))
    {
      return yield* new CheckpointRunExecutionHeadUnavailableError({
        operation,
        threadId: input.threadId,
        runId: input.runId,
        planRevision: input.planRevision,
      })
    }
    return result
  })

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
    getRunDiff,
    getRunExecutionDiffV1,
  })
})

export const layer = Layer.effect(CheckpointDiffQuery, make)
