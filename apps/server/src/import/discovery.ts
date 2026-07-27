// apps/server/src/import/discovery.ts
// discovers and describes importable provider transcript sessions
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  IMPORT_METADATA_MAX_CHARS,
  IMPORT_RESULT_MESSAGE_MAX_CHARS,
  IMPORT_SCAN_MAX_CANDIDATES,
  IMPORT_SCAN_MAX_ERRORS,
  IMPORT_SOURCE_PATH_MAX_CHARS,
  IMPORT_TITLE_MAX_CHARS,
  IMPORT_WORKSPACE_ROOT_MAX_CHARS,
  ImportScanCandidate,
  type ImportScanResult,
  type ProjectId,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { parseClaudeSession } from "./claudeSessionParser.ts";
import { parseCodexRollout } from "./codexRolloutParser.ts";
import type { AcpImportCatalogLoadResult } from "./acpImport.ts";
import { compactImportedSession } from "./compactImportedSession.ts";
import {
  discoverOpenCodeSessionMetadataFiles,
  loadOpenCodeSessionFromMetadata,
} from "./openCodeStorage.ts";
import {
  groupImportFileSourceDescriptors,
  loadBoundedImportSourceFile,
  type AcpImportSourceDescriptor,
  type ImportFileSource,
  type ImportFileSourceDescriptor,
  type ImportScanRootOverrides,
  resolveAcpImportSourceCatalog,
  resolveDefaultSourceCatalog,
  resolveImportSourcePath,
  resolveSourceCatalog,
  type SourceCatalogOptions,
} from "./sourceCatalog.ts";
import { isImportedSessionSourceIdentityValid } from "./sourceIdentity.ts";
import type { ImportSource, ImportedSession } from "./types.ts";
import {
  type ImportCountBudget,
  IMPORT_NORMALIZED_REQUEST_MAX_RECORDS,
  IMPORT_NORMALIZED_SESSION_MAX_BYTES,
  IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
  IMPORT_RPC_MAX_BYTES,
  IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES,
  IMPORT_SESSION_MAX_BYTES,
  OPENCODE_SESSION_MAX_JSON_FILES,
  makeImportByteBudget,
  makeImportCountBudget,
  partitionAcpImportBytePolicy,
  reserveNormalizedImportResources,
  takeImportCount,
} from "./resourceLimits.ts";

export {
  type ImportScanRootOverrides,
  type ImportScanRoots,
  resolveScanRoots,
} from "./sourceCatalog.ts";

const claudeSessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const importScanTimeoutMs = 60_000;
const defaultAcpScanPhaseTimeoutMs = Math.floor(importScanTimeoutMs / 2);
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const importScanSemaphore = Semaphore.makeUnsafe(1);

export interface ImportDiscoveryResourceLimits {
  readonly maximumScanBytes?: number;
  readonly acpScanPhaseTimeoutMs?: number;
  readonly scanTimeoutMs?: number;
}

export interface ImportDiscoveryDepsShape {
  readonly findThreadByContentHash: (lookup: {
    readonly contentHash: string;
    readonly source: ImportSource;
    readonly sourcePath: string;
    readonly nativeSessionId: string | null;
    readonly providerInstanceId: ProviderInstanceId | null;
  }) => Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId | null;
      readonly archived: boolean;
    } | null,
    Error
  >;
  readonly findProjectByWorkspaceRoot: (
    normalizedRoot: string,
  ) => Effect.Effect<ProjectId | null, Error>;
  readonly normalizeWorkspaceRoot: (path: string) => Effect.Effect<string, Error>;
  readonly scanAcpSource: (
    descriptor: AcpImportSourceDescriptor,
    maximumSessionsToLoad: number,
  ) => Effect.Effect<ReadonlyArray<AcpImportCatalogLoadResult>, Error>;
  readonly resourceLimits?: ImportDiscoveryResourceLimits;
}

export class ImportDiscoveryDeps extends Context.Service<
  ImportDiscoveryDeps,
  ImportDiscoveryDepsShape
>()("456code/import/discovery/ImportDiscoveryDeps") {}

export class ImportDiscovery extends Context.Service<
  ImportDiscovery,
  {
    readonly scan: {
      (settings: ServerSettings, options?: SourceCatalogOptions): Effect.Effect<ImportScanResult>;
      (overrides?: ImportScanRootOverrides): Effect.Effect<ImportScanResult>;
    };
  }
>()("456code/import/discovery/ImportDiscovery") {}

async function* directoryEntries(
  path: string,
  traversalBudget: ImportCountBudget,
  signal: AbortSignal,
): AsyncGenerator<NodeFS.Dirent> {
  let directory: NodeFS.Dir | null = null;
  try {
    signal.throwIfAborted();
    directory = await NodeFSP.opendir(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  try {
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (!takeImportCount(traversalBudget)) {
        return;
      }
      yield entry;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function codexCandidates(
  root: string,
  traversalBudget: ImportCountBudget,
  signal: AbortSignal,
): Promise<string[]> {
  const candidates: string[] = [];
  for await (const year of directoryEntries(root, traversalBudget, signal)) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) {
      continue;
    }
    const yearPath = NodePath.join(root, year.name);
    for await (const month of directoryEntries(yearPath, traversalBudget, signal)) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) {
        continue;
      }
      const monthPath = NodePath.join(yearPath, month.name);
      for await (const day of directoryEntries(monthPath, traversalBudget, signal)) {
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) {
          continue;
        }
        const dayPath = NodePath.join(monthPath, day.name);
        for await (const file of directoryEntries(dayPath, traversalBudget, signal)) {
          if (file.isFile() && /^rollout-.*\.jsonl$/.test(file.name)) {
            candidates.push(NodePath.join(dayPath, file.name));
          }
        }
        if (traversalBudget.truncated) return candidates;
      }
      if (traversalBudget.truncated) return candidates;
    }
    if (traversalBudget.truncated) return candidates;
  }
  return candidates;
}

