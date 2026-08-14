// packages/cartographer-core/src/store/atlasIndex/digest.ts
// bind derived atlas artifacts to exact graph bytes

import * as NodeCrypto from 'node:crypto'

import type { SourceGraphDigest } from '../../contracts/types.js'

export function graphContentDigest(bytes: string | Uint8Array): SourceGraphDigest
{
  return `sha256:${NodeCrypto.createHash('sha256').update(bytes).digest('hex')}`
}
