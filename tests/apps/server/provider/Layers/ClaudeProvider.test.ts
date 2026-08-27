// tests/apps/server/provider/Layers/ClaudeProvider.test.ts
// verifies explicit Claude catalog lifecycle metadata without external probes

import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, it } from '@effect/vitest'
import { ClaudeSettings } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { checkClaudeProviderStatus } from '../../../../../apps/server/src/provider/Layers/ClaudeProvider.ts'

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings)

it.effect(
  'marks only explicitly superseded built-ins and preserves custom model deduplication',
  () =>
    Effect.gen(function* ()
    {
      const provider = yield* checkClaudeProviderStatus(
        decodeClaudeSettings({
          enabled: false,
          customModels: ['claude-opus-4-6', 'claude-future', 'custom-old-model'],
        }),
      )
      assert.deepStrictEqual(
        provider.models.filter((model) => model.isLegacy).map((model) => model.slug),
        [
          'claude-opus-4-8',
          'claude-opus-4-7',
          'claude-opus-4-6',
          'claude-opus-4-5',
          'claude-sonnet-4-6',
        ],
      )
      assert.strictEqual(
        provider.models.filter((model) => model.slug === 'claude-opus-4-6').length,
        1,
      )
      assert.strictEqual(
        provider.models.find((model) => model.slug === 'claude-haiku-4-5')?.isLegacy,
        undefined,
      )
      assert.deepStrictEqual(
        provider.models
          .filter((model) => model.isCustom)
          .map((model) => ({
            slug: model.slug,
            isLegacy: model.isLegacy,
          })),
        [
          { slug: 'claude-future', isLegacy: undefined },
          { slug: 'custom-old-model', isLegacy: undefined },
        ],
      )
    }).pipe(Effect.provide(NodeServices.layer)),
)
