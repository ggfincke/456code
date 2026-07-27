// apps/server/src/import/codexRolloutParser.ts
// parses codex rollout jsonl into inert imported records
// @effect-diagnostics globalDate:off

import type {
  ImportedActivityRecord,
  ImportedMessageRecord,
  ImportedRecord,
  ImportedSession,
  ImportedSessionMeta,
  ParseInput,
} from "./types.ts";
import { deterministicId } from "./ids.ts";
import { IMPORT_NORMALIZED_SESSION_MAX_RECORDS } from "./resourceLimits.ts";

interface PendingToolCall {
  activity: ImportedActivityRecord;
}

interface PendingToolSearch {
  callId: string;
  createdAt: string;
  query: string;
  sourceIndex: number;
}

interface StreamMessageCandidate {
  paired: boolean;
  record: ImportedMessageRecord;
  stream: "event" | "response";
}

interface WarningState {
  details: string[];
  omittedCount: number;
  totalCount: number;
}

interface NormalizedWebSearchAction {
  detail: string;
  input: Record<string, unknown>;
  summary: string;
  title: string;
}

interface AttachmentReferenceOccurrences {
  eventMessages: number;
  responseItems: number;
}

type AttachmentRepresentation = keyof AttachmentReferenceOccurrences;

const summaryLimit = 120;
const warningDetailLimit = 100;
const warningTextLimit = 512;
const maxPhysicalLines = 50_000;
const maxJsonlRecords = 50_000;
const maxFieldBytes = 1_048_576;
const maxCwdCharacters = 4_096;
const maxMetadataCharacters = 512;
const maxToolCallIdBytes = 512;
const maxToolNameBytes = 256;
const maxToolNames = 100;
const maxWebSearchQueries = 100;
const maxCollectionItems = 10_000;
const maxNestedCollectionNodes = 20_000;
const maximumDateTimestamp = 8_640_000_000_000_000;
const textEncoder = new TextEncoder();
const omittedAttachmentDetail = "Attachment payloads are not included in imported transcripts.";
const ignoredResponseItemTypes = new Set(["agent_message", "reasoning"]);
const ignoredResponseMessageRoles = new Set(["developer", "system"]);
const safeNativeSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

class JsonlParseLimitError extends Error {
  constructor(limitKind: "physical-line" | "record") {
    super(`session import ${limitKind} limit exceeded: maximum is 50000`);
    this.name = "JsonlParseLimitError";
  }
}

class NormalizedRecordLimitError extends Error {
  constructor() {
    super(
      `session import normalized record limit exceeded: maximum is ${IMPORT_NORMALIZED_SESSION_MAX_RECORDS}`,
    );
    this.name = "NormalizedRecordLimitError";
  }
}

