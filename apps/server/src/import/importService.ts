// apps/server/src/import/importService.ts
// imports inert transcript records into orchestration projects and threads
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  IMPORT_RESULT_MESSAGE_MAX_CHARS,
  IMPORT_SESSIONS_MAX_ITEMS,
  IMPORT_SOURCE_PATH_MAX_CHARS,
  type ImportSessionsRequest,
  type ImportSessionsResult,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
  type ProjectId as ProjectIdType,
  type ProviderInstanceId,
  type ThreadImportContinuation,
  type ThreadId as ThreadIdType,
  type ThreadMessagesImportCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { parseClaudeSession } from "./claudeSessionParser.ts";
import type { AcpImportBatchLoadResult, AcpImportWireUsage } from "./acpImport.ts";
import { compactImportedSession } from "./compactImportedSession.ts";
import {
  bindImportedContinuation,
  IMPORT_CONTINUATION_PRESERVED_BINDING_REASON,
  ImportContinuationDeps,
} from "./continuationContract.ts";
import { parseCodexRollout } from "./codexRolloutParser.ts";
import { deterministicId, deterministicSortableMessageId } from "./ids.ts";
import { loadOpenCodeSessionFromMetadata } from "./openCodeStorage.ts";
import {
  readResolvedImportSourceFile,
  resolveImportSourcePath,
  type ImportFileSourceDescriptor,
} from "./sourceCatalog.ts";
import type { ImportSource, ImportedRecord, ImportedSession } from "./types.ts";
import {
  IMPORT_NORMALIZED_REQUEST_MAX_RECORDS,
  IMPORT_NORMALIZED_SESSION_MAX_BYTES,
  IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
  IMPORT_RPC_MAX_BYTES,
  IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES,
  ImportResourceLimitError,
  OPENCODE_SESSION_MAX_JSON_FILES,
  makeImportByteBudget,
  makeImportCountBudget,
  reserveImportBytes,
  reserveNormalizedImportResources,
} from "./resourceLimits.ts";

const importBatchSize = 200;
const importCreationAttempts = 3;
const titleLimit = 60;
const archivedImportHistoryOnlyReason = "the imported thread remains archived";
const maximumDateEpochMillis = 8_640_000_000_000_000;
export const ACP_IMPORT_REQUEST_DEADLINE_MS = 5 * 60_000;
export const IMPORT_REQUEST_DEADLINE_MS = 5 * 60_000;
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const importTransactionMutex = Semaphore.makeUnsafe(1);

export interface ImportServiceDepsShape {
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, Error>;
  readonly findThreadByContentHash: (
    lookup: ImportedThreadLookup,
  ) => Effect.Effect<ImportedThreadMatch | null, Error>;
  readonly findThreadById: (
    threadId: ThreadIdType,
  ) => Effect.Effect<ImportedThreadMatch | null, Error>;
  readonly findProjectByWorkspaceRoot: (
    normalizedRoot: string,
  ) => Effect.Effect<ProjectIdType | null, Error>;
  readonly isImportFinalized: (threadId: ThreadIdType) => Effect.Effect<boolean, Error>;
  readonly normalizeWorkspaceRoot: (path: string) => Effect.Effect<string, Error>;
  readonly resolveImportTarget: (
    driver: ProviderDriverKind,
    requestedInstanceId: ProviderInstanceId | null,
    compatibleInstanceIds: ReadonlyArray<ProviderInstanceId>,
  ) => Effect.Effect<ResolvedImportTarget | null, Error>;
  readonly threadExistsInShell: (threadId: ThreadIdType) => Effect.Effect<boolean, Error>;
  readonly fallbackModelSelection: ModelSelection;
  readonly maximumRequestBytes?: number;
  readonly maximumRequestRecords?: number;
  readonly requestDeadlineMs?: number;
  readonly sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor>;
  readonly loadAcpSessionsBatch: (input: {
    readonly source: "cursor" | "grok";
    readonly sourcePaths: ReadonlyArray<string>;
    readonly providerInstanceId: ProviderInstanceId;
    readonly maximumBytes: number;
    readonly wireUsage: AcpImportWireUsage;
  }) => Effect.Effect<ReadonlyArray<AcpImportBatchLoadResult>>;
}

export interface ResolvedImportTarget {
  readonly defaultModelSelection: ModelSelection;
  readonly availableModels: ReadonlyArray<string>;
}

export interface ImportedThreadLookup {
  readonly contentHash: string;
  readonly source: ImportSource;
  readonly sourcePath: string;
  readonly nativeSessionId: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
}

export interface ImportedThreadMatch {
  readonly threadId: ThreadIdType;
  readonly projectId: ProjectIdType;
  readonly contentHash: string;
  readonly source: ImportSource;
  readonly sourcePath: string;
  readonly nativeSessionId: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly modelSelection: ModelSelection;
  readonly archived: boolean;
}

export class ImportServiceDeps extends Context.Service<ImportServiceDeps, ImportServiceDepsShape>()(
  "456code/import/importService/ImportServiceDeps",
) {}

export class ImportService extends Context.Service<
  ImportService,
  {
    readonly importSessions: (
      request: ImportSessionsRequest,
    ) => Effect.Effect<ImportSessionsResult>;
  }
