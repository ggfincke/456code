// tests/apps/server/bin.test.ts
// verify bin behavior

// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from 'node:http'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import {
  AuthAdministrativeScopes,
  CommandId,
  DispatchResult,
  EnvironmentHttpApi,
  EnvironmentOrchestrationCommandUnsupportedError,
  EnvironmentOrchestrationHttpApi,
  EnvironmentProjectCommandV1,
  OrchestrationShellSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import * as NetService from '@t3tools/shared/Net'
import { assert, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as DateTime from 'effect/DateTime'
import * as Layer from 'effect/Layer'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServer from 'effect/unstable/http/HttpServer'
import { FetchHttpClient } from 'effect/unstable/http'
import * as HttpApi from 'effect/unstable/httpapi/HttpApi'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'
import * as HttpApiClient from 'effect/unstable/httpapi/HttpApiClient'
import * as HttpApiEndpoint from 'effect/unstable/httpapi/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/unstable/httpapi/HttpApiGroup'
import * as CliError from 'effect/unstable/cli/CliError'
import * as TestConsole from 'effect/testing/TestConsole'
import { Command } from 'effect/unstable/cli'

import { cli, makeCli } from '../../../apps/server/src/bin.ts'
import { ProjectLiveServerIncompatibleError } from '../../../apps/server/src/cli/project.ts'
import * as ServerConfig from '../../../apps/server/src/config.ts'
import * as ServerEnvironment from '../../../apps/server/src/environment/ServerEnvironment.ts'
import * as ServerStorageLease from '../../../apps/server/src/serverStorageLease.ts'
import * as ProjectionSnapshotQuery from '../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import * as OrchestrationEngine from '../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { OrchestrationLayerLive } from '../../../apps/server/src/orchestration/runtimeLayer.ts'
import { orchestrationHttpApiLayer } from '../../../apps/server/src/orchestration/http.ts'
import { layerConfig as SqlitePersistenceLayerLive } from '../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as RepositoryIdentityResolver from '../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from '../../../apps/server/src/serverRuntimeState.ts'
import * as WorkspacePaths from '../../../apps/server/src/workspace/WorkspacePaths.ts'
import * as ServerSecretStore from '../../../apps/server/src/auth/ServerSecretStore.ts'
import * as EnvironmentAuth from '../../../apps/server/src/auth/EnvironmentAuth.ts'
import { environmentAuthenticatedAuthLayer } from '../../../apps/server/src/auth/http.ts'

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer)
class ProjectCliHttpApi extends HttpApi.make('environment').add(EnvironmentOrchestrationHttpApi)
{}

class LegacyProjectCliOrchestrationHttpApi extends HttpApiGroup.make('orchestration')
  .add(
    HttpApiEndpoint.get('shellSnapshot', '/api/orchestration/shell', {
      success: OrchestrationShellSnapshot,
    }),
  )
  .add(
    HttpApiEndpoint.post('dispatch', '/api/orchestration/dispatch', {
      payload: EnvironmentProjectCommandV1,
      success: DispatchResult,
    }),
  )
  {}

class LegacyProjectCliHttpApi extends HttpApi.make('environment').add(
  LegacyProjectCliOrchestrationHttpApi,
)
{}

const legacyProjectCliHttpApiLayer = HttpApiBuilder.group(
  LegacyProjectCliHttpApi,
  'orchestration',
  Effect.fnUntraced(function* (handlers)
  {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService

    return handlers
      .handle('shellSnapshot', () => projectionSnapshotQuery.getShellSnapshot().pipe(Effect.orDie))
      .handle('dispatch', (args) => orchestrationEngine.dispatch(args.payload).pipe(Effect.orDie))
  }),
)

const localCli = makeCli()
const runCli = (args: ReadonlyArray<string>, command = cli) =>
  Command.runWith(command, { version: '0.0.0' })(args)
const runCliWithRuntime = (args: ReadonlyArray<string>) =>
  runCli(args).pipe(Effect.provide(CliRuntimeLayer))

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* ()
  {
    const result = yield* effect
    const output =
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === 'string') ??
      ''
    return { result, output }
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)))

const makeCliTestServerConfig = (baseDir: string) =>
  Effect.gen(function* ()
  {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined)
    return {
      logLevel: 'Info',
      traceMinLevel: 'Info',
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: 't3-server',
      mode: 'web',
      port: 0,
      host: '127.0.0.1',
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: 'browser',
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig['Service']
  })

