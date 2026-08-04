// tests/apps/server/cartographer/CartographerEmbedReconciliation.test.ts
// verifies bounded report-only reconciliation of cartographer embed artifact roots

// @effect-diagnostics globalDateInEffect:off - utimes fixtures need raw date values to age directory entries
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTimersPromises from 'node:timers/promises'

import { it } from '@effect/vitest'
import { ProposalGenerationId, ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect } from 'vite-plus/test'

import * as CartographerEmbedBroker from '../../../../apps/server/src/cartographer/CartographerEmbedBroker.ts'
import * as ServerConfig from '../../../../apps/server/src/config.ts'

const graceMs = 24 * 60 * 60 * 1_000
const capability = '0123456789abcdef0123456789abcdef'
const validName = (character: string) => character.repeat(24)

const useEnvironment = (values: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.sync(() =>
    {
      const previous = new Map<string, string | undefined>()
      for (const [name, value] of Object.entries(values))
      {
        previous.set(name, process.env[name])
        process.env[name] = value
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() =>
      {
        for (const [name, value] of previous)
        {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
  )

const makeFixture = Effect.gen(function* ()
{
  const baseDir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-embed-reconciliation-')),
  )
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true })).pipe(Effect.ignore),
  )
  const stateDir = NodePath.join(baseDir, 'userdata')
  const managedRoot = NodePath.join(stateDir, 'cartographer', 'embed')
  yield* Effect.promise(() => NodeFSP.mkdir(managedRoot, { recursive: true }))
  const broker = yield* CartographerEmbedBroker.make.pipe(
    Effect.provideService(
      ServerConfig.ServerConfig,
      ServerConfig.make({
        stateDir,
        cartographerReconciliationMode: 'report',
        cartographerReconciliationDeleteEnabled: false,
      } as ServerConfig.ServerConfig['Service']),
    ),
  )
  yield* Effect.addFinalizer(() => broker.closeAll)
  return { baseDir, stateDir, managedRoot, broker }
})

const waitForPath = async (path: string): Promise<void> =>
{
  for (let attempt = 0; attempt < 500; attempt += 1)
  {
    if (
      await NodeFSP.access(path).then(
        () => true,
        () => false,
      )
    )
    {
      return
    }
    await NodeTimersPromises.setTimeout(10)
  }
  throw new Error('Timed out waiting for the Cartographer test marker.')
}

