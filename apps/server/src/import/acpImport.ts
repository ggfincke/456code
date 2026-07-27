// apps/server/src/import/acpImport.ts
// catalogs and normalizes replayable Cursor and Grok ACP sessions
// @effect-diagnostics nodeBuiltinImport:off globalDate:off

import * as NodeCrypto from "node:crypto";
import * as NodeBuffer from "node:buffer";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { ToolLifecycleItemType } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { deriveToolActivityPresentation } from "@t3tools/shared/toolActivity";

import { buildCursorAcpSpawnInput } from "../provider/acp/CursorAcpSupport.ts";
import { buildGrokAcpSpawnInput } from "../provider/acp/GrokAcpSupport.ts";
import { syntheticLoadSessionResponseFromInitialize } from "../provider/acp/AcpRuntimeModel.ts";
import {
  ACP_IMPORT_DEFAULT_CATALOG_MAX_BYTES,
  ACP_IMPORT_DEFAULT_NORMALIZED_CONNECTION_MAX_BYTES,
  ACP_IMPORT_DEFAULT_REPLAY_CONNECTION_MAX_BYTES,
  ACP_IMPORT_DEFAULT_REPLAY_SESSION_MAX_BYTES,
  IMPORT_NORMALIZED_SESSION_MAX_BYTES,
  IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
} from "./resourceLimits.ts";
import type { ImportedActivityRecord, ImportedMessageRecord, ImportedRecord } from "./types.ts";

export type AcpImportDriverKind = "cursor" | "grok";
export type AcpImportSource = "cursor-acp" | "grok-acp";

export interface AcpImportWireUsage {
  consumedBytes: number;
}

export interface AcpImportPolicy {
  readonly initializeTimeoutMs: number;
  readonly authenticateTimeoutMs: number;
  readonly listPageTimeoutMs: number;
  readonly loadTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly postResponseReplayGraceMs: number;
  readonly hangingReplayIdleMs: number;
  readonly maxPages: number;
  readonly maxSessions: number;
  readonly maxCatalogBytes: number;
  readonly maxReplayNotificationsPerSession: number;
  readonly maxReplayBytesPerSession: number;
  readonly maxReplayNotificationsPerConnection: number;
  readonly maxReplayBytesPerConnection: number;
  readonly maxNormalizedBytesPerConnection: number;
  readonly batchLoadTimeoutMs: number;
}

export interface AcpImportConnectionOptions {
  readonly driverKind: AcpImportDriverKind;
  readonly providerInstanceId: string;
  readonly cwd: string;
  readonly binaryPath?: string;
  readonly apiEndpoint?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly policy?: Partial<AcpImportPolicy>;
  readonly wireUsage?: AcpImportWireUsage;
}

export interface AcpImportCatalogEntry {
  readonly driverKind: AcpImportDriverKind;
  readonly providerInstanceId: string;
  readonly source: AcpImportSource;
  readonly sourcePath: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly updatedAt: string | null;
}

export interface AcpImportedSessionMeta {
  readonly source: AcpImportSource;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
  readonly gitBranch: null;
  readonly model: string | null;
  readonly title: string | null;
  readonly firstActivityAt: string | null;
  readonly lastActivityAt: string | null;
}

/**
 * Intermediate shaped exactly like the shared importer record model except for
 * its ACP-specific source literal. The integration layer can widen ImportSource
 * without making this process-backed catalog depend on shared contract edits.
 */
export interface AcpImportedSession {
  readonly meta: AcpImportedSessionMeta;
  readonly records: ReadonlyArray<ImportedRecord>;
  readonly warnings: ReadonlyArray<string>;
}

export type AcpImportCatalogLoadResult =
  | {
      readonly descriptor: AcpImportCatalogEntry;
      readonly session: AcpImportedSession;
      readonly error: null;
      readonly consumedWireBytes?: number;
    }
  | {
      readonly descriptor: AcpImportCatalogEntry;
      readonly session: null;
      readonly error: AcpImportError;
      readonly consumedWireBytes?: number;
    };

export interface AcpImportBatchLoadResult {
  readonly sourcePath: string;
  readonly descriptor: AcpImportCatalogEntry | null;
  readonly session: AcpImportedSession | null;
  readonly error: AcpImportError | null;
  readonly consumedWireBytes?: number;
}

export class AcpImportError extends Error {
  readonly code:
    | "spawn-failed"
    | "initialize-failed"
    | "authenticate-failed"
    | "unsupported-list"
    | "unsupported-load"
    | "list-failed"
    | "load-failed"
    | "invalid-pagination"
    | "invalid-source"
    | "timeout"
    | "limit-exceeded";
  override readonly cause: unknown;