const makeProjectPersistenceLayer = (
  config: ServerConfig.ServerConfig['Service'],
  storageLease: ServerStorageLease.ServerStorageLease['Service'],
) =>
  Layer.mergeAll(
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceLayerLive),
    ),
    WorkspacePaths.layer,
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerStorageLease.layer(storageLease)),
    Layer.provide(ServerConfig.layer(config)),
  )

const withProjectStorageLease = <A, E, R>(
  config: ServerConfig.ServerConfig['Service'],
  run: (storageLease: ServerStorageLease.ServerStorageLease['Service']) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const storageLease = yield* ServerStorageLease.acquireServerStorageLease(config.baseDir)
      yield* ServerConfig.ensureServerDirectories(config)
      return yield* run(storageLease)
    }),
  )

const readPersistedSnapshot = (baseDir: string) =>
  Effect.gen(function* ()
  {
    const config = yield* makeCliTestServerConfig(baseDir)
    return yield* withProjectStorageLease(config, (storageLease) =>
      Effect.gen(function* ()
      {
        const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
        return yield* projectionSnapshotQuery.getSnapshot()
      }).pipe(Effect.provide(makeProjectPersistenceLayer(config, storageLease))),
    )
  })

const withLiveProjectCliServer = <A, E, R>(
  baseDir: string,
  run: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* ()
  {
    const config = yield* makeCliTestServerConfig(baseDir)
    return yield* withProjectStorageLease(config, (storageLease) =>
    {
      const routesLayer = HttpApiBuilder.layer(ProjectCliHttpApi).pipe(
        Layer.provide(orchestrationHttpApiLayer),
        Layer.provide(environmentAuthenticatedAuthLayer),
      )
      const appLayer = HttpRouter.serve(routesLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(
          EnvironmentAuth.layer.pipe(
            Layer.provideMerge(SqlitePersistenceLayerLive),
            Layer.provide(ServerEnvironment.layer),
            Layer.provide(ServerSecretStore.layer),
          ),
        ),
        Layer.provideMerge(makeProjectPersistenceLayer(config, storageLease)),
        Layer.provideMerge(
          NodeHttpServer.layer(NodeHttp.createServer, {
            host: '127.0.0.1',
            port: 0,
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(ServerConfig.layer(config)),
      )

      return Effect.scoped(
        Effect.gen(function* ()
        {
          const server = yield* HttpServer.HttpServer
          const address = server.address
          if (typeof address === 'string' || !('port' in address))
          {
            assert.fail(`Expected TCP address, got ${address}`)
          }
          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
            storageLeaseToken: storageLease.owner.token,
          })
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          })
          return yield* run(state.origin)
        }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
      )
    })
  })

const withLegacyProjectCliServer = <A, E, R>(
  baseDir: string,
  run: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* ()
  {
    const config = yield* makeCliTestServerConfig(baseDir)
    return yield* withProjectStorageLease(config, (storageLease) =>
    {
      const routesLayer = HttpApiBuilder.layer(LegacyProjectCliHttpApi).pipe(
        Layer.provide(legacyProjectCliHttpApiLayer),
      )
      const appLayer = HttpRouter.serve(routesLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(makeProjectPersistenceLayer(config, storageLease)),
        Layer.provideMerge(
          NodeHttpServer.layer(NodeHttp.createServer, {
            host: '127.0.0.1',
            port: 0,
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(ServerConfig.layer(config)),
      )

      return Effect.scoped(
        Effect.gen(function* ()
        {
          const server = yield* HttpServer.HttpServer
          const address = server.address
          if (typeof address === 'string' || !('port' in address))
          {
            assert.fail(`Expected TCP address, got ${address}`)
          }
          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
            storageLeaseToken: storageLease.owner.token,
          })
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          })
          return yield* run(state.origin)
        }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
      )
    })
  })

