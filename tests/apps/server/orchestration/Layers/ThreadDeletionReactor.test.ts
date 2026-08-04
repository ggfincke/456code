// tests/apps/server/orchestration/Layers/ThreadDeletionReactor.test.ts
// verifies deletion cleanup failure handling and bounded-resource tombstone ordering

import { ThreadId } from '@t3tools/contracts'
import { it as effectIt } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { describe, expect, it } from 'vite-plus/test'

import {
  logCleanupCauseUnlessInterrupted,
  runThreadDeletionCleanup,
} from '../../../../../apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts'

describe('logCleanupCauseUnlessInterrupted', () =>
{
  const threadId = ThreadId.make('thread-deletion-reactor-test')

  it('swallows ordinary cleanup failures', async () =>
  {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail('cleanup failed'),
        message: 'thread deletion cleanup skipped provider session stop',
        threadId,
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it('preserves interrupt causes', async () =>
  {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: 'thread deletion cleanup skipped provider session stop',
        threadId,
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
    {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
  })
})

describe('runThreadDeletionCleanup', () =>
{
  effectIt.effect(
    'installs proposal and embed tombstones before provider and terminal cleanup',
    () =>
      Effect.gen(function* ()
      {
        const completed: string[] = []
        const mark = (name: string) =>
          Effect.sync(() =>
          {
            completed.push(name)
          })

        yield* runThreadDeletionCleanup({
          cancelProposalGeneration: mark('proposal-generation'),
          closeCartographerEmbed: mark('cartographer-embed'),
          stopProviderSession: mark('provider-session'),
          closeThreadTerminals: mark('terminals'),
        })

        expect(completed).toEqual([
          'proposal-generation',
          'cartographer-embed',
          'provider-session',
          'terminals',
        ])
      }),
  )
})
