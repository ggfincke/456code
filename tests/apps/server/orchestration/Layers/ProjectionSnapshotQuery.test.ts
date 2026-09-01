// tests/apps/server/orchestration/Layers/ProjectionSnapshotQuery.test.ts
// verifies orchestration projection snapshot loading

import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as Tracer from 'effect/Tracer'

import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import ProjectionThreadCommandActivityIndexesMigration from '../../../../../apps/server/src/persistence/Migrations/036_ProjectionThreadCommandActivityIndexes.ts'
import HealOrchestratePlanRespondFailureMigration from '../../../../../apps/server/src/persistence/Migrations/069_HealOrchestratePlanRespondFailure.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import { decideOrchestrationCommand } from '../../../../../apps/server/src/orchestration/decider.ts'
import { projectThreadDetailSnapshot } from '../../../../../apps/server/src/orchestration/ActivityPayloadProjection.ts'
import { ORCHESTRATION_PROJECTOR_NAMES } from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import {
  COMMAND_THREAD_ACTIVITY_QUERY_SQL,
  OrchestrationProjectionSnapshotQueryLive,
  THREAD_DETAIL_ACTIVITY_QUERY_SQL,
} from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { ProjectionSnapshotQuery } from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'

const asProjectId = (value: string): ProjectId => ProjectId.make(value)
const asTurnId = (value: string): TurnId => TurnId.make(value)
const asMessageId = (value: string): MessageId => MessageId.make(value)
const asEventId = (value: string): EventId => EventId.make(value)
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value)
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString)

const clearProjectionTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* ()
  {
    yield* sql`DELETE FROM projection_checkpoint_identities`
    yield* sql`DELETE FROM projection_pending_approvals`
    yield* sql`DELETE FROM projection_thread_messages`
    yield* sql`DELETE FROM projection_thread_activities`
    yield* sql`DELETE FROM projection_thread_proposed_plans`
    yield* sql`DELETE FROM projection_turns`
    yield* sql`DELETE FROM projection_threads`
    yield* sql`DELETE FROM projection_projects`
    yield* sql`DELETE FROM projection_state`
  })

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
)

