// apps/server/src/cartographer/CurrentWorktreeSnapshot.ts
// adapts exact Git snapshots into bounded Cartographer worktree captures
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { CartographerEmbedError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT,
  EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT,
  captureExactGitSnapshot,
  materializeExactGitTree,
} from "../vcs/ExactGitSnapshot.ts";

export const CURRENT_WORKTREE_SNAPSHOT_MAX_ENTRIES = EXACT_GIT_SNAPSHOT_MAX_FILE_COUNT;
export const CURRENT_WORKTREE_SNAPSHOT_MAX_BYTES = EXACT_GIT_SNAPSHOT_MAX_BYTE_COUNT;

export interface CaptureCurrentWorktreeInput {
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
  readonly signal: AbortSignal;
}

export interface CurrentWorktreeSnapshot {
  readonly rootPath: string;
  readonly treeOid: string;
  readonly entryCount: number;
  readonly byteCount: number;
}

const isCartographerEmbedError = Schema.is(CartographerEmbedError);

function publicError(message: string): CartographerEmbedError {
  return new CartographerEmbedError({
    failure: "start_failed",
    message,
  });
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = NodePath.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}

async function removeCapturePath(path: string): Promise<void> {
  await NodeFSP.rm(path, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 25,
  });
}

async function captureCurrentWorktreePromise(
  input: CaptureCurrentWorktreeInput,
  effectSignal: AbortSignal,
): Promise<CurrentWorktreeSnapshot> {
  if (!NodePath.isAbsolute(input.workspaceRoot) || !NodePath.isAbsolute(input.artifactRoot)) {
    throw publicError("Cartographer current-worktree capture requires absolute paths.");
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  effectSignal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted || effectSignal.aborted) {
    abort();
  }

  let destinationRoot: string | null = null;

  try {
    if (controller.signal.aborted) {
      throw publicError("Cartographer current-worktree capture was cancelled.");
    }

    const workspaceRoot = await NodeFSP.realpath(input.workspaceRoot);
    const artifactRoot = await NodeFSP.realpath(input.artifactRoot);
    if (isPathWithin(workspaceRoot, artifactRoot)) {
      throw publicError(
        "Cartographer current-worktree artifacts must be stored outside the captured worktree.",
      );
    }

    const indexPath = NodePath.join(
      artifactRoot,
      `.current-worktree-index-${NodeCrypto.randomUUID()}`,
    );
    const limits = {
      maxFileCount: CURRENT_WORKTREE_SNAPSHOT_MAX_ENTRIES,
      maxByteCount: CURRENT_WORKTREE_SNAPSHOT_MAX_BYTES,
    };
    const snapshot = await captureExactGitSnapshot({
      repositoryRoot: workspaceRoot,
      indexPath,
      signal: controller.signal,
      limits,
    });

    if (controller.signal.aborted) {
      throw publicError("Cartographer current-worktree capture was cancelled.");
    }

    destinationRoot = await NodeFSP.mkdtemp(NodePath.join(artifactRoot, "current-worktree-"));
    const materialized = await materializeExactGitTree({
      repositoryRoot: workspaceRoot,
      treeOid: snapshot.treeOid,
      destinationRoot,
      signal: controller.signal,
      limits,
    });
    if (
      materialized.rootPath !== destinationRoot ||
      materialized.fileCount !== snapshot.fileCount ||
      materialized.byteCount !== snapshot.byteCount
    ) {
      throw publicError(
        "Cartographer could not verify the materialized current-worktree snapshot.",
      );
    }

    if (controller.signal.aborted) {
      throw publicError("Cartographer current-worktree capture was cancelled.");
    }

    return {
      rootPath: materialized.rootPath,
      treeOid: snapshot.treeOid,
      entryCount: snapshot.fileCount,
      byteCount: snapshot.byteCount,
    };
  } catch (cause) {
    if (destinationRoot !== null) {
      try {
        await removeCapturePath(destinationRoot);
      } catch {
        throw publicError(
          "Cartographer could not remove temporary current-worktree capture state.",
        );
      }
    }
    if (isCartographerEmbedError(cause)) {
      throw cause;
    }
    if (controller.signal.aborted) {
      throw publicError("Cartographer current-worktree capture was cancelled.");
    }
    throw publicError("Cartographer could not capture the current worktree.");
  } finally {
    input.signal.removeEventListener("abort", abort);
    effectSignal.removeEventListener("abort", abort);
  }
}

export const captureCurrentWorktree = Effect.fn("CurrentWorktreeSnapshot.capture")(function* (
  input: CaptureCurrentWorktreeInput,
) {
  return yield* Effect.tryPromise({
    try: (signal) => captureCurrentWorktreePromise(input, signal),
    catch: (cause) =>
      isCartographerEmbedError(cause)
        ? cause
        : publicError("Cartographer could not capture the current worktree."),
  });
});
