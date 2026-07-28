// tests/packages/contracts/proposal.test.ts
// verifies bounded proposal inputs and the visible immutable snapshot contract

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PROPOSAL_MAX_OPERATIONS,
  PROPOSAL_SNAPSHOT_POLICY_V1,
  ProposalChangeInput,
  ProposalPreviewUpsertInput,
  ProposalRevisionManifest,
} from "../../../packages/contracts/src/proposal.ts";

const sha256 = "a".repeat(64);

describe("proposal contracts", () => {
  it("accepts all typed operations and the fixed snapshot policy", () => {
    const decodeChanges = Schema.decodeUnknownSync(ProposalChangeInput, {
      errors: "all",
      onExcessProperty: "error",
    });

    const changes = decodeChanges({
      _tag: "typed",
      operations: [
        {
          _tag: "add",
          path: "src/added.ts",
          content: { encoding: "utf8", data: "export const added = true\n" },
        },
        {
          _tag: "modify",
          path: "src/changed.ts",
          beforeSha256: sha256,
          content: { encoding: "utf8", data: "export const changed = true\n" },
        },
        { _tag: "delete", path: "src/deleted.ts", beforeSha256: sha256 },
        {
          _tag: "rename",
          fromPath: "src/old.ts",
          toPath: "src/new.ts",
          beforeSha256: sha256,
        },
      ],
    });

    expect(changes._tag).toBe("typed");
    if (changes._tag !== "typed") {
      throw new Error("expected typed proposal changes");
    }
    expect(changes.operations).toHaveLength(4);
    expect(PROPOSAL_SNAPSHOT_POLICY_V1).toEqual({
      version: "v1",
      trackedContent: "working-tree-bytes",
      untrackedContent: "include-unignored",
      ignoredContent: "omit",
      staging: "flattened",
      submodules: "reject-dirty",
    });
  });

  it("rejects malformed hashes, empty or oversized operation sets, and bodies in manifests", () => {
    const decodeChanges = Schema.decodeUnknownSync(ProposalChangeInput, {
      errors: "all",
      onExcessProperty: "error",
    });
    const decodeManifest = Schema.decodeUnknownSync(ProposalRevisionManifest, {
      errors: "all",
      onExcessProperty: "error",
    });
    const operation = {
      _tag: "delete",
      path: "src/deleted.ts",
      beforeSha256: sha256,
    };

    expect(() => decodeChanges({ _tag: "typed", operations: [] })).toThrow();
    expect(() =>
      decodeChanges({
        _tag: "typed",
        operations: Array.from({ length: PROPOSAL_MAX_OPERATIONS + 1 }, () => operation),
      }),
    ).toThrow();
    expect(() =>
      decodeChanges({
        _tag: "typed",
        operations: [{ ...operation, beforeSha256: "not-a-hash" }],
      }),
    ).toThrow();
    expect(() =>
      decodeManifest({
        version: "v1",
        operations: [
          {
            _tag: "add",
            path: "src/added.ts",
            after: {
              sha256,
              byteLength: 1,
              gitBlobOid: "b".repeat(40),
              mode: "100644",
              content: "must not be persisted in a manifest",
            },
          },
        ],
        operationCount: 1,
        changedFileCount: 1,
        changedContentBytes: 1,
      }),
    ).toThrow();
  });

  it("keeps proposal preview input free of spoofable scope and unified patches", () => {
    const decode = Schema.decodeUnknownSync(ProposalPreviewUpsertInput, {
      errors: "all",
      onExcessProperty: "error",
    });
    const changes = {
      _tag: "typed",
      operations: [
        {
          _tag: "delete",
          path: "src/deleted.ts",
          beforeSha256: sha256,
        },
      ],
    } as const;

    expect(
      decode({
        proposalId: "proposal-contract",
        changes,
        narrativeMdx: "# Proposed change\n",
      }).changes._tag,
    ).toBe("typed");
    expect(() => decode({ changes, planMarkdownSha256: sha256 })).toThrow();
    expect(() => decode({ changes, planId: "spoofed" })).toThrow();
    expect(() => decode({ changes, environmentId: "spoofed" })).toThrow();
    expect(() =>
      decode({
        changes: {
          _tag: "unified-diff",
          diff: "diff --git a/a b/a\n",
        },
      }),
    ).toThrow();
  });
});