it.layer(NodeServices.layer)('bin cli parsing', (it) =>
{
  it.effect('rejects invalid log-level casing before launching the server', () =>
    Effect.gen(function* ()
    {
      const error = yield* runCliWithRuntime(['--log-level', 'Debug']).pipe(Effect.flip)

      if (!CliError.isCliError(error))
      {
        assert.fail(`Expected CliError, got ${String(error)}`)
      }
      if (error._tag !== 'InvalidValue')
      {
        assert.fail(`Expected InvalidValue, got ${error._tag}`)
      }
      assert.equal(error.option, 'log-level')
      assert.equal(error.value, 'Debug')
    }),
  )

  it.effect('exposes service lifecycle commands', () =>
    Effect.gen(function* ()
    {
      const { output } = yield* captureStdout(runCli(['service', '--help'], localCli))

      assert.include(output, 'Manage the 456code background service.')
      assert.include(output, 'install')
      assert.include(output, 'uninstall')
      assert.include(output, 'update')
      assert.include(output, 'status')
    }),
  )

  it.effect('reads service state without acquiring the owned storage lease', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), 't3-cli-service-probe-test-'),
        )
        yield* ServerStorageLease.acquireServerStorageLease(baseDir)
        const home = NodePath.join(baseDir, 'home')
        NodeFS.mkdirSync(home, { recursive: true })
        const probeLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } }))

        const status = yield* captureStdout(
          runCli(['service', 'status', '--base-dir', baseDir], localCli),
        ).pipe(Effect.provide(probeLayer), Effect.provideService(HostProcessPlatform, 'linux'))
        const uninstall = yield* captureStdout(
          runCli(['service', 'uninstall', '--base-dir', baseDir], localCli),
        ).pipe(Effect.provide(probeLayer), Effect.provideService(HostProcessPlatform, 'linux'))

        assert.include(status.output, 'Status: not installed')
        assert.include(uninstall.output, 'service is not installed')
      }),
    ),
  )

  it.effect('executes auth pairing subcommands and redacts secrets from list output', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-auth-pairing-test-'),
      )

      const createdOutput = yield* captureStdout(
        runCli(['auth', 'pairing', 'create', '--base-dir', baseDir, '--json']),
      )
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const created = JSON.parse(createdOutput.output) as {
        readonly id: string
        readonly credential: string
      }
      const listedOutput = yield* captureStdout(
        runCli(['auth', 'pairing', 'list', '--base-dir', baseDir, '--json']),
      )
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly id: string
        readonly credential?: string
      }>

      assert.equal(typeof created.id, 'string')
      assert.equal(typeof created.credential, 'string')
      assert.equal(created.credential.length > 0, true)
      assert.equal(listed.length, 1)
      assert.equal(listed[0]?.id, created.id)
      assert.equal('credential' in (listed[0] ?? {}), false)
    }),
  )

  it.effect('executes auth session subcommands and redacts secrets from list output', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-auth-session-test-'),
      )

      const issuedOutput = yield* captureStdout(
        runCli(['auth', 'session', 'issue', '--base-dir', baseDir, '--json']),
      )
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const issued = JSON.parse(issuedOutput.output) as {
        readonly sessionId: string
        readonly token: string
        readonly scopes: ReadonlyArray<string>
      }
      const recoveryOutput = yield* captureStdout(
        runCli(['auth', 'session', 'issue', '--base-dir', baseDir, '--recovery', '--json']),
      )
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const recovery = JSON.parse(recoveryOutput.output) as {
        readonly sessionId: string
        readonly token: string
        readonly scopes: ReadonlyArray<string>
      }
      const listedOutput = yield* captureStdout(
        runCli(['auth', 'session', 'list', '--base-dir', baseDir, '--json']),
      )
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly sessionId: string
        readonly token?: string
        readonly scopes: ReadonlyArray<string>
      }>

      assert.equal(typeof issued.sessionId, 'string')
      assert.equal(typeof issued.token, 'string')
      assert.deepEqual(issued.scopes, [
        'orchestration:read',
        'orchestration:operate',
        'terminal:operate',
        'review:write',
        'relay:read',
        'access:read',
        'access:write',
        'relay:write',
      ])
      assert.notInclude(issued.scopes, 'orchestration:recover')
      assert.include(recovery.scopes, 'orchestration:recover')
      assert.equal(listed.length, 2)
      const listedDefault = listed.find((session) => session.sessionId === issued.sessionId)
      const listedRecovery = listed.find((session) => session.sessionId === recovery.sessionId)
      assert.deepEqual(listedDefault?.scopes, [
        'orchestration:read',
        'orchestration:operate',
        'terminal:operate',
        'review:write',
        'relay:read',
        'access:read',
        'access:write',
        'relay:write',
      ])
      assert.include(listedRecovery?.scopes ?? [], 'orchestration:recover')
      assert.equal('token' in (listedDefault ?? {}), false)
      assert.equal('token' in (listedRecovery ?? {}), false)
    }),
  )

  it.effect('rejects invalid ttl values before running auth commands', () =>
    Effect.gen(function* ()
    {
      const error = yield* runCliWithRuntime(['auth', 'pairing', 'create', '--ttl', 'soon']).pipe(
        Effect.flip,
      )

      if (!CliError.isCliError(error))
      {
        assert.fail(`Expected CliError, got ${String(error)}`)
      }
      if (error._tag !== 'ShowHelp')
      {
        assert.fail(`Expected ShowHelp, got ${error._tag}`)
      }
      assert.deepEqual(error.commandPath, ['456code', 'auth', 'pairing', 'create'])
      const ttlError = error.errors[0] as CliError.CliError | undefined
      if (!ttlError || ttlError._tag !== 'InvalidValue')
      {
        assert.fail(`Expected InvalidValue, got ${String(ttlError?._tag)}`)
      }
      assert.equal(ttlError.option, 'ttl')
      assert.equal(ttlError.value, 'soon')
      assert.isTrue(ttlError.message.includes('Invalid duration'))
      assert.isTrue(ttlError.message.includes('5m, 1h, 30d, or 15 minutes'))
    }),
  )

  it.effect('adds, renames, and removes projects offline through the orchestration engine', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-offline-test-'),
      )
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-workspace-'),
      )

      yield* runCliWithRuntime([
        'project',
        'add',
        workspaceRoot,
        '--title',
        'Alpha',
        '--base-dir',
        baseDir,
      ])
      const afterAdd = yield* readPersistedSnapshot(baseDir)
      const addedProject = afterAdd.projects.find(
        (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
      )
      assert.isTrue(addedProject !== undefined)
      assert.equal(addedProject?.title, 'Alpha')

      yield* runCliWithRuntime(['project', 'rename', workspaceRoot, 'Beta', '--base-dir', baseDir])
      const afterRename = yield* readPersistedSnapshot(baseDir)
      const renamedProject = afterRename.projects.find((project) => project.id === addedProject?.id)
      assert.equal(renamedProject?.title, 'Beta')
      assert.equal(renamedProject?.deletedAt, null)

      yield* runCliWithRuntime(['project', 'remove', addedProject?.id ?? '', '--base-dir', baseDir])
      const afterRemove = yield* readPersistedSnapshot(baseDir)
      const removedProject = afterRemove.projects.find((project) => project.id === addedProject?.id)
      assert.isTrue((removedProject?.deletedAt ?? null) !== null)
    }),
  )

  it.effect('force removes projects that still contain threads', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-force-remove-test-'),
      )
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-force-remove-workspace-'),
      )

      yield* runCliWithRuntime(['project', 'add', workspaceRoot, '--base-dir', baseDir])
      const afterAdd = yield* readPersistedSnapshot(baseDir)
      const project = afterAdd.projects.find(
        (candidate) => candidate.workspaceRoot === workspaceRoot && candidate.deletedAt === null,
      )
      assert.isTrue(project !== undefined)

      const config = yield* makeCliTestServerConfig(baseDir)
      yield* withProjectStorageLease(config, (storageLease) =>
        Effect.gen(function* ()
        {
          const engine = yield* OrchestrationEngine.OrchestrationEngineService
          yield* engine.dispatch({
            type: 'thread.create',
            commandId: CommandId.make('cmd-cli-force-remove-thread'),
            threadId: ThreadId.make('thread-cli-force-remove'),
            projectId: project!.id,
            title: 'Thread',
            modelSelection: {
              instanceId: ProviderInstanceId.make('codex'),
              model: 'gpt-5-codex',
            },
            interactionMode: 'default',
            runtimeMode: 'approval-required',
            branch: null,
            worktreePath: null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
        }).pipe(Effect.provide(makeProjectPersistenceLayer(config, storageLease))),
      )

      yield* runCliWithRuntime(['project', 'remove', project!.id, '--force', '--base-dir', baseDir])
      const afterRemove = yield* readPersistedSnapshot(baseDir)
      assert.isTrue(
        (afterRemove.projects.find((candidate) => candidate.id === project!.id)?.deletedAt ??
          null) !== null,
      )
      assert.isTrue(
        (afterRemove.threads.find((thread) => thread.id === 'thread-cli-force-remove')?.deletedAt ??
          null) !== null,
      )
    }),
  )

  it.effect('keeps legacy HTTP dispatch project-only on a new server', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-legacy-dispatch-test-'),
      )
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-legacy-dispatch-workspace-'),
      )

      yield* withLiveProjectCliServer(baseDir, (origin) =>
        Effect.gen(function* ()
        {
          const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth
          const session = yield* environmentAuth.issueSession({
            scopes: AuthAdministrativeScopes,
            label: 'legacy project client test',
          })
          const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin })
          const authorization = `Bearer ${session.token}`
          const projectId = ProjectId.make('project-legacy-http')

          yield* client.orchestration.dispatch({
            headers: { authorization },
            payload: {
              type: 'project.create',
              commandId: CommandId.make('command-legacy-project-create'),
              projectId,
              title: 'Legacy HTTP Project',
              workspaceRoot,
              createdAt: DateTime.formatIso(yield* DateTime.now),
            },
          })
          yield* client.orchestration.dispatch({
            headers: { authorization },
            payload: {
              type: 'project.meta.update',
              commandId: CommandId.make('command-legacy-project-update'),
              projectId,
              title: 'Renamed Legacy HTTP Project',
            },
          })

          const unsupported = yield* client.orchestration
            .dispatch({
              headers: { authorization },
              payload: {
                type: 'thread.delete',
                commandId: CommandId.make('command-legacy-thread-delete'),
                threadId: ThreadId.make('thread-legacy-http'),
              },
            })
            .pipe(Effect.flip)

          assert.instanceOf(unsupported, EnvironmentOrchestrationCommandUnsupportedError)
          assert.equal(unsupported.code, 'unsupported_command')
          assert.equal(unsupported.commandType, 'thread.delete')

          yield* client.orchestration.dispatch({
            headers: { authorization },
            payload: {
              type: 'project.delete',
              commandId: CommandId.make('command-legacy-project-delete'),
              projectId,
            },
          })

          const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
          const snapshot = yield* projectionSnapshotQuery.getSnapshot()
          const project = snapshot.projects.find((candidate) => candidate.id === projectId)
          assert.equal(project?.workspaceRoot, workspaceRoot)
          assert.equal(project?.title, 'Renamed Legacy HTTP Project')
          assert.isTrue((project?.deletedAt ?? null) !== null)
          assert.isFalse(snapshot.threads.some((thread) => thread.id === 'thread-legacy-http'))
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      )
    }),
  )

  it.effect('routes project commands through a running server when runtime state is present', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-live-test-'),
      )
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-live-workspace-'),
      )

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* ()
        {
          const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth
          const sessionsBefore = yield* environmentAuth.listSessions()

          yield* runCliWithRuntime([
            'project',
            'add',
            workspaceRoot,
            '--title',
            'Live Project',
            '--base-dir',
            baseDir,
          ])
          const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
          const readModel = yield* projectionSnapshotQuery.getSnapshot()
          const addedProject = readModel.projects.find(
            (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
          )
          assert.isTrue(addedProject !== undefined)
          assert.equal(addedProject?.title, 'Live Project')

          yield* runCliWithRuntime([
            'project',
            'rename',
            addedProject?.id ?? '',
            'Renamed Live Project',
            '--base-dir',
            baseDir,
          ])
          const renamedReadModel = yield* projectionSnapshotQuery.getSnapshot()
          assert.equal(
            renamedReadModel.projects.find((project) => project.id === addedProject?.id)?.title,
            'Renamed Live Project',
          )

          yield* runCliWithRuntime([
            'project',
            'remove',
            addedProject?.id ?? '',
            '--base-dir',
            baseDir,
          ])
          const removedReadModel = yield* projectionSnapshotQuery.getSnapshot()
          assert.isTrue(
            (removedReadModel.projects.find((project) => project.id === addedProject?.id)
              ?.deletedAt ?? null) !== null,
          )
          const sessionsAfter = yield* environmentAuth.listSessions()
          assert.equal(sessionsAfter.length, sessionsBefore.length)
        }),
      )
    }),
  )

  it.effect('fails explicitly when runtime state predates safe project CLI authentication', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-old-auth-test-'),
      )
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-old-auth-workspace-'),
      )
      const config = yield* makeCliTestServerConfig(baseDir)

      yield* withProjectStorageLease(config, () =>
        Effect.gen(function* ()
        {
          const state = yield* makePersistedServerRuntimeState({ config, port: 1 })
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          })
        }),
      )

      const error = yield* runCliWithRuntime([
        'project',
        'add',
        workspaceRoot,
        '--base-dir',
        baseDir,
      ]).pipe(Effect.flip)
      assert.instanceOf(error, ProjectLiveServerIncompatibleError)
      assert.equal(error.reason, 'storage_owner_capability_unavailable')
      assert.isFalse(NodeFS.existsSync(config.dbPath))
    }),
  )

  it.effect('cleans failed live probe state only after acquiring offline ownership', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-stale-runtime-test-'),
      )
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-stale-runtime-workspace-'),
      )
      const config = yield* makeCliTestServerConfig(baseDir)

      yield* withProjectStorageLease(config, (storageLease) =>
        Effect.gen(function* ()
        {
          const currentState = yield* makePersistedServerRuntimeState({
            config,
            port: 1,
            storageLeaseToken: storageLease.owner.token,
          })
          const staleState = {
            ...currentState,
            pid: 2_000_000_000,
          }
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state: staleState,
          })
          const stateBeforeProbe = NodeFS.readFileSync(config.serverRuntimeStatePath, 'utf8')

          const conflict = yield* runCliWithRuntime([
            'project',
            'add',
            workspaceRoot,
            '--base-dir',
            baseDir,
          ]).pipe(Effect.flip)
          assert.instanceOf(conflict, ServerStorageLease.ServerStorageLeaseConflictError)
          assert.equal(NodeFS.readFileSync(config.serverRuntimeStatePath, 'utf8'), stateBeforeProbe)
          assert.isFalse(NodeFS.existsSync(config.dbPath))
        }),
      )

      yield* runCliWithRuntime(['project', 'add', workspaceRoot, '--base-dir', baseDir])
      assert.isFalse(NodeFS.existsSync(config.serverRuntimeStatePath))

      const snapshot = yield* readPersistedSnapshot(baseDir)
      assert.isTrue(
        snapshot.projects.some(
          (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
        ),
      )
    }),
  )

  it.effect('does not fall back to legacy mutation when the versioned API is unavailable', () =>
    Effect.gen(function* ()
    {
      const baseDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-old-server-test-'),
      )
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-old-server-workspace-'),
      )

      yield* withLegacyProjectCliServer(baseDir, () =>
        Effect.gen(function* ()
        {
          const error = yield* runCliWithRuntime([
            'project',
            'add',
            workspaceRoot,
            '--title',
            'Old Server Project',
            '--base-dir',
            baseDir,
          ]).pipe(Effect.flip)
          assert.instanceOf(error, ProjectLiveServerIncompatibleError)
          assert.equal(error.reason, 'project_command_api_unavailable')

          const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
          const snapshot = yield* projectionSnapshotQuery.getSnapshot()
          assert.isFalse(
            snapshot.projects.some((project) => project.workspaceRoot === workspaceRoot),
          )
        }),
      )
    }),
  )

  it.effect('rejects dev-url on project commands', () =>
    Effect.gen(function* ()
    {
      const workspaceRoot = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), 't3-cli-projects-unknown-option-workspace-'),
      )
      const error = yield* runCliWithRuntime([
        'project',
        'add',
        workspaceRoot,
        '--dev-url',
        'http://127.0.0.1:5173',
      ]).pipe(Effect.flip)

      if (!CliError.isCliError(error))
      {
        assert.fail(`Expected CliError, got ${String(error)}`)
      }
      if (error._tag !== 'ShowHelp')
      {
        assert.fail(`Expected ShowHelp, got ${error._tag}`)
      }
      assert.deepEqual(error.commandPath, ['456code', 'project', 'add'])
      const optionError = error.errors[0] as CliError.CliError | undefined
      if (!optionError || optionError._tag !== 'UnrecognizedOption')
      {
        assert.fail(`Expected UnrecognizedOption, got ${String(optionError?._tag)}`)
      }
      assert.equal(optionError.option, '--dev-url')
    }),
  )
})
