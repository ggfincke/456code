// tests/packages/cartographer-core/store/artifactCacheDisposal.test.ts
// verifies architecture artifact cleanup evicts every retained in-process cache

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'
import {
  PATCH_SCHEMA_VERSION,
  type GraphPatch,
} from '../../../../packages/cartographer-core/src/analyze/patch.ts'
import {
  GRAPH_SCHEMA_VERSION,
  type CartographerGraph,
} from '../../../../packages/cartographer-core/src/contracts/types.ts'
import { disposeAtlasArtifacts } from '../../../../packages/cartographer-core/src/store/disposeAtlasArtifacts.ts'
import { ensureAtlasIndex } from '../../../../packages/cartographer-core/src/store/atlasIndex.ts'
import { saveGraph } from '../../../../packages/cartographer-core/src/store/index.ts'
import {
  listPatchPage,
  savePatch,
} from '../../../../packages/cartographer-core/src/store/patches.ts'
import { workingTreeState } from '../../../../packages/cartographer-core/src/store/workingTree.ts'
import { trackedTempRoot } from '../helpers/trackedTempRoot.ts'

const tempRoots = trackedTempRoot('carto-artifact-cache-')

afterAll(tempRoots.cleanup)

function graph(root: string): CartographerGraph
{
  return {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: root,
    mode: 'imports',
    generatedAt: '2026-08-07T00:00:00.000Z',
    scope: 'src',
    nodes: [{ id: 'src/index.ts', kind: 'file', label: 'index.ts', group: 'src' }],
    edges: [],
    groups: [{ id: 'src', label: 'src', fileCount: 1 }],
    metrics: { cycles: 0, orphans: 1, maxFanIn: 0, maxFanOut: 0 },
  }
}

describe('architecture artifact cache disposal', () =>
{
  it('evicts index, working-tree, and patch-catalog cache entries', async () =>
  {
    const root = tempRoots.create()
    saveGraph(graph(root), root)
    ensureAtlasIndex(root, undefined, { immutableArtifacts: true })
    expect(workingTreeState(root, Number.POSITIVE_INFINITY)).toBeUndefined()
    NodeFS.writeFileSync(NodePath.join(root, '.gitignore'), '.cartographer/\n')
    NodeChildProcess.execFileSync('git', ['-C', root, 'init', '-q'])
    NodeChildProcess.execFileSync('git', ['-C', root, 'config', 'user.email', 'cache@test.invalid'])
    NodeChildProcess.execFileSync('git', ['-C', root, 'config', 'user.name', 'Cache Test'])
    NodeChildProcess.execFileSync('git', ['-C', root, 'add', '-A'])
    NodeChildProcess.execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'])

    const patch: GraphPatch = {
      version: PATCH_SCHEMA_VERSION,
      meta: { name: 'cached patch', createdAt: '2026-08-07T00:00:00.000Z' },
      ops: [{ op: 'add_file', path: 'src/new.ts' }],
    }
    savePatch(root, patch)
    savePatch(root, { ...patch, meta: { ...patch.meta, name: 'second patch' } })
    const firstPage = listPatchPage(root, 1)
    NodeFS.rmSync(NodePath.join(root, '.cartographer', 'patches'), { recursive: true })
    const indexPath = NodePath.join(root, '.cartographer', 'atlas-index.json')
    NodeFS.chmodSync(indexPath, 0o000)

    expect(ensureAtlasIndex(root, undefined, { immutableArtifacts: true })).toBeDefined()
    expect(workingTreeState(root, Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(listPatchPage(root, 1, firstPage.nextCursor).patches).toHaveLength(1)

    await disposeAtlasArtifacts(root)

    expect(() => ensureAtlasIndex(root, undefined, { immutableArtifacts: true })).toThrow(
      /prepared atlas index is missing, stale, or corrupt/,
    )
    expect(workingTreeState(root, Number.POSITIVE_INFINITY)).toMatchObject({ dirty: false })
    expect(() => listPatchPage(root, 1, firstPage.nextCursor)).toThrow(/cursor is stale/)
  })
})
