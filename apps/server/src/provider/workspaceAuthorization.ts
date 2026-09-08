// apps/server/src/provider/workspaceAuthorization.ts
// authorize exact provider workspace catalog paths

import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  type OrchestrationShellSnapshot,
} from '@t3tools/contracts'

export function resolveAuthorizedProviderWorkspaceCwd(input: {
  readonly cwd: string
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>
  readonly shell: Pick<OrchestrationShellSnapshot, 'projects' | 'threads'>
  readonly normalizePath: (value: string) => string
}): string | null
{
  if (!input.scopes.includes(AuthOrchestrationReadScope))
  {
    return null
  }

  const cwd = input.normalizePath(input.cwd)
  const authorizedRoots = [
    ...input.shell.projects.map((project) => project.workspaceRoot),
    ...input.shell.threads.flatMap((thread) =>
      [thread.orchestrateRunWorktreePath, thread.worktreePath].filter(
        (candidate): candidate is string => candidate !== undefined && candidate !== null,
      ),
    ),
  ]

  return authorizedRoots.some((root) => input.normalizePath(root) === cwd) ? cwd : null
}
