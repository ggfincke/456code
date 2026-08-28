// tests/apps/server/provider/opencodeRuntime.inventory.test.ts
// verifies optional OpenCode inventory sources degrade independently

import * as NodeAssert from 'node:assert/strict'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from '@t3tools/shared/hostProcess'

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

  it.effect('keeps provider inventory when optional agent discovery fails', () =>
    Effect.gen(function* ()
    {
      const runtime = yield* OpenCodeRuntime
      const client = {
        provider: {
          list: () => Promise.resolve({ data: { connected: ['openai'], all: [], default: {} } }),
        },
        app: {
          agents: () => Promise.reject(new Error('agents endpoint unavailable')),
          skills: () => Promise.resolve({ data: [] }),
        },
      } as unknown as Parameters<OpenCodeRuntimeShape['loadOpenCodeInventory']>[0]
      const inventory = yield* runtime.loadOpenCodeInventory(client)
      NodeAssert.deepEqual(inventory.providerList.connected, ['openai'])
      NodeAssert.deepEqual(inventory.agents, [])
    }),
  )

  it.effect('aborts every in-flight SDK inventory request when its borrower is interrupted', () =>
    Effect.gen(function* ()
    {
      const runtime = yield* OpenCodeRuntime
      const entered = yield* Deferred.make<void>()
      const signals: AbortSignal[] = []
      const pending = (_parameters?: unknown, options?: { signal?: AbortSignal }) =>
      {
        if (options?.signal) signals.push(options.signal)
        if (signals.length === 3) Deferred.doneUnsafe(entered, Effect.void)
        return new Promise(() => undefined)
      }
      const client = {
        provider: { list: pending },
        app: { agents: pending, skills: pending },
      } as unknown as Parameters<OpenCodeRuntimeShape['loadOpenCodeInventory']>[0]
      const fiber = yield* runtime.loadOpenCodeInventory(client).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const result = yield* Fiber.await(fiber)
      NodeAssert.equal(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause), true)
      NodeAssert.equal(signals.length, 3)
      NodeAssert.equal(
        signals.every((signal) => signal.aborted),
        true,
      )
    }),
  )

  it.effect('retains only SDK skill metadata', () =>
    Effect.gen(function* ()
    {
      const runtime = yield* OpenCodeRuntime
      const client = {
        provider: {
          list: () => Promise.resolve({ data: { connected: ['openai'], all: [], default: {} } }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () =>
            Promise.resolve({
              data: [
                {
                  name: 'review',
                  description: 'Review code changes',
                  location: '/skills/review/SKILL.md',
                  content: 'unused skill content',
                },
              ],
            }),
        },
      } as unknown as Parameters<OpenCodeRuntimeShape['loadOpenCodeInventory']>[0]

      const inventory = yield* runtime.loadOpenCodeInventory(client)

      NodeAssert.deepEqual(inventory.skills, [
        {
          name: 'review',
          description: 'Review code changes',
          location: '/skills/review/SKILL.md',
        },
      ])
    }),
  )

  it.effect('drops oversized CLI skill output without losing model inventory', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const hostEnvironment = yield* HostProcessEnvironment
      const executablePath = yield* HostProcessExecutablePath
      const hostPlatform = yield* HostProcessPlatform
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-opencode-inventory-' })
      const isWindows = hostPlatform === 'win32'
      const binaryPath = path.join(tempDir, isWindows ? 'opencode.cmd' : 'opencode')
      const fixturePath = new URL('./testFixtures/openCodeOversizedSkillsMock.mjs', import.meta.url)
        .pathname

      yield* fs.writeFileString(
        binaryPath,
        [
          ...(isWindows ? ['@echo off'] : ['#!/bin/sh']),
          isWindows
            ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
            : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
          '',
        ].join('\n'),
      )
      if (!isWindows)
      {
        yield* fs.chmod(binaryPath, 0o755)
      }

      const runtime = yield* OpenCodeRuntime
      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath,
        cwd: tempDir,
        environment: {
          ...hostEnvironment,
          T3_TEST_NODE_BINARY: executablePath,
          T3_TEST_OPENCODE_SCRIPT: fixturePath,
        },
      })

      NodeAssert.deepEqual(inventory.providerList.connected, ['openai'])
      NodeAssert.equal(inventory.skills.length, 0)
    }),
  )

  it.effect('caps and drains command stdout and stderr when requested', () =>
    Effect.gen(function* ()
    {
      const runtime = yield* OpenCodeRuntime
      const executablePath = yield* HostProcessExecutablePath
      const outputBytes = 2 * 1024 * 1024
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          '-e',
          `process.stdout.write('o'.repeat(${outputBytes})); process.stderr.write('e'.repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      })

      NodeAssert.equal(result.stdout, 'o'.repeat(64))
      NodeAssert.equal(result.stderr, 'e'.repeat(64))
      NodeAssert.equal(result.code, 0)
    }),
  )
})
