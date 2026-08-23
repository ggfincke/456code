// apps/server/src/provider/antigravity/AntigravityCli.ts
// define the closed antigravity headless cli boundary

import { NonNegativeInt, TrimmedNonEmptyString } from '@t3tools/contracts'
import { extractJsonObject } from '@t3tools/shared/schemaJson'
import { compareSemverVersions } from '@t3tools/shared/semver'
import * as Schema from 'effect/Schema'

export const ANTIGRAVITY_MINIMUM_VERSION = '1.1.15'
export const ANTIGRAVITY_PROVIDER = 'antigravity' as const
export const ANTIGRAVITY_RESUME_CURSOR_VERSION = 2 as const
export const ANTIGRAVITY_DEFAULT_MODEL = 'default'

export type AntigravityRuntimeMode = 'auto-accept-edits' | 'full-access'

export const AntigravityResumeBinding = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  executable: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  agent: Schema.String,
  runtimeMode: Schema.Literals(['auto-accept-edits', 'full-access']),
  sandbox: Schema.Boolean,
})
export type AntigravityResumeBinding = typeof AntigravityResumeBinding.Type

export const AntigravityResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(ANTIGRAVITY_RESUME_CURSOR_VERSION),
  conversationId: TrimmedNonEmptyString,
  binding: AntigravityResumeBinding,
  cumulativeUsage: Schema.optional(
    Schema.Struct({
      input: Schema.optional(NonNegativeInt),
      cached: Schema.optional(NonNegativeInt),
      output: Schema.optional(NonNegativeInt),
      reasoning: Schema.optional(NonNegativeInt),
      total: Schema.optional(NonNegativeInt),
      durationMs: Schema.optional(NonNegativeInt),
      turns: Schema.optional(NonNegativeInt),
    }),
  ),
})
export type AntigravityResumeCursor = typeof AntigravityResumeCursor.Type

export interface AntigravityLaunchInput
{
  readonly conversationId?: string
  readonly model?: string
  readonly agent?: string
  readonly runtimeMode: AntigravityRuntimeMode
  readonly sandbox: boolean
}

export interface AntigravityOneShotInput
{
  readonly prompt: string
  readonly model?: string
  readonly sandbox: boolean
}

export type AntigravityStreamMessage =
  | { readonly kind: 'init'; readonly value: Record<string, unknown> }
  | { readonly kind: 'step_update'; readonly value: Record<string, unknown> }
  | { readonly kind: 'result'; readonly value: Record<string, unknown> }

export type AntigravityStreamLine =
  | { readonly kind: 'known'; readonly message: AntigravityStreamMessage }
  | { readonly kind: 'unknown'; readonly event: string }
  | { readonly kind: 'malformed'; readonly detail: string }

const KNOWN_EVENTS = new Set(['init', 'step_update', 'result'])

const STEP_STATES = new Set(['ACTIVE', 'DONE'])

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function compareAntigravityVersions(left: string, right: string): number
{
  return compareSemverVersions(left, right)
}

export function isAntigravityVersionSupported(version: string | null | undefined): boolean
{
  return version !== null && version !== undefined
    ? compareAntigravityVersions(version, ANTIGRAVITY_MINIMUM_VERSION) >= 0
    : false
}

export function buildAntigravityLaunchArgs(input: AntigravityLaunchInput): ReadonlyArray<string>
{
  const args: Array<string> = []
  if (input.conversationId) args.push('--conversation', input.conversationId)
  if (input.model && input.model !== ANTIGRAVITY_DEFAULT_MODEL) args.push('--model', input.model)
  if (input.agent) args.push('--agent', input.agent)
  if (input.runtimeMode === 'auto-accept-edits') args.push('--mode', 'accept-edits')
  if (input.runtimeMode === 'full-access') args.push('--dangerously-skip-permissions')
  if (input.sandbox) args.push('--sandbox')
  args.push('--input-format', 'stream-json', '--output-format', 'stream-json')
  return args
}

export function buildAntigravityOneShotArgs(input: AntigravityOneShotInput): ReadonlyArray<string>
{
  const args: Array<string> = ['-p', input.prompt, '--output-format', 'json']
  if (input.model && input.model !== ANTIGRAVITY_DEFAULT_MODEL) args.push('--model', input.model)
  if (input.sandbox) args.push('--sandbox')
  return args
}

