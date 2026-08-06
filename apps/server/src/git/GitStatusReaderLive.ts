// apps/server/src/git/GitStatusReaderLive.ts
// provide git status reads via manager + repo detection

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import {
  GitManagerError,
  type VcsStatusLocalResult,
  type VcsStatusResult,
} from '@t3tools/contracts'

import * as GitManager from './GitManager.ts'
import * as GitStatusReader from '../vcs/GitStatusReader.ts'
import * as VcsDriverRegistry from '../vcs/VcsDriverRegistry.ts'

function nonRepositoryLocalStatus(): VcsStatusLocalResult
{
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  }
}

function nonRepositoryStatus(): VcsStatusResult
{
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  }
}

export const make = Effect.gen(function* ()
{
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry
  const gitManager = yield* GitManager.GitManager

  const detectGitRepositoryForStatus = Effect.fn('GitStatusReader.detectGitRepositoryForStatus')(
    function* (operation: string, cwd: string)
    {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: 'Failed to detect a VCS repository for this Git workflow.',
              cause,
            }),
        ),
      )
      if (!handle)
      {
        return false
      }
      if (handle.kind !== 'git')
      {
        return yield* new GitManagerError({
          operation,
          cwd,
          detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
        })
      }
      return true
    },
  )

  return GitStatusReader.GitStatusReader.of({
    status: (input) =>
      detectGitRepositoryForStatus('GitStatusReader.status', input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.status(input) : Effect.succeed(nonRepositoryStatus()),
        ),
      ),
    localStatus: (input) =>
      detectGitRepositoryForStatus('GitStatusReader.localStatus', input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.localStatus(input)
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      ),
    remoteStatus: (input, options) =>
      detectGitRepositoryForStatus('GitStatusReader.remoteStatus', input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
  })
})

export const layer = Layer.effect(GitStatusReader.GitStatusReader, make)
