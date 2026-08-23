// apps/server/src/textGeneration/GeminiTextGeneration.ts
// generate source-control text through a no-tool gemini-cli headless run

import type { GeminiSettings, ModelSelection } from '@t3tools/contracts'
import { TextGenerationError } from '@t3tools/contracts'
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from '@t3tools/shared/git'
import { extractJsonObject } from '@t3tools/shared/schemaJson'
import { resolveSpawnCommand } from '@t3tools/shared/shell'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { buildGeminiAcpEnvironment } from '../provider/acp/GeminiAcpSupport.ts'
import type { GEMINI_API_KEY_ENV, GOOGLE_API_KEY_ENV } from '../provider/acp/GeminiAcpSupport.ts'
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

const GEMINI_TIMEOUT_MS = 180_000

const GeminiHeadlessResult = Schema.Struct({
  // gemini-cli's `--output-format json` envelope carries the model text here.
  response: Schema.optional(Schema.String),
})
const decodeGeminiHeadlessResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GeminiHeadlessResult),
)

const isTextGenerationError = Schema.is(TextGenerationError)

export const makeGeminiTextGeneration = Effect.fn('makeGeminiTextGeneration')(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    readonly apiKeyConfigured?: boolean
    readonly explicitlyConfiguredApiKeyNames?: ReadonlySet<
      typeof GEMINI_API_KEY_ENV | typeof GOOGLE_API_KEY_ENV
    >
  } = {},
)
{
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const runtimeEnvironment = buildGeminiAcpEnvironment(environment, {
    apiKeyConfigured: options.apiKeyConfigured === true,
    ...(options.explicitlyConfiguredApiKeyNames === undefined
      ? {}
      : { explicitlyConfiguredApiKeyNames: options.explicitlyConfiguredApiKeyNames }),
  })

  const runGeminiJson = <S extends Schema.Top>(input: {
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
          detail: 'Gemini text generation does not support attachments yet.',
        })
      }

      const command = geminiSettings.binaryPath || 'gemini'
      const spawnCommand = yield* resolveSpawnCommand(
        command,
        [
          '--prompt',
          input.prompt,
          '--model',
          input.modelSelection.model,
          '--output-format',
          'json',
        ],
        { env: runtimeEnvironment, extendEnv: false },
      )
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: input.cwd,
            env: runtimeEnvironment,
            extendEnv: false,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              'gemini',
              input.operation,
              cause,
              'Failed to spawn the Gemini CLI process.',
            ),
          ),
        )

      const completed = yield* Effect.all(
        [
          readCliStreamAsString('gemini', input.operation, child.stdout),
          readCliStreamAsString('gemini', input.operation, child.stderr),
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError((cause) =>
              normalizeCliError(
                'gemini',
                input.operation,
                cause,
                'Failed to read the Gemini CLI exit code.',
              ),
            ),
          ),
        ] as const,
        { concurrency: 'unbounded' },
      ).pipe(Effect.timeoutOption(GEMINI_TIMEOUT_MS))

      if (Option.isNone(completed))
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: 'Gemini CLI request timed out.',
        })
      }
      const [stdout, stderr, exitCode] = completed.value
      if (exitCode !== 0)
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            stderr.trim().length > 0
              ? `Gemini CLI request failed: ${stderr.trim()}`
              : `Gemini CLI request exited with status ${exitCode}.`,
        })
      }
      // tolerate installs that ignore `--output-format json` and print raw text.
      const parsed = yield* decodeGeminiHeadlessResult(stdout.trim()).pipe(Effect.option)
      const response =
        (parsed._tag === 'Some' ? parsed.value.response : undefined)?.trim() || stdout.trim()
      if (!response)
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: 'Gemini returned empty text-generation output.',
        })
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))
      return yield* decodeOutput(extractJsonObject(response)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: 'Gemini returned invalid structured output.',
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
              detail: 'Gemini text generation failed.',
              cause,
            }),
      ),
      Effect.scoped,
    )

  const generateCommitMessage: TextGeneration.TextGeneration['Service']['generateCommitMessage'] =
    Effect.fn('GeminiTextGeneration.generateCommitMessage')(function* (input)
    {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      })
      const generated = yield* runGeminiJson({
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
    Effect.fn('GeminiTextGeneration.generatePrContent')(function* (input)
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
      const generated = yield* runGeminiJson({
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
    Effect.fn('GeminiTextGeneration.generateBranchName')(function* (input)
    {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        includeImageContext: false,
      })
      const generated = yield* runGeminiJson({
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
    Effect.fn('GeminiTextGeneration.generateThreadTitle')(function* (input)
    {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
        includeImageContext: false,
      })
      const generated = yield* runGeminiJson({
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