  constructor(
    code: AcpImportError["code"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = "AcpImportError";
    this.code = code;
    this.cause = options?.cause;
  }
}

interface ConnectedAcpImportClient {
  readonly client: EffectAcpClient.AcpClient["Service"];
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly policy: AcpImportPolicy;
  readonly replayRouter: AcpReplayRouter;
}

interface ReplayCapture {
  readonly sessionId: string;
  readonly notifications: Array<EffectAcpSchema.SessionNotification>;
  notificationCount: number;
  byteCount: number;
  foreignNotificationCount: number;
  lastMatchingActivityAtMs: number | undefined;
  limitError: AcpImportError | undefined;
}

interface ReplayCaptureSnapshot {
  readonly notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>;
  readonly foreignNotificationCount: number;
}

interface AcpReplayRouter {
  readonly begin: (sessionId: string) => ReplayCapture;
  readonly finish: (capture: ReplayCapture) => ReplayCaptureSnapshot;
  readonly abort: (capture: ReplayCapture) => void;
  readonly route: (notification: EffectAcpSchema.SessionNotification, nowMs: number) => void;
}

interface MutableToolReplay {
  readonly sourceIndex: number;
  readonly toolCallId: string;
  title: string | undefined;
  kind: string | undefined;
  status: EffectAcpSchema.ToolCallStatus | undefined;
  command: string | undefined;
  contentTextOutput: string | undefined;
  rawInput: unknown;
  rawOutput: unknown;
  locations: ReadonlyArray<NormalizedToolLocation>;
  omittedContentItemCount: number;
  omittedLocationCount: number;
  attachmentCount: number;
}

interface PendingMessage {
  readonly role: "user" | "assistant";
  readonly messageId: string | null;
  readonly sourceIndex: number;
  readonly chunks: string[];
}

interface PendingThought {
  readonly messageId: string | null;
  readonly sourceIndex: number;
  readonly chunks: string[];
}

interface NormalizedToolLocation {
  readonly path: string;
  readonly line?: number;
}

type ReplayRecord =
  | Omit<ImportedMessageRecord, "createdAt">
  | Omit<ImportedActivityRecord, "createdAt">;

const defaultAcpImportPolicy: AcpImportPolicy = {
  initializeTimeoutMs: 15_000,
  authenticateTimeoutMs: 15_000,
  listPageTimeoutMs: 15_000,
  loadTimeoutMs: 90_000,
  shutdownGraceMs: 1_000,
  postResponseReplayGraceMs: 100,
  hangingReplayIdleMs: 2_000,
  maxPages: 1_000,
  maxSessions: 10_000,
  maxCatalogBytes: ACP_IMPORT_DEFAULT_CATALOG_MAX_BYTES,
  maxReplayNotificationsPerSession: 100_000,
  maxReplayBytesPerSession: ACP_IMPORT_DEFAULT_REPLAY_SESSION_MAX_BYTES,
  maxReplayNotificationsPerConnection: 250_000,
  maxReplayBytesPerConnection: ACP_IMPORT_DEFAULT_REPLAY_CONNECTION_MAX_BYTES,
  maxNormalizedBytesPerConnection: ACP_IMPORT_DEFAULT_NORMALIZED_CONNECTION_MAX_BYTES,
  batchLoadTimeoutMs: 5 * 60_000,
};
const replaySummaryLimit = 120;
const replayTextFieldMaxBytes = 1_048_576;
const replayCommandMaxBytes = 65_536;
const replayLocationPathMaxBytes = 4_096;
const replayToolContentItemLimit = 500;
const replayToolLocationLimit = 100;
const replayPlanEntryLimit = 1_000;
const replayWarningDetailLimit = 100;
const replayFailureMessageMaxBytes = 1_024;
const replayToolCallIdMaxBytes = 512;
const metadataFieldMaxBytes = 512;
const cwdFieldMaxBytes = 4_096;
const replayRawToolValueMaxBytes = 256 * 1024;
const replayRawToolPreviewMaxBytes = 64 * 1024;
const replayRawToolStringMaxBytes = 64 * 1024;
const replayRawToolKeyMaxBytes = 512;
const replayRawToolMaxDepth = 8;
const replayRawToolMaxNodes = 2_000;
const replayRawToolCollectionLimit = 500;
const displayNormalizationChunkCodeUnits = 4_096;
const replayNormalizedEnvelopeReserveBytes = 64 * 1_024;
const timestampedRecordJsonOverheadBytes = NodeBuffer.Buffer.byteLength(
  ',"createdAt":"2000-01-01T00:00:00.000Z"',
  "utf8",
);
const deterministicTimelineEpochMs = Date.UTC(2000, 0, 1);
const deterministicTimelineWindowMs = 50 * 365 * 24 * 60 * 60 * 1_000;
const textEncoder = new TextEncoder();

function positivePolicyValue(
  value: number | undefined,
  fallback: number,
  integer: boolean,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return integer ? Math.max(1, Math.floor(value)) : value;
}

function checkedByteSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function resolveAcpImportPolicy(overrides?: Partial<AcpImportPolicy>): AcpImportPolicy {
  const maxCatalogBytes = positivePolicyValue(
    overrides?.maxCatalogBytes,
    defaultAcpImportPolicy.maxCatalogBytes,
    true,
  );
  const maxReplayBytesPerConnection = positivePolicyValue(
    overrides?.maxReplayBytesPerConnection,
    defaultAcpImportPolicy.maxReplayBytesPerConnection,
    true,
  );
  return {
    initializeTimeoutMs: positivePolicyValue(
      overrides?.initializeTimeoutMs,
      defaultAcpImportPolicy.initializeTimeoutMs,
      false,
    ),
    authenticateTimeoutMs: positivePolicyValue(
      overrides?.authenticateTimeoutMs,
      defaultAcpImportPolicy.authenticateTimeoutMs,
      false,
    ),
    listPageTimeoutMs: positivePolicyValue(
      overrides?.listPageTimeoutMs,
      defaultAcpImportPolicy.listPageTimeoutMs,
      false,
    ),
    loadTimeoutMs: positivePolicyValue(
      overrides?.loadTimeoutMs,
      defaultAcpImportPolicy.loadTimeoutMs,
      false,
    ),
    shutdownGraceMs: positivePolicyValue(
      overrides?.shutdownGraceMs,
      defaultAcpImportPolicy.shutdownGraceMs,
      false,
    ),
    postResponseReplayGraceMs: positivePolicyValue(
      overrides?.postResponseReplayGraceMs,
      defaultAcpImportPolicy.postResponseReplayGraceMs,
      false,
    ),
    hangingReplayIdleMs: positivePolicyValue(
      overrides?.hangingReplayIdleMs,
      defaultAcpImportPolicy.hangingReplayIdleMs,
      false,
    ),
    maxPages: positivePolicyValue(overrides?.maxPages, defaultAcpImportPolicy.maxPages, true),
    maxSessions: positivePolicyValue(
      overrides?.maxSessions,
      defaultAcpImportPolicy.maxSessions,
      true,
    ),
    maxCatalogBytes,
    maxReplayNotificationsPerSession: positivePolicyValue(
      overrides?.maxReplayNotificationsPerSession,
      defaultAcpImportPolicy.maxReplayNotificationsPerSession,
      true,
    ),
    maxReplayBytesPerSession: positivePolicyValue(
      overrides?.maxReplayBytesPerSession,
      defaultAcpImportPolicy.maxReplayBytesPerSession,
      true,
    ),
    maxReplayNotificationsPerConnection: positivePolicyValue(
      overrides?.maxReplayNotificationsPerConnection,
      defaultAcpImportPolicy.maxReplayNotificationsPerConnection,
      true,
    ),
    maxReplayBytesPerConnection,
    maxNormalizedBytesPerConnection: positivePolicyValue(
      overrides?.maxNormalizedBytesPerConnection,
      defaultAcpImportPolicy.maxNormalizedBytesPerConnection,
      true,
    ),
    batchLoadTimeoutMs: positivePolicyValue(
      overrides?.batchLoadTimeoutMs,
      defaultAcpImportPolicy.batchLoadTimeoutMs,
      false,
    ),
  };
}

function jsonByteLength(value: unknown): number {
  return NodeBuffer.Buffer.byteLength(JSON.stringify(value), "utf8");
}

function retainNormalizedSession(
  policy: AcpImportPolicy,
  budget: { consumedBytes: number },
  session: AcpImportedSession,
): AcpImportedSession {
  const sessionBytes = jsonByteLength(session);
  if (sessionBytes > IMPORT_NORMALIZED_SESSION_MAX_BYTES) {
    throw new AcpImportError(
      "limit-exceeded",
      `ACP normalized session exceeded the configured ${IMPORT_NORMALIZED_SESSION_MAX_BYTES}-byte per-session limit.`,
    );
  }
  if (sessionBytes > policy.maxNormalizedBytesPerConnection - budget.consumedBytes) {
    throw new AcpImportError(
      "limit-exceeded",
      `ACP normalized session results exceeded the configured ${policy.maxNormalizedBytesPerConnection}-byte connection limit.`,
    );
  }
  budget.consumedBytes += sessionBytes;
  return session;
}

function makeReplayRouter(policy: AcpImportPolicy): AcpReplayRouter {
  let activeCapture: ReplayCapture | undefined;
  let connectionNotificationCount = 0;
  let connectionByteCount = 0;
  let connectionLimitError: AcpImportError | undefined;

  const begin = (sessionId: string): ReplayCapture => {
    if (activeCapture !== undefined) {
      throw new AcpImportError(
        "load-failed",
        "ACP replay import does not support concurrent session/load calls on one connection.",
      );
    }
    if (connectionLimitError !== undefined) {
      throw connectionLimitError;
    }
    const capture: ReplayCapture = {
      sessionId,
      notifications: [],
      notificationCount: 0,
      byteCount: 0,
      foreignNotificationCount: 0,
      lastMatchingActivityAtMs: undefined,
      limitError: undefined,
    };
    activeCapture = capture;
    return capture;
  };

  const route = (notification: EffectAcpSchema.SessionNotification, nowMs: number): void => {
    const capture = activeCapture;
    if (capture === undefined) {
      return;
    }

    const notificationBytes = jsonByteLength(notification);
    capture.notificationCount += 1;
    capture.byteCount += notificationBytes;
    connectionNotificationCount += 1;
    connectionByteCount += notificationBytes;

    if (
      connectionNotificationCount > policy.maxReplayNotificationsPerConnection ||
      connectionByteCount > policy.maxReplayBytesPerConnection
    ) {
      connectionLimitError ??= new AcpImportError(
        "limit-exceeded",
        "ACP replay exceeded the notification or byte limit for this connection.",
      );
      capture.limitError = connectionLimitError;
      return;
    }
    if (
      capture.notificationCount > policy.maxReplayNotificationsPerSession ||
      capture.byteCount > policy.maxReplayBytesPerSession
    ) {
      capture.limitError ??= new AcpImportError(
        "limit-exceeded",
        `ACP replay for session '${capture.sessionId}' exceeded its notification or byte limit.`,
      );
      return;
    }

    if (notification.sessionId !== capture.sessionId) {
      capture.foreignNotificationCount += 1;
      return;
    }
    capture.notifications.push(notification);
    capture.lastMatchingActivityAtMs = nowMs;
  };

  const finish = (capture: ReplayCapture): ReplayCaptureSnapshot => {
    if (activeCapture !== capture) {
      throw new AcpImportError("load-failed", "ACP replay capture is no longer active.");
    }
    activeCapture = undefined;
    if (capture.limitError !== undefined) {
      throw capture.limitError;
    }
    return {
      notifications: capture.notifications,
      foreignNotificationCount: capture.foreignNotificationCount,
    };
  };

  const abort = (capture: ReplayCapture): void => {
    if (activeCapture === capture) {
      activeCapture = undefined;
    }
  };

  return { begin, finish, abort, route };
}

function withAcpImportTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
  action: string,
): Effect.Effect<A, E | AcpImportError, R> {
  return effect.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new AcpImportError("timeout", `${action} timed out after ${timeoutMs}ms.`)),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function sourceForDriver(driverKind: AcpImportDriverKind): AcpImportSource {
  return driverKind === "cursor" ? "cursor-acp" : "grok-acp";
}

export function makeAcpImportSourcePath(
  driverKind: AcpImportDriverKind,
  providerInstanceId: string,
  nativeSessionId: string,
): string {
  if (providerInstanceId.trim().length === 0 || nativeSessionId.trim().length === 0) {
    throw new AcpImportError(
      "invalid-source",
      "ACP import source requires non-empty provider instance and session ids.",
    );
  }
  return `acp://${driverKind}/${encodeURIComponent(providerInstanceId)}/${encodeURIComponent(
    nativeSessionId,
  )}`;
}

