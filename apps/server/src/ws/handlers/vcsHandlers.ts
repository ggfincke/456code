// apps/server/src/ws/handlers/vcsHandlers.ts
// builds VCS websocket rpc handlers from narrow concrete dependencies

import {
  type GitActionProgressEvent,
  type GitCommandError,
  type GitManagerServiceError,
  type OrchestrateRunExecution,
  type VcsRemoveWorktreeInput,
  WS_METHODS,
  type WsRpcGroup,
} from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import type * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as FileSystem from 'effect/FileSystem'
import type * as Path from 'effect/Path'
import type * as PlatformError from 'effect/PlatformError'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import type * as GitWorkflowService from '../../git/GitWorkflowService.ts'
import type * as VcsProvisioningService from '../../vcs/VcsProvisioningService.ts'
import type * as VcsStatusBroadcaster from '../../vcs/VcsStatusBroadcaster.ts'
import { withOrchestrateRunWorktreePermit } from '../../orchestration/runExecutionAvailability.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'

type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>
type VcsRpcMethod =
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.vcsRefreshStatus
  | typeof WS_METHODS.vcsPull
  | typeof WS_METHODS.gitRunStackedAction
  | typeof WS_METHODS.gitResolvePullRequest
  | typeof WS_METHODS.gitPreparePullRequestThread
  | typeof WS_METHODS.vcsListRefs
  | typeof WS_METHODS.vcsCreateWorktree
  | typeof WS_METHODS.vcsRemoveWorktree
  | typeof WS_METHODS.vcsCreateRef
  | typeof WS_METHODS.vcsSwitchRef
  | typeof WS_METHODS.vcsInit
type VcsRpcHandlers = Pick<WsRpcHandlers, VcsRpcMethod>

interface VcsRpcHandlerDependencies
{
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService['Service']
  readonly vcsProvisioning: VcsProvisioningService.VcsProvisioningService['Service']
  readonly vcsStatusBroadcaster: VcsStatusBroadcaster.VcsStatusBroadcaster['Service']
  readonly automaticGitFetchInterval: Effect.Effect<Duration.Duration, never>
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>
  readonly retireRunExecutionWorktreeAvailability: (
    input: VcsRemoveWorktreeInput,
  ) => Effect.Effect<ReadonlyArray<OrchestrateRunExecution>, GitCommandError>
  readonly restoreRunExecutionWorktreeAvailability: (
    executions: ReadonlyArray<OrchestrateRunExecution>,
  ) => Effect.Effect<void, GitCommandError>
  readonly verifyRunExecutionWorktreePresent: (
    input: VcsRemoveWorktreeInput,
    executions: ReadonlyArray<OrchestrateRunExecution>,
  ) => Effect.Effect<boolean>
  readonly resolveRunExecutionWorktreePermitPath: (
    input: VcsRemoveWorktreeInput,
  ) => Effect.Effect<string, GitCommandError>
  readonly observeRpcEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcEffect']
  readonly observeRpcStream: ReturnType<typeof makeRpcAuthorization>['observeRpcStream']
}

function canonicalizeMissingWorktreeTail(
  value: string,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem
    readonly path: Path.Path
  },
): Effect.Effect<string, PlatformError.PlatformError>
{
  return dependencies.fileSystem.realPath(value).pipe(
    Effect.catchTag('PlatformError', (error) =>
    {
      if (error.reason._tag !== 'NotFound')
      {
        return Effect.fail(error)
      }
      const parent = dependencies.path.dirname(value)
      if (parent === value)
      {
        return Effect.fail(error)
      }
      return canonicalizeMissingWorktreeTail(parent, dependencies).pipe(
        Effect.map((canonicalParent) =>
          dependencies.path.join(canonicalParent, dependencies.path.basename(value)),
        ),
      )
    }),
  )
}

export function resolveCanonicalRunExecutionWorktreePermitPath(
  input: VcsRemoveWorktreeInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem
    readonly path: Path.Path
  },
): Effect.Effect<string, PlatformError.PlatformError>
{
  const worktreePath = dependencies.path.normalize(
    dependencies.path.isAbsolute(input.path)
      ? input.path
      : dependencies.path.resolve(input.cwd, input.path),
  )
  return input.force
    ? canonicalizeMissingWorktreeTail(worktreePath, dependencies)
    : dependencies.fileSystem.realPath(worktreePath)
}

