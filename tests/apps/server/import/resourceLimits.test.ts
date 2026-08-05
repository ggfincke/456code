// tests/apps/server/import/resourceLimits.test.ts
// verifies aggregate import byte partitions and normalized resource reservations

import { describe, expect, it } from '@effect/vitest'

import {
  makeImportByteBudget,
  makeImportCountBudget,
  partitionAcpImportBytePolicy,
  reserveNormalizedImportResources,
} from '../../../../apps/server/src/import/resourceLimits.ts'

describe('ACP import byte policy partition', () =>
{
  it('keeps catalog, replay, and normalized retention within one aggregate maximum', () =>
  {
    const policy = partitionAcpImportBytePolicy(4_096, undefined)

    expect(policy).toEqual({
      maxCatalogBytes: 1_024,
      maxReplayBytesPerSession: 1_536,
      maxReplayBytesPerConnection: 1_536,
      maxNormalizedBytesPerConnection: 1_536,
    })
    expect(
      policy!.maxCatalogBytes +
        policy!.maxReplayBytesPerConnection +
        policy!.maxNormalizedBytesPerConnection,
    ).toBeLessThanOrEqual(4_096)
  })

  it('caps configured components independently without exceeding the aggregate', () =>
  {
    const policy = partitionAcpImportBytePolicy(10_000, {
      maxCatalogBytes: 2_000,
      maxReplayBytesPerConnection: 3_000,
      maxReplayBytesPerSession: 9_000,
      maxNormalizedBytesPerConnection: 9_000,
    })

    expect(policy).toEqual({
      maxCatalogBytes: 2_000,
      maxReplayBytesPerSession: 3_000,
      maxReplayBytesPerConnection: 3_000,
      maxNormalizedBytesPerConnection: 5_000,
    })
    expect(
      policy!.maxCatalogBytes +
        policy!.maxReplayBytesPerConnection +
        policy!.maxNormalizedBytesPerConnection,
    ).toBe(10_000)
  })

  it('rejects aggregates too small to reserve all three retained components', () =>
  {
    expect(partitionAcpImportBytePolicy(2, undefined)).toBeNull()
    expect(partitionAcpImportBytePolicy(Number.NaN, undefined)).toBeNull()
  })
})

describe('normalized import resource reservation', () =>
{
  it('reserves serialized bytes and record counts atomically', () =>
  {
    const byteBudget = makeImportByteBudget(1_000)
    const recordBudget = makeImportCountBudget(10)

    expect(
      reserveNormalizedImportResources({
        byteBudget,
        recordBudget,
        recordCount: 4,
        serializedBytes: 600,
        sourcePath: '/session.jsonl',
      }),
    ).toBeNull()
    expect(byteBudget.consumedBytes).toBe(600)
    expect(recordBudget.consumedCount).toBe(4)

    const error = reserveNormalizedImportResources({
      byteBudget,
      recordBudget,
      recordCount: 7,
      serializedBytes: 300,
      sourcePath: '/later.jsonl',
    })

    expect(error?.reason).toBe('normalized record budget exceeded (10 records maximum)')
    expect(byteBudget.consumedBytes).toBe(600)
    expect(recordBudget.consumedCount).toBe(4)
  })

  it('rejects per-session byte and record amplification without consuming aggregate budgets', () =>
  {
    const byteBudget = makeImportByteBudget(10_000)
    const recordBudget = makeImportCountBudget(100)

    expect(
      reserveNormalizedImportResources({
        byteBudget,
        maximumSessionBytes: 1_000,
        maximumSessionRecords: 10,
        recordBudget,
        recordCount: 1,
        serializedBytes: 1_001,
        sourcePath: '/bytes.jsonl',
      })?.reason,
    ).toBe('normalized session exceeds 1000 bytes')
    expect(
      reserveNormalizedImportResources({
        byteBudget,
        maximumSessionBytes: 1_000,
        maximumSessionRecords: 10,
        recordBudget,
        recordCount: 11,
        serializedBytes: 100,
        sourcePath: '/records.jsonl',
      })?.reason,
    ).toBe('normalized session exceeds 10 records')
    expect(byteBudget.consumedBytes).toBe(0)
    expect(recordBudget.consumedCount).toBe(0)
  })
})
