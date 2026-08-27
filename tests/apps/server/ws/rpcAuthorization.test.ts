// tests/apps/server/ws/rpcAuthorization.test.ts
// checks workspace search authorization before its read effect can execute

import { expect, it } from '@effect/vitest'
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  WS_METHODS,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import { makeRpcAuthorization } from '../../../../apps/server/src/ws/rpcAuthorization.ts'
import type { AuthenticatedSession } from '../../../../apps/server/src/auth/EnvironmentAuth.ts'

it.effect('requires read scope for workspace content search before invoking the query', () =>
  Effect.gen(function* ()
  {
    let reads = 0
    const session: AuthenticatedSession = {
      sessionId: AuthSessionId.make('search-session'),
      subject: 'search-test',
      method: 'browser-session-cookie',
      scopes: [AuthOrchestrationOperateScope],
    }
    const denied = makeRpcAuthorization(session)
    const allowed = makeRpcAuthorization({ ...session, scopes: [AuthOrchestrationReadScope] })
    for (const method of [WS_METHODS.projectsSearchContents])
    {
      const read = Effect.sync(() => ++reads)
      const failure = yield* Effect.flip(denied.observeRpcEffect(method, read))
      expect(failure).toMatchObject({
        _tag: 'EnvironmentAuthorizationError',
        requiredScope: AuthOrchestrationReadScope,
      })
      expect(reads).toBe(0)
      yield* allowed.observeRpcEffect(method, read)
    }
    expect(reads).toBe(1)
  }),
)