function pushImportedRecord<T extends ImportedRecord>(records: T[], record: T): void {
  if (records.length >= IMPORT_NORMALIZED_SESSION_MAX_RECORDS) {
    throw new NormalizedRecordLimitError();
  }
  records.push(record);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function summarize(value: string): string {
  const firstLine = value.trim().split(/\r?\n/, 1)[0] ?? "";
  return truncate(firstLine, summaryLimit);
}

function addWarning(state: WarningState, message: string): void {
  state.totalCount += 1;
  if (state.details.length < warningDetailLimit) {
    state.details.push(truncate(message, warningTextLimit));
    return;
  }
  state.omittedCount += 1;
}

function materializeWarnings(state: WarningState): string[] {
  if (state.omittedCount === 0) {
    return [...state.details];
  }
  return [
    ...state.details,
    `${state.omittedCount} additional parsing warnings omitted after the first ${warningDetailLimit}`,
  ];
}

function truncateUtf8(value: string, maxBytes = maxFieldBytes): string {
  const suffix = "…";
  const byteBudget = maxBytes - textEncoder.encode(suffix).byteLength;
  let byteLength = 0;
  let truncatedEnd = 0;
  for (let index = 0; index < value.length; ) {
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

function boundTextField(value: string, fieldDescription: string, warnings: WarningState): string {
  const bounded = truncateUtf8(value);
  if (bounded === value) {
    return value;
  }
  addWarning(warnings, `${fieldDescription} exceeded 1 MiB and was truncated`);
  return bounded;
}

function boundMetadataField(
  value: string | null,
  fieldDescription: string,
  warnings: WarningState,
): string | null {
  if (value === null || value.length <= maxMetadataCharacters) {
    return value;
  }
  addWarning(
    warnings,
    `${fieldDescription} exceeded ${maxMetadataCharacters} characters and was truncated`,
  );
  return truncate(value, maxMetadataCharacters);
}

function safeCwd(value: string | null, sourceIndex: number, warnings: WarningState): string | null {
  if (value === null || value.length <= maxCwdCharacters) {
    return value;
  }
  addWarning(
    warnings,
    `line ${sourceIndex + 1}: cwd exceeded ${maxCwdCharacters} characters and was omitted`,
  );
  return null;
}

function safeNativeSessionId(
  value: string | null,
  sourceIndex: number,
  warnings: WarningState,
): string | null {
  if (
    value === null ||
    value.length > maxMetadataCharacters ||
    !safeNativeSessionIdPattern.test(value)
  ) {
    if (value !== null) {
      addWarning(
        warnings,
        `line ${sourceIndex + 1}: native session id was invalid or oversized and was omitted`,
      );
    }
    return null;
  }
  return value;
}

function boundStableIdentifier(
  value: string,
  fieldDescription: string,
  warnings: WarningState,
): string {
  if (truncateUtf8(value, maxToolCallIdBytes) === value) {
    return value;
  }
  addWarning(warnings, `${fieldDescription} exceeded 512 bytes and was replaced with a stable id`);
  return deterministicId(value, "codex-import-tool-call");
}

function boundToolName(value: string, sourceIndex: number, warnings: WarningState): string {
  const bounded = truncateUtf8(value, maxToolNameBytes);
  if (bounded === value) {
    return value;
  }
  addWarning(warnings, `line ${sourceIndex + 1}: tool name exceeded 256 bytes and was truncated`);
  return bounded;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function* iteratePhysicalLines(content: string): Generator<{ line: string; sourceIndex: number }> {
  let lineStart = 0;
  let sourceIndex = 0;

  while (lineStart < content.length) {
    if (sourceIndex >= maxPhysicalLines) {
      throw new JsonlParseLimitError("physical-line");
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

function makeMessage(
  role: "user" | "assistant",
  textValue: unknown,
  createdAt: string,
  sourceIndex: number,
  warnings: WarningState,
): ImportedMessageRecord | null {
  if (typeof textValue !== "string") {
    return null;
  }

  const text = textValue.trim();
  if (text.length === 0) {
    return null;
  }

  return {
    kind: "message",
    role,
    text: boundTextField(text, `line ${sourceIndex + 1}: ${role} message`, warnings),
    createdAt,
    sourceIndex,
  };
}

function normalizeMessageText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function extractCodexMessageText(
  value: unknown,
  description: string,
  sourceIndex: number,
  warnings: WarningState,
): string {
  if (typeof value === "string") {
    return value.trim();
  }
  const content = isRecord(value) && Array.isArray(value.content) ? value.content : value;
  if (!Array.isArray(content)) {
    addWarning(warnings, `line ${sourceIndex + 1}: unsupported ${description} content was omitted`);
    return "";
  }

  const textParts: string[] = [];
  let unsupportedBlockCount = 0;
  if (content.length > maxCollectionItems) {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: ${description} content was capped at ${maxCollectionItems} of ${content.length} blocks`,
    );
  }
  for (const item of content.slice(0, maxCollectionItems)) {
    if (
      isRecord(item) &&
      (item.type === "input_text" || item.type === "output_text" || item.type === "text") &&
      typeof item.text === "string"
    ) {
      textParts.push(item.text);
      continue;
    }
    if (isRecord(item) && item.type === "input_image") {
      continue;
    }
    unsupportedBlockCount += 1;
  }
  if (unsupportedBlockCount > 0) {
    const noun = unsupportedBlockCount === 1 ? "block" : "blocks";
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: ${unsupportedBlockCount} unsupported ${description} content ${noun} omitted`,
    );
  }
  return textParts.join("\n").trim();
}

function attachmentReferenceKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? deterministicId(normalized, "omitted-attachment-reference") : null;
}

function recordAttachmentReference(
  occurrences: Map<string, AttachmentReferenceOccurrences>,
  value: unknown,
  representation: AttachmentRepresentation,
): boolean {
  const key = attachmentReferenceKey(value);
  if (key === null) {
    return false;
  }

  const current = occurrences.get(key) ?? { eventMessages: 0, responseItems: 0 };
  current[representation] += 1;
  occurrences.set(key, current);
  return true;
}

function recordAttachmentArray(
  occurrences: Map<string, AttachmentReferenceOccurrences>,
  value: unknown,
  representation: AttachmentRepresentation,
  sourceIndex: number,
  warnings: WarningState,
): number {
  if (!Array.isArray(value)) {
    return 0;
  }

  if (value.length > maxCollectionItems) {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: attachment references were capped at ${maxCollectionItems} of ${value.length}`,
    );
  }
  let recorded = 0;
  for (const reference of value.slice(0, maxCollectionItems)) {
    if (recordAttachmentReference(occurrences, reference, representation)) {
      recorded += 1;
    }
  }
  return recorded;
}

function recordInputImageBlocks(
  occurrences: Map<string, AttachmentReferenceOccurrences>,
  value: unknown,
  representation: AttachmentRepresentation,
  sourceIndex: number,
  warnings: WarningState,
): number {
  const content = isRecord(value) && Array.isArray(value.content) ? value.content : value;
  if (!Array.isArray(content)) {
    return 0;
  }

  if (content.length > maxCollectionItems) {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: image content was capped at ${maxCollectionItems} of ${content.length} blocks`,
    );
  }
  let recorded = 0;
  for (const contentValue of content.slice(0, maxCollectionItems)) {
    if (
      isRecord(contentValue) &&
      contentValue.type === "input_image" &&
      recordAttachmentReference(occurrences, contentValue.image_url, representation)
    ) {
      recorded += 1;
    }
  }
  return recorded;
}

function recordCodexAttachments(
  occurrences: Map<string, AttachmentReferenceOccurrences>,
  recordType: string,
  itemType: string,
  payload: Record<string, unknown>,
  sourceIndex: number,
  warnings: WarningState,
): number {
  if (recordType === "event_msg") {
    return (
      recordInputImageBlocks(occurrences, payload.message, "eventMessages", sourceIndex, warnings) +
      (itemType === "user_message"
        ? recordAttachmentArray(
            occurrences,
            payload.images,
            "eventMessages",
            sourceIndex,
            warnings,
          ) +
          recordAttachmentArray(
            occurrences,
            payload.local_images,
            "eventMessages",
            sourceIndex,
            warnings,
          )
        : 0)
    );
  }
  if (recordType !== "response_item") {
    return 0;
  }

  return (
    recordInputImageBlocks(occurrences, payload.content, "responseItems", sourceIndex, warnings) +
    recordInputImageBlocks(occurrences, payload.output, "responseItems", sourceIndex, warnings)
  );
}

function countLogicalAttachments(
  occurrences: ReadonlyMap<string, AttachmentReferenceOccurrences>,
): number {
  let count = 0;
  for (const occurrence of occurrences.values()) {
    count += Math.max(occurrence.eventMessages, occurrence.responseItems);
  }
  return count;
}

function toolItemType(name: string, custom: boolean): string {
  if (custom) {
    return "dynamic_tool_call";
  }

  return name === "shell" || name === "exec_command" || name === "container.exec"
    ? "command_execution"
    : "dynamic_tool_call";
}

function toolKind(itemType: string): string {
  if (itemType === "command_execution") {
    return "execute";
  }
  if (itemType === "file_change") {
    return "edit";
  }
  if (itemType === "web_search") {
    return "search";
  }
  return "tool";
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeToolInput(
  payload: Record<string, unknown>,
  sourceIndex: number,
  warnings: WarningState,
): { command: string | null; value: unknown } {
  const originalValue = payload.arguments ?? payload.input;
  const serialized = stringifyValue(originalValue);
  const bounded = boundTextField(serialized, `line ${sourceIndex + 1}: tool input`, warnings);
  let structuredValue: unknown = originalValue ?? "";

  if (bounded !== serialized) {
    structuredValue = bounded;
  } else if (typeof originalValue === "string") {
    try {
      structuredValue = JSON.parse(originalValue) as unknown;
    } catch {
      structuredValue = originalValue;
    }
  }

  const inputRecord = isRecord(structuredValue) ? structuredValue : null;
  const commandValue = inputRecord?.command ?? inputRecord?.cmd;
  const command =
    typeof commandValue === "string"
      ? commandValue.trim()
      : Array.isArray(commandValue)
        ? commandValue
            .filter((part): part is string => typeof part === "string")
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .join(" ")
        : null;
  return {
    command:
      command !== null && command.length > 0
        ? boundTextField(command, `line ${sourceIndex + 1}: tool command`, warnings)
        : null,
    value: structuredValue,
  };
}

function withoutInputImageBlocks(
  value: unknown,
  sourceIndex: number,
  warnings: WarningState,
): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  if (value.length > maxCollectionItems) {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: tool output content was capped at ${maxCollectionItems} of ${value.length} blocks`,
    );
  }
  const retained: unknown[] = [];
  const limit = Math.min(value.length, maxCollectionItems);
  for (let index = 0; index < limit; index += 1) {
    const contentValue = value[index];
    if (!isRecord(contentValue) || contentValue.type !== "input_image") {
      retained.push(contentValue);
    }
  }
  return retained;
}

function toolOutput(
  payload: Record<string, unknown>,
  sourceIndex: number,
  warnings: WarningState,
): string {
  const value = withoutInputImageBlocks(payload.output ?? payload.content, sourceIndex, warnings);
  return boundTextField(stringifyValue(value), `line ${sourceIndex + 1}: tool output`, warnings);
}

function toolSearchQuery(
  payload: Record<string, unknown>,
  sourceIndex: number,
  warnings: WarningState,
): string {
  const argumentsValue = isRecord(payload.arguments) ? payload.arguments : null;
  const query = typeof argumentsValue?.query === "string" ? argumentsValue.query.trim() : "";
  if (query.length === 0) {
    addWarning(warnings, `line ${sourceIndex + 1}: tool search call has no query`);
    return "";
  }
  return boundTextField(query, `line ${sourceIndex + 1}: tool search query`, warnings);
}

function normalizeWebSearchText(
  value: unknown,
  fieldDescription: string,
  warnings: WarningState,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : boundTextField(normalized, fieldDescription, warnings);
}

function normalizeWebSearchAction(
  payload: Record<string, unknown>,
  sourceIndex: number,
  warnings: WarningState,
): NormalizedWebSearchAction | null {
  const status = asString(payload.status);
  if (status !== null && status !== "completed") {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: web search call with status "${truncate(status, summaryLimit)}" was omitted`,
    );
    return null;
  }

  const action = isRecord(payload.action) ? payload.action : null;
  const actionType = action === null ? null : asString(action.type);
  if (action === null || actionType === null) {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: completed web search call had no valid action and was omitted`,
    );
    return null;
  }

  if (actionType === "search") {
    if (action.query !== undefined && action.query !== null && typeof action.query !== "string") {
      addWarning(warnings, `line ${sourceIndex + 1}: web search query had an invalid type`);
    }
    if (action.queries !== undefined && action.queries !== null && !Array.isArray(action.queries)) {
      addWarning(warnings, `line ${sourceIndex + 1}: web search queries had an invalid type`);
    }

    const query = normalizeWebSearchText(
      action.query,
      `line ${sourceIndex + 1}: web search query`,
      warnings,
    );
    const queries: string[] = [];
    let queryListByteCount = 0;
    let malformedQueryCount = 0;
    if (Array.isArray(action.queries)) {
      const queryLimit = Math.min(action.queries.length, maxWebSearchQueries);
      for (let index = 0; index < queryLimit; index += 1) {
        const normalized = normalizeWebSearchText(
          action.queries[index],
          `line ${sourceIndex + 1}: web search query ${index + 1}`,
          warnings,
        );
        if (normalized === null) {
          malformedQueryCount += 1;
          continue;
        }
        if (queries.includes(normalized)) {
          continue;
        }
        const additionalBytes =
          textEncoder.encode(normalized).byteLength + (queries.length === 0 ? 0 : 1);
        if (queryListByteCount + additionalBytes > maxFieldBytes) {
          addWarning(
            warnings,
            `line ${sourceIndex + 1}: web search query list exceeded 1 MiB and was truncated`,
          );
          break;
        }
        queries.push(normalized);
        queryListByteCount += additionalBytes;
      }
      if (action.queries.length > maxWebSearchQueries) {
        addWarning(
          warnings,
          `line ${sourceIndex + 1}: web search query list was capped at ${maxWebSearchQueries} of ${action.queries.length}`,
        );
      }
    }
    if (malformedQueryCount > 0) {
      const noun = malformedQueryCount === 1 ? "query" : "queries";
      addWarning(
        warnings,
        `line ${sourceIndex + 1}: ${malformedQueryCount} malformed web search ${noun} omitted`,
      );
    }

    const primaryQuery = query ?? queries[0] ?? null;
    if (primaryQuery === null) {
      addWarning(
        warnings,
        `line ${sourceIndex + 1}: completed web search action had no query and was omitted`,
      );
      return null;
    }
    const input: Record<string, unknown> = { type: "search", query: primaryQuery };
    if (queries.length > 0) {
      input.queries = queries;
    }
    const detail = boundTextField(
      [...new Set([primaryQuery, ...queries])].join("\n"),
      `line ${sourceIndex + 1}: web search detail`,
      warnings,
    );
    return {
      detail,
      input,
      summary: truncate(`Search web: ${summarize(primaryQuery)}`, summaryLimit),
      title: "Web search",
    };
  }

  if (actionType === "open_page") {
    const url = normalizeWebSearchText(
      action.url,
      `line ${sourceIndex + 1}: web search URL`,
      warnings,
    );
    if (url === null) {
      addWarning(
        warnings,
        `line ${sourceIndex + 1}: completed open-page action had no URL and was omitted`,
      );
      return null;
    }
    return {
      detail: url,
      input: { type: "open_page", url },
      summary: truncate(`Open page: ${summarize(url)}`, summaryLimit),
      title: "Open page",
    };
  }

  if (actionType === "find_in_page") {
    const pattern = normalizeWebSearchText(
      action.pattern,
      `line ${sourceIndex + 1}: find-in-page pattern`,
      warnings,
    );
    if (pattern === null) {
      addWarning(
        warnings,
        `line ${sourceIndex + 1}: completed find-in-page action had no pattern and was omitted`,
      );
      return null;
    }
    const url = normalizeWebSearchText(
      action.url,
      `line ${sourceIndex + 1}: find-in-page URL`,
      warnings,
    );
    const input: Record<string, unknown> = { type: "find_in_page", pattern };
    if (url !== null) {
      input.url = url;
    }
    return {
      detail:
        url === null
          ? pattern
          : boundTextField(
              `${pattern}\n${url}`,
              `line ${sourceIndex + 1}: find-in-page detail`,
              warnings,
            ),
      input,
      summary: truncate(`Find in page: ${summarize(pattern)}`, summaryLimit),
      title: "Find in page",
    };
  }

  addWarning(
    warnings,
    `line ${sourceIndex + 1}: unsupported completed web search action "${truncate(actionType, summaryLimit)}" was omitted`,
  );
  return null;
}

function collectToolSearchNames(
  tools: unknown,
  sourceIndex: number,
  warnings: WarningState,
): { names: string[]; totalTools: number; truncated: boolean } {
  const names: string[] = [];
  let totalTools = 0;
  let depthTruncated = false;
  let visitedNodes = 0;
  let nodeTruncated = false;

  const visit = (value: unknown, depth: number): void => {
    if (visitedNodes >= maxNestedCollectionNodes) {
      nodeTruncated = true;
      return;
    }
    visitedNodes += 1;
    if (depth > 8) {
      depthTruncated = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
        if (nodeTruncated) {
          break;
        }
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (Array.isArray(value.tools)) {
      visit(value.tools, depth + 1);
      return;
    }
    const name = asString(value.name);
    if (name === null) {
      return;
    }
    totalTools += 1;
    if (names.length < maxToolNames) {
      names.push(boundToolName(name.trim(), sourceIndex, warnings));
    }
  };

  visit(tools, 0);
  if (depthTruncated) {
    addWarning(warnings, `line ${sourceIndex + 1}: nested tool search output exceeded depth 8`);
  }
  if (nodeTruncated) {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: nested tool search output was capped after ${maxNestedCollectionNodes} inspected values`,
    );
  }
  if (totalTools > maxToolNames) {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: tool search name list was capped at ${maxToolNames} of ${totalTools}`,
    );
  }
  return {
    names,
    totalTools,
    truncated: depthTruncated || nodeTruncated || totalTools > names.length,
  };
}

function completedToolSearchActivity(
  pending: PendingToolSearch,
  output: Record<string, unknown>,
  sourceIndex: number,
  warnings: WarningState,
): ImportedActivityRecord {
  const result = collectToolSearchNames(output.tools, sourceIndex, warnings);
  const noun = result.totalTools === 1 ? "tool" : "tools";
  const summary =
    pending.query.length === 0
      ? `Found ${result.totalTools} ${noun}`
      : truncate(
          `Found ${result.totalTools} ${noun} for "${summarize(pending.query)}"`,
          summaryLimit,
        );
  const detail =
    result.names.length === 0
      ? `No tool names returned (${result.totalTools} total)`
      : result.names.join(", ");
  const normalizedResult = {
    totalTools: result.totalTools,
    toolNames: result.names,
    truncated: result.truncated,
  };

  return {
    kind: "activity",
    tone: "tool",
    activityKind: "tool.completed",
    summary,
    payload: {
      itemType: "dynamic_tool_call",
      title: "Tool search",
      status: "completed",
      detail,
      data: {
        toolCallId: pending.callId,
        kind: "search",
        rawInput: { query: pending.query },
        rawOutput: normalizedResult,
        item: {
          input: { query: pending.query },
          result: normalizedResult,
        },
      },
    },
    createdAt: pending.createdAt,
    sourceIndex: pending.sourceIndex,
  };
}

function completeToolActivity(
  activity: ImportedActivityRecord,
  output: string,
  failed: boolean,
): void {
  activity.tone = failed ? "error" : "tool";
  activity.payload.status = failed ? "failed" : "completed";
  activity.payload.detail = output;
  const data = isRecord(activity.payload.data) ? activity.payload.data : {};
  const item = isRecord(data.item) ? data.item : {};
  item.result = { content: output };
  data.item = item;
  data.rawOutput = { content: output };
  activity.payload.data = data;
}

function collapseAdjacentCrossStreamMessages(
  eventRecords: ImportedRecord[],
  responseMessages: ImportedMessageRecord[],
): ImportedRecord[] {
  const candidates: Array<
    | { kind: "activity"; record: ImportedActivityRecord }
    | { kind: "message"; value: StreamMessageCandidate }
  > = [
    ...eventRecords.map((record) =>
      record.kind === "message"
        ? ({
            kind: "message",
            value: { paired: false, record, stream: "event" },
          } as const)
        : ({ kind: "activity", record } as const),
    ),
    ...responseMessages.map(
      (record) =>
        ({
          kind: "message",
          value: { paired: false, record, stream: "response" },
        }) as const,
    ),
  ].sort((left, right) => {
    const leftRecord = left.kind === "message" ? left.value.record : left.record;
    const rightRecord = right.kind === "message" ? right.value.record : right.record;
    return leftRecord.sourceIndex - rightRecord.sourceIndex;
  });

  let previousMessage: StreamMessageCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.kind !== "message") {
      continue;
    }
    const current = candidate.value;
    if (
      previousMessage !== null &&
      !previousMessage.paired &&
      previousMessage.stream !== current.stream &&
      previousMessage.record.role === current.record.role &&
      normalizeMessageText(previousMessage.record.text) ===
        normalizeMessageText(current.record.text)
    ) {
      previousMessage.paired = true;
      current.paired = true;
      if (previousMessage.stream === "response") {
        previousMessage.record = current.record;
        previousMessage.stream = "event";
        current.record = previousMessage.record;
      }
      continue;
    }
    previousMessage = current;
  }

  const retainedEventMessages = new Set(
    candidates
      .filter(
        (candidate): candidate is { kind: "message"; value: StreamMessageCandidate } =>
          candidate.kind === "message" && candidate.value.stream === "event",
      )
      .map((candidate) => candidate.value.record),
  );
  const retainedResponses = new Set(
    candidates
      .filter(
        (candidate): candidate is { kind: "message"; value: StreamMessageCandidate } =>
          candidate.kind === "message" &&
          candidate.value.stream === "response" &&
          !candidate.value.paired,
      )
      .map((candidate) => candidate.value.record),
  );

  return [
    ...eventRecords.filter(
      (record) => record.kind === "activity" || retainedEventMessages.has(record),
    ),
    ...responseMessages.filter((record) => retainedResponses.has(record)),
  ].sort((left, right) => left.sourceIndex - right.sourceIndex);
}

function fileChangeRecords(
  payload: Record<string, unknown>,
  sourceIndex: number,
  warnings: WarningState,
): Array<{ path: string }> {
  const candidates = Array.isArray(payload.files)
    ? payload.files
    : Array.isArray(payload.changes)
      ? payload.changes
      : [];
  const changes: Array<{ path: string }> = [];

  if (candidates.length > maxCollectionItems) {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: changed files were capped at ${maxCollectionItems} of ${candidates.length}`,
    );
  }
  for (const candidate of candidates.slice(0, maxCollectionItems)) {
    const rawPath =
      typeof candidate === "string"
        ? candidate
        : isRecord(candidate)
          ? (candidate.path ??
            candidate.filePath ??
            candidate.relativePath ??
            candidate.filename ??
            candidate.newPath ??
            candidate.oldPath)
          : null;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      continue;
    }
    changes.push({
      path: boundTextField(rawPath.trim(), `line ${sourceIndex + 1}: changed file path`, warnings),
    });
  }
  return changes;
}

