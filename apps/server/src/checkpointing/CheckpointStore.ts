// apps/server/src/checkpointing/CheckpointStore.ts
// manage checkpoint state

// owns hidden Git-ref checkpoint capture/restore and diff computation for a
// workspace thread timeline. It does not store user-facing checkpoint metadata
// and does not coordinate provider conversation rollback.
//
// the live adapter resolves the active VCS driver once per checkpoint operation
// and delegates to the driver's optional checkpoint capability.
//
// uses Effect `Context.Service` for dependency injection and exposes typed
// domain errors for checkpoint storage operations.
//
// @module CheckpointStore
import { VcsUnsupportedOperationError, type CheckpointRef } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import type { CheckpointStoreError } from './Errors.ts'
import type {
  VcsCaptureCheckpointResult,
  VcsCheckpointOps,
  VcsCheckpointRefExpectation,
} from '../vcs/VcsDriver.ts'
import type { GitStagedCheckpointOps } from '../vcs/GitVcsDriver.ts'
import type {
  ExactGitTreeRestore,
  ExactGitTreeRestorePreflight,
  ExactGitTreeVerification,
} from '../vcs/ExactGitSnapshot.ts'
import * as VcsDriverRegistry from '../vcs/VcsDriverRegistry.ts'

export type { VcsCaptureCheckpointResult, VcsCheckpointRefExpectation }

export interface CaptureCheckpointInput
{
  readonly cwd: string
  readonly checkpointRef: CheckpointRef
  readonly expected?: VcsCheckpointRefExpectation
}

export interface RestoreCheckpointInput
{
  readonly cwd: string
  readonly checkpointRef: CheckpointRef
  readonly fallbackToHead?: boolean
}

export interface DiffCheckpointsInput
{
  readonly cwd: string
  readonly fromCheckpointRef: CheckpointRef
  readonly toCheckpointRef: CheckpointRef
  readonly fallbackFromToHead?: boolean
  readonly ignoreWhitespace: boolean
}

export interface DeleteCheckpointRefsInput
{
  readonly cwd: string
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>
}

export interface StageCheckpointTreeInput
{
  readonly cwd: string
  readonly ref: CheckpointRef
  readonly stagePath: string
}

export interface VerifyCheckpointRestorePreconditionsInput
{
  readonly cwd: string
  readonly ref: CheckpointRef
}

export interface ApplyStagedCheckpointRestoreInput extends VerifyCheckpointRestorePreconditionsInput
{
  readonly stagePath: string
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    // check whether cwd is inside a Git worktree.
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>

    // capture a checkpoint commit and publish it at the provided checkpoint ref.
    //
    // uses an isolated temporary Git index and writes a hidden ref through a
    // compare-and-swap; a concurrent publication returns a `lost-race` outcome
    // instead of overwriting the ref.
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<VcsCaptureCheckpointResult, CheckpointStoreError>

    // check whether a checkpoint ref exists.
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, 'fallbackToHead'>,
    ) => Effect.Effect<boolean, CheckpointStoreError>

    // restore workspace and staging state to a checkpoint.
    //
    // optionally falls back to current `HEAD` when the checkpoint ref is missing.
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>

    // materialize and verify a checkpoint tree outside the live worktree.
    readonly stageCheckpointTree: (
      input: StageCheckpointTreeInput,
    ) => Effect.Effect<ExactGitTreeVerification, CheckpointStoreError>

    // validate restore obstructions without mutating the worktree or index.
    readonly verifyRestorePreconditions: (
      input: VerifyCheckpointRestorePreconditionsInput,
    ) => Effect.Effect<ExactGitTreeRestorePreflight, CheckpointStoreError>

    // converge the worktree from a previously verified staged tree.
    readonly applyStagedRestore: (
      input: ApplyStagedCheckpointRestoreInput,
    ) => Effect.Effect<ExactGitTreeRestore, CheckpointStoreError>

    // verify restored worktree bytes, modes, links, and index policy.
    readonly postVerifyRestore: (
      input: VerifyCheckpointRestorePreconditionsInput,
    ) => Effect.Effect<ExactGitTreeVerification, CheckpointStoreError>

    // compute a patch diff between two checkpoint refs.
    //
    // can optionally treat a missing "from" ref as `HEAD`.
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>

    // delete the provided checkpoint refs.
    //
    // missing refs are tolerated; a ref that could not be deleted fails.
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>
  }
>()('456code/checkpointing/CheckpointStore')
{}

