// tests/packages/cartographer-core/helpers/trackedTempRoot.ts
// tracked synchronous temp roots w/ explicit suite-owned cleanup registration

import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

interface TrackedTempRoot
{
  create: () => string
  cleanup: () => void
}

export function trackedTempRoot(prefix: string): TrackedTempRoot
{
  const roots: string[] = []
  return {
    create: (): string =>
    {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))
      roots.push(root)
      return root
    },
    cleanup: (): void =>
    {
      for (const root of roots)
      {
        NodeFS.rmSync(root, { recursive: true, force: true })
      }
    },
  }
}