projectionSnapshotLayer('ProjectionSnapshotQuery', (it) =>
{
  it.effect('searches literal canonical messages with ranked bounded thread results', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient
      const query = yield* ProjectionSnapshotQuery
      yield* clearProjectionTables(sql)
      const timestamp = '2026-08-27T00:00:00.000Z'
      for (const projectId of ['search-project', 'deleted-project'])
      {
        yield* sql`INSERT INTO projection_projects
          (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
          VALUES (${projectId}, ${projectId}, '/tmp/search', NULL, '[]', ${timestamp}, ${timestamp},
            ${projectId === 'deleted-project' ? timestamp : null})`
      }
      const rows = [
        ['user', 'user', 'literal !%_ match'],
        ['assistant', 'assistant', 'literal !%_ match'],
        ['intermediate', 'assistant', 'literal !%_ match'],
        ['streaming', 'user', 'literal !%_ match'],
        ['archived', 'user', 'literal !%_ match'],
        ['deleted', 'user', 'literal !%_ match'],
        ['project-deleted', 'user', 'literal !%_ match'],
        ['system', 'system', 'literal !%_ match'],
        ['wildcard-decoy', 'user', 'literal !XX match'],
      ] as const
      for (const [id, role, text] of rows)
      {
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, created_at, updated_at, archived_at, deleted_at)
          VALUES (${id}, ${id === 'project-deleted' ? 'deleted-project' : 'search-project'}, ${id},
            '{"provider":"codex","model":"gpt-5"}', ${timestamp}, ${timestamp},
            ${id === 'archived' ? timestamp : null}, ${id === 'deleted' ? timestamp : null})`
        yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${`message-${id}`}, ${id}, ${`turn-${id}`}, ${role}, ${text},
            ${id === 'streaming' ? 1 : 0}, ${timestamp}, ${timestamp})`
      }
      yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, assistant_message_id, state, requested_at, checkpoint_files_json)
        VALUES ('assistant', 'turn-assistant', 'message-assistant', 'completed', ${timestamp}, '[]')`
      // return only the newest matching user message from the same thread
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('second-user', 'user', 'user', ${`${'prefix '.repeat(50)}!%_ ${'suffix '.repeat(50)}`},
          0, '2026-08-27T00:01:00.000Z', ${timestamp})`
      const found = yield* query.searchThreads({ query: '!%_' })
      assert.deepEqual(
        found.matches.map((match) => [match.threadId, match.source]),
        [
          ['user', 'user'],
          ['assistant', 'assistant'],
        ],
      )
      assert.isAtMost(found.matches[0]!.snippet.length, 240)
      assert.include(found.matches[0]!.snippet, '!%_')
      assert.equal(found.matches[0]!.messageCreatedAt, '2026-08-27T00:01:00.000Z')
      assert.equal((yield* query.searchThreads({ query: '!%_', limit: 1 })).matches.length, 1)
    }),
  )

  it.effect('hydrates read model from projection tables and computes snapshot sequence', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `

      let sequence = 5
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES))
      {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `
        sequence += 1
      }

      const snapshot = yield* snapshotQuery.getSnapshot()

      assert.equal(snapshot.snapshotSequence, 5)
      assert.equal(snapshot.updatedAt, '2026-02-24T00:00:09.000Z')
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId('project-1'),
          title: 'Project 1',
          workspaceRoot: '/tmp/project-1',
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          scripts: [
            {
              id: 'script-1',
              name: 'Build',
              command: 'bun run build',
              icon: 'build',
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: '2026-02-24T00:00:00.000Z',
          updatedAt: '2026-02-24T00:00:01.000Z',
          deletedAt: null,
        },
      ])
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make('thread-1'),
          projectId: asProjectId('project-1'),
          title: 'Thread 1',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          interactionMode: 'default',
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          origin: null,
          pendingHandoff: null,
          providerSwitch: null,
          latestTurn: {
            turnId: asTurnId('turn-1'),
            state: 'completed',
            requestedAt: '2026-02-24T00:00:08.000Z',
            startedAt: '2026-02-24T00:00:08.000Z',
            completedAt: '2026-02-24T00:00:08.000Z',
            assistantMessageId: asMessageId('message-1'),
            sourceProposedPlan: {
              threadId: ThreadId.make('thread-1'),
              planId: 'plan-1',
            },
          },
          createdAt: '2026-02-24T00:00:02.000Z',
          updatedAt: '2026-02-24T00:00:03.000Z',
          archivedAt: null,
          archiveGeneration: 0,
          orchestrateRunExecution: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId('message-1'),
              role: 'assistant',
              text: 'hello from projection',
              turnId: asTurnId('turn-1'),
              streaming: false,
              createdAt: '2026-02-24T00:00:04.000Z',
              updatedAt: '2026-02-24T00:00:05.000Z',
            },
          ],
          proposedPlans: [
            {
              id: 'plan-1',
              turnId: asTurnId('turn-1'),
              planMarkdown: '# Ship it',
              implementedAt: '2026-02-24T00:00:05.500Z',
              implementationThreadId: ThreadId.make('thread-2'),
              createdAt: '2026-02-24T00:00:05.000Z',
              updatedAt: '2026-02-24T00:00:05.500Z',
            },
          ],
          orchestratePlans: [],
          activities: [
            {
              id: asEventId('activity-1'),
              tone: 'info',
              kind: 'runtime.note',
              summary: 'provider started',
              payload: { stage: 'start' },
              turnId: asTurnId('turn-1'),
              createdAt: '2026-02-24T00:00:06.000Z',
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId('turn-1'),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef('checkpoint-1'),
              status: 'ready',
              files: [{ path: 'README.md', kind: 'modified', additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId('message-1'),
              completedAt: '2026-02-24T00:00:08.000Z',
            },
          ],
          approvalOutcomes: [],
          session: {
            threadId: ThreadId.make('thread-1'),
            status: 'running',
            providerName: 'codex',
            runtimeMode: 'approval-required',
            activeTurnId: asTurnId('turn-1'),
            lastError: null,
            updatedAt: '2026-02-24T00:00:07.000Z',
          },
        },
      ])

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot()
      assert.equal(shellSnapshot.snapshotSequence, 5)
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId('project-1'),
          title: 'Project 1',
          workspaceRoot: '/tmp/project-1',
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          scripts: [
            {
              id: 'script-1',
              name: 'Build',
              command: 'bun run build',
              icon: 'build',
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: '2026-02-24T00:00:00.000Z',
          updatedAt: '2026-02-24T00:00:01.000Z',
        },
      ])
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make('thread-1'),
          projectId: asProjectId('project-1'),
          title: 'Thread 1',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          interactionMode: 'default',
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          origin: null,
          providerSwitch: null,
          latestTurn: {
            turnId: asTurnId('turn-1'),
            state: 'completed',
            requestedAt: '2026-02-24T00:00:08.000Z',
            startedAt: '2026-02-24T00:00:08.000Z',
            completedAt: '2026-02-24T00:00:08.000Z',
            assistantMessageId: asMessageId('message-1'),
            sourceProposedPlan: {
              threadId: ThreadId.make('thread-1'),
              planId: 'plan-1',
            },
          },
          createdAt: '2026-02-24T00:00:02.000Z',
          updatedAt: '2026-02-24T00:00:03.000Z',
          archivedAt: null,
          orchestrateRunExecution: null,
          settledOverride: null,
          settledAt: null,
          unsettledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          session: {
            threadId: ThreadId.make('thread-1'),
            status: 'running',
            providerName: 'codex',
            runtimeMode: 'approval-required',
            activeTurnId: asTurnId('turn-1'),
            lastError: null,
            updatedAt: '2026-02-24T00:00:07.000Z',
          },
          latestUserMessageAt: '2026-02-24T00:00:04.000Z',
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          approvalOutcomes: [],
        },
      ])

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make('thread-1'))
      assert.equal(threadDetail._tag, 'Some')
      if (threadDetail._tag === 'Some')
      {
        assert.deepEqual(threadDetail.value, snapshot.threads[0])
      }
    }),
  )

  it.effect('measures serialized replay bytes without decoding event payloads', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* sql`DELETE FROM orchestration_events`
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'replay-event-before',
            'thread',
            'thread-replay',
            0,
            'thread.activity-appended',
            '2026-03-01T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{}',
            '{}'
          ),
          (
            'replay-event-invalid-json',
            'thread',
            'thread-replay',
            1,
            'thread.activity-appended',
            '2026-03-01T00:00:01.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{not-json',
            '{}'
          ),
          (
            'replay-event-emoji',
            'thread',
            'thread-replay',
            2,
            'thread.activity-appended',
            '2026-03-01T00:00:02.000Z',
            NULL,
            NULL,
            NULL,
            'provider',
            '{"output":"😀"}',
            '{}'
          )
      `
      const sequenceRows = yield* sql<{
        readonly eventId: string
        readonly sequence: number
      }>`
        SELECT event_id AS "eventId", sequence
        FROM orchestration_events
        ORDER BY sequence ASC
      `

      const stats = yield* snapshotQuery.getEventReplayStats({
        fromSequenceExclusive: sequenceRows[0]!.sequence,
        toSequenceInclusive: sequenceRows[2]!.sequence,
      })
      assert.deepStrictEqual(stats, {
        eventCount: 2,
        payloadBytes: 26,
      })
    }),
  )

  it.effect('filters targeted activities before payload decoding', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient
      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project-filtered-detail', 'Filtered detail', '/tmp/filtered-detail',
          '{"provider":"codex","model":"gpt-5"}', '[]',
          '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL
        )
      `
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at
        ) VALUES (
          'thread-filtered-detail', 'project-filtered-detail', 'Filtered detail',
          '{"provider":"codex","model":"gpt-5"}',
          '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'
        )
      `
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          (
            'activity-task-started', 'thread-filtered-detail', NULL, 'info', 'task.started',
            'Ship the query filter', '{"taskId":"task-1"}', 1,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'activity-malformed-tool', 'thread-filtered-detail', NULL, 'tool', 'tool.completed',
            'Malformed tool output', 'not-json', 2, '2026-03-01T00:00:02.000Z'
          )
      `

      const withoutActivities = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make('thread-filtered-detail'),
        { activityKinds: [] },
      )
      assert.equal(withoutActivities._tag, 'Some')
      if (withoutActivities._tag === 'Some')
      {
        assert.deepEqual(withoutActivities.value.activities, [])
      }

      const withTaskActivities = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make('thread-filtered-detail'),
        { activityKinds: ['task.started', 'task.progress'] },
      )
      assert.equal(withTaskActivities._tag, 'Some')
      if (withTaskActivities._tag === 'Some')
      {
        assert.deepEqual(withTaskActivities.value.activities, [
          {
            id: EventId.make('activity-task-started'),
            tone: 'info',
            kind: 'task.started',
            summary: 'Ship the query filter',
            payload: { taskId: 'task-1' },
            turnId: null,
            sequence: 1,
            createdAt: '2026-03-01T00:00:01.000Z',
          },
        ])
      }
    }),
  )

  it.effect('keeps archived threads out of the main shell snapshot', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot()
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make('thread-active')],
      )

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot()
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make('thread-archived')],
      )
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, '2026-04-06T00:00:06.000Z')
    }),
  )

  it.effect('checks import finalization without hydrating thread history', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-import-finalization',
          'Import Finalization',
          '/tmp/import-finalization',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T01:00:00.000Z',
          '2026-04-06T01:00:01.000Z',
          NULL
        )
      `
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-finalized-active',
            'project-import-finalization',
            'Finalized active',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T01:00:02.000Z',
            '2026-04-06T01:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-finalized-archived',
            'project-import-finalization',
            'Finalized archived',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T01:00:04.000Z',
            '2026-04-06T01:00:05.000Z',
            '2026-04-06T01:00:06.000Z',
            NULL
          ),
          (
            'thread-finalized-deleted',
            'project-import-finalization',
            'Finalized deleted',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T01:00:07.000Z',
            '2026-04-06T01:00:08.000Z',
            NULL,
            '2026-04-06T01:00:09.000Z'
          ),
          (
            'thread-not-finalized',
            'project-import-finalization',
            'Not finalized',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T01:00:10.000Z',
            '2026-04-06T01:00:11.000Z',
            NULL,
            NULL
          )
      `
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-finalized-active',
            'thread-finalized-active',
            NULL,
            'info',
            'task.completed',
            'Continuation marker',
            '{"type":"import.continuation"}',
            1,
            '2026-04-06T01:00:03.000Z'
          ),
          (
            'activity-finalized-archived',
            'thread-finalized-archived',
            NULL,
            'info',
            'task.completed',
            'Continuation marker',
            '{"type":"import.continuation"}',
            1,
            '2026-04-06T01:00:05.000Z'
          ),
          (
            'activity-finalized-deleted',
            'thread-finalized-deleted',
            NULL,
            'info',
            'task.completed',
            'Continuation marker',
            '{"type":"import.continuation"}',
            1,
            '2026-04-06T01:00:08.000Z'
          ),
          (
            'activity-invalid-json',
            'thread-not-finalized',
            NULL,
            'info',
            'runtime.note',
            'Invalid payload',
            '{',
            1,
            '2026-04-06T01:00:11.000Z'
          ),
          (
            'activity-other-type',
            'thread-not-finalized',
            NULL,
            'info',
            'runtime.note',
            'Other payload',
            '{"type":"runtime.note"}',
            2,
            '2026-04-06T01:00:12.000Z'
          )
      `

      assert.equal(
        yield* snapshotQuery.isThreadImportFinalized(ThreadId.make('thread-finalized-active')),
        true,
      )
      assert.equal(
        yield* snapshotQuery.isThreadImportFinalized(ThreadId.make('thread-finalized-archived')),
        true,
      )
      assert.equal(
        yield* snapshotQuery.isThreadImportFinalized(ThreadId.make('thread-finalized-deleted')),
        false,
      )
      assert.equal(
        yield* snapshotQuery.isThreadImportFinalized(ThreadId.make('thread-not-finalized')),
        false,
      )
      assert.equal(
        yield* snapshotQuery.isThreadImportFinalized(ThreadId.make('thread-missing')),
        false,
      )
    }),
  )

  it.effect('keeps settled threads in the shell snapshot with non-null settlement fields', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-settled-test',
          'Settled Test',
          '/tmp/settled-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES (
          'thread-settled',
          'project-settled-test',
          'Settled Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-06T00:00:02.000Z',
          '2026-04-06T00:00:05.000Z',
          NULL,
          'settled',
          '2026-04-06T00:00:04.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `

      // settled ≠ archived: the thread must appear in the LIVE shell
      // snapshot, carrying its settlement fields through the row aliases.
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot()
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make('thread-settled')],
      )
      assert.equal(shellSnapshot.threads[0]?.settledOverride, 'settled')
      assert.equal(shellSnapshot.threads[0]?.settledAt, '2026-04-06T00:00:04.000Z')

      // and the full command read model carries them too.
      const readModel = yield* snapshotQuery.getCommandReadModel()
      const thread = readModel.threads.find(
        (candidate) => candidate.id === ThreadId.make('thread-settled'),
      )
      assert.equal(thread?.settledOverride, 'settled')
      assert.equal(thread?.settledAt, '2026-04-06T00:00:04.000Z')
    }),
  )

  it.effect(
    'reads targeted project, thread, and count queries without hydrating the full snapshot',
    () =>
      Effect.gen(function* ()
      {
        const snapshotQuery = yield* ProjectionSnapshotQuery
        const sql = yield* SqlClient.SqlClient

        yield* clearProjectionTables(sql)

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `

        const counts = yield* snapshotQuery.getCounts()
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        })

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot('/tmp/workspace')
        assert.equal(project._tag, 'Some')
        if (project._tag === 'Some')
        {
          assert.equal(project.value.id, asProjectId('project-active'))
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot('/tmp/missing')
        assert.equal(missingProject._tag, 'None')

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId('project-active'),
        )
        assert.equal(firstThreadId._tag, 'Some')
        if (firstThreadId._tag === 'Some')
        {
          assert.equal(firstThreadId.value, ThreadId.make('thread-first'))
        }
      }),
  )

  it.effect('reads only active projects and nondeleted imported-thread metadata', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-import-active',
            'Imported History',
            '/tmp/imported-history',
            NULL,
            '[]',
            '2026-03-01T01:00:00.000Z',
            '2026-03-01T01:00:01.000Z',
            NULL
          ),
          (
            'project-import-deleted',
            'Deleted Imported History',
            '/tmp/deleted-imported-history',
            NULL,
            '[]',
            '2026-03-01T01:00:02.000Z',
            '2026-03-01T01:00:03.000Z',
            '2026-03-01T01:00:04.000Z'
          )
      `
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          origin_json,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-import-active',
            'project-import-active',
            'Active import',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            '{"kind":"imported","source":"codex-cli","sourcePath":"/tmp/active.jsonl","contentHash":"active-hash","nativeSessionId":"active-native","providerInstanceId":null,"importedAt":"2026-03-01T01:00:05.000Z"}',
            NULL,
            '2026-03-01T01:00:05.000Z',
            '2026-03-01T01:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-import-archived',
            'project-import-active',
            'Archived import',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            '{"kind":"imported","source":"claude-code","sourcePath":"/tmp/archived.jsonl","contentHash":"archived-hash","nativeSessionId":"archived-native","providerInstanceId":null,"originalWorkspaceRoot":"/missing/workspace","importedAt":"2026-03-01T01:00:07.000Z"}',
            NULL,
            '2026-03-01T01:00:07.000Z',
            '2026-03-01T01:00:08.000Z',
            '2026-03-01T01:00:09.000Z',
            NULL
          ),
          (
            'thread-not-imported',
            'project-import-active',
            'Ordinary thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            '2026-03-01T01:00:10.000Z',
            '2026-03-01T01:00:11.000Z',
            NULL,
            NULL
          ),
          (
            'thread-import-deleted',
            'project-import-active',
            'Deleted import',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            '{"kind":"imported","source":"opencode","sourcePath":"/tmp/deleted.json","contentHash":"deleted-hash","nativeSessionId":"deleted-native","providerInstanceId":null,"importedAt":"2026-03-01T01:00:12.000Z"}',
            NULL,
            '2026-03-01T01:00:12.000Z',
            '2026-03-01T01:00:13.000Z',
            NULL,
            '2026-03-01T01:00:14.000Z'
          )
      `

      const context = yield* snapshotQuery.getImportReconciliationContext()

      assert.deepEqual(context.projects, [
        {
          projectId: asProjectId('project-import-active'),
          workspaceRoot: '/tmp/imported-history',
        },
      ])
      assert.deepEqual(
        context.threads.map((thread) => ({
          threadId: thread.threadId,
          source: thread.origin.source,
          archived: thread.archived,
        })),
        [
          {
            threadId: ThreadId.make('thread-import-active'),
            source: 'codex-cli',
            archived: false,
          },
          {
            threadId: ThreadId.make('thread-import-archived'),
            source: 'claude-code',
            archived: true,
          },
        ],
      )
    }),
  )

  it.effect('reads single-thread checkpoint context without hydrating unrelated threads', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `
      yield* sql`
        INSERT INTO projection_checkpoint_identities (
          thread_id,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_capture_root,
          checkpoint_repository_common_dir,
          checkpoint_commit_oid,
          captured_at
        )
        VALUES
          (
            'thread-context',
            0,
            'checkpoint-zero',
            '/tmp/capture-zero',
            '/tmp/repository/.git',
            '0000000000000000000000000000000000000000',
            '2026-03-02T00:00:03.000Z'
          ),
          (
            'thread-context',
            1,
            'checkpoint-a',
            '/tmp/capture-one',
            '/tmp/repository/.git',
            '1111111111111111111111111111111111111111',
            '2026-03-02T00:00:04.000Z'
          )
      `

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make('thread-context'),
      )
      assert.equal(context._tag, 'Some')
      if (context._tag === 'Some')
      {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make('thread-context'),
          projectId: asProjectId('project-context'),
          workspaceRoot: '/tmp/context-workspace',
          worktreePath: '/tmp/context-worktree',
          baselineCheckpointIdentity: {
            checkpointTurnCount: 0,
            checkpointRef: asCheckpointRef('checkpoint-zero'),
            checkpointCaptureRoot: '/tmp/capture-zero',
            checkpointRepositoryCommonDir: '/tmp/repository/.git',
            checkpointCommitOid: '0000000000000000000000000000000000000000',
          },
          checkpoints: [
            {
              turnId: asTurnId('turn-1'),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef('checkpoint-a'),
              status: 'ready',
              files: [],
              assistantMessageId: null,
              completedAt: '2026-03-02T00:00:04.000Z',
              checkpointCaptureRoot: '/tmp/capture-one',
              checkpointRepositoryCommonDir: '/tmp/repository/.git',
              checkpointCommitOid: '1111111111111111111111111111111111111111',
            },
            {
              turnId: asTurnId('turn-2'),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef('checkpoint-b'),
              status: 'ready',
              files: [],
              assistantMessageId: null,
              completedAt: '2026-03-02T00:00:05.000Z',
            },
          ],
        })
      }

      const fullContext = yield* snapshotQuery.getFullThreadDiffContext(
        ThreadId.make('thread-context'),
        2,
      )
      assert.equal(fullContext._tag, 'Some')
      if (fullContext._tag === 'Some')
      {
        assert.deepEqual(fullContext.value.fromCheckpointIdentity, {
          checkpointTurnCount: 0,
          checkpointRef: asCheckpointRef('checkpoint-zero'),
          checkpointCaptureRoot: '/tmp/capture-zero',
          checkpointRepositoryCommonDir: '/tmp/repository/.git',
          checkpointCommitOid: '0000000000000000000000000000000000000000',
        })
        assert.deepEqual(fullContext.value.toCheckpointIdentity, {
          checkpointTurnCount: 2,
          checkpointRef: asCheckpointRef('checkpoint-b'),
          checkpointCaptureRoot: null,
          checkpointRepositoryCommonDir: null,
          checkpointCommitOid: null,
        })
        assert.equal(fullContext.value.toCheckpointRef, asCheckpointRef('checkpoint-b'))
      }
    }),
  )

  it.effect('keeps thread detail activity ordering consistent with shell snapshot ordering', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          ),
          (
            'activity-a-completed',
            'thread-1',
            'turn-native',
            'info',
            'tool.completed',
            'completed',
            '{}',
            7,
            '2026-04-01T00:00:05.500Z'
          ),
          (
            'activity-m-progress',
            'thread-1',
            'turn-native',
            'info',
            'tool.updated',
            'progress',
            '{}',
            7,
            '2026-04-01T00:00:05.500Z'
          ),
          (
            'activity-z-started',
            'thread-1',
            'turn-native',
            'info',
            'tool.started',
            'started',
            '{}',
            7,
            '2026-04-01T00:00:05.500Z'
          )
      `

      const snapshot = yield* snapshotQuery.getSnapshot()
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make('thread-1'))

      assert.equal(threadDetail._tag, 'Some')
      if (threadDetail._tag === 'Some')
      {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? [])
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId('activity-sequence-1'),
          tone: 'info',
          kind: 'runtime.note',
          summary: 'sequence one',
          payload: { source: 'sequence-1' },
          turnId: null,
          sequence: 1,
          createdAt: '2026-04-01T00:00:05.000Z',
        },
        {
          id: asEventId('activity-sequence-2'),
          tone: 'info',
          kind: 'runtime.note',
          summary: 'sequence two',
          payload: { source: 'sequence-2' },
          turnId: null,
          sequence: 2,
          createdAt: '2026-04-01T00:00:04.000Z',
        },
        {
          id: asEventId('activity-z-started'),
          tone: 'info',
          kind: 'tool.started',
          summary: 'started',
          payload: {},
          turnId: asTurnId('turn-native'),
          sequence: 7,
          createdAt: '2026-04-01T00:00:05.500Z',
        },
        {
          id: asEventId('activity-m-progress'),
          tone: 'info',
          kind: 'tool.updated',
          summary: 'progress',
          payload: {},
          turnId: asTurnId('turn-native'),
          sequence: 7,
          createdAt: '2026-04-01T00:00:05.500Z',
        },
        {
          id: asEventId('activity-a-completed'),
          tone: 'info',
          kind: 'tool.completed',
          summary: 'completed',
          payload: {},
          turnId: asTurnId('turn-native'),
          sequence: 7,
          createdAt: '2026-04-01T00:00:05.500Z',
        },
        {
          id: asEventId('activity-unsequenced'),
          tone: 'info',
          kind: 'runtime.note',
          summary: 'unsequenced first',
          payload: { source: 'unsequenced' },
          turnId: null,
          createdAt: '2026-04-01T00:00:06.000Z',
        },
      ])
    }),
  )

  it.effect(
    'bounds detail activity hydration while pinning unresolved requests and import state',
    () =>
      Effect.gen(function* ()
      {
        const snapshotQuery = yield* ProjectionSnapshotQuery
        const sql = yield* SqlClient.SqlClient

        yield* clearProjectionTables(sql)
        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-bounded-detail',
          'Bounded detail',
          '/tmp/project-bounded-detail',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-08-16T00:00:00.000Z',
          '2026-08-16T00:00:01.000Z',
          NULL
        )
      `
        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-bounded-detail',
          'project-bounded-detail',
          'Bounded detail',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          1,
          1,
          0,
          '2026-08-16T00:00:02.000Z',
          '2026-08-16T00:00:03.000Z',
          NULL
        )
      `
        yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        VALUES (
          'approval-bounded-detail',
          'thread-bounded-detail',
          NULL,
          'pending',
          NULL,
          '2026-08-16T00:00:04.000Z',
          NULL
        )
      `
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-bounded-import-marker',
            'thread-bounded-detail',
            NULL,
            'info',
            'task.completed',
            'Continuation marker',
            '{"type":"import.continuation"}',
            0,
            '2026-08-16T00:00:04.000Z'
          ),
          (
            'activity-bounded-approval',
            'thread-bounded-detail',
            NULL,
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-bounded-detail"}',
            1,
            '2026-08-16T00:00:05.000Z'
          ),
          (
            'activity-bounded-user-input',
            'thread-bounded-detail',
            NULL,
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-bounded-detail"}',
            2,
            '2026-08-16T00:00:06.000Z'
          )
      `
        yield* sql`
        WITH RECURSIVE activity_numbers(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1
          FROM activity_numbers
          WHERE value < 501
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          'activity-bounded-note-' || printf('%03d', value),
          'thread-bounded-detail',
          NULL,
          'info',
          CASE
            WHEN value = 2 THEN 'tool.updated'
            WHEN value = 80 THEN 'tool.completed'
            WHEN value IN (3, 70) THEN 'context-window.updated'
            ELSE 'runtime.note'
          END,
          'Later activity',
          CASE
            WHEN value IN (2, 80) THEN json_object(
              'itemType', 'command_execution',
              'toolCallId', 'cross-batch-call',
              'title', CASE WHEN value = 80 THEN 'Build completed' ELSE 'Build' END,
              'status', 'completed',
              'data', json_object(
                'toolCallId', 'cross-batch-call',
                'item', json_object(
                  'command', 'vp test run',
                  'aggregatedOutput', printf(
                    'command output%s%s',
                    char(13) || char(10),
                    replace(hex(zeroblob(8192)), '00', 'x')
                  )
                ),
                'rawOutput', printf(
                  'raw output%s%s',
                  char(13) || char(10),
                  replace(hex(zeroblob(8192)), '00', 'y')
                ),
                'files', json_array(json_object('path', 'apps/server/src/snapshot.ts'))
              )
            )
            WHEN value IN (3, 70) THEN json_object(
              'usedTokens', value * 100,
              'modelContextWindow', 100000
            )
            ELSE json_object('value', value)
          END,
          value + 2,
          printf('2026-08-16T01:%02d:%02d.000Z', value / 60, value % 60)
        FROM activity_numbers
      `

        const planRows = yield* sql.unsafe<{
          readonly id: number
          readonly parent: number
          readonly detail: string
        }>(`EXPLAIN QUERY PLAN ${THREAD_DETAIL_ACTIVITY_QUERY_SQL}`, [
          'thread-bounded-detail',
          'thread-bounded-detail',
          'thread-bounded-detail',
          'thread-bounded-detail',
        ])
        const plan = planRows.map((row) => row.detail).join('\n')

        assert.match(
          plan,
          /SEARCH recent USING INDEX idx_projection_thread_activities_command_window \(thread_id=\?\)/u,
        )
        assert.match(
          plan,
          /SEARCH marker USING INDEX idx_projection_thread_activities_import_continuation \(thread_id=\?\)/u,
        )
        assert.match(
          plan,
          /SEARCH pending USING INDEX idx_projection_pending_approvals_thread_status \(thread_id=\? AND status=\?\)/u,
        )
        assert.equal(
          planRows.filter((row) =>
            row.detail.includes(
              'SEARCH activity USING INDEX idx_projection_thread_activities_command_relevant (thread_id=?)',
            ),
          ).length,
          2,
        )
        assert.notMatch(plan, /\bSCAN (?:recent|marker|activity)(?:\s|$)/u)

        // merge and final-order sorts are bounded by the selected rows; the
        // two source windows must never sort full thread history themselves
        const historyWindowIds = new Set(
          planRows
            .filter(
              (row) =>
                row.detail === 'CO-ROUTINE recent_activity_ids' ||
                row.detail === 'CO-ROUTINE latest_import_marker',
            )
            .map((row) => row.id),
        )
        assert.equal(historyWindowIds.size, 2)
        assert.isFalse(
          planRows.some(
            (row) =>
              historyWindowIds.has(row.parent) && row.detail === 'USE TEMP B-TREE FOR ORDER BY',
          ),
        )

        const detail = yield* snapshotQuery.getThreadDetailById(
          ThreadId.make('thread-bounded-detail'),
        )
        assert.equal(detail._tag, 'Some')
        if (detail._tag === 'Some')
        {
          const activityIds = detail.value.activities.map((activity) => activity.id)
          assert.equal(activityIds.length, 503)
          assert.deepEqual(activityIds.slice(0, 3), [
            asEventId('activity-bounded-import-marker'),
            asEventId('activity-bounded-approval'),
            asEventId('activity-bounded-user-input'),
          ])
          assert.isFalse(activityIds.includes(asEventId('activity-bounded-note-001')))
          assert.isTrue(activityIds.includes(asEventId('activity-bounded-note-002')))
          assert.isTrue(activityIds.includes(asEventId('activity-bounded-note-501')))
        }

        const payloadQuerySpans: Array<{
          readonly startTime: bigint
          readonly endTime: bigint
          readonly query: string
        }> = []
        const queryTracer = Tracer.make({
          span: (options) =>
          {
            const span = new Tracer.NativeSpan(options)
            const end = span.end.bind(span)
            span.end = (endTime, exit) =>
            {
              end(endTime, exit)
              const query = span.attributes.get('db.query.text')
              if (
                typeof query === 'string' &&
                query.includes('payload_json AS "payload"') &&
                query.includes('"activity_id" IN (')
              )
              {
                payloadQuerySpans.push({ startTime: span.startTime, endTime, query })
              }
            }
            return span
          },
        })
        const clientSnapshot = yield* snapshotQuery
          .getThreadDetailSnapshot(ThreadId.make('thread-bounded-detail'))
          .pipe(Effect.withTracer(queryTracer))
        assert.equal(clientSnapshot._tag, 'Some')
        assert.equal(payloadQuerySpans.length, Math.ceil(503 / 25))
        for (let index = 0; index < payloadQuerySpans.length; index += 1)
        {
          const current = payloadQuerySpans[index]!
          assert.isAtMost(current.query.match(/\?/gu)?.length ?? 0, 25)
          if (index > 0)
          {
            assert.isTrue(payloadQuerySpans[index - 1]!.endTime <= current.startTime)
          }
        }
        if (detail._tag === 'Some' && clientSnapshot._tag === 'Some')
        {
          const projectedClientSnapshot = projectThreadDetailSnapshot(clientSnapshot.value)
          const projectedRawBaseline = projectThreadDetailSnapshot({
            snapshotSequence: clientSnapshot.value.snapshotSequence,
            thread: detail.value,
          })
          assert.deepStrictEqual(projectedClientSnapshot, projectedRawBaseline)

          const projectedActivities = projectedClientSnapshot.thread.activities
          const latestContextWindow = projectedActivities.find(
            (activity) => activity.id === asEventId('activity-bounded-note-070'),
          )
          assert.deepEqual(latestContextWindow?.payload, {
            usedTokens: 7000,
            modelContextWindow: 100000,
          })

          const completedCommand = projectedActivities.find(
            (activity) => activity.id === asEventId('activity-bounded-note-080'),
          )
          assert.isDefined(completedCommand)
          if (completedCommand)
          {
            const completedPayloadJson = encodeUnknownJsonString(completedCommand.payload)
            assert.isBelow(completedPayloadJson.length, 1_000)
            assert.notInclude(completedPayloadJson, 'xxxxxxxxxx')
            assert.notInclude(completedPayloadJson, 'yyyyyyyyyy')
          }
        }
      }),
  )

  it.effect(
    'uses projection_threads.latest_turn_id for targeted thread queries and bulk snapshots',
    () =>
      Effect.gen(function* ()
      {
        const snapshotQuery = yield* ProjectionSnapshotQuery
        const sql = yield* SqlClient.SqlClient

        yield* clearProjectionTables(sql)

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `

        yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `

        yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `

        const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make('thread-1'))
        assert.equal(threadShell._tag, 'Some')
        if (threadShell._tag === 'Some')
        {
          assert.equal(threadShell.value.latestTurn?.turnId, asTurnId('turn-running'))
          assert.equal(threadShell.value.latestTurn?.state, 'running')
          assert.equal(threadShell.value.latestTurn?.startedAt, '2026-04-03T00:00:30.000Z')
        }

        const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make('thread-1'))
        assert.equal(threadDetail._tag, 'Some')
        if (threadDetail._tag === 'Some')
        {
          assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId('turn-running'))
          assert.equal(threadDetail.value.latestTurn?.state, 'running')
          assert.equal(threadDetail.value.latestTurn?.startedAt, '2026-04-03T00:00:30.000Z')
        }

        const commandReadModel = yield* snapshotQuery.getCommandReadModel()
        assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId('turn-running'))
        assert.equal(commandReadModel.threads[0]?.latestTurn?.state, 'running')

        const shellSnapshot = yield* snapshotQuery.getShellSnapshot()
        assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId('turn-running'))
        assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, 'running')

        const fullSnapshot = yield* snapshotQuery.getSnapshot()
        assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId('turn-running'))
        assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, 'running')
      }),
  )

  it.effect('keeps deleted project and thread tombstones in the command read model', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `

      const commandReadModel = yield* snapshotQuery.getCommandReadModel()
      assert.equal(commandReadModel.projects[0]?.id, asProjectId('project-deleted'))
      assert.equal(commandReadModel.projects[0]?.deletedAt, '2026-04-05T00:00:02.000Z')
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make('thread-deleted'))
      assert.equal(commandReadModel.threads[0]?.deletedAt, '2026-04-05T00:00:05.000Z')
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId('turn-deleted'))
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, 'completed')

      const fullSnapshot = yield* snapshotQuery.getSnapshot()
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make('thread-deleted'))
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId('turn-deleted'))
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, 'completed')

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot()
      assert.equal(shellSnapshot.projects.length, 0)
      assert.equal(shellSnapshot.threads.length, 0)
    }),
  )

  it.effect('restores blocking request activities for command decisions after restart', () =>
    Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-blocking-restart',
          'Blocking Restart',
          '/tmp/blocking-restart',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-07-26T00:00:00.000Z',
          '2026-07-26T00:00:01.000Z',
          NULL
        )
      `

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-open-approval',
            'project-blocking-restart',
            'Open approval',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            1,
            0,
            0,
            '2026-07-26T00:00:02.000Z',
            '2026-07-26T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-open-input',
            'project-blocking-restart',
            'Open user input',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            1,
            0,
            '2026-07-26T00:00:04.000Z',
            '2026-07-26T00:00:05.000Z',
            NULL,
            NULL
          ),
          (
            'thread-stale-cleared',
            'project-blocking-restart',
            'Stale request cleared',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-07-26T00:00:06.000Z',
            '2026-07-26T00:00:07.000Z',
            NULL,
            NULL
          ),
          (
            'thread-old-request-pruned',
            'project-blocking-restart',
            'Old request pruned',
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-07-26T00:00:08.000Z',
            '2026-07-26T00:00:09.000Z',
            NULL,
            NULL
          )
      `

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-import-marker',
            'thread-open-approval',
            NULL,
            'info',
            'task.completed',
            'Continuation marker',
            '{"type":"import.continuation","driverKind":"codex","continuation":{"state":"history-only","providerInstanceId":"codex","reason":"history only"}}',
            0,
            '2026-07-26T00:00:02.100Z'
          ),
          (
            'activity-approval-request',
            'thread-open-approval',
            NULL,
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-open"}',
            1,
            '2026-07-26T00:00:02.200Z'
          ),
          (
            'activity-input-request',
            'thread-open-input',
            NULL,
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-open"}',
            0,
            '2026-07-26T00:00:04.100Z'
          ),
          (
            'activity-stale-request',
            'thread-stale-cleared',
            NULL,
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-stale"}',
            0,
            '2026-07-26T00:00:06.100Z'
          ),
          (
            'activity-stale-failure',
            'thread-stale-cleared',
            NULL,
            'error',
            'provider.approval.respond.failed',
            'Approval response failed',
            '{"requestId":"approval-stale","detail":"Stale pending approval request: approval-stale"}',
            1,
            '2026-07-26T00:00:06.200Z'
          )
      `

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-pruned-import-marker',
            'thread-old-request-pruned',
            NULL,
            'info',
            'task.completed',
            'Continuation marker',
            '{"type":"import.continuation","driverKind":"codex","continuation":{"state":"history-only","providerInstanceId":"codex","reason":"history only"}}',
            0,
            '2026-07-26T00:00:08.050Z'
          ),
          (
            'activity-pruned-request',
            'thread-old-request-pruned',
            NULL,
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-pruned"}',
            0,
            '2026-07-26T00:00:08.100Z'
          )
      `
      yield* sql`
        WITH RECURSIVE activity_numbers(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1
          FROM activity_numbers
          WHERE value < 500
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          'activity-pruned-note-' || printf('%03d', value),
          'thread-old-request-pruned',
          NULL,
          'info',
          'runtime.note',
          'Later activity',
          '{}',
          value,
          printf('2026-07-26T00:%02d:%02d.000Z', value / 60, value % 60)
        FROM activity_numbers
      `

      const readModel = yield* snapshotQuery.getCommandReadModel()
      const approvalThread = readModel.threads.find(
        (thread) => thread.id === ThreadId.make('thread-open-approval'),
      )
      const inputThread = readModel.threads.find(
        (thread) => thread.id === ThreadId.make('thread-open-input'),
      )
      const clearedThread = readModel.threads.find(
        (thread) => thread.id === ThreadId.make('thread-stale-cleared'),
      )
      const prunedThread = readModel.threads.find(
        (thread) => thread.id === ThreadId.make('thread-old-request-pruned'),
      )
      assert.deepEqual(
        approvalThread?.activities.map((activity) => activity.id),
        [asEventId('activity-import-marker'), asEventId('activity-approval-request')],
      )
      assert.deepEqual(
        inputThread?.activities.map((activity) => activity.id),
        [asEventId('activity-input-request')],
      )
      assert.deepEqual(
        clearedThread?.activities.map((activity) => activity.id),
        [asEventId('activity-stale-request'), asEventId('activity-stale-failure')],
      )
      assert.deepEqual(
        prunedThread?.activities.map((activity) => activity.id),
        [asEventId('activity-pruned-import-marker')],
      )

      const settleError = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.settle',
          commandId: CommandId.make('cmd-settle-after-restart'),
          threadId: ThreadId.make('thread-open-approval'),
        },
        readModel,
      }).pipe(Effect.flip)
      assert.equal(settleError._tag, 'OrchestrationCommandInvariantError')

      const snoozeError = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.snooze',
          commandId: CommandId.make('cmd-snooze-after-restart'),
          threadId: ThreadId.make('thread-open-input'),
          snoozedUntil: '2099-01-01T00:00:00.000Z',
        },
        readModel,
      }).pipe(Effect.flip)
      assert.equal(snoozeError._tag, 'OrchestrationCommandInvariantError')

      const clearedDecision = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.settle',
          commandId: CommandId.make('cmd-settle-cleared-after-restart'),
          threadId: ThreadId.make('thread-stale-cleared'),
        },
        readModel,
      })
      const clearedEvents = Array.isArray(clearedDecision) ? clearedDecision : [clearedDecision]
      assert.equal(clearedEvents[0]?.type, 'thread.settled')

      const prunedDecision = yield* decideOrchestrationCommand({
        command: {
          type: 'thread.settle',
          commandId: CommandId.make('cmd-settle-pruned-after-restart'),
          threadId: ThreadId.make('thread-old-request-pruned'),
        },
        readModel,
      })
      const prunedEvents = Array.isArray(prunedDecision) ? prunedDecision : [prunedDecision]
      assert.equal(prunedEvents[0]?.type, 'thread.settled')
    }),
  )

  it.effect('upgrades existing activities and uses bounded command read-model indexes', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)
      yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_command_window`
      yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_command_relevant`
      yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_import_continuation`
      yield* sql`
        WITH RECURSIVE activity_numbers(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1
          FROM activity_numbers
          WHERE value < 1000
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          'activity-upgrade-bulk-' || printf('%04d', value),
          'thread-upgrade',
          NULL,
          'info',
          'runtime.note',
          'Imported history',
          '{}',
          value,
          printf('2026-07-26T00:%02d:%02d.000Z', value / 60, value % 60)
        FROM activity_numbers
      `
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-upgrade-request',
            'thread-upgrade',
            NULL,
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-upgrade"}',
            1001,
            '2026-07-26T01:00:01.000Z'
          ),
          (
            'activity-upgrade-marker',
            'thread-upgrade',
            NULL,
            'info',
            'task.completed',
            'Continuation marker',
            '{"type":"import.continuation"}',
            1002,
            '2026-07-26T01:00:02.000Z'
          )
      `

      yield* ProjectionThreadCommandActivityIndexesMigration
      yield* HealOrchestratePlanRespondFailureMigration

      const retainedRows = yield* sql.unsafe<{ readonly activityId: string }>(
        COMMAND_THREAD_ACTIVITY_QUERY_SQL,
      )
      assert.deepEqual(
        retainedRows.map((row) => row.activityId),
        ['activity-upgrade-request', 'activity-upgrade-marker'],
      )

      const planRows = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${COMMAND_THREAD_ACTIVITY_QUERY_SQL}`,
      )
      const plan = planRows.map((row) => row.detail).join('\n')

      assert.match(
        plan,
        /SCAN activity USING INDEX idx_projection_thread_activities_command_relevant/u,
      )
      assert.match(
        plan,
        /SEARCH recent USING INDEX idx_projection_thread_activities_command_window \(thread_id=\?\)/u,
      )
      assert.match(
        plan,
        /SCAN marker USING INDEX idx_projection_thread_activities_import_continuation/u,
      )
      assert.match(
        plan,
        /SEARCH latest_marker USING INDEX idx_projection_thread_activities_import_continuation \(thread_id=\?\)/u,
      )
      assert.equal(
        planRows.filter((row) => row.detail === 'USE TEMP B-TREE FOR ORDER BY').length,
        1,
      )
    }),
  )

  it.effect('matches canonical retention across out-of-order inserts and upserts', () =>
    Effect.gen(function* ()
    {
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-canonical-approval',
            'thread-canonical-window',
            NULL,
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-canonical"}',
            501,
            '2026-07-26T01:00:01.000Z'
          ),
          (
            'activity-canonical-marker-latest',
            'thread-canonical-window',
            NULL,
            'info',
            'task.completed',
            'Latest continuation marker',
            '{"type":"import.continuation"}',
            600,
            '2026-07-26T01:00:02.000Z'
          )
      `
      yield* sql`
        WITH RECURSIVE activity_numbers(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1
          FROM activity_numbers
          WHERE value < 500
        )
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        SELECT
          'activity-canonical-note-' || printf('%03d', value),
          'thread-canonical-window',
          NULL,
          'info',
          'runtime.note',
          'Imported history',
          '{}',
          value,
          printf('2026-07-26T00:%02d:%02d.000Z', value / 60, value % 60)
        FROM activity_numbers
        ORDER BY value DESC
      `
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-canonical-marker-old',
          'thread-canonical-window',
          NULL,
          'info',
          'task.completed',
          'Older continuation marker',
          '{"type":"import.continuation"}',
          599,
          '2026-07-26T01:00:03.000Z'
        )
      `

      const initialRows = yield* sql.unsafe<{ readonly activityId: string }>(
        COMMAND_THREAD_ACTIVITY_QUERY_SQL,
      )
      assert.deepEqual(
        initialRows.map((row) => row.activityId),
        ['activity-canonical-approval', 'activity-canonical-marker-latest'],
      )

      const rowIdsBefore = yield* sql<{
        readonly activityId: string
        readonly rowId: number
      }>`
        SELECT activity_id AS "activityId", rowid AS "rowId"
        FROM projection_thread_activities
        WHERE activity_id IN (
          'activity-canonical-approval',
          'activity-canonical-marker-latest'
        )
        ORDER BY activity_id
      `
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-canonical-approval',
            'thread-canonical-window',
            NULL,
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-canonical"}',
            0,
            '2026-07-26T01:00:01.000Z'
          ),
          (
            'activity-canonical-marker-latest',
            'thread-canonical-window',
            NULL,
            'info',
            'task.completed',
            'Latest continuation marker',
            '{"type":"import.continuation"}',
            598,
            '2026-07-26T01:00:02.000Z'
          )
        ON CONFLICT (activity_id)
        DO UPDATE SET sequence = excluded.sequence
      `
      const rowIdsAfter = yield* sql<{
        readonly activityId: string
        readonly rowId: number
      }>`
        SELECT activity_id AS "activityId", rowid AS "rowId"
        FROM projection_thread_activities
        WHERE activity_id IN (
          'activity-canonical-approval',
          'activity-canonical-marker-latest'
        )
        ORDER BY activity_id
      `
      assert.deepEqual(rowIdsAfter, rowIdsBefore)

      const updatedRows = yield* sql.unsafe<{ readonly activityId: string }>(
        COMMAND_THREAD_ACTIVITY_QUERY_SQL,
      )
      assert.deepEqual(
        updatedRows.map((row) => row.activityId),
        ['activity-canonical-marker-old'],
      )
    }),
  )
})

it.effect(
  'ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots',
  () =>
  {
    const resolveCalls: string[] = []
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() =>
            {
              resolveCalls.push(cwd)
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: 'git-remote' as const,
                  remoteName: 'origin',
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              }
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    )

    return Effect.gen(function* ()
    {
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const sql = yield* SqlClient.SqlClient

      yield* clearProjectionTables(sql)

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            NULL
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot()
      assert.deepStrictEqual(resolveCalls.toSorted(), ['/tmp/shared-root'])
      assert.equal(shellSnapshot.projects.length, 2)
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, '/tmp/shared-root')
      assert.equal(shellSnapshot.projects[1]?.repositoryIdentity?.rootPath, '/tmp/shared-root')

      resolveCalls.length = 0

      const fullSnapshot = yield* snapshotQuery.getSnapshot()
      assert.deepStrictEqual(resolveCalls.toSorted(), ['/tmp/deleted-root', '/tmp/shared-root'])
      assert.equal(fullSnapshot.projects.length, 3)
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, '/tmp/deleted-root')
    }).pipe(Effect.provide(layer))
  },
)
