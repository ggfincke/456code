// apps/server/src/architecture/ArchitectureAdmissionService.ts
// leases durable architecture admissions and delegates exact background work

// @effect-diagnostics globalDate:off

import * as NodeCrypto from 'node:crypto'

import {
  ArchitectureToolError,
  CartographerError,
  ProposalError,
  type ProposalGeneration,
  ProposalGenerationError,
  type ArchitectureAnalysisAdmissionId,
  type ProposalId,
  type ProposalRevisionId,
  type ArchitectureStandingSource,
  type ThreadId,
} from '@t3tools/contracts'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Scope from 'effect/Scope'

import * as AtlasRebuildService from '../cartographer/AtlasRebuildService.ts'
import { resolveArchitecturePathScope } from '../cartographer/architecturePathResolver.ts'
import { anchorPlannedImpactProjection } from '../cartographer/architectureStandingAnchors.ts'
import * as CartographerAnalyzer from '../cartographer/CartographerAnalyzer.ts'
import * as ProjectArchitectureLifecycleService from '../cartographer/ProjectArchitectureLifecycleService.ts'
import { PersistenceSqlError } from '../persistence/Errors.ts'
import {
  architectureAdmissionMetricAttributes,
  architectureAnalysisAdmissionsTotal,
  increment,
} from '../observability/Metrics.ts'
import * as ProposalGenerationService from '../proposal/ProposalGenerationService.ts'
import * as ArchitectureAdmissionRepository from './ArchitectureAdmissionRepository.ts'
import * as PlannedImpactService from './PlannedImpactService.ts'

export const ARCHITECTURE_ADMISSION_LEASE = Duration.seconds(30)
export const ARCHITECTURE_ADMISSION_RENEW_INTERVAL = Duration.seconds(10)
export const ARCHITECTURE_ADMISSION_POLL_INTERVAL = Duration.seconds(2)
export const ARCHITECTURE_ADMISSION_MAX_ATTEMPTS = 5
const ARCHITECTURE_ADMISSION_BATCH_SIZE = 8
const ARCHITECTURE_ADMISSION_RETRY_BASE = Duration.seconds(1)
const ARCHITECTURE_ADMISSION_RETRY_MAX = Duration.minutes(1)
const ARCHITECTURE_ADMISSION_GENERATION_POLL_INTERVAL = Duration.millis(200)

export interface ArchitectureAdmissionServiceShape
{
  readonly start: Effect.Effect<void, PersistenceSqlError, Scope.Scope>
  readonly drain: Effect.Effect<void, PersistenceSqlError>
  readonly retryProposal: (input: {
    readonly threadId: ThreadId
    readonly proposalId: ProposalId
    readonly revisionId: ProposalRevisionId
  }) => Effect.Effect<ProposalGeneration, ProposalError | ProposalGenerationError>
  readonly cancelThread: (threadId: ThreadId) => Effect.Effect<void, PersistenceSqlError>
}

export class ArchitectureAdmissionService extends Context.Service<
  ArchitectureAdmissionService,
  ArchitectureAdmissionServiceShape
>()('456code/architecture/ArchitectureAdmissionService')
{}

const isArchitectureToolError = Schema.is(ArchitectureToolError)
const isCartographerError = Schema.is(CartographerError)
const isProposalError = Schema.is(ProposalError)
const isProposalGenerationError = Schema.is(ProposalGenerationError)
const isPersistenceSqlError = Schema.is(PersistenceSqlError)

class ArchitectureAdmissionLeaseLostError extends Data.TaggedError(
  'ArchitectureAdmissionLeaseLostError',
)<{
  readonly admissionId: ArchitectureAnalysisAdmissionId
}>
{}

type ArchitectureAdmissionExecutionError =
  | ArchitectureAdmissionLeaseLostError
  | ArchitectureToolError
  | CartographerError
  | PersistenceSqlError
  | ProposalError
  | ProposalGenerationError

const formatIsoMillis = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis))

function retryDelay(attemptCount: number): Duration.Duration
{
  return Duration.min(
    Duration.times(ARCHITECTURE_ADMISSION_RETRY_BASE, 2 ** Math.max(0, attemptCount - 1)),
    ARCHITECTURE_ADMISSION_RETRY_MAX,
  )
}

