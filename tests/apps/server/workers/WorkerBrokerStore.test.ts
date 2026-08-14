// tests/apps/server/workers/WorkerBrokerStore.test.ts
// verifies backward-compatible worker-broker reads and evidence mapping

import * as NodeServices from '@effect/platform-node/NodeServices'
import { WorkersActivitySnapshot } from '@t3tools/contracts'
import { HostProcessEnvironment } from '@t3tools/shared/hostProcess'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

import * as WorkerBrokerStore from '../../../../apps/server/src/workers/WorkerBrokerStore.ts'

const encodeActivitySnapshot = Schema.encodeUnknownSync(WorkersActivitySnapshot)

// fixtures are arbitrary broker records, so they encode through the unknown
// JSON codec rather than JSON.stringify
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

// the tail-boundary case measures encoded bytes, not code units
const utf8Length = (value: string): number => new TextEncoder().encode(value).length

function activityLayer(stateDir: string)
{
  return WorkerBrokerStore.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { WORKER_BROKER_HOME: stateDir })),
  )
}

interface WorkerStoreIo
{
  readonly writeActivity: (lines: ReadonlyArray<string>) => Effect.Effect<void>
  readonly writeActivityText: (text: string) => Effect.Effect<void>
  readonly writeJob: (jobId: string, record: unknown) => Effect.Effect<void>
}