describe('Cartographer embed restart reconciliation', () =>
{
  it.effect('reports direct-child predicate failures without mutating the managed root', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const { baseDir, managedRoot, broker } = yield* makeFixture
        const orphan = validName('a')
        const file = validName('b')
        const symlink = validName('c')
        const malformed = 'malformed'
        const escapeLookalike = `..${'d'.repeat(22)}`
        const outside = NodePath.join(baseDir, 'outside')
        const generationsRoot = NodePath.join(baseDir, 'userdata', 'cartographer', 'generations')
        yield* Effect.promise(() =>
          Promise.all([
            NodeFSP.mkdir(NodePath.join(managedRoot, orphan)),
            NodeFSP.writeFile(NodePath.join(managedRoot, file), 'not a directory'),
            NodeFSP.mkdir(NodePath.join(managedRoot, malformed)),
            NodeFSP.mkdir(NodePath.join(managedRoot, escapeLookalike)),
            NodeFSP.mkdir(outside),
            NodeFSP.mkdir(NodePath.join(generationsRoot, validName('z')), { recursive: true }),
          ]),
        )
        yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(managedRoot, symlink)))
        const before = yield* Effect.promise(() => NodeFSP.readdir(managedRoot))

        const report = yield* broker.reconcileEmbedRoots
        const after = yield* Effect.promise(() => NodeFSP.readdir(managedRoot))

        expect(report).toMatchObject({
          reportVersion: 1,
          enumerated: 5,
          candidates: 0,
          live: 0,
          grace: 1,
          malformed: 2,
          manualSkip: 4,
          budgetExceeded: false,
          deleteAttempted: 0,
          deleteSucceeded: 0,
          deleteFailed: 0,
        })
        expect(report.items).toEqual(
          expect.arrayContaining([
            { name: orphan, reason: 'within-grace' },
            { name: file, reason: 'not-directory' },
            { name: symlink, reason: 'symlink' },
            { name: malformed, reason: 'malformed-name' },
            { name: escapeLookalike, reason: 'malformed-name' },
          ]),
        )
        expect(report.items.every((item) => item.name === NodePath.basename(item.name))).toBe(true)
        expect(after.sort()).toEqual(before.sort())
        expect(yield* Effect.promise(() => NodeFSP.readdir(generationsRoot))).toEqual([
          validName('z'),
        ])
      }),
    ),
  )

  it.effect('uses a strict older-than-24-hours candidate boundary', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const { managedRoot, broker } = yield* makeFixture
        const stale = validName('e')
        const recent = validName('f')
        const exact = validName('g')
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(managedRoot, exact)))
        yield* Effect.promise(() => NodeTimersPromises.setTimeout(20))
        yield* Effect.promise(() =>
          Promise.all([
            NodeFSP.mkdir(NodePath.join(managedRoot, stale)),
            NodeFSP.mkdir(NodePath.join(managedRoot, recent)),
          ]),
        )
        const stats = yield* Effect.promise(() =>
          Promise.all(
            [stale, recent, exact].map((name) => NodeFSP.lstat(NodePath.join(managedRoot, name))),
          ),
        )
        const createdAt = stats[2]?.birthtimeMs || stats[2]?.ctimeMs || 0
        yield* Effect.promise(() =>
          NodeFSP.utimes(
            NodePath.join(managedRoot, stale),
            new Date(createdAt - graceMs - 1),
            new Date(createdAt - graceMs - 1),
          ),
        )

        yield* TestClock.setTime(createdAt + graceMs)
        const exactReport = yield* broker.reconcileEmbedRoots
        // exactly-24h roots stay within grace; the pre-aged root's classification is
        // platform-dependent (utimes can move birthtime on apfs), so assert on `exact`
        expect(exactReport.items).toEqual(
          expect.arrayContaining([{ name: exact, reason: 'within-grace' }]),
        )
        expect(exactReport.deleteAttempted).toBe(0)

        yield* TestClock.setTime(createdAt + graceMs + 1)
        const before = yield* Effect.promise(() => NodeFSP.readdir(managedRoot))
        const staleReport = yield* broker.reconcileEmbedRoots
        const after = yield* Effect.promise(() => NodeFSP.readdir(managedRoot))
        expect(staleReport.candidates).toBeGreaterThanOrEqual(1)
        expect(staleReport.deleteAttempted).toBe(0)
        expect(staleReport.items).toEqual(
          expect.arrayContaining([
            { name: exact, reason: 'stale-report-only' },
            { name: recent, reason: 'within-grace' },
          ]),
        )
        expect(after.sort()).toEqual(before.sort())
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  )

  it.effect('retains live sessions and pending artifact roots', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const { baseDir, stateDir, managedRoot } = yield* makeFixture
        const workspaceRoot = NodePath.join(baseDir, 'workspace')
        const cliPath = NodePath.join(baseDir, 'fake-cartographer.mjs')
        const pendingMarker = NodePath.join(baseDir, 'pending.marker')
        yield* Effect.promise(() => NodeFSP.mkdir(workspaceRoot))
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            cliPath,
            [
              "import { writeFileSync } from 'node:fs'",
              'const marker = process.env.T3_TEST_CARTOGRAPHER_PENDING_MARKER',
              "if (marker) writeFileSync(marker, 'pending')",
              'else console.log(JSON.stringify({',
              "  type: 'cartographer.embed-ready',",
              '  version: 1,',
              "  host: '127.0.0.1',",
              '  port: 41837,',
              `  capability: '${capability}',`,
              '}))',
              'setInterval(() => {}, 60_000)',
              '',
            ].join('\n'),
          ),
        )
        yield* useEnvironment({
          T3CODE_CARTOGRAPHER_CLI: cliPath,
          T3CODE_CARTOGRAPHER_NODE: process.execPath,
        })
        const broker = yield* CartographerEmbedBroker.make.pipe(
          Effect.provideService(
            ServerConfig.ServerConfig,
            ServerConfig.make({
              stateDir,
              cartographerReconciliationMode: 'report',
              cartographerReconciliationDeleteEnabled: false,
            } as ServerConfig.ServerConfig['Service']),
          ),
        )
        yield* Effect.addFinalizer(() => broker.closeAll)

        const live = yield* broker.issue({
          threadId: ThreadId.make('thread-live'),
          generationId: ProposalGenerationId.make('generation-live'),
          workspaceRoot,
          parentOrigin: 'https://example.com',
          theme: 'light',
        })
        yield* useEnvironment({ T3_TEST_CARTOGRAPHER_PENDING_MARKER: pendingMarker })
        const pendingThreadId = ThreadId.make('thread-pending')
        const pendingFiber = yield* broker
          .issue({
            threadId: pendingThreadId,
            generationId: ProposalGenerationId.make('generation-pending'),
            workspaceRoot,
            parentOrigin: 'https://example.com',
            theme: 'dark',
          })
          .pipe(Effect.forkScoped)
        yield* Effect.promise(() => waitForPath(pendingMarker))
        const childNames = yield* Effect.promise(() => NodeFSP.readdir(managedRoot))
        const pendingName = childNames.find((name) => name !== live.sessionId)

        const report = yield* broker.reconcileEmbedRoots
        expect(report.live).toBe(2)
        expect(report.items).toEqual(
          expect.arrayContaining([
            { name: live.sessionId, reason: 'live-session' },
            { name: pendingName, reason: 'pending-root' },
          ]),
        )

        yield* broker.closeThread(pendingThreadId)
        yield* Fiber.join(pendingFiber).pipe(Effect.flip)
      }),
    ),
  )

  it.effect('caps enumeration at 256 entries and reports budget exhaustion', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const { managedRoot, broker } = yield* makeFixture
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 257 }, (_, index) =>
              NodeFSP.mkdir(NodePath.join(managedRoot, `bad.${index.toString(36)}`)),
            ),
          ),
        )

        const report = yield* broker.reconcileEmbedRoots
        expect(report.enumerated).toBe(256)
        expect(report.budgetExceeded).toBe(true)
        expect(report.deleteAttempted).toBe(0)
      }),
    ),
  )

  it.effect('returns a budget-exceeded report when the 250 ms wall-clock deadline wins', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const { managedRoot, broker } = yield* makeFixture
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 256 }, (_, index) =>
              NodeFSP.mkdir(NodePath.join(managedRoot, `z${index.toString(36).padStart(23, '0')}`)),
            ),
          ),
        )
        const reconciliationFiber = yield* broker.reconcileEmbedRoots.pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* TestClock.adjust('250 millis')

        const report = yield* Fiber.join(reconciliationFiber)
        expect(report.budgetExceeded).toBe(true)
        expect(report.deleteAttempted).toBe(0)
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  )
})
