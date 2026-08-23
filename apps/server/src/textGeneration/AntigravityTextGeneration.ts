// apps/server/src/textGeneration/AntigravityTextGeneration.ts
// generate structured text through one-shot antigravity json output

import type { AntigravitySettings, ModelSelection } from '@t3tools/contracts'
import { TextGenerationError } from '@t3tools/contracts'
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from '@t3tools/shared/git'
import { extractJsonObject } from '@t3tools/shared/schemaJson'
import { resolveSpawnCommand } from '@t3tools/shared/shell'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { buildAntigravityOneShotArgs } from '../provider/antigravity/AntigravityCli.ts'
import * as TextGeneration from './TextGeneration.ts'
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from './TextGenerationPrompts.ts'
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from './TextGenerationUtils.ts'
import { collectUint8StreamText } from '../stream/collectUint8StreamText.ts'

const AntigravityHeadlessResult = Schema.Struct({
  conversation_id: Schema.String,
  status: Schema.String,
  response: Schema.String,
  error: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeHeadlessResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AntigravityHeadlessResult),
)
const isTextGenerationError = Schema.is(TextGenerationError)
const MAX_STDOUT_BYTES = 2 * 1024 * 1024
const MAX_STDERR_BYTES = 128 * 1024
const CHILD_TERMINATION_TIMEOUT = '2 seconds' as const

export const makeAntigravityTextGeneration = Effect.fn('makeAntigravityTextGeneration')(function* (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
)
{
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const readBoundedOutput = <E>(
    operation: TextGeneration.TextGenerationOp,
    stream: Stream.Stream<Uint8Array, E>,
    maxBytes: number,
    streamName: 'stdout' | 'stderr',
  ): Effect.Effect<string, TextGenerationError> =>
    collectUint8StreamText({ stream, maxBytes }).pipe(
      Effect.mapError((cause) =>
        normalizeCliError('agy', operation, cause, `Failed to collect Antigravity ${streamName}.`),
      ),
      Effect.flatMap((collected) =>
        collected.truncated
          ? Effect.fail(
              new TextGenerationError({
                operation,
                detail: `Antigravity ${streamName} exceeded the ${maxBytes}-byte limit.`,
              }),
            )
          : Effect.succeed(collected.text),
      ),
    )

  const runJson = <S extends Schema.Top>(input: {
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
          detail: 'Antigravity text generation supports text input only.',
        })
      }
      const args = buildAntigravityOneShotArgs({
        prompt: input.prompt,
        model: input.modelSelection.model,
        sandbox: settings.sandbox,
      })
      const command = settings.binaryPath || 'agy'
      const resolved = yield* resolveSpawnCommand(command, args, { env: environment })
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: input.cwd,
            env: environment,
            shell: resolved.shell,
            stdin: 'ignore',
            forceKillAfter: CHILD_TERMINATION_TIMEOUT,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError('agy', input.operation, cause, 'Failed to spawn Antigravity CLI.'),
          ),
        )
      const terminateChild = Effect.uninterruptible(
        Effect.gen(function* ()
        {
          const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false))
          if (!running) return
          yield* child
            .kill({ killSignal: 'SIGTERM', forceKillAfter: CHILD_TERMINATION_TIMEOUT })
            .pipe(Effect.ignore)
          const exited = yield* child.exitCode.pipe(Effect.timeoutOption(CHILD_TERMINATION_TIMEOUT))
          if (exited._tag === 'None')
          {
            yield* child
              .kill({ killSignal: 'SIGKILL', forceKillAfter: CHILD_TERMINATION_TIMEOUT })
              .pipe(Effect.ignore)
            yield* child.exitCode.pipe(
              Effect.timeoutOption(CHILD_TERMINATION_TIMEOUT),
              Effect.ignore,
            )
          }
        }),
      ).pipe(Effect.ignoreCause)
      const completed = yield* Effect.all(
        [
          readBoundedOutput(input.operation, child.stdout, MAX_STDOUT_BYTES, 'stdout'),
          readBoundedOutput(input.operation, child.stderr, MAX_STDERR_BYTES, 'stderr'),
          child.exitCode.pipe(Effect.map(Number)),
        ] as const,
        { concurrency: 'unbounded' },
      ).pipe(Effect.timeoutOption('3 minutes'), Effect.ensuring(terminateChild))
      if (Option.isNone(completed))
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: 'Antigravity CLI request timed out.',
        })
      }
      const [stdout, stderr, exitCode] = completed.value
      const parsed = yield* decodeHeadlessResult(extractJsonObject(stdout)).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: 'Antigravity returned an invalid terminal JSON envelope.',
              cause,
            }),
        ),
      )
      if (exitCode !== 0)
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            parsed.error?.trim() ||
            stderr.trim() ||
            `Antigravity CLI exited with status ${exitCode}.`,
        })
      }
      if (parsed.status !== 'SUCCESS')
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            parsed.error?.trim() || `Antigravity returned terminal status '${parsed.status}'.`,
        })
      }
      const response = parsed.response.trim()
      if (!response)
      {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: 'Antigravity returned empty text-generation output.',
        })
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
        extractJsonObject(response),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: 'Antigravity returned invalid structured output.',
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
              detail: 'Antigravity text generation failed.',
              cause,
            }),
      ),
      Effect.scoped,
    )

  const generateCommitMessage: TextGeneration.TextGeneration['Service']['generateCommitMessage'] =
    Effect.fn('AntigravityTextGeneration.generateCommitMessage')(function* (input)
    {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      })
      const generated = yield* runJson({
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
    Effect.fn('AntigravityTextGeneration.generatePrContent')(function* (input)
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
      const generated = yield* runJson({
        operation: 'generatePrContent',
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      })
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() }
    })

  const generateBranchName: TextGeneration.TextGeneration['Service']['generateBranchName'] =
    Effect.fn('AntigravityTextGeneration.generateBranchName')(function* (input)
    {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        includeImageContext: false,
      })
      const generated = yield* runJson({
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
    Effect.fn('AntigravityTextGeneration.generateThreadTitle')(function* (input)
    {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
        includeImageContext: false,
      })
      const generated = yield* runJson({
        operation: 'generateThreadTitle',
        cwd: input.cwd,
        prompt,
        attachments: input.attachments,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      })
      return { title: sanitizeThreadTitle(generated.title) }
    })

  return { generateCommitMessage, generatePrContent, generateBranchName, generateThreadTitle }
})
