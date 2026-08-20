// tests/apps/server/provider/opencodeRuntime.inventory.test.ts
// verifies optional OpenCode inventory sources degrade independently

import * as NodeAssert from 'node:assert/strict'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import {
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  type OpenCodeRuntimeShape,
} from '../../../../apps/server/src/provider/opencodeRuntime.ts'

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer))

it.layer(testLayer)('loadOpenCodeInventory', (it) =>
{
  it.effect('keeps provider inventory when skill discovery fails', () =>
    Effect.gen(function* ()
    {
      const runtime = yield* OpenCodeRuntime
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: { connected: ['openai'], all: [], default: {} },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.reject(new Error('skills endpoint unavailable')),
        },
      } as unknown as Parameters<OpenCodeRuntimeShape['loadOpenCodeInventory']>[0]

      const inventory = yield* runtime.loadOpenCodeInventory(client)

      NodeAssert.deepEqual(inventory.providerList.connected, ['openai'])
      NodeAssert.deepEqual(inventory.agents, [])
      NodeAssert.deepEqual(inventory.skills, [])
    }),
  )
})
