// packages/client-runtime/src/state/workers.ts
// environment atoms for the read-only worker-broker jobs surface

import { WS_METHODS } from '@t3tools/contracts'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import { Atom } from 'effect/unstable/reactivity'

import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from './runtime.ts'
import type { EnvironmentRegistry } from '../connection/registry.ts'
import { request, subscribe, type EnvironmentRpcInput } from '../rpc/client.ts'

const FALLBACK_REFRESH_INTERVAL = Duration.seconds(30)

function workerSnapshots(input: EnvironmentRpcInput<typeof WS_METHODS.workersSubscribe>)
{
  return subscribe(WS_METHODS.workersSubscribe, input).pipe(
    Stream.catchCause(() =>
      Stream.tick(FALLBACK_REFRESH_INTERVAL).pipe(
        Stream.mapEffect(() =>
          Effect.all({
            list: request(WS_METHODS.workersList, input),
            runs: request(WS_METHODS.workersListRuns, {}).pipe(
              Effect.map((result) => ({
                ...result,
                runs:
                  input.run === undefined
                    ? result.runs
                    : result.runs.filter((summary) => summary.run === input.run),
              })),
            ),
          }),
        ),
      ),
    ),
  )
}

export function createWorkersEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
)
{
  const list = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: 'environment-data:workers:list',
    subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.workersSubscribe>) =>
      workerSnapshots(input).pipe(Stream.map((snapshot) => snapshot.list)),
  })
  const listRuns = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: 'environment-data:workers:listRuns',
    subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.workersSubscribe>) =>
      workerSnapshots(input).pipe(Stream.map((snapshot) => snapshot.runs)),
  })
  const getRun = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: 'environment-data:workers:getRun',
    subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.workersSubscribe>) =>
      workerSnapshots(input).pipe(
        Stream.map((snapshot) =>
        {
          const run = snapshot.runs.runs[0]
          return {
            readAt: snapshot.list.readAt,
            run: Option.fromNullishOr(run),
            jobs: snapshot.list.jobs,
            error:
              run === undefined
                ? Option.some({
                    message: `Worker-broker run was not found.`,
                  })
                : snapshot.list.error,
          }
        }),
      ),
  })

  return {
    readiness: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: 'environment-data:workers:readiness',
      tag: WS_METHODS.workersReadiness,
    }),
    list,
    listByRun: list,
    listRuns,
    getJob: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: 'environment-data:workers:getJob',
      tag: WS_METHODS.workersGetJob,
      staleTimeMs: 30_000,
      refreshIntervalMs: 30_000,
    }),
    activity: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: 'environment-data:workers:activity',
      idleTtlMs: 0,
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.workersSubscribeActivity>) =>
        subscribe(WS_METHODS.workersSubscribeActivity, input),
    }),
    getRun,
  }
}
