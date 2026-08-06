// apps/server/src/import/parsers/acpImportRedact.ts
// redacts secrets and bounds hostile display text for ACP replay

import * as NodeBuffer from 'node:buffer'

export const replaySummaryLimit = 120
export const replayTextFieldMaxBytes = 1_048_576
export const replayCommandMaxBytes = 65_536
export const replayLocationPathMaxBytes = 4_096
export const replayToolContentItemLimit = 500
export const replayToolLocationLimit = 100
export const replayPlanEntryLimit = 1_000
export const replayWarningDetailLimit = 100
export const replayFailureMessageMaxBytes = 1_024
export const replayToolCallIdMaxBytes = 512
export const metadataFieldMaxBytes = 512
export const cwdFieldMaxBytes = 4_096
export const replayRawToolValueMaxBytes = 256 * 1024
export const replayRawToolPreviewMaxBytes = 64 * 1024
export const replayRawToolStringMaxBytes = 64 * 1024
export const replayRawToolKeyMaxBytes = 512
export const replayRawToolMaxDepth = 8
export const replayRawToolMaxNodes = 2_000
export const replayRawToolCollectionLimit = 500
export const displayNormalizationChunkCodeUnits = 4_096
export const replayNormalizedEnvelopeReserveBytes = 64 * 1_024
export const timestampedRecordJsonOverheadBytes = NodeBuffer.Buffer.byteLength(
  ',"createdAt":"2000-01-01T00:00:00.000Z"',
  'utf8',
)
export const deterministicTimelineEpochMs = Date.UTC(2000, 0, 1)
export const deterministicTimelineWindowMs = 50 * 365 * 24 * 60 * 60 * 1_000
export const textEncoder = new TextEncoder()

export function compareStrings(left: string, right: string): number
{
  return left < right ? -1 : left > right ? 1 : 0
}