function errorCode(cause: unknown): string
{
  if (isArchitectureToolError(cause)) return cause.code
  if (isCartographerError(cause)) return cause.failure
  if (isProposalGenerationError(cause)) return cause.failure
  if (isProposalError(cause)) return cause.code
  if (isPersistenceSqlError(cause)) return 'persistence-failed'
  return 'unexpected'
}

function errorClass(cause: unknown): string
{
  if (isArchitectureToolError(cause)) return 'architecture-tool'
  if (isCartographerError(cause)) return 'cartographer'
  if (isProposalGenerationError(cause)) return 'proposal-generation'
  if (isProposalError(cause)) return 'proposal'
  if (isPersistenceSqlError(cause)) return 'persistence'
  return 'unexpected'
}

function retryable(cause: unknown): boolean
{
  if (isPersistenceSqlError(cause)) return true
  if (isArchitectureToolError(cause)) return cause.code === 'persistence-failed'
  if (isProposalError(cause)) return cause.code === 'persistence-failed'
  if (isProposalGenerationError(cause))
  {
    return ['persistence-failed', 'process-failed', 'io-failed'].includes(cause.failure)
  }
  if (isCartographerError(cause))
  {
    return ['context_start_failed', 'snapshot_failed'].includes(cause.failure)
  }
  return false
}

function admittedGenerationFailure(generation: ProposalGeneration): ProposalGenerationError
{
  if (generation.state === 'cancelled' && generation.errorCode === 'thread-deleted')
  {
    return new ProposalGenerationError({
      failure: 'scope-mismatch',
      message: 'The admitted proposal generation belongs to a deleted thread.',
    })
  }
  if (generation.state === 'cancelled' || generation.state === 'abandoned')
  {
    return new ProposalGenerationError({
      failure: 'process-failed',
      message: 'The admitted proposal generation stopped before analysis completed.',
    })
  }
  const failure = generation.errorCode
  if (
    failure === 'not-found' ||
    failure === 'scope-mismatch' ||
    failure === 'unsupported' ||
    failure === 'limit-exceeded' ||
    failure === 'process-failed' ||
    failure === 'io-failed' ||
    failure === 'materialization-failed' ||
    failure === 'analysis-failed' ||
    failure === 'persistence-failed'
  )
  {
    return new ProposalGenerationError({
      failure,
      message: 'The admitted proposal generation failed before producing exact evidence.',
    })
  }
  return new ProposalGenerationError({
    failure: 'analysis-failed',
    message: 'The admitted proposal generation failed without a recognized terminal code.',
  })
}

