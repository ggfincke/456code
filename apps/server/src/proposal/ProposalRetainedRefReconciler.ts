// apps/server/src/proposal/ProposalRetainedRefReconciler.ts
// reports owner-local stale proposal retained refs without deleting them

import * as NodeCrypto from 'node:crypto'

import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { PersistenceSqlError } from '../persistence/Errors.ts'
import { enumerateProposalRetainedRefs, proposalRetainedRefPairToken } from './ProposalGitEngine.ts'
import * as ProposalRetainedRefAttemptStore from './ProposalRetainedRefAttemptStore.ts'

const REPOSITORY_CAP = 8
const REF_CAP_PER_REPOSITORY = 512
const RECONCILIATION_BUDGET_MS = 500
const ATTEMPT_GRACE_MS = 24 * 60 * 60 * 1_000
const BASE_REF = /^refs\/t3\/proposals\/([0-9a-f]{64})\/base$/u
const PROPOSED_REF = /^refs\/t3\/proposals\/([0-9a-f]{64})\/proposed$/u

export interface ProposalRetainedRefReportItem
{
  readonly status: 'candidate' | 'live' | 'grace' | 'malformed' | 'manual-skip'
  readonly reason: string
  readonly repositoryHash: string
  readonly refNames: ReadonlyArray<string>
  readonly baseRef: string | null
  readonly proposedRef: string | null
}

export interface ProposalRetainedRefReconciliationReport
{
  readonly reportVersion: 1
  readonly enumerated: number
  readonly candidates: number
  readonly live: number
  readonly grace: number
  readonly malformed: number
  readonly manualSkip: number
  readonly budgetExceeded: boolean
  readonly deleteAttempted: 0
  readonly deleteSucceeded: 0
  readonly deleteFailed: 0
  readonly items: ReadonlyArray<ProposalRetainedRefReportItem>
}

interface DurableRefRow
{
  readonly gitCommonDir: string
  readonly baseRef: string
  readonly proposedRef: string
}

interface PairRefs
{
  baseRef: string | null
  proposedRef: string | null
}

function repositoryHash(gitCommonDir: string): string
{
  return NodeCrypto.createHash('sha256').update(gitCommonDir).digest('hex')
}

function attemptCreatedAtMillis(createdAt: string): number | null
{
  return Option.match(DateTime.make(createdAt), {
    onNone: () => null,
    onSome: DateTime.toEpochMillis,
  })
}

function pairRefNames(pair: PairRefs): ReadonlyArray<string>
{
  return [pair.baseRef, pair.proposedRef].filter((refName): refName is string => refName !== null)
}

export class ProposalRetainedRefReconciler extends Context.Service<
  ProposalRetainedRefReconciler,
  {
    readonly reconcile: Effect.Effect<ProposalRetainedRefReconciliationReport, PersistenceSqlError>
  }
>()('456code/proposal/ProposalRetainedRefReconciler')
{}

