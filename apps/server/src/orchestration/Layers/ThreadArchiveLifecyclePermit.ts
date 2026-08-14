// apps/server/src/orchestration/Layers/ThreadArchiveLifecyclePermit.ts
// provides runtime-local archive lifecycle exclusion keyed by thread

import type { ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { makeKeyedSemaphore } from '../../provider/Layers/KeyedSemaphore.ts'
import { ThreadArchiveLifecyclePermit } from '../Services/ThreadArchiveLifecyclePermit.ts'

export const ThreadArchiveLifecyclePermitLive = Layer.effect(
  ThreadArchiveLifecyclePermit,
  Effect.map(makeKeyedSemaphore<ThreadId>(), (permits) =>
    ThreadArchiveLifecyclePermit.of({ withPermit: permits.withPermit }),
  ),
)
