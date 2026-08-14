// apps/server/src/textGeneration/CoralTextGeneration.ts
// generate source-control text through an isolated no-tool Coral exec run

import type { CoralSettings, ModelSelection } from '@t3tools/contracts'
import { TextGenerationError } from '@t3tools/contracts'
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from '@t3tools/shared/git'
import { extractJsonObject } from '@t3tools/shared/schemaJson'
import { resolveSpawnCommand } from '@t3tools/shared/shell'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import {
  buildCoralAcpEnvironment,
  normalizeCoralOllamaHost,
} from '../provider/acp/CoralAcpSupport.ts'
import * as TextGeneration from './TextGeneration.ts'
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from './TextGenerationPrompts.ts'
import {
  normalizeCliError,
  readCliStreamAsString,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from './TextGenerationUtils.ts'

const CORAL_TIMEOUT_MS = 180_000

const CoralExecResult = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(['completed', 'cancelled', 'iteration_limited', 'failed']),
  response: Schema.String,
  error: Schema.optional(Schema.String),
})
const decodeCoralExecResult = Schema.decodeUnknownEffect(Schema.fromJsonString(CoralExecResult))

const isTextGenerationError = Schema.is(TextGenerationError)

export const makeCoralTextGeneration = Effect.fn('makeCoralTextGeneration')(function* (
  coralSettings: CoralSettings,
  environment: NodeJS.ProcessEnv = process.env,
)
{
  const fileSystem = yield* FileSystem.FileSystem
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const runtimeEnvironment = buildCoralAcpEnvironment(coralSettings, environment)

  const runCoralJson = <S extends Schema.Top>(input: {
    readonly operation: TextGeneration.TextGenerationOp
    readonly cwd: string
    readonly prompt: string
    readonly attachments?: TextGeneration.BranchNameGenerationInput['attachments']
    readonly outputSchemaJson: S
    readonly modelSelection: ModelSelection
  }): Effect.Effect<S['Type'], TextGenerationError, S['DecodingServices']> =>
    Effect.gen(function* ()
    {
      if ((input.attachments?.length ?? 0) > 0)
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: 'Coral text generation does not support attachments yet.',
        })
      }

      const promptPath = yield* fileSystem
        .makeTempFileScoped({ prefix: `456code-coral-${process.pid}-` })
        .pipe(
          Effect.tap((filePath) => fileSystem.writeFileString(filePath, input.prompt)),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: 'Failed to write the Coral text-generation prompt.',
                cause,
              }),
          ),
        )
      const command = coralSettings.binaryPath || 'coral'
      const spawnCommand = yield* resolveSpawnCommand(
        command,
        [
          'exec',
          '--permission-profile',
          'none',
          '--output-format',
          'json',
          '--ephemeral',
          '--no-mcp',
          '--host',
          normalizeCoralOllamaHost(coralSettings.ollamaHost),
          '--model',
          input.modelSelection.model,
          '--cwd',
          input.cwd,
          '--prompt-file',
          promptPath,
        ],
        { env: runtimeEnvironment },
      )
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
              'coral',
              input.operation,
              cause,
              'Failed to spawn the Coral CLI process.',
            ),
          ),
        )

      const completed = yield* Effect.all(
        [
          readCliStreamAsString('coral', input.operation, child.stdout),
          readCliStreamAsString('coral', input.operation, child.stderr),
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError((cause) =>
              normalizeCliError(
                'coral',
                input.operation,
                cause,
                'Failed to read the Coral CLI exit code.',
              ),
            ),
          ),
        ] as const,
        { concurrency: 'unbounded' },
      ).pipe(Effect.timeoutOption(CORAL_TIMEOUT_MS))

      if (Option.isNone(completed))
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: 'Coral CLI request timed out.',
        })
      }
      const [stdout, stderr, exitCode] = completed.value
      const execResult = yield* decodeCoralExecResult(stdout.trim()).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: 'Coral CLI returned an invalid JSON result envelope.',
              cause,
            }),
        ),
      )
      if (exitCode !== 0 || execResult.status !== 'completed')
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            execResult.error?.trim() ||
            (stderr.trim().length > 0
              ? `Coral CLI request failed: ${stderr.trim()}`
              : `Coral CLI request ended with status ${execResult.status}.`),
        })
      }
      if (!execResult.response.trim())
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: 'Coral returned empty text-generation output.',
        })
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))
      return yield* decodeOutput(extractJsonObject(execResult.response)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: 'Coral returned invalid structured output.',
              cause,
            }),
        ),
      )
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: 'Coral text generation failed.',
              cause,
            }),
      ),
      Effect.scoped,
    )

  const generateCommitMessage: TextGeneration.TextGeneration['Service']['generateCommitMessage'] =
    Effect.fn('CoralTextGeneration.generateCommitMessage')(function* (input)
    {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      })
      const generated = yield* runCoralJson({
        operation: 'generateCommitMessage',
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      })
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...('branch' in generated && typeof generated.branch === 'string'
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      }
    })

  const generatePrContent: TextGeneration.TextGeneration['Service']['generatePrContent'] =
    Effect.fn('CoralTextGeneration.generatePrContent')(function* (input)
    {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      })
      const generated = yield* runCoralJson({
        operation: 'generatePrContent',
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      })
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      }
    })

  const generateBranchName: TextGeneration.TextGeneration['Service']['generateBranchName'] =
    Effect.fn('CoralTextGeneration.generateBranchName')(function* (input)
    {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        includeImageContext: false,
      })
      const generated = yield* runCoralJson({
        operation: 'generateBranchName',
        cwd: input.cwd,
        prompt,
        attachments: input.attachments,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      })
      return { branch: sanitizeBranchFragment(generated.branch) }
    })

  const generateThreadTitle: TextGeneration.TextGeneration['Service']['generateThreadTitle'] =
    Effect.fn('CoralTextGeneration.generateThreadTitle')(function* (input)
    {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
        includeImageContext: false,
      })
      const generated = yield* runCoralJson({
        operation: 'generateThreadTitle',
        cwd: input.cwd,
        prompt,
        attachments: input.attachments,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      })
      return { title: sanitizeThreadTitle(generated.title) }
    })

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration['Service']
})
