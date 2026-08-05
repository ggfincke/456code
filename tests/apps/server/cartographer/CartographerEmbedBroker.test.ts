// tests/apps/server/cartographer/CartographerEmbedBroker.test.ts
// verifies one-time embed authorization and one supervised sidecar per thread
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off

import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodePerfHooks from 'node:perf_hooks'
import * as NodeTimersPromises from 'node:timers/promises'
import * as NodeUtil from 'node:util'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import { ProposalGenerationId, ThreadId } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { describe, expect } from 'vite-plus/test'

import * as CartographerEmbedBroker from '../../../../apps/server/src/cartographer/CartographerEmbedBroker.ts'
import * as ServerConfig from '../../../../apps/server/src/config.ts'

const capability = '0123456789abcdef0123456789abcdef'
const execFile = NodeUtil.promisify(NodeChildProcess.execFile)

async function initializeGitRepository(workspaceRoot: string): Promise<void>
{
  await execFile('git', ['-C', workspaceRoot, 'init'])
  await execFile('git', [
    '-C',
    workspaceRoot,
    'config',
    'user.email',
    'cartographer-embed-test@example.com',
  ])
  await execFile('git', ['-C', workspaceRoot, 'config', 'user.name', 'Cartographer Embed Test'])
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, 'tracked.txt'), 'captured workspace\n')
  await execFile('git', ['-C', workspaceRoot, 'add', 'tracked.txt'])
  await execFile('git', ['-C', workspaceRoot, 'commit', '-m', 'initial'])
}

function useEnvironment(values: Readonly<Record<string, string>>)
{
  return Effect.acquireRelease(
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
          if (value === undefined)
          {
            delete process.env[name]
          }
          else
          {
            process.env[name] = value
          }
        }
      }),
  )
}

async function waitForExit(child: CartographerEmbedBroker.CartographerEmbedSession['child'])
{
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) =>
  {
    child.once('exit', () => resolve())
  })
}

async function pathExists(path: string): Promise<boolean>
{
  return await NodeFSP.access(path).then(
    () => true,
    () => false,
  )
}

async function waitForPath(path: string): Promise<void>
{
  for (let attempt = 0; attempt < 500; attempt += 1)
  {
    if (await pathExists(path)) return
    await NodeTimersPromises.setTimeout(10)
  }
  throw new Error(`Timed out waiting for ${path}.`)
}

