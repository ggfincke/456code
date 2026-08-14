// tests/apps/server/cartographer/ProjectAtlasStatusBroadcaster.test.ts
// verifies snapshot-first project atlas status delivery and subscription retention

import { it } from '@effect/vitest'
import { ArchitectureGenerationId, ArchitectureGraphDigest, ProjectId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import { describe, expect } from 'vite-plus/test'

import { make } from '../../../../apps/server/src/cartographer/ProjectAtlasStatusBroadcaster.ts'

describe('ProjectAtlasStatusBroadcaster', () =>
{
  it.effect('retains a snapshot-first stream until its subscriber closes', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const projectId = ProjectId.make('project-atlas-status')
        const broadcaster = yield* make
        let retained = 0
        const collected = yield* broadcaster
          .streamStatus(projectId, {
            retain: Effect.sync(() =>
            {
              retained += 1
            }),
            release: Effect.sync(() =>
            {
              retained -= 1
            }),
          })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow

        expect(retained).toBe(1)
        yield* broadcaster.update(projectId, () => ({
          state: 'ready',
          source: {
            kind: 'standing-project-generation',
            projectId,
            generationId: ArchitectureGenerationId.make('a'.repeat(64)),
            side: 'analyzed',
            graphDigest: ArchitectureGraphDigest.make(`sha256:${'b'.repeat(64)}`),
          },
          freshness: { builtAt: '2026-08-07T12:00:00.000Z', dirty: false },
          lastBuildError: null,
        }))
        const statuses = Array.from(yield* Fiber.join(collected))

        expect(statuses.map((status) => status.state)).toEqual(['idle', 'ready'])
        expect(retained).toBe(0)
      }),
    ),
  )
})
