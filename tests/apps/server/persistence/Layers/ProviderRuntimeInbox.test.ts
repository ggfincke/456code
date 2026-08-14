// tests/apps/server/persistence/Layers/ProviderRuntimeInbox.test.ts
// verifies provider-event admission identity, ordering, fencing, and handoff

import { assert, it } from '@effect/vitest'
import { ProviderDriverKind } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { ProviderRuntimeInboxLive } from '../../../../../apps/server/src/persistence/Layers/ProviderRuntimeInbox.ts'
import { SqlitePersistenceMemory } from '../../../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { ProviderRuntimeInbox } from '../../../../../apps/server/src/persistence/Services/ProviderRuntimeInbox.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const CODEX = ProviderDriverKind.make('codex')
const LEGACY_UNRESOLVED = ProviderDriverKind.make('legacy-unresolved')

const makeLayer = () =>
  ProviderRuntimeInboxLive.pipe(Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)))

const appendInput = (input: {
  readonly ownerId: string
  readonly ownerGeneration: number
  readonly sessionGeneration: number
  readonly sourceEventId: string
  readonly eventType?: string
  readonly eventCreatedAt?: string
  readonly eventJson?: string
  readonly eventDigest?: string
  readonly provider?: ProviderDriverKind
}) => ({
  ownerId: input.ownerId,
  ownerGeneration: input.ownerGeneration,
  provider: input.provider ?? CODEX,
  providerInstanceId: 'codex',
  threadId: 'thread-1',
  sessionGeneration: input.sessionGeneration,
  sourceEventId: input.sourceEventId,
  eventType: input.eventType ?? 'session.started',
  eventCreatedAt: input.eventCreatedAt ?? NOW,
  receivedAt: NOW,
  eventJson: input.eventJson ?? JSON.stringify({ eventId: input.sourceEventId }),
  eventDigest: input.eventDigest ?? `digest-${input.sourceEventId}`,
})

