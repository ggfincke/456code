// apps/server/src/cartographer/CartographerEmbedBroker.ts
// supervises capability-protected cartographer embed sidecars
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off globalDateInEffect:off - node owns the external sidecar process lifetime

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CartographerEmbedError,
  CartographerEmbedSessionId,
  type CartographerIssueEmbedResult,
  type ProposalGenerationId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { captureCurrentWorktree } from "./CurrentWorktreeSnapshot.ts";

const EMBED_ROUTE_PREFIX = "/api/cartographer/embed";
const EMBED_TICKET_TTL_MS = 60_000;
const EMBED_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const EMBED_START_TIMEOUT_MS = 120_000;
const EMBED_HANDSHAKE_MAX_BYTES = 64 * 1024;
const EMBED_ERROR_MAX_BYTES = 8 * 1024;
const EMBED_COOKIE_NAME = "t3-cartographer-session";

interface CartographerEmbedReady {
  readonly type: "cartographer.embed-ready";
  readonly version: 1;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly capability: string;
}

export interface CartographerEmbedSession {
  readonly sessionId: CartographerEmbedSessionId;
  readonly threadId: ThreadId;
  readonly generationId: ProposalGenerationId | null;
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
  readonly parentOrigin: string;
  readonly port: number;
  readonly capability: string;
  readonly cookieSecret: string;
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  expiryTimer: NodeJS.Timeout | null;
  ticketHash: Buffer | null;
  ticketExpiresAt: number;
  exited: boolean;
  disposePromise: Promise<void> | null;
}

export interface CartographerEmbedIssueInput {
  readonly threadId: ThreadId;
  readonly generationId?: ProposalGenerationId;
  readonly workspaceRoot: string;
  readonly baseGraphPath?: string;
  readonly proposedGraphPath?: string;
  readonly impactPath?: string;
  readonly parentOrigin: string;
  readonly theme: "light" | "dark";
}

export interface CartographerEmbedProxyTarget {
  readonly session: CartographerEmbedSession;
  readonly targetUrl: string;
}

export interface CartographerEmbedBrokerShape {
  readonly issue: (
    input: CartographerEmbedIssueInput,
  ) => Effect.Effect<CartographerIssueEmbedResult, CartographerEmbedError>;
  readonly exchangeTicket: (
    sessionId: string,
    ticket: string,
  ) => Effect.Effect<
    { readonly cookie: string; readonly redirectPath: string },
    CartographerEmbedError
  >;
  readonly resolveProxyTarget: (
    sessionId: string,
    cookieHeader: string | undefined,
    relativePath: string,
    search: string,
  ) => Effect.Effect<CartographerEmbedProxyTarget, CartographerEmbedError>;
  readonly releaseSession: (
    threadId: ThreadId,
    sessionId: CartographerEmbedSessionId,
  ) => Effect.Effect<void>;
  readonly closeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly closeAll: Effect.Effect<void>;
}

export class CartographerEmbedBroker extends Context.Service<
  CartographerEmbedBroker,
  CartographerEmbedBrokerShape
>()("456code/cartographer/CartographerEmbedBroker") {}

function token(bytes = 32): string {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}

function tokenHash(value: string): Buffer {
  return NodeCrypto.createHash("sha256").update(value.slice(0, 4_096), "utf8").digest();
}

function equalSecret(left: Buffer, right: Buffer): boolean {
  return left.length > 0 && left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
}

function validateParentOrigin(rawOrigin: string): string | null {
  if (rawOrigin === "code456://app" || rawOrigin === "code456-dev://app") {
    return rawOrigin;
  }
  try {
    const parsed = new URL(rawOrigin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== rawOrigin
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeConfiguredAbsolutePath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  return trimmed !== "" && NodePath.isAbsolute(trimmed) ? NodePath.normalize(trimmed) : null;
}

function publicError(
  failure: CartographerEmbedError["failure"],
  message: string,
): CartographerEmbedError {
  return new CartographerEmbedError({ failure, message });
}

function decodeReadyHandshake(line: string): CartographerEmbedReady | null {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      value.type !== "cartographer.embed-ready" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("host" in value) ||
      value.host !== "127.0.0.1" ||
      !("port" in value) ||
      typeof value.port !== "number" ||
      !Number.isSafeInteger(value.port) ||
      value.port < 1 ||
      value.port > 65_535 ||
      !("capability" in value) ||
      typeof value.capability !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(value.capability)
    ) {
      return null;
    }
    return value as CartographerEmbedReady;
  } catch {
    return null;
  }
}

