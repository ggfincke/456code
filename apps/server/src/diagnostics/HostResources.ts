// apps/server/src/diagnostics/HostResources.ts
// samples bounded whole-host capacity on demand for connected-machine balancing

import * as NodeOS from 'node:os'
import type { HostResourcesSnapshot } from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Cache from 'effect/Cache'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'

import * as ProcessRunner from '../process/processRunner.ts'

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()('456code/diagnostics/HostResources')
{}

function readCpu()
{
  const cpus = NodeOS.cpus()
  const counters = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  )
  return { ...counters, count: cpus.length }
}

export function darwinAvailableMemory(output: string): number | null
{
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1]
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1]
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1]
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1]
  if (!pageSize || !free || !inactive || !speculative) return null
  // vm_stat already excludes speculative pages from its printed free count
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize)
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null
}

export const make = Effect.gen(function* ()
{
  const fs = yield* FileSystem.FileSystem
  const platform = yield* HostProcessPlatform
  const runner = yield* ProcessRunner.ProcessRunner
  const sample = Effect.fn('HostResources.sample')(function* ()
  {
    const previousCpu = readCpu()
    yield* Effect.sleep('200 millis')
    const cpu = readCpu()
    const totalDelta = cpu.total - previousCpu.total
    const idleDelta = cpu.idle - previousCpu.idle
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null
    const totalMemoryBytes = NodeOS.totalmem()
    let availableMemoryBytes = NodeOS.freemem()
    if (platform === 'linux')
    {
      const meminfo = yield* fs.readFileString('/proc/meminfo').pipe(Effect.orElseSucceed(() => ''))
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1]
      if (available) availableMemoryBytes = Number(available) * 1024
    }
    else if (platform === 'darwin')
    {
      const output = yield* runner
        .run({
          command: '/usr/bin/vm_stat',
          args: [],
          timeout: '1 second',
          maxOutputBytes: 16 * 1024,
        })
        .pipe(
          Effect.map((result) => (result.code === 0 ? result.stdout : '')),
          Effect.orElseSucceed(() => ''),
        )
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
    } satisfies HostResourcesSnapshot
  })

  // concurrent authorized readers share one sample; idle hosts never poll
  const cache = yield* Cache.makeWith<'host', HostResourcesSnapshot>(() => sample(), {
    capacity: 1,
    timeToLive: () => '5 seconds',
  })
  return HostResources.of({ read: Cache.get(cache, 'host') })
})

export const layer = Layer.effect(HostResources, make)