export function parseAcpImportSourcePath(
  sourcePath: string,
  expectedDriverKind?: AcpImportDriverKind,
  expectedProviderInstanceId?: string,
): {
  readonly driverKind: AcpImportDriverKind;
  readonly providerInstanceId: string;
  readonly nativeSessionId: string;
} {
  const match = /^acp:\/\/(cursor|grok)\/([^/?#]+)\/([^/?#]+)$/u.exec(sourcePath);
  if (match === null) {
    throw new AcpImportError("invalid-source", "ACP import source has an unsupported driver.");
  }
  const driverKind = match[1] as AcpImportDriverKind;
  if (expectedDriverKind !== undefined && driverKind !== expectedDriverKind) {
    throw new AcpImportError(
      "invalid-source",
      `ACP import source belongs to '${driverKind}', not '${expectedDriverKind}'.`,
    );
  }
  let providerInstanceId: string;
  let nativeSessionId: string;
  try {
    providerInstanceId = decodeURIComponent(match[2]!);
    nativeSessionId = decodeURIComponent(match[3]!);
  } catch (cause) {
    throw new AcpImportError(
      "invalid-source",
      "ACP import source has an invalid provider instance or session id.",
      { cause },
    );
  }
  if (providerInstanceId.trim().length === 0 || nativeSessionId.trim().length === 0) {
    throw new AcpImportError(
      "invalid-source",
      "ACP import source has an invalid provider instance or session id.",
    );
  }
  if (
    expectedProviderInstanceId !== undefined &&
    providerInstanceId !== expectedProviderInstanceId
  ) {
    throw new AcpImportError(
      "invalid-source",
      `ACP import source belongs to provider instance '${providerInstanceId}', not '${expectedProviderInstanceId}'.`,
    );
  }
  return { driverKind, providerInstanceId, nativeSessionId };
}

function buildSpawnInput(options: AcpImportConnectionOptions) {
  if (options.driverKind === "cursor") {
    return buildCursorAcpSpawnInput(
      {
        binaryPath: options.binaryPath ?? "",
        apiEndpoint: options.apiEndpoint ?? "",
      },
      options.cwd,
      options.environment,
    );
  }
  return buildGrokAcpSpawnInput(
    {
      binaryPath: options.binaryPath ?? "",
    },
    options.cwd,
    options.environment,
  );
}

function authMethodId(options: AcpImportConnectionOptions): string {
  if (options.driverKind === "cursor") {
    return "cursor_login";
  }
  return options.environment?.XAI_API_KEY?.trim() ? "xai.api_key" : "cached_token";
}

function terminateAcpImportChild(
  child: ChildProcessSpawner.ChildProcessHandle,
  shutdownGraceMs: number,
): Effect.Effect<void> {
  const forceKill = child
    .kill({ killSignal: "SIGKILL" })
    .pipe(Effect.timeoutOption(shutdownGraceMs), Effect.asVoid, Effect.ignore);
  const gracefulThenForced = child.kill({ killSignal: "SIGTERM" }).pipe(
    Effect.timeoutOption(shutdownGraceMs),
    Effect.flatMap((completion) => (Option.isSome(completion) ? Effect.void : forceKill)),
    Effect.catch(() => forceKill),
  );
  return child.isRunning.pipe(
    Effect.flatMap((isRunning) => (isRunning ? gracefulThenForced : Effect.void)),
    Effect.catch(() => forceKill),
  );
}

const connectAcpImportClient = (
  options: AcpImportConnectionOptions,
): Effect.Effect<
  ConnectedAcpImportClient,
  AcpImportError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    if (options.providerInstanceId.trim().length === 0) {
      return yield* Effect.fail(
        new AcpImportError("invalid-source", "ACP provider instance id must not be empty."),
      );
    }
    const policy = resolveAcpImportPolicy(options.policy);
    const wireUsage = options.wireUsage;
    const initialWireUsageBytes =
      wireUsage === undefined ||
      !Number.isFinite(wireUsage.consumedBytes) ||
      wireUsage.consumedBytes < 0
        ? 0
        : Math.floor(wireUsage.consumedBytes);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;
    const spawn = buildSpawnInput(options);
    const resolved = yield* resolveSpawnCommand(
      spawn.command,
      spawn.args,
      spawn.env ? { env: spawn.env, extendEnv: true } : {},
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AcpImportError("spawn-failed", `Could not resolve '${spawn.command}'.`, { cause }),
      ),
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
          ...(spawn.env ? { env: spawn.env, extendEnv: true } : {}),
          shell: resolved.shell,
          // the scoped spawner's finalizer waits for exit; use SIGKILL as its
          // last-resort signal after our graceful bounded finalizer runs
          killSignal: "SIGKILL",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new AcpImportError("spawn-failed", `Could not start '${spawn.command}'.`, { cause }),
        ),
      );
    yield* Scope.addFinalizer(scope, terminateAcpImportChild(child, policy.shutdownGraceMs));
    yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkScoped);
    const maximumIncomingBytesPerConnection = checkedByteSum(
      policy.maxCatalogBytes,
      policy.maxReplayBytesPerConnection,
    );
    const clientContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        maximumIncomingConnectionBytes: maximumIncomingBytesPerConnection,
        maximumIncomingFrameBytes: maximumIncomingBytesPerConnection,
        maximumPendingNotifications: 0,
        maximumRetainedNotifications: 0,
        ...(wireUsage === undefined
          ? {}
          : {
              onIncomingConnectionBytes: (connectionBytes: number) => {
                wireUsage.consumedBytes = checkedByteSum(initialWireUsageBytes, connectionBytes);
              },
            }),
      }),
    ).pipe(Effect.provideService(Scope.Scope, scope));
    const client = yield* EffectAcpClient.AcpClient.pipe(Effect.provide(clientContext));
    const replayRouter = makeReplayRouter(policy);

    // replay import must never leave an actionable request waiting on a user
    yield* client.handleRequestPermission(() =>
      Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
    );
    yield* client.handleElicitation(() =>
      Effect.succeed({ action: { action: "cancel" as const } }),
    );
    yield* client.handleSessionUpdate((notification) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          Effect.sync(() => {
            replayRouter.route(notification, nowMs);
          }),
        ),
      ),
    );

    const initializeResult = yield* withAcpImportTimeout(
      client.agent
        .initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "code456-session-import", version: "0.0.0" },
        })
        .pipe(Effect.mapError(mapProtocolError("initialize-failed", "ACP initialization failed"))),
      policy.initializeTimeoutMs,
      "ACP initialization",
    );
    yield* withAcpImportTimeout(
      client.agent
        .authenticate({ methodId: authMethodId(options) })
        .pipe(
          Effect.mapError(mapProtocolError("authenticate-failed", "ACP authentication failed")),
        ),
      policy.authenticateTimeoutMs,
      "ACP authentication",
    );
    return { client, initializeResult, policy, replayRouter };
  });

function requireCatalogCapabilities(
  initializeResult: EffectAcpSchema.InitializeResponse,
  operation: "list" | "load",
): void {
  if (
    operation === "list" &&
    initializeResult.agentCapabilities?.sessionCapabilities?.list == null
  ) {
    throw new AcpImportError(
      "unsupported-list",
      "The ACP agent does not advertise session/list support.",
    );
  }
  if (operation === "load" && initializeResult.agentCapabilities?.loadSession !== true) {
    throw new AcpImportError(
      "unsupported-load",
      "The ACP agent does not advertise replay-capable session/load support.",
    );
  }
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8CodePointByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function isUnsafeDisplayCodePoint(codePoint: number): boolean {
  return (
    (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200e && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

// normalize only the retained prefix so hostile multi-megabyte fields cannot
// allocate one array entry per code point before reaching their byte ceiling
function boundedNormalizedDisplayText(value: string, maximumBytes: number): string {
  const byteLimit =
    Number.isFinite(maximumBytes) && maximumBytes > 0 ? Math.floor(maximumBytes) : 0;
  if (byteLimit === 0 || value.length === 0) {
    return "";
  }

  const chunks: string[] = [];
  let chunk = "";
  let byteCount = 0;
  let sourceIndex = 0;
  let truncated = false;
  while (sourceIndex < value.length) {
    const sourceCodePoint = value.codePointAt(sourceIndex) ?? 0xfffd;
    const sourceWidth = sourceCodePoint > 0xffff ? 2 : 1;
    const isCarriageReturn = sourceCodePoint === 0x0d;
    const nextSourceIndex =
      isCarriageReturn && value.codePointAt(sourceIndex + sourceWidth) === 0x0a
        ? sourceIndex + sourceWidth + 1
        : sourceIndex + sourceWidth;
    const normalizedCodePoint = isCarriageReturn
      ? 0x0a
      : isUnsafeDisplayCodePoint(sourceCodePoint)
        ? 0xfffd
        : sourceCodePoint;
    const normalizedByteLength = utf8CodePointByteLength(normalizedCodePoint);
    if (normalizedByteLength > byteLimit - byteCount) {
      truncated = true;
      break;
    }

    chunk += String.fromCodePoint(normalizedCodePoint);
    byteCount += normalizedByteLength;
    sourceIndex = nextSourceIndex;
    if (chunk.length >= displayNormalizationChunkCodeUnits) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  const retained = chunks.length === 0 ? chunk : `${chunks.join("")}${chunk}`;
  if (!truncated) {
    return retained;
  }

  const suffix = "…";
  const suffixBytes = utf8CodePointByteLength(suffix.codePointAt(0) ?? 0x2026);
  if (byteLimit < suffixBytes) {
    return "";
  }
  const prefixBudget = byteLimit - suffixBytes;
  let retainedBytes = byteCount;
  let retainedCodeUnits = retained.length;
  while (retainedBytes > prefixBudget && retainedCodeUnits > 0) {
    let codePointStart = retainedCodeUnits - 1;
    const trailingCodeUnit = retained.charCodeAt(codePointStart);
    if (trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff && codePointStart > 0) {
      codePointStart -= 1;
    }
    const codePoint = retained.codePointAt(codePointStart) ?? 0xfffd;
    retainedBytes -= utf8CodePointByteLength(codePoint);
    retainedCodeUnits = codePointStart;
  }
  return `${retained.slice(0, retainedCodeUnits)}${suffix}`;
}

function assignmentIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_.-]/u.test(value);
}

function assignmentValueEnd(value: string, start: number, key: string): number {
  if (value.startsWith("[REDACTED]", start)) {
    return start + "[REDACTED]".length;
  }
  const bearerMatch = /^Bearer\s+\[REDACTED\]/iu.exec(value.slice(start));
  if (bearerMatch !== null) {
    return start + bearerMatch[0].length;
  }

  const escapedQuote =
    value[start] === "\\" && (value[start + 1] === '"' || value[start + 1] === "'")
      ? value[start + 1]
      : null;
  const quote =
    escapedQuote ?? (value[start] === '"' || value[start] === "'" ? value[start] : null);
  if (quote !== null) {
    let index = start + (escapedQuote === null ? 1 : 2);
    while (index < value.length) {
      if (escapedQuote !== null && value[index] === "\\" && value[index + 1] === quote) {
        return index + 2;
      }
      if (escapedQuote === null && value[index] === quote && value[index - 1] !== "\\") {
        return index + 1;
      }
      index += 1;
    }
    return value.length;
  }

  const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (
    normalizedKey.endsWith("cookie") ||
    normalizedKey.endsWith("cookies") ||
    normalizedKey.endsWith("cookiejar")
  ) {
    let index = start;
    while (index < value.length && value[index] !== "\n") {
      index += 1;
    }
    return index;
  }
  if (normalizedKey.endsWith("authorization")) {
    const scheme = /^([A-Za-z][A-Za-z0-9._-]*)\s+/u.exec(value.slice(start));
    if (scheme?.[1]?.toLowerCase() === "digest") {
      let index = start + scheme[0].length;
      while (index < value.length && value[index] !== "\n" && value[index] !== ";") {
        index += 1;
      }
      return index;
    }
    if (scheme !== null) {
      let index = start + scheme[0].length;
      while (index < value.length && !/[\s,;}\]]/u.test(value[index]!)) {
        index += 1;
      }
      return index;
    }
  }

  let index = start;
  while (index < value.length && !/[\s,;}\]]/u.test(value[index]!)) {
    index += 1;
  }
  return index;
}

