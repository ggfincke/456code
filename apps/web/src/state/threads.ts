// apps/web/src/state/threads.ts
// provides environment-scoped thread state and web-local commands
import { useAtomValue } from '@effect/atom-react'
import { request } from '@t3tools/client-runtime/rpc'
import { createEnvironmentCommand } from '@t3tools/client-runtime/state/runtime'
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from '@t3tools/client-runtime/state/threads'
import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type ThreadId,
  type ThreadProviderSwitchCommand,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'

import { environmentCatalog } from '../connection/catalog'
import { connectionAtomRuntime } from '../connection/runtime'
import { environmentSnapshotAtom } from './shell'

type SwitchThreadProviderInput = Omit<ThreadProviderSwitchCommand, 'type' | 'commandId'> & {
  readonly commandId?: CommandId
}

const switchThreadProvider = Effect.fn('WebEnvironmentCommands.switchThreadProvider')(function* (
  input: SwitchThreadProviderInput,
)
{
  const commandId =
    input.commandId ??
    (yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.orDie,
      Effect.map(CommandId.make),
    ))
  return yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, {
    ...input,
    type: 'thread.provider.switch',
    commandId,
  })
})

export const threadEnvironment = {
  ...createThreadEnvironmentAtoms(connectionAtomRuntime),
  switchProvider: createEnvironmentCommand(connectionAtomRuntime, {
    label: 'environment-data:commands:thread:switch-provider',
    execute: switchThreadProvider,
  }),
}
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime)
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
)
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
})

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel('web-environment-thread:empty'),
)

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState
{
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  )
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState
}