export const make = Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient
  const attemptStore = yield* ProposalRetainedRefAttemptStore.ProposalRetainedRefAttemptStore

  const reconcile = Effect.fn('ProposalRetainedRefReconciler.reconcile')(function* ()
  {
    const startedAt = yield* Clock.currentTimeMillis
    const attempts = yield* attemptStore.list
    const durableRows = yield* sql<DurableRefRow>`
      SELECT DISTINCT
        p.worktree_git_common_dir AS "gitCommonDir",
        r.base_retained_ref AS "baseRef",
        r.proposed_retained_ref AS "proposedRef"
      FROM proposal_revisions r
      JOIN proposals p ON p.proposal_id = r.proposal_id
      ORDER BY p.worktree_git_common_dir, r.base_retained_ref, r.proposed_retained_ref
    `.pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: 'ProposalRetainedRefReconciler.listDurableRefs',
            cause,
          }),
      ),
    )
    const now = yield* Clock.currentTimeMillis
    const allRepositoryDirs = [
      ...new Set([
        ...durableRows.map((row) => row.gitCommonDir),
        ...attempts.map((attempt) => attempt.gitCommonDir),
      ]),
    ].toSorted()
    const repositoryDirs = allRepositoryDirs.slice(0, REPOSITORY_CAP)
    let budgetExceeded = allRepositoryDirs.length > REPOSITORY_CAP
    let enumerated = 0
    let candidates = 0
    let live = 0
    let grace = 0
    let malformed = 0
    let manualSkip = 0
    const items: ProposalRetainedRefReportItem[] = []
    const attemptsByToken = new Map(attempts.map((attempt) => [attempt.refToken, attempt] as const))
    const liveRefsByRepository = new Map<string, Set<string>>()
    for (const row of durableRows)
    {
      const refs = liveRefsByRepository.get(row.gitCommonDir) ?? new Set<string>()
      refs.add(row.baseRef)
      refs.add(row.proposedRef)
      liveRefsByRepository.set(row.gitCommonDir, refs)
    }

    for (const gitCommonDir of repositoryDirs)
    {
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt
      const remaining = RECONCILIATION_BUDGET_MS - elapsed
      if (remaining <= 0)
      {
        budgetExceeded = true
        break
      }
      const enumeration = yield* enumerateProposalRetainedRefs(
        gitCommonDir,
        REF_CAP_PER_REPOSITORY + 1,
      ).pipe(
        Effect.timeoutOption(remaining),
        Effect.match({
          onFailure: () => ({ _tag: 'failed' as const }),
          onSuccess: (refs) =>
            Option.match(refs, {
              onNone: () => ({ _tag: 'timeout' as const }),
              onSome: (value) => ({ _tag: 'success' as const, refs: value }),
            }),
        }),
      )
      const hash = repositoryHash(gitCommonDir)
      if (enumeration._tag !== 'success')
      {
        if (enumeration._tag === 'timeout') budgetExceeded = true
        manualSkip += 1
        items.push({
          status: 'manual-skip',
          reason: enumeration._tag === 'timeout' ? 'budget-exceeded' : 'enumeration-failed',
          repositoryHash: hash,
          refNames: [],
          baseRef: null,
          proposedRef: null,
        })
        if (enumeration._tag === 'timeout') break
        continue
      }
      if (enumeration.refs.length > REF_CAP_PER_REPOSITORY) budgetExceeded = true
      const refs = enumeration.refs.slice(0, REF_CAP_PER_REPOSITORY)
      enumerated += refs.length
      const pairs = new Map<string, PairRefs>()
      for (const refName of refs)
      {
        const baseToken = BASE_REF.exec(refName)?.[1]
        const proposedToken = PROPOSED_REF.exec(refName)?.[1]
        const token = baseToken ?? proposedToken
        if (token === undefined)
        {
          malformed += 1
          items.push({
            status: 'malformed',
            reason: 'malformed-ref',
            repositoryHash: hash,
            refNames: [refName],
            baseRef: refName.endsWith('/base') ? refName : null,
            proposedRef: refName.endsWith('/proposed') ? refName : null,
          })
          continue
        }
        const pair = pairs.get(token) ?? { baseRef: null, proposedRef: null }
        if (baseToken !== undefined) pair.baseRef = refName
        if (proposedToken !== undefined) pair.proposedRef = refName
        pairs.set(token, pair)
      }

      const localAttempts = attempts.filter((attempt) => attempt.gitCommonDir === gitCommonDir)
      for (const attempt of localAttempts)
      {
        if (!pairs.has(attempt.refToken))
        {
          pairs.set(attempt.refToken, { baseRef: null, proposedRef: null })
        }
      }
      const liveRefs = liveRefsByRepository.get(gitCommonDir) ?? new Set<string>()
      for (const [token, pair] of [...pairs.entries()].toSorted(([left], [right]) =>
        left.localeCompare(right),
      ))
      {
        const localAttempt = localAttempts.find((attempt) => attempt.refToken === token)
        const globalAttempt = attemptsByToken.get(token)
        if (pair.baseRef === null || pair.proposedRef === null)
        {
          manualSkip += 1
          items.push({
            status: 'manual-skip',
            reason: 'partial-pair',
            repositoryHash: hash,
            refNames: pairRefNames(pair),
            baseRef: pair.baseRef,
            proposedRef: pair.proposedRef,
          })
          continue
        }
        if (liveRefs.has(pair.baseRef) || liveRefs.has(pair.proposedRef))
        {
          live += 1
          items.push({
            status: 'live',
            reason: 'durable-revision',
            repositoryHash: hash,
            refNames: pairRefNames(pair),
            baseRef: pair.baseRef,
            proposedRef: pair.proposedRef,
          })
          // not gated by the reconciliation flags: the refs were just proven
          // live and durable, so this only retires a local bookkeeping row that
          // contradicts them. no ref, file, or thread is touched
          if (localAttempt?.durableAt === null)
          {
            yield* attemptStore.remove(localAttempt.refToken)
          }
          continue
        }
        if (localAttempt === undefined)
        {
          manualSkip += 1
          items.push({
            status: 'manual-skip',
            reason:
              globalAttempt === undefined ? 'no-attempt-record' : 'repository-identity-mismatch',
            repositoryHash: hash,
            refNames: pairRefNames(pair),
            baseRef: pair.baseRef,
            proposedRef: pair.proposedRef,
          })
          continue
        }
        if (
          proposalRetainedRefPairToken(localAttempt.baseRef, localAttempt.proposedRef) !== token ||
          localAttempt.baseRef !== pair.baseRef ||
          localAttempt.proposedRef !== pair.proposedRef
        )
        {
          manualSkip += 1
          items.push({
            status: 'manual-skip',
            reason: 'attempt-identity-mismatch',
            repositoryHash: hash,
            refNames: pairRefNames(pair),
            baseRef: pair.baseRef,
            proposedRef: pair.proposedRef,
          })
          continue
        }
        const createdAt = attemptCreatedAtMillis(localAttempt.createdAt)
        if (localAttempt.durableAt !== null || createdAt === null)
        {
          manualSkip += 1
          items.push({
            status: 'manual-skip',
            reason: localAttempt.durableAt === null ? 'invalid-attempt-time' : 'durable-attempt',
            repositoryHash: hash,
            refNames: pairRefNames(pair),
            baseRef: pair.baseRef,
            proposedRef: pair.proposedRef,
          })
          continue
        }
        if (now - createdAt <= ATTEMPT_GRACE_MS)
        {
          grace += 1
          items.push({
            status: 'grace',
            reason: 'attempt-within-grace',
            repositoryHash: hash,
            refNames: pairRefNames(pair),
            baseRef: pair.baseRef,
            proposedRef: pair.proposedRef,
          })
          continue
        }
        candidates += 1
        items.push({
          status: 'candidate',
          reason: 'stale-owned-pair',
          repositoryHash: hash,
          refNames: pairRefNames(pair),
          baseRef: pair.baseRef,
          proposedRef: pair.proposedRef,
        })
      }
    }

    if ((yield* Clock.currentTimeMillis) - startedAt >= RECONCILIATION_BUDGET_MS)
    {
      budgetExceeded = true
    }
    return {
      reportVersion: 1,
      enumerated,
      candidates,
      live,
      grace,
      malformed,
      manualSkip,
      budgetExceeded,
      deleteAttempted: 0,
      deleteSucceeded: 0,
      deleteFailed: 0,
      items,
    } satisfies ProposalRetainedRefReconciliationReport
  })

  return ProposalRetainedRefReconciler.of({ reconcile: reconcile() })
})

export const layer = Layer.effect(ProposalRetainedRefReconciler, make)
