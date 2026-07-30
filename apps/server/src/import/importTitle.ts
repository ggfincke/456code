// apps/server/src/import/importTitle.ts
// resolves provider-authored titles and semantic prompt fallbacks
// @effect-diagnostics nodeBuiltinImport:off

import {
  IMPORT_METADATA_MAX_CHARS,
  IMPORT_SCAN_MAX_CANDIDATES,
  IMPORT_TITLE_MAX_CHARS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { readBoundedUtf8File } from "./resourceLimits.ts";
import type { ImportedRecord } from "./types.ts";

const codexRequestMarker = "## My request for Codex:";
const codexSessionIndexMaxBytes = 4 * 1024 * 1024;
const importedAttachmentTitle = "Imported attachment session";
const providerAdministrativeTitlePrefixes = [
  "<command-message>",
  "<command-name>",
  "<environment_context>",
  "<local-command-caveat>",
  "<recommended_plugins>",
  "<turn_aborted>",
  "<user_action>",
  "<user_instructions>",
] as const;
const decodeUnknownJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function boundedTitle(value: string): string {
  return value.length <= IMPORT_TITLE_MAX_CHARS
    ? value
    : `${value.slice(0, IMPORT_TITLE_MAX_CHARS - 1)}…`;
}

function nonAdministrativeTitle(value: unknown): string | null {
  const title = nonEmptyString(value);
  if (
    title === null ||
    providerAdministrativeTitlePrefixes.some((prefix) => title.startsWith(prefix))
  ) {
    return null;
  }
  return title;
}

export function codexSemanticTitle(text: string): string | null {
  const markerIndex = text.lastIndexOf(codexRequestMarker);
  if (markerIndex === -1) {
    return nonAdministrativeTitle(text);
  }
  const candidate = text.slice(markerIndex + codexRequestMarker.length).trim();
  return candidate.length > 0 ? candidate : importedAttachmentTitle;
}

export function claudeSemanticTitle(isMeta: unknown, content: unknown): string | null {
  if (isMeta === true) {
    return null;
  }
  if (typeof content === "string") {
    return nonAdministrativeTitle(content);
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
  return nonAdministrativeTitle(text);
}

export function claudeExplicitTitle(value: unknown): string | null {
  return nonAdministrativeTitle(value);
}

export function firstUserMessageTitle(records: ReadonlyArray<ImportedRecord>): string | null {
  for (const record of records) {
    if (record.kind !== "message" || record.role !== "user") {
      continue;
    }
    const title = nonAdministrativeTitle(record.text);
    if (title !== null) {
      return title;
    }
  }
  return null;
}

export const loadCodexSessionTitles = Effect.fn("ImportTitle.loadCodexSessionTitles")(function* (
  indexPath: string,
): Effect.fn.Return<ReadonlyMap<string, string>> {
  const loaded = yield* readBoundedUtf8File(indexPath, codexSessionIndexMaxBytes).pipe(
    Effect.result,
  );
  if (loaded._tag === "Failure") {
    return new Map();
  }

  const titles = new Map<string, string>();
  let recordCount = 0;
  for (const rawLine of loaded.success.content.split(/\r?\n/u)) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    recordCount += 1;
    if (recordCount > IMPORT_SCAN_MAX_CANDIDATES) {
      break;
    }
    const decoded = decodeUnknownJsonString(rawLine);
    if (Option.isNone(decoded) || !isRecord(decoded.value)) {
      continue;
    }
    const nativeSessionId = nonEmptyString(decoded.value.id);
    const title = nonAdministrativeTitle(decoded.value.thread_name);
    if (
      nativeSessionId === null ||
      nativeSessionId.length > IMPORT_METADATA_MAX_CHARS ||
      title === null
    ) {
      continue;
    }
    titles.set(nativeSessionId, boundedTitle(title));
  }
  return titles;
});