async function claudeCandidates(
  root: string,
  traversalBudget: ImportCountBudget,
  signal: AbortSignal,
): Promise<string[]> {
  const candidates: string[] = [];
  for await (const project of directoryEntries(root, traversalBudget, signal)) {
    if (!project.isDirectory()) {
      continue;
    }
    const projectPath = NodePath.join(root, project.name);
    for await (const file of directoryEntries(projectPath, traversalBudget, signal)) {
      if (
        file.isFile() &&
        file.name.endsWith(".jsonl") &&
        claudeSessionIdPattern.test(file.name.slice(0, -".jsonl".length))
      ) {
        candidates.push(NodePath.join(projectPath, file.name));
      }
    }
    if (traversalBudget.truncated) return candidates;
  }
  return candidates.toSorted();
}

function hashContent(content: string): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maximumChars: number): string {
  return value.length <= maximumChars ? value : `${value.slice(0, Math.max(0, maximumChars - 1))}…`;
}

function boundedPath(value: string | null): string | null {
  return value === null ? null : truncate(value, IMPORT_SOURCE_PATH_MAX_CHARS);
}

function boundedMetadata(value: string | null, maximumChars: number): string | null {
  return value === null ? null : truncate(value, maximumChars);
}

function boundedIdentity(value: string | null): string | null {
  return value !== null && value.length <= IMPORT_METADATA_MAX_CHARS ? value : null;
}