// redact only credential-shaped assignment keys and their immediate values
function redactSecretAssignments(value: string): string {
  const credentialMarkerPattern =
    /api[_-]?key|private[_-]?key|access[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|token|cookie|credentials?/giu;
  let output = "";
  let retainedFrom = 0;

  for (const marker of value.matchAll(credentialMarkerPattern)) {
    const markerIndex = marker.index;
    if (markerIndex < retainedFrom) {
      continue;
    }
    let keyStart = markerIndex;
    while (keyStart > retainedFrom && assignmentIdentifierCharacter(value[keyStart - 1])) {
      keyStart -= 1;
    }
    let keyEnd = markerIndex + marker[0].length;
    while (assignmentIdentifierCharacter(value[keyEnd])) {
      keyEnd += 1;
    }
    const key = value.slice(keyStart, keyEnd);
    if (!rawToolKeyIsSensitive(key)) {
      continue;
    }

    let separatorIndex = keyEnd;
    if (
      value[separatorIndex] === "\\" &&
      (value[separatorIndex + 1] === '"' || value[separatorIndex + 1] === "'")
    ) {
      separatorIndex += 2;
    } else if (value[separatorIndex] === '"' || value[separatorIndex] === "'") {
      separatorIndex += 1;
    }
    while (/\s/u.test(value[separatorIndex] ?? "")) {
      separatorIndex += 1;
    }
    if (value[separatorIndex] !== ":" && value[separatorIndex] !== "=") {
      continue;
    }
    separatorIndex += 1;
    while (/\s/u.test(value[separatorIndex] ?? "")) {
      separatorIndex += 1;
    }
    const valueEnd = assignmentValueEnd(value, separatorIndex, key);
    if (valueEnd <= separatorIndex) {
      continue;
    }

    output += `${value.slice(retainedFrom, separatorIndex)}[REDACTED]`;
    retainedFrom = valueEnd;
  }
  return `${output}${value.slice(retainedFrom)}`;
}

function redactDisplaySecrets(value: string): string {
  return redactSecretAssignments(value.replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]"));
}

function boundedReplayText(value: string, maximumBytes = replayTextFieldMaxBytes): string {
  return boundedNormalizedDisplayText(value, maximumBytes);
}

function boundedToolDisplayText(value: string, maximumBytes = replayTextFieldMaxBytes): string {
  const bounded = boundedNormalizedDisplayText(value, maximumBytes);
  return boundedNormalizedDisplayText(redactDisplaySecrets(bounded), maximumBytes);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function boundedImportError(
  fallbackCode: AcpImportError["code"],
  cause: unknown,
  action?: string,
): AcpImportError {
  const code = cause instanceof AcpImportError ? cause.code : fallbackCode;
  const detail = errorMessage(cause);
  const rawMessage = action === undefined ? detail : `${action}: ${detail}`;
  return new AcpImportError(code, boundedToolDisplayText(rawMessage, replayFailureMessageMaxBytes));
}

function mapProtocolError(
  code: Extract<
    AcpImportError["code"],
    "initialize-failed" | "authenticate-failed" | "list-failed" | "load-failed"
  >,
  action: string,
) {
  return (cause: EffectAcpErrors.AcpError) => boundedImportError(code, cause, action);
}

interface RawToolSanitizerState {
  nodeCount: number;
  readonly activeObjects: WeakSet<object>;
}

function rawToolKeyIsSensitive(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return (
    normalized.endsWith("authorization") ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("cookies") ||
    normalized.endsWith("cookiejar") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials")
  );
}

function uniqueRawToolKey(target: Record<string, unknown>, rawKey: string): string {
  const base = boundedToolDisplayText(rawKey, replayRawToolKeyMaxBytes) || "field";
  if (!Object.hasOwn(target, base)) {
    return base;
  }
  let suffix = 2;
  while (Object.hasOwn(target, `${base}#${suffix}`)) {
    suffix += 1;
  }
  return `${base}#${suffix}`;
}

function boundedSortedRawToolKeys(value: object): {
  readonly keys: ReadonlyArray<string>;
  readonly omittedKeyCount: number;
} {
  const keys: string[] = [];
  let ownKeyCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    ownKeyCount += 1;
    let lower = 0;
    let upper = keys.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (compareStrings(keys[middle]!, key) < 0) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    if (keys.length < replayRawToolCollectionLimit) {
      keys.splice(lower, 0, key);
    } else if (lower < replayRawToolCollectionLimit) {
      keys.splice(lower, 0, key);
      keys.pop();
    }
  }
  return {
    keys,
    omittedKeyCount: Math.max(0, ownKeyCount - keys.length),
  };
}

function sanitizeRawToolValueInner(
  value: unknown,
  depth: number,
  state: RawToolSanitizerState,
): unknown {
  if (state.nodeCount >= replayRawToolMaxNodes) {
    return "[TRUNCATED: node limit]";
  }
  state.nodeCount += 1;

  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return boundedToolDisplayText(value, replayRawToolStringMaxBytes);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : `[Unsupported number: ${String(value)}]`;
  }
  if (typeof value === "bigint") {
    return boundedToolDisplayText(value.toString(), replayRawToolStringMaxBytes);
  }
  if (typeof value !== "object") {
    return `[Unsupported ${typeof value}]`;
  }
  if (state.activeObjects.has(value)) {
    return "[Circular]";
  }

  state.activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      if (depth >= replayRawToolMaxDepth) {
        return `[TRUNCATED: depth ${replayRawToolMaxDepth}]`;
      }
      const bounded = value
        .slice(0, replayRawToolCollectionLimit)
        .map((entry) => sanitizeRawToolValueInner(entry, depth + 1, state));
      if (value.length > replayRawToolCollectionLimit) {
        bounded.push(`[TRUNCATED: ${value.length - replayRawToolCollectionLimit} array items]`);
      }
      return bounded;
    }
    if (depth >= replayRawToolMaxDepth) {
      return `[TRUNCATED: depth ${replayRawToolMaxDepth}]`;
    }

    const result: Record<string, unknown> = {};
    const boundedKeys = boundedSortedRawToolKeys(value);
    for (const key of boundedKeys.keys) {
      const outputKey = uniqueRawToolKey(result, key);
      Object.defineProperty(result, outputKey, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: rawToolKeyIsSensitive(key)
          ? "[REDACTED]"
          : sanitizeRawToolValueInner((value as Record<string, unknown>)[key], depth + 1, state),
      });
    }
    if (boundedKeys.omittedKeyCount > 0) {
      result[uniqueRawToolKey(result, "_t3ImportOmittedFields")] = boundedKeys.omittedKeyCount;
    }
    return result;
  } finally {
    state.activeObjects.delete(value);
  }
}

function sanitizeRawToolValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const sanitized = sanitizeRawToolValueInner(value, 0, {
    nodeCount: 0,
    activeObjects: new WeakSet(),
  });
  const serialized = JSON.stringify(sanitized);
  if (
    serialized !== undefined &&
    NodeBuffer.Buffer.byteLength(serialized, "utf8") <= replayRawToolValueMaxBytes
  ) {
    return sanitized;
  }
  return {
    _t3ImportTruncated: true,
    preview: boundedToolDisplayText(serialized ?? String(sanitized), replayRawToolPreviewMaxBytes),
  };
}

function displayTextFromRawToolValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return boundedToolDisplayText(value) || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return boundedToolDisplayText(String(value)) || undefined;
  }
  if (isRecord(value)) {
    const chunks = ["content", "stdout", "stderr", "output", "message"].flatMap((key) => {
      const candidate = value[key];
      return typeof candidate === "string" && candidate.trim().length > 0 ? [candidate] : [];
    });
    if (chunks.length > 0) {
      return boundedToolDisplayText(chunks.join("\n")) || undefined;
    }
    if ("result" in value) {
      const nestedResult = displayTextFromRawToolValue(value.result);
      if (nestedResult !== undefined) {
        return nestedResult;
      }
    }
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : boundedToolDisplayText(serialized) || undefined;
}