export const make = Effect.gen(function* ()
{
  const repository = yield* ArchitectureAdmissionRepository.ArchitectureAdmissionRepository
  const plannedImpacts = yield* PlannedImpactService.PlannedImpactService
  const proposalGenerations = yield* ProposalGenerationService.ProposalGenerationService
  const analyzer = yield* CartographerAnalyzer.CartographerAnalyzer
  const projectArchitecture =
    yield* ProjectArchitectureLifecycleService.ProjectArchitectureLifecycleService
  const atlasRebuild = yield* AtlasRebuildService.AtlasRebuildService
  const ownerId = `architecture-admission-worker-${NodeCrypto.randomUUID()}`
  const lifecycleFence = yield* Semaphore.make(1)
  const activeExecutions = yield* Ref.make(
    new Map<
      ArchitectureAnalysisAdmissionId,
      {
        readonly threadId: ThreadId
        readonly stop: Deferred.Deferred<never, ArchitectureAdmissionLeaseLostError>
      }
    >(),
  )

  const cancelThreadWork = Effect.fn('ArchitectureAdmissionService.cancelThreadWork')(function* (
    threadId: ThreadId,
    now: string,
  )
  {
    yield* lifecycleFence.withPermit(
      Effect.gen(function* ()
      {
        const cancelled = yield* repository.cancelThread({ threadId, now })
        if (cancelled.plannedAnchor > 0)
        {
          yield* increment(
            architectureAnalysisAdmissionsTotal,
            architectureAdmissionMetricAttributes('planned-anchor', 'cancelled'),
            cancelled.plannedAnchor,
          )
        }
        if (cancelled.proposalVerified > 0)
        {
          yield* increment(
            architectureAnalysisAdmissionsTotal,
            architectureAdmissionMetricAttributes('proposal-verified', 'cancelled'),
            cancelled.proposalVerified,
          )
        }
        for (const [admissionId, execution] of yield* Ref.get(activeExecutions))
        {
          if (execution.threadId !== threadId) continue
          yield* Deferred.fail(
            execution.stop,
            new ArchitectureAdmissionLeaseLostError({ admissionId }),
          )
        }
      }),
    )
  })

  const executePlannedAnchor = Effect.fn('ArchitectureAdmissionService.executePlannedAnchor')(
    function* (
      target: ArchitectureAdmissionRepository.PlannedAnchorAdmissionTarget,
      leaseFence: ArchitectureAdmissionRepository.ArchitectureAdmissionLeaseFence,
    )
    {
      const stored = yield* plannedImpacts.get(target.publicationId)
      if (
        stored.publication.publicationRevision !== target.publicationRevision ||
        stored.publication.contentDigest !== target.contentDigest ||
        stored.publication.projectId !== target.projectId ||
        stored.publication.sourceThreadId !== target.threadId ||
        stored.publication.environmentId !== target.environmentId
      )
      {
        return yield* new ArchitectureToolError({
          operation: 'ArchitectureAdmissionService.executePlannedAnchor',
          code: 'identity-mismatch',
          detail: 'The Planned anchor admission no longer matches its immutable publication.',
        })
      }
      const snapshot = yield* projectArchitecture.ensureProject({
        projectId: target.projectId,
        workspaceRoot: target.workspaceRoot,
      })
      const retained = yield* Effect.scoped(
        atlasRebuild.retainPublishedIndex(target.projectId, snapshot.generation),
      )
      if (retained === null || retained.graphDigest !== snapshot.graphDigest)
      {
        return yield* new CartographerError({
          failure: 'context_start_failed',
          message: 'The standing Repository Map index was not retained after its build completed.',
        })
      }
      const standingScope = resolveArchitecturePathScope(
        retained.index,
        stored.publication.claims.pathHints,
      )
      const source = {
        kind: 'standing-project-generation',
        projectId: target.projectId,
        generationId: snapshot.generation as never,
        side: 'analyzed',
        graphDigest: snapshot.graphDigest as never,
      } satisfies ArchitectureStandingSource
      const provisional = stored.projections.find(
        (projection) => projection.projectionRevision === 1,
      )
      if (provisional === undefined || provisional.resultState === 'no-impact')
      {
        return yield* new ArchitectureToolError({
          operation: 'ArchitectureAdmissionService.executePlannedAnchor',
          code: 'identity-mismatch',
          detail: 'The exact provisional Planned projection is unavailable for anchoring.',
        })
      }
      const anchored = anchorPlannedImpactProjection({
        index: retained.index,
        source,
        projection: provisional,
      })
      yield* plannedImpacts.appendAnchored({
        publicationId: target.publicationId,
        publicationRevision: target.publicationRevision,
        standingSource: {
          projectId: target.projectId,
          generationId: snapshot.generation,
          graphDigest: snapshot.graphDigest,
          builtAt: snapshot.builtAt,
        },
        standingScope,
        nodes: anchored.nodes,
        edges: anchored.edges,
        standingAnchors: anchored.standingAnchors,
        leaseFence,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      })
    },
  )

  const executeProposalVerified = Effect.fn('ArchitectureAdmissionService.executeProposalVerified')(
    function* (
      target: ArchitectureAdmissionRepository.ProposalVerifiedAdmissionTarget,
      admissionKey: string,
      leaseFence: ArchitectureAdmissionRepository.ArchitectureAdmissionLeaseFence,
    )
    {
      const generation = yield* proposalGenerations.startAdmitted({
        threadId: target.threadId,
        proposalId: target.proposalId,
        revision: target.revision,
        revisionId: target.revisionId,
        analyzerFingerprint: target.analyzerFingerprint,
        admissionKey,
        leaseFence,
      })
      if (generation.revisionId !== target.revisionId)
      {
        return yield* new ProposalGenerationError({
          failure: 'scope-mismatch',
          message: 'The admitted proposal revision did not resolve to its exact generation target.',
        })
      }
      let current = generation
      while (
        current.state === 'queued' ||
        current.state === 'preparing' ||
        current.state === 'analyzing'
      )
      {
        yield* Effect.sleep(ARCHITECTURE_ADMISSION_GENERATION_POLL_INTERVAL)
        current = yield* proposalGenerations.get({
          threadId: target.threadId,
          generationId: current.generationId,
        })
      }
      if (current.state !== 'ready')
      {
        return yield* admittedGenerationFailure(current)
      }
    },
  )

  const renewLease = (admissionId: ArchitectureAnalysisAdmissionId, leaseEpoch: number) =>
    Effect.gen(function* ()
    {
      const nowMs = yield* Clock.currentTimeMillis
      return yield* repository.renew({
        admissionId,
        ownerId,
        leaseEpoch,
        leaseExpiresAt: formatIsoMillis(nowMs + Duration.toMillis(ARCHITECTURE_ADMISSION_LEASE)),
        now: formatIsoMillis(nowMs),
      })
    })

  const renewWhileRunning = (
    admission: ArchitectureAdmissionRepository.ArchitectureAdmission,
    leaseLost: Deferred.Deferred<never, ArchitectureAdmissionLeaseLostError>,
  ) =>
    Effect.forever(
      Effect.sleep(ARCHITECTURE_ADMISSION_RENEW_INTERVAL).pipe(
        Effect.andThen(
          Effect.gen(function* ()
          {
            const renewed = yield* renewLease(admission.admissionId, admission.leaseEpoch)
            if (!renewed)
            {
              yield* Deferred.fail(
                leaseLost,
                new ArchitectureAdmissionLeaseLostError({
                  admissionId: admission.admissionId,
                }),
              )
              return yield* Effect.interrupt
            }
          }),
        ),
      ),
    ).pipe(
      Effect.catchCause(() =>
        Deferred.fail(
          leaseLost,
          new ArchitectureAdmissionLeaseLostError({
            admissionId: admission.admissionId,
          }),
        ).pipe(Effect.asVoid),
      ),
    )

  const executeWithRenewal = (
    admission: ArchitectureAdmissionRepository.ArchitectureAdmission,
    stop: Deferred.Deferred<never, ArchitectureAdmissionLeaseLostError>,
  ): Effect.Effect<void, ArchitectureAdmissionExecutionError> =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const ownsLease = yield* renewLease(admission.admissionId, admission.leaseEpoch)
        if (!ownsLease)
        {
          return yield* new ArchitectureAdmissionLeaseLostError({
            admissionId: admission.admissionId,
          })
        }
        if (yield* Deferred.isDone(stop))
        {
          return yield* new ArchitectureAdmissionLeaseLostError({
            admissionId: admission.admissionId,
          })
        }
        yield* renewWhileRunning(admission, stop).pipe(Effect.forkScoped)
        const leaseFence: ArchitectureAdmissionRepository.ArchitectureAdmissionLeaseFence = {
          admissionId: admission.admissionId,
          ownerId,
          leaseEpoch: admission.leaseEpoch,
        }
        const execution: Effect.Effect<void, ArchitectureAdmissionExecutionError> =
          admission.target._tag === 'planned-anchor'
            ? executePlannedAnchor(admission.target, leaseFence)
            : executeProposalVerified(admission.target, admission.admissionKey, leaseFence)
        const guardedExecution = Effect.gen(function* ()
        {
          if (yield* Deferred.isDone(stop))
          {
            return yield* new ArchitectureAdmissionLeaseLostError({
              admissionId: admission.admissionId,
            })
          }
          return yield* execution
        })
        return yield* Effect.raceFirst(guardedExecution, Deferred.await(stop))
      }),
    )

  const processAdmission = Effect.fn('ArchitectureAdmissionService.processAdmission')(function* (
    admission: ArchitectureAdmissionRepository.ArchitectureAdmission,
  )
  {
    const stop = yield* Deferred.make<never, ArchitectureAdmissionLeaseLostError>()
    yield* lifecycleFence.withPermit(
      Ref.update(activeExecutions, (active) =>
      {
        const next = new Map(active)
        next.set(admission.admissionId, { threadId: admission.target.threadId, stop })
        return next
      }),
    )
    if (yield* repository.isThreadDeleted(admission.target.threadId))
    {
      yield* cancelThreadWork(admission.target.threadId, DateTime.formatIso(yield* DateTime.now))
    }
    const result = yield* Effect.result(executeWithRenewal(admission, stop)).pipe(
      Effect.ensuring(
        Ref.update(activeExecutions, (active) =>
        {
          const next = new Map(active)
          next.delete(admission.admissionId)
          return next
        }),
      ),
    )
    const nowMs = yield* Clock.currentTimeMillis
    const now = formatIsoMillis(nowMs)
    if (
      result._tag === 'Failure' &&
      result.failure instanceof ArchitectureAdmissionLeaseLostError
    )
    {
      return
    }
    if (result._tag === 'Success')
    {
      yield* repository.complete({
        admissionId: admission.admissionId,
        ownerId,
        leaseEpoch: admission.leaseEpoch,
        now,
      })
      yield* increment(
        architectureAnalysisAdmissionsTotal,
        architectureAdmissionMetricAttributes(admission.kind, 'complete'),
      )
      return
    }
    const cause = result.failure
    const classification = errorClass(cause)
    const code = errorCode(cause)
    if (retryable(cause) && admission.attemptCount < ARCHITECTURE_ADMISSION_MAX_ATTEMPTS)
    {
      yield* repository.retry({
        admissionId: admission.admissionId,
        ownerId,
        leaseEpoch: admission.leaseEpoch,
        nextAttemptAt: formatIsoMillis(
          nowMs + Duration.toMillis(retryDelay(admission.attemptCount)),
        ),
        errorClass: classification,
        errorCode: code,
        now,
      })
      yield* increment(
        architectureAnalysisAdmissionsTotal,
        architectureAdmissionMetricAttributes(admission.kind, 'retry'),
      )
      return
    }
    yield* repository.failTerminal({
      admissionId: admission.admissionId,
      ownerId,
      leaseEpoch: admission.leaseEpoch,
      errorClass: classification,
      errorCode: code,
      now,
    })
    yield* increment(
      architectureAnalysisAdmissionsTotal,
      architectureAdmissionMetricAttributes(admission.kind, 'terminal-failed'),
    )
  })

  const drain: ArchitectureAdmissionServiceShape['drain'] = Effect.gen(function* ()
  {
    const nowMs = yield* Clock.currentTimeMillis
    const recovered = yield* repository.recoverExpired(formatIsoMillis(nowMs))
    if (recovered.plannedAnchor > 0)
    {
      yield* increment(
        architectureAnalysisAdmissionsTotal,
        architectureAdmissionMetricAttributes('planned-anchor', 'retry'),
        recovered.plannedAnchor,
      )
    }
    if (recovered.proposalVerified > 0)
    {
      yield* increment(
        architectureAnalysisAdmissionsTotal,
        architectureAdmissionMetricAttributes('proposal-verified', 'retry'),
        recovered.proposalVerified,
      )
    }
    const claims = yield* repository.claimDue({
      ownerId,
      now: formatIsoMillis(nowMs),
      leaseExpiresAt: formatIsoMillis(nowMs + Duration.toMillis(ARCHITECTURE_ADMISSION_LEASE)),
      limit: ARCHITECTURE_ADMISSION_BATCH_SIZE,
    })
    yield* Effect.forEach(claims, processAdmission, { concurrency: 1 })
  })

  const runSafely = <E>(effect: Effect.Effect<void, E>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('architecture admission worker tick failed', {
          cause: String(cause),
        }),
      ),
    )

  const start: ArchitectureAdmissionServiceShape['start'] = Effect.gen(function* ()
  {
    const recoveredAt = DateTime.formatIso(yield* DateTime.now)
    const completed = yield* repository.listCompletedProposals
    yield* Effect.forEach(
      completed,
      (admission) =>
        Effect.gen(function* ()
        {
          if (admission.target._tag !== 'proposal-verified') return
          if (yield* repository.isThreadDeleted(admission.target.threadId)) return
          const generation = yield* proposalGenerations
            .latestAdmitted({
              admissionKey: admission.admissionKey,
              threadId: admission.target.threadId,
              proposalId: admission.target.proposalId,
              revisionId: admission.target.revisionId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PersistenceSqlError({
                    operation: 'ArchitectureAdmissionService.reconcileRestartAbandoned',
                    cause,
                  }),
              ),
            )
          if (generation?.state !== 'abandoned' || generation.errorCode !== 'server-restarted')
          {
            return
          }
          const requeued = yield* repository.requeueCompletedAfterRestart({
            admissionKey: admission.admissionKey,
            now: recoveredAt,
          })
          if (requeued)
          {
            yield* increment(
              architectureAnalysisAdmissionsTotal,
              architectureAdmissionMetricAttributes('proposal-verified', 'retry'),
            )
          }
        }),
      { discard: true },
    )
    yield* runSafely(drain)
    yield* Effect.forkScoped(
      runSafely(drain).pipe(Effect.repeat(Schedule.spaced(ARCHITECTURE_ADMISSION_POLL_INTERVAL))),
    )
  })

  const retryProposal: ArchitectureAdmissionServiceShape['retryProposal'] = Effect.fn(
    'ArchitectureAdmissionService.retryProposal',
  )(function* (input)
  {
    const found = yield* repository.findProposal(input).pipe(
      Effect.mapError(
        () =>
          new ProposalGenerationError({
            failure: 'persistence-failed',
            message: 'The durable proposal analysis admission could not be read.',
          }),
      ),
    )
    if (found === null)
    {
      return yield* new ProposalGenerationError({
        failure: 'not-found',
        message: 'No durable proposal analysis admission exists for this exact revision.',
      })
    }
    if (found.target._tag !== 'proposal-verified' || found.state === 'cancelled')
    {
      return yield* new ProposalGenerationError({
        failure: 'scope-mismatch',
        message: 'The durable proposal analysis admission is outside the active thread scope.',
      })
    }
    const foundTarget = found.target
    if (
      yield* repository.isThreadDeleted(foundTarget.threadId).pipe(
        Effect.mapError(
          () =>
            new ProposalGenerationError({
              failure: 'persistence-failed',
              message: 'The durable source-thread lifecycle could not be verified.',
            }),
        ),
      )
    )
    {
      return yield* new ProposalGenerationError({
        failure: 'scope-mismatch',
        message: 'The durable proposal analysis admission belongs to a deleted thread.',
      })
    }
    const currentAnalyzer = yield* analyzer.identify.pipe(
      Effect.mapError(
        (cause) =>
          new ProposalGenerationError({
            failure: cause.failure === 'unsupported' ? 'unsupported' : 'process-failed',
            message: 'The exact analyzer identity could not be resolved for retry.',
          }),
      ),
    )
    let admission = found
    let enqueueOutcome: 'queued' | 'reused' | null = null
    if (currentAnalyzer.fingerprint !== foundTarget.analyzerFingerprint)
    {
      const enqueued = yield* repository
        .enqueue({
          admissionKey: `proposal-verified:${foundTarget.revisionId}:${currentAnalyzer.fingerprint}`,
          target: {
            ...foundTarget,
            analyzerFingerprint: currentAnalyzer.fingerprint,
          },
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ProposalGenerationError({
                failure: 'persistence-failed',
                message: 'A new exact analyzer admission could not be created for retry.',
              }),
          ),
        )
      admission = enqueued.admission
      enqueueOutcome = enqueued.reused ? 'reused' : 'queued'
    }
    if (admission.target._tag !== 'proposal-verified')
    {
      return yield* new ProposalGenerationError({
        failure: 'scope-mismatch',
        message: 'The durable proposal analysis retry resolved to a different admission kind.',
      })
    }
    if (admission.state === 'cancelled')
    {
      return yield* new ProposalGenerationError({
        failure: 'scope-mismatch',
        message: 'The durable proposal analysis admission is cancelled.',
      })
    }
    let forceNewAttempt = false
    if (['complete', 'retry-wait', 'terminal-failed'].includes(admission.state))
    {
      const requeued = yield* repository
        .requeueForExplicitRetry({
          admissionKey: admission.admissionKey,
          now: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ProposalGenerationError({
                failure: 'persistence-failed',
                message: 'The durable proposal analysis admission could not be retried.',
              }),
          ),
        )
      if (!requeued)
      {
        return yield* new ProposalGenerationError({
          failure: 'scope-mismatch',
          message: 'The durable proposal analysis admission is no longer retryable.',
        })
      }
      forceNewAttempt = true
      yield* increment(
        architectureAnalysisAdmissionsTotal,
        architectureAdmissionMetricAttributes('proposal-verified', 'retry'),
      )
    }
    else
    {
      yield* increment(
        architectureAnalysisAdmissionsTotal,
        architectureAdmissionMetricAttributes('proposal-verified', enqueueOutcome ?? 'reused'),
      )
    }
    const nowMs = yield* Clock.currentTimeMillis
    const leased = yield* repository
      .leaseForExplicitStart({
        admissionKey: admission.admissionKey,
        ownerId,
        leaseExpiresAt: formatIsoMillis(nowMs + Duration.toMillis(ARCHITECTURE_ADMISSION_LEASE)),
        now: formatIsoMillis(nowMs),
      })
      .pipe(
        Effect.mapError(
          () =>
            new ProposalGenerationError({
              failure: 'persistence-failed',
              message: 'The durable proposal analysis admission could not be leased for retry.',
            }),
        ),
      )
    if (leased === null)
    {
      for (let attempt = 0; attempt < 10; attempt += 1)
      {
        const latest = yield* proposalGenerations.latest({
          threadId: admission.target.threadId,
          proposalId: admission.target.proposalId,
          revision: admission.target.revision,
        })
        if (
          latest !== null &&
          ['queued', 'preparing', 'analyzing', 'ready'].includes(latest.state)
        )
        {
          return latest
        }
        yield* Effect.sleep(Duration.millis(50))
      }
      return yield* new ProposalGenerationError({
        failure: 'process-failed',
        message: 'The durable proposal analysis retry is already starting in another worker.',
      })
    }
    if (leased.target._tag !== 'proposal-verified')
    {
      return yield* new ProposalGenerationError({
        failure: 'scope-mismatch',
        message: 'The leased proposal analysis retry resolved to a different admission kind.',
      })
    }
    const target = leased.target
    return yield* proposalGenerations
      .startAdmitted({
        threadId: target.threadId,
        proposalId: target.proposalId,
        revision: target.revision,
        revisionId: target.revisionId,
        analyzerFingerprint: target.analyzerFingerprint,
        admissionKey: leased.admissionKey,
        leaseFence: {
          admissionId: leased.admissionId,
          ownerId,
          leaseEpoch: leased.leaseEpoch,
        },
        ...(forceNewAttempt ? { forceNewAttempt: true } : {}),
      })
      .pipe(
        Effect.ensuring(
          repository
            .releaseExplicitStart({
              admissionId: leased.admissionId,
              ownerId,
              leaseEpoch: leased.leaseEpoch,
              now: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning('explicit architecture admission lease release failed', {
                  cause: String(cause),
                }),
              ),
            ),
        ),
      )
  })

  const cancelThread: ArchitectureAdmissionServiceShape['cancelThread'] = Effect.fn(
    'ArchitectureAdmissionService.cancelThread',
  )(function* (threadId)
  {
    yield* cancelThreadWork(threadId, DateTime.formatIso(yield* DateTime.now))
  })

  return ArchitectureAdmissionService.of({ start, drain, retryProposal, cancelThread })
})

export const layer = Layer.effect(ArchitectureAdmissionService, make).pipe(
  Layer.provide(ArchitectureAdmissionRepository.layer),
)
