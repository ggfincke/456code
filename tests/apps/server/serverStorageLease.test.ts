// tests/apps/server/serverStorageLease.test.ts
// verifies exclusive canonical storage ownership and conservative stale recovery

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off anyUnknownInErrorContext:off
import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { assert, describe, it } from '@effect/vitest'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'

import * as ServerStorageLease from '../../../apps/server/src/serverStorageLease.ts'

const isLeaseConflict = Schema.is(ServerStorageLease.ServerStorageLeaseConflictError)
const isLeaseBoundary = Schema.is(ServerStorageLease.ServerStorageLeaseBoundaryError)

const stopChild = (child: NodeChildProcess.ChildProcess): Promise<void> =>
  new Promise((resolve) =>
  {
    if (child.exitCode !== null || child.signalCode !== null)
    {
      resolve()
      return
    }
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })

const spawnLockOwner = (
  lockPath: string,
  mutexPath: string,
  canonicalBaseDir: string,
): Promise<NodeChildProcess.ChildProcess> =>
  new Promise((resolve, reject) =>
  {
    const script = `
      const fs = require('node:fs')
      const os = require('node:os')
      const { DatabaseSync } = require('node:sqlite')
      const lockPath = process.argv[1]
      const mutexPath = process.argv[2]
      const canonicalBaseDir = process.argv[3]
      const database = new DatabaseSync(mutexPath)
      database.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 50; BEGIN EXCLUSIVE')
      fs.chmodSync(mutexPath, 0o600)
      const owner = {
        version: 1,
        token: 'child-owner-token',
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        canonicalBaseDir,
      }
      fs.writeFileSync(lockPath, JSON.stringify(owner) + '\\n', { flag: 'wx', mode: 0o600 })
      process.stdout.write('ready\\n')
      process.on('exit', () => {
        try { database.exec('ROLLBACK') } catch {}
        try { database.close() } catch {}
      })
      setInterval(() => {}, 60_000)
    `
    const child = NodeChildProcess.spawn(
      process.execPath,
      ['-e', script, lockPath, mutexPath, canonicalBaseDir],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) =>
    {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) =>
    {
      reject(new Error(`lease owner exited before readiness (${code ?? signal}): ${stderr}`))
    })
    child.stdout?.once('data', () => resolve(child))
  })