function optionalFieldHasType(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
): boolean
{
  return value[key] === undefined || predicate(value[key])
}

function isNonNegativeInteger(value: unknown): boolean
{
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isNonNegativeFiniteNumber(value: unknown): boolean
{
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isUsage(value: unknown): boolean
{
  if (!isRecord(value)) return false
  return [
    'input_tokens',
    'output_tokens',
    'thinking_tokens',
    'cache_read_tokens',
    'total_tokens',
  ].every((key) => optionalFieldHasType(value, key, isNonNegativeInteger))
}

function malformedKnownEvent(event: string, detail: string): AntigravityStreamLine
{
  return { kind: 'malformed', detail: `Malformed Antigravity ${event} event: ${detail}` }
}

export function parseAntigravityStreamLine(line: string): AntigravityStreamLine
{
  let value: unknown
  try
  {
    value = JSON.parse(line)
  }
  catch (cause)
  {
    return {
      kind: 'malformed',
      detail: cause instanceof Error ? cause.message : 'Invalid JSON stream line.',
    }
  }

  if (!isRecord(value) || typeof value.event !== 'string')
  {
    return { kind: 'malformed', detail: 'Stream event must contain a string event field.' }
  }
  if (!KNOWN_EVENTS.has(value.event)) return { kind: 'unknown', event: value.event }

  if (value.event === 'init')
  {
    if (typeof value.conversation_id !== 'string' || value.conversation_id.trim().length === 0)
    {
      return malformedKnownEvent('init', 'conversation_id must be a non-empty string.')
    }
    if (!isRecord(value.init)) return malformedKnownEvent('init', 'init must be an object.')
    if (!optionalFieldHasType(value.init, 'cwd', (candidate) => typeof candidate === 'string'))
    {
      return malformedKnownEvent('init', 'cwd must be a string.')
    }
    if (
      !optionalFieldHasType(
        value.init,
        'tools',
        (candidate) =>
          Array.isArray(candidate) && candidate.every((tool) => typeof tool === 'string'),
      )
    )
    {
      return malformedKnownEvent('init', 'tools must be an array of strings.')
    }
    for (const key of ['permission_mode', 'model', 'agent'] as const)
    {
      if (!optionalFieldHasType(value.init, key, (candidate) => typeof candidate === 'string'))
      {
        return malformedKnownEvent('init', `${key} must be a string.`)
      }
    }
  }
  else if (value.event === 'step_update')
  {
    if (!isRecord(value.step_update))
    {
      return malformedKnownEvent('step_update', 'step_update must be an object.')
    }
    const step = value.step_update
    if (typeof step.conversation_id !== 'string' || step.conversation_id.trim().length === 0)
    {
      return malformedKnownEvent('step_update', 'conversation_id must be a non-empty string.')
    }
    if (!isNonNegativeInteger(step.step_index))
    {
      return malformedKnownEvent('step_update', 'step_index must be a non-negative integer.')
    }
    if (typeof step.state !== 'string' || !STEP_STATES.has(step.state))
    {
      return malformedKnownEvent('step_update', 'state must be ACTIVE or DONE.')
    }
    if (typeof step.step_type !== 'string' || step.step_type.trim().length === 0)
    {
      return malformedKnownEvent('step_update', 'step_type must be a non-empty string.')
    }
    if (!optionalFieldHasType(step, 'text_delta', (candidate) => typeof candidate === 'string'))
    {
      return malformedKnownEvent('step_update', 'text_delta must be a string.')
    }
    for (const key of ['tool_info', 'subagent_info'] as const)
    {
      if (!optionalFieldHasType(step, key, isRecord))
      {
        return malformedKnownEvent('step_update', `${key} must be an object.`)
      }
    }
    if (!optionalFieldHasType(step, 'duration_seconds', isNonNegativeFiniteNumber))
    {
      return malformedKnownEvent('step_update', 'duration_seconds must be a non-negative number.')
    }
    if (!optionalFieldHasType(step, 'usage', isUsage))
    {
      return malformedKnownEvent('step_update', 'usage must contain non-negative integer counters.')
    }
  }
  else
  {
    if (!isRecord(value.result)) return malformedKnownEvent('result', 'result must be an object.')
    const result = value.result
    if (typeof result.status !== 'string' || result.status.trim().length === 0)
    {
      return malformedKnownEvent('result', 'status must be a non-empty string.')
    }
    const allowsMissingConversationId = result.status === 'ERROR' || result.status === 'INVALID'
    if (
      !allowsMissingConversationId &&
      (typeof result.conversation_id !== 'string' || result.conversation_id.trim().length === 0)
    )
    {
      return malformedKnownEvent('result', 'conversation_id must be a non-empty string.')
    }
    if (result.conversation_id !== undefined && typeof result.conversation_id !== 'string')
    {
      return malformedKnownEvent('result', 'conversation_id must be a string when present.')
    }
    if (typeof result.response !== 'string')
    {
      return malformedKnownEvent('result', 'response must be a string.')
    }
    if (!optionalFieldHasType(result, 'error', (candidate) => typeof candidate === 'string'))
    {
      return malformedKnownEvent('result', 'error must be a string.')
    }
    if (!optionalFieldHasType(result, 'usage', isRecord))
    {
      return malformedKnownEvent('result', 'usage must be an object.')
    }
    if (!optionalFieldHasType(result, 'usage', isUsage))
    {
      return malformedKnownEvent('result', 'usage must contain non-negative integer counters.')
    }
    if (!optionalFieldHasType(result, 'duration_seconds', isNonNegativeFiniteNumber))
    {
      return malformedKnownEvent('result', 'duration_seconds must be a non-negative number.')
    }
    if (!optionalFieldHasType(result, 'num_turns', isNonNegativeInteger))
    {
      return malformedKnownEvent('result', 'num_turns must be a non-negative integer.')
    }
  }
  return {
    kind: 'known',
    message: { kind: value.event, value } as AntigravityStreamMessage,
  }
}

function discoveryEntries(
  value: unknown,
  field: 'models' | 'agents',
): ReadonlyArray<unknown> | undefined
{
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return undefined
  if (Array.isArray(value[field])) return value[field]
  const command = value.command
  if (!isRecord(command) || !isRecord(command.data)) return undefined
  return Array.isArray(command.data[field]) ? command.data[field] : undefined
}

function discoveryValues(
  value: unknown,
  field: 'models' | 'agents',
): ReadonlyArray<string> | undefined
{
  const entries = discoveryEntries(value, field)
  if (entries === undefined) return undefined
  const seen = new Set<string>()
  const result: Array<string> = []
  for (const entry of entries)
  {
    const candidate =
      typeof entry === 'string'
        ? entry
        : isRecord(entry)
          ? [entry.id, entry.slug, entry.name].find(
              (part): part is string => typeof part === 'string',
            )
          : undefined
    const trimmed = candidate?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function parseAntigravityDiscoveryOutput(
  output: string,
  field: 'models' | 'agents',
): ReadonlyArray<string> | undefined
{
  try
  {
    return discoveryValues(JSON.parse(extractJsonObject(output)), field)
  }
  catch
  {
    return undefined
  }
}

export function conversationIdFromStreamMessage(
  message: Record<string, unknown>,
): string | undefined
{
  const direct = message.conversation_id
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const nested = message.result
  if (
    isRecord(nested) &&
    typeof nested.conversation_id === 'string' &&
    nested.conversation_id.trim()
  )
  {
    return nested.conversation_id.trim()
  }
  return undefined
}

export function resultResponseFromStreamMessage(message: Record<string, unknown>): string
{
  const result = isRecord(message.result) ? message.result : message
  return typeof result.response === 'string' ? result.response : ''
}

export function resultStatusFromStreamMessage(message: Record<string, unknown>): string
{
  const result = isRecord(message.result) ? message.result : message
  return typeof result.status === 'string' ? result.status : 'ERROR'
}

export function resultErrorFromStreamMessage(message: Record<string, unknown>): string | undefined
{
  const result = isRecord(message.result) ? message.result : message
  return typeof result.error === 'string' ? result.error : undefined
}
