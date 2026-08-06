// apps/server/src/textGeneration/TextGenerationUtils.ts
// share server text generation utils

import { TextGenerationError, type ChatAttachment } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import type * as EffectAcpSchema from 'effect-acp/schema'

import { resolveAttachmentPath } from '../attachmentStore.ts'
import type { TextGenerationOp } from './TextGeneration.ts'

const isTextGenerationError = Schema.is(TextGenerationError)

// convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present.
export function toJsonSchemaObject(schema: Schema.Top): unknown
{
  const document = Schema.toJsonSchemaDocument(schema)
  if (document.definitions && Object.keys(document.definitions).length > 0)
  {
    return { ...document.schema, $defs: document.definitions }
  }
  return document.schema
}

// truncate a text section to `maxChars`, appending a `[truncated]` marker when needed.
export function limitSection(value: string, maxChars: number): string
{
  if (value.length <= maxChars) return value
  const truncated = value.slice(0, maxChars)
  return `${truncated}\n\n[truncated]`
}

// normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period.
export function sanitizeCommitSubject(raw: string): string
{
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? ''
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, '').trim()
  if (withoutTrailingPeriod.length === 0)
  {
    return 'Update project files'
  }

  if (withoutTrailingPeriod.length <= 72)
  {
    return withoutTrailingPeriod
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd()
}

// normalise a raw PR title to a single line with a sensible fallback.
export function sanitizePrTitle(raw: string): string
{
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? ''
  if (singleLine.length > 0)
  {
    return singleLine
  }
  return 'Update project changes'
}

// normalise a raw thread title to a compact single-line sidebar-safe label.
export function sanitizeThreadTitle(raw: string): string
{
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ')

  if (!normalized || normalized.trim().length === 0)
  {
    return 'New thread'
  }

  if (normalized.length <= 50)
  {
    return normalized
  }

  return `${normalized.slice(0, 47).trimEnd()}...`
}

// CLI name to human-readable label, e.g. "codex" -> "Codex CLI (`codex`)"
function cliLabel(cliName: string): string
{
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1)
  return `${capitalized} CLI (\`${cliName}\`)`
}

// normalize an unknown error from a CLI text generation process into a
// typed `TextGenerationError`. Parameterized by CLI name so both Codex
// and Claude (and future providers) can share the same logic.
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError
{
  if (isTextGenerationError(error))
  {
    return error
  }

  if (error instanceof Error)
  {
    const lower = error.message.toLowerCase()
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes('enoent')
    )
    {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      })
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    })
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  })
}

export function readCliStreamAsString<E>(
  cliName: string,
  operation: TextGenerationOp,
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, TextGenerationError>
{
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => '',
      (acc, chunk) => acc + chunk,
    ),
    Effect.mapError((cause) =>
      normalizeCliError(cliName, operation, cause, 'Failed to collect process output'),
    ),
  )
}

export const buildAcpImagePromptParts = Effect.fn('buildAcpImagePromptParts')(function* (input: {
  readonly operation: TextGenerationOp
  readonly providerLabel: string
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined
  readonly attachmentsDir: string
  readonly fileSystem: FileSystem.FileSystem
})
{
  const parts: Array<EffectAcpSchema.ContentBlock> = []
  for (const attachment of input.attachments ?? [])
  {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    })
    if (!attachmentPath)
    {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: `Invalid ${input.providerLabel} image attachment id '${attachment.id}'.`,
      })
    }

    const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `Failed to read ${input.providerLabel} image attachment.`,
            cause,
          }),
      ),
    )
    parts.push({
      type: 'image',
      data: Buffer.from(bytes).toString('base64'),
      mimeType: attachment.mimeType,
    })
  }
  return parts
})