describe('ServerStorageLease', () =>
{
  it.effect('rejects a second owner and permits a graceful handoff', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: '456code-lease-test-' })

      yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const owner = yield* ServerStorageLease.acquireServerStorageLease(root)
          assert.equal(
            (yield* Effect.promise(() => NodeFSP.stat(owner.lockPath))).mode & 0o777,
            0o600,
          )
          assert.equal(
            (yield* Effect.promise(() => NodeFSP.stat(owner.mutexPath))).mode & 0o777,
            0o600,
          )
          const error = yield* Effect.scoped(
            ServerStorageLease.acquireServerStorageLease(root),
          ).pipe(Effect.flip)
          assert.isTrue(isLeaseConflict(error))
          if (isLeaseConflict(error)) assert.equal(error.reason, 'active-owner')
        }),
      )

      const nextOwner = yield* ServerStorageLease.acquireServerStorageLease(root)
      assert.equal(nextOwner.canonicalBaseDir, yield* Effect.promise(() => NodeFSP.realpath(root)))
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('canonicalizes aliases and rejects symlink escapes from the leased root', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: '456code-lease-test-' })
      const aliasParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: '456code-lease-alias-test-',
      })
      const alias = NodePath.join(aliasParent, 'storage')
      const outside = NodePath.join(aliasParent, 'outside.sqlite')
      const escaped = NodePath.join(root, 'escaped.sqlite')
      yield* Effect.promise(() => NodeFSP.symlink(root, alias, 'dir'))
      yield* Effect.promise(() => NodeFSP.writeFile(outside, 'outside'))
      yield* Effect.promise(() => NodeFSP.symlink(outside, escaped, 'file'))

      const lease = yield* ServerStorageLease.acquireServerStorageLease(root)
      const conflict = yield* Effect.scoped(
        ServerStorageLease.acquireServerStorageLease(alias),
      ).pipe(Effect.flip)
      assert.isTrue(isLeaseConflict(conflict))

      const boundary = yield* ServerStorageLease.assertLeasedStoragePath(escaped).pipe(
        Effect.provideService(ServerStorageLease.ServerStorageLease, lease),
        Effect.flip,
      )
      assert.isTrue(isLeaseBoundary(boundary))
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('denies a live OS-process owner and recovers its crash residue', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: '456code-lease-test-' })
      const canonicalBaseDir = yield* Effect.promise(() => NodeFSP.realpath(root))
      const lockPath = NodePath.join(canonicalBaseDir, ServerStorageLease.SERVER_STORAGE_LEASE_FILE)
      const mutexPath = NodePath.join(
        canonicalBaseDir,
        ServerStorageLease.SERVER_STORAGE_LEASE_MUTEX_FILE,
      )
      const child = yield* Effect.promise(() =>
        spawnLockOwner(lockPath, mutexPath, canonicalBaseDir),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => stopChild(child)).pipe(Effect.ignore))

      const conflict = yield* Effect.scoped(
        ServerStorageLease.acquireServerStorageLease(root),
      ).pipe(Effect.flip)
      assert.isTrue(isLeaseConflict(conflict))
      if (isLeaseConflict(conflict)) assert.equal(conflict.incumbent?.pid, child.pid)

      yield* Effect.promise(() => stopChild(child))
      const replacement = yield* ServerStorageLease.acquireServerStorageLease(root)
      assert.notEqual(replacement.owner.token, 'child-owner-token')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('fails closed for a recent unreadable owner and recovers it after the grace gate', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: '456code-lease-test-' })
      const lockPath = NodePath.join(root, ServerStorageLease.SERVER_STORAGE_LEASE_FILE)
      yield* Effect.promise(() => NodeFSP.writeFile(lockPath, '{not json', { mode: 0o600 }))

      const conflict = yield* Effect.scoped(
        ServerStorageLease.acquireServerStorageLease(root),
      ).pipe(Effect.flip)
      assert.isTrue(isLeaseConflict(conflict))
      if (isLeaseConflict(conflict)) assert.equal(conflict.reason, 'recent-unreadable-owner')

      const replacement = yield* ServerStorageLease.acquireServerStorageLease(root, {
        recoveryGraceMs: 0,
      })
      assert.equal(
        replacement.owner.canonicalBaseDir,
        yield* Effect.promise(() => NodeFSP.realpath(root)),
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('does not mistake a reused current PID for the recorded process birth', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: '456code-lease-test-' })
      const canonicalBaseDir = yield* Effect.promise(() => NodeFSP.realpath(root))
      const lockPath = NodePath.join(root, ServerStorageLease.SERVER_STORAGE_LEASE_FILE)
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          lockPath,
          `${JSON.stringify({
            version: 1,
            token: 'reused-pid-owner',
            pid: process.pid,
            hostname: NodeOS.hostname(),
            acquiredAt: '2020-01-01T00:00:00.000Z',
            processStartedAt: '2020-01-01T00:00:00.000Z',
            canonicalBaseDir,
          })}\n`,
          { mode: 0o600 },
        ),
      )

      const replacement = yield* ServerStorageLease.acquireServerStorageLease(root)
      assert.notEqual(replacement.owner.token, 'reused-pid-owner')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('serializes simultaneous stale recovery so exactly one replacement owns storage', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: '456code-lease-test-' })
        const canonicalBaseDir = yield* Effect.promise(() => NodeFSP.realpath(root))
        const lockPath = NodePath.join(root, ServerStorageLease.SERVER_STORAGE_LEASE_FILE)
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            lockPath,
            `${JSON.stringify({
              version: 1,
              token: 'stale-owner',
              pid: 2_147_483_647,
              hostname: NodeOS.hostname(),
              acquiredAt: '2020-01-01T00:00:00.000Z',
              processStartedAt: '2020-01-01T00:00:00.000Z',
              canonicalBaseDir,
            })}\n`,
            { mode: 0o600 },
          ),
        )

        const outcomes = yield* Queue.unbounded<
          | { readonly _tag: 'Acquired'; readonly token: string }
          | { readonly _tag: 'Rejected'; readonly error: unknown }
        >()
        const releaseWinner = yield* Deferred.make<void>()
        const contender = Effect.scoped(
          ServerStorageLease.acquireServerStorageLease(root).pipe(
            Effect.tap((lease) =>
              Queue.offer(outcomes, { _tag: 'Acquired', token: lease.owner.token } as const),
            ),
            Effect.andThen(Deferred.await(releaseWinner)),
            Effect.catch((error) => Queue.offer(outcomes, { _tag: 'Rejected', error } as const)),
          ),
        )

        yield* Effect.forkScoped(contender)
        yield* Effect.forkScoped(contender)
        const first = yield* Queue.take(outcomes)
        const second = yield* Queue.take(outcomes)
        const acquired = [first, second].filter((outcome) => outcome._tag === 'Acquired')
        const rejected = [first, second].filter((outcome) => outcome._tag === 'Rejected')
        assert.lengthOf(acquired, 1)
        assert.lengthOf(rejected, 1)
        if (rejected[0]?._tag === 'Rejected') assert.isTrue(isLeaseConflict(rejected[0].error))
        if (acquired[0]?._tag === 'Acquired')
        {
          const current = yield* Effect.promise(() => NodeFSP.readFile(lockPath, 'utf8'))
          assert.include(current, `"token":"${acquired[0].token}"`)
        }
        yield* Deferred.succeed(releaseWinner, undefined)
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  )
})
