// packages/client-runtime/src/state/workspace/composerPathSearch.ts
// manage composer path search entry state

import type { EnvironmentId } from '@t3tools/contracts'

export interface ComposerPathSearchEntry
{
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly parentPath?: string
}

export interface ComposerPathSearchState
{
  readonly entries: ReadonlyArray<ComposerPathSearchEntry>
  readonly isPending: boolean
  readonly error: string | null
}

export interface ComposerPathSearchTarget
{
  readonly environmentId: EnvironmentId | null
  readonly cwd: string | null
  readonly query: string | null
}
