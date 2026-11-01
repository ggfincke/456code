#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

interface NativeStaticTool {
  readonly command: string;
  readonly installHint: string;
}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export class NativeStaticCheckSourceDiscoveryError extends Schema.TaggedError<NativeStaticCheckSourceDiscoveryError>()(
  "NativeStaticCheckSourceDiscoveryError",
  {
    operation: Schema.Literals(["resolve-root", "read-directory", "stat-entry"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Native source discovery operation '${this.operation}' failed.`;
  }
}

export class NativeStaticCheckProcessError extends Schema.TaggedError<NativeStaticCheckProcessError>()(
  "NativeStaticCheckProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    command: Schema.String,
    argumentCount: NonNegativeInt,
    cwd: Schema.String,
    shell: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Native static check process operation '${this.operation}' failed for command '${this.command}'.`;
  }
}

export class NativeStaticCheckCommandError extends Schema.TaggedError<NativeStaticCheckCommandError>()(
  "NativeStaticCheckCommandError",
  {
    command: Schema.String,
    argumentCount: NonNegativeInt,
    cwd: Schema.String,
    shell: Schema.Boolean,
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `Native static check command '${this.command}' exited with code ${this.exitCode}.`;
  }
}

const tools = [
  {
    command: "swiftlint",
    installHint: "brew install swiftlint",
  },
] as const satisfies ReadonlyArray<NativeStaticTool>;

const sourceExtensions = new Set([".swift"]);
const excludedDirectories = new Set([
  ".expo",
  ".git",
  "build",
  "DerivedData",
  "node_modules",
  "Pods",
  "Vendor",
]);
const generatedNativeProjectDirectories = new Set(["ios"]);

const mobileAppRootUrl = new URL("../apps/mobile", import.meta.url);
const appRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(mobileAppRootUrl)),
  Effect.mapError(
    (cause) =>
      new NativeStaticCheckSourceDiscoveryError({
        operation: "resolve-root",
        path: mobileAppRootUrl.pathname,
        cause,
      }),
  ),
);

const commandOutputOptions = {
  stdout: "inherit",
  stderr: "inherit",
} as const;

const commandExists = Effect.fn("commandExists")(function* (command: string) {
  return yield* isCommandAvailable(command);
});

const warnMissingTool = (tool: NativeStaticTool, checkName: string) =>
  Effect.logWarning(
    `${tool.command} is not installed; skipping ${checkName}. Install it with '${tool.installHint}' or run 'brew bundle install --file apps/mobile/Brewfile'.`,
  );

export const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  yield* Console.log(`$ ${[command, ...args].join(" ")}`);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(command, args);
  const processContext = {
    command,
    argumentCount: args.length,
    cwd,
    shell: spawnCommand.shell,
  } as const;
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd,
        ...commandOutputOptions,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new NativeStaticCheckProcessError({
            ...processContext,
            operation: "spawn",
            cause,
          }),
      ),
    );
  const exitCode = Number(
    yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new NativeStaticCheckProcessError({
            ...processContext,
            operation: "wait-for-exit",
            cause,
          }),
      ),
    ),
  );

  if (exitCode !== 0) {
    return yield* new NativeStaticCheckCommandError({
      ...processContext,
      exitCode,
    });
  }
});

export const collectSources = Effect.fn("mobile-native-static-check.collectSources")(function* (
  directory: string,
  root: string,
): Effect.fn.Return<
  ReadonlyArray<string>,
  NativeStaticCheckSourceDiscoveryError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.mapError(
      (cause) =>
        new NativeStaticCheckSourceDiscoveryError({
          operation: "read-directory",
          path: directory,
          cause,
        }),
    ),
  );
  const sources: Array<string> = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry);
    const stat = yield* fs.stat(entryPath).pipe(
      Effect.mapError(
        (cause) =>
          new NativeStaticCheckSourceDiscoveryError({
            operation: "stat-entry",
            path: entryPath,
            cause,
          }),
      ),
    );

    if (stat.type === "Directory") {
      const isGeneratedNativeProjectDirectory =
        directory === root && generatedNativeProjectDirectories.has(entry);

      if (excludedDirectories.has(entry) || isGeneratedNativeProjectDirectory) {
        continue;
      }

      sources.push(...(yield* collectSources(entryPath, root)));
      continue;
    }

    if (stat.type === "File" && sourceExtensions.has(path.extname(entry))) {
      sources.push(entryPath);
    }
  }

  return sources;
});

const runNativeStaticChecks = Effect.fn("runNativeStaticChecks")(function* () {
  const path = yield* Path.Path;
  const root = yield* appRoot;
  const sources = yield* collectSources(root, root);
  const swiftSources = sources.filter((source) => path.extname(source) === ".swift");
  const availableTools = new Map<string, boolean>();

  for (const tool of tools) {
    availableTools.set(tool.command, yield* commandExists(tool.command));
  }

  yield* Console.log(`Found ${swiftSources.length} Swift native source files.`);

  if (swiftSources.length > 0) {
    if (availableTools.get("swiftlint")) {
      yield* runCommand("swiftlint", ["lint", "--config", ".swiftlint.yml", "--strict"], root);
    } else {
      yield* warnMissingTool(tools[0], "SwiftLint");
    }
  }

  yield* Console.log("Skipping the generated native project folder: ios/.");
});

export const mobileNativeStaticCheckCommand = Command.make("mobile-native-static-check", {}, () =>
  runNativeStaticChecks(),
).pipe(
  Command.withDescription(
    "Run mobile native static analysis. SwiftLint may be skipped when unavailable.",
  ),
);

if (import.meta.main) {
  Command.run(mobileNativeStaticCheckCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
