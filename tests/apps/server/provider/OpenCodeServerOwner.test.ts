// tests/apps/server/provider/OpenCodeServerOwner.test.ts
// protect shared OpenCode server leases, cancellation, & idle cleanup

import { it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Ref from 'effect/Ref'
import * as TestClock from 'effect/testing/TestClock'
import { expect } from 'vite-plus/test'

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from '../../../../apps/server/src/provider/opencodeRuntime.ts'
import * as OpenCodeServerOwner from '../../../../apps/server/src/provider/OpenCodeServerOwner.ts'

const makeRuntime = (
  startOpenCodeServerProcess: OpenCodeRuntimeShape['startOpenCodeServerProcess'],
): OpenCodeRuntimeShape => ({
  startOpenCodeServerProcess,
  connectToOpenCodeServer: () => Effect.die('unused runtime method'),
  runOpenCodeCommand: () => Effect.die('unused runtime method'),
  createOpenCodeSdkClient: () => ({}) as never,
  loadOpenCodeInventory: () => Effect.die('unused runtime method'),
  loadInventoryFromCli: () => Effect.die('unused runtime method'),
})

const makeServer = Effect.fn('makeServer')(function* (index: number)
{
  const running = yield* Ref.make(true)
  const exited = yield* Deferred.make<number>()
  const closed = yield* Deferred.make<void>()
  return {
    running,
    exited,
    closed,
    handle: {
      url: `http://127.0.0.1:${index}`,
      version: '1.14.19',
      isRunning: Ref.get(running),
      exitCode: Deferred.await(exited),
    },
  }
})

it.effect('shares concurrent borrowers and cancels the previous idle deadline on reborrow', () =>
  Effect.gen(function* ()
  {
    const starts = yield* Ref.make(0)
    const server = yield* makeServer(1)
    const runtime = makeRuntime(() =>
      Effect.gen(function* ()
      {
        yield* Ref.update(starts, (count) => count + 1)
        yield* Effect.addFinalizer(() => Deferred.succeed(server.closed, undefined))
        return server.handle
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: 'opencode',
          directory: '/project',
        })
        const entered = yield* Ref.make(0)
        const bothEntered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const use = owner.withServer((handle) =>
          Effect.gen(function* ()
          {
            if ((yield* Ref.updateAndGet(entered, (count) => count + 1)) === 2)
            {
              yield* Deferred.succeed(bothEntered, undefined)
            }
            yield* Deferred.await(release)
            return handle.url
          }),
        )
        const borrowers = yield* Effect.all([use, use], { concurrency: 'unbounded' }).pipe(
          Effect.forkChild,
        )
        yield* Deferred.await(bothEntered)
        expect(yield* Ref.get(starts)).toBe(1)
        yield* TestClock.adjust('31 seconds')
        expect(yield* Deferred.isDone(server.closed)).toBe(false)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(borrowers)).toEqual([server.handle.url, server.handle.url])

        yield* TestClock.adjust('20 seconds')
        const reentered = yield* Deferred.make<void>()
        const releaseAgain = yield* Deferred.make<void>()
        const reborrower = yield* owner
          .withServer(() =>
            Deferred.succeed(reentered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseAgain)),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(reentered)
        yield* TestClock.adjust('11 seconds')
        expect(yield* Ref.get(starts)).toBe(1)
        expect(yield* Deferred.isDone(server.closed)).toBe(false)
        yield* Deferred.succeed(releaseAgain, undefined)
        yield* Fiber.join(reborrower)
        yield* TestClock.adjust('29 seconds')
        expect(yield* Deferred.isDone(server.closed)).toBe(false)
        yield* TestClock.adjust('1 second')
        yield* Deferred.await(server.closed)
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime))
  }).pipe(Effect.provide(TestClock.layer())),
)

it.effect('closes a canceled startup scope and lets a waiting borrower retry', () =>
  Effect.gen(function* ()
  {
    const starts = yield* Ref.make(0)
    const firstEntered = yield* Deferred.make<void>()
    const firstClosed = yield* Deferred.make<void>()
    const server = yield* makeServer(2)
    const environment = { OPENCODE_SERVER_PASSWORD: 'environment-password' }
    const runtime = makeRuntime((input) =>
      Effect.gen(function* ()
      {
        expect(input).toEqual({
          binaryPath: 'custom-opencode',
          directory: '/project',
          serverPassword: 'explicit-password',
          environment,
        })
        const index = yield* Ref.updateAndGet(starts, (count) => count + 1)
        if (index === 1)
        {
          yield* Effect.addFinalizer(() => Deferred.succeed(firstClosed, undefined))
          yield* Deferred.succeed(firstEntered, undefined)
          return yield* Effect.never
        }
        yield* Effect.addFinalizer(() => Deferred.succeed(server.closed, undefined))
        return server.handle
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: 'custom-opencode',
          directory: '/project',
          serverPassword: 'explicit-password',
          environment,
        })
        const first = yield* owner
          .withServer((handle) => Effect.succeed(handle.url))
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        const waiting = yield* owner
          .withServer((handle) => Effect.succeed(handle.url))
          .pipe(Effect.forkChild)
        yield* Fiber.interrupt(first)
        const interrupted = yield* Fiber.await(first)
        expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
        yield* Deferred.await(firstClosed)
        expect(yield* Fiber.join(waiting)).toBe(server.handle.url)
        expect(yield* Ref.get(starts)).toBe(2)
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime))
    expect(yield* Deferred.isDone(server.closed)).toBe(true)
  }),
)

