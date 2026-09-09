// apps/server/src/orchestration/ThreadSettlementReactor.ts
// serialize server-owned inactivity and merge settlement sweeps

import { CommandId } from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import { GitManager } from '../git/GitManager.ts'
import { ProviderBackgroundTaskRegistry } from '../provider/Services/ProviderBackgroundTaskRegistry.ts'
import { ProviderService } from '../provider/Services/ProviderService.ts'
import { ServerSettingsService } from '../serverSettings.ts'
import { OrchestrationEngineService } from './Services/OrchestrationEngine.ts'
import { ProjectionSnapshotQuery } from './Services/ProjectionSnapshotQuery.ts'
import { isAutoSettlementCandidate, resolveAutoSettlementAt } from './ThreadSettlementPolicy.ts'

export const makeThreadSettlementReactor = Effect.gen(function* ()
{
  const engine = yield* OrchestrationEngineService
  const snapshots = yield* ProjectionSnapshotQuery
  const settingsService = yield* ServerSettingsService
  const git = yield* GitManager
  const providerService = yield* ProviderService
  const backgroundTasks = yield* ProviderBackgroundTaskRegistry
  const crypto = yield* Crypto.Crypto
  const gate = yield* Semaphore.make(1)

  const sweep = Effect.fn('ThreadSettlementReactor.sweep')(function* ()
  {
    const policy = yield* settingsService.getSettings
    if (policy.sidebarAutoSettleAfterDays === null && !policy.sidebarAutoSettleOnMerge) return
    const snapshot = yield* snapshots.getShellSnapshot()
    const now = DateTime.formatIso(yield* DateTime.now)
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]))
    const candidates = snapshot.threads.filter((thread) => isAutoSettlementCandidate(thread, now))
    const groups = Map.groupBy(candidates, (thread) =>
      JSON.stringify([thread.projectId, thread.branch]),
    )
    for (const threads of groups.values())
    {
      yield* Effect.gen(function* ()
      {
        const first = threads[0]!
        const project = projects.get(first.projectId)
        if (project === undefined) return
        // branch lookup never switches a checkout; failed lookups keep the thread active.
        const pullRequest =
          first.branch === null
            ? null
            : yield* git
                .branchPullRequest({
                  cwd: project.workspaceRoot,
                  branch: first.branch,
                })
                .pipe(Effect.timeout('20 seconds'))
        for (const thread of threads)
        {
          yield* Effect.gen(function* ()
          {
            const sessions = yield* providerService.listSessions()
            if (
              sessions.some(
                (session) =>
                  session.threadId === thread.id &&
                  (session.status === 'connecting' ||
                    session.status === 'running' ||
                    session.activeTurnId !== undefined),
              )
            )
              return
            for (const identity of yield* providerService.captureSessionIdentities({
              threadId: thread.id,
            }))
            {
              if (yield* backgroundTasks.hasLiveTasks(identity)) return
            }
            const settings = yield* settingsService.getSettings
            const settledAt = resolveAutoSettlementAt({
              thread,
              pullRequest,
              now: DateTime.formatIso(yield* DateTime.now),
              autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
              autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
            })
            if (settledAt === null) return
            yield* engine.dispatch({
              type: 'thread.auto-settle',
              commandId: CommandId.make(
                `server:auto-settle:${thread.id}:${yield* crypto.randomUUIDv4}`,
              ),
              threadId: thread.id,
              snapshotSequence: snapshot.snapshotSequence,
              settledAt,
              autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
              autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
            })
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logDebug('automatic thread settlement skipped', {
                    threadId: thread.id,
                    cause: Cause.pretty(cause),
                  }),
            ),
          )
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning('automatic settlement source control lookup failed', {
                cause: Cause.pretty(cause),
              }),
        ),
      )
    }
  }, gate.withPermit)

  const runSweep = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning('automatic settlement sweep failed', { cause: Cause.pretty(cause) }),
    ),
  )
  const start = Effect.fn('ThreadSettlementReactor.start')(function* ()
  {
    yield* Effect.sleep('1 minute').pipe(
      Effect.andThen(runSweep),
      Effect.forever,
      Effect.forkScoped,
    )
    yield* settingsService.streamCurrentAndChanges.pipe(
      Stream.map((settings) => ({
        afterDays: settings.sidebarAutoSettleAfterDays,
        onMerge: settings.sidebarAutoSettleOnMerge,
      })),
      Stream.changesWith(
        (left, right) => left.afterDays === right.afterDays && left.onMerge === right.onMerge,
      ),
      Stream.runForEach(() => runSweep),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning('automatic settlement settings subscription failed', {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.forkScoped,
    )
  })

  return { sweep, start }
})