// the temp state dir is scoped, so each case is cleaned up on release instead
// of through a try/finally around the assertions
const withWorkerStore = <A, E>(
  run: (io: WorkerStoreIo) => Effect.Effect<A, E, WorkerBrokerStore.WorkerBrokerStore>,
) =>
  Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'workers-store-' })

    const writeFile = (jobId: string, name: string, contents: string) =>
      Effect.gen(function* ()
      {
        const jobDir = path.join(stateDir, 'jobs', jobId)
        yield* fileSystem.makeDirectory(jobDir, { recursive: true })
        yield* fileSystem.writeFileString(path.join(jobDir, name), contents)
      }).pipe(Effect.orDie)

    const io: WorkerStoreIo = {
      writeActivity: (lines) => writeFile('job-1', 'activity.jsonl', lines.join('\n')),
      writeActivityText: (text) => writeFile('job-1', 'activity.jsonl', text),
      writeJob: (jobId, record) => writeFile(jobId, 'job.json', encodeJson(record)),
    }

    return yield* run(io).pipe(Effect.provide(activityLayer(stateDir)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe('WorkerBrokerStore activity', () =>
{
  it.effect('returns empty history when old jobs have no activity artifact', () =>
    withWorkerStore(() =>
      Effect.gen(function* ()
      {
        const store = yield* WorkerBrokerStore.WorkerBrokerStore
        const snapshot = yield* store.readActivity({ jobId: 'job-1' })
        assert.deepStrictEqual(snapshot.entries, [])
        assert.strictEqual(snapshot.skippedEntryCount, 0)
        assert.strictEqual(snapshot.truncated, false)
      }),
    ),
  )

  it.effect('normalizes safe records while reporting malformed and unsupported lines', () =>
    withWorkerStore(({ writeActivity }) =>
      Effect.gen(function* ()
      {
        yield* writeActivity([
          encodeJson({
            schema_version: 1,
            sequence: 1,
            recorded_at: '2026-07-31T12:00:00Z',
            kind: 'phase',
            phase: 'working',
            status: 'started',
          }),
          'not json',
          encodeJson({
            schema_version: 2,
            sequence: 2,
            recorded_at: '2026-07-31T12:00:01Z',
            kind: 'message',
            summary: 'hidden',
          }),
          encodeJson({
            schema_version: 1,
            sequence: 3,
            recorded_at: '2026-07-31T12:00:02Z',
            kind: 'message',
            summary: '  safe\u0000summary  ',
          }),
          encodeJson({
            schema_version: 1,
            sequence: 4,
            recorded_at: '2026-07-31T12:00:03Z',
            kind: 'action',
            status: 'completed',
            command: 'secret',
          }),
        ])

        const store = yield* WorkerBrokerStore.WorkerBrokerStore
        const snapshot = yield* store.readActivity({ jobId: 'job-1' })
        assert.strictEqual(snapshot.entries.length, 3)
        assert.strictEqual(snapshot.skippedEntryCount, 2)
        assert.deepStrictEqual(snapshot.entries[1], {
          sequence: 3,
          recordedAt: '2026-07-31T12:00:02Z',
          kind: 'message',
          summary: 'safe summary',
        })
        assert.deepStrictEqual(snapshot.entries[2], {
          sequence: 4,
          recordedAt: '2026-07-31T12:00:03Z',
          kind: 'action',
          status: 'completed',
        })
      }),
    ),
  )

  it.effect('skips unsafe activity sequences without losing later records', () =>
    withWorkerStore(({ writeActivity }) =>
      Effect.gen(function* ()
      {
        yield* writeActivity([
          encodeJson({
            schema_version: 1,
            sequence: 1,
            recorded_at: '2026-07-31T12:00:00Z',
            kind: 'message',
            summary: 'before',
          }),
          encodeJson({
            schema_version: 1,
            sequence: Number.MAX_SAFE_INTEGER + 1,
            recorded_at: '2026-07-31T12:00:01Z',
            kind: 'message',
            summary: 'unsafe',
          }),
          encodeJson({
            schema_version: 1,
            sequence: 2,
            recorded_at: '2026-07-31T12:00:02Z',
            kind: 'message',
            summary: 'after',
          }),
        ])

        const store = yield* WorkerBrokerStore.WorkerBrokerStore
        const snapshot = yield* store.readActivity({ jobId: 'job-1' })
        assert.deepStrictEqual(
          snapshot.entries.map((entry) => entry.sequence),
          [1, 2],
        )
        assert.strictEqual(snapshot.skippedEntryCount, 1)
        assert.doesNotThrow(() => encodeActivitySnapshot(snapshot))
      }),
    ),
  )

  it.effect('preserves a complete activity record at the bounded tail boundary', () =>
    withWorkerStore(({ writeActivityText }) =>
      Effect.gen(function* ()
      {
        const record = (sequence: number, summary: string) =>
          encodeJson({
            schema_version: 1,
            sequence,
            recorded_at: '2026-07-31T12:00:00Z',
            kind: 'message',
            summary,
          })
        const boundaryRecord = record(2, 'boundary')
        const emptyFinalRecord = record(3, '')
        const maxActivityBytes = 256 * 1024
        const paddingLength =
          maxActivityBytes - utf8Length(`${boundaryRecord}\n`) - utf8Length(emptyFinalRecord)

        yield* writeActivityText(
          `${record(1, 'prefix')}\n${boundaryRecord}\n${record(3, 'x'.repeat(paddingLength))}`,
        )

        const store = yield* WorkerBrokerStore.WorkerBrokerStore
        const snapshot = yield* store.readActivity({ jobId: 'job-1' })
        assert.deepStrictEqual(
          snapshot.entries.map((entry) => entry.sequence),
          [2, 3],
        )
        assert.strictEqual(snapshot.skippedEntryCount, 0)
        assert.strictEqual(snapshot.truncated, true)
      }),
    ),
  )

  it.effect('bounds large activity artifacts and normalized entry history', () =>
    withWorkerStore(({ writeActivity }) =>
      Effect.gen(function* ()
      {
        yield* writeActivity(
          Array.from({ length: 400 }, (_, index) =>
            encodeJson({
              schema_version: 1,
              sequence: index + 1,
              recorded_at: '2026-07-31T12:00:00Z',
              kind: 'message',
              summary: 'x'.repeat(1000),
            }),
          ),
        )

        const store = yield* WorkerBrokerStore.WorkerBrokerStore
        const snapshot = yield* store.readActivity({ jobId: 'job-1' })
        assert.strictEqual(snapshot.entries.length, 200)
        assert.strictEqual(snapshot.skippedEntryCount, 1)
        assert.strictEqual(snapshot.truncated, true)
        assert.strictEqual(snapshot.entries[0]?.kind, 'message')
      }),
    ),
  )
})

describe('WorkerBrokerStore failure classification', () =>
{
  it.effect('projects broker evidence and rolls up explicit outcomes', () =>
    withWorkerStore(({ writeJob }) =>
      Effect.gen(function* ()
      {
        yield* writeJob('job-env', {
          job_id: 'job-env',
          status: 'failed',
          request: {
            provider: 'codex',
            mode: 'edit',
            repo: '/r',
            task: 't',
            run: 'run-evidence',
          },
          result: {
            status: 'failed',
            outcome: 'worker-failed',
            failure_class: 'verification-failed',
            patch_path: '/state/jobs/job-env/change.patch',
            changed_files: ['a.ts', 'b.ts'],
            verification: [{ command: 'vp test run x', exit_code: 127, timed_out: false }],
          },
        })
        yield* writeJob('job-legacy', {
          job_id: 'job-legacy',
          status: 'failed',
          request: { provider: 'codex', mode: 'edit', repo: '/r', task: 't' },
          result: { status: 'failed' },
        })
        yield* writeJob('job-ok', {
          job_id: 'job-ok',
          status: 'completed',
          request: { provider: 'codex', mode: 'read', repo: '/r', task: 't' },
          result: { status: 'completed', patch_path: '/state/jobs/job-ok/change.patch' },
        })
        yield* writeJob('job-superseded', {
          job_id: 'job-superseded',
          status: 'cancelled',
          request: {
            provider: 'codex',
            mode: 'edit',
            repo: '/r',
            task: 't',
            run: 'run-evidence',
            relaunch_of: 'job-before',
          },
          result: {
            status: 'cancelled',
            outcome: 'superseded',
            cancel_reason: 'superseded',
            superseded_by: 'job-after',
            baseline_verification: [
              { command: 'vp test run baseline', exit_code: 1, timed_out: false },
            ],
            scope_violations: ['legacy/path.ts'],
            scope_violation_details: [
              {
                path: 'apps/web/a.ts',
                phase: 'provider',
                nearest_allowed: 'apps/web',
                root: 'apps/web',
              },
              {
                path: 'apps/web/b.ts',
                phase: 'final',
                nearest_allowed: null,
                root: 'apps/web',
              },
            ],
          },
        })

        const store = yield* WorkerBrokerStore.WorkerBrokerStore
        const listed = yield* store.list({})
        const byId = new Map(listed.jobs.map((job) => [job.jobId, job]))

        const env = byId.get('job-env')
        assert.ok(env)
        assert.deepStrictEqual(env.outcome, Option.some('worker-failed'))
        assert.deepStrictEqual(env.failureClass, Option.some('verification-failed'))
        assert.deepStrictEqual(env.hasPatch, Option.some(true))
        assert.deepStrictEqual(env.verificationExitCodes, [Option.some(127)])

        // legacy failed records degrade to "unknown", never to a false claim
        const legacy = byId.get('job-legacy')
        assert.ok(legacy)
        assert.deepStrictEqual(legacy.outcome, Option.none())
        assert.deepStrictEqual(legacy.cancelReason, Option.none())
        assert.deepStrictEqual(legacy.supersededBy, Option.none())
        assert.deepStrictEqual(legacy.relaunchOf, Option.none())
        assert.deepStrictEqual(legacy.failureClass, Option.some('unknown'))
        assert.deepStrictEqual(legacy.hasPatch, Option.some(false))

        // non-failed jobs carry no failure class even when a patch exists
        const ok = byId.get('job-ok')
        assert.ok(ok)
        assert.deepStrictEqual(ok.failureClass, Option.none())
        assert.deepStrictEqual(ok.hasPatch, Option.some(true))

        const superseded = byId.get('job-superseded')
        assert.ok(superseded)
        assert.deepStrictEqual(superseded.outcome, Option.some('superseded'))
        assert.deepStrictEqual(superseded.cancelReason, Option.some('superseded'))
        assert.deepStrictEqual(superseded.supersededBy, Option.some('job-after'))
        assert.deepStrictEqual(superseded.relaunchOf, Option.some('job-before'))
        assert.strictEqual(superseded.scopeViolationCount, 2)
        assert.deepStrictEqual(
          superseded.scopeViolationGroups,
          Option.some([{ root: 'apps/web', count: 2 }]),
        )

        const detail = yield* store.getJob({ jobId: 'job-superseded' })
        const detailJob = Option.getOrUndefined(detail.job)
        assert.ok(detailJob)
        assert.deepStrictEqual(
          detailJob.baselineVerification,
          Option.some([
            {
              command: 'vp test run baseline',
              exitCode: Option.some(1),
              timedOut: false,
              elapsedMs: Option.none(),
            },
          ]),
        )
        assert.deepStrictEqual(
          detailJob.scopeViolationDetails,
          Option.some([
            {
              path: 'apps/web/a.ts',
              phase: 'provider',
              nearestAllowed: Option.some('apps/web'),
              root: 'apps/web',
            },
            {
              path: 'apps/web/b.ts',
              phase: 'final',
              nearestAllowed: Option.none(),
              root: 'apps/web',
            },
          ]),
        )

        const runs = yield* store.listRuns({})
        const evidenceRun = runs.runs.find((run) => run.run === 'run-evidence')
        assert.ok(evidenceRun)
        assert.deepStrictEqual(evidenceRun.outcomeCounts, {
          'worker-failed': 1,
          superseded: 1,
        })
        assert.deepStrictEqual(
          evidenceRun.scopeViolationGroups,
          Option.some([{ root: 'apps/web', count: 2 }]),
        )
      }),
    ),
  )
})

describe('WorkerBrokerStore execution evidence', () =>
{
  it.effect(
    'returns raw immutable request and result identity without normalizing mismatches',
    () =>
      withWorkerStore(({ writeJob }) =>
        Effect.gen(function* ()
        {
          yield* writeJob('job-execution', {
            job_id: 'job-execution',
            status: 'completed',
            base_sha: 'base-oid',
            branch: 'record-branch',
            worktree: '/repo/worktrees/record',
            request: {
              run: 'run-execution',
              repo: '/repo',
            },
            result: {
              status: 'completed',
              repo: '/repo/worktrees/result',
              base_sha: 'base-oid',
              head_sha: 'head-oid',
              branch: 'result-branch',
              worktree: '/repo/worktrees/result',
            },
          })
          yield* writeJob('job-requested-path', {
            job_id: 'different-record-id',
            status: 'failed',
            request: { run: 'run-other', repo: '/other' },
            result: { status: 'failed' },
          })

          const store = yield* WorkerBrokerStore.WorkerBrokerStore
          const loaded = yield* store.getExecutionEvidence('job-execution')
          assert.deepStrictEqual(loaded, {
            state: 'loaded',
            evidence: {
              requestedJobId: 'job-execution',
              recordJobId: 'job-execution',
              recordStatus: 'completed',
              resultStatus: 'completed',
              requestRunId: 'run-execution',
              requestRepositoryRoot: '/repo',
              resultRepositoryRoot: '/repo/worktrees/result',
              recordBaseOid: 'base-oid',
              resultBaseOid: 'base-oid',
              headOid: 'head-oid',
              recordBranch: 'record-branch',
              resultBranch: 'result-branch',
              recordWorktreeRoot: '/repo/worktrees/record',
              resultWorktreeRoot: '/repo/worktrees/result',
            },
          })

          const mismatched = yield* store.getExecutionEvidence('job-requested-path')
          assert.deepStrictEqual(mismatched, {
            state: 'loaded',
            evidence: {
              requestedJobId: 'job-requested-path',
              recordJobId: 'different-record-id',
              recordStatus: 'failed',
              resultStatus: 'failed',
              requestRunId: 'run-other',
              requestRepositoryRoot: '/other',
              resultRepositoryRoot: null,
              recordBaseOid: null,
              resultBaseOid: null,
              headOid: null,
              recordBranch: null,
              resultBranch: null,
              recordWorktreeRoot: null,
              resultWorktreeRoot: null,
            },
          })
        }),
      ),
  )
})