>()("456code/import/importService") {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedResultMessage(error: unknown): string {
  const message = errorMessage(error).trim() || "Session import failed";
  return message.length <= IMPORT_RESULT_MESSAGE_MAX_CHARS
    ? message
    : `${message.slice(0, IMPORT_RESULT_MESSAGE_MAX_CHARS - 1)}…`;
}

class ImportSessionOperationError extends Schema.TaggedErrorClass<ImportSessionOperationError>()(
  "ImportSessionOperationError",
  {
    operation: Schema.Literals(["read", "parse", "persist"]),
    sourcePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.operation} failed for '${this.sourcePath}': ${errorMessage(this.cause)}`;
  }
}

function hashContent(content: string): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex");
}

function parserFor(source: "codex-cli" | "claude-code") {
  return source === "codex-cli" ? parseCodexRollout : parseClaudeSession;
}

function driverFor(source: ImportSource): ProviderDriverKind {
  switch (source) {
    case "codex-cli":
      return ProviderDriverKind.make("codex");
    case "claude-code":
      return ProviderDriverKind.make("claudeAgent");
    case "opencode":
      return ProviderDriverKind.make("opencode");
    case "cursor":
      return ProviderDriverKind.make("cursor");
    case "grok":
      return ProviderDriverKind.make("grok");
  }
}

function importedTitle(session: ImportedSession): string {
  const candidate =
    session.meta.title ??
    session.records.find(
      (record): record is Extract<ImportedRecord, { kind: "message" }> =>
        record.kind === "message" && record.role === "user",
    )?.text ??
    "Imported session";
  const firstLine = candidate.trim().split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.length <= titleLimit) return firstLine || "Imported session";
  return `${firstLine.slice(0, titleLimit - 1)}…`;
}

function chunks<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function commandId(importSeed: string, ...parts: ReadonlyArray<string | number>): CommandId {
  return CommandId.make(deterministicId(importSeed, "command", ...parts));
}

function importedThreadSeed(importSeed: string, threadId: ThreadIdType): string {
  return [importSeed, threadId].join("\u0000");
}

function importedProjectId(normalizedRoot: string): ProjectIdType {
  return ProjectId.make(deterministicId(normalizedRoot, "import-project"));
}

function importedProjectCreateCommandId(normalizedRoot: string): CommandId {
  return CommandId.make(deterministicId(normalizedRoot, "import-project-create-command"));
}

function generatedProjectIdentity(normalizedRoot: string): {
  readonly commandId: CommandId;
  readonly projectId: ProjectIdType;
} {
  const generation = NodeCrypto.randomUUID();
  return {
    commandId: CommandId.make(
      deterministicId(normalizedRoot, "import-project-create-generation", generation),
    ),
    projectId: ProjectId.make(deterministicId(normalizedRoot, "import-project", generation)),
  };
}

function generatedThreadIdentity(importSeed: string): {
  readonly commandId: CommandId;
  readonly threadId: ThreadIdType;
} {
  const generation = NodeCrypto.randomUUID();
  return {
    commandId: commandId(importSeed, "thread-create-generation", generation),
    threadId: ThreadId.make(deterministicId(importSeed, "thread", generation)),
  };
}

function finalMarkerCreatedAt(records: ReadonlyArray<ImportedRecord>): string {
  if (records.length === 0) {
    throw new RangeError("Imported session has no records for its continuation marker");
  }
  const maximumTimestamp = records.reduce(
    (maximum, record) =>
      Math.max(maximum, DateTime.toEpochMillis(DateTime.makeUnsafe(record.createdAt))),
    Number.NEGATIVE_INFINITY,
  );
  const markerTimestamp = Math.min(maximumTimestamp + 1, maximumDateEpochMillis);
  if (!Number.isFinite(markerTimestamp)) {
    throw new RangeError("Imported session contains an invalid activity timestamp");
  }
  return DateTime.formatIso(DateTime.makeUnsafe(markerTimestamp));
}

function finalMarkerSequence(records: ReadonlyArray<ImportedRecord>): number {
  const maximumSourceSequence = records.reduce(
    (maximum, record) => Math.max(maximum, record.sourceIndex),
    -1,
  );
  if (!Number.isSafeInteger(maximumSourceSequence) || maximumSourceSequence < 0) {
    throw new RangeError("Imported session contains an invalid source sequence");
  }
  if (maximumSourceSequence === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Imported session source sequence has no successor");
  }
  return maximumSourceSequence + 1;
}

function makeImportCommand(
  importSeed: string,
  threadId: ThreadIdType,
  batch: ReadonlyArray<{
    readonly record: ImportedRecord;
    readonly recordIndex: number;
  }>,
  createdAt: string,
): ThreadMessagesImportCommand {
  const threadSeed = importedThreadSeed(importSeed, threadId);
  const firstRecordIndex = batch[0]?.recordIndex ?? -1;
  const lastRecordIndex = batch.at(-1)?.recordIndex ?? -1;
  return {
    type: "thread.messages.import",
    commandId: commandId(threadSeed, "records-v3", firstRecordIndex, lastRecordIndex, batch.length),
    threadId,
    messages: batch.flatMap(({ record, recordIndex }) =>
      record.kind === "message"
        ? [
            {
              messageId: MessageId.make(
                deterministicSortableMessageId(threadSeed, record.role, recordIndex),
              ),
              role: record.role,
              text: record.text,
              createdAt: record.createdAt,
            },
          ]
        : [],
    ),
    activities: batch.flatMap<OrchestrationThreadActivity>(({ record, recordIndex }) =>
      record.kind === "activity"
        ? [
            {
              id: EventId.make(
                deterministicId(threadSeed, "activity", record.activityKind, recordIndex),
              ),
              tone: record.tone,
              kind: record.activityKind,
              summary: record.summary,
              payload: record.payload,
              turnId: null,
              sequence: record.sourceIndex,
              createdAt: record.createdAt,
            },
          ]
        : [],
    ),
    createdAt,
  };
}

function makeContinuationActivityCommand(
  importSeed: string,
  threadId: ThreadIdType,
  driver: ProviderDriverKind,
  outcome: ThreadImportContinuation,
  createdAt: string,
  sequence: number,
): OrchestrationCommand {
  const threadSeed = importedThreadSeed(importSeed, threadId);
  const verified = outcome.state === "verified";
  const summary = verified
    ? `Native ${driver} continuation verified`
    : `History-only import: ${outcome.reason}`;
  const transitionKey = [
    driver,
    outcome.state,
    outcome.providerInstanceId ?? "none",
    outcome.continuationIdentity?.continuationKey ?? "unbound",
    outcome.reason ?? "none",
  ].join("\u0000");
  return {
    type: "thread.activity.append",
    commandId: commandId(threadSeed, "continuation-v3", transitionKey),
    threadId,
    activity: {
      id: EventId.make(deterministicId(threadSeed, "continuation-v3")),
      tone: "info",
      kind: verified ? "task.completed" : "runtime.warning",
      summary,
      payload: {
        type: "import.continuation",
        driverKind: driver,
        continuation: outcome,
      },
      turnId: null,
      sequence,
      createdAt,
    },
    createdAt,
  };
}

export const make = Effect.gen(function* () {
  const deps = yield* ImportServiceDeps;
  const continuation = yield* ImportContinuationDeps;

  const importSessionsUnlocked = Effect.fn("ImportService.importSessionsUnlocked")(function* (
    request: ImportSessionsRequest,
    result: {
      imported: ImportSessionsResult["imported"][number][];
      skipped: ImportSessionsResult["skipped"][number][];
      failed: ImportSessionsResult["failed"][number][];
    },
  ) {
    const importedThreadsBySourceAndHash = new Map<string, ImportedThreadMatch>();
    const importedThreadsByNativeSession = new Map<string, ImportedThreadMatch>();
    const configuredRequestMaximum = deps.maximumRequestBytes ?? IMPORT_RPC_MAX_BYTES;
    const requestMaximumBytes = Number.isFinite(configuredRequestMaximum)
      ? Math.max(0, Math.min(Math.floor(configuredRequestMaximum), IMPORT_RPC_MAX_BYTES))
      : IMPORT_RPC_MAX_BYTES;
    const requestByteBudget = makeImportByteBudget(requestMaximumBytes);
    const normalizedByteBudget = makeImportByteBudget(requestMaximumBytes);
    const configuredRequestMaximumRecords =
      deps.maximumRequestRecords ?? IMPORT_NORMALIZED_REQUEST_MAX_RECORDS;
    const normalizedRecordBudget = makeImportCountBudget(
      Number.isFinite(configuredRequestMaximumRecords)
        ? Math.max(
            0,
            Math.min(
              Math.floor(configuredRequestMaximumRecords),
              IMPORT_NORMALIZED_REQUEST_MAX_RECORDS,
            ),
          )
        : IMPORT_NORMALIZED_REQUEST_MAX_RECORDS,
    );
    const openCodeTraversalBudget = makeImportCountBudget(IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES);
    const openCodeJsonFileBudget = makeImportCountBudget(OPENCODE_SESSION_MAX_JSON_FILES);
    const seenRawRequestItems = new Set<string>();
    const seenCanonicalRequestItems = new Set<string>();
    const configuredSwapCleanupDeadline = deps.requestDeadlineMs ?? IMPORT_REQUEST_DEADLINE_MS;
    const swapCleanupDeadlineMs = Number.isFinite(configuredSwapCleanupDeadline)
      ? Math.max(1, Math.min(Math.floor(configuredSwapCleanupDeadline), 5_000))
      : 5_000;

    const ensureActiveProject = Effect.fn("ImportService.ensureActiveProject")(function* (
      normalizedRoot: string,
      createdAt: string,
    ) {
      const existingProjectId = yield* deps.findProjectByWorkspaceRoot(normalizedRoot);
      if (existingProjectId !== null) {
        return existingProjectId;
      }

      let lastDispatchError: Error | null = null;
      for (let attempt = 0; attempt < importCreationAttempts; attempt += 1) {
        const identity =
          attempt === 0
            ? {
                commandId: importedProjectCreateCommandId(normalizedRoot),
                projectId: importedProjectId(normalizedRoot),
              }
            : generatedProjectIdentity(normalizedRoot);
        yield* deps
          .dispatch({
            type: "project.create",
            commandId: identity.commandId,
            projectId: identity.projectId,
            title: NodePath.basename(normalizedRoot) || "Imported project",
            workspaceRoot: normalizedRoot,
            createdAt,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                lastDispatchError = error;
              }),
            ),
          );

        const activeProjectId = yield* deps.findProjectByWorkspaceRoot(normalizedRoot);
        if (activeProjectId !== null) {
          return activeProjectId;
        }
      }

      return yield* new ImportSessionOperationError({
        operation: "persist",
        sourcePath: normalizedRoot,
        cause:
          lastDispatchError ??
          `Failed to create an active imported project for '${normalizedRoot}'`,
      });
    });

    if (request.items.length > IMPORT_SESSIONS_MAX_ITEMS) {
      return {
        ...result,
        failed: [
          {
            sourcePath:
              request.items[0]?.sourcePath.slice(0, IMPORT_SOURCE_PATH_MAX_CHARS) ??
              "import-request",
            message: `import request exceeds ${IMPORT_SESSIONS_MAX_ITEMS} items`,
          },
        ],
      } satisfies ImportSessionsResult;
    }

    const acpBatchGroups = new Map<
      string,
      {
        readonly source: "cursor" | "grok";
        readonly providerInstanceId: ProviderInstanceId;
        readonly sourcePaths: string[];
      }
    >();
    const groupedAcpRequestKeys = new Set<string>();
    for (const item of request.items) {
      if (
        (item.source !== "cursor" && item.source !== "grok") ||
        item.providerInstanceId === null ||
        item.sourcePath.length > IMPORT_SOURCE_PATH_MAX_CHARS
      ) {
        continue;
      }
      const requestKey = [item.source, item.providerInstanceId, item.sourcePath].join("\u0000");
      if (groupedAcpRequestKeys.has(requestKey)) {
        continue;
      }
      groupedAcpRequestKeys.add(requestKey);
      const groupKey = `${item.source}\u0000${item.providerInstanceId}`;
      const existingGroup = acpBatchGroups.get(groupKey);
      if (existingGroup === undefined) {
        acpBatchGroups.set(groupKey, {
          source: item.source,
          providerInstanceId: item.providerInstanceId,
          sourcePaths: [item.sourcePath],
        });
      } else {
        existingGroup.sourcePaths.push(item.sourcePath);
      }
    }
    const acpBatchResults = new Map<
      string,
      {
        readonly session: AcpImportBatchLoadResult["session"];
        readonly error: unknown | null;
      }
    >();
    const acpWireUsage: AcpImportWireUsage = { consumedBytes: 0 };
    const acpRequestDeadlineExpired = Option.isNone(
      yield* Effect.gen(function* () {
        for (const group of acpBatchGroups.values()) {
          const remainingBytes = requestByteBudget.maximumBytes - requestByteBudget.consumedBytes;
          if (remainingBytes < 3) {
            for (const sourcePath of group.sourcePaths) {
              acpBatchResults.set(
                [group.source, group.providerInstanceId, sourcePath].join("\u0000"),
                {
                  session: null,
                  error: new ImportResourceLimitError({
                    sourcePath,
                    reason: `byte budget exceeded (${requestByteBudget.maximumBytes} bytes maximum)`,
                  }),
                },
              );
            }
            continue;
          }
          const wireBytesBeforeLoad = acpWireUsage.consumedBytes;
          let wireReservationError: ImportResourceLimitError | null = null;
          const loadedResults = yield* deps
            .loadAcpSessionsBatch({
              ...group,
              maximumBytes: remainingBytes,
              wireUsage: acpWireUsage,
            })
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  const reportedWireBytes = Number.isFinite(acpWireUsage.consumedBytes)
                    ? Math.max(wireBytesBeforeLoad, Math.floor(acpWireUsage.consumedBytes))
                    : wireBytesBeforeLoad;
                  acpWireUsage.consumedBytes = reportedWireBytes;
                  wireReservationError = reserveImportBytes(
                    requestByteBudget,
                    reportedWireBytes - wireBytesBeforeLoad,
                    group.sourcePaths[0] ?? `${group.source}:${group.providerInstanceId}`,
                  );
                }),
              ),
            );
          if (wireReservationError !== null) {
            const loadWireError = wireReservationError;
            for (const sourcePath of group.sourcePaths) {
              acpBatchResults.set(
                [group.source, group.providerInstanceId, sourcePath].join("\u0000"),
                { session: null, error: loadWireError },
              );
            }
            continue;
          }
          const requestedSourcePaths = new Set(group.sourcePaths);
          const retainedSourcePaths = new Set<string>();
          for (const loadedResult of loadedResults) {
            if (
              !requestedSourcePaths.has(loadedResult.sourcePath) ||
              retainedSourcePaths.has(loadedResult.sourcePath)
            ) {
              continue;
            }
            retainedSourcePaths.add(loadedResult.sourcePath);
            const key = [group.source, group.providerInstanceId, loadedResult.sourcePath].join(
              "\u0000",
            );
            if (loadedResult.error !== null || loadedResult.session === null) {
              acpBatchResults.set(key, {
                session: null,
                error: loadedResult.error ?? new Error("ACP session replay returned no transcript"),
              });
              continue;
            }
            const serialized = yield* encodeUnknownJsonString(loadedResult.session).pipe(
              Effect.result,
            );
            if (serialized._tag === "Failure") {
              acpBatchResults.set(key, {
                session: null,
                error: serialized.failure,
              });
              continue;
            }
            const reservationError = reserveImportBytes(
              requestByteBudget,
              NodeBuffer.Buffer.byteLength(serialized.success, "utf8"),
              loadedResult.sourcePath,
            );
            acpBatchResults.set(
              key,
              reservationError === null
                ? { session: loadedResult.session, error: null }
                : { session: null, error: reservationError },
            );
          }
        }
      }).pipe(Effect.timeoutOption(ACP_IMPORT_REQUEST_DEADLINE_MS)),
    );

    for (const item of request.items) {
      yield* Effect.gen(function* () {
        if (item.sourcePath.length > IMPORT_SOURCE_PATH_MAX_CHARS) {
          return yield* new ImportSessionOperationError({
            operation: "read",
            sourcePath: item.sourcePath.slice(0, IMPORT_SOURCE_PATH_MAX_CHARS),
            cause: new Error(`source path exceeds ${IMPORT_SOURCE_PATH_MAX_CHARS} characters`),
          });
        }
        const rawRequestKey = `${item.source}\u0000${item.sourcePath}\u0000${item.providerInstanceId ?? ""}`;
        if (seenRawRequestItems.has(rawRequestKey)) {
          result.skipped.push({
            sourcePath: item.sourcePath,
            reason: "duplicate import request item",
            threadId: null,
          });
          return;
        }
        seenRawRequestItems.add(rawRequestKey);
        let loaded: {
          readonly session: ImportedSession;
          readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
        };
        if (item.source === "cursor" || item.source === "grok") {
          const source = item.source;
          const batchResult = acpBatchResults.get(
            [source, item.providerInstanceId, item.sourcePath].join("\u0000"),
          );
          if (batchResult === undefined) {
            return yield* new ImportSessionOperationError({
              operation: "parse",
              sourcePath: item.sourcePath,
              cause: new Error(
                acpRequestDeadlineExpired
                  ? `ACP import request exceeded its ${ACP_IMPORT_REQUEST_DEADLINE_MS}ms aggregate load deadline`
                  : "ACP batch loader did not return this requested session",
              ),
            });
          }
          if (batchResult.error !== null || batchResult.session === null) {
            return yield* new ImportSessionOperationError({
              operation: "parse",
              sourcePath: item.sourcePath,
              cause: batchResult.error ?? new Error("ACP session replay returned no transcript"),
            });
          }
          const acpSession = batchResult.session;
          loaded = {
            session: {
              meta: {
                ...acpSession.meta,
                source,
              },
              records: [...acpSession.records],
              warnings: [...acpSession.warnings],
            },
            providerInstanceIds: [item.providerInstanceId],
          };
        } else {
          const source = item.source;
          // the same configured-source catalog powers discovery and import;
          // canonical resolution also rejects symlink escapes and non-files
          const trustedSource = yield* resolveImportSourcePath(
            deps.sourceDescriptors,
            source,
            item.sourcePath,
          );
          const requestKey = `${source}\u0000${trustedSource.canonicalPath}\u0000${item.providerInstanceId ?? ""}`;
          if (seenCanonicalRequestItems.has(requestKey)) {
            result.skipped.push({
              sourcePath: item.sourcePath,
              reason: "duplicate import request item",
              threadId: null,
            });
            return;
          }
          seenCanonicalRequestItems.add(requestKey);
          if (source === "opencode") {
            const openCode = yield* loadOpenCodeSessionFromMetadata(trustedSource.canonicalPath, {
              aggregateBudget: requestByteBudget,
              jsonFileBudget: openCodeJsonFileBudget,
              sourceValidation: trustedSource.validation,
              traversalBudget: openCodeTraversalBudget,
            });
            loaded = {
              session: openCode.session,
              providerInstanceIds: trustedSource.providerInstanceIds,
            };
          } else {
            const sourceFile = yield* readResolvedImportSourceFile(
              trustedSource,
              requestByteBudget,
            );
            const contentHash = hashContent(sourceFile.content);
            const session = yield* Effect.try({
              try: () =>
                parserFor(source)({
                  content: sourceFile.content,
                  sourcePath: sourceFile.canonicalPath,
                  contentHash,
                }),
              catch: (cause) =>
                new ImportSessionOperationError({
                  operation: "parse",
                  sourcePath: item.sourcePath,
                  cause,
                }),
            });
            loaded = {
              session,
              providerInstanceIds: trustedSource.providerInstanceIds,
            };
          }
        }
        if (
          item.providerInstanceId !== null &&
          !loaded.providerInstanceIds.includes(item.providerInstanceId)
        ) {
          result.skipped.push({
            sourcePath: item.sourcePath,
            reason: `provider instance '${item.providerInstanceId}' does not own this source`,
            threadId: null,
          });
          return;
        }
        const session = compactImportedSession(loaded.session);
        const serializedSession = yield* encodeUnknownJsonString(session).pipe(
          Effect.mapError(
            (cause) =>
              new ImportSessionOperationError({
                operation: "parse",
                sourcePath: item.sourcePath,
                cause,
              }),
          ),
        );
        const normalizedReservationError = reserveNormalizedImportResources({
          byteBudget: normalizedByteBudget,
          maximumSessionBytes: IMPORT_NORMALIZED_SESSION_MAX_BYTES,
          maximumSessionRecords: IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
          recordBudget: normalizedRecordBudget,
          recordCount: session.records.length,
          serializedBytes: NodeBuffer.Buffer.byteLength(serializedSession, "utf8"),
          sourcePath: item.sourcePath,
        });
        if (normalizedReservationError !== null) {
          return yield* new ImportSessionOperationError({
            operation: "parse",
            sourcePath: item.sourcePath,
            cause: normalizedReservationError,
          });
        }
        const contentHash = session.meta.contentHash;
        const messageCount = session.records.filter((record) => record.kind === "message").length;
        if (messageCount === 0) {
          result.skipped.push({
            sourcePath: item.sourcePath,
            reason: "no importable messages",
            threadId: null,
          });
          return;
        }

        const driver = driverFor(item.source);
        const proposedTarget = yield* deps.resolveImportTarget(
          driver,
          item.providerInstanceId,
          loaded.providerInstanceIds,
        );
        const resolvedTarget =
          proposedTarget !== null &&
          loaded.providerInstanceIds.includes(proposedTarget.defaultModelSelection.instanceId) &&
          (item.providerInstanceId === null ||
            proposedTarget.defaultModelSelection.instanceId === item.providerInstanceId)
            ? proposedTarget
            : null;
        const originProviderInstanceId =
          resolvedTarget?.defaultModelSelection.instanceId ?? item.providerInstanceId;
        const importSeed = [item.source, session.meta.sourcePath, contentHash].join("\u0000");
        const modelSelection =
          resolvedTarget === null
            ? deps.fallbackModelSelection
            : session.meta.model !== null &&
                resolvedTarget.availableModels.includes(session.meta.model)
              ? {
                  instanceId: resolvedTarget.defaultModelSelection.instanceId,
                  model: session.meta.model,
                }
              : resolvedTarget.defaultModelSelection;
        if (resolvedTarget === null) {
          yield* Effect.logWarning(
            "No provider instance resolved for imported session; using fallback",
            {
              sourcePath: item.sourcePath,
              driver,
              fallbackInstanceId: modelSelection.instanceId,
              requestedInstanceId: item.providerInstanceId,
              compatibleInstanceIds: loaded.providerInstanceIds,
            },
          );
        }

        const nativeSessionKey =
          session.meta.nativeSessionId === null
            ? null
            : [item.source, originProviderInstanceId ?? "none", session.meta.nativeSessionId].join(
                "\u0000",
              );
        const projectedThread = yield* deps.findThreadByContentHash({
          contentHash,
          source: item.source,
          sourcePath: session.meta.sourcePath,
          nativeSessionId: session.meta.nativeSessionId,
          providerInstanceId: originProviderInstanceId,
        });
        let existingThread =
          importedThreadsBySourceAndHash.get(importSeed) ??
          (nativeSessionKey === null
            ? undefined
            : importedThreadsByNativeSession.get(nativeSessionKey)) ??
          projectedThread;
        let incompleteImportProjectId: ProjectIdType | null = null;
        let incompleteImportWasArchived = false;
        let archivedIncompleteThreadToReplace: ImportedThreadMatch | null = null;
        let existingImportFinalized: boolean | null =
          existingThread?.archived === true
            ? yield* deps.isImportFinalized(existingThread.threadId)
            : null;
        if (existingThread !== null && existingThread.contentHash !== contentHash) {
          const importFinalized =
            existingImportFinalized ?? (yield* deps.isImportFinalized(existingThread.threadId));
          if (importFinalized) {
            result.skipped.push({
              sourcePath: item.sourcePath,
              reason:
                "already imported; the original session has new activity (delta sync not yet supported)",
              threadId: existingThread.threadId,
            });
            return;
          }
          incompleteImportProjectId = existingThread.projectId;
          incompleteImportWasArchived = existingThread.archived;
          if (existingThread.archived) {
            // keep the archived source durable until its replacement is also
            // archived; this makes a failed or interrupted swap retryable
            archivedIncompleteThreadToReplace = existingThread;
          } else {
            yield* deps.dispatch({
              type: "thread.delete",
              commandId: commandId(importSeed, "replace-incomplete-v1", existingThread.threadId),
              threadId: existingThread.threadId,
            });
          }
          for (const [key, match] of importedThreadsBySourceAndHash) {
            if (match.threadId === existingThread.threadId) {
              importedThreadsBySourceAndHash.delete(key);
            }
          }
          for (const [key, match] of importedThreadsByNativeSession) {
            if (match.threadId === existingThread.threadId) {
              importedThreadsByNativeSession.delete(key);
            }
          }
          existingThread = null;
          existingImportFinalized = false;
        }
        if (
          existingThread !== null &&
          existingThread.providerInstanceId !== originProviderInstanceId
        ) {
          result.skipped.push({
            sourcePath: item.sourcePath,
            reason: "already imported",
            threadId: existingThread.threadId,
          });
          return;
        }
        const wasAlreadyImported = existingThread !== null;
        if (
          existingThread === null &&
          incompleteImportProjectId === null &&
          session.meta.cwd === null
        ) {
          result.skipped.push({
            sourcePath: item.sourcePath,
            reason: "no cwd recorded",
            threadId: null,
          });
          return;
        }

        const now = DateTime.formatIso(yield* DateTime.now);
        let projectId = existingThread?.projectId ?? incompleteImportProjectId;
        if (projectId === null) {
          const normalizedCwd = yield* deps.normalizeWorkspaceRoot(session.meta.cwd!);
          projectId = yield* ensureActiveProject(normalizedCwd, now);
        }

        const threadCreateBase = {
          type: "thread.create",
          projectId,
          title: importedTitle(session),
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: session.meta.gitBranch,
          worktreePath: null,
          origin: {
            kind: "imported",
            source: item.source,
            sourcePath: session.meta.sourcePath,
            contentHash,
            nativeSessionId: session.meta.nativeSessionId,
            providerInstanceId: originProviderInstanceId,
            importedAt: now,
          },
          createdAt: session.meta.firstActivityAt ?? now,
        } as const;
        let threadId = existingThread?.threadId ?? null;
        if (threadId === null) {
          const initialProjectId = projectId;
          let archivedReplacementCandidate: {
            readonly threadId: ThreadIdType;
            readonly projectId: ProjectIdType;
          } | null = null;
          let archivedReplacementSwapComplete = false;
          const cleanupArchivedReplacement = (replacement: {
            readonly threadId: ThreadIdType;
            readonly projectId: ProjectIdType;
          }) =>
            Effect.gen(function* () {
              if (archivedIncompleteThreadToReplace === null) {
                return;
              }
              const original = yield* deps.findThreadById(
                archivedIncompleteThreadToReplace.threadId,
              );
              if (original === null) {
                return;
              }
              if (
                original.projectId !== archivedIncompleteThreadToReplace.projectId ||
                original.contentHash !== archivedIncompleteThreadToReplace.contentHash ||
                original.source !== archivedIncompleteThreadToReplace.source ||
                original.sourcePath !== archivedIncompleteThreadToReplace.sourcePath ||
                original.nativeSessionId !== archivedIncompleteThreadToReplace.nativeSessionId ||
                original.providerInstanceId !== archivedIncompleteThreadToReplace.providerInstanceId
              ) {
                return yield* new ImportSessionOperationError({
                  operation: "persist",
                  sourcePath: item.sourcePath,
                  cause: `incomplete archived thread '${archivedIncompleteThreadToReplace.threadId}' no longer matches this import`,
                });
              }
              const current = yield* deps.findThreadById(replacement.threadId);
              if (
                current === null ||
                current.projectId !== replacement.projectId ||
                current.contentHash !== contentHash ||
                current.source !== item.source ||
                current.sourcePath !== session.meta.sourcePath ||
                current.nativeSessionId !== session.meta.nativeSessionId ||
                current.providerInstanceId !== originProviderInstanceId
              ) {
                return yield* new ImportSessionOperationError({
                  operation: "persist",
                  sourcePath: item.sourcePath,
                  cause: `replacement thread '${replacement.threadId}' no longer matches this import`,
                });
              }
              return yield* deps
                .dispatch({
                  type: "thread.delete",
                  commandId: commandId(
                    importedThreadSeed(importSeed, replacement.threadId),
                    "cleanup-failed-archive-v1",
                  ),
                  threadId: replacement.threadId,
                })
                .pipe(
                  Effect.timeoutOption(swapCleanupDeadlineMs),
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        Effect.fail(
                          new ImportSessionOperationError({
                            operation: "persist",
                            sourcePath: item.sourcePath,
                            cause: `replacement cleanup exceeded ${swapCleanupDeadlineMs}ms deadline`,
                          }),
                        ),
                      onSome: () => Effect.void,
                    }),
                  ),
                );
            });
          const createThreadAndSwapArchivedSource = Effect.gen(function* () {
            let creationProjectId = initialProjectId;
            let createdThreadId: ThreadIdType | null = null;
            let replacementAlreadyArchived = false;
            let lastDispatchError: Error | null = null;
            for (let attempt = 0; attempt < importCreationAttempts; attempt += 1) {
              if (attempt > 0) {
                const normalizedCwd = yield* deps.normalizeWorkspaceRoot(session.meta.cwd!);
                creationProjectId = yield* ensureActiveProject(normalizedCwd, now);
              }
              const identity =
                attempt === 0
                  ? {
                      commandId: commandId(importSeed, "thread-create"),
                      threadId: ThreadId.make(deterministicId(importSeed, "thread")),
                    }
                  : generatedThreadIdentity(importSeed);
              if (archivedIncompleteThreadToReplace !== null) {
                archivedReplacementCandidate = {
                  threadId: identity.threadId,
                  projectId: creationProjectId,
                };
              }
              yield* deps
                .dispatch({
                  ...threadCreateBase,
                  projectId: creationProjectId,
                  commandId: identity.commandId,
                  threadId: identity.threadId,
                })
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      lastDispatchError = error;
                    }),
                  ),
                );

              // the archived source deliberately remains discoverable until
              // the replacement is safe, so verify this exact new id instead
              // of resolving the still-authoritative source identity
              if (archivedIncompleteThreadToReplace !== null) {
                const replacement = yield* deps.findThreadById(identity.threadId);
                if (
                  replacement !== null &&
                  replacement.projectId === creationProjectId &&
                  replacement.contentHash === contentHash &&
                  replacement.source === item.source &&
                  replacement.sourcePath === session.meta.sourcePath &&
                  replacement.nativeSessionId === session.meta.nativeSessionId &&
                  replacement.providerInstanceId === originProviderInstanceId
                ) {
                  createdThreadId = identity.threadId;
                  replacementAlreadyArchived = replacement.archived;
                  break;
                }
                continue;
              }

              const claimedThread = yield* deps.findThreadByContentHash({
                contentHash,
                source: item.source,
                sourcePath: session.meta.sourcePath,
                nativeSessionId: session.meta.nativeSessionId,
                providerInstanceId: originProviderInstanceId,
              });
              if (claimedThread !== null) {
                if (claimedThread.contentHash !== contentHash) {
                  return yield* new ImportSessionOperationError({
                    operation: "persist",
                    sourcePath: item.sourcePath,
                    cause:
                      "The native session was claimed with different content while this import was creating its thread",
                  });
                }
                existingThread = claimedThread;
                createdThreadId = claimedThread.threadId;
                creationProjectId = claimedThread.projectId;
                break;
              }
              if (yield* deps.threadExistsInShell(identity.threadId)) {
                createdThreadId = identity.threadId;
                break;
              }
            }
            if (createdThreadId === null) {
              return yield* new ImportSessionOperationError({
                operation: "persist",
                sourcePath: item.sourcePath,
                cause:
                  lastDispatchError ?? "Failed to create an active thread for the imported session",
              });
            }

            if (archivedIncompleteThreadToReplace !== null) {
              if (!replacementAlreadyArchived) {
                let archiveError: Error | null = null;
                yield* deps
                  .dispatch({
                    type: "thread.archive",
                    commandId: commandId(
                      importedThreadSeed(importSeed, createdThreadId),
                      "restore-archive-v1",
                    ),
                    threadId: createdThreadId,
                  })
                  .pipe(
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        archiveError = error;
                      }),
                    ),
                  );
                if (archiveError !== null) {
                  let cleanupError: Error | null = null;
                  yield* cleanupArchivedReplacement({
                    threadId: createdThreadId,
                    projectId: creationProjectId,
                  }).pipe(
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        cleanupError = error;
                      }),
                    ),
                  );
                  if (cleanupError !== null) {
                    return yield* new ImportSessionOperationError({
                      operation: "persist",
                      sourcePath: item.sourcePath,
                      cause: new Error(
                        `Failed to archive replacement thread and cleanup also failed: ${errorMessage(cleanupError)}`,
                        { cause: archiveError },
                      ),
                    });
                  }
                  return yield* new ImportSessionOperationError({
                    operation: "persist",
                    sourcePath: item.sourcePath,
                    cause: archiveError,
                  });
                }
              }

              let oldDeleteError: Error | null = null;
              yield* deps
                .dispatch({
                  type: "thread.delete",
                  commandId: commandId(
                    importSeed,
                    "replace-incomplete-v1",
                    archivedIncompleteThreadToReplace.threadId,
                  ),
                  threadId: archivedIncompleteThreadToReplace.threadId,
                })
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      oldDeleteError = error;
                    }),
                  ),
                );
              if (oldDeleteError !== null) {
                let cleanupError: Error | null = null;
                yield* cleanupArchivedReplacement({
                  threadId: createdThreadId,
                  projectId: creationProjectId,
                }).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      cleanupError = error;
                    }),
                  ),
                );
                if (cleanupError !== null) {
                  return yield* new ImportSessionOperationError({
                    operation: "persist",
                    sourcePath: item.sourcePath,
                    cause: new Error(
                      `Failed to delete the incomplete archived thread and replacement cleanup also failed: ${errorMessage(cleanupError)}`,
                      { cause: oldDeleteError },
                    ),
                  });
                }
                return yield* new ImportSessionOperationError({
                  operation: "persist",
                  sourcePath: item.sourcePath,
                  cause: oldDeleteError,
                });
              }

              archivedReplacementSwapComplete = true;
            }

            return {
              threadId: createdThreadId,
              projectId: creationProjectId,
            };
          });

          const createdThread =
            archivedIncompleteThreadToReplace === null
              ? yield* createThreadAndSwapArchivedSource
              : yield* createThreadAndSwapArchivedSource.pipe(
                  Effect.onInterrupt(() => {
                    const replacement = archivedReplacementCandidate;
                    return replacement === null || archivedReplacementSwapComplete
                      ? Effect.void
                      : cleanupArchivedReplacement(replacement).pipe(Effect.ignore);
                  }),
                );
          threadId = createdThread.threadId;
          projectId = createdThread.projectId;
        }
        const importShouldRemainArchived =
          incompleteImportWasArchived || existingThread?.archived === true;

        const indexedRecords: Array<{
          readonly record: ImportedRecord;
          readonly recordIndex: number;
        }> = session.records.map((record, recordIndex) => ({
          record,
          recordIndex,
        }));
        for (const batch of chunks(indexedRecords, importBatchSize)) {
          yield* deps.dispatch(makeImportCommand(importSeed, threadId, batch, now));
        }

        const continuationOutcome = importShouldRemainArchived
          ? existingImportFinalized === true
            ? null
            : {
                state: "history-only" as const,
                providerInstanceId: originProviderInstanceId,
                continuationIdentity: null,
                reason: archivedImportHistoryOnlyReason,
              }
          : resolvedTarget === null && !wasAlreadyImported
            ? {
                state: "history-only" as const,
                providerInstanceId: item.providerInstanceId,
                continuationIdentity: null,
                reason:
                  item.providerInstanceId === null
                    ? `no available ${driver} provider instance owns this source`
                    : `provider instance '${item.providerInstanceId}' is unavailable or does not own this source`,
              }
            : yield* bindImportedContinuation({
                threadId,
                meta: session.meta,
                providerInstanceId:
                  resolvedTarget?.defaultModelSelection.instanceId ?? item.providerInstanceId,
                modelSelection:
                  resolvedTarget === null && existingThread !== null
                    ? existingThread.modelSelection
                    : modelSelection,
                runtimeMode: "approval-required",
              }).pipe(Effect.provideService(ImportContinuationDeps, continuation));
        if (
          wasAlreadyImported &&
          resolvedTarget !== null &&
          continuationOutcome?.state === "verified" &&
          existingThread !== null &&
          (existingThread.modelSelection.instanceId !== modelSelection.instanceId ||
            existingThread.modelSelection.model !== modelSelection.model)
        ) {
          yield* deps.dispatch({
            type: "thread.meta.update",
            commandId: commandId(
              importedThreadSeed(importSeed, threadId),
              "continuation-model-v3",
              modelSelection.instanceId,
              modelSelection.model,
            ),
            threadId,
            modelSelection,
          });
        }
        const markerCreatedAt = finalMarkerCreatedAt(session.records);
        const markerSequence = finalMarkerSequence(session.records);
        const bindingWasPreserved =
          continuationOutcome?.state === "history-only" &&
          continuationOutcome.reason === IMPORT_CONTINUATION_PRESERVED_BINDING_REASON;
        if (continuationOutcome !== null && !bindingWasPreserved) {
          yield* deps.dispatch(
            makeContinuationActivityCommand(
              importSeed,
              threadId,
              driver,
              continuationOutcome,
              markerCreatedAt,
              markerSequence,
            ),
          );
        }
        const importedThread = {
          threadId,
          projectId,
          contentHash,
          source: item.source,
          sourcePath: session.meta.sourcePath,
          nativeSessionId: session.meta.nativeSessionId,
          providerInstanceId: originProviderInstanceId,
          modelSelection:
            resolvedTarget === null && existingThread !== null
              ? existingThread.modelSelection
              : modelSelection,
          archived: importShouldRemainArchived,
        } satisfies ImportedThreadMatch;
        importedThreadsBySourceAndHash.set(importSeed, importedThread);
        if (nativeSessionKey !== null) {
          importedThreadsByNativeSession.set(nativeSessionKey, importedThread);
        }
        if (wasAlreadyImported) {
          result.skipped.push({
            sourcePath: item.sourcePath,
            reason: "already imported",
            threadId,
          });
          return;
        }
        result.imported.push({
          sourcePath: item.sourcePath,
          threadId,
          projectId,
          messageCount,
          activityCount: session.records.length - messageCount,
          continuation: continuationOutcome ?? {
            state: "history-only",
            providerInstanceId: originProviderInstanceId,
            continuationIdentity: null,
            reason: "archived imports do not retain live continuation",
          },
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            result.failed.push({
              sourcePath: item.sourcePath,
              message: boundedResultMessage(error),
            });
          }),
        ),
      );
    }

    return result satisfies ImportSessionsResult;
  });

  const importSessions = Effect.fn("ImportService.importSessions")(
    (request: ImportSessionsRequest) =>
      Effect.suspend(() => {
        const result: {
          imported: ImportSessionsResult["imported"][number][];
          skipped: ImportSessionsResult["skipped"][number][];
          failed: ImportSessionsResult["failed"][number][];
        } = { imported: [], skipped: [], failed: [] };
        const configuredDeadline = deps.requestDeadlineMs ?? IMPORT_REQUEST_DEADLINE_MS;
        const requestDeadlineMs = Number.isFinite(configuredDeadline)
          ? Math.max(1, Math.min(Math.floor(configuredDeadline), IMPORT_REQUEST_DEADLINE_MS))
          : IMPORT_REQUEST_DEADLINE_MS;
        return importTransactionMutex
          .withPermitsIfAvailable(1)(
            importSessionsUnlocked(request, result).pipe(
              Effect.timeoutOption(requestDeadlineMs),
              Effect.map(
                Option.match({
                  onNone: () => {
                    const reportedSourcePaths = new Set([
                      ...result.imported.map((item) => item.sourcePath),
                      ...result.skipped.map((item) => item.sourcePath),
                      ...result.failed.map((item) => item.sourcePath),
                    ]);
                    for (const item of request.items) {
                      if (reportedSourcePaths.has(item.sourcePath)) {
                        continue;
                      }
                      reportedSourcePaths.add(item.sourcePath);
                      result.failed.push({
                        sourcePath: item.sourcePath.slice(0, IMPORT_SOURCE_PATH_MAX_CHARS),
                        message: `import request exceeded its ${requestDeadlineMs}ms aggregate execution deadline; retry is safe because import command identifiers are deterministic`,
                      });
                    }
                    return result satisfies ImportSessionsResult;
                  },
                  onSome: (completed) => completed,
                }),
              ),
            ),
          )
          .pipe(
            Effect.map(
              Option.match({
                onNone: () => ({
                  imported: [],
                  skipped: [],
                  failed: request.items.map((item) => ({
                    sourcePath: item.sourcePath.slice(0, IMPORT_SOURCE_PATH_MAX_CHARS),
                    message: "import skipped because another session import is already in progress",
                  })),
                }),
                onSome: (completed) => completed,
              }),
            ),
          );
      }),
  );

  return ImportService.of({ importSessions });
});

export const layer = Layer.effect(ImportService, make);