function fairShares(total: number, participantCount: number): ReadonlyArray<number> {
  if (participantCount <= 0) {
    return [];
  }
  const base = Math.floor(total / participantCount);
  const remainder = total % participantCount;
  return Array.from({ length: participantCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function boundedPositiveInteger(
  configured: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (configured === undefined || !Number.isFinite(configured)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(configured), maximum));
}

function isByteBudgetError(
  error: unknown,
  budget: ReturnType<typeof makeImportByteBudget>,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ImportResourceLimitError" &&
    "reason" in error &&
    error.reason === `byte budget exceeded (${budget.maximumBytes} bytes maximum)`
  );
}

function discoveryFileReadError(error: Error): Error {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ImportResourceLimitError" &&
    "reason" in error &&
    error.reason === `file exceeds ${IMPORT_SESSION_MAX_BYTES} bytes`
    ? new ImportDiscoverySkipError({ message: "skipped: file exceeds 25MB" })
    : error;
}

class ImportDiscoveryOperationError extends Schema.TaggedErrorClass<ImportDiscoveryOperationError>()(
  "ImportDiscoveryOperationError",
  {
    operation: Schema.Literals(["read", "stat", "parse", "discover"]),
    sourcePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.operation} failed for '${this.sourcePath}': ${errorMessage(this.cause)}`;
  }
}

class ImportDiscoverySkipError extends Schema.TaggedErrorClass<ImportDiscoverySkipError>()(
  "ImportDiscoverySkipError",
  {
    message: Schema.String,
  },
) {}

function parserFor(source: "codex-cli" | "claude-code") {
  return source === "codex-cli" ? parseCodexRollout : parseClaudeSession;
}

export const make = Effect.gen(function* () {
  const deps = yield* ImportDiscoveryDeps;
  const configuredScanTimeoutMs = boundedPositiveInteger(
    deps.resourceLimits?.scanTimeoutMs,
    importScanTimeoutMs,
    importScanTimeoutMs,
  );

  interface ImportScanProgress {
    readonly candidates: ImportScanCandidate[];
    readonly errors: ImportScanResult["errors"][number][];
    omittedErrorCount: number;
  }

  const appendScanError = (
    progress: ImportScanProgress,
    issue: ImportScanResult["errors"][number],
  ) => {
    if (progress.errors.length < IMPORT_SCAN_MAX_ERRORS) {
      const message = issue.message.trim() || "Unknown import scan error";
      progress.errors.push({
        sourcePath: boundedPath(issue.sourcePath),
        message: truncate(message, IMPORT_RESULT_MESSAGE_MAX_CHARS),
      });
    } else {
      progress.omittedErrorCount += 1;
    }
  };

  const snapshotScanProgress = (progress: ImportScanProgress) =>
    DateTime.now.pipe(
      Effect.map((now) => {
        const errors = [...progress.errors];
        if (progress.omittedErrorCount > 0) {
          errors.push({
            sourcePath: null,
            message: `${progress.omittedErrorCount} additional scan errors omitted`,
          });
        }
        return {
          candidates: progress.candidates.toSorted(
            (left, right) =>
              (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? "") ||
              left.source.localeCompare(right.source) ||
              left.sourcePath.localeCompare(right.sourcePath),
          ),
          scannedAt: DateTime.formatIso(now),
          errors,
        } satisfies ImportScanResult;
      }),
    );

  const findImportedThread = Effect.fn("ImportDiscovery.findImportedThread")(function* (input: {
    readonly contentHash: string;
    readonly source: ImportSource;
    readonly sourcePath: string;
    readonly nativeSessionId: string | null;
    readonly providerInstanceIds: ReadonlyArray<ProviderInstanceId>;
  }) {
    for (const providerInstanceId of input.providerInstanceIds) {
      const match = yield* deps.findThreadByContentHash({
        contentHash: input.contentHash,
        source: input.source,
        sourcePath: input.sourcePath,
        nativeSessionId: input.nativeSessionId,
        providerInstanceId,
      });
      if (match !== null) {
        return match;
      }
    }
    return yield* deps.findThreadByContentHash({
      contentHash: input.contentHash,
      source: input.source,
      sourcePath: input.sourcePath,
      nativeSessionId: input.nativeSessionId,
      providerInstanceId: null,
    });
  });

  const describeCandidate = Effect.fn("ImportDiscovery.describeCandidate")(function* (
    source: ImportFileSource,
    sourcePath: string,
    providerInstanceIds: ImportScanCandidate["providerInstanceIds"],
    sourceDescriptors: ReadonlyArray<ImportFileSourceDescriptor>,
    scanByteBudget: ReturnType<typeof makeImportByteBudget>,
    normalizedRecordBudget: ImportCountBudget,
    openCodeJsonFileBudget: ImportCountBudget,
    traversalBudget: ImportCountBudget,
  ): Effect.fn.Return<ImportScanCandidate | null, Error> {
    if (sourcePath.length > IMPORT_SOURCE_PATH_MAX_CHARS) {
      return yield* new ImportDiscoverySkipError({
        message: `skipped: source path exceeds ${IMPORT_SOURCE_PATH_MAX_CHARS} characters`,
      });
    }
    const loaded =
      source === "opencode"
        ? yield* Effect.gen(function* () {
            const trustedSource = yield* resolveImportSourcePath(
              sourceDescriptors,
              source,
              sourcePath,
            );
            return yield* loadOpenCodeSessionFromMetadata(trustedSource.canonicalPath, {
              aggregateBudget: scanByteBudget,
              jsonFileBudget: openCodeJsonFileBudget,
              traversalBudget,
              sourceValidation: trustedSource.validation,
            }).pipe(
              Effect.map((result) => ({
                session: result.session,
                modifiedAt: result.modifiedAt,
              })),
            );
          })
        : yield* Effect.gen(function* () {
            const sourceFile = yield* loadBoundedImportSourceFile(
              sourceDescriptors,
              source,
              sourcePath,
              scanByteBudget,
            ).pipe(Effect.mapError(discoveryFileReadError));
            const contentHash = hashContent(sourceFile.content);
            const session: ImportedSession = yield* Effect.try({
              try: () =>
                parserFor(source)({
                  content: sourceFile.content,
                  sourcePath: sourceFile.canonicalPath,
                  contentHash,
                }),
              catch: (cause) =>
                new ImportDiscoveryOperationError({
                  operation: "parse",
                  sourcePath,
                  cause,
                }),
            });
            return {
              session,
              modifiedAt: DateTime.formatIso(DateTime.makeUnsafe(sourceFile.mtimeMs)),
            };
          });
    const session = compactImportedSession(loaded.session);
    const serializedSession = yield* encodeUnknownJsonString(session);
    const normalizedReservationError = reserveNormalizedImportResources({
      byteBudget: scanByteBudget,
      maximumSessionBytes: IMPORT_NORMALIZED_SESSION_MAX_BYTES,
      maximumSessionRecords: IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
      recordBudget: normalizedRecordBudget,
      recordCount: session.records.length,
      serializedBytes: NodeBuffer.Buffer.byteLength(serializedSession, "utf8"),
      sourcePath,
    });
    if (normalizedReservationError !== null) {
      return yield* normalizedReservationError;
    }
    const messageCount = session.records.filter((record) => record.kind === "message").length;
    if (messageCount === 0) {
      return null;
    }

    const normalizedCwd =
      session.meta.cwd === null
        ? null
        : yield* deps.normalizeWorkspaceRoot(session.meta.cwd).pipe(
            Effect.map((value) => value as string | null),
            Effect.orElseSucceed(() => null),
          );
    const matchedProjectId =
      normalizedCwd === null ? null : yield* deps.findProjectByWorkspaceRoot(normalizedCwd);

    const nativeSessionId = boundedIdentity(session.meta.nativeSessionId);
    const importedThread = yield* findImportedThread({
      contentHash: session.meta.contentHash,
      source,
      sourcePath: session.meta.sourcePath,
      nativeSessionId,
      providerInstanceIds,
    });

    return {
      source,
      sourcePath,
      providerInstanceIds,
      nativeSessionId,
      title: boundedMetadata(session.meta.title, IMPORT_TITLE_MAX_CHARS),
      cwd: boundedMetadata(session.meta.cwd, IMPORT_WORKSPACE_ROOT_MAX_CHARS),
      gitBranch: boundedMetadata(session.meta.gitBranch, IMPORT_METADATA_MAX_CHARS),
      model: boundedMetadata(session.meta.model, IMPORT_METADATA_MAX_CHARS),
      messageCount,
      modifiedAt: loaded.modifiedAt,
      alreadyImportedThreadId: importedThread?.threadId ?? null,
      alreadyImportedProviderInstanceId: importedThread?.providerInstanceId ?? null,
      alreadyImportedArchived: importedThread?.archived ?? false,
      matchedProjectId,
      resumable:
        nativeSessionId !== null &&
        session.meta.nativeSessionId === nativeSessionId &&
        isImportedSessionSourceIdentityValid(session.meta),
    };
  });

  const scanWithinBudgets = Effect.fn("ImportDiscovery.scanWithinBudgets")(function* (
    input: ServerSettings | ImportScanRootOverrides = {},
    options: SourceCatalogOptions = {},
    progress: ImportScanProgress,
  ) {
    const catalogResolutionTimeoutMs = Math.min(
      5_000,
      Math.max(0, Math.floor(configuredScanTimeoutMs / 10)),
      Math.max(0, configuredScanTimeoutMs - 1),
    );
    const fileCatalogEffect =
      "providers" in input && "providerInstances" in input
        ? resolveSourceCatalog(input, {
            ...options,
            rootResolutionTimeoutMs: Math.max(0, catalogResolutionTimeoutMs - 1),
          })
        : resolveDefaultSourceCatalog(input, {
            ...options,
            rootResolutionTimeoutMs: Math.max(0, catalogResolutionTimeoutMs - 1),
          });
    const acpCatalogEffect =
      "providers" in input && "providerInstances" in input
        ? resolveAcpImportSourceCatalog(input, options)
        : Effect.succeed({ descriptors: [], errors: [] });
    const [fileCatalogOption, acpCatalogOption] = yield* Effect.all(
      [
        fileCatalogEffect.pipe(Effect.timeoutOption(catalogResolutionTimeoutMs)),
        acpCatalogEffect.pipe(Effect.timeoutOption(catalogResolutionTimeoutMs)),
      ],
      { concurrency: "unbounded" },
    );
    const catalog = Option.getOrElse(fileCatalogOption, () => ({
      descriptors: [],
      errors: [
        {
          sourcePath: null,
          message: `file-source catalog resolution timed out after ${catalogResolutionTimeoutMs}ms`,
        },
      ],
    }));
    const acpCatalog = Option.getOrElse(acpCatalogOption, () => ({
      descriptors: [],
      errors: [
        {
          sourcePath: null,
          message: `ACP source catalog resolution timed out after ${catalogResolutionTimeoutMs}ms`,
        },
      ],
    }));
    const appendError = (issue: ImportScanResult["errors"][number]) => {
      appendScanError(progress, issue);
    };
    const candidates = progress.candidates;
    for (const issue of [...catalog.errors, ...acpCatalog.errors]) {
      appendError(issue);
    }
    const candidateBudget = makeImportCountBudget(IMPORT_SCAN_MAX_CANDIDATES);
    const normalizedRecordBudget = makeImportCountBudget(IMPORT_NORMALIZED_REQUEST_MAX_RECORDS);
    const openCodeJsonFileBudget = makeImportCountBudget(OPENCODE_SESSION_MAX_JSON_FILES);
    const fileGroups = groupImportFileSourceDescriptors(catalog.descriptors);
    const sourcePhaseTimeoutMs = Math.max(1, configuredScanTimeoutMs - catalogResolutionTimeoutMs);
    const maximumScanBytes = boundedPositiveInteger(
      deps.resourceLimits?.maximumScanBytes,
      IMPORT_RPC_MAX_BYTES,
      IMPORT_RPC_MAX_BYTES,
    );
    const activeSourceClassCount =
      (fileGroups.length > 0 ? 1 : 0) + (acpCatalog.descriptors.length > 0 ? 1 : 0);
    const sourceClassByteShares = fairShares(maximumScanBytes, activeSourceClassCount);
    const fileScanMaximumBytes = fileGroups.length === 0 ? 0 : sourceClassByteShares[0]!;
    const acpScanMaximumBytes =
      acpCatalog.descriptors.length === 0
        ? 0
        : sourceClassByteShares[fileGroups.length > 0 ? 1 : 0]!;
    const acpScanPhaseTimeoutMs = boundedPositiveInteger(
      deps.resourceLimits?.acpScanPhaseTimeoutMs,
      Math.min(defaultAcpScanPhaseTimeoutMs, Math.max(1, sourcePhaseTimeoutMs - 1)),
      Math.max(1, sourcePhaseTimeoutMs - 1),
    );
    const fileScanPhaseTimeoutMs =
      fileGroups.length === 0
        ? 0
        : acpCatalog.descriptors.length === 0
          ? Math.max(1, sourcePhaseTimeoutMs - 1)
          : Math.max(1, sourcePhaseTimeoutMs - acpScanPhaseTimeoutMs);
    const fileDiscoveryPhaseTimeoutMs = Math.max(1, Math.floor(fileScanPhaseTimeoutMs / 2));
    const fileProcessingPhaseTimeoutMs = Math.max(
      1,
      fileScanPhaseTimeoutMs - fileDiscoveryPhaseTimeoutMs,
    );
    const fileDiscoveryTimeoutShares = fairShares(fileDiscoveryPhaseTimeoutMs, fileGroups.length);
    const fileProcessingTimeoutShares = fairShares(fileProcessingPhaseTimeoutMs, fileGroups.length);
    const traversalShares = fairShares(IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES, fileGroups.length);
    const groupTraversalBudgets = traversalShares.map(makeImportCountBudget);
    const fileCandidates: Array<{
      readonly group: ReturnType<typeof groupImportFileSourceDescriptors>[number];
      readonly groupIndex: number;
      readonly modifiedAtMs: number;
      readonly sourcePath: string;
      readonly traversalBudget: ImportCountBudget;
    }> = [];

    for (const [groupIndex, group] of fileGroups.entries()) {
      const traversalBudget = groupTraversalBudgets[groupIndex]!;
      const groupDiscoveryTimeoutMs = fileDiscoveryTimeoutShares[groupIndex] ?? 0;
      if (groupDiscoveryTimeoutMs <= 0) {
        appendError({
          sourcePath: group.scanRoot,
          message: "file-source discovery skipped because its deadline share was exhausted",
        });
        continue;
      }
      const pathsEffect =
        group.source === "codex-cli"
          ? Effect.tryPromise({
              try: (signal) => codexCandidates(group.scanRoot, traversalBudget, signal),
              catch: (cause) =>
                new ImportDiscoveryOperationError({
                  operation: "discover",
                  sourcePath: group.scanRoot,
                  cause,
                }),
            })
          : group.source === "claude-code"
            ? Effect.tryPromise({
                try: (signal) => claudeCandidates(group.scanRoot, traversalBudget, signal),
                catch: (cause) =>
                  new ImportDiscoveryOperationError({
                    operation: "discover",
                    sourcePath: group.scanRoot,
                    cause,
                  }),
              })
            : discoverOpenCodeSessionMetadataFiles(NodePath.dirname(group.scanRoot), {
                traversalBudget,
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ImportDiscoveryOperationError({
                      operation: "discover",
                      sourcePath: group.scanRoot,
                      cause,
                    }),
                ),
              );
      const groupDiscoveryResult = yield* Effect.gen(function* () {
        const paths = yield* pathsEffect.pipe(
          Effect.catch((error) => {
            appendError({ sourcePath: group.scanRoot, message: errorMessage(error) });
            return Effect.succeed([]);
          }),
        );
        for (const sourcePath of paths) {
          yield* Effect.tryPromise({
            try: () => NodeFSP.stat(sourcePath),
            catch: (cause) =>
              new ImportDiscoveryOperationError({
                operation: "stat",
                sourcePath,
                cause,
              }),
          }).pipe(
            Effect.tap((stat) =>
              Effect.sync(() => {
                fileCandidates.push({
                  group,
                  groupIndex,
                  modifiedAtMs: stat.mtimeMs,
                  sourcePath,
                  traversalBudget,
                });
              }),
            ),
            Effect.catch((error) => {
              return Effect.sync(() => {
                appendError({ sourcePath, message: errorMessage(error) });
              });
            }),
          );
        }
      }).pipe(Effect.timeoutOption(groupDiscoveryTimeoutMs));
      if (Option.isNone(groupDiscoveryResult)) {
        appendError({
          sourcePath: group.scanRoot,
          message: `file-source discovery timed out after ${groupDiscoveryTimeoutMs}ms`,
        });
      }
    }

    const fileCandidateLimit =
      fileGroups.length === 0
        ? 0
        : acpCatalog.descriptors.length === 0
          ? IMPORT_SCAN_MAX_CANDIDATES
          : Math.floor(IMPORT_SCAN_MAX_CANDIDATES / 2);
    const fileCandidateShares = fairShares(fileCandidateLimit, fileGroups.length);
    const fileCandidatesByGroup = fileGroups.map((_, groupIndex) =>
      fileCandidates
        .filter((candidate) => candidate.groupIndex === groupIndex)
        .toSorted(
          (left, right) =>
            right.modifiedAtMs - left.modifiedAtMs ||
            left.sourcePath.localeCompare(right.sourcePath),
        ),
    );
    const selectedFileCandidatesByGroup = fileCandidatesByGroup.map((groupCandidates, groupIndex) =>
      groupCandidates.slice(0, fileCandidateShares[groupIndex]),
    );
    const initialOverflowFileCandidates = fileCandidatesByGroup
      .flatMap((groupCandidates, groupIndex) =>
        groupCandidates.slice(fileCandidateShares[groupIndex]),
      )
      .toSorted(
        (left, right) =>
          right.modifiedAtMs - left.modifiedAtMs ||
          left.group.source.localeCompare(right.group.source) ||
          left.sourcePath.localeCompare(right.sourcePath),
      );

    const processFileCandidate = Effect.fn("ImportDiscovery.processFileCandidate")(function* (
      fileCandidate: (typeof fileCandidates)[number],
      scanByteBudget: ReturnType<typeof makeImportByteBudget>,
      reportByteLimitError = true,
    ) {
      if (!takeImportCount(candidateBudget)) {
        return "candidate-limited" as const;
      }
      return yield* describeCandidate(
        fileCandidate.group.source,
        fileCandidate.sourcePath,
        [...fileCandidate.group.providerInstanceIds],
        catalog.descriptors,
        scanByteBudget,
        normalizedRecordBudget,
        openCodeJsonFileBudget,
        fileCandidate.traversalBudget,
      ).pipe(
        Effect.tap((candidate) =>
          candidate === null
            ? Effect.void
            : Effect.sync(() => {
                candidates.push(candidate);
              }),
        ),
        Effect.as("processed" as const),
        Effect.catch((error) => {
          return Effect.sync(() => {
            const byteLimited = isByteBudgetError(error, scanByteBudget);
            if (byteLimited) {
              candidateBudget.consumedCount -= 1;
            }
            if (!byteLimited || reportByteLimitError) {
              appendError({
                sourcePath: fileCandidate.sourcePath,
                message: errorMessage(error),
              });
            }
            return byteLimited ? ("byte-limited" as const) : ("processed" as const);
          });
        }),
      );
    });

    const fileGroupByteShares = fairShares(fileScanMaximumBytes, fileGroups.length);
    const fileGroupByteBudgets: Array<ReturnType<typeof makeImportByteBudget>> = [];
    const deferredSelectedFileCandidates: typeof fileCandidates = [];
    let fileByteCarry = 0;
    for (const [groupIndex, groupCandidates] of selectedFileCandidatesByGroup.entries()) {
      const groupByteBudget = makeImportByteBudget(
        (fileGroupByteShares[groupIndex] ?? 0) + fileByteCarry,
      );
      fileGroupByteBudgets.push(groupByteBudget);
      const groupProcessingTimeoutMs = fileProcessingTimeoutShares[groupIndex] ?? 0;
      if (groupCandidates.length === 0) {
        fileByteCarry = groupByteBudget.maximumBytes;
        continue;
      }
      if (groupProcessingTimeoutMs <= 0) {
        appendError({
          sourcePath: fileGroups[groupIndex]?.scanRoot ?? null,
          message:
            "file-source candidate processing skipped because its deadline share was exhausted",
        });
        fileByteCarry = groupByteBudget.maximumBytes;
        continue;
      }
      const groupProcessingResult = yield* Effect.gen(function* () {
        for (const [candidateIndex, fileCandidate] of groupCandidates.entries()) {
          const outcome = yield* processFileCandidate(fileCandidate, groupByteBudget, false);
          if (outcome === "byte-limited") {
            deferredSelectedFileCandidates.push(...groupCandidates.slice(candidateIndex));
            break;
          }
          if (outcome === "candidate-limited") {
            break;
          }
        }
      }).pipe(Effect.timeoutOption(groupProcessingTimeoutMs));
      if (Option.isNone(groupProcessingResult)) {
        appendError({
          sourcePath: fileGroups[groupIndex]?.scanRoot ?? null,
          message: `file-source candidate processing timed out after ${groupProcessingTimeoutMs}ms`,
        });
      }
      fileByteCarry = groupByteBudget.maximumBytes - groupByteBudget.consumedBytes;
    }
    const overflowFileCandidates = [
      ...deferredSelectedFileCandidates,
      ...initialOverflowFileCandidates,
    ].toSorted(
      (left, right) =>
        right.modifiedAtMs - left.modifiedAtMs ||
        left.group.source.localeCompare(right.group.source) ||
        left.sourcePath.localeCompare(right.sourcePath),
    );
    const fileOverflowByteBudget = makeImportByteBudget(fileByteCarry);

    const acpCandidatesByKey = new Map<
      string,
      {
        readonly candidate: ImportScanCandidate;
        readonly candidateIndex: number;
        readonly contentHash: string;
      }
    >();
    const acpCandidateShares = fairShares(
      candidateBudget.maximumCount - candidateBudget.consumedCount,
      acpCatalog.descriptors.length,
    );
    const acpByteShares = fairShares(acpScanMaximumBytes, acpCatalog.descriptors.length);
    const acpDescriptorScanTimeoutMs =
      acpCatalog.descriptors.length === 0
        ? 0
        : Math.max(1, Math.floor(acpScanPhaseTimeoutMs / acpCatalog.descriptors.length));
    const acpDescriptorByteBudgets: Array<ReturnType<typeof makeImportByteBudget>> = [];
    let acpCandidateCarry = 0;
    for (const [descriptorIndex, descriptor] of acpCatalog.descriptors.entries()) {
      const assignedCandidateCount = (acpCandidateShares[descriptorIndex] ?? 0) + acpCandidateCarry;
      const descriptorMaximumBytes = acpByteShares[descriptorIndex] ?? 0;
      if (assignedCandidateCount <= 0) {
        candidateBudget.truncated = true;
        break;
      }
      if (descriptorMaximumBytes <= 0) {
        acpCandidateCarry = assignedCandidateCount;
        continue;
      }
      const configuredPolicy = descriptor.connection.policy;
      const boundedBytePolicy = partitionAcpImportBytePolicy(
        descriptorMaximumBytes,
        configuredPolicy,
      );
      if (boundedBytePolicy === null) {
        appendError({
          sourcePath: null,
          message: `ACP scan byte share is too small for provider instance '${descriptor.providerInstanceId}'`,
        });
        acpCandidateCarry = assignedCandidateCount;
        continue;
      }
      const descriptorNormalizedByteBudget = makeImportByteBudget(
        boundedBytePolicy.maxNormalizedBytesPerConnection,
      );
      acpDescriptorByteBudgets.push(descriptorNormalizedByteBudget);
      const boundedDescriptor: AcpImportSourceDescriptor = {
        ...descriptor,
        connection: {
          ...descriptor.connection,
          policy: {
            ...configuredPolicy,
            ...boundedBytePolicy,
          },
        },
      };
      const consumedBeforeDescriptor = candidateBudget.consumedCount;
      const descriptorCompletion = yield* Effect.gen(function* () {
        const loadedCatalog = yield* deps
          .scanAcpSource(boundedDescriptor, assignedCandidateCount)
          .pipe(
            Effect.catch((error) => {
              appendError({
                sourcePath: null,
                message: `failed to scan ${descriptor.source} sessions for provider instance '${descriptor.providerInstanceId}': ${errorMessage(error)}`,
              });
              return Effect.succeed([]);
            }),
          );
        if (loadedCatalog.length > assignedCandidateCount) {
          candidateBudget.truncated = true;
        }
        for (const loaded of loadedCatalog.slice(0, assignedCandidateCount)) {
          yield* Effect.gen(function* () {
            if (loaded.error !== null || loaded.session === null) {
              appendError({
                sourcePath: loaded.descriptor.sourcePath,
                message: errorMessage(loaded.error),
              });
              return;
            }
            const session: ImportedSession = {
              meta: {
                ...loaded.session.meta,
                source: descriptor.source,
              },
              records: [...loaded.session.records],
              warnings: [...loaded.session.warnings],
            };
            const serializedSession = yield* encodeUnknownJsonString(session).pipe(
              Effect.catch((error) => {
                appendError({
                  sourcePath: session.meta.sourcePath,
                  message: `failed to measure imported session payload: ${errorMessage(error)}`,
                });
                return Effect.succeed(null);
              }),
            );
            if (serializedSession === null) {
              return;
            }
            const serializedBytes = NodeBuffer.Buffer.byteLength(serializedSession, "utf8");
            const reservationError = reserveNormalizedImportResources({
              byteBudget: descriptorNormalizedByteBudget,
              maximumSessionBytes: IMPORT_NORMALIZED_SESSION_MAX_BYTES,
              maximumSessionRecords: IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
              recordBudget: normalizedRecordBudget,
              recordCount: session.records.length,
              serializedBytes,
              sourcePath: session.meta.sourcePath,
            });
            if (reservationError !== null) {
              appendError({
                sourcePath: session.meta.sourcePath,
                message: reservationError.message,
              });
              return;
            }
            const messageCount = session.records.filter(
              (record) => record.kind === "message",
            ).length;
            if (messageCount === 0) {
              return;
            }
            if (session.meta.sourcePath.length > IMPORT_SOURCE_PATH_MAX_CHARS) {
              appendError({
                sourcePath: session.meta.sourcePath,
                message: `skipped: source path exceeds ${IMPORT_SOURCE_PATH_MAX_CHARS} characters`,
              });
              return;
            }
            const normalizedCwd =
              session.meta.cwd === null
                ? null
                : yield* deps.normalizeWorkspaceRoot(session.meta.cwd).pipe(
                    Effect.map((value) => value as string | null),
                    Effect.orElseSucceed(() => null),
                  );
            const matchedProjectId =
              normalizedCwd === null ? null : yield* deps.findProjectByWorkspaceRoot(normalizedCwd);
            const importedThread = yield* findImportedThread({
              contentHash: session.meta.contentHash,
              source: descriptor.source,
              sourcePath: session.meta.sourcePath,
              nativeSessionId: session.meta.nativeSessionId,
              providerInstanceIds: [descriptor.providerInstanceId],
            });
            if (!takeImportCount(candidateBudget)) {
              return;
            }
            const nativeSessionId = boundedIdentity(session.meta.nativeSessionId);
            const candidate = {
              source: descriptor.source,
              sourcePath: session.meta.sourcePath,
              providerInstanceIds: [descriptor.providerInstanceId],
              nativeSessionId,
              title: boundedMetadata(session.meta.title, IMPORT_TITLE_MAX_CHARS),
              cwd: boundedMetadata(session.meta.cwd, IMPORT_WORKSPACE_ROOT_MAX_CHARS),
              gitBranch: null,
              model: boundedMetadata(session.meta.model, IMPORT_METADATA_MAX_CHARS),
              messageCount,
              modifiedAt: loaded.descriptor.updatedAt,
              alreadyImportedThreadId: importedThread?.threadId ?? null,
              alreadyImportedProviderInstanceId: importedThread?.providerInstanceId ?? null,
              alreadyImportedArchived: importedThread?.archived ?? false,
              matchedProjectId,
              resumable:
                nativeSessionId !== null &&
                session.meta.nativeSessionId === nativeSessionId &&
                isImportedSessionSourceIdentityValid(session.meta),
            } satisfies ImportScanCandidate;
            const key = [
              candidate.source,
              descriptor.providerInstanceId,
              candidate.sourcePath,
            ].join("\u0000");
            const existing = acpCandidatesByKey.get(key);
            if (existing === undefined) {
              const candidateIndex = candidates.length;
              candidates.push(candidate);
              acpCandidatesByKey.set(key, {
                candidate,
                candidateIndex,
                contentHash: session.meta.contentHash,
              });
              return;
            }
            if (existing.contentHash !== session.meta.contentHash) {
              appendError({
                sourcePath: candidate.sourcePath,
                message:
                  "provider instances returned conflicting content for the same ACP session identity",
              });
              return;
            }
            if (!existing.candidate.providerInstanceIds.includes(descriptor.providerInstanceId)) {
              const updatedCandidate = {
                ...existing.candidate,
                providerInstanceIds: [
                  ...existing.candidate.providerInstanceIds,
                  descriptor.providerInstanceId,
                ],
              };
              candidates[existing.candidateIndex] = updatedCandidate;
              acpCandidatesByKey.set(key, {
                candidate: updatedCandidate,
                candidateIndex: existing.candidateIndex,
                contentHash: existing.contentHash,
              });
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                appendError({
                  sourcePath: loaded.descriptor.sourcePath,
                  message: errorMessage(error),
                });
              }),
            ),
          );
        }
      }).pipe(Effect.timeoutOption(acpDescriptorScanTimeoutMs));
      if (Option.isNone(descriptorCompletion)) {
        appendError({
          sourcePath: null,
          message: `scan timed out after ${acpDescriptorScanTimeoutMs}ms for ${descriptor.source} sessions for provider instance '${descriptor.providerInstanceId}'`,
        });
      }
      acpCandidateCarry = Math.max(
        0,
        assignedCandidateCount - (candidateBudget.consumedCount - consumedBeforeDescriptor),
      );
    }
    let processedOverflowCount = 0;
    for (const fileCandidate of overflowFileCandidates) {
      if (
        candidateBudget.consumedCount >= candidateBudget.maximumCount ||
        fileOverflowByteBudget.maximumBytes <= 0
      ) {
        break;
      }
      const outcome = yield* processFileCandidate(fileCandidate, fileOverflowByteBudget);
      processedOverflowCount += 1;
      if (outcome === "byte-limited" || outcome === "candidate-limited") {
        break;
      }
    }
    if (processedOverflowCount < overflowFileCandidates.length) {
      candidateBudget.truncated = true;
    }
    const truncatedTraversalGroups = fileGroups.filter(
      (_, groupIndex) => groupTraversalBudgets[groupIndex]?.truncated === true,
    );
    if (truncatedTraversalGroups.length > 0) {
      appendError({
        sourcePath: null,
        message: `scan traversal truncated within the ${IMPORT_SCAN_MAX_TRAVERSAL_ENTRIES}-entry global budget for ${truncatedTraversalGroups.length} source root${truncatedTraversalGroups.length === 1 ? "" : "s"}; partial results may omit sessions not reached within a root's fair share`,
      });
    }
    const fileScanConsumedBytes =
      fileGroupByteBudgets.reduce((total, budget) => total + budget.consumedBytes, 0) +
      fileOverflowByteBudget.consumedBytes;
    if (fileScanMaximumBytes > 0 && fileScanConsumedBytes >= fileScanMaximumBytes) {
      appendError({
        sourcePath: null,
        message: `file-source scan byte share exhausted after ${fileScanMaximumBytes} bytes`,
      });
    }
    const acpScanConsumedBytes = acpDescriptorByteBudgets.reduce(
      (total, budget) => total + budget.consumedBytes,
      0,
    );
    if (acpScanMaximumBytes > 0 && acpScanConsumedBytes >= acpScanMaximumBytes) {
      appendError({
        sourcePath: null,
        message: `ACP scan byte share exhausted after ${acpScanMaximumBytes} bytes`,
      });
    }
    if (candidateBudget.truncated) {
      appendError({
        sourcePath: null,
        message: `scan truncated after ${IMPORT_SCAN_MAX_CANDIDATES} candidates`,
      });
    }
    return yield* snapshotScanProgress(progress);
  });

  const diagnosticScanResult = (message: string) =>
    DateTime.now.pipe(
      Effect.map(
        (now) =>
          ({
            candidates: [],
            scannedAt: DateTime.formatIso(now),
            errors: [{ sourcePath: null, message }],
          }) satisfies ImportScanResult,
      ),
    );

  const scan = (
    input: ServerSettings | ImportScanRootOverrides = {},
    options: SourceCatalogOptions = {},
  ) =>
    Effect.suspend(() => {
      const progress: ImportScanProgress = {
        candidates: [],
        errors: [],
        omittedErrorCount: 0,
      };
      return importScanSemaphore
        .withPermitsIfAvailable(1)(
          scanWithinBudgets(input, options, progress).pipe(
            Effect.timeoutOption(configuredScanTimeoutMs),
            Effect.flatMap(
              Option.match({
                onNone: () => {
                  appendScanError(progress, {
                    sourcePath: null,
                    message: `scan timed out after ${configuredScanTimeoutMs}ms`,
                  });
                  return snapshotScanProgress(progress);
                },
                onSome: Effect.succeed,
              }),
            ),
          ),
        )
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                diagnosticScanResult(
                  "scan skipped because another import scan is already in progress",
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
    });

  return ImportDiscovery.of({ scan });
});

export const layer = Layer.effect(ImportDiscovery, make);
