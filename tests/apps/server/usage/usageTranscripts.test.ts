// tests/apps/server/usage/usageTranscripts.test.ts
// verifies transcript deltas and exact-model pricing

import { describe, expect, it } from 'vite-plus/test'

import {
  parseUsageTranscript,
  totalUsageTokens,
} from '../../../../apps/server/src/usage/usageTranscripts.ts'
import { priceUsageRecord } from '../../../../apps/server/src/usage/usagePricing.ts'

describe('transcript usage parsing', () =>
{
  it('reads Claude usage and its provider-reported cost', () =>
  {
    const parsed = parseUsageTranscript(
      'claude',
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-09T12:00:00.000Z',
        sessionId: 'session-1',
        requestId: 'request-1',
        costUSD: 0.125,
        message: {
          id: 'message-1',
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 25,
            cache_creation_input_tokens: 10,
            output_tokens: 40,
          },
        },
      }),
    )

    expect(parsed.malformedRecords).toBe(0)
    expect(parsed.records).toEqual([
      {
        provider: 'claude',
        timestampMs: Date.parse('2026-09-09T12:00:00.000Z'),
        model: 'claude-sonnet-4-5',
        sessionId: 'session-1',
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 25,
          cacheCreationTokens: 10,
          outputTokens: 40,
          reasoningTokens: 0,
        },
        reportedCostUsd: 0.125,
        dedupeKey: 'message-1:request-1',
      },
    ])
  })

  it('sums Codex deltas, drops repeated frames, and retains equal later deltas', () =>
  {
    const tokenCount = {
      type: 'event_msg',
      timestamp: '2026-09-09T12:00:01.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 50_000, output_tokens: 5_000 },
          last_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 600,
            cache_write_input_tokens: 100,
            output_tokens: 200,
            reasoning_output_tokens: 75,
          },
        },
      },
    }
    const parsed = parseUsageTranscript(
      'codex',
      [
        { type: 'session_meta', timestamp: '2026-09-09T12:00:00.000Z', payload: { id: 's1' } },
        {
          type: 'turn_context',
          timestamp: '2026-09-09T12:00:00.500Z',
          payload: { model: 'gpt-5.6' },
        },
        tokenCount,
        tokenCount,
        {
          ...tokenCount,
          timestamp: '2026-09-09T12:00:02.000Z',
          payload: {
            ...tokenCount.payload,
            info: {
              ...tokenCount.payload.info,
              total_token_usage: { input_tokens: 51_000, output_tokens: 5_200 },
            },
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    )

    expect(parsed.records).toHaveLength(2)
    expect(parsed.records[0]?.totals).toEqual({
      uncachedInputTokens: 300,
      cachedInputTokens: 600,
      cacheCreationTokens: 100,
      outputTokens: 200,
      reasoningTokens: 75,
    })
    expect(totalUsageTokens(parsed.records[0]!.totals)).toBe(1_200)
    expect(parsed.records[1]?.totals).toEqual(parsed.records[0]?.totals)
  })
})

describe('custom usage pricing', () =>
{
  const totals = {
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 500_000,
    cacheCreationTokens: 250_000,
    outputTokens: 100_000,
    reasoningTokens: 50_000,
  }

  it('applies an exact custom model rate to real token categories', () =>
  {
    expect(
      priceUsageRecord({
        model: 'gpt-custom',
        totals,
        reportedCostUsd: null,
        overrides: {
          'gpt-custom': {
            inputCostPerMillionTokens: 2,
            outputCostPerMillionTokens: 8,
            cacheReadCostPerMillionTokens: 1,
            cacheWriteCostPerMillionTokens: 3,
          },
        },
      }),
    ).toEqual({ costUsd: 4.05, source: 'customPriced' })
  })

  it('does not treat inherited object properties as price overrides', () =>
  {
    expect(
      priceUsageRecord({
        model: 'constructor',
        totals,
        reportedCostUsd: null,
        overrides: {},
      }),
    ).toEqual({ costUsd: 0, source: 'unpriced' })
  })
})