export function isRecord(value: unknown): value is Record<string, unknown>
{
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function utf8CodePointByteLength(codePoint: number): number
{
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

function isUnsafeDisplayCodePoint(codePoint: number): boolean
{
  return (
    (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200e && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
}

// normalize only the retained prefix so hostile multi-megabyte fields cannot
// allocate one array entry per code point before reaching their byte ceiling
export function boundedNormalizedDisplayText(value: string, maximumBytes: number): string
{
  const byteLimit = Number.isFinite(maximumBytes) && maximumBytes > 0 ? Math.floor(maximumBytes) : 0
  if (byteLimit === 0 || value.length === 0)
  {
    return ''
  }

  const chunks: string[] = []
  let chunk = ''
  let byteCount = 0
  let sourceIndex = 0
  let truncated = false
  while (sourceIndex < value.length)
  {
    const sourceCodePoint = value.codePointAt(sourceIndex) ?? 0xfffd
    const sourceWidth = sourceCodePoint > 0xffff ? 2 : 1
    const isCarriageReturn = sourceCodePoint === 0x0d
    const nextSourceIndex =
      isCarriageReturn && value.codePointAt(sourceIndex + sourceWidth) === 0x0a
        ? sourceIndex + sourceWidth + 1
        : sourceIndex + sourceWidth
    const normalizedCodePoint = isCarriageReturn
      ? 0x0a
      : isUnsafeDisplayCodePoint(sourceCodePoint)
        ? 0xfffd
        : sourceCodePoint
    const normalizedByteLength = utf8CodePointByteLength(normalizedCodePoint)
    if (normalizedByteLength > byteLimit - byteCount)
    {
      truncated = true
      break
    }

    chunk += String.fromCodePoint(normalizedCodePoint)
    byteCount += normalizedByteLength
    sourceIndex = nextSourceIndex
    if (chunk.length >= displayNormalizationChunkCodeUnits)
    {
      chunks.push(chunk)
      chunk = ''
    }
  }
  const retained = chunks.length === 0 ? chunk : `${chunks.join('')}${chunk}`
  if (!truncated)
  {
    return retained
  }

  const suffix = '…'
  const suffixBytes = utf8CodePointByteLength(suffix.codePointAt(0) ?? 0x2026)
  if (byteLimit < suffixBytes)
  {
    return ''
  }
  const prefixBudget = byteLimit - suffixBytes
  let retainedBytes = byteCount
  let retainedCodeUnits = retained.length
  while (retainedBytes > prefixBudget && retainedCodeUnits > 0)
  {
    let codePointStart = retainedCodeUnits - 1
    const trailingCodeUnit = retained.charCodeAt(codePointStart)
    if (trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff && codePointStart > 0)
    {
      codePointStart -= 1
    }
    const codePoint = retained.codePointAt(codePointStart) ?? 0xfffd
    retainedBytes -= utf8CodePointByteLength(codePoint)
    retainedCodeUnits = codePointStart
  }
  return `${retained.slice(0, retainedCodeUnits)}${suffix}`
}

function assignmentIdentifierCharacter(value: string | undefined): boolean
{
  return value !== undefined && /[A-Za-z0-9_.-]/u.test(value)
}

function assignmentValueEnd(value: string, start: number, key: string): number
{
  if (value.startsWith('[REDACTED]', start))
  {
    return start + '[REDACTED]'.length
  }
  const bearerMatch = /^Bearer\s+\[REDACTED\]/iu.exec(value.slice(start))
  if (bearerMatch !== null)
  {
    return start + bearerMatch[0].length
  }

  const escapedQuote =
    value[start] === '\\' && (value[start + 1] === '"' || value[start + 1] === "'")
      ? value[start + 1]
      : null
  const quote = escapedQuote ?? (value[start] === '"' || value[start] === "'" ? value[start] : null)
  if (quote !== null)
  {
    let index = start + (escapedQuote === null ? 1 : 2)
    while (index < value.length)
    {
      if (escapedQuote !== null && value[index] === '\\' && value[index + 1] === quote)
      {
        return index + 2
      }
      if (escapedQuote === null && value[index] === quote && value[index - 1] !== '\\')
      {
        return index + 1
      }
      index += 1
    }
    return value.length
  }

  const normalizedKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  if (
    normalizedKey.endsWith('cookie') ||
    normalizedKey.endsWith('cookies') ||
    normalizedKey.endsWith('cookiejar')
  )
  {
    let index = start
    while (index < value.length && value[index] !== '\n')
    {
      index += 1
    }
    return index
  }
  if (normalizedKey.endsWith('authorization'))
  {
    const scheme = /^([A-Za-z][A-Za-z0-9._-]*)\s+/u.exec(value.slice(start))
    if (scheme?.[1]?.toLowerCase() === 'digest')
    {
      let index = start + scheme[0].length
      while (index < value.length && value[index] !== '\n' && value[index] !== ';')
      {
        index += 1
      }
      return index
    }
    if (scheme !== null)
    {
      let index = start + scheme[0].length
      while (index < value.length && !/[\s,;}\]]/u.test(value[index]!))
      {
        index += 1
      }
      return index
    }
  }

  let index = start
  while (index < value.length && !/[\s,;}\]]/u.test(value[index]!))
  {
    index += 1
  }
  return index
}