async function readReadyHandshake(
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  signal: AbortSignal,
): Promise<CartographerEmbedReady> {
  return await new Promise<CartographerEmbedReady>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Cartographer did not become ready within ${EMBED_START_TIMEOUT_MS}ms.`));
    }, EMBED_START_TIMEOUT_MS);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error: Error | null, ready?: CartographerEmbedReady) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else if (ready) {
        resolve(ready);
      }
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > EMBED_HANDSHAKE_MAX_BYTES) {
        finish(new Error("Cartographer emitted an oversized readiness handshake."));
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const ready = decodeReadyHandshake(stdout.slice(0, newline).trim());
      finish(
        ready
          ? null
          : new Error(
              stderr.trim().slice(0, EMBED_ERROR_MAX_BYTES) ||
                "Cartographer emitted an invalid readiness handshake.",
            ),
        ready ?? undefined,
      );
    };
    const onStderr = (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < EMBED_ERROR_MAX_BYTES) {
        stderr += chunk.toString("utf8").slice(0, EMBED_ERROR_MAX_BYTES);
      }
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          stderr.trim().slice(0, EMBED_ERROR_MAX_BYTES) ||
            `Cartographer exited before readiness (${code ?? signal ?? "unknown"}).`,
        ),
      );
    const onAbort = () => finish(new Error("Cartographer startup was cancelled."));

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function cookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === cookieName) {
      return entry.slice(separator + 1).trim();
    }
  }
  return null;
}

async function stopChild(child: NodeChildProcess.ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (terminateTimer) clearTimeout(terminateTimer);
      if (forceTimer) clearTimeout(forceTimer);
      child.off("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    terminateTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        finish();
        return;
      }
      // keep shutdown bounded even if the platform never reports exit
      forceTimer = setTimeout(finish, 2_000);
      forceTimer.unref();
    }, 2_000);
    terminateTimer.unref();
  });
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sessions = new Map<string, CartographerEmbedSession>();
  const threadLocks = new Map<ThreadId, Semaphore.Semaphore>();
  const deletedThreads = new Set<ThreadId>();
  const pendingStarts = new Map<ThreadId, AbortController>();
  let brokerClosed = false;
  const configuredNodePath = process.env.T3CODE_CARTOGRAPHER_NODE;
  const nodePath =
    configuredNodePath === undefined ? "node" : normalizeConfiguredAbsolutePath(configuredNodePath);
  const configuredCliPath = process.env.T3CODE_CARTOGRAPHER_CLI;
  const cliPath =
    configuredCliPath === undefined
      ? undefined
      : normalizeConfiguredAbsolutePath(configuredCliPath);

  const disposeSession = (session: CartographerEmbedSession): Promise<void> => {
    if (session.disposePromise !== null) return session.disposePromise;
    session.disposePromise = (async () => {
      sessions.delete(session.sessionId);
      if (session.expiryTimer !== null) {
        clearTimeout(session.expiryTimer);
        session.expiryTimer = null;
      }
      session.ticketHash = null;
      await stopChild(session.child);
      await NodeFSP.rm(session.artifactRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      }).catch(() => undefined);
    })();
    return session.disposePromise;
  };

  const closeSession = (session: CartographerEmbedSession) =>
    Effect.promise(() => disposeSession(session));

  const closeThreadUnlocked: CartographerEmbedBrokerShape["closeThread"] = (threadId) =>
    Effect.forEach(
      [...sessions.values()].filter((session) => session.threadId === threadId),
      closeSession,
      { discard: true },
    );

  const lockForThread = Effect.fn("CartographerEmbedBroker.lockForThread")(function* (
    threadId: ThreadId,
  ) {
    const existing = threadLocks.get(threadId);
    if (existing) return existing;
    const created = yield* Semaphore.make(1);
    const raced = threadLocks.get(threadId);
    if (raced) return raced;
    threadLocks.set(threadId, created);
    return created;
  });

  const closeAll = Effect.suspend(() =>
    Effect.gen(function* () {
      brokerClosed = true;
      for (const controller of pendingStarts.values()) {
        controller.abort();
      }
      yield* Effect.forEach(
        [...threadLocks.entries()],
        ([threadId, lock]) => lock.withPermit(closeThreadUnlocked(threadId)),
        { discard: true },
      );
      yield* Effect.forEach([...sessions.values()], closeSession, { discard: true });
    }),
  );

  const startupUnavailable = (
    threadId: ThreadId,
    signal?: AbortSignal,
  ): CartographerEmbedError | null => {
    if (brokerClosed) {
      return publicError("session_not_found", "Cartographer cannot start after its broker closed.");
    }
    if (deletedThreads.has(threadId) || signal?.aborted === true) {
      return publicError("session_not_found", "Cartographer cannot start for a deleted thread.");
    }
    return null;
  };

  const issueUnlocked: CartographerEmbedBrokerShape["issue"] = Effect.fn(
    "CartographerEmbedBroker.issue",
  )(function* (input) {
    const unavailableAtEntry = startupUnavailable(input.threadId);
    if (unavailableAtEntry !== null) return yield* unavailableAtEntry;
    if (
      configuredCliPath === undefined ||
      configuredCliPath.trim() === "" ||
      cliPath === undefined
    ) {
      return yield* publicError(
        "unsupported",
        "Cartographer is unavailable because T3CODE_CARTOGRAPHER_CLI is not configured.",
      );
    }
    if (cliPath === null) {
      return yield* publicError(
        "unsupported",
        "The configured Cartographer CLI path must be absolute.",
      );
    }
    if (nodePath === null) {
      return yield* publicError(
        "unsupported",
        "The configured Cartographer Node executable path must be absolute.",
      );
    }
    const validatedCliPath = cliPath;
    const validatedNodePath = nodePath;
    const parentOrigin = validateParentOrigin(input.parentOrigin);
    if (!parentOrigin) {
      return yield* publicError("start_failed", "The Cartographer parent origin is invalid.");
    }
    const workspaceRoot = NodePath.resolve(input.workspaceRoot);
    const hasBaseGraph = input.baseGraphPath !== undefined;
    const hasProposedGraph = input.proposedGraphPath !== undefined;
    const hasImpact = input.impactPath !== undefined;
    if (hasBaseGraph !== hasProposedGraph || hasBaseGraph !== hasImpact) {
      return yield* publicError(
        "start_failed",
        "Cartographer comparison artifacts must be provided together.",
      );
    }
    const cliStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(validatedCliPath),
      catch: () =>
        publicError("unsupported", "The configured Cartographer CLI could not be loaded."),
    });
    if (!cliStat.isFile()) {
      return yield* publicError("unsupported", "The configured Cartographer CLI is not a file.");
    }
    if (configuredNodePath !== undefined) {
      const nodeStat = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(validatedNodePath),
        catch: () =>
          publicError(
            "unsupported",
            "The configured Cartographer Node executable could not be loaded.",
          ),
      });
      if (!nodeStat.isFile()) {
        return yield* publicError(
          "unsupported",
          "The configured Cartographer Node executable is not a file.",
        );
      }
      yield* Effect.tryPromise({
        try: () => NodeFSP.access(validatedNodePath, NodeFS.constants.X_OK),
        catch: () =>
          publicError(
            "unsupported",
            "The configured Cartographer Node executable is not executable.",
          ),
      });
    }

    yield* closeThreadUnlocked(input.threadId);
    const unavailableAfterReplacement = startupUnavailable(input.threadId);
    if (unavailableAfterReplacement !== null) return yield* unavailableAfterReplacement;
    const startController = new AbortController();
    pendingStarts.set(input.threadId, startController);
    const sessionId = CartographerEmbedSessionId.make(token(18));
    let artifactRoot = NodePath.join(config.stateDir, "cartographer", "embed", sessionId);
    let preRegistrationChild: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
    let sessionRegistered = false;

    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(artifactRoot, { recursive: true }),
        catch: () =>
          publicError("start_failed", "Cartographer artifact storage could not be created."),
      });
      artifactRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(artifactRoot),
        catch: () =>
          publicError("start_failed", "Cartographer artifact storage could not be resolved."),
      });
      const unavailableAfterStorage = startupUnavailable(input.threadId, startController.signal);
      if (unavailableAfterStorage !== null) return yield* unavailableAfterStorage;
      const sidecarWorkspaceRoot =
        input.generationId === undefined
          ? (yield* captureCurrentWorktree({
              workspaceRoot,
              artifactRoot,
              signal: startController.signal,
            })).rootPath
          : workspaceRoot;
      const unavailableAfterCapture = startupUnavailable(input.threadId, startController.signal);
      if (unavailableAfterCapture !== null) return yield* unavailableAfterCapture;

      const child = yield* Effect.try({
        try: () =>
          NodeChildProcess.spawn(
            validatedNodePath,
            [
              validatedCliPath,
              "embed-server",
              sidecarWorkspaceRoot,
              ...(input.generationId === undefined ? ["--scope", "."] : []),
              "--out",
              artifactRoot,
              "--parent-origin",
              parentOrigin,
              "--storage-namespace",
              `t3-${sessionId}`,
              "--theme",
              input.theme,
              "--port",
              "0",
              ...(input.baseGraphPath === undefined ||
              input.proposedGraphPath === undefined ||
              input.impactPath === undefined
                ? []
                : [
                    "--base-graph",
                    NodePath.resolve(input.baseGraphPath),
                    "--proposed-graph",
                    NodePath.resolve(input.proposedGraphPath),
                    "--impact-artifact",
                    NodePath.resolve(input.impactPath),
                  ]),
            ],
            {
              cwd: sidecarWorkspaceRoot,
              env: process.env,
              stdio: ["pipe", "pipe", "pipe"],
            },
          ),
        catch: () => publicError("start_failed", "Cartographer could not be started."),
      });
      preRegistrationChild = child;
      child.stdin.end();
      const ready = yield* Effect.tryPromise({
        try: () => readReadyHandshake(child, startController.signal),
        catch: (cause) => ({
          error:
            startupUnavailable(input.threadId, startController.signal) ??
            publicError("invalid_handshake", "Cartographer failed to start safely."),
          detail:
            cause instanceof Error
              ? cause.message.slice(0, EMBED_ERROR_MAX_BYTES)
              : "Unknown Cartographer startup failure.",
        }),
      }).pipe(
        Effect.tapError(({ detail }) =>
          Effect.logWarning("cartographer embed startup failed", {
            threadId: input.threadId,
            sessionId,
            detail,
          }),
        ),
        Effect.mapError(({ error }) => error),
      );
      const unavailableAfterHandshake = startupUnavailable(input.threadId, startController.signal);
      if (unavailableAfterHandshake !== null) return yield* unavailableAfterHandshake;

      const ticket = token();
      const cookieSecret = token();
      const issuedAt = Date.now();
      const ticketExpiresAt = issuedAt + EMBED_TICKET_TTL_MS;
      const session: CartographerEmbedSession = {
        sessionId,
        threadId: input.threadId,
        generationId: input.generationId ?? null,
        workspaceRoot: sidecarWorkspaceRoot,
        artifactRoot,
        parentOrigin,
        port: ready.port,
        capability: ready.capability,
        cookieSecret,
        child,
        expiryTimer: null,
        ticketHash: tokenHash(ticket),
        ticketExpiresAt,
        exited: false,
        disposePromise: null,
      };
      const onExit = () => {
        session.exited = true;
        void disposeSession(session);
      };
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off("exit", onExit);
        return yield* publicError(
          "invalid_handshake",
          "Cartographer exited before its embed session could be registered.",
        );
      }
      // sidecar diagnostics are intentionally drained but never sent to clients
      child.stderr.resume();
      child.stdout.resume();
      session.expiryTimer = setTimeout(() => {
        void disposeSession(session);
      }, EMBED_TICKET_TTL_MS);
      session.expiryTimer.unref();
      sessions.set(sessionId, session);
      sessionRegistered = true;
      if (pendingStarts.get(input.threadId) === startController) {
        pendingStarts.delete(input.threadId);
      }

      return {
        version: 1 as const,
        sessionId,
        url: `${EMBED_ROUTE_PREFIX}/${sessionId}/exchange?ticket=${encodeURIComponent(ticket)}`,
        expiresAt: new Date(ticketExpiresAt).toISOString(),
      };
    }).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          if (pendingStarts.get(input.threadId) === startController) {
            pendingStarts.delete(input.threadId);
          }
          if (sessionRegistered) return;
          if (preRegistrationChild !== null) {
            await stopChild(preRegistrationChild);
          }
          await NodeFSP.rm(artifactRoot, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 25,
          }).catch(() => undefined);
        }),
      ),
    );
  });

  const issue: CartographerEmbedBrokerShape["issue"] = (input) =>
    Effect.gen(function* () {
      const unavailable = startupUnavailable(input.threadId);
      if (unavailable !== null) return yield* unavailable;
      const lock = yield* lockForThread(input.threadId);
      return yield* lock.withPermit(issueUnlocked(input));
    });

  const releaseSession: CartographerEmbedBrokerShape["releaseSession"] = (threadId, sessionId) =>
    Effect.flatMap(lockForThread(threadId), (lock) =>
      lock.withPermit(
        Effect.gen(function* () {
          const session = sessions.get(sessionId);
          if (session?.threadId === threadId) {
            yield* closeSession(session);
          }
        }),
      ),
    );

  const closeThread: CartographerEmbedBrokerShape["closeThread"] = (threadId) =>
    Effect.gen(function* () {
      deletedThreads.add(threadId);
      pendingStarts.get(threadId)?.abort();
      const lock = yield* lockForThread(threadId);
      yield* lock.withPermit(closeThreadUnlocked(threadId));
    });

  const exchangeTicket: CartographerEmbedBrokerShape["exchangeTicket"] = Effect.fn(
    "CartographerEmbedBroker.exchangeTicket",
  )(function* (sessionId, ticket) {
    const session = sessions.get(sessionId);
    const presented = tokenHash(ticket);
    if (
      !session ||
      session.exited ||
      session.ticketHash === null ||
      Date.now() > session.ticketExpiresAt ||
      !equalSecret(session.ticketHash, presented)
    ) {
      return yield* publicError("ticket_invalid", "The Cartographer embed ticket is invalid.");
    }
    session.ticketHash = null;
    if (session.expiryTimer !== null) clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(() => {
      void disposeSession(session);
    }, EMBED_SESSION_TTL_MS);
    session.expiryTimer.unref();
    const cookiePath = `${EMBED_ROUTE_PREFIX}/${session.sessionId}`;
    const crossSiteParent =
      session.parentOrigin.startsWith("https:") ||
      session.parentOrigin === "code456://app" ||
      session.parentOrigin === "code456-dev://app";
    const sameSite = crossSiteParent ? "SameSite=None; Secure; Partitioned" : "SameSite=Strict";
    return {
      cookie: `${EMBED_COOKIE_NAME}=${session.cookieSecret}; Path=${cookiePath}; Max-Age=${Math.floor(EMBED_SESSION_TTL_MS / 1_000)}; HttpOnly; ${sameSite}`,
      redirectPath: `${cookiePath}/`,
    };
  });

  const resolveProxyTarget: CartographerEmbedBrokerShape["resolveProxyTarget"] = Effect.fn(
    "CartographerEmbedBroker.resolveProxyTarget",
  )(function* (sessionId, cookieHeader, relativePath, search) {
    const session = sessions.get(sessionId);
    if (!session || session.exited) {
      return yield* publicError(
        "session_not_found",
        "The Cartographer embed session was not found.",
      );
    }
    const presentedCookie = cookieValue(cookieHeader, EMBED_COOKIE_NAME);
    if (
      presentedCookie === null ||
      !equalSecret(tokenHash(session.cookieSecret), tokenHash(presentedCookie))
    ) {
      return yield* publicError(
        "ticket_invalid",
        "The Cartographer embed session is unauthorized.",
      );
    }
    const normalizedPath = relativePath.replace(/^[/\\]+/u, "");
    if (
      normalizedPath.includes("\0") ||
      normalizedPath.split(/[\\/]/u).some((segment) => segment === "..")
    ) {
      return yield* publicError("proxy_failed", "The Cartographer proxy path is invalid.");
    }
    return {
      session,
      targetUrl: `http://127.0.0.1:${session.port}/${normalizedPath}${search}`,
    };
  });

  return CartographerEmbedBroker.of({
    issue,
    exchangeTicket,
    resolveProxyTarget,
    releaseSession,
    closeThread,
    closeAll,
  });
});

export const layer = Layer.effect(
  CartographerEmbedBroker,
  Effect.acquireRelease(make, (broker) => broker.closeAll),
);

export const routePrefix = EMBED_ROUTE_PREFIX;
