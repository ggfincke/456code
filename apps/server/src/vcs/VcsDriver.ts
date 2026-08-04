// apps/server/src/vcs/VcsDriver.ts
// define vcs capture checkpoint input

import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type {
  VcsDriverCapabilities,
  VcsError,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  VcsRepositoryIdentity,
} from '@t3tools/contracts'
import { CheckpointRef } from '@t3tools/contracts'
import * as VcsProcess from './VcsProcess.ts'

// what the target ref must hold when a capture publishes its commit; captures
// that omit it read the ref before snapshotting and require it to be unchanged
export type VcsCheckpointRefExpectation =
  { readonly kind: 'absent' } | { readonly kind: 'commit'; readonly commitOid: string }

export interface VcsCaptureCheckpointInput
{
  readonly cwd: string
  readonly checkpointRef: CheckpointRef
  readonly expected?: VcsCheckpointRefExpectation
}

// `lost-race` means another writer published the ref first, so the captured
// commit was never installed and the caller must drop its snapshot
export interface VcsCaptureCheckpointResult
{
  readonly outcome: 'published' | 'lost-race'
  readonly commitOid: string
}

export interface VcsRestoreCheckpointInput
{
  readonly cwd: string
  readonly checkpointRef: CheckpointRef
  readonly fallbackToHead?: boolean
}

export interface VcsDiffCheckpointsInput
{
  readonly cwd: string
  readonly fromCheckpointRef: CheckpointRef
  readonly toCheckpointRef: CheckpointRef
  readonly fallbackFromToHead?: boolean
  readonly ignoreWhitespace: boolean
}

export interface VcsDeleteCheckpointRefsInput
{
  readonly cwd: string
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>
}

export interface VcsCheckpointOps
{
  readonly captureCheckpoint: (
    input: VcsCaptureCheckpointInput,
  ) => Effect.Effect<VcsCaptureCheckpointResult, VcsError>
  readonly hasCheckpointRef: (
    input: Omit<VcsRestoreCheckpointInput, 'fallbackToHead'>,
  ) => Effect.Effect<boolean, VcsError>
  readonly restoreCheckpoint: (input: VcsRestoreCheckpointInput) => Effect.Effect<boolean, VcsError>
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>
}

export class VcsDriver extends Context.Service<
  VcsDriver,
  {
    readonly capabilities: VcsDriverCapabilities
    readonly execute: (
      input: Omit<VcsProcess.VcsProcessInput, 'command'>,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>
    readonly checkpoints?: VcsCheckpointOps
    readonly detectRepository: (
      cwd: string,
    ) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>
    readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>
    readonly listWorkspaceFiles: (
      cwd: string,
    ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>
    readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>
    readonly filterIgnoredPaths: (
      cwd: string,
      relativePaths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, VcsError>
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>
    readonly getDiffPreview?: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, VcsError>
  }
>()('456code/vcs/VcsDriver')
{}
