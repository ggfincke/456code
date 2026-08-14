// tests/packages/contracts/runtimeRecovery.test.ts
// verifies recovery contracts expose retry without generic success or skip overrides

import { RuntimeRecoveryReactorMutation } from '@t3tools/contracts'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

const decodeMutation = Schema.decodeUnknownEffect(RuntimeRecoveryReactorMutation)

it.effect('accepts confirmed retry and rejects generic skip or succeeded mutations', () =>
  Effect.gen(function* ()
  {
    const retry = yield* decodeMutation({
      action: 'retry',
      expectedStatus: 'manual',
      expectedUpdatedAt: '2026-08-09T00:00:00.000Z',
      confirmation: 'retry-owner-declared-idempotent',
      reason: 'dependency repaired',
    })
    assert.equal(retry.action, 'retry')

    for (const action of ['skip', 'succeeded'])
    {
      const result = yield* Effect.result(
        decodeMutation({
          action,
          expectedStatus: 'manual',
          expectedUpdatedAt: '2026-08-09T00:00:00.000Z',
          confirmation: 'operator-confirmed',
          reason: 'unsafe override',
        }),
      )
      assert.equal(result._tag, 'Failure')
    }
  }),
)