it.effect(
  'orders canonical receipt, deduplicates exactly, and rotates after terminal admission',
  () =>
    Effect.gen(function* ()
    {
      const inbox = yield* ProviderRuntimeInbox
      const owner = yield* inbox.claimAdmissionOwner({ ownerId: 'owner-a', now: NOW })
      const firstSession = yield* inbox.beginSession({
        ownerId: 'owner-a',
        ownerGeneration: owner.ownerGeneration,
        provider: CODEX,
        providerInstanceId: 'codex',
        threadId: 'thread-1',
        now: NOW,
      })

      const laterSourceTime = yield* inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: owner.ownerGeneration,
          sessionGeneration: firstSession.sessionGeneration,
          sourceEventId: 'event-later-source-time',
          eventCreatedAt: '2026-01-01T00:00:02.000Z',
        }),
      )
      const earlierSourceTime = yield* inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: owner.ownerGeneration,
          sessionGeneration: firstSession.sessionGeneration,
          sourceEventId: 'event-earlier-source-time',
          eventCreatedAt: '2026-01-01T00:00:01.000Z',
        }),
      )
      const duplicate = yield* inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: owner.ownerGeneration,
          sessionGeneration: firstSession.sessionGeneration,
          sourceEventId: 'event-later-source-time',
          eventCreatedAt: '2026-01-01T00:00:02.000Z',
        }),
      )
      const collision = yield* Effect.flip(
        inbox.append(
          appendInput({
            ownerId: 'owner-a',
            ownerGeneration: owner.ownerGeneration,
            sessionGeneration: firstSession.sessionGeneration,
            sourceEventId: 'event-later-source-time',
            eventCreatedAt: '2026-01-01T00:00:02.000Z',
            eventJson: '{"changed":true}',
            eventDigest: 'changed-digest',
          }),
        ),
      )
      const terminal = yield* inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: owner.ownerGeneration,
          sessionGeneration: firstSession.sessionGeneration,
          sourceEventId: 'event-terminal',
          eventType: 'session.exited',
        }),
      )
      const fallbackAfterNative = yield* inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: owner.ownerGeneration,
          sessionGeneration: firstSession.sessionGeneration,
          sourceEventId: 'event-terminal-fallback',
          eventType: 'session.exited',
        }),
      )
      const repeatedNonterminalAfterClose = yield* Effect.flip(
        inbox.append(
          appendInput({
            ownerId: 'owner-a',
            ownerGeneration: owner.ownerGeneration,
            sessionGeneration: firstSession.sessionGeneration,
            sourceEventId: 'event-later-source-time',
            eventCreatedAt: '2026-01-01T00:00:02.000Z',
          }),
        ),
      )
      const late = yield* Effect.flip(
        inbox.append(
          appendInput({
            ownerId: 'owner-a',
            ownerGeneration: owner.ownerGeneration,
            sessionGeneration: firstSession.sessionGeneration,
            sourceEventId: 'event-after-terminal',
          }),
        ),
      )
      const secondSession = yield* inbox.beginSession({
        ownerId: 'owner-a',
        ownerGeneration: owner.ownerGeneration,
        provider: LEGACY_UNRESOLVED,
        providerInstanceId: 'codex',
        threadId: 'thread-1',
        now: '2026-01-01T00:01:00.000Z',
      })
      const restarted = yield* inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: owner.ownerGeneration,
          sessionGeneration: secondSession.sessionGeneration,
          sourceEventId: 'event-restarted',
          provider: LEGACY_UNRESOLVED,
        }),
      )
      const fallbackTerminal = yield* inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: owner.ownerGeneration,
          sessionGeneration: secondSession.sessionGeneration,
          sourceEventId: 'event-fallback-terminal',
          eventType: 'session.exited',
          provider: LEGACY_UNRESOLVED,
        }),
      )
      const nativeAfterFallback = yield* inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: owner.ownerGeneration,
          sessionGeneration: secondSession.sessionGeneration,
          sourceEventId: 'event-native-terminal',
          eventType: 'session.exited',
        }),
      )

      assert.equal(laterSourceTime.record.sequence, 1)
      assert.equal(earlierSourceTime.record.sequence, 2)
      assert.equal(duplicate.duplicate, true)
      assert.equal(duplicate.record.sequence, 1)
      assert.equal(collision._tag, 'ProviderRuntimeInboxAdmissionError')
      if (collision._tag === 'ProviderRuntimeInboxAdmissionError')
      {
        assert.equal(collision.reason, 'event-collision')
      }
      assert.equal(terminal.record.sequence, 3)
      assert.isTrue(fallbackAfterNative.duplicate)
      assert.isTrue(fallbackAfterNative.terminalAlreadyClosed)
      assert.equal(fallbackAfterNative.record.sequence, terminal.record.sequence)
      assert.equal(repeatedNonterminalAfterClose._tag, 'ProviderRuntimeInboxAdmissionError')
      if (repeatedNonterminalAfterClose._tag === 'ProviderRuntimeInboxAdmissionError')
      {
        assert.equal(repeatedNonterminalAfterClose.reason, 'session-closed')
      }
      assert.equal(late._tag, 'ProviderRuntimeInboxAdmissionError')
      if (late._tag === 'ProviderRuntimeInboxAdmissionError')
      {
        assert.equal(late.reason, 'session-closed')
      }
      assert.equal(secondSession.sessionGeneration, firstSession.sessionGeneration + 1)
      assert.equal(restarted.record.sequence, 4)
      assert.equal(fallbackTerminal.record.sequence, 5)
      assert.isFalse(fallbackTerminal.terminalAlreadyClosed)
      assert.isTrue(nativeAfterFallback.duplicate)
      assert.isTrue(nativeAfterFallback.terminalAlreadyClosed)
      assert.equal(nativeAfterFallback.record.sequence, fallbackTerminal.record.sequence)
      assert.deepStrictEqual(
        (yield* inbox.readPage({ afterSequence: 0, limit: 10 })).map(
          (record) => record.sourceEventId,
        ),
        [
          'event-later-source-time',
          'event-earlier-source-time',
          'event-terminal',
          'event-restarted',
          'event-fallback-terminal',
        ],
      )
    }).pipe(Effect.provide(makeLayer())),
)

