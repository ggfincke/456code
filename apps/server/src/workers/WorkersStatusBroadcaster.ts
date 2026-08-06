// apps/server/src/workers/WorkersStatusBroadcaster.ts
// streams debounced worker-broker snapshots from filesystem changes

import type {
  WorkersActivityInput,
  WorkersActivitySnapshot,
  WorkersListInput,
  WorkersStatusSnapshot,
} from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Stream from 'effect/Stream'

import * as WorkerBrokerStore from './WorkerBrokerStore.ts'

// fs watch on the jobs dir is not recursive, so nested job.json rewrites can be
// missed; a slow tick keeps snapshots correct while the watch keeps them fast
const WATCH_DEBOUNCE = '250 millis'
const REFRESH_INTERVAL = '3 seconds'

export class WorkersStatusBroadcaster extends Context.Service<
  WorkersStatusBroadcaster,
  {
    readonly streamSnapshots: (
      input: WorkersListInput,
    ) => Stream.Stream<WorkersStatusSnapshot, never>
    readonly streamActivity: (
      input: WorkersActivityInput,
    ) => Stream.Stream<WorkersActivitySnapshot, never>
  }
>()('456code/workers/WorkersStatusBroadcaster')
{}

export const make = Effect.gen(function* ()
{
  const store = yield* WorkerBrokerStore.WorkerBrokerStore
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  // the jobs dir may not exist until the broker runs its first job; watch the
  // closest existing ancestor so its creation is observed
  const nearestExistingDirectory = Effect.fn('WorkersStatusBroadcaster.nearestExistingDirectory')(
    function* (directory: string)
    {
      let candidate = directory
      while (true)
      {
        const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))
        if (exists) return candidate
        const parent = path.dirname(candidate)
        if (parent === candidate) return candidate
        candidate = parent
      }
    },
  )

  const loadSnapshot = Effect.fn('WorkersStatusBroadcaster.loadSnapshot')(function* (
    input: WorkersListInput,
  )
  {
    const list = yield* store.list(input)
    const allRuns = WorkerBrokerStore.runsFromWorkersList(list)
    const run = input.run?.trim()
    const runs =
      run === undefined
        ? allRuns
        : {
            ...allRuns,
            runs: allRuns.runs.filter((summary) => summary.run === run),
          }
    return { list, runs }
  })

  const streamSnapshots: WorkersStatusBroadcaster['Service']['streamSnapshots'] = (input) =>
    Stream.unwrap(
      Effect.gen(function* ()
      {
        const watchedDirectory = yield* nearestExistingDirectory(store.jobsDir)
        const triggers = Stream.merge(
          fs.watch(watchedDirectory).pipe(Stream.catchCause(() => Stream.empty)),
          Stream.tick(REFRESH_INTERVAL),
        ).pipe(Stream.debounce(WATCH_DEBOUNCE))
        return Stream.concat(
          Stream.fromEffect(loadSnapshot(input)),
          triggers.pipe(Stream.mapEffect(() => loadSnapshot(input))),
        )
      }),
    )

  const streamActivity: WorkersStatusBroadcaster['Service']['streamActivity'] = (input) =>
  {
    const jobId = input.jobId.trim()
    const watchChanges = WorkerBrokerStore.isSafeJobId(jobId)
      ? fs.watch(path.join(store.jobsDir, jobId)).pipe(Stream.catchCause(() => Stream.empty))
      : Stream.empty
    const triggers = Stream.merge(watchChanges, Stream.tick(REFRESH_INTERVAL)).pipe(
      Stream.debounce(WATCH_DEBOUNCE),
    )
    return Stream.concat(
      Stream.fromEffect(store.readActivity(input)),
      triggers.pipe(Stream.mapEffect(() => store.readActivity(input))),
    ).pipe(
      Stream.changesWith(
        (left, right) =>
          JSON.stringify([
            left.jobId,
            left.entries,
            left.skippedEntryCount,
            left.truncated,
            left.error,
          ]) ===
          JSON.stringify([
            right.jobId,
            right.entries,
            right.skippedEntryCount,
            right.truncated,
            right.error,
          ]),
      ),
    )
  }

  return WorkersStatusBroadcaster.of({ streamSnapshots, streamActivity })
})

export const layer = Layer.effect(WorkersStatusBroadcaster, make)
