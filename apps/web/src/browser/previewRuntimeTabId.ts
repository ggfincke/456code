// apps/web/src/browser/previewRuntimeTabId.ts
// derive desktop-scoped preview tab identity

import type { ScopedThreadRef } from '@t3tools/contracts'

export function previewRuntimeTabId(
  threadRef: ScopedThreadRef,
  serverEpoch: string | null,
  serverTabId: string,
): string
{
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, serverEpoch, serverTabId])
}
