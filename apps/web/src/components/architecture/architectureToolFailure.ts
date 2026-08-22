// apps/web/src/components/architecture/architectureToolFailure.ts
// classifies typed architecture RPC failures for compatibility decisions

import type { ArchitectureToolErrorCode } from '@t3tools/contracts'

export function hasArchitectureToolErrorCode(
  failure: unknown,
  code: ArchitectureToolErrorCode,
): boolean
{
  return (
    typeof failure === 'object' &&
    failure !== null &&
    '_tag' in failure &&
    failure._tag === 'ArchitectureToolError' &&
    'code' in failure &&
    failure.code === code
  )
}
