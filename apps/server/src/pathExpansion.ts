// apps/server/src/pathExpansion.ts
// expand home path

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

// expand a leading `~` (or `~/…`, `~\…`) in a user-supplied path to the
// current user's home directory. Spawned processes don't get shell
// expansion, so env vars like `CODEX_HOME=~/.codex-work` would be passed
// verbatim and treated as relative paths by the receiver.
//
// matches the behavior of the other `expandHomePath` helpers in the
// workspace layers and CLI bootstrap: `~` alone and both `~/` and `~\`
// separators are handled. Returns the input unchanged if it doesn't
// start with `~` or is empty. Does not handle `~user` (other-user)
// expansion.
export function expandHomePath(value: string): string
{
  if (!value) return value
  if (value === '~') return NodeOS.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\'))
  {
    return NodePath.join(NodeOS.homedir(), value.slice(2))
  }
  return value
}
