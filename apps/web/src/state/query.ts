// apps/web/src/state/query.ts
// manage environment query view state

import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import * as Cause from 'effect/Cause'
import * as Option from 'effect/Option'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel('web-environment-query:empty'),
)

export interface EnvironmentQueryView<A>
{
  readonly data: A | null
  readonly error: string | null
  readonly failure: unknown | null
  readonly isPending: boolean
  // whether the query has produced a result at least once. `waiting` is an overlay on any
  // variant, so isPending alone cannot separate the initial load from a refresh; consumers
  // where null is a valid settled value need this to avoid flickering on every revalidation
  readonly hasSettled: boolean
  readonly refresh: () => void
}

function formatError(error: unknown): string
{
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'The environment request failed.'
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A>
{
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM
  const result = useAtomValue(selectedAtom)
  const refresh = useAtomRefresh(selectedAtom)
  const failure = result._tag === 'Failure' ? Cause.squash(result.cause) : null
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: failure === null ? null : formatError(failure),
    failure,
    isPending: atom !== null && result.waiting,
    hasSettled: atom !== null && !AsyncResult.isInitial(result),
    refresh,
  }
}
