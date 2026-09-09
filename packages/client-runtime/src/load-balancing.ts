// packages/client-runtime/src/load-balancing.ts
// selects a healthy connected project host using fresh whole-machine capacity

import type { HostResourcesSnapshot } from '@t3tools/contracts'

// callers supply only already-connected hosts authorized for the same project and provider
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    readonly environmentId: string
    readonly resources: HostResourcesSnapshot | null
    readonly requestedAt: number
    readonly receivedAt: number
    readonly weight: number
  }>,
  now: number,
): string | null
{
  if (!Number.isFinite(now)) return null
  let selected: string | null = null
  let bestScore = 0
  for (const { environmentId, resources, requestedAt, receivedAt, weight } of candidates)
  {
    if (
      resources === null ||
      !Number.isFinite(requestedAt) ||
      !Number.isFinite(receivedAt) ||
      requestedAt > receivedAt ||
      receivedAt - requestedAt > 15_000 ||
      receivedAt > now ||
      now - requestedAt > 15_000 ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      weight > 100 ||
      resources.cpuUtilization === null ||
      !Number.isFinite(resources.cpuUtilization) ||
      resources.cpuUtilization < 0 ||
      resources.cpuUtilization >= 0.95 ||
      !Number.isFinite(resources.cpuCount) ||
      resources.cpuCount <= 0 ||
      !Number.isFinite(resources.totalMemoryBytes) ||
      resources.totalMemoryBytes <= 0 ||
      !Number.isFinite(resources.availableMemoryBytes) ||
      resources.availableMemoryBytes > resources.totalMemoryBytes
    )
    {
      continue
    }
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes
    if (memoryAvailable <= 0.05) continue
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable
    if (score > bestScore)
    {
      selected = environmentId
      bestScore = score
    }
  }
  return selected
}
