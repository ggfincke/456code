// apps/server/src/persistence/Migrations/061_ProviderRuntimeInbox.ts
// adds durable canonical provider-event admission and consumer checkpoints

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE provider_runtime_inbox_control (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
      admission_mode TEXT NOT NULL CHECK (admission_mode IN ('required', 'fenced')),
      active_owner_id TEXT,
      owner_generation INTEGER NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),
      high_water_sequence INTEGER,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    INSERT INTO provider_runtime_inbox_control (
      singleton_id,
      next_sequence,
      admission_mode,
      updated_at
    )
    VALUES (1, 1, 'required', '1970-01-01T00:00:00.000Z')
  `

  yield* sql`
    CREATE TABLE provider_runtime_inbox_sessions (
      provider_kind TEXT NOT NULL CHECK (
        length(provider_kind) BETWEEN 1 AND 64
        AND substr(provider_kind, 1, 1) GLOB '[A-Za-z]'
        AND provider_kind NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      provider_instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      session_generation INTEGER NOT NULL CHECK (session_generation >= 1),
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      opened_sequence INTEGER,
      closed_sequence INTEGER,
      consumers_completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_instance_id, thread_id, session_generation),
      CHECK (
        (status = 'open' AND closed_sequence IS NULL)
        OR status = 'closed'
      )
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX provider_runtime_inbox_sessions_one_open
    ON provider_runtime_inbox_sessions(provider_instance_id, thread_id)
    WHERE status = 'open'
  `

  yield* sql`
    CREATE TABLE provider_runtime_inbox (
      sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
      provider_instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      session_generation INTEGER NOT NULL CHECK (session_generation >= 1),
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_created_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      event_digest TEXT NOT NULL,
      FOREIGN KEY (provider_instance_id, thread_id, session_generation)
        REFERENCES provider_runtime_inbox_sessions(
          provider_instance_id,
          thread_id,
          session_generation
        ),
      UNIQUE (
        provider_instance_id,
        thread_id,
        session_generation,
        source_event_id
      )
    )
  `

  yield* sql`
    CREATE INDEX provider_runtime_inbox_session_order
    ON provider_runtime_inbox(
      provider_instance_id,
      thread_id,
      session_generation,
      sequence
    )
  `

  yield* sql`
    CREATE INDEX provider_runtime_inbox_received
    ON provider_runtime_inbox(received_at, sequence)
  `

  yield* sql`
    CREATE TABLE provider_runtime_inbox_buffers (
      consumer_id TEXT PRIMARY KEY CHECK (
        consumer_id IN ('provider-runtime-ingestion', 'provider-runtime-checkpoint')
      ),
      state_version INTEGER NOT NULL CHECK (state_version >= 1),
      through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (through_sequence >= 0),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE provider_runtime_inbox_consumer_sessions (
      consumer_id TEXT NOT NULL CHECK (
        consumer_id IN ('provider-runtime-ingestion', 'provider-runtime-checkpoint')
      ),
      provider_instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      session_generation INTEGER NOT NULL CHECK (session_generation >= 1),
      through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (through_sequence >= 0),
      buffer_terminal INTEGER NOT NULL DEFAULT 0 CHECK (buffer_terminal IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (
        consumer_id,
        provider_instance_id,
        thread_id,
        session_generation
      ),
      FOREIGN KEY (provider_instance_id, thread_id, session_generation)
        REFERENCES provider_runtime_inbox_sessions(
          provider_instance_id,
          thread_id,
          session_generation
        ) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE INDEX provider_runtime_inbox_consumer_sessions_prune
    ON provider_runtime_inbox_consumer_sessions(
      provider_instance_id,
      thread_id,
      session_generation,
      consumer_id,
      buffer_terminal,
      through_sequence
    )
  `
})
