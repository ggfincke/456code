// packages/cartographer-core/src/store/workingTree.ts
// live git state for shared artifact-freshness decisions

import * as NodeChildProcess from 'node:child_process'
import * as NodePath from 'node:path'
import type { WorkingTreeMeta } from '../contracts/atlasContract.js'

const TTL_MS = 2000
const GIT_TIMEOUT_MS = 1500

interface CacheEntry
{
  at: number
  state?: WorkingTreeMeta
}

// negative results are cached too so non-git roots do not fork per request
const cache = new Map<string, CacheEntry>()

function git(root: string, args: string[]): string
{
  return NodeChildProcess.execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  }).toString()
}

// root has already passed the caller's project/tool boundary
export function workingTreeState(root: string, maxAgeMs = TTL_MS): WorkingTreeMeta | undefined
{
  const cached = cache.get(root)
  const now = Date.now()
  if (cached && now - cached.at < maxAgeMs)
  {
    return cached.state
  }
  let state: WorkingTreeMeta | undefined
  try
  {
    const gitRef = git(root, ['rev-parse', '--short', 'HEAD']).trim()
    const dirty = git(root, ['status', '--porcelain']).trim().length > 0
    state = { gitRef, dirty }
  }
  catch
  {
    state = undefined
  }
  cache.set(root, {
    at: now,
    ...(state === undefined ? {} : { state }),
  })
  return state
}

// release git metadata cached for equivalent spellings of one root
export function disposeWorkingTreeCache(root: string): void
{
  const target = NodePath.resolve(root)
  for (const key of cache.keys())
  {
    if (NodePath.resolve(key) === target)
    {
      cache.delete(key)
    }
  }
}
