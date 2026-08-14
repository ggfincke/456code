// tests/apps/server/support/providerRuntimeInbox.ts
// provides durable provider-event admission and runner wiring for server tests

import * as NodeCrypto from 'node:crypto'

import type { ProviderRuntimeEvent } from '@t3tools/contracts'
import { stableStringify } from '@t3tools/shared/relaySigning'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { ProviderRuntimeInboxLive } from '../../../../apps/server/src/persistence/Layers/ProviderRuntimeInbox.ts'
import { OrchestrationReactorDeliveryLive } from '../../../../apps/server/src/persistence/Layers/OrchestrationReactorDelivery.ts'
import { SqlitePersistenceMemory } from '../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { ProviderRuntimeInbox } from '../../../../apps/server/src/persistence/Services/ProviderRuntimeInbox.ts'
import { ProviderRuntimeInboxRunnerLive } from '../../../../apps/server/src/orchestration/Layers/ProviderRuntimeInboxRunner.ts'

const providerRuntimeInboxPersistenceTestLive = Layer.merge(
  ProviderRuntimeInboxLive,
  OrchestrationReactorDeliveryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory))

export const ProviderRuntimeInboxTestInfrastructureLive = Layer.merge(
  providerRuntimeInboxPersistenceTestLive,
  ProviderRuntimeInboxRunnerLive.pipe(Layer.provide(providerRuntimeInboxPersistenceTestLive)),
)

class ProviderRuntimeInboxTestAdmissionError extends Schema.TaggedErrorClass<ProviderRuntimeInboxTestAdmissionError>()(
  'ProviderRuntimeInboxTestAdmissionError',
  { detail: Schema.String },
)
{
  override get message(): string
  {
    return this.detail
  }
}

export const makeProviderRuntimeInboxTestAdmission = Effect.gen(function* ()
{
  const inbox = yield* ProviderRuntimeInbox
  const owner = yield* inbox.claimAdmissionOwner({
    ownerId: 'provider-runtime-inbox-test-owner',
    now: '2026-01-01T00:00:00.000Z',
  })
  const sessions = new Map<string, { readonly generation: number; closed: boolean }>()

  const append = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* ()
    {
      if (event.providerInstanceId === undefined)
      {
        return yield* new ProviderRuntimeInboxTestAdmissionError({
          detail: 'provider runtime inbox test events require providerInstanceId',
        })
      }
      const key = `${event.providerInstanceId}\u0000${event.threadId}`
      let session = sessions.get(key)
      if (session === undefined || (session.closed && event.type === 'session.started'))
      {
        const started = yield* inbox.beginSession({
          ownerId: 'provider-runtime-inbox-test-owner',
          ownerGeneration: owner.ownerGeneration,
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          now: event.createdAt,
        })
        session = { generation: started.sessionGeneration, closed: false }
        sessions.set(key, session)
      }
      const eventJson = stableStringify(event)
      const appended = yield* inbox.append({
        ownerId: 'provider-runtime-inbox-test-owner',
        ownerGeneration: owner.ownerGeneration,
        provider: event.provider,
        providerInstanceId: event.providerInstanceId,
        threadId: event.threadId,
        sessionGeneration: session.generation,
        sourceEventId: event.eventId,
        eventType: event.type,
        eventCreatedAt: event.createdAt,
        receivedAt: event.createdAt,
        eventJson,
        eventDigest: NodeCrypto.createHash('sha256').update(eventJson).digest('hex'),
      })
      if (event.type === 'session.exited')
      {
        session.closed = true
      }
      return appended
    })

  return { append }
})
