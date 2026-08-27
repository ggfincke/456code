// tests/apps/server/orchestration/Layers/ProjectionPipeline.test.ts
// verifies orchestration projection persistence

import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  type OrchestrateRunExecution,
} from '@t3tools/contracts'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'

import {
  ATTACHMENT_CLEANUP_GRACE,
  AttachmentCleanupReactorLive,
} from '../../../../../apps/server/src/orchestration/Layers/AttachmentCleanupReactor.ts'
import { AttachmentCleanupReactor } from '../../../../../apps/server/src/orchestration/Services/AttachmentCleanupReactor.ts'
import { CheckpointRevertOperationsLive } from '../../../../../apps/server/src/persistence/Layers/CheckpointRevertOperations.ts'
import { AttachmentLifecycleRepository } from '../../../../../apps/server/src/persistence/Services/AttachmentLifecycle.ts'
import { OrchestrationCommandReceiptRepositoryLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts'
import { OrchestrationEventStoreLive } from '../../../../../apps/server/src/persistence/Layers/OrchestrationEventStore.ts'
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from '../../../../../apps/server/src/persistence/Services/OrchestrationEventStore.ts'
import * as RepositoryIdentityResolver from '../../../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import { OrchestrationEngineLive } from '../../../../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts'
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from '../../../../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts'
import { OrchestrationProjectionSnapshotQueryLive } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts'
import { OrchestrationEngineService } from '../../../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { OrchestrationProjectionPipeline } from '../../../../../apps/server/src/orchestration/Services/ProjectionPipeline.ts'
import { ProjectionSnapshotQuery } from '../../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { ServerConfig } from '../../../../../apps/server/src/config.ts'
import { makeTestServerStorageLeaseLayer } from '../../support/serverStorageLease.ts'

const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString)

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  Layer.merge(OrchestrationProjectionPipelineLive, AttachmentCleanupReactorLive).pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  )

const exists = (filePath: string) =>
  Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath))
    return fileInfo._tag === 'Success'
  })

