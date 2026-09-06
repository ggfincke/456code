// tests/apps/server/diagnostics/HostResources.test.ts
// verifies on-demand capacity sampling and shared bounded cache ownership

import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import {
  darwinAvailableMemory,
  make,
} from '../../../../apps/server/src/diagnostics/HostResources.ts'
import * as ProcessRunner from '../../../../apps/server/src/process/processRunner.ts'

const vmStat = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free: 10.',
  'Pages inactive: 20.',
  'Pages speculative: 5.',
  'Pages purgeable: 20.',
].join('\n')

it.layer(NodeServices.layer)('HostResources', (it) =>
{
  it.effect('shares concurrent samples without polling and refreshes after expiry', () =>
    Effect.gen(function* ()
    {
      let samples = 0
      const resources = yield* make.pipe(
        Effect.provideService(HostProcessPlatform, 'darwin'),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.sync(() =>
            {
              expect(input.command).toBe('/usr/bin/vm_stat')
              expect(input.maxOutputBytes).toBe(16 * 1024)
              samples += 1
              return {
                stdout: vmStat,
                stderr: '',
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              }
            }),
        }),
      )
      expect(samples).toBe(0)
      const concurrent = yield* Effect.all([resources.read, resources.read], {
        concurrency: 2,
      }).pipe(Effect.forkScoped)
      yield* TestClock.adjust('200 millis')
      const [first, second] = yield* Fiber.join(concurrent)
      expect(samples).toBe(1)
      expect(first).toBe(second)
      expect(first.availableMemoryBytes).toBe(35 * 16384)
      yield* TestClock.adjust('6 seconds')
      expect(samples).toBe(1)
      const refreshed = yield* resources.read.pipe(Effect.forkScoped)
      yield* TestClock.adjust('200 millis')
      yield* Fiber.join(refreshed)
      expect(samples).toBe(2)
    }),
  )

  it('counts reclaimable macOS pages once and rejects malformed samples', () =>
  {
    expect(darwinAvailableMemory(vmStat)).toBe(35 * 16384)
    expect(darwinAvailableMemory('unavailable')).toBeNull()
  })
})
