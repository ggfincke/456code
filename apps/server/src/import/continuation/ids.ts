// apps/server/src/import/continuation/ids.ts
// derives stable identifiers for imported transcript entities

import * as NodeCrypto from 'node:crypto'

function uuidBytes(seed: string): Buffer
{
  const bytes = NodeCrypto.createHash('sha256').update(seed).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return bytes
}

export function deterministicId(
  namespaceSeed: string,
  ...parts: ReadonlyArray<string | number>
): string
{
  const bytes = uuidBytes([namespaceSeed, ...parts.map(String)].join('\u0000'))
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function deterministicSortableMessageId(
  contentHash: string,
  role: string,
  recordIndex: number,
): string
{
  const prefix = String(recordIndex).padStart(8, '0')
  const digest = NodeCrypto.createHash('sha256')
    .update(`${contentHash}|${role}|${recordIndex}`)
    .digest('hex')
    .slice(0, 16)
  return `imp-${prefix}-${digest}`
}
