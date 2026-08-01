// apps/server/src/import/parserSupport.ts
// shares provider-independent session parser mechanics
// @effect-diagnostics globalDate:off

import type { ImportedRecord } from "./types.ts";

export interface WarningState {
  details: string[];
  omittedCount: number;
  totalCount: number;
}

type PushImportedRecord = (records: ImportedRecord[], record: ImportedRecord) => void;

const warningDetailLimit = 100;
const warningTextLimit = 512;
const maximumDateTimestamp = 8_640_000_000_000_000;
const textEncoder = new TextEncoder();

function truncateWarning(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export function addWarning(state: WarningState, message: string): void {
  state.totalCount += 1;
  if (state.details.length < warningDetailLimit) {
    state.details.push(truncateWarning(message, warningTextLimit));
    return;
  }
  state.omittedCount += 1;
}

export function materializeWarnings(state: WarningState): string[] {
  if (state.omittedCount === 0) {
    return [...state.details];
  }
  return [
    ...state.details,
    `${state.omittedCount} additional parsing warnings omitted after the first ${warningDetailLimit}`,
  ];
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const suffix = "…";
  const byteBudget = maxBytes - textEncoder.encode(suffix).byteLength;
  let byteLength = 0;
  let truncatedEnd = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    byteLength += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    index += codeUnits;
    if (byteLength <= byteBudget) {
      truncatedEnd = index;
    }
    if (byteLength > maxBytes) {
      return `${value.slice(0, truncatedEnd)}${suffix}`;
    }
  }
  return value;
}

export class JsonlParseLimitError extends Error {
  constructor(limitKind: "physical-line" | "record", limit: number) {
    super(`session import ${limitKind} limit exceeded: maximum is ${limit}`);
    this.name = "JsonlParseLimitError";
  }
}

export function* iterateJsonlPhysicalLines(
  content: string,
  maxPhysicalLines: number,
): Generator<{ line: string; sourceIndex: number }> {
  let lineStart = 0;
  let sourceIndex = 0;

  while (lineStart < content.length) {
    if (sourceIndex >= maxPhysicalLines) {
      throw new JsonlParseLimitError("physical-line", maxPhysicalLines);
    }

    const newlineIndex = content.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex;
    const contentEnd =
      lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    yield {
      line: content.slice(lineStart, contentEnd),
      sourceIndex,
    };
    sourceIndex += 1;
    if (newlineIndex === -1) {
      return;
    }
    lineStart = newlineIndex + 1;
  }
}

export function incrementJsonlRecordCount(recordCount: number, maxJsonlRecords: number): number {
  const nextRecordCount = recordCount + 1;
  if (nextRecordCount > maxJsonlRecords) {
    throw new JsonlParseLimitError("record", maxJsonlRecords);
  }
  return nextRecordCount;
}

export function applyStrictlyIncreasingTimestamps(records: ImportedRecord[]): void {
  let previousTimestamp: number | null = null;

  for (const record of records) {
    const currentTimestamp = Date.parse(record.createdAt);
    if (previousTimestamp !== null && currentTimestamp <= previousTimestamp) {
      previousTimestamp = Math.min(previousTimestamp + 1, maximumDateTimestamp);
      record.createdAt = new Date(previousTimestamp).toISOString();
      continue;
    }

    previousTimestamp = currentTimestamp;
  }
}

export function appendParsingWarningActivity(
  records: ImportedRecord[],
  warnings: WarningState,
  sourceIndex: number,
  pushImportedRecord: PushImportedRecord,
): void {
  const createdAt = records.at(-1)?.createdAt;
  if (warnings.totalCount === 0 || createdAt === undefined) {
    return;
  }

  const noun = warnings.totalCount === 1 ? "warning" : "warnings";
  const summary = `Imported with ${warnings.totalCount} parsing ${noun}`;
  pushImportedRecord(records, {
    kind: "activity",
    tone: "error",
    activityKind: "task.completed",
    summary,
    payload: {
      summary,
      detail: materializeWarnings(warnings).join("\n"),
      importWarningCount: warnings.totalCount,
      omittedWarningCount: warnings.omittedCount,
    },
    createdAt,
    sourceIndex,
  });
}