export function makeVcsRpcHandlers({
  gitWorkflow,
  vcsProvisioning,
  vcsStatusBroadcaster,
  automaticGitFetchInterval,
  refreshGitStatus,
  retireRunExecutionWorktreeAvailability,
  restoreRunExecutionWorktreeAvailability,
  verifyRunExecutionWorktreePresent,
  resolveRunExecutionWorktreePermitPath,
  observeRpcEffect,
  observeRpcStream,
}: VcsRpcHandlerDependencies)
{
  return {
    [WS_METHODS.subscribeVcsStatus]: (input) =>
      observeRpcStream(
        WS_METHODS.subscribeVcsStatus,
        vcsStatusBroadcaster.streamStatus(input, {
          automaticRemoteRefreshInterval: automaticGitFetchInterval,
        }),
        {
          'rpc.aggregate': 'vcs',
        },
      ),
    [WS_METHODS.vcsRefreshStatus]: (input) =>
      observeRpcEffect(WS_METHODS.vcsRefreshStatus, vcsStatusBroadcaster.refreshStatus(input.cwd), {
        'rpc.aggregate': 'vcs',
      }),
    [WS_METHODS.vcsPull]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsPull,
        gitWorkflow.pullCurrentBranch(input.cwd).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => Effect.failCause(cause),
            onSuccess: (result) =>
              refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
          }),
        ),
        { 'rpc.aggregate': 'git' },
      ),
    [WS_METHODS.gitRunStackedAction]: (input) =>
      observeRpcStream(
        WS_METHODS.gitRunStackedAction,
        Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
          gitWorkflow
            .runStackedAction(input, {
              actionId: input.actionId,
              progressReporter: {
                publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
              },
            })
            .pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Queue.failCause(queue, cause),
                onSuccess: () =>
                  refreshGitStatus(input.cwd).pipe(
                    Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                  ),
              }),
            ),
        ),
        { 'rpc.aggregate': 'vcs' },
      ),
    [WS_METHODS.gitResolvePullRequest]: (input) =>
      observeRpcEffect(WS_METHODS.gitResolvePullRequest, gitWorkflow.resolvePullRequest(input), {
        'rpc.aggregate': 'git',
      }),
    [WS_METHODS.gitPreparePullRequestThread]: (input) =>
      observeRpcEffect(
        WS_METHODS.gitPreparePullRequestThread,
        gitWorkflow
          .preparePullRequestThread(input)
          .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        { 'rpc.aggregate': 'git' },
      ),
    [WS_METHODS.vcsListRefs]: (input) =>
      observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
        'rpc.aggregate': 'vcs',
      }),
    [WS_METHODS.vcsCreateWorktree]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsCreateWorktree,
        gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        { 'rpc.aggregate': 'vcs' },
      ),
    [WS_METHODS.vcsRemoveWorktree]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsRemoveWorktree,
        removeWorktreeWithRunExecutionAvailability(input, {
          removeWorktree: gitWorkflow.removeWorktree,
          retireRunExecutionWorktreeAvailability,
          restoreRunExecutionWorktreeAvailability,
          verifyRunExecutionWorktreePresent,
          resolveRunExecutionWorktreePermitPath,
        }).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        { 'rpc.aggregate': 'vcs' },
      ),
    [WS_METHODS.vcsCreateRef]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsCreateRef,
        gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        { 'rpc.aggregate': 'vcs' },
      ),
    [WS_METHODS.vcsSwitchRef]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsSwitchRef,
        gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        { 'rpc.aggregate': 'vcs' },
      ),
    [WS_METHODS.vcsInit]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsInit,
        vcsProvisioning.initRepository(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        { 'rpc.aggregate': 'vcs' },
      ),
  } satisfies VcsRpcHandlers
}

export function removeWorktreeWithRunExecutionAvailability(
  input: VcsRemoveWorktreeInput,
  dependencies: {
    readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>
    readonly retireRunExecutionWorktreeAvailability: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<ReadonlyArray<OrchestrateRunExecution>, GitCommandError>
    readonly restoreRunExecutionWorktreeAvailability: (
      executions: ReadonlyArray<OrchestrateRunExecution>,
    ) => Effect.Effect<void, GitCommandError>
    readonly verifyRunExecutionWorktreePresent: (
      input: VcsRemoveWorktreeInput,
      executions: ReadonlyArray<OrchestrateRunExecution>,
    ) => Effect.Effect<boolean>
    readonly resolveRunExecutionWorktreePermitPath: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<string, GitCommandError>
  },
): Effect.Effect<void, GitCommandError>
{
  return Effect.gen(function* ()
  {
    const worktreePath = yield* dependencies.resolveRunExecutionWorktreePermitPath(input)
    const canonicalInput = { ...input, path: worktreePath }
    return yield* withOrchestrateRunWorktreePermit(
      worktreePath,
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* ()
        {
          const retired = yield* dependencies.retireRunExecutionWorktreeAvailability(canonicalInput)
          const removalExit = yield* restore(dependencies.removeWorktree(canonicalInput)).pipe(
            Effect.exit,
          )
          if (Exit.isSuccess(removalExit))
          {
            return
          }

          const presenceExit = yield* dependencies
            .verifyRunExecutionWorktreePresent(canonicalInput, retired)
            .pipe(Effect.exit)
          if (Exit.isFailure(presenceExit))
          {
            return yield* Effect.failCause(Cause.combine(removalExit.cause, presenceExit.cause))
          }
          if (!presenceExit.value)
          {
            return yield* Effect.failCause(removalExit.cause)
          }

          const restorationExit = yield* dependencies
            .restoreRunExecutionWorktreeAvailability(retired)
            .pipe(Effect.exit)
          if (Exit.isFailure(restorationExit))
          {
            return yield* Effect.failCause(Cause.combine(removalExit.cause, restorationExit.cause))
          }
          return yield* Effect.failCause(removalExit.cause)
        }),
      ),
    )
  })
}