function persistedToolCallId(toolCallId: string): string {
  const sanitized = boundedToolDisplayText(toolCallId, replayToolCallIdMaxBytes);
  if (sanitized.length > 0 && sanitized === toolCallId) {
    return sanitized;
  }
  return `acp-tool-${NodeCrypto.createHash("sha256").update(toolCallId).digest("hex").slice(0, 32)}`;
}

function failedBatchResult(
  sourcePath: string,
  error: AcpImportError,
  consumedWireBytes = 0,
): AcpImportBatchLoadResult {
  return {
    sourcePath,
    descriptor: null,
    session: null,
    error: boundedImportError(error.code, error),
    consumedWireBytes,
  };
}

function finalizeBatchResults(
  sourcePaths: ReadonlyArray<string>,
  completedResults: ReadonlyArray<AcpImportBatchLoadResult | undefined>,
): ReadonlyArray<AcpImportBatchLoadResult> {
  return sourcePaths.map(
    (sourcePath, index) =>
      completedResults[index] ??
      failedBatchResult(
        sourcePath,
        new AcpImportError("load-failed", "ACP batch load did not produce a result."),
      ),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasUnsafeCatalogCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      (codePoint >= 0x200e && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function catalogEntry(
  driverKind: AcpImportDriverKind,
  providerInstanceId: string,
  info: EffectAcpSchema.SessionInfo,
): AcpImportCatalogEntry {
  if (info.sessionId.trim().length === 0) {
    throw new AcpImportError("invalid-source", "ACP session/list returned an empty session id.");
  }
  if (hasUnsafeCatalogCharacters(info.sessionId)) {
    throw new AcpImportError(
      "invalid-source",
      "ACP session/list returned a session id containing unsafe control or bidirectional characters.",
    );
  }
  if (textEncoder.encode(info.sessionId).byteLength > metadataFieldMaxBytes) {
    throw new AcpImportError(
      "invalid-source",
      `ACP session/list returned a session id longer than ${metadataFieldMaxBytes} bytes.`,
    );
  }
  if (hasUnsafeCatalogCharacters(info.cwd)) {
    throw new AcpImportError(
      "invalid-source",
      "ACP session/list returned a cwd containing unsafe control or bidirectional characters.",
    );
  }
  if (info.cwd.trim().length === 0 || !NodePath.isAbsolute(info.cwd)) {
    throw new AcpImportError(
      "invalid-source",
      `ACP session/list returned a non-absolute cwd for session '${info.sessionId}'.`,
    );
  }
  if (textEncoder.encode(info.cwd).byteLength > cwdFieldMaxBytes) {
    throw new AcpImportError(
      "invalid-source",
      `ACP session/list returned a cwd longer than ${cwdFieldMaxBytes} bytes.`,
    );
  }
  const normalizedTitle = normalizeOptionalText(info.title);
  return {
    driverKind,
    providerInstanceId,
    source: sourceForDriver(driverKind),
    sourcePath: makeAcpImportSourcePath(driverKind, providerInstanceId, info.sessionId),
    nativeSessionId: info.sessionId,
    cwd: info.cwd,
    title:
      normalizedTitle === null ? null : boundedReplayText(normalizedTitle, metadataFieldMaxBytes),
    updatedAt: normalizeOptionalTimestamp(info.updatedAt),
  };
}

export const listConnectedAcpImportSessions = (
  connection: ConnectedAcpImportClient,
  driverKind: AcpImportDriverKind,
  providerInstanceId: string,
): Effect.Effect<ReadonlyArray<AcpImportCatalogEntry>, AcpImportError> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => requireCatalogCapabilities(connection.initializeResult, "list"),
      catch: (cause) => boundedImportError("unsupported-list", cause),
    });

    const entries: AcpImportCatalogEntry[] = [];
    const seenCursors = new Set<string>();
    const seenSessionIds = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    let sessionCount = 0;
    let catalogByteCount = 0;

    while (true) {
      pageCount += 1;
      if (pageCount > connection.policy.maxPages) {
        return yield* Effect.fail(
          new AcpImportError(
            "limit-exceeded",
            `ACP session/list exceeded the ${connection.policy.maxPages}-page catalog limit.`,
          ),
        );
      }
      const response = yield* withAcpImportTimeout(
        connection.client.agent
          .listSessions(cursor === undefined ? {} : { cursor })
          .pipe(Effect.mapError(mapProtocolError("list-failed", "ACP session/list failed"))),
        connection.policy.listPageTimeoutMs,
        "ACP session/list page",
      );
      sessionCount += response.sessions.length;
      catalogByteCount += jsonByteLength(response);
      if (
        sessionCount > connection.policy.maxSessions ||
        catalogByteCount > connection.policy.maxCatalogBytes
      ) {
        return yield* Effect.fail(
          new AcpImportError(
            "limit-exceeded",
            "ACP session/list exceeded the configured session or byte limit.",
          ),
        );
      }
      for (const info of response.sessions) {
        const entry = yield* Effect.try({
          try: () => catalogEntry(driverKind, providerInstanceId, info),
          catch: (cause) => boundedImportError("invalid-source", cause),
        });
        if (seenSessionIds.has(entry.nativeSessionId)) {
          return yield* Effect.fail(
            new AcpImportError(
              "invalid-pagination",
              `ACP session/list returned duplicate session '${entry.nativeSessionId}'.`,
            ),
          );
        }
        seenSessionIds.add(entry.nativeSessionId);
        entries.push(entry);
      }

      const nextCursor = response.nextCursor == null ? undefined : response.nextCursor;
      if (nextCursor === undefined) {
        break;
      }
      if (seenCursors.has(nextCursor)) {
        return yield* Effect.fail(
          new AcpImportError(
            "invalid-pagination",
            `ACP session/list repeated pagination cursor '${nextCursor}'.`,
          ),
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return entries.sort(
      (left, right) =>
        compareStrings(right.updatedAt ?? "", left.updatedAt ?? "") ||
        compareStrings(left.nativeSessionId, right.nativeSessionId),
    );
  });

export const scanAcpImportCatalog = (
  options: AcpImportConnectionOptions,
): Effect.Effect<
  ReadonlyArray<AcpImportCatalogEntry>,
  AcpImportError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    connectAcpImportClient(options).pipe(
      Effect.flatMap((connection) =>
        listConnectedAcpImportSessions(connection, options.driverKind, options.providerInstanceId),
      ),
    ),
  ).pipe(Effect.mapError((error) => boundedImportError("list-failed", error)));

function attachmentCountFromContentBlock(content: EffectAcpSchema.ContentBlock): number {
  return content.type === "text" ? 0 : 1;
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? boundedToolDisplayText(trimmed, replayCommandMaxBytes) : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );
  return parts.length > 0
    ? boundedToolDisplayText(parts.join(" "), replayCommandMaxBytes)
    : undefined;
}

function commandFromTitle(title: string | undefined): string | undefined {
  const match = title === undefined ? null : /`([^`]+)`/u.exec(title);
  const command = match?.[1]?.trim();
  return command ? boundedToolDisplayText(command, replayCommandMaxBytes) : undefined;
}

function commandFromRawInput(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const direct = normalizeCommandValue(rawInput.command);
    if (direct !== undefined) {
      return direct;
    }
    const executable =
      typeof rawInput.executable === "string"
        ? boundedToolDisplayText(rawInput.executable.trim(), replayCommandMaxBytes)
        : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return boundedToolDisplayText(`${executable} ${args}`, replayCommandMaxBytes);
    }
    if (executable) {
      return executable;
    }
  }
  return commandFromTitle(title);
}

function normalizeToolContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): {
  readonly textOutput: string | undefined;
  readonly attachmentCount: number;
  readonly omittedContentItemCount: number;
} {
  if (!content) {
    return { textOutput: undefined, attachmentCount: 0, omittedContentItemCount: 0 };
  }
  const textChunks: string[] = [];
  let attachmentCount = 0;
  let retainedTextBytes = 0;
  let omittedContentItemCount = Math.max(0, content.length - replayToolContentItemLimit);
  const scannedItemCount = Math.min(content.length, replayToolContentItemLimit);
  for (let contentIndex = 0; contentIndex < scannedItemCount; contentIndex += 1) {
    const item = content[contentIndex]!;
    if (item.type === "content" && item.content.type === "text") {
      const separatorBytes = textChunks.length === 0 ? 0 : 1;
      const remainingBytes = replayTextFieldMaxBytes - retainedTextBytes - separatorBytes;
      if (remainingBytes <= 0) {
        omittedContentItemCount += 1;
        continue;
      }
      const boundedChunk = boundedReplayText(item.content.text, remainingBytes);
      if (boundedChunk.length === 0) {
        continue;
      }
      textChunks.push(boundedChunk);
      retainedTextBytes += separatorBytes + NodeBuffer.Buffer.byteLength(boundedChunk, "utf8");
      continue;
    }
    if (item.type === "content") {
      attachmentCount += 1;
      continue;
    }
    if (item.type === "diff" || item.type === "terminal") {
      attachmentCount += 1;
    }
  }
  const joined = textChunks.join("\n").trim();
  return {
    textOutput: joined.length > 0 ? boundedToolDisplayText(joined) : undefined,
    attachmentCount,
    omittedContentItemCount,
  };
}

function normalizeToolLocations(
  locations: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined,
): {
  readonly locations: ReadonlyArray<NormalizedToolLocation>;
  readonly omittedLocationCount: number;
} {
  if (!locations) {
    return { locations: [], omittedLocationCount: 0 };
  }
  const normalized: NormalizedToolLocation[] = [];
  const seen = new Set<string>();
  const scannedLocationCount = Math.min(locations.length, replayToolLocationLimit);
  for (let locationIndex = 0; locationIndex < scannedLocationCount; locationIndex += 1) {
    const location = locations[locationIndex]!;
    const path = boundedToolDisplayText(location.path, replayLocationPathMaxBytes).trim();
    if (path.length === 0) {
      continue;
    }
    const line =
      typeof location.line === "number" && Number.isSafeInteger(location.line) && location.line >= 0
        ? location.line
        : undefined;
    const key = `${path}\u0000${line ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      path,
      ...(line !== undefined ? { line } : {}),
    });
  }
  return {
    locations: normalized,
    omittedLocationCount: Math.max(0, locations.length - normalized.length),
  };
}

function canonicalItemTypeFromToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function messageIdentityMatches(
  pending: PendingMessage,
  role: "user" | "assistant",
  messageId: string | null,
): boolean {
  return (
    pending.role === role &&
    ((pending.messageId === null && messageId === null) || pending.messageId === messageId)
  );
}

function thoughtIdentityMatches(pending: PendingThought, messageId: string | null): boolean {
  return (pending.messageId === null && messageId === null) || pending.messageId === messageId;
}

function summarize(text: string, fallback: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (!flattened) return fallback;
  return flattened.length <= replaySummaryLimit
    ? flattened
    : `${flattened.slice(0, replaySummaryLimit - 1)}…`;
}

function buildReplayRecords(notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>): {
  readonly records: ReadonlyArray<ReplayRecord>;
  readonly attachmentCount: number;
  readonly omittedContentItemCount: number;
  readonly omittedLocationCount: number;
  readonly omittedRecordCount: number;
  readonly omittedToolCount: number;
} {
  const records: ReplayRecord[] = [];
  const pendingTools = new Map<string, MutableToolReplay>();
  const completedTools = new Set<string>();
  let pendingMessage: PendingMessage | undefined;
  let pendingThought: PendingThought | undefined;
  let attachmentCount = 0;
  let omittedContentItemCount = 0;
  let omittedLocationCount = 0;
  let omittedRecordCount = 0;
  let lastOmittedRecordSourceIndex = 0;
  let retainedRecordBytes = 2;
  let attachmentSourceIndex = -1;

  const pushRecord = (record: ReplayRecord): void => {
    const normalizedRecordByteLimit =
      IMPORT_NORMALIZED_SESSION_MAX_BYTES - replayNormalizedEnvelopeReserveBytes;
    const recordBytes =
      records.length < IMPORT_NORMALIZED_SESSION_MAX_RECORDS
        ? jsonByteLength(record) + timestampedRecordJsonOverheadBytes + 1
        : 0;
    if (
      records.length < IMPORT_NORMALIZED_SESSION_MAX_RECORDS &&
      recordBytes <= normalizedRecordByteLimit - retainedRecordBytes
    ) {
      records.push(record);
      retainedRecordBytes += recordBytes;
      return;
    }
    omittedRecordCount += 1;
    lastOmittedRecordSourceIndex = Math.max(lastOmittedRecordSourceIndex, record.sourceIndex);
  };

  const flushMessage = () => {
    if (pendingMessage === undefined) return;
    const text = boundedReplayText(pendingMessage.chunks.join("").trim());
    if (text) {
      pushRecord({
        kind: "message",
        role: pendingMessage.role,
        text,
        sourceIndex: pendingMessage.sourceIndex,
      } satisfies Omit<ImportedMessageRecord, "createdAt">);
    }
    pendingMessage = undefined;
  };
  const flushThought = () => {
    if (pendingThought === undefined) return;
    const text = boundedReplayText(pendingThought.chunks.join("").trim());
    if (text) {
      const summary = summarize(text, "Reasoning");
      pushRecord({
        kind: "activity",
        tone: "info",
        activityKind: "task.progress",
        summary,
        payload: { summary, detail: text },
        sourceIndex: pendingThought.sourceIndex,
      } satisfies Omit<ImportedActivityRecord, "createdAt">);
    }
    pendingThought = undefined;
  };
  const emitTool = (tool: MutableToolReplay, sourceIndex: number) => {
    const itemType = canonicalItemTypeFromToolKind(tool.kind);
    const textOutput = tool.contentTextOutput ?? displayTextFromRawToolValue(tool.rawOutput);
    const item: Record<string, unknown> = {};
    if (tool.rawInput !== undefined) {
      item.input = tool.rawInput;
    }
    if (tool.command !== undefined) {
      item.command = tool.command;
    }
    if (textOutput !== undefined) {
      item.result = { content: textOutput };
    }
    if (itemType === "file_change" && tool.locations.length > 0) {
      item.changes = tool.locations;
    }
    const data: Record<string, unknown> = {
      toolCallId: persistedToolCallId(tool.toolCallId),
      ...(tool.kind ? { kind: tool.kind } : {}),
      ...(tool.command ? { command: tool.command } : {}),
      ...(Object.keys(item).length > 0 ? { item } : {}),
      ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
      ...(tool.rawOutput !== undefined
        ? { rawOutput: tool.rawOutput }
        : textOutput
          ? { rawOutput: { content: textOutput } }
          : {}),
      ...(tool.locations.length > 0 ? { locations: tool.locations } : {}),
      ...(tool.omittedContentItemCount > 0
        ? { omittedContentItemCount: tool.omittedContentItemCount }
        : {}),
      ...(tool.omittedLocationCount > 0 ? { omittedLocationCount: tool.omittedLocationCount } : {}),
    };
    const presentation = deriveToolActivityPresentation({
      itemType,
      title: tool.title,
      detail: textOutput ?? tool.command,
      data,
      fallbackSummary: tool.title ?? "Tool",
    });
    const summary = summarize(presentation.summary, "Tool");
    const detail = textOutput ?? presentation.detail;
    pushRecord({
      kind: "activity",
      tone: tool.status === "failed" ? "error" : "tool",
      activityKind: "tool.completed",
      summary,
      payload: {
        itemType,
        title: summary,
        status: tool.status,
        ...(detail ? { detail } : {}),
        data,
      },
      sourceIndex,
    } satisfies Omit<ImportedActivityRecord, "createdAt">);
    attachmentCount += tool.attachmentCount;
    omittedContentItemCount += tool.omittedContentItemCount;
    omittedLocationCount += tool.omittedLocationCount;
    if (tool.attachmentCount > 0) {
      attachmentSourceIndex = Math.max(attachmentSourceIndex, sourceIndex);
    }
    pendingTools.delete(tool.toolCallId);
    completedTools.add(tool.toolCallId);
  };

  for (const [sourceIndex, notification] of notifications.entries()) {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "user_message_chunk":
      case "agent_message_chunk": {
        flushThought();
        const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
        const messageId = update.messageId ?? null;
        if (
          pendingMessage !== undefined &&
          !messageIdentityMatches(pendingMessage, role, messageId)
        ) {
          flushMessage();
        }
        const blockAttachments = attachmentCountFromContentBlock(update.content);
        if (blockAttachments > 0) {
          attachmentCount += blockAttachments;
          attachmentSourceIndex = sourceIndex;
          continue;
        }
        if (update.content.type === "text") {
          if (pendingMessage === undefined) {
            pendingMessage = {
              role,
              messageId,
              sourceIndex,
              chunks: [update.content.text],
            };
          } else {
            pendingMessage.chunks.push(update.content.text);
          }
        }
        continue;
      }
      case "agent_thought_chunk": {
        flushMessage();
        const blockAttachments = attachmentCountFromContentBlock(update.content);
        if (blockAttachments > 0) {
          attachmentCount += blockAttachments;
          attachmentSourceIndex = sourceIndex;
          continue;
        }
        if (update.content.type === "text") {
          const messageId = update.messageId ?? null;
          if (pendingThought !== undefined && !thoughtIdentityMatches(pendingThought, messageId)) {
            flushThought();
          }
          if (pendingThought === undefined) {
            pendingThought = {
              messageId,
              sourceIndex,
              chunks: [update.content.text],
            };
          } else {
            pendingThought.chunks.push(update.content.text);
          }
        }
        continue;
      }
      case "tool_call": {
        flushMessage();
        flushThought();
        if (completedTools.has(update.toolCallId)) continue;
        const title = boundedToolDisplayText(update.title.trim()) || undefined;
        const rawInput = sanitizeRawToolValue(update.rawInput);
        const rawOutput = sanitizeRawToolValue(update.rawOutput);
        const content = normalizeToolContent(update.content);
        const locations = normalizeToolLocations(update.locations);
        const tool: MutableToolReplay = {
          sourceIndex,
          toolCallId: update.toolCallId,
          title,
          kind: update.kind,
          status: update.status,
          command: commandFromRawInput(rawInput, title),
          contentTextOutput: content.textOutput,
          rawInput,
          rawOutput,
          locations: locations.locations,
          omittedContentItemCount: content.omittedContentItemCount,
          omittedLocationCount: locations.omittedLocationCount,
          attachmentCount: content.attachmentCount,
        };
        pendingTools.set(update.toolCallId, tool);
        if (tool.status === "completed" || tool.status === "failed") {
          emitTool(tool, sourceIndex);
        }
        continue;
      }
      case "tool_call_update": {
        flushMessage();
        flushThought();
        if (completedTools.has(update.toolCallId)) continue;
        const tool = pendingTools.get(update.toolCallId) ?? {
          sourceIndex,
          toolCallId: update.toolCallId,
          title: undefined,
          kind: undefined,
          status: undefined,
          command: undefined,
          contentTextOutput: undefined,
          rawInput: undefined,
          rawOutput: undefined,
          locations: [],
          omittedContentItemCount: 0,
          omittedLocationCount: 0,
          attachmentCount: 0,
        };
        if ("title" in update) {
          tool.title =
            update.title == null
              ? undefined
              : boundedToolDisplayText(update.title.trim()) || undefined;
        }
        if ("kind" in update) {
          tool.kind = update.kind ?? undefined;
        }
        if ("status" in update) {
          tool.status = update.status ?? undefined;
        }
        if ("rawInput" in update) {
          tool.rawInput = sanitizeRawToolValue(update.rawInput);
          tool.command = commandFromRawInput(tool.rawInput, tool.title);
        } else if (tool.command === undefined) {
          tool.command = commandFromTitle(tool.title);
        }
        if ("rawOutput" in update) {
          tool.rawOutput = sanitizeRawToolValue(update.rawOutput);
        }
        if ("content" in update) {
          const content = normalizeToolContent(update.content);
          tool.contentTextOutput = content.textOutput;
          tool.attachmentCount = content.attachmentCount;
          tool.omittedContentItemCount = content.omittedContentItemCount;
        }
        if ("locations" in update) {
          const locations = normalizeToolLocations(update.locations);
          tool.locations = locations.locations;
          tool.omittedLocationCount = locations.omittedLocationCount;
        }
        pendingTools.set(update.toolCallId, tool);
        if (tool.status === "completed" || tool.status === "failed") {
          emitTool(tool, sourceIndex);
        }
        continue;
      }
      case "plan": {
        const plan = update.entries.slice(0, replayPlanEntryLimit).map((entry, index) => ({
          step: boundedReplayText(entry.content.trim()) || `Step ${index + 1}`,
          status:
            entry.status === "completed"
              ? ("completed" as const)
              : entry.status === "in_progress"
                ? ("inProgress" as const)
                : ("pending" as const),
        }));
        pushRecord({
          kind: "activity",
          tone: "info",
          activityKind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan,
            ...(update.entries.length > replayPlanEntryLimit
              ? {
                  explanation: `Imported ACP plan omitted ${
                    update.entries.length - replayPlanEntryLimit
                  } additional steps after the first ${replayPlanEntryLimit}.`,
                  omittedStepCount: update.entries.length - replayPlanEntryLimit,
                }
              : {}),
          },
          sourceIndex,
        } satisfies Omit<ImportedActivityRecord, "createdAt">);
        continue;
      }
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        continue;
    }
  }

  flushMessage();
  flushThought();
  for (const tool of pendingTools.values()) {
    attachmentCount += tool.attachmentCount;
    omittedContentItemCount += tool.omittedContentItemCount;
    omittedLocationCount += tool.omittedLocationCount;
    if (tool.attachmentCount > 0) {
      attachmentSourceIndex = Math.max(attachmentSourceIndex, tool.sourceIndex);
    }
  }
  if (pendingTools.size > 0) {
    const omittedTools = [...pendingTools.values()];
    let unfinishedSourceIndex = 0;
    for (const tool of omittedTools) {
      unfinishedSourceIndex = Math.max(unfinishedSourceIndex, tool.sourceIndex);
    }
    const detail = omittedTools
      .slice(0, replayWarningDetailLimit)
      .map((tool) =>
        boundedReplayText(tool.title ?? tool.kind ?? "Unnamed tool", replayLocationPathMaxBytes),
      )
      .join("\n");
    const summary = `Omitted ${pendingTools.size} unfinished tool activit${
      pendingTools.size === 1 ? "y" : "ies"
    } from imported ACP history`;
    pushRecord({
      kind: "activity",
      tone: "error",
      activityKind: "task.completed",
      summary,
      payload: {
        summary,
        detail:
          omittedTools.length > replayWarningDetailLimit
            ? `${detail}\n… and ${omittedTools.length - replayWarningDetailLimit} more`
            : detail,
        unfinishedToolCount: pendingTools.size,
      },
      sourceIndex: unfinishedSourceIndex,
    } satisfies Omit<ImportedActivityRecord, "createdAt">);
  }
  if (attachmentCount > 0) {
    const summary = `Omitted ${attachmentCount} attachment${
      attachmentCount === 1 ? "" : "s"
    } from imported ACP history`;
    pushRecord({
      kind: "activity",
      tone: "info",
      activityKind: "task.completed",
      summary,
      payload: {
        summary,
        detail: "Attachment payloads are not included in imported transcripts.",
        omittedAttachmentCount: attachmentCount,
      },
      sourceIndex: attachmentSourceIndex < 0 ? notifications.length : attachmentSourceIndex,
    } satisfies Omit<ImportedActivityRecord, "createdAt">);
  }
  if (omittedRecordCount > 0) {
    const displacedRecord = records.pop();
    if (displacedRecord !== undefined) {
      omittedRecordCount += 1;
      lastOmittedRecordSourceIndex = Math.max(
        lastOmittedRecordSourceIndex,
        displacedRecord.sourceIndex,
      );
    }
    const summary = `Omitted ${omittedRecordCount} additional record${
      omittedRecordCount === 1 ? "" : "s"
    } after the ACP normalized session limit`;
    records.push({
      kind: "activity",
      tone: "info",
      activityKind: "task.completed",
      summary,
      payload: {
        summary,
        omittedRecordCount,
        normalizedByteLimit: IMPORT_NORMALIZED_SESSION_MAX_BYTES,
        normalizedRecordLimit: IMPORT_NORMALIZED_SESSION_MAX_RECORDS,
      },
      sourceIndex: lastOmittedRecordSourceIndex,
    });
  }
  records.sort((left, right) => left.sourceIndex - right.sourceIndex);
  return {
    records,
    attachmentCount,
    omittedContentItemCount,
    omittedLocationCount,
    omittedRecordCount,
    omittedToolCount: pendingTools.size,
  };
}

