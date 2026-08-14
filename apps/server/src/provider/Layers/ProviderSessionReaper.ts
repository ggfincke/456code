// apps/server/src/provider/Layers/ProviderSessionReaper.ts
// assemble provider session reaper Effect layer

import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'

import { ProjectionSnapshotQuery } from '../../orchestration/Services/ProjectionSnapshotQuery.ts'
import { ProviderBackgroundTaskRegistry } from '../Services/ProviderBackgroundTaskRegistry.ts'
import { ProviderSessionDirectory } from '../Services/ProviderSessionDirectory.ts'
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from '../Services/ProviderSessionReaper.ts'
import { ProviderService } from '../Services/ProviderService.ts'

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export interface ProviderSessionReaperLiveOptions
{
  readonly inactivityThresholdMs?: number
  readonly sweepIntervalMs?: number
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* ()
  {
    const providerService = yield* ProviderService
    const backgroundTasks = yield* ProviderBackgroundTaskRegistry
    const directory = yield* ProviderSessionDirectory
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    )
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)

    const sweep = Effect.gen(function* ()
    {
      const bindings = yield* directory.listBindings()
      const now = yield* Clock.currentTimeMillis
      let reapedCount = 0

      const bindingByThread = new Map(bindings.map((binding) => [binding.threadId, binding]))
      const durableSessions = yield* providerService.captureSessionIdentities()
      for (const identity of durableSessions)
      {
        const binding = bindingByThread.get(identity.threadId)
        if (
          binding !== undefined &&
          binding.status !== 'stopped' &&
          binding.provider === identity.provider &&
          binding.providerInstanceId === identity.providerInstanceId
        )
        {
          continue
        }
        if (yield* backgroundTasks.hasLiveTasks(identity))
        {
          yield* Effect.logDebug('provider.session.reaper.skipped-background-task', {
            threadId: identity.threadId,
            providerInstanceId: identity.providerInstanceId,
            sessionGeneration: identity.sessionGeneration,
            reason: 'durable_orphan',
          })
          continue
        }
        const reaped = yield* providerService.stopSessionIfExact(identity).pipe(
          Effect.tap((stopped) =>
            stopped
              ? Effect.logInfo('provider.session.reaper.reconciled-orphan', {
                  threadId: identity.threadId,
                  providerInstanceId: identity.providerInstanceId,
                  sessionGeneration: identity.sessionGeneration,
                })
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning('provider.session.reaper.orphan-stop-failed', {
              threadId: identity.threadId,
              providerInstanceId: identity.providerInstanceId,
              sessionGeneration: identity.sessionGeneration,
              cause,
            }).pipe(Effect.as(false)),
          ),
        )
        if (reaped)
        {
          reapedCount += 1
        }
      }

      for (const binding of bindings)
      {
        if (binding.status === 'stopped')
        {
          continue
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt)
        if (Number.isNaN(lastSeenMs))
        {
          yield* Effect.logWarning('provider.session.reaper.invalid-last-seen', {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          })
          continue
        }

        const idleDurationMs = now - lastSeenMs
        if (idleDurationMs < inactivityThresholdMs)
        {
          continue
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined))
        if (thread?.session?.activeTurnId != null)
        {
          yield* Effect.logDebug('provider.session.reaper.skipped-active-turn', {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          })
          continue
        }

        // pending orchestrate approve is live work; don't reap before the user responds
        const threadDetail = yield* projectionSnapshotQuery
          .getThreadDetailById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined))
        if (threadDetail?.orchestratePlans.some((plan) => plan.status === 'pending'))
        {
          yield* Effect.logDebug('provider.session.reaper.skipped-pending-orchestrate-plan', {
            threadId: binding.threadId,
            idleDurationMs,
          })
          continue
        }

        const latestBindings = yield* directory.listBindings()
        const latestBinding = latestBindings.find(
          (candidate) => candidate.threadId === binding.threadId,
        )
        if (
          latestBinding === undefined ||
          latestBinding.status === 'stopped' ||
          latestBinding.provider !== binding.provider ||
          latestBinding.providerInstanceId !== binding.providerInstanceId
        )
        {
          continue
        }

        const latestLastSeenMs = Date.parse(latestBinding.lastSeenAt)
        if (
          Number.isNaN(latestLastSeenMs) ||
          latestBinding.lastSeenAt !== binding.lastSeenAt ||
          now - latestLastSeenMs < inactivityThresholdMs
        )
        {
          continue
        }

        const providerInstanceId = latestBinding.providerInstanceId
        if (providerInstanceId === undefined)
        {
          continue
        }
        const identity = Option.getOrUndefined(
          yield* providerService.captureSessionIdentity({
            threadId: latestBinding.threadId,
            expectedProviderInstanceId: providerInstanceId,
          }),
        )
        if (identity === undefined || identity.provider !== latestBinding.provider)
        {
          continue
        }
        if (yield* backgroundTasks.hasLiveTasks(identity))
        {
          yield* Effect.logDebug('provider.session.reaper.skipped-background-task', {
            threadId: identity.threadId,
            providerInstanceId: identity.providerInstanceId,
            sessionGeneration: identity.sessionGeneration,
            reason: 'inactivity_threshold',
          })
          continue
        }

        const reaped = yield* providerService.stopSessionIfExact(identity).pipe(
          Effect.tap((stopped) =>
            stopped
              ? Effect.logInfo('provider.session.reaped', {
                  threadId: identity.threadId,
                  provider: identity.provider,
                  providerInstanceId: identity.providerInstanceId,
                  sessionGeneration: identity.sessionGeneration,
                  idleDurationMs,
                  reason: 'inactivity_threshold',
                })
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning('provider.session.reaper.stop-failed', {
              threadId: identity.threadId,
              provider: identity.provider,
              providerInstanceId: identity.providerInstanceId,
              sessionGeneration: identity.sessionGeneration,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        )

        if (reaped)
        {
          reapedCount += 1
        }
      }

      if (reapedCount > 0)
      {
        yield* Effect.logInfo('provider.session.reaper.sweep-complete', {
          reapedCount,
          totalBindings: bindings.length,
        })
      }
    })

    const start: ProviderSessionReaperShape['start'] = () =>
      Effect.gen(function* ()
      {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning('provider.session.reaper.sweep-failed', {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning('provider.session.reaper.sweep-defect', {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        )

        yield* Effect.logInfo('provider.session.reaper.started', {
          inactivityThresholdMs,
          sweepIntervalMs,
        })
      })

    return {
      start,
    } satisfies ProviderSessionReaperShape
  })

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options))

export const ProviderSessionReaperLive = makeProviderSessionReaperLive()