// redact only credential-shaped assignment keys and their immediate values
function redactSecretAssignments(value: string): string
{
  const credentialMarkerPattern =
    /api[_-]?key|private[_-]?key|access[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|secret|token|cookie|credentials?/giu
  let output = ''
  let retainedFrom = 0

  for (const marker of value.matchAll(credentialMarkerPattern))
  {
    const markerIndex = marker.index
    if (markerIndex < retainedFrom)
    {
      continue
    }
    let keyStart = markerIndex
    while (keyStart > retainedFrom && assignmentIdentifierCharacter(value[keyStart - 1]))
    {
      keyStart -= 1
    }
    let keyEnd = markerIndex + marker[0].length
    while (assignmentIdentifierCharacter(value[keyEnd]))
    {
      keyEnd += 1
    }
    const key = value.slice(keyStart, keyEnd)
    if (!rawToolKeyIsSensitive(key))
    {
      continue
    }

    let separatorIndex = keyEnd
    if (
      value[separatorIndex] === '\\' &&
      (value[separatorIndex + 1] === '"' || value[separatorIndex + 1] === "'")
    )
    {
      separatorIndex += 2
    }
    else if (value[separatorIndex] === '"' || value[separatorIndex] === "'")
    {
      separatorIndex += 1
    }
    while (/\s/u.test(value[separatorIndex] ?? ''))
    {
      separatorIndex += 1
    }
    if (value[separatorIndex] !== ':' && value[separatorIndex] !== '=')
    {
      continue
    }
    separatorIndex += 1
    while (/\s/u.test(value[separatorIndex] ?? ''))
    {
      separatorIndex += 1
    }
    const valueEnd = assignmentValueEnd(value, separatorIndex, key)
    if (valueEnd <= separatorIndex)
    {
      continue
    }

    output += `${value.slice(retainedFrom, separatorIndex)}[REDACTED]`
    retainedFrom = valueEnd
  }
  return `${output}${value.slice(retainedFrom)}`
}

export function redactDisplaySecrets(value: string): string
{
  return redactSecretAssignments(value.replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]'))
}

export function boundedReplayText(value: string, maximumBytes = replayTextFieldMaxBytes): string
{
  return boundedNormalizedDisplayText(value, maximumBytes)
}

export function boundedToolDisplayText(
  value: string,
  maximumBytes = replayTextFieldMaxBytes,
): string
{
  const bounded = boundedNormalizedDisplayText(value, maximumBytes)
  return boundedNormalizedDisplayText(redactDisplaySecrets(bounded), maximumBytes)
}

interface RawToolSanitizerState
{
  nodeCount: number
  readonly activeObjects: WeakSet<object>
}

function rawToolKeyIsSensitive(key: string): boolean
{
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return (
    normalized.endsWith('authorization') ||
    normalized === 'password' ||
    normalized === 'secret' ||
    normalized === 'token' ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('accesskey') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('secretkey') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('refreshtoken') ||
    normalized.endsWith('token') ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('cookie') ||
    normalized.endsWith('cookies') ||
    normalized.endsWith('cookiejar') ||
    normalized.endsWith('credential') ||
    normalized.endsWith('credentials')
  )
}

function uniqueRawToolKey(target: Record<string, unknown>, rawKey: string): string
{
  const base = boundedToolDisplayText(rawKey, replayRawToolKeyMaxBytes) || 'field'
  if (!Object.hasOwn(target, base))
  {
    return base
  }
  let suffix = 2
  while (Object.hasOwn(target, `${base}#${suffix}`))
  {
    suffix += 1
  }
  return `${base}#${suffix}`
}

function boundedSortedRawToolKeys(value: object): {
  readonly keys: ReadonlyArray<string>
  readonly omittedKeyCount: number
}
{
  const keys: string[] = []
  let ownKeyCount = 0
  for (const key in value)
  {
    if (!Object.hasOwn(value, key))
    {
      continue
    }
    ownKeyCount += 1
    let lower = 0
    let upper = keys.length
    while (lower < upper)
    {
      const middle = Math.floor((lower + upper) / 2)
      if (compareStrings(keys[middle]!, key) < 0)
      {
        lower = middle + 1
      }
      else
      {
        upper = middle
      }
    }
    if (keys.length < replayRawToolCollectionLimit)
    {
      keys.splice(lower, 0, key)
    }
    else if (lower < replayRawToolCollectionLimit)
    {
      keys.splice(lower, 0, key)
      keys.pop()
    }
  }
  return {
    keys,
    omittedKeyCount: Math.max(0, ownKeyCount - keys.length),
  }
}

function sanitizeRawToolValueInner(
  value: unknown,
  depth: number,
  state: RawToolSanitizerState,
): unknown
{
  if (state.nodeCount >= replayRawToolMaxNodes)
  {
    return '[TRUNCATED: node limit]'
  }
  state.nodeCount += 1

  if (value === null || typeof value === 'boolean')
  {
    return value
  }
  if (typeof value === 'string')
  {
    return boundedToolDisplayText(value, replayRawToolStringMaxBytes)
  }
  if (typeof value === 'number')
  {
    return Number.isFinite(value) ? value : `[Unsupported number: ${String(value)}]`
  }
  if (typeof value === 'bigint')
  {
    return boundedToolDisplayText(value.toString(), replayRawToolStringMaxBytes)
  }
  if (typeof value !== 'object')
  {
    return `[Unsupported ${typeof value}]`
  }
  if (state.activeObjects.has(value))
  {
    return '[Circular]'
  }

  state.activeObjects.add(value)
  try
  {
    if (Array.isArray(value))
    {
      if (depth >= replayRawToolMaxDepth)
      {
        return `[TRUNCATED: depth ${replayRawToolMaxDepth}]`
      }
      const bounded = value
        .slice(0, replayRawToolCollectionLimit)
        .map((entry) => sanitizeRawToolValueInner(entry, depth + 1, state))
      if (value.length > replayRawToolCollectionLimit)
      {
        bounded.push(`[TRUNCATED: ${value.length - replayRawToolCollectionLimit} array items]`)
      }
      return bounded
    }
    if (depth >= replayRawToolMaxDepth)
    {
      return `[TRUNCATED: depth ${replayRawToolMaxDepth}]`
    }

    const result: Record<string, unknown> = {}
    const boundedKeys = boundedSortedRawToolKeys(value)
    for (const key of boundedKeys.keys)
    {
      const outputKey = uniqueRawToolKey(result, key)
      Object.defineProperty(result, outputKey, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: rawToolKeyIsSensitive(key)
          ? '[REDACTED]'
          : sanitizeRawToolValueInner((value as Record<string, unknown>)[key], depth + 1, state),
      })
    }
    if (boundedKeys.omittedKeyCount > 0)
    {
      result[uniqueRawToolKey(result, '_t3ImportOmittedFields')] = boundedKeys.omittedKeyCount
    }
    return result
  }
  finally
  {
    state.activeObjects.delete(value)
  }
}

