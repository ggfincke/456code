// tests/apps/server/persistence/Layers/ProjectionRepositories.test.ts
// verifies projection repository persistence

import { EventId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { ProjectionProjectRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/ProjectionProjects.ts'
import { ProjectionThreadActivityRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/ProjectionThreadActivities.ts'
import { ProjectionThreadRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/ProjectionThreads.ts'
import { ProjectionProjectRepository } from '../../../../../apps/server/src/persistence/Services/ProjectionProjects.ts'
import { ProjectionThreadActivityRepository } from '../../../../../apps/server/src/persistence/Services/ProjectionThreadActivities.ts'
import { ProjectionThreadRepository } from '../../../../../apps/server/src/persistence/Services/ProjectionThreads.ts'

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
)

projectionRepositoriesLayer('Projection repositories', (it) =>
{
  it.effect('stores JSON for project and thread model selections', () =>
    Effect.gen(function* ()
    {
      const projects = yield* ProjectionProjectRepository
      const threads = yield* ProjectionThreadRepository
      const sql = yield* SqlClient.SqlClient

      const projectSelection = {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.4',
      }
      const threadSelection = {
        instanceId: ProviderInstanceId.make('claudeAgent'),
        model: 'claude-opus-4-6',
      }

      yield* projects.upsert({
        projectId: ProjectId.make('project-null-options'),
        title: 'Null options project',
        workspaceRoot: '/tmp/project-null-options',
        defaultModelSelection: projectSelection,
        scripts: [],
        createdAt: '2026-03-24T00:00:00.000Z',
        updatedAt: '2026-03-24T00:00:00.000Z',
        deletedAt: null,
      })

      yield* threads.upsert({
        threadId: ThreadId.make('thread-null-options'),
        projectId: ProjectId.make('project-null-options'),
        title: 'Null options thread',
        modelSelection: threadSelection,
        pendingHandoff: null,
        providerSwitch: null,
        runtimeMode: 'full-access',
        interactionMode: 'default',
        interactionOrchestrate: 0,
        branch: null,
        worktreePath: null,
        orchestrateRunWorktreePath: null,
        orchestrateRunBranch: null,
        originJson: null,
        latestTurnId: null,
        createdAt: '2026-03-24T00:00:00.000Z',
        updatedAt: '2026-03-24T00:00:00.000Z',
        archivedAt: null,
        archiveGeneration: 0,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      })

      const projectRows = yield* sql<{
        readonly defaultModelSelection: string | null
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `
      const projectRow = projectRows[0]
      if (!projectRow)
      {
        return yield* Effect.die('Expected projection_projects row to exist.')
      }

      assert.strictEqual(
        projectRow.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify(projectSelection),
      )

      const persistedProject = yield* projects.getById({
        projectId: ProjectId.make('project-null-options'),
      })
      assert.deepStrictEqual(
        Option.getOrNull(persistedProject)?.defaultModelSelection,
        projectSelection,
      )

      const threadRows = yield* sql<{
        readonly modelSelection: string | null
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `
      const threadRow = threadRows[0]
      if (!threadRow)
      {
        return yield* Effect.die('Expected projection_threads row to exist.')
      }

      assert.strictEqual(
        threadRow.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify(threadSelection),
      )

      const persistedThread = yield* threads.getById({
        threadId: ThreadId.make('thread-null-options'),
      })
      assert.deepStrictEqual(Option.getOrNull(persistedThread)?.modelSelection, threadSelection)
    }),
  )

  it.effect('round-trips non-null settlement values through the thread row', () =>
    Effect.gen(function* ()
    {
      const threads = yield* ProjectionThreadRepository

      yield* threads.upsert({
        threadId: ThreadId.make('thread-settled'),
        projectId: ProjectId.make('project-1'),
        title: 'Settled thread',
        modelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5.4',
        },
        pendingHandoff: null,
        providerSwitch: null,
        runtimeMode: 'full-access',
        interactionMode: 'default',
        interactionOrchestrate: 0,
        branch: null,
        worktreePath: null,
        orchestrateRunWorktreePath: null,
        orchestrateRunBranch: null,
        originJson: null,
        latestTurnId: null,
        createdAt: '2026-03-24T00:00:00.000Z',
        updatedAt: '2026-03-25T00:00:00.000Z',
        archivedAt: null,
        archiveGeneration: 0,
        settledOverride: 'settled',
        settledAt: '2026-03-25T00:00:00.000Z',
        unsettledAt: null,
        snoozedUntil: '2026-03-26T09:00:00.000Z',
        snoozedAt: '2026-03-25T00:00:00.000Z',
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      })

      const persisted = yield* threads.getById({
        threadId: ThreadId.make('thread-settled'),
      })
      const row = Option.getOrNull(persisted)
      if (!row)
      {
        return yield* Effect.die('Expected settled projection_threads row to exist.')
      }
      assert.strictEqual(row.settledOverride, 'settled')
      assert.strictEqual(row.settledAt, '2026-03-25T00:00:00.000Z')
      assert.strictEqual(row.snoozedUntil, '2026-03-26T09:00:00.000Z')
      assert.strictEqual(row.snoozedAt, '2026-03-25T00:00:00.000Z')

      // un-settle to the keep-active pin and wake the snooze; confirm the
      // flips persist.
      yield* threads.upsert({
        ...row,
        settledOverride: 'active',
        settledAt: null,
        unsettledAt: '2026-03-26T00:00:00.000Z',
        snoozedUntil: null,
        snoozedAt: null,
      })
      const repersisted = yield* threads.getById({
        threadId: ThreadId.make('thread-settled'),
      })
      const updated = Option.getOrNull(repersisted)
      assert.strictEqual(updated?.settledOverride, 'active')
      assert.strictEqual(updated?.settledAt, null)
      assert.strictEqual(updated?.unsettledAt, '2026-03-26T00:00:00.000Z')
      assert.strictEqual(updated?.snoozedUntil, null)
      assert.strictEqual(updated?.snoozedAt, null)
    }),
  )

  it.effect('orders activity lifecycle ties before the activity ID fallback', () =>
    Effect.gen(function* ()
    {
      const activities = yield* ProjectionThreadActivityRepository
      const threadId = ThreadId.make('thread-activity-order')
      const turnId = TurnId.make('turn-native')

      for (const [activityId, kind] of [
        [EventId.make('activity-a-completed'), 'tool.completed'],
        [EventId.make('activity-m-progress'), 'tool.updated'],
        [EventId.make('activity-z-started'), 'tool.started'],
      ] as const)
      {
        yield* activities.upsert({
          activityId,
          threadId,
          turnId,
          tone: 'info',
          kind,
          summary: kind,
          payload: {},
          sequence: 7,
          createdAt: '2026-03-24T00:00:00.000Z',
        })
      }

      const persisted = yield* activities.listByThreadId({ threadId })
      assert.deepStrictEqual(
        persisted.map((activity) => activity.activityId),
        ['activity-z-started', 'activity-m-progress', 'activity-a-completed'],
      )
    }),
  )
})
