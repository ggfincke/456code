// apps/server/src/persistence/Migrations/037_Proposals.ts
// installs immutable proposal, revision, and content-addressed blob storage

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export default Effect.gen(function* ()
{
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS proposals (
      proposal_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      producer_session_id TEXT NOT NULL,
      producer_instance_id TEXT NOT NULL,
      repository_identity_json TEXT NOT NULL,
      worktree_root_path TEXT NOT NULL,
      worktree_git_dir TEXT NOT NULL,
      worktree_git_common_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_proposals_scope_updated
    ON proposals(environment_id, project_id, source_thread_id, updated_at DESC)
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS proposal_blobs (
      sha256 TEXT PRIMARY KEY
        CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      content BLOB NOT NULL,
      byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
      created_at TEXT NOT NULL,
      CHECK(length(content) = byte_length)
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS proposal_revisions (
      revision_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      head_commit_oid TEXT NOT NULL,
      base_tree_oid TEXT NOT NULL,
      base_retained_ref TEXT NOT NULL,
      base_file_count INTEGER NOT NULL CHECK(base_file_count >= 0),
      base_byte_count INTEGER NOT NULL CHECK(base_byte_count >= 0),
      snapshot_policy_json TEXT NOT NULL,
      proposed_tree_oid TEXT NOT NULL,
      proposed_retained_ref TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL
        REFERENCES proposal_blobs(sha256),
      diff_sha256 TEXT NOT NULL
        REFERENCES proposal_blobs(sha256),
      diff_byte_length INTEGER NOT NULL CHECK(diff_byte_length >= 0),
      narrative_sha256 TEXT
        REFERENCES proposal_blobs(sha256),
      narrative_byte_length INTEGER CHECK(narrative_byte_length >= 0),
      plan_id TEXT,
      plan_markdown_sha256 TEXT,
      created_at TEXT NOT NULL,
      CHECK(
        (narrative_sha256 IS NULL AND narrative_byte_length IS NULL)
        OR
        (narrative_sha256 IS NOT NULL AND narrative_byte_length IS NOT NULL)
      ),
      UNIQUE(proposal_id, revision)
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_proposal_revisions_proposal_revision
    ON proposal_revisions(proposal_id, revision DESC)
  `
})
