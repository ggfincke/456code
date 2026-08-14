// tests/apps/server/recovery/http.test.ts
// verifies recovery mutations require explicitly reissued recovery credentials

import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  AuthOrchestrationRecoverScope,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentAuthenticatedPrincipal,
} from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { requireRuntimeRecoveryMutationPrincipal } from '../../../../apps/server/src/recovery/http.ts'

const principal = (
  subject: string,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): EnvironmentAuthenticatedPrincipal['Service'] => ({
  sessionId: AuthSessionId.make(`session-${subject}`),
  subject,
  method: 'bearer-access-token',
  scopes: new Set(scopes),
})

const requireMutation = (candidate: EnvironmentAuthenticatedPrincipal['Service']) =>
  requireRuntimeRecoveryMutationPrincipal().pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, candidate),
  )

it.effect('denies old/default admin and ordinary clients but allows explicit recovery scope', () =>
  Effect.gen(function* ()
  {
    assert.notInclude(AuthAdministrativeScopes, AuthOrchestrationRecoverScope)
    assert.notInclude(AuthStandardClientScopes, AuthOrchestrationRecoverScope)

    const oldAdmin = yield* requireMutation(principal('old-admin', AuthAdministrativeScopes)).pipe(
      Effect.flip,
    )
    const ordinaryClient = yield* requireMutation(
      principal('ordinary-client', AuthStandardClientScopes),
    ).pipe(Effect.flip)
    assert.equal(oldAdmin._tag, 'EnvironmentScopeRequiredError')
    assert.equal(ordinaryClient._tag, 'EnvironmentScopeRequiredError')
    if (oldAdmin._tag === 'EnvironmentScopeRequiredError')
    {
      assert.equal(oldAdmin.requiredScope, AuthOrchestrationRecoverScope)
    }

    const explicitRecovery = yield* requireMutation(
      principal('explicit-recovery', [...AuthAdministrativeScopes, AuthOrchestrationRecoverScope]),
    )
    assert.equal(explicitRecovery.subject, 'explicit-recovery')
    assert.isTrue(explicitRecovery.scopes.has(AuthOrchestrationRecoverScope))
  }),
)