export const make = Effect.gen(function* ()
{
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry

  const resolveCheckpoints = Effect.fn('CheckpointStore.resolveCheckpoints')(function* (
    operation: string,
    cwd: string,
  )
  {
    const handle = yield* vcsRegistry.resolve({ cwd })
    if (!handle.driver.checkpoints)
    {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      })
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps
  })

  const resolveStagedCheckpoints = Effect.fn('CheckpointStore.resolveStagedCheckpoints')(function* (
    operation: string,
    cwd: string,
  )
  {
    const handle = yield* vcsRegistry.resolve({ cwd, requestedKind: 'git' })
    const checkpoints = handle.driver.checkpoints as
      (VcsCheckpointOps & Partial<GitStagedCheckpointOps>) | undefined
    if (
      checkpoints?.stageCheckpointTree === undefined ||
      checkpoints.verifyRestorePreconditions === undefined ||
      checkpoints.applyStagedRestore === undefined ||
      checkpoints.postVerifyRestore === undefined
    )
    {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement staged checkpoint restore operations.`,
      })
    }
    return checkpoints as VcsCheckpointOps & GitStagedCheckpointOps
  })

  const isGitRepository: CheckpointStore['Service']['isGitRepository'] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: 'git' })
      .pipe(Effect.map((repository) => repository !== null))

  const captureCheckpoint: CheckpointStore['Service']['captureCheckpoint'] = Effect.fn(
    'captureCheckpoint',
  )(function* (input)
  {
    const checkpoints = yield* resolveCheckpoints('CheckpointStore.captureCheckpoint', input.cwd)
    return yield* checkpoints.captureCheckpoint(input)
  })

  const hasCheckpointRef: CheckpointStore['Service']['hasCheckpointRef'] = Effect.fn(
    'hasCheckpointRef',
  )(function* (input)
  {
    const checkpoints = yield* resolveCheckpoints('CheckpointStore.hasCheckpointRef', input.cwd)
    return yield* checkpoints.hasCheckpointRef(input)
  })

  const restoreCheckpoint: CheckpointStore['Service']['restoreCheckpoint'] = Effect.fn(
    'restoreCheckpoint',
  )(function* (input)
  {
    const checkpoints = yield* resolveCheckpoints('CheckpointStore.restoreCheckpoint', input.cwd)
    return yield* checkpoints.restoreCheckpoint(input)
  })

  const stageCheckpointTree: CheckpointStore['Service']['stageCheckpointTree'] = Effect.fn(
    'stageCheckpointTree',
  )(function* (input)
  {
    const checkpoints = yield* resolveStagedCheckpoints(
      'CheckpointStore.stageCheckpointTree',
      input.cwd,
    )
    return yield* checkpoints.stageCheckpointTree(input)
  })

  const verifyRestorePreconditions: CheckpointStore['Service']['verifyRestorePreconditions'] =
    Effect.fn('verifyRestorePreconditions')(function* (input)
    {
      const checkpoints = yield* resolveStagedCheckpoints(
        'CheckpointStore.verifyRestorePreconditions',
        input.cwd,
      )
      return yield* checkpoints.verifyRestorePreconditions(input)
    })

  const applyStagedRestore: CheckpointStore['Service']['applyStagedRestore'] = Effect.fn(
    'applyStagedRestore',
  )(function* (input)
  {
    const checkpoints = yield* resolveStagedCheckpoints(
      'CheckpointStore.applyStagedRestore',
      input.cwd,
    )
    return yield* checkpoints.applyStagedRestore(input)
  })

  const postVerifyRestore: CheckpointStore['Service']['postVerifyRestore'] = Effect.fn(
    'postVerifyRestore',
  )(function* (input)
  {
    const checkpoints = yield* resolveStagedCheckpoints(
      'CheckpointStore.postVerifyRestore',
      input.cwd,
    )
    return yield* checkpoints.postVerifyRestore(input)
  })

  const diffCheckpoints: CheckpointStore['Service']['diffCheckpoints'] = Effect.fn(
    'diffCheckpoints',
  )(function* (input)
  {
    const checkpoints = yield* resolveCheckpoints('CheckpointStore.diffCheckpoints', input.cwd)
    return yield* checkpoints.diffCheckpoints(input)
  })

  const deleteCheckpointRefs: CheckpointStore['Service']['deleteCheckpointRefs'] = Effect.fn(
    'deleteCheckpointRefs',
  )(function* (input)
  {
    const checkpoints = yield* resolveCheckpoints('CheckpointStore.deleteCheckpointRefs', input.cwd)
    return yield* checkpoints.deleteCheckpointRefs(input)
  })

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    stageCheckpointTree,
    verifyRestorePreconditions,
    applyStagedRestore,
    postVerifyRestore,
    diffCheckpoints,
    deleteCheckpointRefs,
  })
})

export const layer = Layer.effect(CheckpointStore, make)