it.effect('fences crash and graceful handoffs until both durable consumers catch up', () =>
  Effect.gen(function* ()
  {
    const inbox = yield* ProviderRuntimeInbox
    const sql = yield* SqlClient.SqlClient
    const setConsumerCursor = (consumerId: string, sequence: number, now: string) => sql`
      INSERT INTO orchestration_reactor_progress (
        reactor_id,
        operation_version,
        mode,
        cursor_sequence,
        shadow_cursor_sequence,
        updated_at
      )
      VALUES (${consumerId}, 1, 'durable', ${sequence}, ${sequence}, ${now})
      ON CONFLICT (reactor_id) DO UPDATE SET
        cursor_sequence = excluded.cursor_sequence,
        shadow_cursor_sequence = excluded.shadow_cursor_sequence,
        updated_at = excluded.updated_at
    `
    const ownerA = yield* inbox.claimAdmissionOwner({ ownerId: 'owner-a', now: NOW })
    const session = yield* inbox.beginSession({
      ownerId: 'owner-a',
      ownerGeneration: ownerA.ownerGeneration,
      provider: CODEX,
      providerInstanceId: 'codex',
      threadId: 'thread-1',
      now: NOW,
    })
    yield* inbox.append(
      appendInput({
        ownerId: 'owner-a',
        ownerGeneration: ownerA.ownerGeneration,
        sessionGeneration: session.sessionGeneration,
        sourceEventId: 'event-a-1',
      }),
    )
    const ownerB = yield* inbox.claimAdmissionOwner({
      ownerId: 'owner-b',
      now: '2026-01-01T00:00:01.000Z',
    })
    const staleA = yield* Effect.flip(
      inbox.beginSession({
        ownerId: 'owner-a',
        ownerGeneration: ownerA.ownerGeneration,
        provider: CODEX,
        providerInstanceId: 'codex',
        threadId: 'thread-1',
        now: '2026-01-01T00:00:01.000Z',
      }),
    )
    const fencedBAppend = yield* Effect.flip(
      inbox.append(
        appendInput({
          ownerId: 'owner-b',
          ownerGeneration: ownerB.ownerGeneration,
          sessionGeneration: session.sessionGeneration,
          sourceEventId: 'event-b-before-catch-up',
        }),
      ),
    )
    const resumeBeforeEither = yield* Effect.flip(
      inbox.resumeAdmissionAfterHandoff({
        ownerId: 'owner-b',
        ownerGeneration: ownerB.ownerGeneration,
        now: '2026-01-01T00:00:02.000Z',
      }),
    )
    yield* setConsumerCursor('provider-runtime-ingestion', 1, '2026-01-01T00:00:03.000Z')
    const resumeBeforeCheckpoint = yield* Effect.flip(
      inbox.resumeAdmissionAfterHandoff({
        ownerId: 'owner-b',
        ownerGeneration: ownerB.ownerGeneration,
        now: '2026-01-01T00:00:03.000Z',
      }),
    )
    yield* setConsumerCursor('provider-runtime-checkpoint', 1, '2026-01-01T00:00:04.000Z')
    const resumedB = yield* inbox.resumeAdmissionAfterHandoff({
      ownerId: 'owner-b',
      ownerGeneration: ownerB.ownerGeneration,
      now: '2026-01-01T00:00:04.000Z',
    })
    const fromB = yield* inbox.append(
      appendInput({
        ownerId: 'owner-b',
        ownerGeneration: ownerB.ownerGeneration,
        sessionGeneration: session.sessionGeneration,
        sourceEventId: 'event-b-1',
      }),
    )
    yield* inbox.setAdmissionMode({
      ownerId: 'owner-b',
      ownerGeneration: ownerB.ownerGeneration,
      mode: 'fenced',
      now: '2026-01-01T00:00:05.000Z',
    })
    const ownerAAgain = yield* inbox.claimAdmissionOwner({
      ownerId: 'owner-a',
      now: '2026-01-01T00:00:06.000Z',
    })
    yield* setConsumerCursor('provider-runtime-ingestion', 2, '2026-01-01T00:00:07.000Z')
    yield* setConsumerCursor('provider-runtime-checkpoint', 2, '2026-01-01T00:00:07.000Z')
    const resumedA = yield* inbox.resumeAdmissionAfterHandoff({
      ownerId: 'owner-a',
      ownerGeneration: ownerAAgain.ownerGeneration,
      now: '2026-01-01T00:00:07.000Z',
    })
    const fromA = yield* inbox.append(
      appendInput({
        ownerId: 'owner-a',
        ownerGeneration: ownerAAgain.ownerGeneration,
        sessionGeneration: session.sessionGeneration,
        sourceEventId: 'event-a-2',
      }),
    )
    yield* inbox.setAdmissionMode({
      ownerId: 'owner-a',
      ownerGeneration: ownerAAgain.ownerGeneration,
      mode: 'fenced',
      now: '2026-01-01T00:00:08.000Z',
    })
    yield* setConsumerCursor('provider-runtime-ingestion', 3, '2026-01-01T00:00:09.000Z')
    yield* setConsumerCursor('provider-runtime-checkpoint', 3, '2026-01-01T00:00:09.000Z')
    const ownerBAgain = yield* inbox.claimAdmissionOwner({
      ownerId: 'owner-b',
      now: '2026-01-01T00:00:10.000Z',
    })
    const staleAAppend = yield* Effect.flip(
      inbox.append(
        appendInput({
          ownerId: 'owner-a',
          ownerGeneration: ownerAAgain.ownerGeneration,
          sessionGeneration: session.sessionGeneration,
          sourceEventId: 'event-a-stale',
        }),
      ),
    )
    const fromBAgain = yield* inbox.append(
      appendInput({
        ownerId: 'owner-b',
        ownerGeneration: ownerBAgain.ownerGeneration,
        sessionGeneration: session.sessionGeneration,
        sourceEventId: 'event-b-2',
      }),
    )

    assert.equal(ownerB.ownerGeneration, ownerA.ownerGeneration + 1)
    assert.equal(ownerB.mode, 'fenced')
    assert.equal(ownerB.highWaterSequence, 1)
    assert.equal(staleA._tag, 'ProviderRuntimeInboxAdmissionError')
    if (staleA._tag === 'ProviderRuntimeInboxAdmissionError')
    {
      assert.equal(staleA.reason, 'owner-fenced')
    }
    assert.equal(fencedBAppend._tag, 'ProviderRuntimeInboxAdmissionError')
    if (fencedBAppend._tag === 'ProviderRuntimeInboxAdmissionError')
    {
      assert.equal(fencedBAppend.reason, 'fenced')
    }
    assert.equal(resumeBeforeEither._tag, 'ProviderRuntimeInboxAdmissionError')
    if (resumeBeforeEither._tag === 'ProviderRuntimeInboxAdmissionError')
    {
      assert.equal(resumeBeforeEither.reason, 'handoff-incomplete')
    }
    assert.equal(resumeBeforeCheckpoint._tag, 'ProviderRuntimeInboxAdmissionError')
    if (resumeBeforeCheckpoint._tag === 'ProviderRuntimeInboxAdmissionError')
    {
      assert.equal(resumeBeforeCheckpoint.reason, 'handoff-incomplete')
    }
    assert.equal(resumedB.mode, 'required')
    assert.equal(fromB.record.sequence, 2)
    assert.equal(ownerAAgain.ownerGeneration, ownerB.ownerGeneration + 1)
    assert.equal(ownerAAgain.mode, 'fenced')
    assert.equal(ownerAAgain.highWaterSequence, 2)
    assert.equal(resumedA.mode, 'required')
    assert.equal(fromA.record.sequence, 3)
    assert.equal(ownerBAgain.ownerGeneration, ownerAAgain.ownerGeneration + 1)
    assert.equal(ownerBAgain.mode, 'required')
    assert.equal(ownerBAgain.highWaterSequence, null)
    assert.equal(staleAAppend._tag, 'ProviderRuntimeInboxAdmissionError')
    if (staleAAppend._tag === 'ProviderRuntimeInboxAdmissionError')
    {
      assert.equal(staleAAppend.reason, 'owner-fenced')
    }
    assert.equal(fromBAgain.record.sequence, 4)
  }).pipe(Effect.provide(makeLayer())),
)

