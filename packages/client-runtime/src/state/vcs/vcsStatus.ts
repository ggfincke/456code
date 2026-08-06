// packages/client-runtime/src/state/vcs/vcsStatus.ts
// manage vcs status target state

import type { EnvironmentId } from '@t3tools/contracts'

export interface VcsStatusTarget
{
  readonly environmentId: EnvironmentId | null
  readonly cwd: string | null
}