function timestampRecords(
  records: ReadonlyArray<ReplayRecord>,
  updatedAt: string | null,
  contentHash: string,
): ReadonlyArray<ImportedRecord> {
  const hashOffset = Number.parseInt(contentHash.slice(0, 12), 16) % deterministicTimelineWindowMs;
  const fallbackMillis = deterministicTimelineEpochMs + hashOffset;
  const lastMillis = updatedAt === null ? fallbackMillis : Date.parse(updatedAt);
  const firstMillis = Math.max(0, lastMillis - Math.max(0, records.length - 1));
  return records.map(
    (record, index) =>
      ({
        ...record,
        createdAt: new Date(firstMillis + index).toISOString(),
      }) as ImportedRecord,
  );
}

export function normalizeAcpSessionReplay(input: {
  readonly descriptor: AcpImportCatalogEntry;
  readonly notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>;
  readonly loadResponse: EffectAcpSchema.LoadSessionResponse;
  readonly foreignNotificationCount?: number;
}): AcpImportedSession {
  const relevantNotifications = input.notifications.filter(
    (notification) => notification.sessionId === input.descriptor.nativeSessionId,
  );
  const built = buildReplayRecords(relevantNotifications);
  const warnings: string[] = [];
  if (
    relevantNotifications.length !== input.notifications.length ||
    (input.foreignNotificationCount ?? 0) > 0
  ) {
    warnings.push("ignored replay updates for a different ACP session");
  }
  if (built.records.every((record) => record.kind !== "message")) {
    warnings.push("no messages found in ACP session replay");
  }
  if (built.attachmentCount > 0) {
    warnings.push("attachment contents were omitted from ACP session replay");
  }
  if (built.omittedToolCount > 0) {
    warnings.push("unfinished tool activities were omitted from ACP session replay");
  }
  if (built.omittedContentItemCount > 0) {
    warnings.push("tool content items beyond bounded replay limits were omitted");
  }
  if (built.omittedLocationCount > 0) {
    warnings.push(
      "tool locations beyond bounded replay limits or without unique paths were omitted",
    );
  }
  if (built.omittedRecordCount > 0) {
    warnings.push("records beyond the normalized session limit were omitted from ACP replay");
  }
  const normalizedModel = normalizeOptionalText(input.loadResponse.models?.currentModelId);
  const model =
    normalizedModel === null ? null : boundedReplayText(normalizedModel, metadataFieldMaxBytes);
  const stablePayload = {
    source: input.descriptor.source,
    sourcePath: input.descriptor.sourcePath,
    nativeSessionId: input.descriptor.nativeSessionId,
    cwd: input.descriptor.cwd,
    model,
    title: input.descriptor.title,
    records: built.records,
  };
  const contentHash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(stablePayload))
    .digest("hex");
  const records = timestampRecords(built.records, input.descriptor.updatedAt, contentHash);
  return {
    meta: {
      source: input.descriptor.source,
      sourcePath: input.descriptor.sourcePath,
      contentHash,
      nativeSessionId: input.descriptor.nativeSessionId,
      cwd: input.descriptor.cwd,
      gitBranch: null,
      model,
      title: input.descriptor.title,
      firstActivityAt: records[0]?.createdAt ?? null,
      lastActivityAt: records.at(-1)?.createdAt ?? null,
    },
    records,
    warnings,
  };
}