it.effect('persists self-sufficient provider identity after a route is removed', () =>
  Effect.gen(function* ()
  {
    const inbox = yield* ProviderRuntimeInbox
    const provider = ProviderDriverKind.make('opencode')
    const owner = yield* inbox.claimAdmissionOwner({ ownerId: 'owner-removed', now: NOW })
    const session = yield* inbox.beginSession({
      ownerId: 'owner-removed',
      ownerGeneration: owner.ownerGeneration,
      provider,
      providerInstanceId: 'removed-route',
      threadId: 'thread-orphaned',
      now: NOW,
    })
    const admitted = yield* inbox.append({
      ownerId: 'owner-removed',
      ownerGeneration: owner.ownerGeneration,
      provider,
      providerInstanceId: 'removed-route',
      threadId: 'thread-orphaned',
      sessionGeneration: session.sessionGeneration,
      sourceEventId: 'event-removed-route',
      eventType: 'session.started',
      eventCreatedAt: NOW,
      receivedAt: NOW,
      eventJson: '{"provider":"opencode"}',
      eventDigest: 'digest-removed-route',
    })
    const mismatchedAppend = yield* inbox
      .append({
        ownerId: 'owner-removed',
        ownerGeneration: owner.ownerGeneration,
        provider: CODEX,
        providerInstanceId: 'removed-route',
        threadId: 'thread-orphaned',
        sessionGeneration: session.sessionGeneration,
        sourceEventId: 'event-wrong-provider',
        eventType: 'session.started',
        eventCreatedAt: NOW,
        receivedAt: NOW,
        eventJson: '{"provider":"codex"}',
        eventDigest: 'digest-wrong-provider',
      })
      .pipe(Effect.flip)

    const current = yield* inbox.getCurrentSession({
      providerInstanceId: 'removed-route',
      threadId: 'thread-orphaned',
    })
    const exact = yield* inbox.getSession(session)
    const wrongProvider = yield* inbox.getSession({
      provider: CODEX,
      providerInstanceId: session.providerInstanceId,
      threadId: session.threadId,
      sessionGeneration: session.sessionGeneration,
    })
    const byInstance = yield* inbox.listOpenSessions('removed-route')
    const allOpen = yield* inbox.listAllOpenSessions()
    const exactMatch = yield* inbox.matchesCurrentSession(session)
    const wrongProviderMatch = yield* inbox.matchesCurrentSession({
      provider: CODEX,
      providerInstanceId: session.providerInstanceId,
      threadId: session.threadId,
      sessionGeneration: session.sessionGeneration,
    })
    const mismatchedRestart = yield* inbox
      .beginSession({
        ownerId: 'owner-removed',
        ownerGeneration: owner.ownerGeneration,
        provider: CODEX,
        providerInstanceId: 'removed-route',
        threadId: 'thread-orphaned',
        now: '2026-01-01T00:00:01.000Z',
      })
      .pipe(Effect.flip)

    assert.equal(session.provider, provider)
    assert.equal(admitted.record.provider, provider)
    assert.isFalse(admitted.terminalAlreadyClosed)
    assert.equal(mismatchedAppend._tag, 'ProviderRuntimeInboxAdmissionError')
    if (mismatchedAppend._tag === 'ProviderRuntimeInboxAdmissionError')
    {
      assert.equal(mismatchedAppend.reason, 'session-provider-mismatch')
    }
    assert.equal(current._tag, 'Some')
    if (current._tag === 'Some')
    {
      assert.equal(current.value.provider, provider)
    }
    assert.equal(exact._tag, 'Some')
    if (exact._tag === 'Some')
    {
      assert.equal(exact.value.status, 'open')
      assert.equal(exact.value.openedSequence, admitted.record.sequence)
    }
    assert.equal(wrongProvider._tag, 'None')
    assert.deepStrictEqual(
      byInstance.map((entry) => entry.provider),
      [provider],
    )
    assert.deepStrictEqual(
      allOpen.map((entry) => entry.provider),
      [provider],
    )
    assert.isTrue(exactMatch)
    assert.isFalse(wrongProviderMatch)
    assert.equal(mismatchedRestart._tag, 'ProviderRuntimeInboxAdmissionError')
    if (mismatchedRestart._tag === 'ProviderRuntimeInboxAdmissionError')
    {
      assert.equal(mismatchedRestart.reason, 'session-provider-mismatch')
    }
  }).pipe(Effect.provide(makeLayer())),
)
