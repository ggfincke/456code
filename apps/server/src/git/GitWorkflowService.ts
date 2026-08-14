// apps/server/src/git/GitWorkflowService.ts
// provide git workflow service behavior

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
} from '@t3tools/contracts'

import * as GitManager from './GitManager.ts'
import * as GitStatusReader from '../vcs/GitStatusReader.ts'
import * as GitVcsDriver from '../vcs/GitVcsDriver.ts'
import * as VcsDriverRegistry from '../vcs/VcsDriverRegistry.ts'

type GitManagerWorkflowMethods = Pick<
  GitManager.GitManager['Service'],
  | 'status'
  | 'localStatus'
  | 'remoteStatus'
  | 'invalidateLocalStatus'
  | 'invalidateRemoteStatus'
  | 'invalidateStatus'
  | 'runStackedAction'
  | 'resolvePullRequest'
  | 'preparePullRequestThread'
>

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  GitManagerWorkflowMethods & {
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>
    readonly fetchRemote: (input: {
      readonly cwd: string
      readonly remoteName: string
    }) => Effect.Effect<void, GitCommandError>
    readonly remoteExists: (input: {
      readonly cwd: string
      readonly remoteName: string
    }) => Effect.Effect<boolean, GitCommandError>
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string
      readonly refName: string
      readonly fallbackRemoteName: string
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >
    readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>
    readonly renameBranch: (input: {
      readonly cwd: string
      readonly oldBranch: string
      readonly newBranch: string
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>
  }
>()('456code/git/GitWorkflowService')
{}

function nonRepositoryListRefs(): VcsListRefsResult
{
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  }
}

export const make = Effect.gen(function* ()
{
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry
  const git = yield* GitVcsDriver.GitVcsDriver
  const gitManager = yield* GitManager.GitManager
  const statusReader = yield* GitStatusReader.GitStatusReader

  const ensureGit = Effect.fn('GitWorkflowService.ensureGit')(function* (
    operation: string,
    cwd: string,
  )
  {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: 'Failed to resolve the VCS driver for this Git workflow.',
            cause,
          }),
      ),
    )
    if (handle.kind !== 'git')
    {
      return yield* new GitManagerError({
        operation,
        cwd,
        detail: `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}. (${cwd})`,
      })
    }
  })

  const ensureGitCommand = Effect.fn('GitWorkflowService.ensureGitCommand')(function* (
    operation: string,
    cwd: string,
  )
  {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: 'vcs-route',
            cwd,
            detail: 'Failed to resolve the VCS driver for this Git command.',
            cause,
          }),
      ),
    )
    if (handle.kind !== 'git')
    {
      return yield* new GitCommandError({
        operation,
        command: 'vcs-route',
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      })
    }
  })

  const detectGitRepositoryForCommand = Effect.fn(
    'GitWorkflowService.detectGitRepositoryForCommand',
  )(function* (operation: string, cwd: string)
  {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: 'vcs-route',
            cwd,
            detail: 'Failed to detect a VCS repository for this Git command.',
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
      return yield* new GitCommandError({
        operation,
        command: 'vcs-route',
        cwd,
        detail: `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      })
    }
    return true
  })

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)))

  return GitWorkflowService.of({
    status: statusReader.status,
    localStatus: statusReader.localStatus,
    remoteStatus: statusReader.remoteStatus,
    invalidateLocalStatus: statusReader.invalidateLocalStatus,
    invalidateRemoteStatus: statusReader.invalidateRemoteStatus,
    invalidateStatus: statusReader.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand('GitWorkflowService.pullCurrentBranch', cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      ),
    runStackedAction: (input, options) =>
      ensureGit('GitWorkflowService.runStackedAction', input.cwd).pipe(
        Effect.andThen(gitManager.runStackedAction(input, options)),
      ),
    resolvePullRequest: routeGitManager(
      'GitWorkflowService.resolvePullRequest',
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      'GitWorkflowService.preparePullRequestThread',
      gitManager.preparePullRequestThread,
    ),
    listRefs: (input) =>
      detectGitRepositoryForCommand('GitWorkflowService.listRefs', input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input) =>
      ensureGitCommand('GitWorkflowService.createWorktree', input.cwd).pipe(
        Effect.andThen(git.createWorktree(input)),
      ),
    fetchRemote: (input) =>
      ensureGitCommand('GitWorkflowService.fetchRemote', input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      ),
    remoteExists: (input) =>
      ensureGitCommand('GitWorkflowService.remoteExists', input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      ),
    resolveRemoteTrackingCommit: (input) =>
      ensureGitCommand('GitWorkflowService.resolveRemoteTrackingCommit', input.cwd).pipe(
        Effect.andThen(git.resolveRemoteTrackingCommit(input)),
      ),
    removeWorktree: (input) =>
      ensureGitCommand('GitWorkflowService.removeWorktree', input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      ),
    createRef: (input) =>
      ensureGitCommand('GitWorkflowService.createRef', input.cwd).pipe(
        Effect.andThen(git.createRef(input)),
      ),
    switchRef: (input) =>
      ensureGitCommand('GitWorkflowService.switchRef', input.cwd).pipe(
        Effect.andThen(Effect.scoped(git.switchRef(input))),
      ),
    renameBranch: (input) =>
      ensureGit('GitWorkflowService.renameBranch', input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  })
})

export const layer = Layer.effect(GitWorkflowService, make)