export function sanitizeRawToolValue(value: unknown): unknown
{
  if (value === undefined)
  {
    return undefined
  }
  const sanitized = sanitizeRawToolValueInner(value, 0, {
    nodeCount: 0,
    activeObjects: new WeakSet(),
  })
  const serialized = JSON.stringify(sanitized)
  if (
    serialized !== undefined &&
    NodeBuffer.Buffer.byteLength(serialized, 'utf8') <= replayRawToolValueMaxBytes
  )
  {
    return sanitized
  }
  return {
    _t3ImportTruncated: true,
    preview: boundedToolDisplayText(serialized ?? String(sanitized), replayRawToolPreviewMaxBytes),
  }
}

export function displayTextFromRawToolValue(value: unknown): string | undefined
{
  if (value === undefined || value === null)
  {
    return undefined
  }
  if (typeof value === 'string')
  {
    return boundedToolDisplayText(value) || undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
  {
    return boundedToolDisplayText(String(value)) || undefined
  }
  if (isRecord(value))
  {
    const chunks = ['content', 'stdout', 'stderr', 'output', 'message'].flatMap((key) =>
    {
      const candidate = value[key]
      return typeof candidate === 'string' && candidate.trim().length > 0 ? [candidate] : []
    })
    if (chunks.length > 0)
    {
      return boundedToolDisplayText(chunks.join('\n')) || undefined
    }
    if ('result' in value)
    {
      const nestedResult = displayTextFromRawToolValue(value.result)
      if (nestedResult !== undefined)
      {
        return nestedResult
      }
    }
  }
  const serialized = JSON.stringify(value)
  return serialized === undefined ? undefined : boundedToolDisplayText(serialized) || undefined
}
