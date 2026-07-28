// apps/server/src/workspace/WorkspaceFileSystem.ts
// owns contained utf-8 workspace file reads and writes

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;
const isWorkspaceFileSystemOperationError = Schema.is(WorkspaceFileSystemOperationError);

function sameFileIdentity(
  left: Pick<NodeFS.BigIntStats, "dev" | "ino">,
  right: Pick<NodeFS.BigIntStats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isCanonicalDescendant(workspaceRoot: string, candidate: string): boolean {
  const relative = NodePath.relative(workspaceRoot, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

function changedDuringRead(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly resolvedPath: string;
}): WorkspaceFileSystemOperationError {
  return new WorkspaceFileSystemOperationError({
    ...input,
    operationPath: input.resolvedPath,
    operation: "read",
    cause: new Error("Workspace file changed while it was being read."),
  });
}

async function revalidateOpenedWorkspaceFile(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly realWorkspaceRoot: string;
  readonly realTargetPath: string;
  readonly workspaceStat: NodeFS.BigIntStats;
  readonly fileStat: NodeFS.BigIntStats;
  readonly openedStat: NodeFS.BigIntStats;
}): Promise<void> {
  let currentWorkspaceRoot: string;
  let currentTargetPath: string;
  let currentWorkspaceStat: NodeFS.BigIntStats;
  let currentTargetStat: NodeFS.BigIntStats;
  try {
    [currentWorkspaceRoot, currentTargetPath, currentWorkspaceStat, currentTargetStat] =
      await Promise.all([
        NodeFSP.realpath(input.workspaceRoot),
        NodeFSP.realpath(input.absolutePath),
        NodeFSP.stat(input.realWorkspaceRoot, { bigint: true }),
        NodeFSP.lstat(input.realTargetPath, { bigint: true }),
      ]);
  } catch {
    throw changedDuringRead({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.relativePath,
      resolvedPath: input.realTargetPath,
    });
  }

  if (
    currentWorkspaceRoot !== input.realWorkspaceRoot ||
    !currentWorkspaceStat.isDirectory() ||
    !sameFileIdentity(currentWorkspaceStat, input.workspaceStat) ||
    currentTargetPath !== input.realTargetPath ||
    !currentTargetStat.isFile() ||
    !sameFileIdentity(currentTargetStat, input.fileStat) ||
    !sameFileIdentity(currentTargetStat, input.openedStat) ||
    !isCanonicalDescendant(currentWorkspaceRoot, currentTargetPath)
  ) {
    throw changedDuringRead({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.relativePath,
      resolvedPath: input.realTargetPath,
    });
  }
}

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("456code/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const workspaceStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(realWorkspaceRoot, { bigint: true }),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: realWorkspaceRoot,
          operation: "stat",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    const fileStat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(realTargetPath, { bigint: true }),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: realTargetPath,
          operation: "stat",
          cause,
        }),
    });
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    if (!workspaceStat.isDirectory() || !fileStat.isFile()) {
      return yield* new WorkspacePathNotFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: realTargetPath,
      });
    }

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => {
          const noFollow = NodeFS.constants.O_NOFOLLOW ?? 0;
          const nonBlock = NodeFS.constants.O_NONBLOCK ?? 0;
          return NodeFSP.open(realTargetPath, NodeFS.constants.O_RDONLY | noFollow | nonBlock);
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const initialStat = yield* Effect.tryPromise({
            try: () => handle.stat({ bigint: true }),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!initialStat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }
          if (!sameFileIdentity(initialStat, fileStat)) {
            return yield* changedDuringRead({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }
          yield* Effect.tryPromise({
            try: () =>
              revalidateOpenedWorkspaceFile({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                absolutePath: target.absolutePath,
                realWorkspaceRoot,
                realTargetPath,
                workspaceStat,
                fileStat,
                openedStat: initialStat,
              }),
            catch: (cause) =>
              isWorkspaceFileSystemOperationError(cause)
                ? cause
                : changedDuringRead({
                    workspaceRoot: input.cwd,
                    relativePath: input.relativePath,
                    resolvedPath: realTargetPath,
                  }),
          });

          const byteLength = Number(initialStat.size);
          if (!Number.isSafeInteger(byteLength)) {
            return yield* changedDuringRead({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }
          const truncated = byteLength > PROJECT_READ_FILE_MAX_BYTES;
          const expectedBytes = Math.min(byteLength, PROJECT_READ_FILE_MAX_BYTES);
          const readLimit = truncated ? expectedBytes : expectedBytes + 1;
          const buffer = Buffer.alloc(readLimit);
          let bytesRead = 0;
          while (bytesRead < readLimit) {
            const result = yield* Effect.tryPromise({
              try: () => handle.read(buffer, bytesRead, readLimit - bytesRead, bytesRead),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "read",
                  cause,
                }),
            });
            if (result.bytesRead === 0) {
              break;
            }
            bytesRead += result.bytesRead;
          }
          const finalStat = yield* Effect.tryPromise({
            try: () => handle.stat({ bigint: true }),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (
            bytesRead !== expectedBytes ||
            !sameFileIdentity(finalStat, initialStat) ||
            finalStat.size !== initialStat.size ||
            finalStat.mtimeNs !== initialStat.mtimeNs ||
            finalStat.ctimeNs !== initialStat.ctimeNs
          ) {
            return yield* changedDuringRead({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }
          yield* Effect.tryPromise({
            try: () =>
              revalidateOpenedWorkspaceFile({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                absolutePath: target.absolutePath,
                realWorkspaceRoot,
                realTargetPath,
                workspaceStat,
                fileStat,
                openedStat: finalStat,
              }),
            catch: (cause) =>
              isWorkspaceFileSystemOperationError(cause)
                ? cause
                : changedDuringRead({
                    workspaceRoot: input.cwd,
                    relativePath: input.relativePath,
                    resolvedPath: realTargetPath,
                  }),
          });

          const fileBytes = buffer.subarray(0, expectedBytes);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const contents = yield* Effect.try({
            try: () =>
              new TextDecoder("utf-8", { fatal: true }).decode(
                fileBytes,
                truncated ? { stream: true } : undefined,
              ),
            catch: () =>
              new WorkspaceBinaryFileError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
              }),
          });

          return {
            relativePath: target.relativePath,
            contents,
            byteLength,
            truncated,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
