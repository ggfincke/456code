// apps/server/src/vcs/GitStatusReader.ts
// vcs-owned status read + invalidate surface for broadcasters

import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
} from '@t3tools/contracts'

export class GitStatusReader extends Context.Service<
  GitStatusReader,
  {
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: { readonly refreshUpstream?: boolean },
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>
  }
>()('456code/vcs/GitStatusReader')
{}
