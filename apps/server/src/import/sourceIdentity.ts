// apps/server/src/import/sourceIdentity.ts
// validates that native session ids agree with their trusted import source identity
// @effect-diagnostics nodeBuiltinImport:off

import * as NodePath from "node:path";

import type { ImportedSessionMeta } from "./types.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPENCODE_SESSION_ID_PATTERN = /^ses_[a-zA-Z0-9_-]+$/;

export function importedSessionSourceIdentityIssue(meta: ImportedSessionMeta): string | null {
  const nativeSessionId = meta.nativeSessionId;
  const sourceFileName = NodePath.basename(meta.sourcePath);

  switch (meta.source) {
    case "codex-cli":
      if (nativeSessionId === null) {
        return "rollout has no session id";
      }
      return sourceFileName.endsWith(`-${nativeSessionId}.jsonl`)
        ? null
        : "codex session id does not match the rollout filename";

    case "claude-code":
      if (nativeSessionId === null || !CLAUDE_SESSION_ID_PATTERN.test(nativeSessionId)) {
        return "claude session id is not a uuid";
      }
      return sourceFileName === `${nativeSessionId}.jsonl`
        ? null
        : "claude session id does not match the transcript filename";

    case "opencode":
      if (nativeSessionId === null || !OPENCODE_SESSION_ID_PATTERN.test(nativeSessionId)) {
        return "opencode session id is invalid";
      }
      return sourceFileName === `${nativeSessionId}.json`
        ? null
        : "opencode session id does not match the metadata filename";

    case "cursor":
    case "grok": {
      if (nativeSessionId === null) {
        return `${meta.source} session has no native id`;
      }
      const prefix = `acp://${meta.source}/`;
      const segments = meta.sourcePath.startsWith(prefix)
        ? meta.sourcePath.slice(prefix.length).split("/")
        : [];
      try {
        return segments.length === 2 &&
          decodeURIComponent(segments[0] ?? "").trim().length > 0 &&
          decodeURIComponent(segments[1] ?? "") === nativeSessionId
          ? null
          : `${meta.source} session id does not match the ACP source path`;
      } catch {
        return `${meta.source} session id does not match the ACP source path`;
      }
    }
  }
}

export function isImportedSessionSourceIdentityValid(meta: ImportedSessionMeta): boolean {
  return importedSessionSourceIdentityIssue(meta) === null;
}
