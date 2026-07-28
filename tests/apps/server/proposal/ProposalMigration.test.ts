// tests/apps/server/proposal/ProposalMigration.test.ts
// verifies proposal storage installs cleanly on a brand-new database

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../../../apps/server/src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../../../../apps/server/src/persistence/NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_Proposals", (it) => {
  it.effect("creates immutable revision and content-addressed blob tables from empty state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const executed = yield* runMigrations({ toMigrationInclusive: 39 });
      const tableRows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'proposals',
            'proposal_revisions',
            'proposal_blobs',
            'proposal_generations',
            'proposal_implementation_attempts'
          )
        ORDER BY name
      `;
      const revisionIndexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'proposal_revisions'
      `;
      const revisionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(proposal_revisions)
      `;

      assert.deepStrictEqual(
        tableRows.map((row) => row.name),
        [
          "proposal_blobs",
          "proposal_generations",
          "proposal_implementation_attempts",
          "proposal_revisions",
          "proposals",
        ],
      );
      assert.isTrue(
        revisionIndexes.some((row) => row.name === "idx_proposal_revisions_proposal_revision"),
      );
      assert.isTrue(revisionColumns.some((row) => row.name === "narrative_sha256"));
      assert.isTrue(revisionColumns.some((row) => row.name === "narrative_byte_length"));
      assert.deepStrictEqual(executed.at(-1), [39, "ProposalImplementationAttempts"]);
    }),
  );
});
