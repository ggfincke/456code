// apps/server/src/vcs/ExactGitCacheMaterialization.ts
// stages exact trees before publishing them into server-owned worktree caches

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import {
  type ExactGitSnapshotLimits,
  ExactGitSnapshotError,
  type ExactGitTreeMaterialization,
  materializeExactGitTree,
} from './ExactGitSnapshot.ts'
import { runGit } from './ExactGitSnapshotGit.ts'

export interface MaterializeExactGitTreeIntoCacheInput
{
  readonly repositoryRoot: string
  readonly treeOid: string
  readonly cacheRoot: string
  readonly destinationRoot: string
  readonly signal: AbortSignal
  readonly limits?: ExactGitSnapshotLimits
}

function isWithin(root: string, candidate: string): boolean
{
  const relative = NodePath.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  )
}

async function canonicalEmptyDirectory(path: string, label: string): Promise<string>
{
  if (!NodePath.isAbsolute(path))
  {
    throw new ExactGitSnapshotError('invalid-input', `${label} must be an absolute path.`)
  }
  const stat = await NodeFSP.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
  {
    throw new ExactGitSnapshotError('invalid-input', `${label} must be a real directory.`)
  }
  const canonical = await NodeFSP.realpath(path)
  if ((await NodeFSP.readdir(canonical)).length > 0)
  {
    throw new ExactGitSnapshotError('invalid-input', `${label} must be empty.`)
  }
  return canonical
}

async function publishStagedTree(stagedRoot: string, destinationRoot: string): Promise<void>
{
  await NodeFSP.rmdir(destinationRoot)
  try
  {
    await NodeFSP.rename(stagedRoot, destinationRoot)
  }
  catch (cause)
  {
    if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EXDEV') throw cause
    await NodeFSP.mkdir(destinationRoot)
    await NodeFSP.cp(stagedRoot, destinationRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
  }
}

// in-repository dev homes stage externally so git-derived paths never write into the worktree;
// the completed tree is published only after exact materialization succeeds
export async function materializeExactGitTreeIntoCache(
  input: MaterializeExactGitTreeIntoCacheInput,
): Promise<ExactGitTreeMaterialization>
{
  const repositoryRoot = await NodeFSP.realpath(input.repositoryRoot)
  const cacheRoot = await NodeFSP.realpath(input.cacheRoot)
  const destinationRoot = await canonicalEmptyDirectory(
    input.destinationRoot,
    'Cache materialization destination',
  )
  if (destinationRoot === cacheRoot || !isWithin(cacheRoot, destinationRoot))
  {
    throw new ExactGitSnapshotError(
      'invalid-input',
      'Cache materialization destination must be inside its owned cache root.',
    )
  }
  if (!isWithin(repositoryRoot, destinationRoot))
  {
    return materializeExactGitTree({
      repositoryRoot,
      treeOid: input.treeOid,
      destinationRoot,
      signal: input.signal,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    })
  }

  const ignored = await runGit(
    repositoryRoot,
    ['check-ignore', '--quiet', '--no-index', '--', NodePath.relative(repositoryRoot, cacheRoot)],
    input.signal,
    {
      allowNonZeroExit: true,
      env: { GIT_LITERAL_PATHSPECS: '0' },
      maxStdoutBytes: 1_024,
    },
  )
  if (ignored.exitCode !== 0)
  {
    throw new ExactGitSnapshotError(
      'invalid-input',
      'An in-worktree exact-tree cache must be ignored by Git.',
    )
  }

  const stagingParent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-exact-tree-'))
  const stagedRoot = NodePath.join(stagingParent, 'tree')
  try
  {
    await NodeFSP.mkdir(stagedRoot)
    const materialization = await materializeExactGitTree({
      repositoryRoot,
      treeOid: input.treeOid,
      destinationRoot: stagedRoot,
      signal: input.signal,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    })
    const currentCacheRoot = await NodeFSP.realpath(input.cacheRoot)
    const currentDestination = await canonicalEmptyDirectory(
      input.destinationRoot,
      'Cache materialization destination',
    )
    if (currentCacheRoot !== cacheRoot || currentDestination !== destinationRoot)
    {
      throw new ExactGitSnapshotError(
        'invalid-input',
        'Cache materialization destination changed before publication.',
      )
    }
    await publishStagedTree(stagedRoot, destinationRoot)
    return { ...materialization, rootPath: destinationRoot }
  }
  finally
  {
    await NodeFSP.rm(stagingParent, { recursive: true, force: true })
  }
}