const stageOwnedAttachment = Effect.fn('stageOwnedAttachment')(function* (input: {
  readonly stagingKey: string
  readonly commandId: string
  readonly threadId: ThreadId
  readonly messageId: string
  readonly attachmentId: string
  readonly ownerSequence: number
  readonly now: string
})
{
  const repository = yield* AttachmentLifecycleRepository
  const relativePath = `${input.attachmentId}.png`
  yield* repository.stage({
    stagingKey: input.stagingKey,
    commandId: CommandId.make(input.commandId),
    threadId: input.threadId,
    messageId: MessageId.make(input.messageId),
    attachmentIndex: 0,
    attachmentId: input.attachmentId,
    stagingRelativePath: `.staging/${input.stagingKey}/${relativePath}`,
    relativePath,
    mimeType: 'image/png',
    byteCount: 5,
    contentDigest: input.stagingKey,
    now: input.now,
  })
  yield* repository.associateAccepted({
    commandId: CommandId.make(input.commandId),
    ownerSequence: input.ownerSequence,
    ownerEventType: 'thread.message-sent',
    now: input.now,
  })
})

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-run-execution-jobs-')))(
  'OrchestrationProjectionPipeline run execution jobs',
  (it) =>
  {
    it.effect('accepts exact job replay and rejects conflicting immutable binding', () =>
      Effect.gen(function* ()
      {
        const projectionPipeline = yield* OrchestrationProjectionPipeline
        const eventStore = yield* OrchestrationEventStore
        const sql = yield* SqlClient.SqlClient
        const threadId = ThreadId.make('thread-run-execution-jobs')
        const sourceTurnId = TurnId.make('turn-run-execution-jobs')
        const now = '2026-08-09T02:00:00.000Z'
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))
        const makeExecution = (
          runId: string,
          planRevision: number,
          jobs: OrchestrateRunExecution['jobs'] = [],
        ): OrchestrateRunExecution => ({
          threadId,
          runId,
          planRevision,
          sourceTurnId,
          sourceSequence: planRevision,
          repositoryRoot: '/repo',
          repositoryCommonDir: '/repo/.git',
          baseOid: 'base-oid',
          lifecycle: 'active',
          availability: jobs.length === 0 ? 'unavailable' : 'available',
          integrationRoot: jobs.length === 0 ? null : '/repo/worktrees/run',
          integrationCommonDir: jobs.length === 0 ? null : '/repo/.git',
          integrationBranch: jobs.length === 0 ? null : 'run-branch',
          integrationOid: jobs.length === 0 ? null : 'head-oid',
          observedHeadOid: jobs.length === 0 ? null : 'head-oid',
          finalHeadOid: null,
          closeReason: null,
          current: true,
          admittedAt: now,
          updatedAt: now,
          terminalAt: null,
          jobs,
        })
        const job = {
          jobId: 'job-exact-binding',
          status: 'completed' as const,
          requestRunId: 'run-1',
          requestRepositoryRoot: '/repo',
          resultRepositoryRoot: '/repo/worktrees/run',
          repositoryCommonDir: '/repo/.git',
          baseOid: 'base-oid',
          headOid: 'head-oid',
          worktreeRoot: '/repo/worktrees/run',
          branch: 'run-branch',
          boundAt: now,
        }
        const first = makeExecution('run-1', 1)
        const bound = makeExecution('run-1', 1, [job])

        yield* appendAndProject({
          type: 'thread.orchestrate-run-execution-admitted',
          eventId: EventId.make('evt-run-execution-admit-1'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make('cmd-run-execution-admit-1'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-run-execution-admit-1'),
          metadata: {},
          payload: { execution: first },
        })
        for (const suffix of ['first', 'replay'] as const)
        {
          yield* appendAndProject({
            type: 'thread.orchestrate-run-execution-updated',
            eventId: EventId.make(`evt-run-execution-update-${suffix}`),
            aggregateKind: 'thread',
            aggregateId: threadId,
            occurredAt: now,
            commandId: CommandId.make(`cmd-run-execution-update-${suffix}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-run-execution-update-${suffix}`),
            metadata: {},
            payload: { execution: bound },
          })
        }

        const second = makeExecution('run-2', 1)
        yield* appendAndProject({
          type: 'thread.orchestrate-run-execution-admitted',
          eventId: EventId.make('evt-run-execution-admit-2'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make('cmd-run-execution-admit-2'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-run-execution-admit-2'),
          metadata: {},
          payload: { execution: second },
        })
        const conflict = yield* appendAndProject({
          type: 'thread.orchestrate-run-execution-updated',
          eventId: EventId.make('evt-run-execution-conflict'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make('cmd-run-execution-conflict'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-run-execution-conflict'),
          metadata: {},
          payload: {
            execution: makeExecution('run-2', 1, [
              { ...job, requestRunId: 'run-2', boundAt: '2026-08-09T02:01:00.000Z' },
            ]),
          },
        }).pipe(Effect.result)
        assert.strictEqual(conflict._tag, 'Failure')

        const bindings = yield* sql<{
          readonly jobId: string
          readonly runId: string
          readonly boundAt: string
        }>`
          SELECT job_id AS "jobId", run_id AS "runId", bound_at AS "boundAt"
          FROM projection_orchestrate_execution_jobs
        `
        assert.deepEqual(bindings, [{ jobId: 'job-exact-binding', runId: 'run-1', boundAt: now }])
      }),
    )
  },
)

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer('t3-projection-pipeline-test-')

it.layer(BaseTestLayer)('OrchestrationProjectionPipeline', (it) =>
{
  it.effect('bootstraps all projection states and writes projection rows', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const now = '2026-01-01T00:00:00.000Z'

      yield* eventStore.append({
        type: 'project.created',
        eventId: EventId.make('evt-1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-1'),
        occurredAt: now,
        commandId: CommandId.make('cmd-1'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-1'),
          title: 'Project 1',
          workspaceRoot: '/tmp/project-1',
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.created',
        eventId: EventId.make('evt-2'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        occurredAt: now,
        commandId: CommandId.make('cmd-2'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-2'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-1'),
          projectId: ProjectId.make('project-1'),
          title: 'Thread 1',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-3'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        occurredAt: now,
        commandId: CommandId.make('cmd-3'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-3'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-1'),
          messageId: MessageId.make('message-1'),
          role: 'assistant',
          text: 'hello',
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* projectionPipeline.bootstrap

      const projectRows = yield* sql<{
        readonly projectId: string
        readonly title: string
        readonly scriptsJson: string
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `
      assert.deepEqual(projectRows, [
        { projectId: 'project-1', title: 'Project 1', scriptsJson: '[]' },
      ])

      const messageRows = yield* sql<{
        readonly messageId: string
        readonly text: string
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `
      assert.deepEqual(messageRows, [{ messageId: 'message-1', text: 'hello' }])

      const stateRows = yield* sql<{
        readonly projector: string
        readonly lastAppliedSequence: number
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length)
      for (const row of stateRows)
      {
        assert.equal(row.lastAppliedSequence, 3)
      }

      yield* sql`CREATE TABLE thread_shell_updates (count INTEGER NOT NULL)`
      yield* sql`INSERT INTO thread_shell_updates (count) VALUES (0)`
      yield* sql`
        CREATE TRIGGER count_thread_shell_updates
        AFTER UPDATE ON projection_threads
        WHEN NEW.thread_id = 'thread-1'
        BEGIN
          UPDATE thread_shell_updates SET count = count + 1;
        END;
      `

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-assistant-update'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        occurredAt: '2026-01-01T00:00:00.100Z',
        commandId: CommandId.make('cmd-assistant-update'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-assistant-update'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-1'),
          messageId: MessageId.make('message-2'),
          role: 'assistant',
          text: 'more work',
          turnId: null,
          streaming: false,
          createdAt: '2026-01-01T00:00:00.100Z',
          updatedAt: '2026-01-01T00:00:00.100Z',
        },
      })
      yield* projectionPipeline.bootstrap

      let threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `
      assert.deepEqual(threadShellUpdates, [{ count: 1 }])

      yield* sql`UPDATE thread_shell_updates SET count = 0`
      yield* eventStore.append({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-routine-activity'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        occurredAt: '2026-01-01T00:00:00.200Z',
        commandId: CommandId.make('cmd-routine-activity'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-routine-activity'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-1'),
          activity: {
            id: EventId.make('activity-routine'),
            tone: 'tool',
            kind: 'tool.updated',
            summary: 'Tool made progress',
            payload: {},
            turnId: null,
            createdAt: '2026-01-01T00:00:00.200Z',
          },
        },
      })
      yield* projectionPipeline.bootstrap

      threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `
      assert.deepEqual(threadShellUpdates, [{ count: 1 }])

      yield* sql`UPDATE thread_shell_updates SET count = 0`
      yield* eventStore.append({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-summary-activity'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        occurredAt: '2026-01-01T00:00:00.300Z',
        commandId: CommandId.make('cmd-summary-activity'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-summary-activity'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-1'),
          activity: {
            id: EventId.make('activity-summary'),
            tone: 'approval',
            kind: 'approval.requested',
            summary: 'Command approval requested',
            payload: { requestId: 'approval-request-1', requestKind: 'command' },
            turnId: null,
            createdAt: '2026-01-01T00:00:00.300Z',
          },
        },
      })
      yield* projectionPipeline.bootstrap

      threadShellUpdates = yield* sql<{ readonly count: number }>`
        SELECT count FROM thread_shell_updates
      `
      assert.deepEqual(threadShellUpdates, [{ count: 2 }])
      yield* sql`DROP TRIGGER count_thread_shell_updates`
      yield* sql`DROP TABLE thread_shell_updates`

      // settled lifecycle through the DB pipeline: thread.settled writes the
      // override + timestamp, thread.unsettled(user) flips to the active pin.
      yield* eventStore.append({
        type: 'thread.settled',
        eventId: EventId.make('evt-settle-1'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        occurredAt: '2026-01-01T00:00:01.000Z',
        commandId: CommandId.make('cmd-settle-1'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-settle-1'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-1'),
          settledAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
      })
      yield* projectionPipeline.bootstrap

      const settledRows = yield* sql<{
        readonly settledOverride: string | null
        readonly settledAt: string | null
        readonly unsettledAt: string | null
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `
      assert.deepEqual(settledRows, [
        {
          settledOverride: 'settled',
          settledAt: '2026-01-01T00:00:01.000Z',
          unsettledAt: null,
        },
      ])

      yield* eventStore.append({
        type: 'thread.unsettled',
        eventId: EventId.make('evt-unsettle-1'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-1'),
        occurredAt: '2026-01-01T00:00:02.000Z',
        commandId: CommandId.make('cmd-unsettle-1'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-unsettle-1'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-1'),
          reason: 'user',
          updatedAt: '2026-01-01T00:00:02.000Z',
        },
      })
      yield* projectionPipeline.bootstrap

      const unsettledRows = yield* sql<{
        readonly settledOverride: string | null
        readonly settledAt: string | null
        readonly unsettledAt: string | null
      }>`
        SELECT
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `
      assert.deepEqual(unsettledRows, [
        {
          settledOverride: 'active',
          settledAt: null,
          unsettledAt: '2026-01-01T00:00:02.000Z',
        },
      ])
    }),
  )

  it.effect('upserts replacement worker verdict activities during projection replay', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const now = '2026-08-06T12:00:00.000Z'
      const threadId = ThreadId.make('thread-worker-verdict-upsert')
      const activityId = EventId.make('worker-verdict:run-1:job-1')

      yield* eventStore.append({
        type: 'project.created',
        eventId: EventId.make('event-worker-verdict-upsert-project'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-worker-verdict-upsert'),
        occurredAt: now,
        commandId: CommandId.make('command-worker-verdict-upsert-project'),
        causationEventId: null,
        correlationId: CorrelationId.make('command-worker-verdict-upsert-project'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-worker-verdict-upsert'),
          title: 'Worker verdict projection',
          workspaceRoot: '/tmp/worker-verdict-upsert',
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      })
      yield* eventStore.append({
        type: 'thread.created',
        eventId: EventId.make('event-worker-verdict-upsert-thread'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('command-worker-verdict-upsert-thread'),
        causationEventId: null,
        correlationId: CorrelationId.make('command-worker-verdict-upsert-thread'),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make('project-worker-verdict-upsert'),
          title: 'Thread',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5.6',
          },
          runtimeMode: 'full-access',
          interactionMode: 'default',
          branch: null,
          worktreePath: null,
          origin: null,
          createdAt: now,
          updatedAt: now,
        },
      })
      for (const [index, verdict] of ['needs changes', 'approved'].entries())
      {
        yield* eventStore.append({
          type: 'thread.activity-appended',
          eventId: EventId.make(`event-worker-verdict-upsert-${index}`),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: `2026-08-06T12:00:0${index + 1}.000Z`,
          commandId: CommandId.make(`command-worker-verdict-upsert-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`command-worker-verdict-upsert-${index}`),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: activityId,
              tone: 'info',
              kind: 'orchestrate.worker.verdict',
              summary: 'Worker verdict',
              payload: { runId: 'run-1', jobId: 'job-1', verdict },
              turnId: null,
              createdAt: `2026-08-06T12:00:0${index + 1}.000Z`,
            },
          },
        })
      }

      yield* projectionPipeline.bootstrap

      const rows = yield* sql<{
        readonly activityId: string
        readonly payloadJson: string
        readonly turnId: string | null
      }>`
        SELECT
          activity_id AS "activityId",
          payload_json AS "payloadJson",
          turn_id AS "turnId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `
      assert.deepEqual(rows, [
        {
          activityId,
          payloadJson: encodeUnknownJsonString({
            runId: 'run-1',
            jobId: 'job-1',
            verdict: 'approved',
          }),
          turnId: null,
        },
      ])
    }),
  )
})

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-projection-attachments-safe-')))(
  'OrchestrationProjectionPipeline',
  (it) =>
  {
    it.effect('preserves mixed image attachment metadata as-is', () =>
      Effect.gen(function* ()
      {
        const projectionPipeline = yield* OrchestrationProjectionPipeline
        const eventStore = yield* OrchestrationEventStore
        const sql = yield* SqlClient.SqlClient
        const now = '2026-01-01T00:00:00.000Z'

        yield* eventStore.append({
          type: 'thread.message-sent',
          eventId: EventId.make('evt-attachments-safe'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-attachments-safe'),
          occurredAt: now,
          commandId: CommandId.make('cmd-attachments-safe'),
          causationEventId: null,
          correlationId: CommandId.make('cmd-attachments-safe'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-attachments-safe'),
            messageId: MessageId.make('message-attachments-safe'),
            role: 'user',
            text: 'Inspect this',
            attachments: [
              {
                type: 'image',
                id: 'thread-attachments-safe-att-1',
                name: 'untrusted.exe',
                mimeType: 'image/x-unknown',
                sizeBytes: 5,
              },
              {
                type: 'image',
                id: 'thread-attachments-safe-att-2',
                name: 'not-image.png',
                mimeType: 'image/png',
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        })

        yield* projectionPipeline.bootstrap

        const rows = yield* sql<{
          readonly attachmentsJson: string | null
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `
        assert.equal(rows.length, 1)
        assert.deepEqual(decodeUnknownJsonString(rows[0]?.attachmentsJson ?? 'null'), [
          {
            type: 'image',
            id: 'thread-attachments-safe-att-1',
            name: 'untrusted.exe',
            mimeType: 'image/x-unknown',
            sizeBytes: 5,
          },
          {
            type: 'image',
            id: 'thread-attachments-safe-att-2',
            name: 'not-image.png',
            mimeType: 'image/png',
            sizeBytes: 5,
          },
        ])
      }),
    )
  },
)

it.layer(BaseTestLayer)('OrchestrationProjectionPipeline', (it) =>
{
  it.effect(
    'passes explicit empty attachment arrays through the projection pipeline to clear attachments',
    () =>
      Effect.gen(function* ()
      {
        const projectionPipeline = yield* OrchestrationProjectionPipeline
        const eventStore = yield* OrchestrationEventStore
        const sql = yield* SqlClient.SqlClient
        const now = '2026-01-01T00:00:00.000Z'
        const later = '2026-01-01T00:00:01.000Z'

        yield* eventStore.append({
          type: 'project.created',
          eventId: EventId.make('evt-clear-attachments-1'),
          aggregateKind: 'project',
          aggregateId: ProjectId.make('project-clear-attachments'),
          occurredAt: now,
          commandId: CommandId.make('cmd-clear-attachments-1'),
          causationEventId: null,
          correlationId: CommandId.make('cmd-clear-attachments-1'),
          metadata: {},
          payload: {
            projectId: ProjectId.make('project-clear-attachments'),
            title: 'Project Clear Attachments',
            workspaceRoot: '/tmp/project-clear-attachments',
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        })

        yield* eventStore.append({
          type: 'thread.created',
          eventId: EventId.make('evt-clear-attachments-2'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-clear-attachments'),
          occurredAt: now,
          commandId: CommandId.make('cmd-clear-attachments-2'),
          causationEventId: null,
          correlationId: CommandId.make('cmd-clear-attachments-2'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-clear-attachments'),
            projectId: ProjectId.make('project-clear-attachments'),
            title: 'Thread Clear Attachments',
            modelSelection: {
              instanceId: ProviderInstanceId.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        })

        yield* eventStore.append({
          type: 'thread.message-sent',
          eventId: EventId.make('evt-clear-attachments-3'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-clear-attachments'),
          occurredAt: now,
          commandId: CommandId.make('cmd-clear-attachments-3'),
          causationEventId: null,
          correlationId: CommandId.make('cmd-clear-attachments-3'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-clear-attachments'),
            messageId: MessageId.make('message-clear-attachments'),
            role: 'user',
            text: 'Has attachments',
            attachments: [
              {
                type: 'image',
                id: 'thread-clear-attachments-att-1',
                name: 'clear.png',
                mimeType: 'image/png',
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        })

        yield* eventStore.append({
          type: 'thread.message-sent',
          eventId: EventId.make('evt-clear-attachments-4'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-clear-attachments'),
          occurredAt: later,
          commandId: CommandId.make('cmd-clear-attachments-4'),
          causationEventId: null,
          correlationId: CommandId.make('cmd-clear-attachments-4'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-clear-attachments'),
            messageId: MessageId.make('message-clear-attachments'),
            role: 'user',
            text: '',
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        })

        yield* projectionPipeline.bootstrap

        const rows = yield* sql<{
          readonly attachmentsJson: string | null
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `
        assert.equal(rows.length, 1)
        assert.deepEqual(decodeUnknownJsonString(rows[0]?.attachmentsJson ?? 'null'), [])
      }),
  )
})

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-projection-attachments-overwrite-')),
)('OrchestrationProjectionPipeline', (it) =>
{
  it.effect('overwrites stored attachment references when a message updates attachments', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const now = '2026-01-01T00:00:00.000Z'
      const later = '2026-01-01T00:00:01.000Z'

      yield* eventStore.append({
        type: 'project.created',
        eventId: EventId.make('evt-overwrite-1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-overwrite'),
        occurredAt: now,
        commandId: CommandId.make('cmd-overwrite-1'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-overwrite-1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-overwrite'),
          title: 'Project Overwrite',
          workspaceRoot: '/tmp/project-overwrite',
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.created',
        eventId: EventId.make('evt-overwrite-2'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-overwrite'),
        occurredAt: now,
        commandId: CommandId.make('cmd-overwrite-2'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-overwrite-2'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-overwrite'),
          projectId: ProjectId.make('project-overwrite'),
          title: 'Thread Overwrite',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-overwrite-3'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-overwrite'),
        occurredAt: now,
        commandId: CommandId.make('cmd-overwrite-3'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-overwrite-3'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-overwrite'),
          messageId: MessageId.make('message-overwrite'),
          role: 'user',
          text: 'first image',
          attachments: [
            {
              type: 'image',
              id: 'thread-overwrite-att-1',
              name: 'file.png',
              mimeType: 'image/png',
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-overwrite-4'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-overwrite'),
        occurredAt: later,
        commandId: CommandId.make('cmd-overwrite-4'),
        causationEventId: null,
        correlationId: CommandId.make('cmd-overwrite-4'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-overwrite'),
          messageId: MessageId.make('message-overwrite'),
          role: 'user',
          text: '',
          attachments: [
            {
              type: 'image',
              id: 'thread-overwrite-att-2',
              name: 'file.png',
              mimeType: 'image/png',
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      })

      yield* projectionPipeline.bootstrap

      const rows = yield* sql<{
        readonly attachmentsJson: string | null
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `
      assert.equal(rows.length, 1)
      assert.deepEqual(decodeUnknownJsonString(rows[0]?.attachmentsJson ?? 'null'), [
        {
          type: 'image',
          id: 'thread-overwrite-att-2',
          name: 'file.png',
          mimeType: 'image/png',
          sizeBytes: 5,
        },
      ])
    }),
  )
})

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-projection-attachments-rollback-')),
)('OrchestrationProjectionPipeline', (it) =>
{
  it.effect('does not persist attachment files when projector transaction rolls back', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const path = yield* Path.Path
      const sql = yield* SqlClient.SqlClient
      const now = '2026-01-01T00:00:00.000Z'

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      yield* appendAndProject({
        type: 'project.created',
        eventId: EventId.make('evt-rollback-1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-rollback'),
        occurredAt: now,
        commandId: CommandId.make('cmd-rollback-1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-rollback-1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-rollback'),
          title: 'Project Rollback',
          workspaceRoot: '/tmp/project-rollback',
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* appendAndProject({
        type: 'thread.created',
        eventId: EventId.make('evt-rollback-2'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-rollback'),
        occurredAt: now,
        commandId: CommandId.make('cmd-rollback-2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-rollback-2'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-rollback'),
          projectId: ProjectId.make('project-rollback'),
          title: 'Thread Rollback',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `

      const result = yield* Effect.result(
        appendAndProject({
          type: 'thread.message-sent',
          eventId: EventId.make('evt-rollback-3'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-rollback'),
          occurredAt: now,
          commandId: CommandId.make('cmd-rollback-3'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-rollback-3'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-rollback'),
            messageId: MessageId.make('message-rollback'),
            role: 'user',
            text: 'Rollback me',
            attachments: [
              {
                type: 'image',
                id: 'thread-rollback-att-1',
                name: 'rollback.png',
                mimeType: 'image/png',
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      )
      assert.equal(result._tag, 'Failure')

      const rows = yield* sql<{
        readonly count: number
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `
      assert.equal(rows[0]?.count ?? 0, 0)

      const { attachmentsDir } = yield* ServerConfig
      const attachmentPath = path.join(attachmentsDir, 'thread-rollback-att-1.png')
      assert.isFalse(yield* exists(attachmentPath))
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`
    }),
  )
})

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-projection-attachments-overwrite-')),
)('OrchestrationProjectionPipeline', (it) =>
{
  it.effect('removes reverted attachment files after durable cleanup grace', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const cleanupReactor = yield* AttachmentCleanupReactor
      const eventStore = yield* OrchestrationEventStore
      const { attachmentsDir } = yield* ServerConfig
      const now = '2026-01-01T00:00:00.000Z'
      const threadId = ThreadId.make('Thread Revert.Files')
      const keepAttachmentId = 'thread-revert-files-00000000-0000-4000-8000-000000000001'
      const removeAttachmentId = 'thread-revert-files-00000000-0000-4000-8000-000000000002'
      const otherThreadAttachmentId =
        'thread-revert-files-extra-00000000-0000-4000-8000-000000000003'

      yield* stageOwnedAttachment({
        stagingKey: 'revert-keep-staging',
        commandId: 'cmd-revert-keep-staging',
        threadId,
        messageId: 'message-revert-keep-staging',
        attachmentId: keepAttachmentId,
        ownerSequence: 4,
        now,
      })
      yield* stageOwnedAttachment({
        stagingKey: 'revert-remove-staging',
        commandId: 'cmd-revert-remove-staging',
        threadId,
        messageId: 'message-revert-remove-staging',
        attachmentId: removeAttachmentId,
        ownerSequence: 6,
        now,
      })
      yield* stageOwnedAttachment({
        stagingKey: 'revert-other-staging',
        commandId: 'cmd-revert-other-staging',
        threadId: ThreadId.make('Thread Revert.Files.Extra'),
        messageId: 'message-revert-other-staging',
        attachmentId: otherThreadAttachmentId,
        ownerSequence: 1,
        now,
      })

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      yield* appendAndProject({
        type: 'project.created',
        eventId: EventId.make('evt-revert-files-1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-revert-files'),
        occurredAt: now,
        commandId: CommandId.make('cmd-revert-files-1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-files-1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-revert-files'),
          title: 'Project Revert Files',
          workspaceRoot: '/tmp/project-revert-files',
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* appendAndProject({
        type: 'thread.created',
        eventId: EventId.make('evt-revert-files-2'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('cmd-revert-files-2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-files-2'),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make('project-revert-files'),
          title: 'Thread Revert Files',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* appendAndProject({
        type: 'thread.turn-diff-completed',
        eventId: EventId.make('evt-revert-files-3'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('cmd-revert-files-3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-files-3'),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make('turn-keep'),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make('refs/t3/checkpoints/thread-revert-files/turn/1'),
          status: 'ready',
          files: [],
          assistantMessageId: MessageId.make('message-keep'),
          completedAt: now,
        },
      })

      yield* appendAndProject({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-revert-files-4'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('cmd-revert-files-4'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-files-4'),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make('message-keep'),
          role: 'assistant',
          text: 'Keep',
          attachments: [
            {
              type: 'image',
              id: keepAttachmentId,
              name: 'keep.png',
              mimeType: 'image/png',
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make('turn-keep'),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* appendAndProject({
        type: 'thread.turn-diff-completed',
        eventId: EventId.make('evt-revert-files-5'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('cmd-revert-files-5'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-files-5'),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make('turn-remove'),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make('refs/t3/checkpoints/thread-revert-files/turn/2'),
          status: 'ready',
          files: [],
          assistantMessageId: MessageId.make('message-remove'),
          completedAt: now,
        },
      })

      yield* appendAndProject({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-revert-files-6'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('cmd-revert-files-6'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-files-6'),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make('message-remove'),
          role: 'assistant',
          text: 'Remove',
          attachments: [
            {
              type: 'image',
              id: removeAttachmentId,
              name: 'remove.png',
              mimeType: 'image/png',
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.make('turn-remove'),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      })

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`)
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`)
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true })
      yield* fileSystem.writeFileString(keepPath, 'keep')
      yield* fileSystem.writeFileString(removePath, 'remove')
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`)
      yield* fileSystem.writeFileString(otherThreadPath, 'other')
      assert.isTrue(yield* exists(keepPath))
      assert.isTrue(yield* exists(removePath))
      assert.isTrue(yield* exists(otherThreadPath))

      yield* appendAndProject({
        type: 'thread.reverted',
        eventId: EventId.make('evt-revert-files-7'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('cmd-revert-files-7'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-files-7'),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      })

      assert.isTrue(yield* exists(keepPath))
      assert.isTrue(yield* exists(removePath))
      assert.isTrue(yield* exists(otherThreadPath))

      const graceExpiresAt = Date.parse(now) + Duration.toMillis(ATTACHMENT_CLEANUP_GRACE)
      yield* TestClock.setTime(graceExpiresAt - 1)
      yield* cleanupReactor.drain
      assert.isTrue(yield* exists(removePath))

      yield* TestClock.setTime(graceExpiresAt)
      yield* cleanupReactor.drain
      assert.isFalse(yield* exists(removePath))
      assert.isTrue(yield* exists(keepPath))
      assert.isTrue(yield* exists(otherThreadPath))
    }),
  )
})

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-projection-attachments-revert-')))(
  'OrchestrationProjectionPipeline',
  (it) =>
  {
    it.effect('removes deleted-thread attachments after durable cleanup grace', () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const projectionPipeline = yield* OrchestrationProjectionPipeline
        const cleanupReactor = yield* AttachmentCleanupReactor
        const eventStore = yield* OrchestrationEventStore
        const { attachmentsDir } = yield* ServerConfig
        const now = '2026-01-01T00:00:00.000Z'
        const threadId = ThreadId.make('Thread Delete.Files')
        const attachmentId = 'thread-delete-files-00000000-0000-4000-8000-000000000001'
        const otherThreadAttachmentId =
          'thread-delete-files-extra-00000000-0000-4000-8000-000000000002'

        yield* stageOwnedAttachment({
          stagingKey: 'delete-thread-staging',
          commandId: 'cmd-delete-thread-staging',
          threadId,
          messageId: 'message-delete-thread-staging',
          attachmentId,
          ownerSequence: 3,
          now,
        })
        yield* stageOwnedAttachment({
          stagingKey: 'delete-other-staging',
          commandId: 'cmd-delete-other-staging',
          threadId: ThreadId.make('Thread Delete.Files.Extra'),
          messageId: 'message-delete-other-staging',
          attachmentId: otherThreadAttachmentId,
          ownerSequence: 1,
          now,
        })

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

        yield* appendAndProject({
          type: 'project.created',
          eventId: EventId.make('evt-delete-files-1'),
          aggregateKind: 'project',
          aggregateId: ProjectId.make('project-delete-files'),
          occurredAt: now,
          commandId: CommandId.make('cmd-delete-files-1'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-delete-files-1'),
          metadata: {},
          payload: {
            projectId: ProjectId.make('project-delete-files'),
            title: 'Project Delete Files',
            workspaceRoot: '/tmp/project-delete-files',
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        })

        yield* appendAndProject({
          type: 'thread.created',
          eventId: EventId.make('evt-delete-files-2'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make('cmd-delete-files-2'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-delete-files-2'),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.make('project-delete-files'),
            title: 'Thread Delete Files',
            modelSelection: {
              instanceId: ProviderInstanceId.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        })

        yield* appendAndProject({
          type: 'thread.message-sent',
          eventId: EventId.make('evt-delete-files-3'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make('cmd-delete-files-3'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-delete-files-3'),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make('message-delete-files'),
            role: 'user',
            text: 'Delete',
            attachments: [
              {
                type: 'image',
                id: attachmentId,
                name: 'delete.png',
                mimeType: 'image/png',
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        })

        const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`)
        const otherThreadAttachmentPath = path.join(
          attachmentsDir,
          `${otherThreadAttachmentId}.png`,
        )
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true })
        yield* fileSystem.writeFileString(threadAttachmentPath, 'delete')
        yield* fileSystem.writeFileString(otherThreadAttachmentPath, 'other-thread')
        assert.isTrue(yield* exists(threadAttachmentPath))
        assert.isTrue(yield* exists(otherThreadAttachmentPath))

        yield* appendAndProject({
          type: 'thread.deleted',
          eventId: EventId.make('evt-delete-files-4'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.make('cmd-delete-files-4'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-delete-files-4'),
          metadata: {},
          payload: {
            threadId,
            deletedAt: now,
          },
        })

        assert.isTrue(yield* exists(threadAttachmentPath))
        assert.isTrue(yield* exists(otherThreadAttachmentPath))

        const graceExpiresAt = Date.parse(now) + Duration.toMillis(ATTACHMENT_CLEANUP_GRACE)
        yield* TestClock.setTime(graceExpiresAt - 1)
        yield* cleanupReactor.drain
        assert.isTrue(yield* exists(threadAttachmentPath))

        yield* TestClock.setTime(graceExpiresAt)
        yield* cleanupReactor.drain
        assert.isFalse(yield* exists(threadAttachmentPath))
        assert.isTrue(yield* exists(otherThreadAttachmentPath))
      }),
    )
  },
)

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-projection-attachments-delete-')))(
  'OrchestrationProjectionPipeline',
  (it) =>
  {
    it.effect('ignores unsafe thread ids for attachment cleanup paths', () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const projectionPipeline = yield* OrchestrationProjectionPipeline
        const eventStore = yield* OrchestrationEventStore
        const now = '2026-01-01T00:00:00.000Z'
        const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig
        const attachmentsSentinelPath = path.join(attachmentsRootDir, 'sentinel.txt')
        const stateDirSentinelPath = path.join(stateDir, 'state-sentinel.txt')
        yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true })
        yield* fileSystem.writeFileString(attachmentsSentinelPath, 'keep-attachments-root')
        yield* fileSystem.writeFileString(stateDirSentinelPath, 'keep-state-dir')

        yield* eventStore.append({
          type: 'thread.deleted',
          eventId: EventId.make('evt-unsafe-thread-delete'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('..'),
          occurredAt: now,
          commandId: CommandId.make('cmd-unsafe-thread-delete'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-unsafe-thread-delete'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('..'),
            deletedAt: now,
          },
        })

        yield* projectionPipeline.bootstrap

        assert.isTrue(yield* exists(attachmentsRootDir))
        assert.isTrue(yield* exists(attachmentsSentinelPath))
        assert.isTrue(yield* exists(stateDirSentinelPath))
      }),
    )
  },
)

it.layer(BaseTestLayer)('OrchestrationProjectionPipeline', (it) =>
{
  it.effect('resumes from projector last_applied_sequence without replaying older events', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const now = '2026-01-01T00:00:00.000Z'

      yield* eventStore.append({
        type: 'project.created',
        eventId: EventId.make('evt-a1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-a'),
        occurredAt: now,
        commandId: CommandId.make('cmd-a1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-a1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-a'),
          title: 'Project A',
          workspaceRoot: '/tmp/project-a',
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.created',
        eventId: EventId.make('evt-a2'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-a'),
        occurredAt: now,
        commandId: CommandId.make('cmd-a2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-a2'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-a'),
          projectId: ProjectId.make('project-a'),
          title: 'Thread A',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-a3'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-a'),
        occurredAt: now,
        commandId: CommandId.make('cmd-a3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-a3'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-a'),
          messageId: MessageId.make('message-a'),
          role: 'assistant',
          text: 'hello',
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* projectionPipeline.bootstrap

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-a4'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-a'),
        occurredAt: now,
        commandId: CommandId.make('cmd-a4'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-a4'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-a'),
          messageId: MessageId.make('message-a'),
          role: 'assistant',
          text: ' world',
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* projectionPipeline.bootstrap
      yield* projectionPipeline.bootstrap

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `
      assert.deepEqual(messageRows, [{ text: 'hello world' }])

      const stateRows = yield* sql<{
        readonly projector: string
        readonly lastAppliedSequence: number
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0
      for (const row of stateRows)
      {
        assert.equal(row.lastAppliedSequence, maxSequence)
      }
    }),
  )

  it.effect('keeps the turn running across interim assistant messages until the session ends', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const now = '2026-01-01T00:00:00.000Z'
      const threadId = ThreadId.make('thread-turn-lifecycle')
      const turnId = TurnId.make('turn-lifecycle-1')

      yield* eventStore.append({
        type: 'thread.created',
        eventId: EventId.make('evt-tl1'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('cmd-tl1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-tl1'),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make('project-turn-lifecycle'),
          title: 'Turn lifecycle',
          modelSelection: {
            instanceId: ProviderInstanceId.make('claude'),
            model: 'claude-opus',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.session-set',
        eventId: EventId.make('evt-tl2'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-01-01T00:00:01.000Z',
        commandId: CommandId.make('cmd-tl2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-tl2'),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: 'running',
            providerName: 'claude',
            runtimeMode: 'full-access',
            activeTurnId: turnId,
            lastError: null,
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
        },
      })

      // interim assistant message completes mid-turn (commentary between
      // tool calls) — the turn must stay running and unsettled.
      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-tl3'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-01-01T00:00:05.000Z',
        commandId: CommandId.make('cmd-tl3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-tl3'),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make('message-tl-interim'),
          role: 'assistant',
          text: 'interim commentary',
          turnId,
          streaming: false,
          createdAt: '2026-01-01T00:00:05.000Z',
          updatedAt: '2026-01-01T00:00:05.000Z',
        },
      })

      yield* projectionPipeline.bootstrap

      const runningRows = yield* sql<{
        readonly state: string
        readonly completedAt: string | null
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `
      assert.deepEqual(runningRows, [{ state: 'running', completedAt: null }])

      // the session leaving "running" is the turn-end signal.
      yield* eventStore.append({
        type: 'thread.session-set',
        eventId: EventId.make('evt-tl4'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-01-01T00:01:00.000Z',
        commandId: CommandId.make('cmd-tl4'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-tl4'),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: 'ready',
            providerName: 'claude',
            runtimeMode: 'full-access',
            activeTurnId: null,
            lastError: null,
            updatedAt: '2026-01-01T00:01:00.000Z',
          },
        },
      })

      yield* projectionPipeline.bootstrap

      const settledRows = yield* sql<{
        readonly state: string
        readonly completedAt: string | null
      }>`
        SELECT state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `
      assert.deepEqual(settledRows, [
        { state: 'completed', completedAt: '2026-01-01T00:01:00.000Z' },
      ])

      const threadRows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `
      assert.deepEqual(threadRows, [{ latestTurnId: turnId }])

      const staleErrorTurnId = TurnId.make('turn-stale-error')
      yield* eventStore.append({
        type: 'thread.session-set',
        eventId: EventId.make('evt-tl5'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-01-01T00:02:00.000Z',
        commandId: CommandId.make('cmd-tl5'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-tl5'),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: 'error',
            providerName: 'claude',
            runtimeMode: 'full-access',
            activeTurnId: staleErrorTurnId,
            lastError: 'stale runtime error',
            updatedAt: '2026-01-01T00:02:00.000Z',
          },
        },
      })
      yield* projectionPipeline.bootstrap

      const afterStaleErrorRows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `
      assert.deepEqual(afterStaleErrorRows, [{ latestTurnId: turnId }])
    }),
  )

  it.effect('settles a superseded running turn when a new turn becomes active', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const now = '2026-01-01T00:00:00.000Z'
      const threadId = ThreadId.make('thread-turn-supersede')
      const oldTurnId = TurnId.make('turn-superseded')
      const newTurnId = TurnId.make('turn-steer')

      yield* eventStore.append({
        type: 'thread.created',
        eventId: EventId.make('evt-ts1'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make('cmd-ts1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-ts1'),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make('project-turn-supersede'),
          title: 'Turn supersede',
          modelSelection: {
            instanceId: ProviderInstanceId.make('opencode'),
            model: 'big-pickle',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      const appendRunningSessionSet = (eventId: string, turnId: TurnId, updatedAt: string) =>
        eventStore.append({
          type: 'thread.session-set',
          eventId: EventId.make(eventId),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: updatedAt,
          commandId: CommandId.make(`cmd-${eventId}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-${eventId}`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status: 'running',
              providerName: 'opencode',
              runtimeMode: 'full-access',
              activeTurnId: turnId,
              lastError: null,
              updatedAt,
            },
          },
        })

      yield* appendRunningSessionSet('evt-ts2', oldTurnId, '2026-01-01T00:00:01.000Z')
      // a steer: a new turn becomes active without the provider ever
      // completing the previous one.
      yield* appendRunningSessionSet('evt-ts3', newTurnId, '2026-01-01T00:00:30.000Z')

      yield* projectionPipeline.bootstrap

      const rows = yield* sql<{
        readonly turnId: string
        readonly state: string
        readonly completedAt: string | null
      }>`
        SELECT turn_id AS "turnId", state, completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY requested_at
      `
      assert.deepEqual(rows, [
        { turnId: oldTurnId, state: 'completed', completedAt: '2026-01-01T00:00:30.000Z' },
        { turnId: newTurnId, state: 'running', completedAt: null },
      ])
    }),
  )

  it.effect('keeps accumulated assistant text when completion payload text is empty', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const now = '2026-01-01T00:00:00.000Z'

      yield* eventStore.append({
        type: 'project.created',
        eventId: EventId.make('evt-empty-1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-empty'),
        occurredAt: now,
        commandId: CommandId.make('cmd-empty-1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-empty-1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-empty'),
          title: 'Project Empty',
          workspaceRoot: '/tmp/project-empty',
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.created',
        eventId: EventId.make('evt-empty-2'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-empty'),
        occurredAt: now,
        commandId: CommandId.make('cmd-empty-2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-empty-2'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-empty'),
          projectId: ProjectId.make('project-empty'),
          title: 'Thread Empty',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-empty-3'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-empty'),
        occurredAt: now,
        commandId: CommandId.make('cmd-empty-3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-empty-3'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-empty'),
          messageId: MessageId.make('assistant-empty'),
          role: 'assistant',
          text: 'Hello',
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-empty-4'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-empty'),
        occurredAt: now,
        commandId: CommandId.make('cmd-empty-4'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-empty-4'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-empty'),
          messageId: MessageId.make('assistant-empty'),
          role: 'assistant',
          text: ' world',
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* eventStore.append({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-empty-5'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-empty'),
        occurredAt: now,
        commandId: CommandId.make('cmd-empty-5'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-empty-5'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-empty'),
          messageId: MessageId.make('assistant-empty'),
          role: 'assistant',
          text: '',
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      })

      yield* projectionPipeline.bootstrap

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `
      assert.equal(messageRows.length, 1)
      assert.equal(messageRows[0]?.text, 'Hello world')
      assert.isFalse(Boolean(messageRows[0]?.isStreaming))
    }),
  )

  it.effect(
    'resolves turn-count conflicts when checkpoint completion rewrites provisional turns',
    () =>
      Effect.gen(function* ()
      {
        const projectionPipeline = yield* OrchestrationProjectionPipeline
        const eventStore = yield* OrchestrationEventStore
        const sql = yield* SqlClient.SqlClient
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

        yield* appendAndProject({
          type: 'project.created',
          eventId: EventId.make('evt-conflict-1'),
          aggregateKind: 'project',
          aggregateId: ProjectId.make('project-conflict'),
          occurredAt: '2026-02-26T13:00:00.000Z',
          commandId: CommandId.make('cmd-conflict-1'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-conflict-1'),
          metadata: {},
          payload: {
            projectId: ProjectId.make('project-conflict'),
            title: 'Project Conflict',
            workspaceRoot: '/tmp/project-conflict',
            defaultModelSelection: null,
            scripts: [],
            createdAt: '2026-02-26T13:00:00.000Z',
            updatedAt: '2026-02-26T13:00:00.000Z',
          },
        })

        yield* appendAndProject({
          type: 'thread.created',
          eventId: EventId.make('evt-conflict-2'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-conflict'),
          occurredAt: '2026-02-26T13:00:01.000Z',
          commandId: CommandId.make('cmd-conflict-2'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-conflict-2'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-conflict'),
            projectId: ProjectId.make('project-conflict'),
            title: 'Thread Conflict',
            modelSelection: {
              instanceId: ProviderInstanceId.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt: '2026-02-26T13:00:01.000Z',
            updatedAt: '2026-02-26T13:00:01.000Z',
          },
        })

        yield* appendAndProject({
          type: 'thread.turn-interrupt-requested',
          eventId: EventId.make('evt-conflict-3'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-conflict'),
          occurredAt: '2026-02-26T13:00:02.000Z',
          commandId: CommandId.make('cmd-conflict-3'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-conflict-3'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-conflict'),
            turnId: TurnId.make('turn-interrupted'),
            createdAt: '2026-02-26T13:00:02.000Z',
          },
        })

        yield* appendAndProject({
          type: 'thread.message-sent',
          eventId: EventId.make('evt-conflict-4'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-conflict'),
          occurredAt: '2026-02-26T13:00:03.000Z',
          commandId: CommandId.make('cmd-conflict-4'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-conflict-4'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-conflict'),
            messageId: MessageId.make('assistant-conflict'),
            role: 'assistant',
            text: 'done',
            turnId: TurnId.make('turn-completed'),
            streaming: false,
            createdAt: '2026-02-26T13:00:03.000Z',
            updatedAt: '2026-02-26T13:00:03.000Z',
          },
        })

        yield* appendAndProject({
          type: 'thread.turn-diff-completed',
          eventId: EventId.make('evt-conflict-5'),
          aggregateKind: 'thread',
          aggregateId: ThreadId.make('thread-conflict'),
          occurredAt: '2026-02-26T13:00:04.000Z',
          commandId: CommandId.make('cmd-conflict-5'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-conflict-5'),
          metadata: {},
          payload: {
            threadId: ThreadId.make('thread-conflict'),
            turnId: TurnId.make('turn-completed'),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make('refs/t3/checkpoints/thread-conflict/turn/1'),
            status: 'ready',
            files: [],
            assistantMessageId: MessageId.make('assistant-conflict'),
            completedAt: '2026-02-26T13:00:04.000Z',
          },
        })

        const turnRows = yield* sql<{
          readonly turnId: string
          readonly checkpointTurnCount: number | null
          readonly status: string
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `
        assert.deepEqual(turnRows, [
          { turnId: 'turn-completed', checkpointTurnCount: 1, status: 'completed' },
          { turnId: 'turn-interrupted', checkpointTurnCount: null, status: 'interrupted' },
        ])
      }),
  )

  it.effect('deduplicates adjacent provider-switch activities at the SQL boundary', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const threadId = ThreadId.make('thread-provider-switch-parity')
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.tap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      yield* appendAndProject({
        type: 'project.created',
        eventId: EventId.make('evt-provider-switch-parity-project'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-provider-switch-parity'),
        occurredAt: '2026-02-26T12:20:00.000Z',
        commandId: CommandId.make('cmd-provider-switch-parity-project'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-provider-switch-parity-project'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-provider-switch-parity'),
          title: 'Provider Switch Parity',
          workspaceRoot: '/tmp/project-provider-switch-parity',
          defaultModelSelection: null,
          scripts: [],
          createdAt: '2026-02-26T12:20:00.000Z',
          updatedAt: '2026-02-26T12:20:00.000Z',
        },
      })
      yield* appendAndProject({
        type: 'thread.created',
        eventId: EventId.make('evt-provider-switch-parity-thread'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:20:01.000Z',
        commandId: CommandId.make('cmd-provider-switch-parity-thread'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-provider-switch-parity-thread'),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make('project-provider-switch-parity'),
          title: 'Provider Switch Parity',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: '2026-02-26T12:20:01.000Z',
          updatedAt: '2026-02-26T12:20:01.000Z',
        },
      })
      yield* appendAndProject({
        type: 'thread.provider-switch-requested',
        eventId: EventId.make('evt-provider-switch-parity-requested'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:20:02.000Z',
        commandId: CommandId.make('cmd-provider-switch-parity-requested'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-provider-switch-parity-requested'),
        metadata: {},
        payload: {
          threadId,
          targetModelSelection: {
            instanceId: ProviderInstanceId.make('claude'),
            model: 'sonnet',
          },
          expectedCurrentInstanceId: ProviderInstanceId.make('codex'),
        },
      })
      yield* appendAndProject({
        type: 'thread.provider-switched',
        eventId: EventId.make('evt-provider-switch-parity-canonical'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:20:03.000Z',
        commandId: CommandId.make('cmd-provider-switch-parity-canonical'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-provider-switch-parity-canonical'),
        metadata: {},
        payload: {
          modelSelection: {
            instanceId: ProviderInstanceId.make('claude'),
            model: 'sonnet',
          },
          fromInstanceId: ProviderInstanceId.make('codex'),
          fromModel: 'gpt-5-codex',
          handoffText: 'Continue from the provider handoff.',
        },
      })
      const legacyActivityEvent = yield* appendAndProject({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-provider-switch-parity-legacy'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:20:04.000Z',
        commandId: CommandId.make('cmd-provider-switch-parity-legacy'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-provider-switch-parity-legacy'),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make('activity-provider-switch-parity-legacy'),
            tone: 'info',
            kind: 'provider.switch.completed',
            summary: 'Provider switch completed',
            payload: {
              fromInstanceId: ProviderInstanceId.make('codex'),
              fromModel: 'gpt-5-codex',
              toInstanceId: ProviderInstanceId.make('claude'),
              toModel: 'sonnet',
            },
            turnId: null,
            createdAt: '2026-02-26T12:20:03.000Z',
          },
        },
      })
      yield* appendAndProject({
        type: 'thread.provider-switched',
        eventId: EventId.make('evt-provider-switch-parity-canonical-replay'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:20:05.000Z',
        commandId: CommandId.make('cmd-provider-switch-parity-canonical-replay'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-provider-switch-parity-canonical-replay'),
        metadata: {},
        payload: {
          modelSelection: {
            instanceId: ProviderInstanceId.make('claude'),
            model: 'sonnet',
          },
          fromInstanceId: ProviderInstanceId.make('codex'),
          fromModel: 'gpt-5-codex',
          handoffText: 'Continue from the provider handoff.',
        },
      })

      const activities = yield* sql<{
        readonly activityId: string
        readonly kind: string
        readonly sequence: number | null
      }>`
        SELECT
          activity_id AS "activityId",
          kind,
          sequence
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY sequence, activity_id
      `
      assert.deepEqual(activities, [
        {
          activityId: 'activity-provider-switch-parity-legacy',
          kind: 'provider.switch.completed',
          sequence: legacyActivityEvent.sequence,
        },
      ])
    }),
  )

  // shared project+thread seed for stale pending-request clearance (approval vs user-input)
  const seedStalePendingThread = <A, E, R>(
    appendAndProject: (
      event: Parameters<OrchestrationEventStoreShape['append']>[0],
    ) => Effect.Effect<A, E, R>,
    slug: string,
    at: string,
  ) =>
    Effect.gen(function* ()
    {
      const projectId = ProjectId.make(`project-${slug}`)
      const threadId = ThreadId.make(`thread-${slug}`)
      const threadAt = DateTime.formatIso(
        DateTime.addDuration(DateTime.makeUnsafe(at), Duration.seconds(1)),
      )
      yield* appendAndProject({
        type: 'project.created',
        eventId: EventId.make(`evt-${slug}-1`),
        aggregateKind: 'project',
        aggregateId: projectId,
        occurredAt: at,
        commandId: CommandId.make(`cmd-${slug}-1`),
        causationEventId: null,
        correlationId: CorrelationId.make(`cmd-${slug}-1`),
        metadata: {},
        payload: {
          projectId,
          title: `Project ${slug}`,
          workspaceRoot: `/tmp/project-${slug}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        },
      })
      yield* appendAndProject({
        type: 'thread.created',
        eventId: EventId.make(`evt-${slug}-2`),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: threadAt,
        commandId: CommandId.make(`cmd-${slug}-2`),
        causationEventId: null,
        correlationId: CorrelationId.make(`cmd-${slug}-2`),
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: `Thread ${slug}`,
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'approval-required',
          interactionMode: 'default',
          branch: null,
          worktreePath: null,
          createdAt: threadAt,
          updatedAt: threadAt,
        },
      })
      return { projectId, threadId }
    })

  it.effect('clears stale pending approvals from projected shell summaries', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      const { threadId } = yield* seedStalePendingThread(
        appendAndProject,
        'stale-approval',
        '2026-02-26T12:30:00.000Z',
      )

      yield* appendAndProject({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-stale-approval-3'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:30:02.000Z',
        commandId: CommandId.make('cmd-stale-approval-3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-stale-approval-3'),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make('activity-stale-approval-requested'),
            tone: 'approval',
            kind: 'approval.requested',
            summary: 'Command approval requested',
            payload: {
              requestId: 'approval-request-stale-1',
              requestKind: 'command',
            },
            turnId: null,
            createdAt: '2026-02-26T12:30:02.000Z',
          },
        },
      })

      yield* appendAndProject({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-stale-approval-4'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:30:03.000Z',
        commandId: CommandId.make('cmd-stale-approval-4'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-stale-approval-4'),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make('activity-stale-approval-failed'),
            tone: 'error',
            kind: 'provider.approval.respond.failed',
            summary: 'Provider approval response failed',
            payload: {
              requestId: 'approval-request-stale-1',
              detail: 'Unknown pending permission request: approval-request-stale-1',
            },
            turnId: null,
            createdAt: '2026-02-26T12:30:03.000Z',
          },
        },
      })

      const approvalRows = yield* sql<{
        readonly requestId: string
        readonly status: string
        readonly resolvedAt: string | null
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-request-stale-1'
      `
      assert.deepEqual(approvalRows, [
        {
          requestId: 'approval-request-stale-1',
          status: 'resolved',
          resolvedAt: '2026-02-26T12:30:03.000Z',
        },
      ])

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 0 }])
    }),
  )

  it.effect('clears stale pending user input from projected shell summaries', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      const { threadId } = yield* seedStalePendingThread(
        appendAndProject,
        'stale-user-input',
        '2026-02-26T12:35:00.000Z',
      )

      yield* appendAndProject({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-stale-user-input-3'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:35:02.000Z',
        commandId: CommandId.make('cmd-stale-user-input-3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-stale-user-input-3'),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make('activity-stale-user-input-requested'),
            tone: 'info',
            kind: 'user-input.requested',
            summary: 'User input requested',
            payload: {
              requestId: 'user-input-request-stale-1',
              questions: [
                {
                  id: 'sandbox_mode',
                  header: 'Sandbox',
                  question: 'Which mode should be used?',
                  options: [
                    {
                      label: 'workspace-write',
                      description: 'Allow workspace writes only',
                    },
                  ],
                },
              ],
            },
            turnId: null,
            createdAt: '2026-02-26T12:35:02.000Z',
          },
        },
      })

      yield* appendAndProject({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-stale-user-input-4'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-02-26T12:35:03.000Z',
        commandId: CommandId.make('cmd-stale-user-input-4'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-stale-user-input-4'),
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make('activity-stale-user-input-failed'),
            tone: 'error',
            kind: 'provider.user-input.respond.failed',
            summary: 'Provider user input response failed',
            payload: {
              requestId: 'user-input-request-stale-1',
              detail:
                'Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: user-input-request-stale-1',
            },
            turnId: null,
            createdAt: '2026-02-26T12:35:03.000Z',
          },
        },
      })

      // user-input request kind clears the shell pending count (distinct from approval.requested)
      const threadRows = yield* sql<{
        readonly pendingUserInputCount: number
      }>`
        SELECT pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `
      assert.deepEqual(threadRows, [{ pendingUserInputCount: 0 }])
    }),
  )

  it.effect('ignores non-stale provider approval response failures', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      yield* appendAndProject({
        type: 'project.created',
        eventId: EventId.make('evt-nonstale-approval-1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-nonstale-approval'),
        occurredAt: '2026-02-26T12:45:00.000Z',
        commandId: CommandId.make('cmd-nonstale-approval-1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-nonstale-approval-1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-nonstale-approval'),
          title: 'Project Non-Stale Approval',
          workspaceRoot: '/tmp/project-nonstale-approval',
          defaultModelSelection: null,
          scripts: [],
          createdAt: '2026-02-26T12:45:00.000Z',
          updatedAt: '2026-02-26T12:45:00.000Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.created',
        eventId: EventId.make('evt-nonstale-approval-2'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-nonstale-approval'),
        occurredAt: '2026-02-26T12:45:01.000Z',
        commandId: CommandId.make('cmd-nonstale-approval-2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-nonstale-approval-2'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-nonstale-approval'),
          projectId: ProjectId.make('project-nonstale-approval'),
          title: 'Thread Non-Stale Approval',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'approval-required',
          interactionMode: 'default',
          branch: null,
          worktreePath: null,
          createdAt: '2026-02-26T12:45:01.000Z',
          updatedAt: '2026-02-26T12:45:01.000Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-nonstale-approval-3'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-nonstale-approval'),
        occurredAt: '2026-02-26T12:45:02.000Z',
        commandId: CommandId.make('cmd-nonstale-approval-3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-nonstale-approval-3'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-nonstale-approval'),
          activity: {
            id: EventId.make('activity-nonstale-approval-requested'),
            tone: 'approval',
            kind: 'approval.requested',
            summary: 'Command approval requested',
            payload: {
              requestId: 'approval-request-nonstale-existing',
              requestKind: 'command',
            },
            turnId: null,
            createdAt: '2026-02-26T12:45:02.000Z',
          },
        },
      })

      yield* appendAndProject({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-nonstale-approval-4'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-nonstale-approval'),
        occurredAt: '2026-02-26T12:45:03.000Z',
        commandId: CommandId.make('cmd-nonstale-approval-4'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-nonstale-approval-4'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-nonstale-approval'),
          activity: {
            id: EventId.make('activity-nonstale-approval-failed-existing'),
            tone: 'error',
            kind: 'provider.approval.respond.failed',
            summary: 'Provider approval response failed',
            payload: {
              requestId: 'approval-request-nonstale-existing',
              detail: 'Provider timed out while responding to approval request',
            },
            turnId: TurnId.make('turn-nonstale-failure'),
            createdAt: '2026-02-26T12:45:03.000Z',
          },
        },
      })

      yield* appendAndProject({
        type: 'thread.activity-appended',
        eventId: EventId.make('evt-nonstale-approval-5'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-nonstale-approval'),
        occurredAt: '2026-02-26T12:45:04.000Z',
        commandId: CommandId.make('cmd-nonstale-approval-5'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-nonstale-approval-5'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-nonstale-approval'),
          activity: {
            id: EventId.make('activity-nonstale-approval-failed-missing'),
            tone: 'error',
            kind: 'provider.approval.respond.failed',
            summary: 'Provider approval response failed',
            payload: {
              requestId: 'approval-request-nonstale-missing',
              detail: 'Provider timed out while responding to approval request',
            },
            turnId: null,
            createdAt: '2026-02-26T12:45:04.000Z',
          },
        },
      })

      const approvalRows = yield* sql<{
        readonly requestId: string
        readonly status: string
        readonly turnId: string | null
        readonly createdAt: string
        readonly resolvedAt: string | null
      }>`
        SELECT
          request_id AS "requestId",
          status,
          turn_id AS "turnId",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id IN (
          'approval-request-nonstale-existing',
          'approval-request-nonstale-missing'
        )
        ORDER BY request_id
      `
      assert.deepEqual(approvalRows, [
        {
          requestId: 'approval-request-nonstale-existing',
          status: 'pending',
          turnId: null,
          createdAt: '2026-02-26T12:45:02.000Z',
          resolvedAt: null,
        },
      ])

      const threadRows = yield* sql<{
        readonly pendingApprovalCount: number
      }>`
        SELECT pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        WHERE thread_id = 'thread-nonstale-approval'
      `
      assert.deepEqual(threadRows, [{ pendingApprovalCount: 1 }])
    }),
  )

  it.effect('does not fallback-retain messages whose turnId is removed by revert', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      yield* appendAndProject({
        type: 'project.created',
        eventId: EventId.make('evt-revert-1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-revert'),
        occurredAt: '2026-02-26T12:00:00.000Z',
        commandId: CommandId.make('cmd-revert-1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-revert'),
          title: 'Project Revert',
          workspaceRoot: '/tmp/project-revert',
          defaultModelSelection: null,
          scripts: [],
          createdAt: '2026-02-26T12:00:00.000Z',
          updatedAt: '2026-02-26T12:00:00.000Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.created',
        eventId: EventId.make('evt-revert-2'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-revert'),
        occurredAt: '2026-02-26T12:00:01.000Z',
        commandId: CommandId.make('cmd-revert-2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-2'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-revert'),
          projectId: ProjectId.make('project-revert'),
          title: 'Thread Revert',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: '2026-02-26T12:00:01.000Z',
          updatedAt: '2026-02-26T12:00:01.000Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.turn-diff-completed',
        eventId: EventId.make('evt-revert-3'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-revert'),
        occurredAt: '2026-02-26T12:00:02.000Z',
        commandId: CommandId.make('cmd-revert-3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-3'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-revert'),
          turnId: TurnId.make('turn-1'),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make('refs/t3/checkpoints/thread-revert/turn/1'),
          status: 'ready',
          files: [],
          assistantMessageId: MessageId.make('assistant-keep'),
          completedAt: '2026-02-26T12:00:02.000Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-revert-4'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-revert'),
        occurredAt: '2026-02-26T12:00:02.100Z',
        commandId: CommandId.make('cmd-revert-4'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-4'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-revert'),
          messageId: MessageId.make('assistant-keep'),
          role: 'assistant',
          text: 'kept',
          turnId: TurnId.make('turn-1'),
          streaming: false,
          createdAt: '2026-02-26T12:00:02.100Z',
          updatedAt: '2026-02-26T12:00:02.100Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.turn-diff-completed',
        eventId: EventId.make('evt-revert-5'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-revert'),
        occurredAt: '2026-02-26T12:00:03.000Z',
        commandId: CommandId.make('cmd-revert-5'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-5'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-revert'),
          turnId: TurnId.make('turn-2'),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make('refs/t3/checkpoints/thread-revert/turn/2'),
          status: 'ready',
          files: [],
          assistantMessageId: MessageId.make('assistant-remove'),
          completedAt: '2026-02-26T12:00:03.000Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-revert-6'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-revert'),
        occurredAt: '2026-02-26T12:00:03.050Z',
        commandId: CommandId.make('cmd-revert-6'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-6'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-revert'),
          messageId: MessageId.make('user-remove'),
          role: 'user',
          text: 'removed',
          turnId: TurnId.make('turn-2'),
          streaming: false,
          createdAt: '2026-02-26T12:00:03.050Z',
          updatedAt: '2026-02-26T12:00:03.050Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.message-sent',
        eventId: EventId.make('evt-revert-7'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-revert'),
        occurredAt: '2026-02-26T12:00:03.100Z',
        commandId: CommandId.make('cmd-revert-7'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-7'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-revert'),
          messageId: MessageId.make('assistant-remove'),
          role: 'assistant',
          text: 'removed',
          turnId: TurnId.make('turn-2'),
          streaming: false,
          createdAt: '2026-02-26T12:00:03.100Z',
          updatedAt: '2026-02-26T12:00:03.100Z',
        },
      })

      yield* appendAndProject({
        type: 'thread.reverted',
        eventId: EventId.make('evt-revert-8'),
        aggregateKind: 'thread',
        aggregateId: ThreadId.make('thread-revert'),
        occurredAt: '2026-02-26T12:00:04.000Z',
        commandId: CommandId.make('cmd-revert-8'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-revert-8'),
        metadata: {},
        payload: {
          threadId: ThreadId.make('thread-revert'),
          turnCount: 1,
        },
      })

      const messageRows = yield* sql<{
        readonly messageId: string
        readonly turnId: string | null
        readonly role: string
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `
      assert.deepEqual(messageRows, [
        {
          messageId: 'assistant-keep',
          turnId: 'turn-1',
          role: 'assistant',
        },
      ])
    }),
  )

  it.effect('prunes only reverted orchestrate plans and their exact proposal links', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const threadId = ThreadId.make('thread-orchestrate-revert')
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      yield* appendAndProject({
        type: 'project.created',
        eventId: EventId.make('evt-orchestrate-revert-1'),
        aggregateKind: 'project',
        aggregateId: ProjectId.make('project-orchestrate-revert'),
        occurredAt: '2026-08-07T13:00:00.000Z',
        commandId: CommandId.make('cmd-orchestrate-revert-1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-orchestrate-revert-1'),
        metadata: {},
        payload: {
          projectId: ProjectId.make('project-orchestrate-revert'),
          title: 'Project Orchestrate Revert',
          workspaceRoot: '/tmp/project-orchestrate-revert',
          defaultModelSelection: null,
          scripts: [],
          createdAt: '2026-08-07T13:00:00.000Z',
          updatedAt: '2026-08-07T13:00:00.000Z',
        },
      })
      yield* appendAndProject({
        type: 'thread.created',
        eventId: EventId.make('evt-orchestrate-revert-2'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-08-07T13:00:01.000Z',
        commandId: CommandId.make('cmd-orchestrate-revert-2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-orchestrate-revert-2'),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make('project-orchestrate-revert'),
          title: 'Thread Orchestrate Revert',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5-codex',
          },
          runtimeMode: 'full-access',
          branch: null,
          worktreePath: null,
          createdAt: '2026-08-07T13:00:01.000Z',
          updatedAt: '2026-08-07T13:00:01.000Z',
        },
      })

      for (const turn of [
        { id: 'turn-orchestrate-keep', count: 1, suffix: '3' },
        { id: 'turn-orchestrate-prune', count: 2, suffix: '4' },
      ] as const)
      {
        yield* appendAndProject({
          type: 'thread.turn-diff-completed',
          eventId: EventId.make(`evt-orchestrate-revert-${turn.suffix}`),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: `2026-08-07T13:00:0${turn.count + 1}.000Z`,
          commandId: CommandId.make(`cmd-orchestrate-revert-${turn.suffix}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-orchestrate-revert-${turn.suffix}`),
          metadata: {},
          payload: {
            threadId,
            turnId: TurnId.make(turn.id),
            checkpointTurnCount: turn.count,
            checkpointRef: CheckpointRef.make(
              `refs/t3/checkpoints/thread-orchestrate-revert/turn/${turn.count}`,
            ),
            status: 'ready',
            files: [],
            assistantMessageId: MessageId.make(`assistant-orchestrate-${turn.count}`),
            completedAt: `2026-08-07T13:00:0${turn.count + 1}.000Z`,
          },
        })
      }

      for (const [index, plan] of [
        { runId: 'run-orchestrate-keep', turnId: TurnId.make('turn-orchestrate-keep') },
        { runId: 'run-orchestrate-prune', turnId: TurnId.make('turn-orchestrate-prune') },
        { runId: 'run-orchestrate-null', turnId: null },
      ].entries())
      {
        const occurredAt = `2026-08-07T13:00:0${index + 4}.000Z`
        yield* appendAndProject({
          type: 'thread.orchestrate-plan-upserted',
          eventId: EventId.make(`evt-orchestrate-revert-plan-${index}`),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.make(`cmd-orchestrate-revert-plan-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-orchestrate-revert-plan-${index}`),
          metadata: {},
          payload: {
            threadId,
            plan: {
              runId: plan.runId,
              revision: 1,
              turnId: plan.turnId,
              workflow: 'implementation',
              task: plan.runId,
              stages: [],
              totalWorkers: 0,
              maxWorkers: 1,
              source: 'tool',
              status: 'pending',
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
            createdAt: occurredAt,
          },
        })
      }

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
          'proposal-orchestrate-revert',
          'environment-orchestrate-revert',
          'project-orchestrate-revert',
          ${threadId},
          'session-orchestrate-revert',
          'codex',
          '{}',
          '/tmp/project-orchestrate-revert',
          '/tmp/project-orchestrate-revert/.git',
          '/tmp/project-orchestrate-revert/.git',
          '2026-08-07T13:00:08.000Z',
          '2026-08-07T13:00:08.000Z'
        )
      `
      yield* sql`
        INSERT INTO proposal_blobs (sha256, content, byte_length, created_at)
        VALUES (
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          X'',
          0,
          '2026-08-07T13:00:08.000Z'
        )
      `
      const runIds = [
        'run-orchestrate-keep',
        'run-orchestrate-prune',
        'run-orchestrate-null',
      ] as const
      for (const [index, runId] of runIds.entries())
      {
        const revision = index + 1
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
            created_at
          )
          VALUES (
            ${`revision-orchestrate-revert-${revision}`},
            'proposal-orchestrate-revert',
            ${revision},
            'dddddddddddddddddddddddddddddddddddddddd',
            'dddddddddddddddddddddddddddddddddddddddd',
            ${`refs/base/${revision}`},
            0,
            0,
            '{}',
            'dddddddddddddddddddddddddddddddddddddddd',
            ${`refs/proposed/${revision}`},
            '{}',
            'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            0,
            '2026-08-07T13:00:08.000Z'
          )
        `
        yield* sql`
          INSERT INTO proposal_orchestrate_plan_links (
            proposal_id,
            proposal_revision,
            source_thread_id,
            run_id,
            orchestrate_revision,
            created_at
          )
          VALUES (
            'proposal-orchestrate-revert',
            ${revision},
            ${threadId},
            ${runId},
            1,
            '2026-08-07T13:00:08.000Z'
          )
        `
      }

      yield* appendAndProject({
        type: 'thread.reverted',
        eventId: EventId.make('evt-orchestrate-revert-9'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: '2026-08-07T13:00:09.000Z',
        commandId: CommandId.make('cmd-orchestrate-revert-9'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-orchestrate-revert-9'),
        metadata: {},
        payload: { threadId, turnCount: 1 },
      })

      const projected = yield* sql<{ readonly runId: string; readonly turnId: string | null }>`
        SELECT run_id AS "runId", turn_id AS "turnId"
        FROM projection_thread_orchestrate_plans
        WHERE thread_id = ${threadId}
        ORDER BY run_id
      `
      assert.deepEqual(projected, [
        { runId: 'run-orchestrate-keep', turnId: 'turn-orchestrate-keep' },
        { runId: 'run-orchestrate-null', turnId: null },
      ])
      const links = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId"
        FROM proposal_orchestrate_plan_links
        WHERE source_thread_id = ${threadId}
        ORDER BY run_id
      `
      assert.deepEqual(links, [
        { runId: 'run-orchestrate-keep' },
        { runId: 'run-orchestrate-null' },
      ])

      // rebuild the dependent projections from sequence zero to prove turns
      // exist before the orchestrate revert projector consults them.
      yield* sql`
        INSERT INTO proposal_orchestrate_plan_links (
          proposal_id,
          proposal_revision,
          source_thread_id,
          run_id,
          orchestrate_revision,
          created_at
        )
        VALUES (
          'proposal-orchestrate-revert',
          2,
          ${threadId},
          'run-orchestrate-prune',
          1,
          '2026-08-07T13:00:08.000Z'
        )
      `
      yield* sql`DELETE FROM projection_thread_orchestrate_plans WHERE thread_id = ${threadId}`
      yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`
      yield* sql`
        DELETE FROM projection_state
        WHERE projector IN (
          ${ORCHESTRATION_PROJECTOR_NAMES.threadTurns},
          ${ORCHESTRATION_PROJECTOR_NAMES.threadOrchestratePlans}
        )
      `

      yield* projectionPipeline.bootstrap

      const rebuiltPlans = yield* sql<{
        readonly runId: string
        readonly turnId: string | null
      }>`
        SELECT run_id AS "runId", turn_id AS "turnId"
        FROM projection_thread_orchestrate_plans
        WHERE thread_id = ${threadId}
        ORDER BY run_id
      `
      assert.deepEqual(rebuiltPlans, [
        { runId: 'run-orchestrate-keep', turnId: 'turn-orchestrate-keep' },
        { runId: 'run-orchestrate-null', turnId: null },
      ])
      const rebuiltLinks = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId"
        FROM proposal_orchestrate_plan_links
        WHERE source_thread_id = ${threadId}
        ORDER BY run_id
      `
      assert.deepEqual(rebuiltLinks, [
        { runId: 'run-orchestrate-keep' },
        { runId: 'run-orchestrate-null' },
      ])
    }),
  )
})

it.layer(makeProjectionPipelinePrefixedTestLayer('t3-pending-turn-terminal-test-'))(
  'OrchestrationProjectionPipeline pending turn cleanup',
  (it) =>
  {
    it.effect('clears pending turn starts when startup reaches a terminal session state', () =>
      Effect.gen(function* ()
      {
        const projectionPipeline = yield* OrchestrationProjectionPipeline
        const eventStore = yield* OrchestrationEventStore
        const sql = yield* SqlClient.SqlClient

        for (const [index, status] of (['error', 'interrupted', 'stopped'] as const).entries())
        {
          const threadId = ThreadId.make(`thread-terminal-${status}`)
          const requestedAt = `2026-02-26T14:00:0${index}.000Z`
          yield* eventStore.append({
            type: 'thread.turn-start-requested',
            eventId: EventId.make(`evt-terminal-pending-${status}`),
            aggregateKind: 'thread',
            aggregateId: threadId,
            occurredAt: requestedAt,
            commandId: CommandId.make(`cmd-terminal-pending-${status}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-terminal-pending-${status}`),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.make(`message-terminal-${status}`),
              runtimeMode: 'approval-required',
              createdAt: requestedAt,
            },
          })
          yield* eventStore.append({
            type: 'thread.session-set',
            eventId: EventId.make(`evt-terminal-session-${status}`),
            aggregateKind: 'thread',
            aggregateId: threadId,
            occurredAt: requestedAt,
            commandId: CommandId.make(`cmd-terminal-session-${status}`),
            causationEventId: null,
            correlationId: CorrelationId.make(`cmd-terminal-session-${status}`),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status,
                providerName: 'codex',
                runtimeMode: 'approval-required',
                activeTurnId: null,
                lastError: status === 'error' ? 'startup failed' : null,
                updatedAt: requestedAt,
              },
            },
          })
        }

        yield* projectionPipeline.bootstrap

        const pendingRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM projection_turns
          WHERE turn_id IS NULL
            AND state = 'pending'
        `
        assert.deepEqual(pendingRows, [])
      }),
    )
  },
)

it.effect('restores pending turn-start metadata across projection pipeline restart', () =>
  Effect.gen(function* ()
  {
    const { baseDir, dbPath } = yield* ServerConfig
    const persistenceLayer = makeSqlitePersistenceLive(dbPath).pipe(
      Layer.provideMerge(makeTestServerStorageLeaseLayer(baseDir)),
    )
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    )
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    )

    const threadId = ThreadId.make('thread-restart')
    const turnId = TurnId.make('turn-restart')
    const messageId = MessageId.make('message-restart')
    const sourcePlanThreadId = ThreadId.make('thread-plan-source')
    const sourcePlanId = 'plan-source'
    const turnStartedAt = '2026-02-26T14:00:00.000Z'
    const sessionSetAt = '2026-02-26T14:00:05.000Z'

    yield* Effect.gen(function* ()
    {
      const eventStore = yield* OrchestrationEventStore
      const projectionPipeline = yield* OrchestrationProjectionPipeline

      yield* eventStore.append({
        type: 'thread.turn-start-requested',
        eventId: EventId.make('evt-restart-1'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.make('cmd-restart-1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-restart-1'),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: 'approval-required',
          createdAt: turnStartedAt,
        },
      })

      yield* projectionPipeline.bootstrap
    }).pipe(Effect.provide(firstProjectionLayer))

    const turnRows = yield* Effect.gen(function* ()
    {
      const eventStore = yield* OrchestrationEventStore
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const sql = yield* SqlClient.SqlClient

      yield* eventStore.append({
        type: 'thread.session-set',
        eventId: EventId.make('evt-restart-2'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.make('cmd-restart-2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-restart-2'),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: 'running',
            providerName: 'codex',
            runtimeMode: 'approval-required',
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      })

      yield* projectionPipeline.bootstrap

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `
      assert.deepEqual(pendingRows, [])

      return yield* sql<{
        readonly turnId: string
        readonly userMessageId: string | null
        readonly sourceProposedPlanThreadId: string | null
        readonly sourceProposedPlanId: string | null
        readonly startedAt: string
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `
    }).pipe(Effect.provide(secondProjectionLayer))

    assert.deepEqual(turnRows, [
      {
        turnId: 'turn-restart',
        userMessageId: 'message-restart',
        sourceProposedPlanThreadId: 'thread-plan-source',
        sourceProposedPlanId: 'plan-source',
        startedAt: turnStartedAt,
      },
    ])
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: 't3-projection-pipeline-restart-',
        }),
        NodeServices.layer,
      ),
    ),
  ),
)

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(CheckpointRevertOperationsLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: 't3-projection-pipeline-engine-dispatch-',
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
)

engineLayer('OrchestrationProjectionPipeline via engine dispatch', (it) =>
{
  it.effect('projects dispatched engine events immediately', () =>
    Effect.gen(function* ()
    {
      const engine = yield* OrchestrationEngineService
      const sql = yield* SqlClient.SqlClient
      const createdAt = '2026-01-01T00:00:00.000Z'

      yield* engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-live-project'),
        projectId: ProjectId.make('project-live'),
        title: 'Live Project',
        workspaceRoot: '/tmp/project-live',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      })

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `
      assert.deepEqual(projectRows, [{ title: 'Live Project', scriptsJson: '[]' }])

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }])
    }),
  )

  it.effect('projects imported messages in timestamp order and exposes thread provenance', () =>
    Effect.gen(function* ()
    {
      const engine = yield* OrchestrationEngineService
      const snapshotQuery = yield* ProjectionSnapshotQuery
      const createdAt = '2026-01-03T00:00:00.000Z'
      const importedAt = '2026-01-04T00:00:00.000Z'
      const importedProjectId = ProjectId.make('project-import-round-trip')
      const importedThreadId = ThreadId.make('thread-import-round-trip')
      const origin = {
        kind: 'imported' as const,
        source: 'claude-code' as const,
        sourcePath: '/tmp/claude-session.jsonl',
        contentHash: 'sha256-content-hash',
        nativeSessionId: 'claude-session-1',
        providerInstanceId: ProviderInstanceId.make('claudeAgent'),
        importedAt,
      }

      yield* engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-import-project-create'),
        projectId: importedProjectId,
        title: 'Imported project',
        workspaceRoot: '/tmp/import-round-trip',
        createdAt,
      })
      yield* engine.dispatch({
        type: 'thread.create',
        commandId: CommandId.make('cmd-import-thread-create'),
        threadId: importedThreadId,
        projectId: importedProjectId,
        title: 'Imported thread',
        modelSelection: {
          instanceId: ProviderInstanceId.make('claudeAgent'),
          model: 'claude-opus-4-6',
        },
        runtimeMode: 'full-access',
        interactionMode: 'default',
        branch: null,
        worktreePath: null,
        origin,
        createdAt,
      })
      yield* engine.dispatch({
        type: 'thread.messages.import',
        commandId: CommandId.make('cmd-import-messages'),
        threadId: importedThreadId,
        messages: [
          {
            messageId: MessageId.make('message-z'),
            role: 'assistant',
            text: 'latest',
            createdAt: '2026-01-03T00:00:02.000Z',
          },
          {
            messageId: MessageId.make('message-b'),
            role: 'assistant',
            text: 'same time, second id',
            createdAt: '2026-01-03T00:00:01.000Z',
          },
          {
            messageId: MessageId.make('message-a'),
            role: 'user',
            text: 'same time, first id',
            createdAt: '2026-01-03T00:00:01.000Z',
          },
        ],
        activities: [],
        createdAt: importedAt,
      })

      const detail = yield* snapshotQuery.getThreadDetailById(importedThreadId)
      assert.equal(detail._tag, 'Some')
      if (detail._tag === 'Some')
      {
        assert.deepEqual(
          detail.value.messages.map((message) => message.id),
          [MessageId.make('message-a'), MessageId.make('message-b'), MessageId.make('message-z')],
        )
        assert.deepEqual(detail.value.origin, origin)
      }

      const shell = yield* snapshotQuery.getThreadShellById(importedThreadId)
      assert.equal(shell._tag, 'Some')
      if (shell._tag === 'Some')
      {
        assert.deepEqual(shell.value.origin, origin)
      }
    }),
  )

  it.effect('projects persist updated scripts from project.meta.update', () =>
    Effect.gen(function* ()
    {
      const engine = yield* OrchestrationEngineService
      const sql = yield* SqlClient.SqlClient
      const createdAt = '2026-01-01T00:00:00.000Z'

      yield* engine.dispatch({
        type: 'project.create',
        commandId: CommandId.make('cmd-scripts-project-create'),
        projectId: ProjectId.make('project-scripts'),
        title: 'Scripts Project',
        workspaceRoot: '/tmp/project-scripts',
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5-codex',
        },
        createdAt,
      })

      yield* engine.dispatch({
        type: 'project.meta.update',
        commandId: CommandId.make('cmd-scripts-project-update'),
        projectId: ProjectId.make('project-scripts'),
        scripts: [
          {
            id: 'script-1',
            name: 'Build',
            command: 'bun run build',
            icon: 'build',
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5',
        },
      })

      const projectRows = yield* sql<{
        readonly scriptsJson: string
        readonly defaultModelSelection: string
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5"}',
        },
      ])
    }),
  )
})

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-checkpoint-identity-projection-')),
)('OrchestrationProjectionPipeline checkpoint identity', (it) =>
{
  it.effect('projects turn zero and preserves authoritative identity across legacy replay', () =>
    Effect.gen(function* ()
    {
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const eventStore = yield* OrchestrationEventStore
      const sql = yield* SqlClient.SqlClient
      const threadId = ThreadId.make('thread-checkpoint-identity')
      const occurredAt = '2026-08-09T00:00:00.000Z'
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

      yield* appendAndProject({
        type: 'thread.checkpoint-baseline-recorded',
        eventId: EventId.make('evt-checkpoint-identity-1'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt,
        commandId: CommandId.make('cmd-checkpoint-identity-1'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-checkpoint-identity-1'),
        metadata: {},
        payload: {
          threadId,
          checkpointTurnCount: 0,
          checkpointRef: CheckpointRef.make('refs/t3/checkpoint/thread-checkpoint-identity/0'),
          checkpointCaptureRoot: '/capture/baseline',
          checkpointRepositoryCommonDir: '/capture/repository/.git',
          checkpointCommitOid: '0000000000000000000000000000000000000000',
          capturedAt: occurredAt,
        },
      })
      yield* appendAndProject({
        type: 'thread.turn-diff-completed',
        eventId: EventId.make('evt-checkpoint-identity-2'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt,
        commandId: CommandId.make('cmd-checkpoint-identity-2'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-checkpoint-identity-2'),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make('turn-checkpoint-identity'),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make('refs/t3/checkpoint/thread-checkpoint-identity/1'),
          status: 'ready',
          files: [],
          assistantMessageId: null,
          completedAt: occurredAt,
          checkpointCaptureRoot: '/capture/turn-one',
          checkpointRepositoryCommonDir: '/capture/repository/.git',
          checkpointCommitOid: '1111111111111111111111111111111111111111',
        },
      })
      yield* appendAndProject({
        type: 'thread.turn-diff-completed',
        eventId: EventId.make('evt-checkpoint-identity-3'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt,
        commandId: CommandId.make('cmd-checkpoint-identity-3'),
        causationEventId: null,
        correlationId: CorrelationId.make('cmd-checkpoint-identity-3'),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.make('turn-checkpoint-identity'),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make('refs/t3/checkpoint/thread-checkpoint-identity/1'),
          status: 'missing',
          files: [],
          assistantMessageId: null,
          completedAt: occurredAt,
        },
      })

      const identities = yield* sql<{
        readonly turnCount: number
        readonly captureRoot: string | null
        readonly commonDir: string | null
        readonly commitOid: string | null
      }>`
        SELECT
          checkpoint_turn_count AS "turnCount",
          checkpoint_capture_root AS "captureRoot",
          checkpoint_repository_common_dir AS "commonDir",
          checkpoint_commit_oid AS "commitOid"
        FROM projection_checkpoint_identities
        WHERE thread_id = ${threadId}
        ORDER BY checkpoint_turn_count
      `
      assert.deepEqual(identities, [
        {
          turnCount: 0,
          captureRoot: '/capture/baseline',
          commonDir: '/capture/repository/.git',
          commitOid: '0000000000000000000000000000000000000000',
        },
        {
          turnCount: 1,
          captureRoot: '/capture/turn-one',
          commonDir: '/capture/repository/.git',
          commitOid: '1111111111111111111111111111111111111111',
        },
      ])
    }),
  )
})

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer('t3-orchestrate-respond-failed-')))(
  'OrchestrationProjectionPipeline',
  (it) =>
  {
    it.effect('reverts an approved orchestrate plan after respond.failed', () =>
      Effect.gen(function* ()
      {
        const projectionPipeline = yield* OrchestrationProjectionPipeline
        const eventStore = yield* OrchestrationEventStore
        const sql = yield* SqlClient.SqlClient
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)))

        const threadId = ThreadId.make('thread-orchestrate-respond-failed')
        const projectId = ProjectId.make('project-orchestrate-respond-failed')
        const upsertedAt = '2026-08-13T18:00:00.000Z'
        const approvedAt = '2026-08-13T18:00:01.000Z'
        const failedAt = '2026-08-13T18:00:02.000Z'

        yield* appendAndProject({
          type: 'project.created',
          eventId: EventId.make('evt-orchestrate-respond-failed-project'),
          aggregateKind: 'project',
          aggregateId: projectId,
          occurredAt: upsertedAt,
          commandId: CommandId.make('cmd-orchestrate-respond-failed-project'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-orchestrate-respond-failed-project'),
          metadata: {},
          payload: {
            projectId,
            title: 'Orchestrate respond failed',
            workspaceRoot: '/tmp/orchestrate-respond-failed',
            defaultModelSelection: null,
            scripts: [],
            createdAt: upsertedAt,
            updatedAt: upsertedAt,
          },
        })
        yield* appendAndProject({
          type: 'thread.created',
          eventId: EventId.make('evt-orchestrate-respond-failed-thread'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: upsertedAt,
          commandId: CommandId.make('cmd-orchestrate-respond-failed-thread'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-orchestrate-respond-failed-thread'),
          metadata: {},
          payload: {
            threadId,
            projectId,
            title: 'Thread',
            modelSelection: {
              instanceId: ProviderInstanceId.make('codex'),
              model: 'gpt-5-codex',
            },
            runtimeMode: 'full-access',
            branch: null,
            worktreePath: null,
            createdAt: upsertedAt,
            updatedAt: upsertedAt,
          },
        })
        yield* appendAndProject({
          type: 'thread.orchestrate-plan-upserted',
          eventId: EventId.make('evt-orchestrate-respond-failed-upsert'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: upsertedAt,
          commandId: CommandId.make('cmd-orchestrate-respond-failed-upsert'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-orchestrate-respond-failed-upsert'),
          metadata: {},
          payload: {
            threadId,
            plan: {
              runId: 'run-pipeline-revert',
              revision: 1,
              turnId: null,
              workflow: 'implementation',
              task: 'Ship the change',
              stages: [],
              totalWorkers: 0,
              maxWorkers: 1,
              source: 'tool',
              status: 'pending',
              createdAt: upsertedAt,
              updatedAt: upsertedAt,
            },
            createdAt: upsertedAt,
          },
        })
        yield* appendAndProject({
          type: 'thread.orchestrate-plan-response-requested',
          eventId: EventId.make('evt-orchestrate-respond-failed-approve'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: approvedAt,
          commandId: CommandId.make('cmd-orchestrate-respond-failed-approve'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-orchestrate-respond-failed-approve'),
          metadata: {},
          payload: {
            threadId,
            runId: 'run-pipeline-revert',
            revision: 1,
            decision: 'approve',
            createdAt: approvedAt,
          },
        })

        const approved = yield* sql<{ readonly status: string }>`
          SELECT status
          FROM projection_thread_orchestrate_plans
          WHERE thread_id = ${threadId}
            AND run_id = 'run-pipeline-revert'
            AND revision = 1
        `
        assert.deepEqual(approved, [{ status: 'approved' }])

        yield* appendAndProject({
          type: 'thread.activity-appended',
          eventId: EventId.make('evt-orchestrate-respond-failed-activity'),
          aggregateKind: 'thread',
          aggregateId: threadId,
          occurredAt: failedAt,
          commandId: CommandId.make('cmd-orchestrate-respond-failed-activity'),
          causationEventId: null,
          correlationId: CorrelationId.make('cmd-orchestrate-respond-failed-activity'),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make('activity-orchestrate-respond-failed'),
              tone: 'error',
              kind: 'provider.orchestrate-plan.respond.failed',
              summary: 'Provider orchestrate plan response failed',
              payload: {
                detail: 'simulated envelope delivery failure',
                runId: 'run-pipeline-revert',
                revision: 1,
              },
              turnId: null,
              createdAt: failedAt,
            },
          },
        })

        const reverted = yield* sql<{ readonly status: string }>`
          SELECT status
          FROM projection_thread_orchestrate_plans
          WHERE thread_id = ${threadId}
            AND run_id = 'run-pipeline-revert'
            AND revision = 1
        `
        assert.deepEqual(reverted, [{ status: 'pending' }])
      }),
    )
  },
)
