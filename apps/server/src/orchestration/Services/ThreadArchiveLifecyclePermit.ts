// apps/server/src/orchestration/Services/ThreadArchiveLifecyclePermit.ts
// serializes archive command commits with exact-resource cleanup per thread

import type { ThreadId } from '@t3tools/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

export interface ThreadArchiveLifecyclePermitShape
{
  readonly withPermit: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class ThreadArchiveLifecyclePermit extends Context.Service<
  ThreadArchiveLifecyclePermit,
  ThreadArchiveLifecyclePermitShape
>()('456code/orchestration/Services/ThreadArchiveLifecyclePermit')
{}