describe('CartographerEmbedBroker', () =>
{
  it.effect('confines tickets, cookies, paths, origins, and replacement cleanup', () =>
    Effect.gen(function* ()
    {
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-cartographer-embed-workspace-')),
      )
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-cartographer-embed-state-')),
      )
      yield* Effect.promise(() => initializeGitRepository(workspaceRoot))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const cliPath = NodePath.join(baseDir, 'fake-cartographer-embed.mjs')
      const configuredCliPath = `${baseDir}${NodePath.sep}.${NodePath.sep}fake-cartographer-embed.mjs`
      const configuredNodePath = `${NodePath.dirname(process.execPath)}${NodePath.sep}.${NodePath.sep}${NodePath.basename(process.execPath)}`
      const lifecycleLog = NodePath.join(workspaceRoot, 'embed-lifecycle.ndjson')
      const baseGraphPath = NodePath.join(baseDir, 'verified-base.graph.json')
      const proposedGraphPath = NodePath.join(baseDir, 'verified-proposed.graph.json')
      const impactPath = NodePath.join(baseDir, 'verified-impact.json')
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(baseGraphPath, '{}'),
          NodeFSP.writeFile(proposedGraphPath, '{}'),
          NodeFSP.writeFile(impactPath, '{}'),
        ]),
      )
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          cliPath,
          [
            'import { appendFileSync } from "node:fs"',
            'const log = process.env.T3_TEST_CARTOGRAPHER_EMBED_LOG',
            'appendFileSync(log, `${JSON.stringify({ event: "start", pid: process.pid, args: process.argv.slice(2), execPath: process.execPath, entrypoint: process.argv[1], cwd: process.cwd() })}\\n`)',
            "process.on('SIGTERM', () => {",
            '  appendFileSync(log, `${JSON.stringify({ event: "stop", pid: process.pid })}\\n`)',
            '  process.exit(0)',
            '})',
            'const hangMarker = process.env.T3_TEST_CARTOGRAPHER_HANG_MARKER',
            'if (hangMarker) {',
            '  appendFileSync(hangMarker, "started\\n")',
            '} else {',
            `  console.log(JSON.stringify({ type: "cartographer.embed-ready", version: 1, host: "127.0.0.1", port: 41837, capability: "${capability}" }))`,
            '}',
            'setInterval(() => {}, 60_000)',
            '',
          ].join('\n'),
        ),
      )
      yield* useEnvironment({
        T3CODE_CARTOGRAPHER_CLI: configuredCliPath,
        T3CODE_CARTOGRAPHER_NODE: configuredNodePath,
        T3_TEST_CARTOGRAPHER_EMBED_LOG: lifecycleLog,
      })

      const TestLayer = CartographerEmbedBroker.layer.pipe(
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      )
      yield* Effect.gen(function* ()
      {
        const broker = yield* CartographerEmbedBroker.CartographerEmbedBroker
        const threadId = ThreadId.make('thread-cartographer-embed')

        const invalidOrigin = yield* broker
          .issue({
            threadId,
            workspaceRoot,
            parentOrigin: 'https://example.com/',
            theme: 'light',
          })
          .pipe(Effect.flip)
        expect(invalidOrigin.failure).toBe('start_failed')

        const first = yield* broker.issue({
          threadId,
          generationId: ProposalGenerationId.make('generation-cartographer-embed'),
          workspaceRoot,
          baseGraphPath,
          proposedGraphPath,
          impactPath,
          parentOrigin: 'https://example.com',
          theme: 'dark',
        })
        const firstUrl = new URL(first.url, 'https://host.invalid')
        const firstTicket = firstUrl.searchParams.get('ticket')
        expect(firstTicket).toBeTruthy()
        const firstExchange = yield* broker.exchangeTicket(first.sessionId, firstTicket ?? '')
        expect(firstExchange.redirectPath).toBe(
          `${CartographerEmbedBroker.routePrefix}/${first.sessionId}/`,
        )
        expect(firstExchange.cookie).toContain(
          `Path=${CartographerEmbedBroker.routePrefix}/${first.sessionId}`,
        )
        expect(firstExchange.cookie).toContain('HttpOnly; SameSite=None; Secure; Partitioned')
        expect(firstExchange.cookie).not.toContain('SameSite=Strict')

        const replay = yield* broker
          .exchangeTicket(first.sessionId, firstTicket ?? '')
          .pipe(Effect.flip)
        expect(replay.failure).toBe('ticket_invalid')
        const wrongCookie = yield* broker
          .resolveProxyTarget(first.sessionId, 't3-cartographer-session=wrong', '', '')
          .pipe(Effect.flip)
        expect(wrongCookie.failure).toBe('ticket_invalid')
        const escapedPath = yield* broker
          .resolveProxyTarget(first.sessionId, firstExchange.cookie, 'assets/../private', '')
          .pipe(Effect.flip)
        expect(escapedPath.failure).toBe('proxy_failed')

        const firstTarget = yield* broker.resolveProxyTarget(
          first.sessionId,
          firstExchange.cookie,
          '/assets/index.js',
          '?theme=dark',
        )
        expect(firstTarget.targetUrl).toBe('http://127.0.0.1:41837/assets/index.js?theme=dark')
        expect(firstTarget.session.workspaceRoot).toBe(NodePath.resolve(workspaceRoot))
        expect(firstTarget.session.parentOrigin).toBe('https://example.com')
        expect(firstTarget.session.capability).toBe(capability)
        expect(yield* Effect.promise(() => pathExists(firstTarget.session.artifactRoot))).toBe(true)

        const second = yield* broker.issue({
          threadId,
          workspaceRoot,
          parentOrigin: 'https://example.com',
          theme: 'light',
        })
        expect(second.sessionId).not.toBe(first.sessionId)
        yield* Effect.promise(() => waitForExit(firstTarget.session.child))
        expect(firstTarget.session.child.killed).toBe(true)
        expect(yield* Effect.promise(() => pathExists(firstTarget.session.artifactRoot))).toBe(
          false,
        )
        const replacedSession = yield* broker
          .resolveProxyTarget(first.sessionId, firstExchange.cookie, '', '')
          .pipe(Effect.flip)
        expect(replacedSession.failure).toBe('session_not_found')

        const secondUrl = new URL(second.url, 'https://host.invalid')
        const secondExchange = yield* broker.exchangeTicket(
          second.sessionId,
          secondUrl.searchParams.get('ticket') ?? '',
        )
        const secondTarget = yield* broker.resolveProxyTarget(
          second.sessionId,
          secondExchange.cookie,
          '',
          '',
        )
        expect(secondTarget.session.generationId).toBeNull()
        expect(secondTarget.session.workspaceRoot).not.toBe(NodePath.resolve(workspaceRoot))
        expect(
          secondTarget.session.workspaceRoot.startsWith(secondTarget.session.artifactRoot),
        ).toBe(true)
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(workspaceRoot, 'tracked.txt'), 'later workspace edit\n'),
        )
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(secondTarget.session.workspaceRoot, 'tracked.txt'),
              'utf8',
            ),
          ),
        ).toBe('captured workspace\n')
        yield* broker.releaseSession(threadId, second.sessionId)
        yield* Effect.promise(() => waitForExit(secondTarget.session.child))
        expect(secondTarget.session.child.killed).toBe(true)
        expect(yield* Effect.promise(() => pathExists(secondTarget.session.artifactRoot))).toBe(
          false,
        )
        const closedSession = yield* broker
          .resolveProxyTarget(second.sessionId, secondExchange.cookie, '', '')
          .pipe(Effect.flip)
        expect(closedSession.failure).toBe('session_not_found')

        const reopened = yield* broker.issue({
          threadId,
          workspaceRoot,
          parentOrigin: 'https://example.com',
          theme: 'light',
        })
        const reopenedUrl = new URL(reopened.url, 'https://host.invalid')
        const reopenedExchange = yield* broker.exchangeTicket(
          reopened.sessionId,
          reopenedUrl.searchParams.get('ticket') ?? '',
        )
        const reopenedTarget = yield* broker.resolveProxyTarget(
          reopened.sessionId,
          reopenedExchange.cookie,
          '',
          '',
        )
        yield* broker.closeThread(threadId)
        yield* Effect.promise(() => waitForExit(reopenedTarget.session.child))
        expect(reopenedTarget.session.child.killed).toBe(true)
        const deletedThreadRestart = yield* broker
          .issue({
            threadId,
            workspaceRoot,
            parentOrigin: 'https://example.com',
            theme: 'light',
          })
          .pipe(Effect.flip)
        expect(deletedThreadRestart.failure).toBe('session_not_found')

        const closeAllThreadId = ThreadId.make('thread-cartographer-embed-close-all')
        const third = yield* broker.issue({
          threadId: closeAllThreadId,
          workspaceRoot,
          parentOrigin: 'code456://app',
          theme: 'light',
        })
        const thirdUrl = new URL(third.url, 'https://host.invalid')
        const thirdExchange = yield* broker.exchangeTicket(
          third.sessionId,
          thirdUrl.searchParams.get('ticket') ?? '',
        )
        expect(thirdExchange.cookie).toContain('HttpOnly; SameSite=None; Secure; Partitioned')
        const thirdTarget = yield* broker.resolveProxyTarget(
          third.sessionId,
          thirdExchange.cookie,
          '',
          '',
        )
        const closeAllHangMarker = NodePath.join(baseDir, 'close-all-hanging-start')
        yield* useEnvironment({
          T3_TEST_CARTOGRAPHER_HANG_MARKER: closeAllHangMarker,
        })
        const pendingCloseAllThreadId = ThreadId.make('thread-cartographer-embed-close-all-pending')
        const pendingCloseAllFiber = yield* broker
          .issue({
            threadId: pendingCloseAllThreadId,
            workspaceRoot,
            parentOrigin: 'https://example.com',
            theme: 'light',
          })
          .pipe(Effect.forkScoped)
        yield* Effect.promise(() => waitForPath(closeAllHangMarker))

        yield* broker.closeAll
        const pendingCloseAllFailure = yield* Fiber.join(pendingCloseAllFiber).pipe(Effect.flip)
        expect(pendingCloseAllFailure.failure).toBe('session_not_found')
        yield* Effect.promise(() => waitForExit(thirdTarget.session.child))
        expect(yield* Effect.promise(() => pathExists(thirdTarget.session.artifactRoot))).toBe(
          false,
        )
        const closedAllSession = yield* broker
          .resolveProxyTarget(third.sessionId, thirdExchange.cookie, '', '')
          .pipe(Effect.flip)
        expect(closedAllSession.failure).toBe('session_not_found')
        const afterCloseAll = yield* broker
          .issue({
            threadId: ThreadId.make('thread-cartographer-embed-after-close-all'),
            workspaceRoot,
            parentOrigin: 'https://example.com',
            theme: 'light',
          })
          .pipe(Effect.flip)
        expect(afterCloseAll.failure).toBe('session_not_found')
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readdir(NodePath.join(baseDir, 'userdata', 'cartographer', 'embed')),
          ),
        ).toEqual([])

        const lifecycle = (yield* Effect.promise(() => NodeFSP.readFile(lifecycleLog, 'utf8')))
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as {
                readonly event: string
                readonly args?: ReadonlyArray<string>
                readonly execPath?: string
                readonly entrypoint?: string
                readonly cwd?: string
              },
          )
        expect(lifecycle.filter((entry) => entry.event === 'start')).toHaveLength(5)
        expect(lifecycle.filter((entry) => entry.event === 'stop')).toHaveLength(5)
        const starts = lifecycle.filter((entry) => entry.event === 'start')
        const firstStart = starts[0]
        expect(firstStart?.execPath).toBe(NodePath.normalize(process.execPath))
        expect(firstStart?.entrypoint).toBe(NodePath.normalize(cliPath))
        expect(firstStart?.cwd).toBe(yield* Effect.promise(() => NodeFSP.realpath(workspaceRoot)))
        expect(firstStart?.args).toEqual([
          'embed-server',
          NodePath.resolve(workspaceRoot),
          '--out',
          firstTarget.session.artifactRoot,
          '--parent-origin',
          'https://example.com',
          '--storage-namespace',
          `t3-${first.sessionId}`,
          '--theme',
          'dark',
          '--port',
          '0',
          '--base-graph',
          NodePath.resolve(baseGraphPath),
          '--proposed-graph',
          NodePath.resolve(proposedGraphPath),
          '--impact-artifact',
          NodePath.resolve(impactPath),
        ])
        expect(starts[1]?.cwd).toBe(secondTarget.session.workspaceRoot)
        expect(starts[1]?.args?.slice(0, 4)).toEqual([
          'embed-server',
          secondTarget.session.workspaceRoot,
          '--scope',
          '.',
        ])
      }).pipe(Effect.provide(TestLayer))
    }),
  )

  it.effect('rejects a configured relative Cartographer CLI path before creating artifacts', () =>
    Effect.gen(function* ()
    {
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), '456code-cartographer-relative-cli-workspace-'),
        ),
      )
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-cartographer-relative-cli-state-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      yield* useEnvironment({
        T3CODE_CARTOGRAPHER_CLI: 'relative/cartographer.mjs',
        T3CODE_CARTOGRAPHER_NODE: process.execPath,
      })

      const TestLayer = CartographerEmbedBroker.layer.pipe(
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      )
      yield* Effect.gen(function* ()
      {
        const broker = yield* CartographerEmbedBroker.CartographerEmbedBroker
        const failure = yield* broker
          .issue({
            threadId: ThreadId.make('thread-cartographer-relative-cli'),
            workspaceRoot,
            parentOrigin: 'https://example.com',
            theme: 'light',
          })
          .pipe(Effect.flip)

        expect(failure.failure).toBe('unsupported')
        expect(failure.message).toContain('CLI path must be absolute')
        expect(
          yield* Effect.promise(() =>
            pathExists(NodePath.join(baseDir, 'userdata', 'cartographer', 'embed')),
          ),
        ).toBe(false)
      }).pipe(Effect.provide(TestLayer))
    }),
  )

  it.effect('rejects a configured relative Cartographer Node path before creating artifacts', () =>
    Effect.gen(function* ()
    {
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), '456code-cartographer-relative-node-workspace-'),
        ),
      )
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), '456code-cartographer-relative-node-state-'),
        ),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const cliPath = NodePath.join(baseDir, 'cartographer.mjs')
      yield* Effect.promise(() => NodeFSP.writeFile(cliPath, ''))
      yield* useEnvironment({
        T3CODE_CARTOGRAPHER_CLI: cliPath,
        T3CODE_CARTOGRAPHER_NODE: 'relative/node',
      })

      const TestLayer = CartographerEmbedBroker.layer.pipe(
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      )
      yield* Effect.gen(function* ()
      {
        const broker = yield* CartographerEmbedBroker.CartographerEmbedBroker
        const failure = yield* broker
          .issue({
            threadId: ThreadId.make('thread-cartographer-relative-node'),
            workspaceRoot,
            parentOrigin: 'https://example.com',
            theme: 'light',
          })
          .pipe(Effect.flip)

        expect(failure.failure).toBe('unsupported')
        expect(failure.message).toContain('Node executable path must be absolute')
        expect(
          yield* Effect.promise(() =>
            pathExists(NodePath.join(baseDir, 'userdata', 'cartographer', 'embed')),
          ),
        ).toBe(false)
      }).pipe(Effect.provide(TestLayer))
    }),
  )

  it.effect('stops the child and removes artifacts when readiness is interrupted', () =>
    Effect.gen(function* ()
    {
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), '456code-cartographer-interrupted-workspace-'),
        ),
      )
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-cartographer-interrupted-state-')),
      )
      yield* Effect.promise(() => initializeGitRepository(workspaceRoot))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const cliPath = NodePath.join(baseDir, 'hanging-cartographer.mjs')
      const lifecycleLog = NodePath.join(baseDir, 'interrupted-lifecycle.ndjson')
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          cliPath,
          [
            'import { appendFileSync } from "node:fs"',
            'const log = process.env.T3_TEST_CARTOGRAPHER_EMBED_LOG',
            "process.on('SIGTERM', () => {",
            '  appendFileSync(log, `${JSON.stringify({ event: "stop", pid: process.pid })}\\n`)',
            '  process.exit(0)',
            '})',
            'appendFileSync(log, `${JSON.stringify({ event: "start", pid: process.pid })}\\n`)',
            'setInterval(() => {}, 60_000)',
            '',
          ].join('\n'),
        ),
      )
      yield* useEnvironment({
        T3CODE_CARTOGRAPHER_CLI: cliPath,
        T3CODE_CARTOGRAPHER_NODE: process.execPath,
        T3_TEST_CARTOGRAPHER_EMBED_LOG: lifecycleLog,
      })

      const TestLayer = CartographerEmbedBroker.layer.pipe(
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      )
      yield* Effect.gen(function* ()
      {
        const broker = yield* CartographerEmbedBroker.CartographerEmbedBroker
        const issueFiber = yield* broker
          .issue({
            threadId: ThreadId.make('thread-cartographer-interrupted'),
            workspaceRoot,
            parentOrigin: 'https://example.com',
            theme: 'light',
          })
          .pipe(Effect.forkScoped)

        yield* Effect.promise(() => waitForPath(lifecycleLog))
        const embedRoot = NodePath.join(baseDir, 'userdata', 'cartographer', 'embed')
        const artifactNames = yield* Effect.promise(() => NodeFSP.readdir(embedRoot))
        expect(artifactNames).toHaveLength(1)
        const artifactRoot = NodePath.join(embedRoot, artifactNames[0] ?? '')

        yield* Fiber.interrupt(issueFiber)

        expect(yield* Effect.promise(() => pathExists(artifactRoot))).toBe(false)
        const lifecycle = (yield* Effect.promise(() => NodeFSP.readFile(lifecycleLog, 'utf8')))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { readonly event: string; readonly pid: number })
        expect(lifecycle.map((entry) => entry.event)).toEqual(['start', 'stop'])
        expect(lifecycle[1]?.pid).toBe(lifecycle[0]?.pid)
      }).pipe(Effect.provide(TestLayer))
    }),
  )

  it.effect('tombstones deletion before cancelling a pending startup', () =>
    Effect.gen(function* ()
    {
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), '456code-cartographer-delete-race-workspace-'),
        ),
      )
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-cartographer-delete-race-state-')),
      )
      yield* Effect.promise(() => initializeGitRepository(workspaceRoot))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(workspaceRoot, { recursive: true, force: true }),
            NodeFSP.rm(baseDir, { recursive: true, force: true }),
          ]),
        ).pipe(Effect.ignore),
      )
      const cliPath = NodePath.join(baseDir, 'hanging-cartographer.mjs')
      const lifecycleLog = NodePath.join(baseDir, 'delete-race-lifecycle.ndjson')
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          cliPath,
          [
            'import { appendFileSync } from "node:fs"',
            'const log = process.env.T3_TEST_CARTOGRAPHER_EMBED_LOG',
            "process.on('SIGTERM', () => {",
            '  appendFileSync(log, `${JSON.stringify({ event: "stop", pid: process.pid })}\\n`)',
            '  process.exit(0)',
            '})',
            'appendFileSync(log, `${JSON.stringify({ event: "start", pid: process.pid })}\\n`)',
            'setInterval(() => {}, 60_000)',
            '',
          ].join('\n'),
        ),
      )
      yield* useEnvironment({
        T3CODE_CARTOGRAPHER_CLI: cliPath,
        T3CODE_CARTOGRAPHER_NODE: process.execPath,
        T3_TEST_CARTOGRAPHER_EMBED_LOG: lifecycleLog,
      })

      const TestLayer = CartographerEmbedBroker.layer.pipe(
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      )
      yield* Effect.gen(function* ()
      {
        const broker = yield* CartographerEmbedBroker.CartographerEmbedBroker
        const threadId = ThreadId.make('thread-cartographer-delete-race')
        const issueInput = {
          threadId,
          workspaceRoot,
          parentOrigin: 'https://example.com',
          theme: 'light' as const,
        }
        const firstFiber = yield* broker.issue(issueInput).pipe(Effect.forkScoped)

        yield* Effect.promise(() => waitForPath(lifecycleLog))
        const embedRoot = NodePath.join(baseDir, 'userdata', 'cartographer', 'embed')
        const artifactNames = yield* Effect.promise(() => NodeFSP.readdir(embedRoot))
        expect(artifactNames).toHaveLength(1)
        const artifactRoot = NodePath.join(embedRoot, artifactNames[0] ?? '')

        const queuedFiber = yield* broker.issue(issueInput).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        const closeStartedAt = NodePerfHooks.performance.now()
        const closeFiber = yield* broker.closeThread(threadId).pipe(Effect.forkScoped)
        yield* Effect.yieldNow

        const subsequentFailure = yield* broker.issue(issueInput).pipe(Effect.flip)
        expect(subsequentFailure.failure).toBe('session_not_found')

        yield* Fiber.join(closeFiber)
        expect(NodePerfHooks.performance.now() - closeStartedAt).toBeLessThan(5_000)

        const firstFailure = yield* Fiber.join(firstFiber).pipe(Effect.flip)
        expect(firstFailure.failure).toBe('session_not_found')
        const queuedFailure = yield* Fiber.join(queuedFiber).pipe(Effect.flip)
        expect(queuedFailure.failure).toBe('session_not_found')
        expect(yield* Effect.promise(() => pathExists(artifactRoot))).toBe(false)

        const lifecycle = (yield* Effect.promise(() => NodeFSP.readFile(lifecycleLog, 'utf8')))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { readonly event: string; readonly pid: number })
        expect(lifecycle.map((entry) => entry.event)).toEqual(['start', 'stop'])
        expect(lifecycle[1]?.pid).toBe(lifecycle[0]?.pid)
      }).pipe(Effect.provide(TestLayer))
    }),
  )
})
