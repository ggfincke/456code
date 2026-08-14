// packages/cartographer-core/src/store/cursorCodec.ts
// shared tamper-evident cursor envelope codec (sha256 signature + base64url json)

import * as NodeCrypto from 'node:crypto'

// sha256 over NUL-joined parts -> base64url -> 18-char signature
export function hashSignature(parts: string[]): string
{
  return NodeCrypto.createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('base64url')
    .slice(0, 18)
}

export function encodeCursorEnvelope<T>(payload: T): string
{
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

// validate charset + canonical base64url round-trip, then JSON-parse
// returns undefined on any failure so call sites throw their own error type
export function decodeCursorEnvelope<T>(cursor: string): Partial<T> | undefined
{
  if (!/^[A-Za-z0-9_-]+$/.test(cursor))
  {
    return undefined
  }
  const decoded = Buffer.from(cursor, 'base64url')
  if (decoded.toString('base64url') !== cursor)
  {
    return undefined
  }
  let parsed: unknown
  try
  {
    parsed = JSON.parse(decoded.toString('utf-8'))
  }
  catch
  {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null)
  {
    return undefined
  }
  return parsed as Partial<T>
}
