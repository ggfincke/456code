// tests/apps/web/components/usage/usagePriceTargets.test.ts
// verify selected pricing targets preserve local rates and settle independently

import { EnvironmentId } from '@t3tools/contracts'
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  usagePriceCell,
  writeUsagePrice,
  type UsagePriceTarget,
} from '../../../../../apps/web/src/components/usage/usagePriceTargets'

describe('usage pricing targets', () =>
{
  it('preserves mixed target-local rates, isolates a failed write, and retries only that target', async () =>
  {
    const model = 'claude-sonnet'
    const targets: readonly UsagePriceTarget[] = [
      {
        environmentId: EnvironmentId.make('local'),
        label: 'Local',
        unavailable: null,
        prices: {
          [model]: {
            inputCostPerMillionTokens: 3,
            outputCostPerMillionTokens: 15,
            cacheReadCostPerMillionTokens: 0.3,
          },
        },
      },
      {
        environmentId: EnvironmentId.make('remote'),
        label: 'Remote',
        unavailable: null,
        prices: {
          [model]: {
            inputCostPerMillionTokens: 5,
            outputCostPerMillionTokens: 20,
            cacheReadCostPerMillionTokens: 0.5,
          },
        },
      },
    ]
    expect(usagePriceCell(targets, model, 'outputCostPerMillionTokens')).toEqual({
      mixed: true,
      value: '',
    })
    const write = vi
      .fn<Parameters<typeof writeUsagePrice>[0]['write']>()
      .mockResolvedValueOnce({ _tag: 'Success' })
      .mockResolvedValueOnce({ _tag: 'Failure' })
    const results = new Map<EnvironmentId, string | null>()
    const edits = { inputCostPerMillionTokens: '4' }
    const onResult = (id: EnvironmentId, error: string | null) =>
    {
      results.set(id, error)
    }
    await writeUsagePrice({ targets, model, edits, write, onResult })
    expect(write.mock.calls.map(([target]) => target)).toEqual(
      targets.map((target) => ({
        environmentId: target.environmentId,
        input: {
          patch: {
            usagePriceOverrides: {
              [model]: { ...target.prices?.[model], inputCostPerMillionTokens: 4 },
            },
          },
        },
      })),
    )
    expect(results.get(targets[0]!.environmentId)).toBeNull()
    expect(results.get(targets[1]!.environmentId)).toBeTypeOf('string')
    write.mockClear().mockResolvedValue({ _tag: 'Success' })
    await writeUsagePrice({
      targets: targets.filter((target) => results.get(target.environmentId)),
      model,
      edits,
      write,
      onResult,
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0].environmentId).toBe(targets[1]!.environmentId)
    expect(results.get(targets[1]!.environmentId)).toBeNull()
    write.mockClear()
    await writeUsagePrice({ targets: [targets[1]!], model, edits: null, write, onResult })
    expect(write).toHaveBeenCalledExactlyOnceWith({
      environmentId: targets[1]!.environmentId,
      input: { patch: { usagePriceOverrides: { [model]: null } } },
    })
  })
})