for (const invalidation of ['exit', 'liveness'] as const)
{
  it.effect(
    `invalidates a dead handle through ${invalidation} without an older borrower releasing its replacement`,
    () =>
      Effect.gen(function* ()
      {
        const firstServer = yield* makeServer(1)
        const replacement = yield* makeServer(2)
        const starts = yield* Ref.make(0)
        const runtime = makeRuntime(() =>
          Effect.gen(function* ()
          {
            const index = yield* Ref.updateAndGet(starts, (count) => count + 1)
            const server = index === 1 ? firstServer : replacement
            yield* Effect.addFinalizer(() => Deferred.succeed(server.closed, undefined))
            return server.handle
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* ()
          {
            const owner = yield* OpenCodeServerOwner.make({
              binaryPath: 'opencode',
              directory: '/project',
            })
            const firstEntered = yield* Deferred.make<void>()
            const firstRelease = yield* Deferred.make<void>()
            const first = yield* owner
              .withServer(() =>
                Deferred.succeed(firstEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(firstRelease)),
                ),
              )
              .pipe(Effect.forkChild)
            yield* Deferred.await(firstEntered)
            if (invalidation === 'exit')
            {
              yield* Deferred.succeed(firstServer.exited, 1)
              yield* Deferred.await(firstServer.closed)
            }
            else
            {
              yield* Ref.set(firstServer.running, false)
            }
            const replacementEntered = yield* Deferred.make<void>()
            const replacementRelease = yield* Deferred.make<void>()
            const second = yield* owner
              .withServer((handle) =>
                Deferred.succeed(replacementEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(replacementRelease)),
                  Effect.as(handle.url),
                ),
              )
              .pipe(Effect.forkChild)
            yield* Deferred.await(replacementEntered)
            expect(yield* Deferred.isDone(firstServer.closed)).toBe(true)
            yield* Deferred.succeed(firstServer.exited, 1)
            yield* Deferred.succeed(firstRelease, undefined)
            yield* Fiber.join(first)
            yield* TestClock.adjust('31 seconds')
            expect(yield* Ref.get(starts)).toBe(2)
            expect(yield* Deferred.isDone(replacement.closed)).toBe(false)
            yield* Deferred.succeed(replacementRelease, undefined)
            expect(yield* Fiber.join(second)).toBe(replacement.handle.url)
            yield* TestClock.adjust('30 seconds')
            yield* Deferred.await(replacement.closed)
          }),
        ).pipe(Effect.provideService(OpenCodeRuntime, runtime))
      }).pipe(Effect.provide(TestClock.layer())),
  )
}

it.effect('retries a failed start and closes the borrowed server on owner scope shutdown', () =>
  Effect.gen(function* ()
  {
    const starts = yield* Ref.make(0)
    const failedClosed = yield* Deferred.make<void>()
    const server = yield* makeServer(2)
    const runtime = makeRuntime(() =>
      Effect.gen(function* ()
      {
        const index = yield* Ref.updateAndGet(starts, (count) => count + 1)
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(index === 1 ? failedClosed : server.closed, undefined),
        )
        if (index === 1)
        {
          return yield* new OpenCodeRuntimeError({
            operation: 'startOpenCodeServerProcess',
            detail: 'start failed',
          })
        }
        return server.handle
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* ()
      {
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: 'opencode',
          directory: '/project',
        })
        expect(Exit.isFailure(yield* Effect.exit(owner.withServer(() => Effect.void)))).toBe(true)
        expect(yield* Deferred.isDone(failedClosed)).toBe(true)
        expect(yield* owner.withServer((handle) => Effect.succeed(handle.url))).toBe(
          server.handle.url,
        )
        expect(yield* Deferred.isDone(server.closed)).toBe(false)
      }),
    ).pipe(Effect.provideService(OpenCodeRuntime, runtime))
    expect(yield* Deferred.isDone(server.closed)).toBe(true)
  }),
)
