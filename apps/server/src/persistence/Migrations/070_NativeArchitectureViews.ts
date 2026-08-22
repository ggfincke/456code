// apps/server/src/persistence/Migrations/070_NativeArchitectureViews.ts
// installs immutable planned-impact storage and durable architecture admissions

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS architecture_planned_impact_publications (
      publication_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      plan_kind TEXT NOT NULL CHECK(plan_kind IN ('plan', 'orchestrate')),
      plan_identity_key TEXT NOT NULL,
      plan_id TEXT,
      orchestrate_run_id TEXT,
      orchestrate_revision INTEGER CHECK(orchestrate_revision >= 0),
      publication_revision INTEGER NOT NULL CHECK(publication_revision >= 1),
      content_digest TEXT NOT NULL
        CHECK(length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
      canonical_payload_json TEXT NOT NULL
        CHECK(json_valid(canonical_payload_json) AND length(CAST(canonical_payload_json AS BLOB)) <= 262144),
      supersedes_publication_id TEXT
        REFERENCES architecture_planned_impact_publications(publication_id),
      created_at TEXT NOT NULL,
      CHECK(
        (plan_kind = 'plan' AND plan_id IS NOT NULL AND orchestrate_run_id IS NULL AND orchestrate_revision IS NULL)
        OR
        (plan_kind = 'orchestrate' AND plan_id IS NULL AND orchestrate_run_id IS NOT NULL AND orchestrate_revision IS NOT NULL)
      ),
      UNIQUE(source_thread_id, plan_identity_key, publication_revision),
      UNIQUE(source_thread_id, plan_identity_key, content_digest),
      UNIQUE(publication_id, publication_revision),
      UNIQUE(publication_id, publication_revision, content_digest)
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_planned_impact_publications_active
    ON architecture_planned_impact_publications(
      source_thread_id,
      plan_identity_key,
      publication_revision DESC
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS architecture_planned_impact_projections (
      projection_id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL
        REFERENCES architecture_planned_impact_publications(publication_id) ON DELETE CASCADE,
      publication_revision INTEGER NOT NULL CHECK(publication_revision >= 1),
      projection_revision INTEGER NOT NULL CHECK(projection_revision >= 1),
      materialization TEXT NOT NULL CHECK(materialization IN ('provisional', 'anchored', 'no-impact')),
      projection_json TEXT NOT NULL CHECK(
        json_valid(projection_json)
        AND length(CAST(projection_json AS BLOB)) <= 2097152
      ),
      projection_digest TEXT NOT NULL
        CHECK(length(projection_digest) = 64 AND projection_digest NOT GLOB '*[^0-9a-f]*'),
      standing_generation_id TEXT,
      standing_graph_digest TEXT,
      created_at TEXT NOT NULL,
      CHECK(
        (materialization = 'anchored' AND standing_generation_id IS NOT NULL AND standing_graph_digest IS NOT NULL)
        OR
        (materialization <> 'anchored' AND standing_generation_id IS NULL AND standing_graph_digest IS NULL)
      ),
      UNIQUE(publication_id, projection_revision),
      FOREIGN KEY(publication_id, publication_revision)
        REFERENCES architecture_planned_impact_publications(publication_id, publication_revision)
        ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_planned_impact_projections_latest
    ON architecture_planned_impact_projections(publication_id, projection_revision DESC)
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS proposal_revision_planned_impacts (
      revision_id TEXT PRIMARY KEY
        REFERENCES proposal_revisions(revision_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL,
      proposal_revision INTEGER NOT NULL CHECK(proposal_revision >= 1),
      publication_id TEXT NOT NULL,
      publication_revision INTEGER NOT NULL CHECK(publication_revision >= 1),
      content_digest TEXT NOT NULL
        CHECK(length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL,
      FOREIGN KEY(proposal_id, proposal_revision)
        REFERENCES proposal_revisions(proposal_id, revision) ON DELETE CASCADE,
      FOREIGN KEY(publication_id, publication_revision, content_digest)
        REFERENCES architecture_planned_impact_publications(
          publication_id,
          publication_revision,
          content_digest
        )
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_proposal_revision_planned_impacts_publication
    ON proposal_revision_planned_impacts(publication_id, publication_revision)
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS architecture_analysis_admissions (
      admission_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('planned-anchor', 'proposal-verified')),
      admission_key TEXT NOT NULL UNIQUE,
      target_json TEXT NOT NULL
        CHECK(
          json_valid(target_json)
          AND length(CAST(target_json AS BLOB)) <= 65536
          AND json_extract(target_json, '$._tag') = kind
        ),
      state TEXT NOT NULL CHECK(
        state IN ('queued', 'leased', 'complete', 'retry-wait', 'terminal-failed', 'cancelled')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      lease_owner TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
      lease_expires_at TEXT,
      next_attempt_at TEXT,
      last_error_class TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
      )
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_architecture_analysis_admissions_due
    ON architecture_analysis_admissions(state, next_attempt_at, created_at)
    WHERE state IN ('queued', 'retry-wait')
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_architecture_analysis_admissions_expired_lease
    ON architecture_analysis_admissions(lease_expires_at, admission_id)
    WHERE state = 'leased'
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_architecture_analysis_admissions_completed_proposal
    ON architecture_analysis_admissions(kind, state, created_at, admission_id)
    WHERE kind = 'proposal-verified' AND state = 'complete'
  `

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_architecture_analysis_admission_identity_immutable
    BEFORE UPDATE OF kind, admission_key, target_json ON architecture_analysis_admissions
    WHEN
      NEW.kind <> OLD.kind
      OR NEW.admission_key <> OLD.admission_key
      OR NEW.target_json <> OLD.target_json
    BEGIN
      SELECT RAISE(ABORT, 'architecture admission identity is immutable');
    END
  `

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_planned_impact_publications_immutable
    BEFORE UPDATE ON architecture_planned_impact_publications
    BEGIN
      SELECT RAISE(ABORT, 'planned impact publications are immutable');
    END
  `

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_planned_impact_projections_immutable
    BEFORE UPDATE ON architecture_planned_impact_projections
    BEGIN
      SELECT RAISE(ABORT, 'planned impact projections are immutable');
    END
  `

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_proposal_revision_planned_impacts_immutable
    BEFORE UPDATE ON proposal_revision_planned_impacts
    BEGIN
      SELECT RAISE(ABORT, 'proposal planned-impact links are immutable');
    END
  `

  const proposalGenerationColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(proposal_generations)
  `
  if (!proposalGenerationColumns.some((column) => column.name === 'impact_projection_path'))
  {
    yield* sql`
      ALTER TABLE proposal_generations
      ADD COLUMN impact_projection_path TEXT
    `
  }
  if (!proposalGenerationColumns.some((column) => column.name === 'architecture_admission_key'))
  {
    yield* sql`
      ALTER TABLE proposal_generations
      ADD COLUMN architecture_admission_key TEXT
    `
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_proposal_generations_architecture_admission
    ON proposal_generations(architecture_admission_key, state, created_at DESC)
    WHERE architecture_admission_key IS NOT NULL
  `

  const diffAnalysisColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(diff_analysis_generations)
  `
  if (!diffAnalysisColumns.some((column) => column.name === 'impact_projection_path'))
  {
    yield* sql`
      ALTER TABLE diff_analysis_generations
      ADD COLUMN impact_projection_path TEXT
    `
  }
  if (!diffAnalysisColumns.some((column) => column.name === 'implementation_changed_file_count'))
  {
    yield* sql`
      ALTER TABLE diff_analysis_generations
      ADD COLUMN implementation_changed_file_count INTEGER
        CHECK (
          implementation_changed_file_count IS NULL OR
          implementation_changed_file_count >= 0
        )
    `
  }
})