function applyStrictlyIncreasingTimestamps(records: ImportedRecord[]): void {
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

function appendOmittedAttachmentActivity(
  records: ImportedRecord[],
  omittedAttachmentCount: number,
  createdAt: string | null,
  sourceIndex: number,
): void {
  const fallbackCreatedAt = records.at(-1)?.createdAt;
  const activityCreatedAt = createdAt ?? fallbackCreatedAt;
  if (omittedAttachmentCount === 0 || activityCreatedAt === undefined) {
    return;
  }

  const noun = omittedAttachmentCount === 1 ? "attachment" : "attachments";
  const summary = `Omitted ${omittedAttachmentCount} ${noun} from imported transcript`;
  pushImportedRecord(records, {
    kind: "activity",
    tone: "info",
    activityKind: "task.completed",
    summary,
    payload: {
      omittedAttachmentCount,
      summary,
      detail: omittedAttachmentDetail,
    },
    createdAt: activityCreatedAt,
    sourceIndex,
  });
}

function appendParsingWarningActivity(
  records: ImportedRecord[],
  warnings: WarningState,
  sourceIndex: number,
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

function emptyMeta(input: ParseInput): ImportedSessionMeta {
  return {
    source: "codex-cli",
    sourcePath: input.sourcePath,
    contentHash: input.contentHash,
    nativeSessionId: null,
    cwd: null,
    gitBranch: null,
    model: null,
    title: null,
    firstActivityAt: null,
    lastActivityAt: null,
  };
}

function finalize(
  meta: ImportedSessionMeta,
  records: ImportedRecord[],
  warnings: WarningState,
  hasMetadata: boolean,
): ImportedSession {
  const messageCount = records.filter((record) => record.kind === "message").length;
  if (!hasMetadata) {
    addWarning(warnings, "no session metadata found; session was not imported");
  }
  if (messageCount === 0) {
    addWarning(warnings, "no messages found; session was not imported");
  }
  if (!hasMetadata || messageCount === 0) {
    return { meta, records: [], warnings: materializeWarnings(warnings) };
  }

  applyStrictlyIncreasingTimestamps(records);
  meta.firstActivityAt = records[0]?.createdAt ?? null;
  meta.lastActivityAt = records.at(-1)?.createdAt ?? null;
  return { meta, records, warnings: materializeWarnings(warnings) };
}

export function parseCodexRollout(input: ParseInput): ImportedSession {
  const warnings: WarningState = { details: [], omittedCount: 0, totalCount: 0 };
  const meta = emptyMeta(input);
  const eventRecords: ImportedRecord[] = [];
  const fallbackMessages: ImportedMessageRecord[] = [];
  const pushEventRecord = (record: ImportedRecord) => {
    if (eventRecords.length + fallbackMessages.length >= IMPORT_NORMALIZED_SESSION_MAX_RECORDS) {
      throw new NormalizedRecordLimitError();
    }
    pushImportedRecord(eventRecords, record);
  };
  const pushFallbackMessage = (record: ImportedMessageRecord) => {
    if (eventRecords.length + fallbackMessages.length >= IMPORT_NORMALIZED_SESSION_MAX_RECORDS) {
      throw new NormalizedRecordLimitError();
    }
    pushImportedRecord(fallbackMessages, record);
  };
  const pendingCalls = new Map<string, PendingToolCall>();
  const pendingToolSearches = new Map<string, PendingToolSearch>();
  const incompleteToolActivities = new Set<ImportedActivityRecord>();
  const attachmentOccurrences = new Map<string, AttachmentReferenceOccurrences>();
  const warnedUnknownResponseItemTypes = new Set<string>();
  let hasMetadata = false;
  let lastOmittedAttachmentAt: string | null = null;
  let lastSourceIndex = -1;
  let parsedRecordCount = 0;

  for (const { line: rawLine, sourceIndex } of iteratePhysicalLines(input.content)) {
    lastSourceIndex = sourceIndex;
    if (rawLine.trim().length === 0) {
      continue;
    }

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(rawLine);
    } catch {
      addWarning(warnings, `line ${sourceIndex + 1}: malformed JSON skipped`);
      continue;
    }
    if (!isRecord(parsedValue)) {
      addWarning(warnings, `line ${sourceIndex + 1}: expected a JSON object`);
      continue;
    }
    parsedRecordCount += 1;
    if (parsedRecordCount > maxJsonlRecords) {
      throw new JsonlParseLimitError("record");
    }
    const line = parsedValue;
    const type = asString(line.type);
    const payload = isRecord(line.payload) ? line.payload : null;

    if (type === "session_meta") {
      if (payload === null) {
        addWarning(warnings, `line ${sourceIndex + 1}: malformed session_meta payload skipped`);
        continue;
      }

      hasMetadata = true;
      const nativeSessionId = asString(payload.id);
      if (nativeSessionId !== null) {
        meta.nativeSessionId = safeNativeSessionId(nativeSessionId, sourceIndex, warnings);
      }
      meta.cwd = safeCwd(asString(payload.cwd), sourceIndex, warnings) ?? meta.cwd;
      if (isRecord(payload.git)) {
        meta.gitBranch =
          boundMetadataField(
            asString(payload.git.branch),
            `line ${sourceIndex + 1}: git branch`,
            warnings,
          ) ?? meta.gitBranch;
      }
      continue;
    }

    if (type === "turn_context") {
      if (payload === null) {
        addWarning(warnings, `line ${sourceIndex + 1}: malformed turn_context payload skipped`);
        continue;
      }

      const cwd = asString(payload.cwd);
      const model = asString(payload.model);
      hasMetadata ||= cwd !== null || model !== null;
      meta.cwd = safeCwd(cwd, sourceIndex, warnings) ?? meta.cwd;
      meta.model =
        boundMetadataField(model, `line ${sourceIndex + 1}: model`, warnings) ?? meta.model;
      continue;
    }

    if (type !== "event_msg" && type !== "response_item") {
      continue;
    }
    if (payload === null) {
      addWarning(warnings, `line ${sourceIndex + 1}: malformed ${type} payload skipped`);
      continue;
    }

    const itemType = asString(payload.type);
    if (itemType === null) {
      addWarning(warnings, `line ${sourceIndex + 1}: ${type} payload has no item type`);
      continue;
    }
    if (
      recordCodexAttachments(
        attachmentOccurrences,
        type,
        itemType,
        payload,
        sourceIndex,
        warnings,
      ) > 0
    ) {
      lastOmittedAttachmentAt = normalizeTimestamp(line.timestamp) ?? lastOmittedAttachmentAt;
    }

    const createdAt = normalizeTimestamp(line.timestamp);
    if (createdAt === null) {
      addWarning(warnings, `line ${sourceIndex + 1}: invalid timestamp skipped`);
      continue;
    }
    if (type === "event_msg") {
      if (itemType === "user_message" || itemType === "agent_message") {
        const role = itemType === "user_message" ? "user" : "assistant";
        const message = makeMessage(
          role,
          extractCodexMessageText(payload.message, `event ${itemType}`, sourceIndex, warnings),
          createdAt,
          sourceIndex,
          warnings,
        );
        if (message !== null) {
          pushEventRecord(message);
        }
        continue;
      }

      if (itemType === "agent_reasoning" && typeof payload.text === "string") {
        const text = boundTextField(
          payload.text.trim(),
          `line ${sourceIndex + 1}: reasoning`,
          warnings,
        );
        if (text.length > 0) {
          const summary = summarize(text);
          pushEventRecord({
            kind: "activity",
            tone: "info",
            activityKind: "task.progress",
            summary,
            payload: { summary, detail: text },
            createdAt,
            sourceIndex,
          });
        }
        continue;
      }

      if (itemType === "patch_apply_end") {
        const changes = fileChangeRecords(payload, sourceIndex, warnings);
        pushEventRecord({
          kind: "activity",
          tone: "tool",
          activityKind: "tool.completed",
          summary: "Applied file changes",
          payload: {
            itemType: "file_change",
            title: "Applied file changes",
            status: "completed",
            detail: changes.length === 1 ? "Changed 1 file" : `Changed ${changes.length} files`,
            data: {
              kind: "edit",
              item: { changes },
              rawOutput: { totalFiles: changes.length, truncated: false },
            },
          },
          createdAt,
          sourceIndex,
        });
      }
      continue;
    }

    if (itemType === "message") {
      const role =
        payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : null;
      if (role !== null) {
        const message = makeMessage(
          role,
          extractCodexMessageText(payload.content, "response message", sourceIndex, warnings),
          createdAt,
          sourceIndex,
          warnings,
        );
        if (message !== null) {
          pushFallbackMessage(message);
        }
      } else if (
        typeof payload.role !== "string" ||
        !ignoredResponseMessageRoles.has(payload.role)
      ) {
        addWarning(warnings, `line ${sourceIndex + 1}: response message has an invalid role`);
      }
      continue;
    }

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const name = boundToolName(asString(payload.name) ?? "tool", sourceIndex, warnings);
      const callId = asString(payload.call_id) ?? asString(payload.id);
      if (callId === null) {
        addWarning(warnings, `line ${sourceIndex + 1}: tool call has no call id and was omitted`);
        continue;
      }
      const custom = itemType === "custom_tool_call";
      const canonicalItemType = toolItemType(name, custom);
      const normalizedInput = normalizeToolInput(payload, sourceIndex, warnings);
      const item: Record<string, unknown> = {
        input: normalizedInput.value,
      };
      const data: Record<string, unknown> = {
        toolCallId: boundStableIdentifier(
          callId,
          `line ${sourceIndex + 1}: tool call id`,
          warnings,
        ),
        kind: toolKind(canonicalItemType),
        rawInput: normalizedInput.value,
        item,
      };
      if (normalizedInput.command !== null) {
        item.command = normalizedInput.command;
        data.command = normalizedInput.command;
      }
      const activity: ImportedActivityRecord = {
        kind: "activity",
        tone: "tool",
        activityKind: "tool.completed",
        summary: truncate(`${name}(...)`, summaryLimit),
        payload: {
          itemType: canonicalItemType,
          title: name,
          status: "completed",
          data,
        },
        createdAt,
        sourceIndex,
      };
      pushEventRecord(activity);
      incompleteToolActivities.add(activity);
      pendingCalls.set(callId, { activity });
      continue;
    }

    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = asString(payload.call_id) ?? asString(payload.id);
      if (callId === null) {
        addWarning(warnings, `line ${sourceIndex + 1}: tool output has no call id`);
        continue;
      }
      const pending = pendingCalls.get(callId);
      if (pending !== undefined) {
        completeToolActivity(
          pending.activity,
          toolOutput(payload, sourceIndex, warnings),
          payload.is_error === true,
        );
        incompleteToolActivities.delete(pending.activity);
        pendingCalls.delete(callId);
      } else {
        addWarning(warnings, `line ${sourceIndex + 1}: unpaired tool output was omitted`);
      }
      continue;
    }

    if (itemType === "web_search_call") {
      const action = normalizeWebSearchAction(payload, sourceIndex, warnings);
      if (action === null) {
        continue;
      }
      const input = action.input;
      const data: Record<string, unknown> = {
        kind: "search",
        rawInput: input,
        item: { input },
      };
      const rawCallId = asString(payload.id) ?? asString(payload.call_id);
      if (rawCallId !== null) {
        data.toolCallId = boundStableIdentifier(
          rawCallId,
          `line ${sourceIndex + 1}: web search call id`,
          warnings,
        );
      }
      pushEventRecord({
        kind: "activity",
        tone: "tool",
        activityKind: "tool.completed",
        summary: action.summary,
        payload: {
          itemType: "web_search",
          title: action.title,
          status: "completed",
          detail: action.detail,
          data,
        },
        createdAt,
        sourceIndex,
      });
      continue;
    }

    if (itemType === "tool_search_call") {
      const rawCallId = asString(payload.call_id) ?? asString(payload.id);
      if (rawCallId === null) {
        addWarning(
          warnings,
          `line ${sourceIndex + 1}: tool search call has no call id and was omitted`,
        );
        continue;
      }
      pendingToolSearches.set(rawCallId, {
        callId: boundStableIdentifier(
          rawCallId,
          `line ${sourceIndex + 1}: tool search call id`,
          warnings,
        ),
        createdAt,
        query: toolSearchQuery(payload, sourceIndex, warnings),
        sourceIndex,
      });
      continue;
    }

    if (itemType === "tool_search_output") {
      const rawCallId = asString(payload.call_id) ?? asString(payload.id);
      if (rawCallId === null) {
        addWarning(warnings, `line ${sourceIndex + 1}: tool search output has no call id`);
        continue;
      }
      const pending = pendingToolSearches.get(rawCallId);
      if (pending === undefined) {
        addWarning(warnings, `line ${sourceIndex + 1}: unpaired tool search output was omitted`);
        continue;
      }
      pushEventRecord(completedToolSearchActivity(pending, payload, sourceIndex, warnings));
      pendingToolSearches.delete(rawCallId);
      continue;
    }

    if (!ignoredResponseItemTypes.has(itemType) && !warnedUnknownResponseItemTypes.has(itemType)) {
      addWarning(
        warnings,
        `unknown response item type "${truncate(itemType, summaryLimit)}" skipped`,
      );
      warnedUnknownResponseItemTypes.add(itemType);
    }
  }

  if (incompleteToolActivities.size > 0) {
    const noun = incompleteToolActivities.size === 1 ? "call" : "calls";
    addWarning(
      warnings,
      `omitted ${incompleteToolActivities.size} unpaired tool ${noun} from imported transcript`,
    );
  }
  if (pendingToolSearches.size > 0) {
    const noun = pendingToolSearches.size === 1 ? "call" : "calls";
    addWarning(
      warnings,
      `omitted ${pendingToolSearches.size} unpaired tool search ${noun} from imported transcript`,
    );
  }

  const completedEventRecords = eventRecords.filter(
    (record) => record.kind !== "activity" || !incompleteToolActivities.has(record),
  );
  const records = collapseAdjacentCrossStreamMessages(completedEventRecords, fallbackMessages);
  appendOmittedAttachmentActivity(
    records,
    countLogicalAttachments(attachmentOccurrences),
    lastOmittedAttachmentAt,
    lastSourceIndex + 1,
  );
  appendParsingWarningActivity(records, warnings, lastSourceIndex + 2);
  if (records.length > IMPORT_NORMALIZED_SESSION_MAX_RECORDS) {
    throw new NormalizedRecordLimitError();
  }
  return finalize(meta, records, warnings, hasMetadata);
}
