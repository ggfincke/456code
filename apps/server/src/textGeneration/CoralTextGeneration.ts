// apps/server/src/textGeneration/CoralTextGeneration.ts
// generates structured text through isolated coral commands
import type { CoralSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  buildCoralAcpEnvironment,
  normalizeCoralOllamaHost,
} from "../provider/acp/CoralAcpSupport.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { normalizeCliError } from "@t3tools/provider-core/server/textGenerationUtils";
const CORAL_TIMEOUT_MS = 180_000;

const CoralExecResult = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["completed", "cancelled", "iteration_limited", "failed"]),
  response: Schema.String,
  error: Schema.optional(Schema.String),
});
const decodeCoralExecResult = Schema.decodeUnknownEffect(Schema.fromJsonString(CoralExecResult));

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeCoralTextGeneration = Effect.fn("makeCoralTextGeneration")(function* (
  coralSettings: CoralSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeEnvironment = buildCoralAcpEnvironment(
    coralSettings,
    environment,
    yield* HostProcess.HomeDirectory,
  );

  const runCoralJson = Effect.fn("CoralTextGeneration.runJson")(
    function* <S extends Schema.Top>(
      input: TextGenerationOperations.Request<S>,
    ): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
      if ((input.attachments?.length ?? 0) > 0) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Coral text generation does not support attachments yet.",
        });
      }

      const promptPath = yield* fileSystem
        .makeTempFileScoped({ prefix: `456code-coral-${process.pid}-` })
        .pipe(
          Effect.tap((filePath) => fileSystem.writeFileString(filePath, input.prompt)),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Failed to write the Coral text-generation prompt.",
                cause,
              }),
          ),
        );
      const command = coralSettings.binaryPath || "coral";
      const spawnCommand = yield* resolveSpawnCommand(
        command,
        [
          "exec",
          "--permission-profile",
          "none",
          "--output-format",
          "json",
          "--ephemeral",
          "--no-mcp",
          "--host",
          normalizeCoralOllamaHost(coralSettings.ollamaHost),
          "--model",
          input.modelSelection.model,
          "--cwd",
          input.cwd,
          "--prompt-file",
          promptPath,
        ],
        { env: runtimeEnvironment },
      );
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: input.cwd,
            env: runtimeEnvironment,
            shell: spawnCommand.shell,
            stdin: { stream: Stream.empty },
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              "coral",
              input.operation,
              cause,
              "Failed to spawn the Coral CLI process.",
            ),
          ),
        );

      const completed = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.mapError((cause) =>
              normalizeCliError("coral", input.operation, cause, "Failed to read Coral stdout."),
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.mapError((cause) =>
              normalizeCliError("coral", input.operation, cause, "Failed to read Coral stderr."),
            ),
          ),
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError((cause) =>
              normalizeCliError(
                "coral",
                input.operation,
                cause,
                "Failed to read the Coral CLI exit code.",
              ),
            ),
          ),
        ] as const,
        { concurrency: "unbounded" },
      ).pipe(Effect.timeoutOption(CORAL_TIMEOUT_MS));

      if (Option.isNone(completed)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Coral CLI request timed out.",
        });
      }
      const [stdout, stderr, exitCode] = completed.value;
      const execResult = yield* decodeCoralExecResult(stdout.trim()).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Coral CLI returned an invalid JSON result envelope.",
              cause,
            }),
        ),
      );
      if (exitCode !== 0 || execResult.status !== "completed") {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            execResult.error?.trim() ||
            (stderr.trim().length > 0
              ? `Coral CLI request failed: ${stderr.trim()}`
              : `Coral CLI request ended with status ${execResult.status}.`),
        });
      }
      if (!execResult.response.trim()) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Coral returned empty text-generation output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
      return yield* decodeOutput(extractJsonObject(execResult.response)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Coral returned invalid structured output.",
              cause,
            }),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Coral text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  return TextGenerationOperations.fromRunner(
    "CoralTextGeneration",
    TextGenerationOperations.withoutInvestigation("Coral", runCoralJson),
  );
});