const waitForReplayIdle = (
  connection: ConnectedAcpImportClient,
  capture: ReplayCapture,
): Effect.Effect<EffectAcpSchema.LoadSessionResponse, AcpImportError> =>
  Effect.gen(function* () {
    while (true) {
      if (capture.limitError !== undefined) {
        return yield* Effect.fail(capture.limitError);
      }
      const nowMs = yield* Clock.currentTimeMillis;
      if (
        capture.lastMatchingActivityAtMs !== undefined &&
        nowMs - capture.lastMatchingActivityAtMs >= connection.policy.hangingReplayIdleMs
      ) {
        return syntheticLoadSessionResponseFromInitialize(connection.initializeResult);
      }
      yield* Effect.sleep(Math.min(25, connection.policy.hangingReplayIdleMs));
    }
  });

const waitForPostResponseReplay = (
  connection: ConnectedAcpImportClient,
  capture: ReplayCapture,
): Effect.Effect<void, AcpImportError> =>
  Effect.sleep(connection.policy.postResponseReplayGraceMs).pipe(
    Effect.flatMap(() =>
      capture.limitError === undefined ? Effect.void : Effect.fail(capture.limitError),
    ),
  );

export const loadConnectedAcpImportSession = (
  connection: ConnectedAcpImportClient,
  descriptor: AcpImportCatalogEntry,
): Effect.Effect<AcpImportedSession, AcpImportError> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => requireCatalogCapabilities(connection.initializeResult, "load"),
      catch: (cause) => boundedImportError("unsupported-load", cause),
    });
    const capture = yield* Effect.try({
      try: () => connection.replayRouter.begin(descriptor.nativeSessionId),
      catch: (cause) => boundedImportError("load-failed", cause),
    });

    return yield* Effect.gen(function* () {
      const responseSettlement = yield* withAcpImportTimeout(
        Effect.raceFirst(
          connection.client.agent
            .loadSession({
              sessionId: descriptor.nativeSessionId,
              cwd: descriptor.cwd,
              mcpServers: [],
            })
            .pipe(
              Effect.mapError(mapProtocolError("load-failed", "ACP session/load failed")),
              Effect.map((response) => ({ _tag: "response" as const, response })),
            ),
          waitForReplayIdle(connection, capture).pipe(
            Effect.map((response) => ({ _tag: "replay-idle" as const, response })),
          ),
        ),
        connection.policy.loadTimeoutMs,
        "ACP session/load",
      );
      if (responseSettlement._tag === "response") {
        yield* waitForPostResponseReplay(connection, capture);
      }
      const snapshot = yield* Effect.try({
        try: () => connection.replayRouter.finish(capture),
        catch: (cause) => boundedImportError("load-failed", cause),
      });
      return normalizeAcpSessionReplay({
        descriptor,
        notifications: snapshot.notifications,
        loadResponse: responseSettlement.response,
        foreignNotificationCount: snapshot.foreignNotificationCount,
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          connection.replayRouter.abort(capture);
        }),
      ),
    );
  });

export const loadAcpImportSessionsBatch = (
  options: AcpImportConnectionOptions,
  sourcePaths: ReadonlyArray<string>,
): Effect.Effect<
  ReadonlyArray<AcpImportBatchLoadResult>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.suspend(() => {
    const policy = resolveAcpImportPolicy(options.policy);
    const normalizedByteBudget = { consumedBytes: 0 };
    const requestedSourcePaths = [...sourcePaths];
    const attemptedSourcePaths = requestedSourcePaths.slice(0, policy.maxSessions);
    const completedResults: Array<AcpImportBatchLoadResult | undefined> = Array.from({
      length: requestedSourcePaths.length,
    });
    for (let index = attemptedSourcePaths.length; index < requestedSourcePaths.length; index += 1) {
      const sourcePath = requestedSourcePaths[index]!;
      completedResults[index] = failedBatchResult(
        sourcePath,
        new AcpImportError(
          "limit-exceeded",
          `ACP batch request exceeded the configured ${policy.maxSessions}-session limit; this source was not loaded.`,
        ),
      );
    }

    const parsedRequests = attemptedSourcePaths.flatMap((sourcePath, index) => {
      try {
        return [
          {
            sourcePath,
            index,
            parsed: parseAcpImportSourcePath(
              sourcePath,
              options.driverKind,
              options.providerInstanceId,
            ),
          },
        ];
      } catch (cause) {
        completedResults[index] = failedBatchResult(
          sourcePath,
          boundedImportError("invalid-source", cause),
        );
        return [];
      }
    });
    if (parsedRequests.length === 0) {
      return Effect.succeed(finalizeBatchResults(requestedSourcePaths, completedResults));
    }

    const batch = Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connectAcpImportClient(options);
        const catalog = yield* listConnectedAcpImportSessions(
          connection,
          options.driverKind,
          options.providerInstanceId,
        );
        const catalogBySourcePath = new Map(catalog.map((entry) => [entry.sourcePath, entry]));
        let attributedWireBytes = 0;

        for (const request of parsedRequests) {
          const { index, parsed, sourcePath } = request;
          const descriptor = catalogBySourcePath.get(sourcePath);
          let result: AcpImportBatchLoadResult;
          if (descriptor === undefined || descriptor.nativeSessionId !== parsed.nativeSessionId) {
            result = failedBatchResult(
              sourcePath,
              new AcpImportError(
                "invalid-source",
                `ACP session '${parsed.nativeSessionId}' is no longer present in session/list.`,
              ),
            );
          } else {
            result = yield* loadConnectedAcpImportSession(connection, descriptor).pipe(
              Effect.flatMap((session) =>
                Effect.try({
                  try: () => retainNormalizedSession(policy, normalizedByteBudget, session),
                  catch: (cause) => boundedImportError("limit-exceeded", cause),
                }),
              ),
              Effect.match({
                onFailure: (error) => ({
                  sourcePath,
                  descriptor,
                  session: null,
                  error: boundedImportError(error.code, error),
                }),
                onSuccess: (session) => ({
                  sourcePath,
                  descriptor,
                  session,
                  error: null,
                }),
              }),
            );
          }
          const totalWireBytes = yield* connection.client.raw.incomingConnectionBytes;
          const consumedWireBytes = Math.max(0, totalWireBytes - attributedWireBytes);
          attributedWireBytes = totalWireBytes;
          completedResults[index] = { ...result, consumedWireBytes };
        }
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          for (const [index, sourcePath] of attemptedSourcePaths.entries()) {
            if (completedResults[index] !== undefined) {
              continue;
            }
            completedResults[index] = failedBatchResult(sourcePath, error);
          }
        }),
      ),
    );

    return batch.pipe(
      Effect.timeoutOption(policy.batchLoadTimeoutMs),
      Effect.map((completion) => {
        if (Option.isNone(completion)) {
          const timeout = new AcpImportError(
            "timeout",
            `ACP batch load timed out after ${policy.batchLoadTimeoutMs}ms.`,
          );
          for (const [index, sourcePath] of attemptedSourcePaths.entries()) {
            if (completedResults[index] !== undefined) {
              continue;
            }
            completedResults[index] = failedBatchResult(sourcePath, timeout);
          }
        }
        return finalizeBatchResults(requestedSourcePaths, completedResults);
      }),
    );
  });

export const loadAcpImportSession = (
  options: AcpImportConnectionOptions,
  sourcePath: string,
): Effect.Effect<AcpImportedSession, AcpImportError, ChildProcessSpawner.ChildProcessSpawner> =>
  loadAcpImportSessionsBatch(options, [sourcePath]).pipe(
    Effect.flatMap((results) => {
      const result = results[0];
      if (result?.session !== null && result?.session !== undefined) {
        return Effect.succeed(result.session);
      }
      return Effect.fail(
        result?.error ?? new AcpImportError("load-failed", "ACP batch load returned no result."),
      );
    }),
  );

export const scanAndLoadAcpImportCatalog = (
  options: AcpImportConnectionOptions,
  maximumSessionsToLoad = Number.POSITIVE_INFINITY,
): Effect.Effect<
  ReadonlyArray<AcpImportCatalogLoadResult>,
  AcpImportError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.suspend(() => {
    const policy = resolveAcpImportPolicy(options.policy);
    const normalizedByteBudget = { consumedBytes: 0 };
    return Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connectAcpImportClient(options);
        const catalog = yield* listConnectedAcpImportSessions(
          connection,
          options.driverKind,
          options.providerInstanceId,
        );
        const boundedCatalog = catalog.slice(0, Math.max(0, Math.floor(maximumSessionsToLoad)));
        let attributedWireBytes = 0;
        return yield* Effect.forEach(
          boundedCatalog,
          (descriptor) =>
            Effect.gen(function* () {
              const result: AcpImportCatalogLoadResult = yield* loadConnectedAcpImportSession(
                connection,
                descriptor,
              ).pipe(
                Effect.flatMap((session) =>
                  Effect.try({
                    try: () => retainNormalizedSession(policy, normalizedByteBudget, session),
                    catch: (cause) => boundedImportError("limit-exceeded", cause),
                  }),
                ),
                Effect.match({
                  onFailure: (error) => ({
                    descriptor,
                    session: null,
                    error: boundedImportError(error.code, error),
                  }),
                  onSuccess: (session) => ({
                    descriptor,
                    session,
                    error: null,
                  }),
                }),
              );
              const totalWireBytes = yield* connection.client.raw.incomingConnectionBytes;
              const consumedWireBytes = Math.max(0, totalWireBytes - attributedWireBytes);
              attributedWireBytes = totalWireBytes;
              return { ...result, consumedWireBytes };
            }),
          { concurrency: 1 },
        );
      }),
    ).pipe(Effect.mapError((error) => boundedImportError("list-failed", error)));
  });
