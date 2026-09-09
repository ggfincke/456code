// tests/packages/client-runtime/load-balancing.test.ts
// verifies fresh capacity selection and unavailable-host rejection

import { describe, expect, it } from 'vite-plus/test'
import { chooseLoadBalancedEnvironment } from '../../../packages/client-runtime/src/load-balancing.ts'

const now = 30_000
const healthy = {
  environmentId: 'healthy',
  requestedAt: now - 100,
  receivedAt: now,
  weight: 1,
  resources: {
    sampledAt: 1,
    cpuUtilization: 0.25,
    cpuCount: 8,
    availableMemoryBytes: 75,
    totalMemoryBytes: 100,
  },
}

describe('chooseLoadBalancedEnvironment', () =>
{
  it('uses local receipt freshness and configured weights instead of remote clock order', () =>
  {
    const preferred = { ...healthy, environmentId: 'preferred', weight: 3 }
    expect(chooseLoadBalancedEnvironment([healthy, preferred], now)).toBe('preferred')
    expect(chooseLoadBalancedEnvironment([healthy, { ...preferred, weight: 0 }], now)).toBe(
      'healthy',
    )
  })

  it('rejects stale, unknown, overloaded, and invalid capacity even at maximum weight', () =>
  {
    const rejected = [
      { ...healthy, receivedAt: now - 15_001 },
      { ...healthy, requestedAt: now - 15_001, receivedAt: now },
      { ...healthy, requestedAt: now + 1 },
      { ...healthy, receivedAt: now + 1 },
      { ...healthy, resources: null },
      { ...healthy, resources: { ...healthy.resources, cpuUtilization: null } },
      { ...healthy, resources: { ...healthy.resources, cpuUtilization: 0.95 } },
      { ...healthy, resources: { ...healthy.resources, availableMemoryBytes: 5 } },
      { ...healthy, resources: { ...healthy.resources, cpuUtilization: Number.NaN } },
      { ...healthy, resources: { ...healthy.resources, totalMemoryBytes: 0 } },
    ].map((candidate, index) => ({ ...candidate, environmentId: `rejected-${index}`, weight: 100 }))
    expect(chooseLoadBalancedEnvironment(rejected, now)).toBeNull()
    expect(chooseLoadBalancedEnvironment([...rejected, healthy], now)).toBe('healthy')
    expect(chooseLoadBalancedEnvironment([], now)).toBeNull()
  })
})
