// tests/apps/server/server.test.ts
// verifies server routes and websocket assembly

// @effect-diagnostics nodeBuiltinImport:off - the router seam binds a concrete loopback listener.
import * as NodeHttpServerPlatform from '@effect/platform-node/NodeHttpServer'
import * as NodeSocket from '@effect/platform-node/NodeSocket'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as NodeCrypto from 'node:crypto'
import * as NodeHttp from 'node:http'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'

import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationRecoverScope,
  AuthTokenExchangeGrantType,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  DiffAnalysisId,
  EnvironmentId,
  EventId,
  GitCommandError,
  KeybindingRule,
  MessageId,
  ImplementationAttemptId,
  ExternalLauncherCommandNotFoundError,
  type OrchestrationThreadShell,
  type OrchestrationProjectShell,
  TerminalNotRunningError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  OrchestratePlanRunId,
  ORCHESTRATION_WS_METHODS,
  type PreviewEvent,
  ProjectId,
  PROPOSAL_SNAPSHOT_POLICY_V1,
  ProposalId,
  ProposalGenerationId,
  ProposalRevisionId,
  ProviderDriverKind,
  ProviderInstanceId,
  ResolvedKeybindingRule,
  type SourceControlDiscoveryResult,
  ThreadId,
  TurnId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from '@t3tools/contracts'
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from '@t3tools/shared/dpop'
import { assert, it } from '@effect/vitest'
import { assertFailure, assertInclude, assertTrue } from '@effect/vitest/utils'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as PubSub from 'effect/PubSub'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { ChildProcessSpawner } from 'effect/unstable/process'
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from 'effect/unstable/http'
import { OtlpSerialization, OtlpTracer } from 'effect/unstable/observability'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import * as Socket from 'effect/unstable/socket/Socket'
import { vi } from 'vite-plus/test'

const TEST_EPOCH = DateTime.makeUnsafe('1970-01-01T00:00:00.000Z')

// bind loopback explicitly so unrelated host listeners cannot intercept test traffic
const loopbackHttpServerTestLayer = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit)({
          keepalive: false,
        }),
      ),
    ),
  ),
  Layer.provideMerge(
    NodeHttpServerPlatform.layer(NodeHttp.createServer, {
      host: '127.0.0.1',
      port: 0,
    }),
  ),
)

import * as ServerConfig from '../../../apps/server/src/config.ts'
import * as ArchitectureQueryService from '../../../apps/server/src/cartographer/ArchitectureQueryService.ts'
import * as ArchitectureProjectionService from '../../../apps/server/src/cartographer/ArchitectureProjectionService.ts'
import {
  makeRoutesLayer,
  makeSourceControlDiscoveryLayer,
} from '../../../apps/server/src/server.ts'
import { resolveAvailableEditorsForConfig } from '../../../apps/server/src/ws.ts'
import { ImportContinuationDepsUnbound } from '../../../apps/server/src/import/continuation/continuationContract.ts'
import * as ImportRuntime from '../../../apps/server/src/import/importRuntime.ts'
import { ImportReplacementIntentRepository } from '../../../apps/server/src/persistence/Services/ImportReplacementIntents.ts'
import { OrchestrationProjectionPipeline } from '../../../apps/server/src/orchestration/Services/ProjectionPipeline.ts'
import { AttachmentLifecycleRepository } from '../../../apps/server/src/persistence/Services/AttachmentLifecycle.ts'
import { makeKeyedSemaphore } from '../../../apps/server/src/provider/Layers/KeyedSemaphore.ts'
import * as CheckpointDiffQuery from '../../../apps/server/src/orchestration/Services/CheckpointDiffQuery.ts'
import * as CheckpointIdentity from '../../../apps/server/src/checkpointing/CheckpointIdentity.ts'
import * as GitManager from '../../../apps/server/src/git/GitManager.ts'
import * as GitStatusReaderLive from '../../../apps/server/src/git/GitStatusReaderLive.ts'
import * as Keybindings from '../../../apps/server/src/keybindings.ts'
import * as EnvironmentTheme from '../../../apps/server/src/environmentTheme.ts'
import * as ExternalLauncher from '../../../apps/server/src/process/externalLauncher.ts'
import * as RemoteOpenTargets from '../../../apps/server/src/environment/RemoteOpenTargets.ts'
import * as OrchestrationEngine from '../../../apps/server/src/orchestration/Services/OrchestrationEngine.ts'
import { ThreadDeletionReactor } from '../../../apps/server/src/orchestration/Services/ThreadDeletionReactor.ts'
import { OrchestrationListenerCallbackError } from '../../../apps/server/src/orchestration/Errors.ts'
import * as ProjectionSnapshotQuery from '../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'
import { SqlitePersistenceMemory } from '../../../apps/server/src/persistence/Layers/Sqlite.ts'
import { PersistenceSqlError } from '../../../apps/server/src/persistence/Errors.ts'
import * as ProviderRegistry from '../../../apps/server/src/provider/Services/ProviderRegistry.ts'
import { makeManualOnlyProviderMaintenanceCapabilities } from '../../../apps/server/src/provider/maintenance/providerMaintenance.ts'
import * as ServerLifecycleEvents from '../../../apps/server/src/serverLifecycleEvents.ts'
import * as ServerRuntimeStartup from '../../../apps/server/src/serverRuntimeStartup.ts'
import * as ServerSettings from '../../../apps/server/src/serverSettings.ts'
import * as TerminalManager from '../../../apps/server/src/terminal/Manager.ts'
import * as PreviewManager from '../../../apps/server/src/preview/Manager.ts'
import * as PortScanner from '../../../apps/server/src/preview/PortScanner.ts'
import * as BrowserTraceCollector from '../../../apps/server/src/observability/BrowserTraceCollector.ts'
import * as McpSessionRegistry from '../../../apps/server/src/mcp/McpSessionRegistry.ts'
import * as ProjectFaviconResolver from '../../../apps/server/src/project/ProjectFaviconResolver.ts'
import * as ProjectFileLoader from '../../../apps/server/src/project/ProjectFileLoader.ts'
import * as ProjectSetupScriptRunner from '../../../apps/server/src/project/ProjectSetupScriptRunner.ts'
import * as RepositoryIdentityResolver from '../../../apps/server/src/project/RepositoryIdentityResolver.ts'
import * as ServerEnvironment from '../../../apps/server/src/environment/ServerEnvironment.ts'
import * as WorkspaceEntries from '../../../apps/server/src/workspace/WorkspaceEntries.ts'
import * as WorkspaceFileSystem from '../../../apps/server/src/workspace/WorkspaceFileSystem.ts'
import * as WorkspacePaths from '../../../apps/server/src/workspace/WorkspacePaths.ts'
import * as GitVcsDriver from '../../../apps/server/src/vcs/GitVcsDriver.ts'
import * as VcsDriver from '../../../apps/server/src/vcs/VcsDriver.ts'
import * as VcsStatusBroadcaster from '../../../apps/server/src/vcs/VcsStatusBroadcaster.ts'
import * as VcsDriverRegistry from '../../../apps/server/src/vcs/VcsDriverRegistry.ts'
import * as VcsProcess from '../../../apps/server/src/vcs/VcsProcess.ts'
import * as VcsProvisioningService from '../../../apps/server/src/vcs/VcsProvisioningService.ts'
import * as GitWorkflowService from '../../../apps/server/src/git/GitWorkflowService.ts'
import * as ReviewService from '../../../apps/server/src/review/ReviewService.ts'
import * as SourceControlDiscovery from '../../../apps/server/src/sourceControl/SourceControlDiscovery.ts'
import * as SourceControlProviderRegistry from '../../../apps/server/src/sourceControl/SourceControlProviderRegistry.ts'
import * as SourceControlRepositoryService from '../../../apps/server/src/sourceControl/SourceControlRepositoryService.ts'
import * as ServerSecretStore from '../../../apps/server/src/auth/ServerSecretStore.ts'
import * as EnvironmentAuth from '../../../apps/server/src/auth/EnvironmentAuth.ts'
import * as ProcessDiagnostics from '../../../apps/server/src/diagnostics/ProcessDiagnostics.ts'
import * as ProcessResourceMonitor from '../../../apps/server/src/diagnostics/ProcessResourceMonitor.ts'
import * as TraceDiagnostics from '../../../apps/server/src/diagnostics/TraceDiagnostics.ts'
import * as WorkerBrokerStore from '../../../apps/server/src/workers/WorkerBrokerStore.ts'
import * as WorkersStatusBroadcaster from '../../../apps/server/src/workers/WorkersStatusBroadcaster.ts'
import * as CurrentWorktreeArchitectureService from '../../../apps/server/src/cartographer/CurrentWorktreeArchitectureService.ts'
import * as DiffAnalysisService from '../../../apps/server/src/cartographer/DiffAnalysisService.ts'
import * as ProjectAtlasStatusBroadcaster from '../../../apps/server/src/cartographer/ProjectAtlasStatusBroadcaster.ts'
import * as ProjectArchitectureLifecycleService from '../../../apps/server/src/cartographer/ProjectArchitectureLifecycleService.ts'
import * as ArchitectureAdmissionService from '../../../apps/server/src/architecture/ArchitectureAdmissionService.ts'
import * as PlannedImpactService from '../../../apps/server/src/architecture/PlannedImpactService.ts'
import * as ProposalGenerationService from '../../../apps/server/src/proposal/ProposalGenerationService.ts'
import * as ProposalImplementationAttemptService from '../../../apps/server/src/proposal/ProposalImplementationAttemptService.ts'
import * as ProposalService from '../../../apps/server/src/proposal/ProposalService.ts'
import { makeProjectionSnapshotQueryStub } from './projectionSnapshotQueryTestHelpers.ts'
import * as Data from 'effect/Data'

const defaultProjectId = ProjectId.make('project-default')
const defaultThreadId = ThreadId.make('thread-default')
const defaultDesktopBootstrapToken = 'test-desktop-bootstrap-token'
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make('codex'),
  model: 'gpt-5-codex',
} as const
const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make('environment-test'),
  label: 'Test environment',
  platform: {
    os: 'darwin' as const,
    arch: 'arm64' as const,
  },
  serverVersion: '0.0.0-test',
  capabilities: {
    repositoryIdentity: true,
  },
}
const makeDefaultOrchestrationReadModel = () =>
{
  const now = '2026-01-01T00:00:00.000Z'
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: 'Default Project',
        workspaceRoot: '/tmp/default-project',
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: 'Default Thread',
        modelSelection: defaultModelSelection,
        interactionMode: 'default' as const,
        runtimeMode: 'full-access' as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        origin: null,
        settledOverride: null,
        settledAt: null,
        latestTurn: null,
        providerSwitch: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        orchestratePlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  }
}

const makeDefaultOrchestrationThreadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell =>
{
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id: defaultThreadId,
    projectId: defaultProjectId,
    title: 'Default Thread',
    modelSelection: defaultModelSelection,
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    latestTurn: null,
    providerSwitch: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    origin: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }
}

const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
)

const makeAuthTestLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
  )

const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* ()
  {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () =>
      {
        const NodeHttp = await import('node:http')

        return await new Promise<{
          readonly close: () => Promise<void>
          readonly firstRequest: Promise<{
            readonly body: string
            readonly contentType: string | null
          }>
          readonly url: string
        }>((resolve, reject) =>
        {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined
          const firstRequest = new Promise<{
            readonly body: string
            readonly contentType: string | null
          }>((resolveRequest) =>
          {
            resolveFirstRequest = resolveRequest
          })

          const server = NodeHttp.createServer((request, response) =>
          {
            const chunks: Buffer[] = []
            request.on('data', (chunk) =>
            {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            })
            request.on('end', () =>
            {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString('utf8'),
                contentType: request.headers['content-type'] ?? null,
              })
              resolveFirstRequest = undefined
              response.statusCode = 204
              response.end()
            })
          })

          server.on('error', reject)
          server.listen(0, '127.0.0.1', () =>
          {
            const address = server.address()
            if (!address || typeof address === 'string')
            {
              reject(new Error('Expected TCP collector address'))
              return
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) =>
                {
                  server.close((error) =>
                  {
                    if (error)
                    {
                      rejectClose(error)
                      return
                    }
                    resolveClose()
                  })
                }),
            })
          })
        })
      }),
      ({ close }) => Effect.promise(close),
    )

    const runtime = ManagedRuntime.make(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: '10 millis',
        resource: {
          serviceName: 't3-web',
          attributes: {
            'service.runtime': 't3-web',
            'service.mode': 'browser',
            'service.version': 'test',
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    )

    try
    {
      yield* Effect.promise(() => runtime.runPromise(Effect.void.pipe(Effect.withSpan(spanName))))
    }
    finally
    {
      yield* Effect.promise(() => runtime.dispose())
    }

    const request = yield* Effect.raceFirst(
      Effect.promise(() => collector.firstRequest).pipe(Effect.orDie),
      Effect.sleep(Duration.seconds(1)).pipe(
        Effect.andThen(Effect.die(new Error('Timed out waiting for OTLP trace export'))),
      ),
    )
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    return JSON.parse(request.body) as OtlpTracer.TraceData
  })

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfig.ServerConfig['Service']>
  layers?: {
    keybindings?: Partial<Keybindings.Keybindings['Service']>
    environmentTheme?: Partial<EnvironmentTheme.EnvironmentThemeService['Service']>
    providerRegistry?: Partial<ProviderRegistry.ProviderRegistry['Service']>
    serverSettings?: Partial<ServerSettings.ServerSettingsService['Service']>
    externalLauncher?: Partial<ExternalLauncher.ExternalLauncher['Service']>
    vcsDriver?: Partial<VcsDriver.VcsDriver['Service']>
    vcsDriverRegistry?: Partial<VcsDriverRegistry.VcsDriverRegistry['Service']>
    gitVcsDriver?: Partial<GitVcsDriver.GitVcsDriver['Service']>
    gitManager?: Partial<GitManager.GitManager['Service']>
    sourceControlRepositoryService?: Partial<
      SourceControlRepositoryService.SourceControlRepositoryService['Service']
    >
    sourceControlDiscovery?: Partial<SourceControlDiscovery.SourceControlDiscovery['Service']>
    reviewService?: Partial<ReviewService.ReviewService['Service']>
    vcsStatusBroadcaster?: Partial<VcsStatusBroadcaster.VcsStatusBroadcaster['Service']>
    projectSetupScriptRunner?: Partial<ProjectSetupScriptRunner.ProjectSetupScriptRunner['Service']>
    terminalManager?: Partial<TerminalManager.TerminalManager['Service']>
    orchestrationEngine?: Partial<OrchestrationEngine.OrchestrationEngineService['Service']>
    threadDeletionReactor?: Partial<ThreadDeletionReactor['Service']>
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQuery.ProjectionSnapshotQuery['Service']>
    checkpointDiffQuery?: Partial<CheckpointDiffQuery.CheckpointDiffQuery['Service']>
    browserTraceCollector?: Partial<BrowserTraceCollector.BrowserTraceCollector['Service']>
    serverLifecycleEvents?: Partial<ServerLifecycleEvents.ServerLifecycleEvents['Service']>
    serverRuntimeStartup?: Partial<ServerRuntimeStartup.ServerRuntimeStartup['Service']>
    serverEnvironment?: Partial<ServerEnvironment.ServerEnvironment['Service']>
    repositoryIdentityResolver?: Partial<
      RepositoryIdentityResolver.RepositoryIdentityResolver['Service']
    >
    architectureQueryService?: Partial<ArchitectureQueryService.ArchitectureQueryService['Service']>
    architectureProjectionService?: Partial<
      ArchitectureProjectionService.ArchitectureProjectionService['Service']
    >
    currentWorktreeArchitecture?: Partial<
      CurrentWorktreeArchitectureService.CurrentWorktreeArchitectureService['Service']
    >
    projectArchitectureLifecycle?: Partial<
      ProjectArchitectureLifecycleService.ProjectArchitectureLifecycleService['Service']
    >
    diffAnalysisService?: Partial<DiffAnalysisService.DiffAnalysisService['Service']>
    proposalGenerationService?: Partial<
      ProposalGenerationService.ProposalGenerationService['Service']
    >
    architectureAdmissionService?: Partial<
      ArchitectureAdmissionService.ArchitectureAdmissionService['Service']
    >
    plannedImpactService?: Partial<PlannedImpactService.PlannedImpactService['Service']>
    proposalImplementationAttemptService?: Partial<
      ProposalImplementationAttemptService.ProposalImplementationAttemptService['Service']
    >
    proposalService?: Partial<ProposalService.ProposalService['Service']>
  }
}) =>
  Effect.gen(function* ()
  {
    const fileSystem = yield* FileSystem.FileSystem
    const attachmentCommandPermits = yield* makeKeyedSemaphore<string>()
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: 't3-router-test-' })
    const baseDir = options?.config?.baseDir ?? tempBaseDir
    const devUrl = options?.config?.devUrl
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl)
    const config: ServerConfig.ServerConfig['Service'] = {
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
      mode: 'desktop',
      port: 0,
      host: '127.0.0.1',
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      startupPresentation: 'browser',
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      ...options?.config,
    }
    const layerConfig = ServerConfig.layer(config)
    const defaultVcsDriver: VcsDriver.VcsDriver['Service'] = {
      capabilities: {
        kind: 'git',
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: 'native',
      },
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      detectRepository: () => Effect.succeed(null),
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
          freshness: {
            source: 'live-local',
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      listRemotes: () =>
        Effect.succeed({
          remotes: [],
          freshness: {
            source: 'live-local',
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      initRepository: () => Effect.void,
      ...options?.layers?.vcsDriver,
    }
    const vcsDriverRegistryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      get: () => Effect.succeed(defaultVcsDriver),
      detect: (input) =>
        defaultVcsDriver.detectRepository(input.cwd).pipe(
          Effect.flatMap((repository) =>
            repository
              ? Effect.succeed(repository)
              : defaultVcsDriver.isInsideWorkTree(input.cwd).pipe(
                  Effect.map((isInsideWorkTree) =>
                    isInsideWorkTree
                      ? {
                          kind: 'git' as const,
                          rootPath: input.cwd,
                          metadataPath: null,
                          freshness: {
                            source: 'live-local' as const,
                            observedAt: TEST_EPOCH,
                            expiresAt: Option.none(),
                          },
                        }
                      : null,
                  ),
                ),
          ),
          Effect.map((repository) =>
            repository
              ? ({
                  kind: repository.kind,
                  repository,
                  driver: defaultVcsDriver,
                } satisfies VcsDriverRegistry.VcsDriverHandle)
              : null,
          ),
        ),
      resolve: (input) =>
        Effect.succeed({
          kind:
            input.requestedKind === 'auto' || !input.requestedKind ? 'git' : input.requestedKind,
          repository: {
            kind:
              input.requestedKind === 'auto' || !input.requestedKind ? 'git' : input.requestedKind,
            rootPath: input.cwd,
            metadataPath: null,
            freshness: {
              source: 'live-local',
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: defaultVcsDriver,
        }),
      ...options?.layers?.vcsDriverRegistry,
    })
    const gitVcsDriverLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
      ...options?.layers?.gitVcsDriver,
    })
    const gitManagerLayer = Layer.mock(GitManager.GitManager)({
      ...options?.layers?.gitManager,
    })
    const workspaceEntriesLayer = WorkspaceEntries.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provideMerge(vcsDriverRegistryLayer),
    )
    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspacePaths.layer,
      workspaceEntriesLayer,
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(workspaceEntriesLayer),
      ),
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(ProjectFileLoader.layer),
      ),
    )
    const gitStatusReaderLayer = GitStatusReaderLive.layer.pipe(
      Layer.provideMerge(vcsDriverRegistryLayer),
      Layer.provideMerge(gitManagerLayer),
    )
    const gitWorkflowLayer = GitWorkflowService.layer.pipe(
      Layer.provideMerge(vcsDriverRegistryLayer),
      Layer.provideMerge(gitVcsDriverLayer),
      Layer.provideMerge(gitManagerLayer),
      Layer.provideMerge(gitStatusReaderLayer),
    )
    const vcsProvisioningLayer = VcsProvisioningService.layer.pipe(
      Layer.provide(vcsDriverRegistryLayer),
    )
    const reviewLayer = options?.layers?.reviewService
      ? Layer.mock(ReviewService.ReviewService)({
          ...options.layers.reviewService,
        })
      : ReviewService.layer.pipe(
          Layer.provideMerge(gitVcsDriverLayer),
          Layer.provide(vcsDriverRegistryLayer),
        )
    const vcsStatusBroadcasterLayer = options?.layers?.vcsStatusBroadcaster
      ? Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          ...options.layers.vcsStatusBroadcaster,
        })
      : VcsStatusBroadcaster.layer.pipe(Layer.provide(gitStatusReaderLayer))

    const servedRoutesLayer = HttpRouter.serve(
      makeRoutesLayer.pipe(Layer.provide(McpSessionRegistry.enabledLayer)),
      {
        disableListenLog: true,
        disableLogger: true,
      },
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          ImportRuntime.layer.pipe(Layer.provide(ImportContinuationDepsUnbound)),
          Layer.mock(Keybindings.Keybindings)({
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
            ...options?.layers?.keybindings,
          }),
          Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
            current: Effect.succeed([]),
            streamChanges: Stream.succeed([]),
            ...options?.layers?.environmentTheme,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
          getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
            ),
          setProviderMaintenanceActionState: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          ...options?.layers?.providerRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          streamCurrentAndChanges: Stream.succeed(DEFAULT_SERVER_SETTINGS),
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ExternalLauncher.ExternalLauncher)({
            resolveAvailableEditors: () => Effect.succeed([]),
            ...options?.layers?.externalLauncher,
          }),
          Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
            resolveTargets: () => Effect.succeed([]),
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
          read: Effect.succeed({
            serverPid: process.pid,
            readAt: TEST_EPOCH,
            processCount: 0,
            totalRssBytes: 0,
            totalCpuPercent: 0,
            processes: [],
            error: Option.none(),
          }),
          signal: (input) =>
            Effect.succeed({
              pid: input.pid,
              signal: input.signal,
              signaled: true,
              message: Option.none(),
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
          readHistory: (input) =>
            Effect.succeed({
              readAt: TEST_EPOCH,
              windowMs: input.windowMs,
              bucketMs: input.bucketMs,
              sampleIntervalMs: 5_000,
              retainedSampleCount: 0,
              totalCpuSecondsApprox: 0,
              buckets: [],
              topProcesses: [],
              error: Option.none(),
            }),
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(TraceDiagnostics.TraceDiagnostics)({
            read: () =>
              Effect.succeed({
                traceFilePath: '',
                scannedFilePaths: [],
                readAt: TEST_EPOCH,
                recordCount: 0,
                parseErrorCount: 0,
                firstSpanAt: Option.none(),
                lastSpanAt: Option.none(),
                failureCount: 0,
                interruptionCount: 0,
                slowSpanThresholdMs: 1_000,
                slowSpanCount: 0,
                logLevelCounts: {},
                topSpansByCount: [],
                slowestSpans: [],
                commonFailures: [],
                latestFailures: [],
                latestWarningAndErrorLogs: [],
                partialFailure: Option.none(),
                error: Option.none(),
              }),
          }),
          Layer.mock(WorkersStatusBroadcaster.WorkersStatusBroadcaster)({
            streamSnapshots: () => Stream.empty,
          }),
          Layer.mock(WorkerBrokerStore.WorkerBrokerStore)({
            jobsDir: '/tmp/worker-broker/jobs',
            list: () =>
              Effect.succeed({
                state: 'state-dir-missing',
                stateDir: '/tmp/worker-broker',
                readAt: '1970-01-01T00:00:00.000Z',
                jobs: [],
                skippedJobCount: 0,
                error: Option.none(),
              }),
            getJob: () =>
              Effect.succeed({
                readAt: '1970-01-01T00:00:00.000Z',
                job: Option.none(),
                error: Option.none(),
              }),
          }),
          ProjectAtlasStatusBroadcaster.layer,
          Layer.mock(ArchitectureQueryService.ArchitectureQueryService)({
            resolveContext: () => Effect.die('ArchitectureQueryService not stubbed in this test'),
            blastRadius: () => Effect.die('ArchitectureQueryService not stubbed in this test'),
            graphDiff: () => Effect.die('ArchitectureQueryService not stubbed in this test'),
            architectureImpactProjection: () =>
              Effect.die('ArchitectureQueryService not stubbed in this test'),
            proposePatch: () => Effect.die('ArchitectureQueryService not stubbed in this test'),
            ...options?.layers?.architectureQueryService,
          }),
          Layer.mock(ArchitectureProjectionService.ArchitectureProjectionService)({
            repositoryMap: () =>
              Effect.die('ArchitectureProjectionService not stubbed in this test'),
            architectureScope: () =>
              Effect.die('ArchitectureProjectionService not stubbed in this test'),
            architectureSource: () =>
              Effect.die('ArchitectureProjectionService not stubbed in this test'),
            ...options?.layers?.architectureProjectionService,
          }),
          Layer.mock(CurrentWorktreeArchitectureService.CurrentWorktreeArchitectureService)({
            prepare: () =>
              Effect.die('CurrentWorktreeArchitectureService not stubbed in this test'),
            retainThreadTarget: () =>
              Effect.die('CurrentWorktreeArchitectureService not stubbed in this test'),
            releasePreparedTarget: () => Effect.void,
            closeThread: () => Effect.void,
            closeAll: Effect.void,
            reapExpired: Effect.succeed(0),
            ...options?.layers?.currentWorktreeArchitecture,
          }),
          Layer.mock(ProjectArchitectureLifecycleService.ProjectArchitectureLifecycleService)({
            ensureProject: () =>
              Effect.die('ProjectArchitectureLifecycleService not stubbed in this test'),
            rebuildProject: () =>
              Effect.die('ProjectArchitectureLifecycleService not stubbed in this test'),
            closeProject: () => Effect.void,
            invalidateProjectMetadata: () => Effect.void,
            deleteProjectArtifacts: () => Effect.void,
            retainProjectStatus: () => Effect.void,
            releaseProjectStatus: () => Effect.void,
            hasRetainedProjectContext: () => Effect.succeed(false),
            projectRetentionChanges: Stream.empty,
            getProjectSnapshot: () => Effect.succeed(null),
            isProjectDeleted: () => Effect.succeed(false),
            closeAll: Effect.void,
            ...options?.layers?.projectArchitectureLifecycle,
          }),
          Layer.mock(DiffAnalysisService.DiffAnalysisService)({
            request: () => Effect.die('DiffAnalysisService not stubbed in this test'),
            get: () => Effect.die('DiffAnalysisService not stubbed in this test'),
            getById: () => Effect.die('DiffAnalysisService not stubbed in this test'),
            retainReadyTarget: () => Effect.die('DiffAnalysisService not stubbed in this test'),
            retainReadyImpactTarget: () =>
              Effect.die('DiffAnalysisService not stubbed in this test'),
            ...options?.layers?.diffAnalysisService,
          }),
          Layer.mock(ProposalGenerationService.ProposalGenerationService)({
            startAdmitted: () => Effect.die('ProposalGenerationService not stubbed in this test'),
            get: () => Effect.die('ProposalGenerationService not stubbed in this test'),
            latest: () => Effect.succeed(null),
            latestAdmitted: () => Effect.succeed(null),
            resolveArchitectureTarget: () =>
              Effect.die('ProposalGenerationService not stubbed in this test'),
            resolveImpactTarget: () =>
              Effect.die('ProposalGenerationService not stubbed in this test'),
            cancelThread: () => Effect.void,
            ...options?.layers?.proposalGenerationService,
          }),
          Layer.mock(ArchitectureAdmissionService.ArchitectureAdmissionService)({
            retryProposal: () =>
              Effect.die('ArchitectureAdmissionService not stubbed in this test'),
            cancelThread: () => Effect.void,
            ...options?.layers?.architectureAdmissionService,
          }),
          Layer.mock(PlannedImpactService.PlannedImpactService)({
            upsert: () => Effect.die('PlannedImpactService not stubbed in this test'),
            get: () => Effect.die('PlannedImpactService not stubbed in this test'),
            appendAnchored: () => Effect.die('PlannedImpactService not stubbed in this test'),
            ...options?.layers?.plannedImpactService,
          }),
          Layer.mock(ProposalImplementationAttemptService.ProposalImplementationAttemptService)({
            begin: () =>
              Effect.die('ProposalImplementationAttemptService not stubbed in this test'),
            complete: () =>
              Effect.die('ProposalImplementationAttemptService not stubbed in this test'),
            latestForProposal: () => Effect.succeed(null),
            ...options?.layers?.proposalImplementationAttemptService,
          }),
          Layer.mock(ProposalService.ProposalService)({
            upsert: () => Effect.die('ProposalService not stubbed in this test'),
            list: () => Effect.succeed({ proposals: [] }),
            get: () => Effect.die('ProposalService not stubbed in this test'),
            diff: () => Effect.die('ProposalService not stubbed in this test'),
            narrative: () => Effect.succeed(null),
            findLatestByPlan: () => Effect.succeed(null),
            findByOrchestrateRevision: () => Effect.succeed(null),
            ...options?.layers?.proposalService,
          }),
        ),
      ),
      Layer.provide(gitManagerLayer),
      Layer.provide(gitVcsDriverLayer),
      Layer.provide(gitWorkflowLayer),
      Layer.provide(reviewLayer),
      Layer.provide(vcsProvisioningLayer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
            ...options?.layers?.sourceControlRepositoryService,
          }),
          Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({
            discover: Effect.succeed({
              versionControlSystems: [],
              sourceControlProviders: [],
            }),
            ...options?.layers?.sourceControlDiscovery,
          }),
        ),
      ),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: 'no-script' as const }),
          ...options?.layers?.projectSetupScriptRunner,
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          ...options?.layers?.terminalManager,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PreviewManager.PreviewManager)({
            open: () => Effect.die('PreviewManager not stubbed in this test'),
            navigate: () => Effect.die('PreviewManager not stubbed in this test'),
            resize: () => Effect.die('PreviewManager not stubbed in this test'),
            reportStatus: () => Effect.void,
            refresh: () => Effect.void,
            close: () => Effect.void,
            list: () => Effect.succeed({ sessions: [], serverEpoch: 'test-server', revision: 0 }),
            events: Stream.empty,
            subscribeEvents: Effect.flatMap(PubSub.unbounded<PreviewEvent>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          }),
          Layer.mock(PortScanner.PortDiscovery)({
            scan: () => Effect.succeed([]),
            subscribe: () => Effect.succeed([]),
            retain: Effect.void,
            registerTerminalProcesses: () => Effect.void,
            unregisterTerminal: () => Effect.void,
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 0 }),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
            ...options?.layers?.orchestrationEngine,
          }),
          Layer.mock(ImportReplacementIntentRepository)({
            getByIntentKey: () => Effect.succeed(Option.none()),
            findOpenBySourceIdentity: () => Effect.succeed(Option.none()),
            insertIfAbsent: (intent) => Effect.succeed(intent),
            casTransition: () => Effect.succeed(false),
            listOpen: () => Effect.succeed([]),
            retire: () => Effect.succeed(false),
          }),
          Layer.mock(OrchestrationProjectionPipeline)({
            verifyThreadAttachmentSet: () =>
              Effect.succeed({ complete: true, actualRelativePaths: [] }),
            cleanupDeletedThreadAttachments: () =>
              Effect.succeed({ complete: true, remainingRelativePaths: [] }),
          }),
          Layer.mock(AttachmentLifecycleRepository)({
            withCommandPermit: attachmentCommandPermits.withPermit,
            markDispatchFailure: () => Effect.void,
          }),
          Layer.mock(ThreadDeletionReactor)({
            start: () => Effect.void,
            drain: Effect.void,
            drainThrough: () => Effect.void,
            ...options?.layers?.threadDeletionReactor,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)(
          makeProjectionSnapshotQueryStub({
            getCommandReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
            getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [],
                threads: [],
                updatedAt: '1970-01-01T00:00:00.000Z',
              }),
            getArchivedShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: [],
                threads: [],
                updatedAt: '1970-01-01T00:00:00.000Z',
              }),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getThreadCheckpointContext: () => Effect.succeed(Option.none()),
            ...options?.layers?.projectionSnapshotQuery,
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
            getTurnDiff: () =>
              Effect.succeed({
                threadId: defaultThreadId,
                fromTurnCount: 0,
                toTurnCount: 0,
                diff: '',
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: defaultThreadId,
                fromTurnCount: 0,
                toTurnCount: 0,
                diff: '',
              }),
            ...options?.layers?.checkpointDiffQuery,
          }),
          Layer.mock(CheckpointIdentity.CheckpointIdentityResolver)({
            resolveCapture: () => Effect.die('CheckpointIdentity.resolveCapture not stubbed'),
            resolveRead: () => Effect.die('CheckpointIdentity.resolveRead not stubbed'),
            resolveReadRange: () => Effect.die('CheckpointIdentity.resolveReadRange not stubbed'),
            resolveDestructive: () =>
              Effect.die('CheckpointIdentity.resolveDestructive not stubbed'),
            resolveRepositoryRevision: () =>
              Effect.die('CheckpointIdentity.resolveRepositoryRevision not stubbed'),
            resolveRepositoryObjectRevision: () =>
              Effect.die('CheckpointIdentity.resolveRepositoryObjectRevision not stubbed'),
          }),
        ),
      ),
    )

    const appLayer = servedRoutesLayer.pipe(
      Layer.provide(
        Layer.mock(BrowserTraceCollector.BrowserTraceCollector)({
          record: () => Effect.void,
          ...options?.layers?.browserTraceCollector,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
          getDescriptor: Effect.succeed(testEnvironmentDescriptor),
          ...options?.layers?.serverEnvironment,
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
          ...options?.layers?.repositoryIdentityResolver,
        }),
      ),
      Layer.provideMerge(makeAuthTestLayer()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(layerConfig),
    )

    yield* Layer.build(appLayer)
    return config
  })

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly url: string } =>
{
  const next = new URL(wsUrl)
  const cookie = next.hash.startsWith('#cookie=')
    ? decodeURIComponent(next.hash.slice('#cookie='.length))
    : null
  next.hash = ''
  return {
    cookie,
    url: next.toString(),
  }
}

const wsRpcProtocolLayer = (wsUrl: string, origin?: string) =>
{
  const { cookie, url } = parseSessionCookieFromWsUrl(wsUrl)
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols,
        cookie || origin
          ? { headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } }
          : undefined,
      ) as unknown as globalThis.WebSocket,
  )

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  )
}

const makeWsRpcClient = RpcClient.make(WsRpcGroup)
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
  origin?: string,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl, origin)))

const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) =>
{
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)
  const next = new URL(url, 'http://localhost')
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`
}

const getHttpServerUrl = (pathname = '') =>
  Effect.gen(function* ()
  {
    const server = yield* HttpServer.HttpServer
    const address = server.address as HttpServer.TcpAddress
    return `http://127.0.0.1:${address.port}${pathname}`
  })

const bootstrapBrowserSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>
  },
) =>
  Effect.gen(function* ()
  {
    const bootstrapUrl = yield* getHttpServerUrl('/api/auth/browser-session')
    const response = yield* fetchEffect(bootstrapUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...options?.headers,
      },
      body: jsonRequestBody({
        credential,
      }),
    })
    const body = yield* responseJsonEffect<{
      readonly authenticated: boolean
      readonly sessionMethod: string
      readonly expiresAt: string
    }>(response)
    return {
      response,
      body,
      cookie: response.headers['set-cookie'],
    }
  })

const exchangeAccessToken = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>
    readonly scope?: string
    readonly clientMetadata?: {
      readonly label?: string
      readonly deviceType?: string
      readonly os?: string
    }
  },
) =>
  Effect.gen(function* ()
  {
    const tokenUrl = yield* getHttpServerUrl('/oauth/token')
    const response = yield* fetchEffect(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...options?.headers,
      },
      body: new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope:
          options?.scope ??
          'orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write',
        ...(options?.clientMetadata?.label ? { client_label: options.clientMetadata.label } : {}),
        ...(options?.clientMetadata?.deviceType
          ? { client_device_type: options.clientMetadata.deviceType }
          : {}),
        ...(options?.clientMetadata?.os ? { client_os: options.clientMetadata.os } : {}),
      }).toString(),
    })
    const body = yield* responseJsonEffect<{
      readonly access_token?: string
      readonly issued_token_type?: string
      readonly token_type?: string
      readonly expires_in?: number
      readonly scope?: string
      readonly _tag?: string
      readonly code?: string
      readonly reason?: string
      readonly traceId?: string
    }>(response)
    return {
      response,
      body,
    }
  })

const makeDpopProof = (input: {
  readonly method: string
  readonly url: string
  readonly iat: number
  readonly accessToken?: string
  readonly jti?: string
  readonly privateKey?: NodeCrypto.KeyObject
  readonly publicJwk?: DpopPublicJwk
}) =>
{
  const keyPair =
    input.privateKey && input.publicJwk
      ? { privateKey: input.privateKey, publicJwk: input.publicJwk }
      : (() =>
        {
          const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync('ec', {
            namedCurve: 'P-256',
          })
          return { privateKey, publicJwk: publicKey.export({ format: 'jwk' }) as DpopPublicJwk }
        })()
  const header = Buffer.from(
    JSON.stringify({
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: keyPair.publicJwk,
    }),
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti ?? 'proof-1',
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString('base64url')
  const signature = NodeCrypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: keyPair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: computeDpopJwkThumbprint(keyPair.publicJwk),
    privateKey: keyPair.privateKey,
    publicJwk: keyPair.publicJwk,
  }
}

class AuthenticationGetterError extends Data.TaggedError('AuthenticationGetterError')<{
  readonly message: string
}>
{}

class TestHttpRequestError extends Data.TaggedError('TestHttpRequestError')<{
  readonly cause: unknown
}>
{}

const testRequestUrl = (input: Parameters<typeof fetch>[0]): string =>
{
  const value = input.toString()
  if (!/^https?:\/\//i.test(value))
  {
    return value
  }
  const url = new URL(value)
  return `${url.pathname}${url.search}`
}

const fetchEffect = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
{
  const request = HttpClientRequest.make((init?.method ?? 'GET') as 'GET' | 'POST')(
    testRequestUrl(input),
    {
      headers: init?.headers as Record<string, string> | undefined,
    },
  ).pipe(
    typeof init?.body === 'string'
      ? HttpClientRequest.bodyText(
          init.body,
          (init.headers as Record<string, string> | undefined)?.['content-type'] ??
            'application/json',
        )
      : (request) => request,
  )
  const effect = HttpClient.execute(request)
  return (
    init?.redirect === 'manual'
      ? effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }))
      : effect
  ).pipe(Effect.mapError((cause) => new TestHttpRequestError({ cause })))
}

const jsonRequestBody = (value: unknown): string =>
{
  return JSON.stringify(value)
}

const responseJsonEffect = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map((json) => json as A),
    Effect.mapError((cause) => new TestHttpRequestError({ cause })),
  )

const responseOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300

const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* ()
  {
    const { response, cookie } = yield* bootstrapBrowserSession(credential)
    if (!responseOk(response))
    {
      return yield* new AuthenticationGetterError({
        message: `Expected bootstrap session response to succeed, got ${response.status}`,
      })
    }

    if (!cookie)
    {
      return yield* new AuthenticationGetterError({
        message: 'Expected bootstrap session response to set a cookie.',
      })
    }

    return cookie.split(';')[0] ?? cookie
  })

const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* ()
  {
    const { response, body } = yield* exchangeAccessToken(credential)
    if (!responseOk(response))
    {
      return yield* new AuthenticationGetterError({
        message: `Expected bearer bootstrap response to succeed, got ${response.status}`,
      })
    }

    if (!body.access_token)
    {
      return yield* new AuthenticationGetterError({
        message: 'Expected token exchange response to include an access token.',
      })
    }

    return body.access_token
  })

const extractSessionTokenFromSetCookie = (cookieHeader: string): string =>
{
  const [nameValue] = cookieHeader.split(';', 1)
  const token = nameValue?.split('=', 2)[1]
  if (!token)
  {
    throw new Error('Expected session cookie header to contain a token value.')
  }
  return token
}

const splitHeaderTokens = (value: string | null | undefined) =>
  (value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted()

const assertBrowserApiCorsResponseHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string
    readonly credentials?: boolean
  },
) =>
{
  assert.equal(headers['access-control-allow-origin'], options?.origin ?? '*')
  assert.equal(
    headers['access-control-allow-credentials'],
    options?.credentials ? 'true' : undefined,
  )
}

const assertBrowserApiCorsPreflightHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string
    readonly credentials?: boolean
  },
) =>
{
  assertBrowserApiCorsResponseHeaders(headers, options)
  assert.deepEqual(splitHeaderTokens(headers['access-control-allow-methods'] ?? null), [
    'GET',
    'OPTIONS',
    'POST',
  ])
  assert.deepEqual(splitHeaderTokens(headers['access-control-allow-headers']), [
    'authorization',
    'b3',
    'content-type',
    'dpop',
    'traceparent',
  ])
}
const crossOriginClientOrigin = 'http://remote-client.test:3773'

const getWsServerUrl = (
  pathname = '',
  options?: { authenticated?: boolean; credential?: string },
) =>
  Effect.gen(function* ()
  {
    const server = yield* HttpServer.HttpServer
    const address = server.address as HttpServer.TcpAddress
    const baseUrl = `ws://127.0.0.1:${address.port}${pathname}`
    if (options?.authenticated === false)
    {
      return baseUrl
    }
    return appendSessionCookieToWsUrl(
      baseUrl,
      yield* getAuthenticatedSessionCookieHeader(options?.credential),
    )
  })

it.layer(NodeServices.layer)('server router seam', (it) =>
{
  it.effect('composes source control discovery over the exact root services', () =>
    Effect.gen(function* ()
    {
      const cwd = '/tmp/source-control-discovery-layer-sentinel'
      const baseDir = '/tmp/source-control-discovery-layer-sentinel-state'
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined)
      const config = ServerConfig.make({
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
        mode: 'desktop',
        port: 0,
        host: '127.0.0.1',
        cwd,
        baseDir,
        ...derivedPaths,
        staticDir: undefined,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: 'browser',
        desktopBootstrapToken: defaultDesktopBootstrapToken,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      })
      const processInputs: Array<VcsProcess.VcsProcessInput> = []
      const process = VcsProcess.VcsProcess.of({
        run: (input) =>
          Effect.sync(() =>
          {
            processInputs.push(input)
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: `${input.command} sentinel version`,
              stderr: '',
              stdoutTruncated: false,
              stderrTruncated: false,
            }
          }),
      })
      const sourceControlProviders: SourceControlDiscoveryResult['sourceControlProviders'] = [
        {
          kind: 'github',
          label: 'Sentinel GitHub',
          executable: 'sentinel-gh',
          status: 'available',
          version: Option.some('sentinel-version'),
          installHint: 'sentinel install hint',
          detail: Option.none(),
          auth: {
            status: 'authenticated',
            account: Option.some('sentinel-account'),
            host: Option.none(),
            detail: Option.none(),
          },
        },
      ]
      let providerDiscoveryCalls = 0
      const providerRegistry = SourceControlProviderRegistry.SourceControlProviderRegistry.of({
        get: () => Effect.die('unused source control provider lookup'),
        resolveHandle: () => Effect.die('unused source control provider handle resolution'),
        resolve: () => Effect.die('unused source control provider resolution'),
        discover: Effect.sync(() =>
        {
          providerDiscoveryCalls += 1
          return sourceControlProviders
        }),
      })
      const rootServices = Layer.mergeAll(
        Layer.succeed(ServerConfig.ServerConfig, config),
        Layer.succeed(VcsProcess.VcsProcess, process),
        Layer.succeed(
          SourceControlProviderRegistry.SourceControlProviderRegistry,
          providerRegistry,
        ),
      )

      yield* Effect.gen(function* ()
      {
        const discovery = yield* SourceControlDiscovery.SourceControlDiscovery
        const result = yield* discovery.discover

        assert.equal(providerDiscoveryCalls, 1)
        assert.deepEqual(
          processInputs
            .map((input) => ({ command: input.command, cwd: input.cwd }))
            .sort((left, right) => left.command.localeCompare(right.command)),
          [
            { command: 'git', cwd },
            { command: 'jj', cwd },
          ],
        )
        assert.deepEqual(result.sourceControlProviders, sourceControlProviders)
        assert.deepEqual(
          result.versionControlSystems.map((item) => item.kind),
          ['git', 'jj'],
        )
      }).pipe(Effect.provide(makeSourceControlDiscoveryLayer(rootServices)))
    }),
  )

  it.effect('serves static index content for GET / when staticDir is configured', () =>
    Effect.gen(function* ()
    {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: 't3-router-static-' })
      const indexPath = path.join(staticDir, 'index.html')
      yield* fileSystem.writeFileString(indexPath, '<html>router-static-ok</html>')

      yield* buildAppUnderTest({ config: { staticDir } })

      const response = yield* HttpClient.get('/')
      assert.equal(response.status, 200)
      assert.include(yield* response.text, 'router-static-ok')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('redirects to dev URL when configured', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        config: { devUrl: new URL('http://127.0.0.1:5173') },
      })

      const url = yield* getHttpServerUrl('/foo/bar?token=test-token')
      const response = yield* fetchEffect(url, { redirect: 'manual' })

      assert.equal(response.status, 302)
      assert.equal(response.headers.location, 'http://127.0.0.1:5173/foo/bar?token=test-token')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('serves the public environment descriptor without requiring auth', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const url = yield* getHttpServerUrl('/.well-known/t3/environment')
      const response = yield* fetchEffect(url, {
        headers: {
          origin: crossOriginClientOrigin,
        },
      })
      const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response)

      assert.equal(response.status, 200)
      assertBrowserApiCorsResponseHeaders(response.headers)
      assert.deepEqual(body, testEnvironmentDescriptor)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('reports unauthenticated session state without requiring auth', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const url = yield* getHttpServerUrl('/api/auth/session')
      const response = yield* fetchEffect(url)
      const body = yield* responseJsonEffect<{
        readonly authenticated: boolean
        readonly auth: {
          readonly policy: string
          readonly bootstrapMethods: ReadonlyArray<string>
          readonly sessionMethods: ReadonlyArray<string>
          readonly sessionCookieName: string
        }
      }>(response)

      assert.equal(response.status, 200)
      assert.equal(body.authenticated, false)
      assert.equal(body.auth.policy, 'desktop-managed-local')
      assert.deepEqual(body.auth.bootstrapMethods, ['desktop-bootstrap'])
      assert.deepEqual(body.auth.sessionMethods, [
        'browser-session-cookie',
        'bearer-access-token',
        'dpop-access-token',
      ])
      assert.isTrue(body.auth.sessionCookieName.startsWith('t3_session_'))
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('bootstraps a browser session and authenticates the session endpoint via cookie', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const {
        response: bootstrapResponse,
        body: bootstrapBody,
        cookie: setCookie,
      } = yield* bootstrapBrowserSession()

      assert.equal(bootstrapResponse.status, 200)
      assert.equal(bootstrapBody.authenticated, true)
      assert.equal(bootstrapBody.sessionMethod, 'browser-session-cookie')
      assert.isUndefined((bootstrapBody as { readonly sessionToken?: string }).sessionToken)
      assert.isDefined(setCookie)

      const sessionUrl = yield* getHttpServerUrl('/api/auth/session')
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          cookie: setCookie?.split(';')[0] ?? '',
        },
      })
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean
        readonly sessionMethod?: string
      }>(sessionResponse)

      assert.equal(sessionResponse.status, 200)
      assert.equal(sessionBody.authenticated, true)
      assert.equal(sessionBody.sessionMethod, 'browser-session-cookie')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('exchanges a bootstrap grant for a scoped bearer access token', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken()

      assert.equal(tokenResponse.status, 200)
      assert.equal(tokenBody.issued_token_type, AuthAccessTokenType)
      assert.equal(tokenBody.token_type, 'Bearer')
      assert.equal(
        tokenBody.scope,
        'orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write',
      )
      assert.equal(typeof tokenBody.access_token, 'string')

      const sessionUrl = yield* getHttpServerUrl('/api/auth/session')
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ''}`,
        },
      })
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean
        readonly sessionMethod?: string
        readonly scopes?: ReadonlyArray<string>
      }>(sessionResponse)

      assert.equal(sessionResponse.status, 200)
      assert.equal(sessionBody.authenticated, true)
      assert.equal(sessionBody.sessionMethod, 'bearer-access-token')
      assert.deepEqual(sessionBody.scopes, [
        'orchestration:read',
        'orchestration:operate',
        'terminal:operate',
        'review:write',
        'relay:read',
        'access:read',
        'access:write',
        'relay:write',
      ])
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('persists token exchange client display metadata for authorized-client listings', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        config: {
          host: '0.0.0.0',
        },
      })

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const pairingResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string
      }

      const { response } = yield* exchangeAccessToken(pairingBody.credential, {
        headers: {
          'user-agent': 'undici',
        },
        scope: 'orchestration:read orchestration:operate terminal:operate review:write',
        clientMetadata: {
          label: '456code Mobile',
          deviceType: 'mobile',
          os: 'iOS',
        },
      })

      const clientsResponse = yield* HttpClient.get('/api/auth/clients', {
        headers: {
          cookie: ownerCookie,
        },
      })
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly current: boolean
        readonly client: {
          readonly label?: string
          readonly deviceType: string
          readonly ipAddress?: string
          readonly os?: string
          readonly userAgent?: string
        }
      }>
      const mobileClient = clients.find((client) => !client.current)

      assert.equal(pairingResponse.status, 200)
      assert.equal(response.status, 200)
      assert.equal(clientsResponse.status, 200)
      assert.deepInclude(mobileClient?.client, {
        label: '456code Mobile',
        deviceType: 'mobile',
        os: 'iOS',
        ipAddress: '127.0.0.1',
        userAgent: 'undici',
      })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('streams pairing consumption changes in their causal revision order', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        config: {
          host: '0.0.0.0',
        },
      })

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const snapshotSeen = yield* Deferred.make<void>()
      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl('/ws', { authenticated: false }),
        ownerCookie,
      )
      const events = yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const eventsFiber = yield* withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeAuthAccess]({}).pipe(
              Stream.tap((event) =>
                event.type === 'snapshot'
                  ? Deferred.succeed(snapshotSeen, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Stream.take(4),
              Stream.runCollect,
            ),
          ).pipe(Effect.forkScoped)

          yield* Deferred.await(snapshotSeen)
          const pairingResponse = yield* HttpClient.post('/api/auth/pairing-token', {
            headers: {
              cookie: ownerCookie,
            },
            body: yield* HttpBody.json({ label: '456code Mobile' }),
          })
          const pairingBody = (yield* pairingResponse.json) as {
            readonly credential: string
          }
          const { response: exchangeResponse } = yield* exchangeAccessToken(
            pairingBody.credential,
            {
              scope: 'orchestration:read orchestration:operate terminal:operate review:write',
              clientMetadata: {
                label: '456code Mobile',
                deviceType: 'mobile',
                os: 'iOS',
              },
            },
          )

          assert.equal(pairingResponse.status, 200)
          assert.equal(exchangeResponse.status, 200)
          return yield* Fiber.join(eventsFiber)
        }),
      ).pipe(Effect.timeout('2 seconds'))

      assert.deepEqual(
        Array.from(events, (event) => event.type),
        ['snapshot', 'pairingLinkUpserted', 'clientUpserted', 'pairingLinkRemoved'],
      )
      assert.deepEqual(
        Array.from(events, (event) => event.revision),
        [1, 2, 3, 4],
      )
      assert.equal(events[2]?.type, 'clientUpserted')
      if (events[2]?.type === 'clientUpserted')
      {
        assert.equal(events[2].payload.current, false)
      }
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect(
    'exchanges a bootstrap credential for a DPoP-bound access token without bearer downgrade',
    () =>
      Effect.gen(function* ()
      {
        yield* buildAppUnderTest()

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
        const credentialResponse = yield* HttpClient.post('/api/auth/pairing-token', {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({}),
        })
        const credential = (yield* credentialResponse.json) as { readonly credential: string }
        const tokenUrl = yield* getHttpServerUrl('/oauth/token')
        const now = yield* DateTime.now
        const tokenProof = makeDpopProof({
          method: 'POST',
          url: tokenUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
          jti: 'token-exchange-proof',
        })
        const tokenResponse = yield* fetchEffect(tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            dpop: tokenProof.proof,
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: credential.credential,
            subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            scope: 'orchestration:read orchestration:operate terminal:operate review:write',
          }).toString(),
        })
        const token = yield* responseJsonEffect<{
          readonly access_token: string
          readonly token_type: string
        }>(tokenResponse)

        assert.equal(tokenResponse.status, 200)
        assert.equal(tokenResponse.headers['cache-control'], 'no-store')
        assert.equal(token.token_type, 'DPoP')

        const sessionUrl = yield* getHttpServerUrl('/api/auth/session')
        const bearerResponse = yield* fetchEffect(sessionUrl, {
          headers: { authorization: `Bearer ${token.access_token}` },
        })
        const bearerState = yield* responseJsonEffect<{ readonly authenticated: boolean }>(
          bearerResponse,
        )
        assert.equal(bearerState.authenticated, false)

        const sessionProof = makeDpopProof({
          method: 'GET',
          url: sessionUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
          jti: 'session-proof',
          accessToken: token.access_token,
          privateKey: tokenProof.privateKey,
          publicJwk: tokenProof.publicJwk,
        })
        const dpopResponse = yield* fetchEffect(sessionUrl, {
          headers: {
            authorization: `DPoP ${token.access_token}`,
            dpop: sessionProof.proof,
          },
        })
        const dpopState = yield* responseJsonEffect<{
          readonly authenticated: boolean
          readonly sessionMethod?: string
        }>(dpopResponse)
        assert.equal(dpopState.authenticated, true)
        assert.equal(dpopState.sessionMethod, 'dpop-access-token')
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('rejects replayed DPoP proofs across token exchanges', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const firstCredentialResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const firstCredential = (yield* firstCredentialResponse.json) as {
        readonly credential: string
      }
      const secondCredentialResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const secondCredential = (yield* secondCredentialResponse.json) as {
        readonly credential: string
      }
      const tokenUrl = yield* getHttpServerUrl('/oauth/token')
      const now = yield* DateTime.now
      const dpop = makeDpopProof({
        method: 'POST',
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      })

      const firstBootstrap = yield* exchangeAccessToken(firstCredential.credential, {
        headers: {
          dpop: dpop.proof,
        },
        scope: 'orchestration:read orchestration:operate terminal:operate review:write',
      })
      const replayBootstrap = yield* exchangeAccessToken(secondCredential.credential, {
        headers: {
          dpop: dpop.proof,
        },
        scope: 'orchestration:read orchestration:operate terminal:operate review:write',
      })

      assert.equal(firstBootstrap.response.status, 200)
      assert.equal(replayBootstrap.response.status, 401)
      assert.equal(replayBootstrap.body._tag, 'EnvironmentAuthInvalidError')
      assert.equal(replayBootstrap.body.code, 'auth_invalid')
      assert.equal(replayBootstrap.body.reason, 'invalid_credential')
      assert.equal(typeof replayBootstrap.body.traceId, 'string')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('ignores forwarded host headers when validating token exchange DPoP URLs', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const credentialResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const credential = (yield* credentialResponse.json) as {
        readonly credential: string
      }
      const tokenUrl = yield* getHttpServerUrl('/oauth/token')
      const now = yield* DateTime.now
      const dpop = makeDpopProof({
        method: 'POST',
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      })

      const bootstrap = yield* exchangeAccessToken(credential.credential, {
        headers: {
          dpop: dpop.proof,
          'x-forwarded-host': 'environment.example.test',
        },
        scope: 'orchestration:read orchestration:operate terminal:operate review:write',
      })

      assert.equal(bootstrap.response.status, 200)
      assert.equal(bootstrap.body.token_type, 'DPoP')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('rejects token exchange DPoP proofs bound to spoofed forwarded hosts', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const credentialResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const credential = (yield* credentialResponse.json) as {
        readonly credential: string
      }
      const tokenUrl = yield* getHttpServerUrl('/oauth/token')
      const spoofedUrl = new URL(tokenUrl)
      spoofedUrl.hostname = 'environment.example.test'
      const now = yield* DateTime.now
      const dpop = makeDpopProof({
        method: 'POST',
        url: spoofedUrl.href,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      })

      const bootstrap = yield* exchangeAccessToken(credential.credential, {
        headers: {
          dpop: dpop.proof,
          'x-forwarded-host': spoofedUrl.host,
        },
        scope: 'orchestration:read orchestration:operate terminal:operate review:write',
      })

      assert.equal(bootstrap.response.status, 401)
      assert.equal(bootstrap.body._tag, 'EnvironmentAuthInvalidError')
      assert.equal(bootstrap.body.code, 'auth_invalid')
      assert.equal(bootstrap.body.reason, 'invalid_credential')
      assert.equal(typeof bootstrap.body.traceId, 'string')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('does not allow management-only access tokens to operate the environment', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const { response: exchangeResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        { scope: 'access:write' },
      )
      assert.equal(exchangeResponse.status, 200)
      assert.equal(tokenBody.scope, 'access:write')
      assert.isDefined(tokenBody.access_token)

      const overbroadPairingResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ''}`,
        },
        body: yield* HttpBody.json({}),
      })
      const overbroadPairingBody = (yield* overbroadPairingResponse.json) as {
        readonly requiredScope: string
      }
      const pairingResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ''}`,
        },
        body: yield* HttpBody.json({ scopes: ['access:write'] }),
      })
      const wsTicketResponse = yield* HttpClient.post('/api/auth/websocket-ticket', {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ''}`,
        },
      })
      const wsTicketBody = (yield* wsTicketResponse.json) as { readonly ticket: string }
      assert.equal(overbroadPairingResponse.status, 403)
      assert.equal(overbroadPairingBody.requiredScope, 'orchestration:read')
      assert.equal(pairingResponse.status, 200)
      assert.equal(wsTicketResponse.status, 200)
      const wsUrl = `${yield* getWsServerUrl('/ws', { authenticated: false })}?wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`
      const rpcErrors = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            serverConfig: client[WS_METHODS.serverGetConfig]({}).pipe(Effect.flip),
            sourceControlDiscovery: client[WS_METHODS.serverDiscoverSourceControl]({}).pipe(
              Effect.flip,
            ),
            mdxDocument: client[WS_METHODS.projectsReadMdxDocument]({
              threadId: defaultThreadId,
              relativePath: 'overview.mdx',
            }).pipe(Effect.flip),
          }),
        ),
      )
      for (const rpcError of Object.values(rpcErrors))
      {
        assert.equal(rpcError._tag, 'EnvironmentAuthorizationError')
        if (rpcError._tag === 'EnvironmentAuthorizationError')
        {
          assert.equal(rpcError.requiredScope, 'orchestration:read')
        }
      }
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('includes CORS headers on remote auth success responses', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const origin = crossOriginClientOrigin
      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        {
          headers: { origin },
        },
      )

      assert.equal(tokenResponse.status, 200)
      assertBrowserApiCorsResponseHeaders(tokenResponse.headers)
      assert.equal(tokenBody.token_type, 'Bearer')
      assert.equal(typeof tokenBody.access_token, 'string')

      const sessionUrl = yield* getHttpServerUrl('/api/auth/session')
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ''}`,
          origin,
        },
      })
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean
        readonly sessionMethod?: string
      }>(sessionResponse)

      assert.equal(sessionResponse.status, 200)
      assertBrowserApiCorsResponseHeaders(sessionResponse.headers)
      assert.equal(sessionBody.authenticated, true)
      assert.equal(sessionBody.sessionMethod, 'bearer-access-token')

      const wsTicketUrl = yield* getHttpServerUrl('/api/auth/websocket-ticket')
      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ''}`,
          origin,
        },
      })
      const wsTicketBody = yield* responseJsonEffect<{
        readonly ticket: string
      }>(wsTicketResponse)

      assert.equal(wsTicketResponse.status, 200)
      assertBrowserApiCorsResponseHeaders(wsTicketResponse.headers)
      assert.equal(typeof wsTicketBody.ticket, 'string')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect(
    'responds to remote auth websocket-ticket preflight requests with authorization CORS headers',
    () =>
      Effect.gen(function* ()
      {
        yield* buildAppUnderTest()

        const wsTicketUrl = yield* getHttpServerUrl('/api/auth/websocket-ticket')
        const response = yield* fetchEffect(wsTicketUrl, {
          method: 'OPTIONS',
          headers: {
            origin: crossOriginClientOrigin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization',
          },
        })

        assert.equal(response.status, 204)
        assertBrowserApiCorsPreflightHeaders(response.headers)
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  for (const desktopOrigin of ['code456://app', 'code456-dev://app'])
  {
    it.effect(`allows credentialed preflights from ${desktopOrigin} in development`, () =>
      Effect.gen(function* ()
      {
        yield* buildAppUnderTest({
          config: { devUrl: new URL(crossOriginClientOrigin) },
        })

        const sessionUrl = yield* getHttpServerUrl('/api/auth/session')
        const response = yield* fetchEffect(sessionUrl, {
          method: 'OPTIONS',
          headers: {
            origin: desktopOrigin,
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'content-type',
          },
        })

        assert.equal(response.status, 204)
        assertBrowserApiCorsPreflightHeaders(response.headers, {
          origin: desktopOrigin,
          credentials: true,
        })
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
    )
  }

  it.effect('includes CORS headers on remote websocket-ticket auth failures', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const wsTicketUrl = yield* getHttpServerUrl('/api/auth/websocket-ticket')
      const response = yield* fetchEffect(wsTicketUrl, {
        method: 'POST',
        headers: {
          origin: crossOriginClientOrigin,
        },
      })
      const body = yield* responseJsonEffect<{
        readonly _tag?: string
        readonly code?: string
        readonly reason?: string
        readonly traceId?: string
      }>(response)

      assert.equal(response.status, 401)
      assertBrowserApiCorsResponseHeaders(response.headers)
      assert.equal(body._tag, 'EnvironmentAuthInvalidError')
      assert.equal(body.code, 'auth_invalid')
      assert.equal(body.reason, 'missing_credential')
      assert.equal(typeof body.traceId, 'string')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('issues authenticated one-time pairing credentials for additional clients', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const response = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({}),
      })
      const body = (yield* response.json) as {
        readonly credential: string
        readonly expiresAt: string
      }

      assert.equal(response.status, 200)
      assert.equal(typeof body.credential, 'string')
      assert.isTrue(body.credential.length > 0)
      assert.equal(typeof body.expiresAt, 'string')

      const bootstrapResult = yield* bootstrapBrowserSession(body.credential)
      assert.equal(bootstrapResult.response.status, 200)

      const reusedResult = yield* bootstrapBrowserSession(body.credential)
      assert.equal(reusedResult.response.status, 401)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('issues pairing credentials for bearer sessions with access management scope', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const bearerToken = yield* getAuthenticatedBearerSessionToken()
      const response = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
        body: yield* HttpBody.json({ label: 'Hosted web' }),
      })
      const body = (yield* response.json) as {
        readonly credential: string
        readonly label?: string
      }

      assert.equal(response.status, 200)
      assert.isTrue(body.credential.length > 0)
      assert.equal(body.label, 'Hosted web')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('rejects pairing credentials with an empty scope grant', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const response = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({ scopes: [] }),
      })
      const body = (yield* response.json) as {
        readonly code: string
        readonly reason: string
      }

      assert.equal(response.status, 400)
      assert.equal(body.code, 'invalid_request')
      assert.equal(body.reason, 'invalid_scope')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('rejects recovery scope grants through the pairing route', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const response = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({ scopes: [AuthOrchestrationRecoverScope] }),
      })
      const body = (yield* response.json) as {
        readonly code: string
        readonly reason: string
      }

      assert.equal(response.status, 400)
      assert.equal(body.code, 'invalid_request')
      assert.equal(body.reason, 'invalid_scope')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('mounts recovery diagnostics behind orchestration read authority', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const unauthenticated = yield* HttpClient.get('/api/recovery/actions')
      assert.equal(unauthenticated.status, 401)

      const { body: readToken } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: 'orchestration:read',
      })
      const response = yield* HttpClient.get('/api/recovery/actions', {
        headers: { authorization: `Bearer ${readToken.access_token ?? ''}` },
      })
      const body = (yield* response.json) as {
        readonly items: ReadonlyArray<unknown>
        readonly truncated: boolean
        readonly nextCursor: string | null
      }

      assert.equal(response.status, 200)
      assert.deepEqual(body, { items: [], truncated: false, nextCursor: null })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('rejects unauthenticated pairing credential requests', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const response = yield* HttpClient.post('/api/auth/pairing-token', {
        body: yield* HttpBody.json({}),
      })
      assert.equal(response.status, 401)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('lists and revokes pairing links for access management sessions', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        config: {
          host: '0.0.0.0',
        },
      })

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const createdResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const createdBody = (yield* createdResponse.json) as {
        readonly id: string
        readonly credential: string
      }

      const listResponse = yield* HttpClient.get('/api/auth/pairing-links', {
        headers: {
          cookie: ownerCookie,
        },
      })
      const listedLinks = (yield* listResponse.json) as ReadonlyArray<{
        readonly id: string
        readonly credential: string
      }>

      const revokeResponse = yield* HttpClient.post('/api/auth/pairing-links/revoke', {
        headers: {
          cookie: ownerCookie,
          'content-type': 'application/json',
        },
        body: HttpBody.text(jsonRequestBody({ id: createdBody.id }), 'application/json'),
      })
      const revokedBootstrap = yield* bootstrapBrowserSession(createdBody.credential)

      assert.equal(createdResponse.status, 200)
      assert.equal(listResponse.status, 200)
      assert.isTrue(listedLinks.some((entry) => entry.id === createdBody.id))
      assert.equal(revokeResponse.status, 200)
      assert.equal(revokedBootstrap.response.status, 401)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('rejects pairing credential requests without access management scope', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        config: {
          host: '0.0.0.0',
        },
      })

      const ownerResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({}),
      })
      const ownerBody = (yield* ownerResponse.json) as {
        readonly credential: string
      }
      assert.equal(ownerResponse.status, 200)

      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(ownerBody.credential)
      const pairedResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: pairedSessionCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const pairedBody = (yield* pairedResponse.json) as {
        readonly _tag: string
        readonly code: string
        readonly requiredScope: string
        readonly traceId: string
      }

      assert.equal(pairedResponse.status, 403)
      assert.equal(pairedBody._tag, 'EnvironmentScopeRequiredError')
      assert.equal(pairedBody.code, 'insufficient_scope')
      assert.equal(pairedBody.requiredScope, 'access:write')
      assert.equal(typeof pairedBody.traceId, 'string')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('lists paired clients and revokes other sessions while keeping the administrator', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        config: {
          host: '0.0.0.0',
        },
      })

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const pairingTokenUrl = yield* getHttpServerUrl('/api/auth/pairing-token')
      const ownerPairingResponse = yield* fetchEffect(pairingTokenUrl, {
        method: 'POST',
        headers: {
          cookie: ownerCookie,
          'content-type': 'application/json',
        },
        body: jsonRequestBody({
          label: 'Julius iPhone',
        }),
      })
      const ownerPairingBody = yield* responseJsonEffect<{
        readonly credential: string
        readonly label?: string
      }>(ownerPairingResponse)
      assert.equal(ownerPairingResponse.status, 200)
      const pairedSessionBootstrap = yield* bootstrapBrowserSession(ownerPairingBody.credential, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        },
      })
      const pairedSessionCookie = pairedSessionBootstrap.cookie?.split(';')[0]
      assert.isDefined(pairedSessionCookie)

      const pairedSessionCookieHeader = pairedSessionCookie ?? ''
      const listBeforeResponse = yield* HttpClient.get('/api/auth/clients', {
        headers: {
          cookie: ownerCookie,
        },
      })
      const clientsBefore = (yield* listBeforeResponse.json) as ReadonlyArray<{
        readonly sessionId: string
        readonly current: boolean
        readonly client: {
          readonly label?: string
          readonly deviceType: string
          readonly ipAddress?: string
          readonly os?: string
          readonly browser?: string
        }
      }>
      const pairedClientBefore = clientsBefore.find((entry) => !entry.current)
      const pairedSessionId = clientsBefore.find((entry) => !entry.current)?.sessionId

      const revokeOthersResponse = yield* HttpClient.post('/api/auth/clients/revoke-others', {
        headers: {
          cookie: ownerCookie,
        },
      })
      const revokeOthersBody = (yield* revokeOthersResponse.json) as {
        readonly revokedCount: number
      }

      const listAfterResponse = yield* HttpClient.get('/api/auth/clients', {
        headers: {
          cookie: ownerCookie,
        },
      })
      const clientsAfter = (yield* listAfterResponse.json) as ReadonlyArray<{
        readonly sessionId: string
        readonly current: boolean
      }>

      const pairedClientPairingResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: pairedSessionCookieHeader,
        },
        body: yield* HttpBody.json({}),
      })
      const pairedClientPairingBody = (yield* pairedClientPairingResponse.json) as {
        readonly _tag: string
        readonly code: string
        readonly reason: string
        readonly traceId: string
      }

      assert.equal(listBeforeResponse.status, 200)
      assert.equal(ownerPairingBody.label, 'Julius iPhone')
      assert.lengthOf(clientsBefore, 2)
      assert.isDefined(pairedSessionId)
      assert.isDefined(pairedClientBefore)
      assert.deepInclude(pairedClientBefore?.client, {
        label: 'Julius iPhone',
        deviceType: 'mobile',
        os: 'iOS',
        browser: 'Safari',
        ipAddress: '127.0.0.1',
      })
      assert.equal(revokeOthersResponse.status, 200)
      assert.equal(revokeOthersBody.revokedCount, 1)
      assert.equal(listAfterResponse.status, 200)
      assert.lengthOf(clientsAfter, 1)
      assert.equal(clientsAfter[0]?.current, true)
      assert.equal(pairedClientPairingResponse.status, 401)
      assert.equal(pairedClientPairingBody._tag, 'EnvironmentAuthInvalidError')
      assert.equal(pairedClientPairingBody.code, 'auth_invalid')
      assert.equal(pairedClientPairingBody.reason, 'invalid_credential')
      assert.equal(typeof pairedClientPairingBody.traceId, 'string')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('separates access inventory reads from credential management writes', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        config: {
          host: '0.0.0.0',
        },
      })

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const issueScopedSession = Effect.fnUntraced(function* (
        scope: 'access:read' | 'access:write',
      )
      {
        const pairingResponse = yield* HttpClient.post('/api/auth/pairing-token', {
          headers: {
            cookie: ownerCookie,
          },
          body: yield* HttpBody.json({ scopes: [scope] }),
        })
        assert.equal(pairingResponse.status, 200)
        const pairingBody = (yield* pairingResponse.json) as {
          readonly credential: string
        }
        return yield* getAuthenticatedSessionCookieHeader(pairingBody.credential)
      })

      const readCookie = yield* issueScopedSession('access:read')
      const readListResponse = yield* HttpClient.get('/api/auth/clients', {
        headers: {
          cookie: readCookie,
        },
      })
      const readWriteResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: readCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const readWriteBody = (yield* readWriteResponse.json) as {
        readonly requiredScope: string
      }

      const writeCookie = yield* issueScopedSession('access:write')
      const writeListResponse = yield* HttpClient.get('/api/auth/clients', {
        headers: {
          cookie: writeCookie,
        },
      })
      const writeListBody = (yield* writeListResponse.json) as {
        readonly requiredScope: string
      }

      assert.equal(readListResponse.status, 200)
      assert.equal(readWriteResponse.status, 403)
      assert.equal(readWriteBody.requiredScope, 'access:write')
      assert.equal(writeListResponse.status, 403)
      assert.equal(writeListBody.requiredScope, 'access:read')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('revokes an individual paired client session', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        config: {
          host: '0.0.0.0',
        },
      })

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader()
      const pairingResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      })
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string
      }
      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(pairingBody.credential)

      const clientsResponse = yield* HttpClient.get('/api/auth/clients', {
        headers: {
          cookie: ownerCookie,
        },
      })
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly sessionId: string
        readonly current: boolean
      }>
      const pairedSessionId = clients.find((entry) => !entry.current)?.sessionId
      assert.isDefined(pairedSessionId)

      const revokeResponse = yield* HttpClient.post('/api/auth/clients/revoke', {
        headers: {
          cookie: ownerCookie,
          'content-type': 'application/json',
        },
        body: HttpBody.text(jsonRequestBody({ sessionId: pairedSessionId }), 'application/json'),
      })
      const pairedClientPairingResponse = yield* HttpClient.post('/api/auth/pairing-token', {
        headers: {
          cookie: pairedSessionCookie,
        },
        body: yield* HttpBody.json({}),
      })

      assert.equal(revokeResponse.status, 200)
      assert.equal(pairedClientPairingResponse.status, 401)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('allows reusing the desktop bootstrap credential', () =>
    Effect.gen(function* ()
    {
      // the desktop-bootstrap grant is delivered over trusted IPC at
      // backend launch and needs to stay claimable after a renderer
      // refresh, so it's intentionally reusable (unlike user-facing
      // one-time pairing credentials).
      yield* buildAppUnderTest()

      const first = yield* bootstrapBrowserSession()
      const second = yield* bootstrapBrowserSession()

      assert.equal(first.response.status, 200)
      assert.equal(second.response.status, 200)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('accepts websocket rpc handshake with a bootstrapped browser session cookie', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const { response: bootstrapResponse, cookie } = yield* bootstrapBrowserSession()

      assert.equal(bootstrapResponse.status, 200)
      assert.isDefined(cookie)

      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl('/ws', { authenticated: false }),
        cookie?.split(';')[0] ?? '',
      )
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      )

      assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId)
      assert.equal(response.auth.policy, 'desktop-managed-local')
      assert.deepEqual(response.remoteOpenTargets, [])
      assert.equal(response.shellResumeCompletionMarker, true)
      assert.equal(response.threadResumeCompletionMarker, true)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('does not block server config when editor discovery never resolves', () =>
    Effect.gen(function* ()
    {
      const discoveryInterrupted = yield* Deferred.make<void>()
      const responseFiber = yield* resolveAvailableEditorsForConfig(
        Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
        ),
      ).pipe(Effect.forkChild)

      yield* TestClock.adjust(Duration.seconds(5))

      const availableEditors = yield* Fiber.join(responseFiber)
      yield* Deferred.await(discoveryInterrupted)
      assert.deepEqual(availableEditors, [])
    }),
  )

  it.effect(
    'rejects websocket rpc handshake when a session token is only provided via query string',
    () =>
      Effect.gen(function* ()
      {
        yield* buildAppUnderTest()

        const { cookie } = yield* bootstrapBrowserSession()
        assert.isDefined(cookie)
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? '')
        const wsUrl = `${yield* getWsServerUrl('/ws', { authenticated: false })}?token=${encodeURIComponent(sessionToken)}`

        const error = yield* Effect.flip(
          Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
        )

        assert.equal(error._tag, 'RpcClientError')
        assertInclude(String(error), 'SocketOpenError')
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect(
    'accepts websocket rpc handshake with a dedicated websocket ticket in the query string',
    () =>
      Effect.gen(function* ()
      {
        yield* buildAppUnderTest()

        const bearerToken = yield* getAuthenticatedBearerSessionToken()
        const wsTicketUrl = yield* getHttpServerUrl('/api/auth/websocket-ticket')
        const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearerToken}`,
          },
        })
        const wsTicketBody = yield* responseJsonEffect<{
          readonly ticket: string
          readonly expiresAt: string
        }>(wsTicketResponse)

        assert.equal(wsTicketResponse.status, 200)
        assert.equal(typeof wsTicketBody.ticket, 'string')
        assert.isTrue(wsTicketBody.ticket.length > 0)
        assert.equal(typeof wsTicketBody.expiresAt, 'string')

        const wsUrl = `${yield* getWsServerUrl('/ws', { authenticated: false })}?wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        )

        assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId)
        assert.equal(response.auth.policy, 'desktop-managed-local')
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('proxies browser OTLP trace exports through the server', () =>
    Effect.gen(function* ()
    {
      const upstreamRequests: Array<{
        readonly body: string
        readonly contentType: string | null
      }> = []
      const localTraceRecords: Array<unknown> = []
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: 'service.name',
                  value: { stringValue: 't3-web' },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: 'effect',
                  version: '4.0.0-beta.43',
                },
                spans: [
                  {
                    traceId: '11111111111111111111111111111111',
                    spanId: '2222222222222222',
                    parentSpanId: '3333333333333333',
                    name: 'RpcClient.server.getSettings',
                    kind: 3,
                    startTimeUnixNano: '1000000',
                    endTimeUnixNano: '2000000',
                    attributes: [
                      {
                        key: 'rpc.method',
                        value: { stringValue: 'server.getSettings' },
                      },
                    ],
                    events: [
                      {
                        name: 'http.request',
                        timeUnixNano: '1500000',
                        attributes: [
                          {
                            key: 'http.status_code',
                            value: { intValue: '200' },
                          },
                        ],
                      },
                    ],
                    links: [],
                    status: {
                      code: 'STATUS_CODE_OK',
                    },
                    flags: 1,
                  },
                ],
              },
            ],
          },
        ],
      }

      const collector = yield* Effect.acquireRelease(
        Effect.promise(async () =>
        {
          const NodeHttp = await import('node:http')

          return await new Promise<{
            readonly close: () => Promise<void>
            readonly url: string
          }>((resolve, reject) =>
          {
            const server = NodeHttp.createServer((request, response) =>
            {
              const chunks: Buffer[] = []
              request.on('data', (chunk) =>
              {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
              })
              request.on('end', () =>
              {
                upstreamRequests.push({
                  body: Buffer.concat(chunks).toString('utf8'),
                  contentType: request.headers['content-type'] ?? null,
                })
                response.statusCode = 204
                response.end()
              })
            })

            server.on('error', reject)
            server.listen(0, '127.0.0.1', () =>
            {
              const address = server.address()
              if (!address || typeof address === 'string')
              {
                reject(new Error('Expected TCP collector address'))
                return
              }

              resolve({
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                close: () =>
                  new Promise<void>((resolveClose, rejectClose) =>
                  {
                    server.close((error) =>
                    {
                      if (error)
                      {
                        rejectClose(error)
                        return
                      }
                      resolveClose()
                    })
                  }),
              })
            })
          })
        }),
        ({ close }) => Effect.promise(close),
      )

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: collector.url,
        },
        layers: {
          browserTraceCollector: {
            record: (records) =>
              Effect.sync(() =>
              {
                localTraceRecords.push(...records)
              }),
          },
        },
      })

      const response = yield* HttpClient.post('/api/observability/v1/traces', {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          'content-type': 'application/json',
          origin: 'http://localhost:5733',
        },
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        body: HttpBody.text(JSON.stringify(payload), 'application/json'),
      })

      assert.equal(response.status, 204)
      assert.equal(response.headers['access-control-allow-origin'], '*')
      assert.deepEqual(localTraceRecords, [
        {
          type: 'otlp-span',
          name: 'RpcClient.server.getSettings',
          traceId: '11111111111111111111111111111111',
          spanId: '2222222222222222',
          parentSpanId: '3333333333333333',
          sampled: true,
          kind: 'client',
          startTimeUnixNano: '1000000',
          endTimeUnixNano: '2000000',
          durationMs: 1,
          attributes: {
            'rpc.method': 'server.getSettings',
          },
          resourceAttributes: {
            'service.name': 't3-web',
          },
          scope: {
            name: 'effect',
            version: '4.0.0-beta.43',
            attributes: {},
          },
          events: [
            {
              name: 'http.request',
              timeUnixNano: '1500000',
              attributes: {
                'http.status_code': '200',
              },
            },
          ],
          links: [],
          status: {
            code: 'STATUS_CODE_OK',
          },
        },
      ])
      assert.deepEqual(upstreamRequests, [
        {
          body: jsonRequestBody(payload),
          contentType: 'application/json',
        },
      ])
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('responds to browser OTLP trace preflight requests with CORS headers', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest()

      const response = yield* HttpClient.options('/api/observability/v1/traces', {
        headers: {
          origin: 'http://localhost:5733',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      })

      assert.equal(response.status, 204)
      assert.equal(response.headers['access-control-allow-origin'], '*')
      assert.deepEqual(splitHeaderTokens(response.headers['access-control-allow-methods']), [
        'GET',
        'OPTIONS',
        'POST',
      ])
      assert.deepEqual(splitHeaderTokens(response.headers['access-control-allow-headers']), [
        'authorization',
        'b3',
        'content-type',
        'dpop',
        'traceparent',
      ])
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect(
    'stores browser OTLP trace exports locally when no upstream collector is configured',
    () =>
      Effect.gen(function* ()
      {
        const localTraceRecords: Array<unknown> = []
        const payload = yield* makeBrowserOtlpPayload('client.test')
        const resourceSpan = payload.resourceSpans[0]
        const scopeSpan = resourceSpan?.scopeSpans[0]
        const span = scopeSpan?.spans[0]

        assert.notEqual(resourceSpan, undefined)
        assert.notEqual(scopeSpan, undefined)
        assert.notEqual(span, undefined)
        if (!resourceSpan || !scopeSpan || !span)
        {
          return
        }

        yield* buildAppUnderTest({
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() =>
                {
                  localTraceRecords.push(...records)
                }),
            },
          },
        })

        const response = yield* HttpClient.post('/api/observability/v1/traces', {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            'content-type': 'application/json',
          },
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          body: HttpBody.text(JSON.stringify(payload), 'application/json'),
        })

        assert.equal(response.status, 204)
        assert.equal(localTraceRecords.length, 1)
        const record = localTraceRecords[0] as {
          readonly type: string
          readonly name: string
          readonly traceId: string
          readonly spanId: string
          readonly kind: string
          readonly attributes: Readonly<Record<string, unknown>>
          readonly events: ReadonlyArray<unknown>
          readonly links: ReadonlyArray<unknown>
          readonly scope: {
            readonly name?: string
            readonly attributes: Readonly<Record<string, unknown>>
          }
          readonly resourceAttributes: Readonly<Record<string, unknown>>
          readonly status?: {
            readonly code?: string
          }
        }

        assert.equal(record.type, 'otlp-span')
        assert.equal(record.name, span.name)
        assert.equal(record.traceId, span.traceId)
        assert.equal(record.spanId, span.spanId)
        assert.equal(record.kind, 'internal')
        assert.deepEqual(record.attributes, {})
        assert.deepEqual(record.events, [])
        assert.deepEqual(record.links, [])
        assert.equal(record.scope.name, scopeSpan.scope.name)
        assert.deepEqual(record.scope.attributes, {})
        assert.equal(record.resourceAttributes['service.name'], 't3-web')
        assert.equal(record.status?.code, String(span.status.code))
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc server.upsertKeybinding', () =>
    Effect.gen(function* ()
    {
      const rule: KeybindingRule = {
        command: 'terminal.toggle',
        key: 'ctrl+k',
      }
      const resolved: ResolvedKeybindingRule = {
        command: 'terminal.toggle',
        shortcut: {
          key: 'k',
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      }

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      )

      assert.deepEqual(response.issues, [])
      assert.deepEqual(response.keybindings, [resolved])
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('shares one preview automation broker across websocket sessions', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        yield* buildAppUnderTest()

        const wsUrl = yield* getWsServerUrl('/ws')
        const firstConnected = yield* Deferred.make<string>()
        const firstClosed = yield* Deferred.make<void>()
        const host = {
          clientId: 'shared-preview-host',
          environmentId: testEnvironmentDescriptor.environmentId,
        } as const

        yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(
            Stream.tap((event) =>
              event.type === 'connected'
                ? Deferred.succeed(firstConnected, event.connectionId)
                : Effect.void,
            ),
            Stream.runDrain,
            Effect.ensuring(Deferred.succeed(firstClosed, undefined)),
          ),
        ).pipe(Effect.forkScoped)

        const firstConnectionId = yield* Deferred.await(firstConnected)
        const replacementEvent = yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(Stream.runHead),
        ).pipe(Effect.map(Option.getOrThrow))
        const firstStreamClosed = yield* Deferred.await(firstClosed).pipe(
          Effect.timeoutOption('2 seconds'),
        )

        assert.equal(replacementEvent.type, 'connected')
        assert.notEqual(replacementEvent.connectionId, firstConnectionId)
        assert.isTrue(Option.isSome(firstStreamClosed))
      }),
    ).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('rejects websocket rpc handshake when session authentication is missing', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-ws-auth-required-' })
      yield* fs.writeFileString(
        path.join(workspaceDir, 'needle-file.ts'),
        'export const needle = 1;',
      )

      yield* buildAppUnderTest()

      const wsUrl = yield* getWsServerUrl('/ws', { authenticated: false })
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: 'needle',
            limit: 10,
          }),
        ).pipe(Effect.result),
      )

      assertTrue(result._tag === 'Failure')
      const failureMessage = String(result.failure)
      assertTrue(
        failureMessage.includes('SocketOpenError') || failureMessage.includes('SocketCloseError'),
      )
      assertTrue(
        failureMessage.includes('Unauthorized') ||
          failureMessage.includes('An error occurred during Open'),
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc subscribeServerConfig streams snapshot then update', () =>
    Effect.gen(function* ()
    {
      const providers = [
        {
          instanceId: ProviderInstanceId.make('codex'),
          driver: ProviderDriverKind.make('codex'),
          enabled: true,
          installed: true,
          version: '1.0.0',
          status: 'ready' as const,
          auth: { status: 'authenticated' as const },
          checkedAt: '2026-04-11T00:00:00.000Z',
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: 'http://localhost:4318/v1/traces',
          otlpMetricsUrl: 'http://localhost:4318/v1/metrics',
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      )

      const [first, second] = Array.from(events)
      assert.equal(first?.type, 'snapshot')
      if (first?.type === 'snapshot')
      {
        assert.equal(first.version, 1)
        assert.deepEqual(first.config.keybindings, [])
        assert.deepEqual(first.config.issues, [])
        assert.deepEqual(first.config.providers, providers)
        assert.equal(first.config.observability.logsDirectoryPath.endsWith('/logs'), true)
        assert.equal(first.config.observability.localTracingEnabled, true)
        assert.equal(first.config.observability.otlpTracesUrl, 'http://localhost:4318/v1/traces')
        assert.equal(first.config.observability.otlpTracesEnabled, true)
        assert.equal(first.config.observability.otlpMetricsUrl, 'http://localhost:4318/v1/metrics')
        assert.equal(first.config.observability.otlpMetricsEnabled, true)
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS)
      }
      assert.deepEqual(second, {
        version: 1,
        type: 'keybindingsUpdated',
        payload: { keybindings: [], issues: [] },
      })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('streams published themes only to opted-in config subscribers', () =>
    Effect.gen(function* ()
    {
      const themes = [
        {
          id: 'nightfall',
          name: 'Nightfall',
          appearance: 'dark' as const,
          canvas: '#123',
          accent: '#456',
        },
      ]
      yield* buildAppUnderTest({
        layers: {
          environmentTheme: { streamChanges: Stream.make(themes, []) },
        },
      })
      const wsUrl = yield* getWsServerUrl('/ws')
      const legacy = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runCollect),
        ),
      )
      assert.deepEqual(
        Array.from(legacy).map((event) => event.type),
        ['snapshot'],
      )
      const modern = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({ environmentThemes: true }).pipe(
            Stream.runCollect,
          ),
        ),
      )
      assert.equal(modern[0]?.type, 'snapshot')
      if (modern[0]?.type === 'snapshot') assert.notProperty(modern[0].config, 'environmentThemes')
      assert.deepEqual(Array.from(modern).slice(1), [
        { version: 1, type: 'environmentThemesUpdated', payload: { themes } },
        { version: 1, type: 'environmentThemesUpdated', payload: { themes: [] } },
      ])
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('catches a theme default changed after the config snapshot read', () =>
    Effect.gen(function* ()
    {
      const changed = {
        ...DEFAULT_SERVER_SETTINGS,
        defaultTheme: 'ocean',
        defaultThemeSetAt: '2026-08-30T00:00:00.001Z',
      }
      let snapshotRead = false
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.sync(() =>
            {
              snapshotRead = true
              return DEFAULT_SERVER_SETTINGS
            }),
            streamCurrentAndChanges: Stream.unwrap(
              Effect.sync(() =>
              {
                assert.isTrue(snapshotRead)
                return Stream.succeed(changed)
              }),
            ),
          },
        },
      })
      const wsUrl = yield* getWsServerUrl('/ws')
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runCollect),
        ),
      )
      assert.deepEqual(
        Array.from(events).map((event) => event.type),
        ['snapshot', 'settingsUpdated'],
      )
      assert.deepEqual(events[1], {
        version: 1,
        type: 'settingsUpdated',
        payload: { settings: changed },
      })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc subscribeServerConfig emits provider status updates', () =>
    Effect.gen(function* ()
    {
      const nextProviders = [
        {
          instanceId: ProviderInstanceId.make('codex'),
          driver: ProviderDriverKind.make('codex'),
          enabled: true,
          installed: true,
          version: '1.0.0',
          status: 'ready' as const,
          auth: { status: 'authenticated' as const },
          checkedAt: '2026-04-11T00:00:00.000Z',
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(nextProviders),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      )

      const [first, second] = Array.from(events)
      assert.equal(first?.type, 'snapshot')
      if (first?.type === 'snapshot')
      {
        assert.deepEqual(first.config.providers, [])
      }
      assert.deepEqual(second, {
        version: 1,
        type: 'providerStatuses',
        payload: { providers: nextProviders },
      })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect(
    'routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates',
    () =>
      Effect.gen(function* ()
      {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: 'welcome' as const,
            payload: {
              environment: testEnvironmentDescriptor,
              cwd: '/tmp/project',
              projectName: 'project',
            },
          },
        ] as const
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: 'ready' as const,
          payload: { at: '2026-01-01T00:00:00.000Z', environment: testEnvironmentDescriptor },
        })

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        })

        const wsUrl = yield* getWsServerUrl('/ws')
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        )

        const [first, second] = Array.from(events)
        assert.equal(first?.type, 'welcome')
        assert.equal(first?.sequence, 1)
        assert.equal(second?.type, 'ready')
        assert.equal(second?.sequence, 2)
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc projects.searchEntries', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-ws-project-search-' })
      yield* fs.writeFileString(
        path.join(workspaceDir, 'needle-file.ts'),
        'export const needle = 1;',
      )

      yield* buildAppUnderTest()

      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: 'needle',
            limit: 10,
          }),
        ),
      )

      assert.isAtLeast(response.entries.length, 1)
      assert.isTrue(response.entries.some((entry) => entry.path === 'needle-file.ts'))
      assert.equal(response.truncated, false)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect('routes websocket rpc projects.listEntries and projects.readFile', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-ws-project-files-' })
      yield* fs.makeDirectory(path.join(workspaceDir, 'src'), { recursive: true })
      yield* fs.writeFileString(
        path.join(workspaceDir, 'src', 'index.ts'),
        'export const answer = 42;\n',
      )

      yield* buildAppUnderTest()

      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            listing: client[WS_METHODS.projectsListEntries]({ cwd: workspaceDir }),
            file: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: 'src/index.ts',
            }),
          }),
        ),
      )

      assert.isTrue(response.listing.entries.some((entry) => entry.path === 'src/index.ts'))
      assert.deepEqual(response.file, {
        relativePath: 'src/index.ts',
        contents: 'export const answer = 42;\n',
        byteLength: 26,
        truncated: false,
      })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect('reads MDX only from the authenticated thread workspace context', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const projectRoot = yield* fs.makeTempDirectoryScoped({
        prefix: 't3-ws-project-mdx-root-',
      })
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({
        prefix: 't3-ws-project-mdx-worktree-',
      })
      yield* fs.writeFileString(path.join(projectRoot, 'overview.mdx'), '# Project root\n')
      yield* fs.writeFileString(path.join(worktreeRoot, 'overview.mdx'), '# Worktree root\n')

      const worktreeThreadId = ThreadId.make('thread-mdx-worktree')
      const projectThreadId = ThreadId.make('thread-mdx-project')
      const project: OrchestrationProjectShell = {
        id: defaultProjectId,
        title: 'MDX Project',
        workspaceRoot: projectRoot,
        defaultModelSelection,
        scripts: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
      const threads = [
        makeDefaultOrchestrationThreadShell({
          id: worktreeThreadId,
          worktreePath: worktreeRoot,
        }),
        makeDefaultOrchestrationThreadShell({
          id: projectThreadId,
          worktreePath: null,
        }),
      ]

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: (projectId) =>
              Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
            getThreadShellById: (threadId) =>
              Effect.succeed(
                Option.fromNullishOr(threads.find((thread) => thread.id === threadId)),
              ),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            worktree: client[WS_METHODS.projectsReadMdxDocument]({
              threadId: worktreeThreadId,
              relativePath: 'overview.mdx',
            }),
            project: client[WS_METHODS.projectsReadMdxDocument]({
              threadId: projectThreadId,
              relativePath: 'overview.mdx',
            }),
            missing: client[WS_METHODS.projectsReadMdxDocument]({
              threadId: ThreadId.make('thread-mdx-missing'),
              relativePath: 'overview.mdx',
            }).pipe(Effect.result),
          }),
        ),
      )

      assert.equal(response.worktree.source, '# Worktree root\n')
      assert.equal(response.project.source, '# Project root\n')
      assert.equal(response.worktree.transportVersion, 1)
      if (
        response.missing._tag !== 'Failure' ||
        response.missing.failure._tag !== 'ProjectReadMdxDocumentError'
      )
      {
        assert.fail('Expected a ProjectReadMdxDocumentError')
      }
      assert.equal(response.missing.failure.failure, 'workspace_context_not_found')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect('dispatches explicit architecture preparation only for live authorized owners', () =>
    Effect.gen(function* ()
    {
      const project: OrchestrationProjectShell = {
        id: defaultProjectId,
        title: 'Architecture lifecycle RPC',
        workspaceRoot: '/tmp/architecture-lifecycle-rpc',
        defaultModelSelection,
        scripts: [],
        createdAt: '2026-08-07T12:00:00.000Z',
        updatedAt: '2026-08-07T12:00:00.000Z',
      }
      const thread = makeDefaultOrchestrationThreadShell({
        id: defaultThreadId,
        projectId: defaultProjectId,
        worktreePath: '/tmp/architecture-lifecycle-rpc-worktree',
      })
      const generation = 'a'.repeat(64)
      const graphDigest = `sha256:${'b'.repeat(64)}` as const
      const ensures: string[] = []
      const rebuilds: string[] = []
      const preparations: string[] = []
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: (projectId) =>
              Effect.succeed(projectId === defaultProjectId ? Option.some(project) : Option.none()),
            getThreadShellById: (threadId) =>
              Effect.succeed(threadId === defaultThreadId ? Option.some(thread) : Option.none()),
          },
          projectArchitectureLifecycle: {
            ensureProject: (input) =>
              Effect.sync(() =>
              {
                ensures.push(`${input.projectId}:${input.workspaceRoot}`)
                return {
                  root: input.workspaceRoot,
                  outDir: '/tmp/architecture-lifecycle-rpc-output',
                  generation,
                  graphDigest,
                  builtAt: '2026-08-07T12:00:00.000Z',
                }
              }),
            rebuildProject: (input) =>
              Effect.sync(() =>
              {
                rebuilds.push(`${input.projectId}:${input.workspaceRoot}`)
                return {
                  root: input.workspaceRoot,
                  outDir: '/tmp/architecture-lifecycle-rpc-output',
                  generation,
                  graphDigest,
                  builtAt: '2026-08-07T12:00:00.000Z',
                }
              }),
          },
          currentWorktreeArchitecture: {
            prepare: (input) =>
              Effect.sync(() =>
              {
                preparations.push(`${input.threadId}:${input.workspaceRoot}`)
                return {
                  sourceKind: 'current-worktree' as const,
                  root: '/tmp/architecture-lifecycle-rpc-snapshot',
                  outDir: '/tmp/architecture-lifecycle-rpc-current-output',
                  graphPath: '/tmp/architecture-lifecycle-rpc-current-output/graph.json',
                  liveRoot: input.workspaceRoot,
                }
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const missingProjectId = ProjectId.make('project-architecture-rpc-missing')
      const missingThreadId = ThreadId.make('thread-architecture-rpc-missing')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* ()
          {
            const source = yield* client[WS_METHODS.cartographerEnsureProjectArchitecture]({
              projectId: defaultProjectId,
            })
            yield* client[WS_METHODS.cartographerPrepareCurrentWorktreeArchitecture]({
              threadId: defaultThreadId,
            })
            yield* client[WS_METHODS.cartographerRebuildProjectAtlas]({
              projectId: defaultProjectId,
            })
            const missing = yield* Effect.all({
              ensure: client[WS_METHODS.cartographerEnsureProjectArchitecture]({
                projectId: missingProjectId,
              }).pipe(Effect.flip),
              prepare: client[WS_METHODS.cartographerPrepareCurrentWorktreeArchitecture]({
                threadId: missingThreadId,
              }).pipe(Effect.flip),
              rebuild: client[WS_METHODS.cartographerRebuildProjectAtlas]({
                projectId: missingProjectId,
              }).pipe(Effect.flip),
            })
            return { source, missing }
          }),
        ),
      )

      assert.deepEqual(result.source, {
        kind: 'standing-project-generation',
        projectId: defaultProjectId,
        generationId: generation,
        side: 'analyzed',
        graphDigest,
      })
      assert.deepEqual(ensures, [`${defaultProjectId}:${project.workspaceRoot}`])
      assert.deepEqual(rebuilds, [`${defaultProjectId}:${project.workspaceRoot}`])
      assert.deepEqual(preparations, [`${defaultThreadId}:${thread.worktreePath}`])
      for (const missing of Object.values(result.missing))
      {
        assert.equal(missing._tag, 'CartographerError')
        if (missing._tag === 'CartographerError')
        {
          assert.equal(missing.failure, 'workspace_context_not_found')
        }
      }

      const { body: readToken } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: 'orchestration:read',
      })
      const readTicketResponse = yield* HttpClient.post('/api/auth/websocket-ticket', {
        headers: { authorization: `Bearer ${readToken.access_token ?? ''}` },
      })
      const readTicket = (yield* readTicketResponse.json) as { readonly ticket: string }
      const readWsUrl = `${yield* getWsServerUrl('/ws', {
        authenticated: false,
      })}?wsTicket=${encodeURIComponent(readTicket.ticket)}`
      const denied = yield* Effect.scoped(
        withWsRpcClient(readWsUrl, (client) =>
          client[WS_METHODS.cartographerPrepareCurrentWorktreeArchitecture]({
            threadId: defaultThreadId,
          }).pipe(Effect.flip),
        ),
      )
      assert.equal(denied._tag, 'EnvironmentAuthorizationError')
      if (denied._tag === 'EnvironmentAuthorizationError')
      {
        assert.equal(denied.requiredScope, 'orchestration:operate')
      }
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes native architecture projections through read-scoped authority', () =>
    Effect.gen(function* ()
    {
      const generationId = ProposalGenerationId.make('proposal-generation-projection-rpc')
      const standingGeneration = '6'.repeat(64)
      const standingDigest = `sha256:${'7'.repeat(64)}` as const
      const proposalDigest = `sha256:${'8'.repeat(64)}` as const
      const source = {
        kind: 'standing-project-generation' as const,
        projectId: defaultProjectId,
        generationId: standingGeneration,
        side: 'analyzed' as const,
        graphDigest: standingDigest,
      }
      const proposalSource = {
        kind: 'proposal-generation' as const,
        threadId: defaultThreadId,
        generationId,
        side: 'proposed' as const,
        graphDigest: proposalDigest,
      }
      const calls: Array<{
        readonly kind: string
        readonly authority: ArchitectureQueryService.ArchitectureQueryAuthority
      }> = []
      const emptyCount = { total: 0, returned: 0, omitted: 0 }
      const projectionBase = {
        projectionVersion: 1 as const,
        projectionRevision: 1,
        kind: 'repository-map' as const,
        authority: 'standing' as const,
        resultState: 'graph' as const,
        freshness: 'fresh' as const,
        generatedAt: '2026-08-09T00:00:00.000Z',
        source,
        repository: { name: '456code', scope: '.', gitRef: 'HEAD' },
        layoutVersion: 'repository-map-v2',
        totals: {
          nodes: emptyCount,
          edges: emptyCount,
          evidence: emptyCount,
          changedFiles: emptyCount,
        },
        nodes: [],
        edges: [],
        evidence: [],
        anchors: [],
      }
      yield* buildAppUnderTest({
        layers: {
          architectureProjectionService: {
            repositoryMap: (authority, input) =>
              Effect.sync(() =>
              {
                calls.push({ kind: 'map', authority })
                return {
                  ...projectionBase,
                  projectionId: 'repository-map-root',
                  lens: input.lens,
                  semanticLevel:
                    input.lens === 'architecture' ? ('systems' as const) : ('dirs' as const),
                  breadcrumbs: [],
                }
              }),
            architectureScope: (authority, input) =>
              Effect.sync(() =>
              {
                calls.push({ kind: 'scope', authority })
                return {
                  ...projectionBase,
                  projectionId: 'repository-map-scope',
                  lens: input.lens,
                  semanticLevel: 'blocks' as const,
                  breadcrumbs: [{ id: input.scope.id, label: 'Runtime', level: input.scope.level }],
                }
              }),
            architectureSource: (authority, input) =>
              Effect.sync(() =>
              {
                calls.push({ kind: 'source', authority })
                return {
                  version: 1 as const,
                  source: input.source,
                  relativePath: input.relativePath,
                  sourceDigest: `sha256:${'9'.repeat(64)}` as const,
                  content: 'export const value = 1\n',
                }
              }),
          },
        },
      })

      const { body: readToken } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: 'orchestration:read',
      })
      const readTicketResponse = yield* HttpClient.post('/api/auth/websocket-ticket', {
        headers: { authorization: `Bearer ${readToken.access_token ?? ''}` },
      })
      const readTicket = (yield* readTicketResponse.json) as { readonly ticket: string }
      const readWsUrl = `${yield* getWsServerUrl('/ws', {
        authenticated: false,
      })}?wsTicket=${encodeURIComponent(readTicket.ticket)}`
      const results = yield* Effect.scoped(
        withWsRpcClient(readWsUrl, (client) =>
          Effect.gen(function* ()
          {
            const map = yield* client[WS_METHODS.cartographerGetRepositoryMap]({
              threadId: defaultThreadId,
              projectId: defaultProjectId,
              lens: 'architecture',
            })
            const scope = yield* client[WS_METHODS.cartographerGetArchitectureScope]({
              threadId: defaultThreadId,
              source,
              lens: 'architecture',
              scope: { level: 'systems', id: 'systems:runtime' },
            })
            const immutableSource = yield* client[WS_METHODS.cartographerGetArchitectureSource]({
              threadId: defaultThreadId,
              source: proposalSource,
              relativePath: 'src/value.ts',
            })
            return { map, scope, immutableSource }
          }),
        ),
      )

      if (results.map.source.kind !== 'standing-project-generation')
      {
        return yield* Effect.die('expected the standing Repository Map source')
      }
      assert.equal(results.map.source.generationId, standingGeneration)
      assert.equal(results.map.projectionId, 'repository-map-root')
      assert.equal(results.scope.breadcrumbs[0]?.id, 'systems:runtime')
      assert.equal(results.immutableSource.content, 'export const value = 1\n')
      assert.deepEqual(
        calls.map((call) => call.kind),
        ['map', 'scope', 'source'],
      )
      assert.equal(
        calls.every(
          (call) =>
            call.authority.environmentId === testEnvironmentDescriptor.environmentId &&
            call.authority.threadId === defaultThreadId,
        ),
        true,
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes diff-analysis RPCs with target reads, owner masking, and scoped access', () =>
    Effect.gen(function* ()
    {
      const project: OrchestrationProjectShell = {
        id: defaultProjectId,
        title: 'Diff analysis RPC',
        workspaceRoot: '/tmp/diff-analysis-rpc',
        defaultModelSelection,
        scripts: [],
        createdAt: '2026-08-07T12:00:00.000Z',
        updatedAt: '2026-08-07T12:00:00.000Z',
      }
      const thread = makeDefaultOrchestrationThreadShell({
        id: defaultThreadId,
        projectId: defaultProjectId,
        worktreePath: '/tmp/diff-analysis-rpc-worktree',
        orchestrateRunExecution: {
          threadId: defaultThreadId,
          runId: OrchestratePlanRunId.make('run-diff-analysis-rpc'),
          planRevision: 1,
          sourceTurnId: TurnId.make('turn-diff-analysis-rpc'),
          sourceSequence: 10,
          repositoryRoot: '/tmp/diff-analysis-rpc-retained',
          repositoryCommonDir: '/tmp/diff-analysis-rpc-retained/.git',
          baseOid: 'a'.repeat(40),
          lifecycle: 'completed',
          availability: 'unavailable',
          integrationRoot: '/tmp/diff-analysis-rpc-pruned',
          integrationCommonDir: '/tmp/diff-analysis-rpc-retained/.git',
          integrationBranch: 'run/exact',
          integrationOid: 'b'.repeat(40),
          observedHeadOid: 'b'.repeat(40),
          finalHeadOid: 'b'.repeat(40),
          closeReason: 'completed fixture',
          current: true,
          admittedAt: '2026-08-07T11:59:00.000Z',
          updatedAt: '2026-08-07T12:00:00.000Z',
          terminalAt: '2026-08-07T12:00:00.000Z',
          jobs: [],
        },
      })
      const diffAnalysisId = DiffAnalysisId.make('diff-analysis-rpc')
      const generation = {
        version: 1 as const,
        diffAnalysisId,
        sourceKind: 'checkpoint' as const,
        state: 'ready' as const,
        baseTreeOid: 'a'.repeat(40),
        headTreeOid: 'b'.repeat(40),
        analyzerVersion: 'cartographer-rpc-test',
        analysisPolicyVersion: 'diff-analysis-v1',
        sourceCurrent: true,
        baseGraphArtifact: 'base-graph-ref',
        headGraphArtifact: 'head-graph-ref',
        impactArtifact: 'impact-ref',
        impactProjectionArtifact: 'impact-projection-ref',
        artifactByteLength: 1024,
        errorCode: null,
        createdAt: '2026-08-07T12:00:00.000Z',
        updatedAt: '2026-08-07T12:00:01.000Z',
        lastAccessedAt: '2026-08-07T12:00:02.000Z',
      }
      const serviceCalls: string[] = []
      const missingProjectId = ProjectId.make('project-diff-analysis-missing')
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: (projectId) =>
              Effect.succeed(projectId === defaultProjectId ? Option.some(project) : Option.none()),
            getThreadShellById: (threadId) =>
              Effect.succeed(threadId === defaultThreadId ? Option.some(thread) : Option.none()),
          },
          diffAnalysisService: {
            request: (input) =>
              Effect.sync(() =>
              {
                const sourceKind = input.source.sourceKind === 'checkpoint' ? 'checkpoint' : 'other'
                serviceCalls.push(['request', sourceKind, input.workspaceRoot].join(':'))
                return generation
              }),
            get: (input) =>
              Effect.sync(() =>
              {
                const sourceKind = input.source.sourceKind === 'review' ? 'review' : 'other'
                serviceCalls.push(
                  [
                    'get',
                    sourceKind,
                    input.diffAnalysisId ?? 'target-only',
                    input.workspaceRoot,
                  ].join(':'),
                )
                return generation
              }),
          },
        },
      })

      const checkpointSource = {
        sourceKind: 'checkpoint' as const,
        threadId: defaultThreadId,
        fromTurnCount: 0,
        toTurnCount: 1,
      }
      const reviewSource = {
        sourceKind: 'review' as const,
        cwd: project.workspaceRoot,
        kind: 'working-tree' as const,
      }
      const exactRunSource = {
        sourceKind: 'commit-pair' as const,
        cwd: '/tmp/diff-analysis-rpc-retained',
        baseCommitOid: 'a'.repeat(40),
        headCommitOid: 'b'.repeat(40),
      }
      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(
          wsUrl,
          (client) =>
            Effect.all({
              requested: client[WS_METHODS.cartographerRequestDiffAnalysis]({
                owner: { threadId: defaultThreadId },
                source: checkpointSource,
              }),
              readByTarget: client[WS_METHODS.cartographerGetDiffAnalysis]({
                owner: { projectId: defaultProjectId },
                source: reviewSource,
                diffAnalysisId,
              }),
              exactRunRead: client[WS_METHODS.cartographerGetDiffAnalysis]({
                owner: { threadId: defaultThreadId },
                source: exactRunSource,
              }),
              masked: client[WS_METHODS.cartographerGetDiffAnalysis]({
                owner: { projectId: defaultProjectId },
                source: checkpointSource,
              }).pipe(Effect.flip),
              missingRequest: client[WS_METHODS.cartographerRequestDiffAnalysis]({
                owner: { projectId: missingProjectId },
                source: reviewSource,
              }).pipe(Effect.flip),
              missingGet: client[WS_METHODS.cartographerGetDiffAnalysis]({
                owner: { projectId: missingProjectId },
                source: reviewSource,
              }).pipe(Effect.flip),
            }),
          'http://127.0.0.1:4173',
        ),
      )

      assert.equal(response.requested.diffAnalysisId, diffAnalysisId)
      assert.equal(response.readByTarget.diffAnalysisId, diffAnalysisId)
      assert.equal(response.exactRunRead.diffAnalysisId, diffAnalysisId)
      assert.equal(response.masked._tag, 'CartographerError')
      if (response.masked._tag === 'CartographerError')
      {
        assert.equal(response.masked.failure, 'diff_analysis_not_found')
      }
      for (const missing of [response.missingRequest, response.missingGet])
      {
        assert.equal(missing._tag, 'CartographerError')
        if (missing._tag === 'CartographerError')
        {
          assert.equal(missing.failure, 'diff_analysis_not_found')
          assert.equal(missing.message, 'A ready diff analysis was not found for this owner.')
        }
      }
      assert.deepEqual(serviceCalls.toSorted(), [
        'get:other:target-only:/tmp/diff-analysis-rpc-retained',
        `get:review:${diffAnalysisId}:${project.workspaceRoot}`,
        `request:checkpoint:${thread.worktreePath ?? project.workspaceRoot}`,
      ])

      const { body: readToken } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: 'orchestration:read',
      })
      const readTicketResponse = yield* HttpClient.post('/api/auth/websocket-ticket', {
        headers: { authorization: `Bearer ${readToken.access_token ?? ''}` },
      })
      const readTicket = (yield* readTicketResponse.json) as { readonly ticket: string }
      const readWsUrl = `${yield* getWsServerUrl('/ws', {
        authenticated: false,
      })}?wsTicket=${encodeURIComponent(readTicket.ticket)}`
      const scoped = yield* Effect.scoped(
        withWsRpcClient(
          readWsUrl,
          (client) =>
            Effect.all({
              read: client[WS_METHODS.cartographerGetDiffAnalysis]({
                owner: { projectId: defaultProjectId },
                source: reviewSource,
              }),
              requestDenied: client[WS_METHODS.cartographerRequestDiffAnalysis]({
                owner: { projectId: defaultProjectId },
                source: reviewSource,
              }).pipe(Effect.flip),
            }),
          'http://127.0.0.1:4173',
        ),
      )
      assert.equal(scoped.read.diffAnalysisId, diffAnalysisId)
      assert.equal(scoped.requestDenied._tag, 'EnvironmentAuthorizationError')
      if (scoped.requestDenied._tag === 'EnvironmentAuthorizationError')
      {
        assert.equal(scoped.requestDenied.requiredScope, 'orchestration:operate')
      }
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('serves scoped proposal state and exact orchestrate links', () =>
    Effect.gen(function* ()
    {
      const proposalId = ProposalId.make('proposal-rpc')
      const revisionId = ProposalRevisionId.make('revision-rpc')
      const source = '{globalThis.__proposalNarrativeExecuted = true}'
      const timestamp = '2026-07-27T12:00:00.000Z'
      const proposal = {
        proposalId,
        environmentId: testEnvironmentDescriptor.environmentId,
        projectId: defaultProjectId,
        sourceThreadId: defaultThreadId,
        producer: {
          providerSessionId: 'provider-session-rpc',
          providerInstanceId: ProviderInstanceId.make('codex'),
        },
        repository: {
          _tag: 'local-git' as const,
          canonicalKey: 'local:/tmp/default-project',
        },
        worktree: {
          rootPath: '/tmp/default-project',
          gitDir: '/tmp/default-project/.git',
          gitCommonDir: '/tmp/default-project/.git',
        },
        latestRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const revision = {
        proposalId,
        revisionId,
        revision: 1,
        baseSnapshot: {
          headCommitOid: 'a'.repeat(40),
          workingTreeOid: 'b'.repeat(40),
          retainedRef: 'refs/t3/proposals/proposal-rpc/revisions/1/base',
          fileCount: 1,
          byteCount: 1,
          policy: PROPOSAL_SNAPSHOT_POLICY_V1,
        },
        proposedTreeOid: 'c'.repeat(40),
        proposedRetainedRef: 'refs/t3/proposals/proposal-rpc/revisions/1/proposed',
        manifest: {
          version: 'v1' as const,
          operations: [
            {
              _tag: 'add' as const,
              path: 'src/proposed.ts',
              after: {
                sha256: 'd'.repeat(64),
                byteLength: 1,
                gitBlobOid: 'e'.repeat(40),
                mode: '100644' as const,
              },
            },
          ],
          operationCount: 1,
          changedFileCount: 1,
          changedContentBytes: 1,
        },
        manifestSha256: 'f'.repeat(64),
        diffSha256: '1'.repeat(64),
        diffByteLength: 1,
        narrativeSha256: '2'.repeat(64),
        narrativeByteLength: Buffer.byteLength(source, 'utf8'),
        planId: 'plan-rpc',
        createdAt: timestamp,
      }
      const attempt = {
        attemptId: ImplementationAttemptId.make('attempt-rpc'),
        proposalId,
        revisionId,
        revision: 1,
        sourceThreadId: defaultThreadId,
        implementationThreadId: defaultThreadId,
        implementationTurnId: TurnId.make('turn-rpc'),
        planId: 'plan-rpc',
        baselineTreeOid: 'b'.repeat(40),
        actualTreeOid: 'c'.repeat(40),
        outcome: 'matched' as const,
        matchedOperationCount: 1,
        intendedOperationCount: 1,
        createdAt: timestamp,
        completedAt: timestamp,
      }
      const project: OrchestrationProjectShell = {
        id: defaultProjectId,
        title: 'Default Project',
        workspaceRoot: '/tmp/default-project',
        defaultModelSelection,
        scripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const thread = makeDefaultOrchestrationThreadShell()
      const orchestratePlan = {
        runId: 'run-proposal-rpc',
        revision: 6,
        turnId: TurnId.make('turn-proposal-rpc'),
        workflow: 'implementation',
        task: 'Serve the exact linked proposal.',
        stages: [],
        totalWorkers: 0,
        maxWorkers: 1,
        source: 'tool' as const,
        leadModelSelection: null,
        status: 'superseded' as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const mismatchedOrchestratePlan = {
        ...orchestratePlan,
        runId: 'run-proposal-rpc-mismatched-link',
        revision: 7,
      }
      const threadDetail = {
        ...makeDefaultOrchestrationReadModel().threads[0]!,
        orchestratePlans: [orchestratePlan, mismatchedOrchestratePlan],
      }
      const exactLookupInputs: Array<{
        readonly sourceThreadId: ThreadId
        readonly runId: string
        readonly revision: number
      }> = []
      Reflect.set(globalThis, '__proposalNarrativeExecuted', false)

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: (requestedProjectId) =>
              Effect.succeed(
                requestedProjectId === defaultProjectId ? Option.some(project) : Option.none(),
              ),
            getThreadShellById: (requestedThreadId) =>
              Effect.succeed(
                requestedThreadId === defaultThreadId ? Option.some(thread) : Option.none(),
              ),
            getThreadDetailById: (requestedThreadId) =>
              Effect.succeed(
                requestedThreadId === defaultThreadId ? Option.some(threadDetail) : Option.none(),
              ),
          },
          proposalService: {
            get: () => Effect.succeed({ proposal, revision, revisions: [revision] }),
            narrative: () =>
              Effect.succeed({
                proposalId,
                revisionId,
                revision: 1,
                source,
                sourceSha256: '2'.repeat(64),
              }),
            findLatestByPlan: () => Effect.succeed({ proposal, revision }),
            findByOrchestrateRevision: (input) =>
              Effect.sync(() =>
              {
                exactLookupInputs.push(input)
                const selectedPlan =
                  input.runId === mismatchedOrchestratePlan.runId
                    ? mismatchedOrchestratePlan
                    : orchestratePlan
                return {
                  link: {
                    proposalId:
                      input.runId === mismatchedOrchestratePlan.runId
                        ? ProposalId.make('proposal-rpc-other')
                        : proposalId,
                    proposalRevision: revision.revision,
                    sourceThreadId: defaultThreadId,
                    runId: selectedPlan.runId,
                    revision: selectedPlan.revision,
                    createdAt: timestamp,
                  },
                  proposal,
                  revision,
                  orchestratePlan: selectedPlan,
                }
              }),
          },
          proposalImplementationAttemptService: {
            latestForProposal: () => Effect.succeed(attempt),
          },
        },
      })

      const { body: readToken } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: 'orchestration:read',
      })
      const readTicketResponse = yield* HttpClient.post('/api/auth/websocket-ticket', {
        headers: { authorization: `Bearer ${readToken.access_token ?? ''}` },
      })
      const readTicket = (yield* readTicketResponse.json) as { readonly ticket: string }
      const wsUrl = `${yield* getWsServerUrl('/ws', {
        authenticated: false,
      })}?wsTicket=${encodeURIComponent(readTicket.ticket)}`
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            narrative: client[WS_METHODS.proposalsNarrative]({ proposalId, revision: 1 }),
            linked: client[WS_METHODS.proposalsFindByPlan]({
              sourceThreadId: defaultThreadId,
              planId: 'plan-rpc',
            }),
            orchestrateLinked: client[WS_METHODS.proposalsFindByOrchestrateRevision]({
              sourceThreadId: defaultThreadId,
              runId: orchestratePlan.runId,
              revision: orchestratePlan.revision,
            }),
            missingOrchestrateLink: client[WS_METHODS.proposalsFindByOrchestrateRevision]({
              sourceThreadId: defaultThreadId,
              runId: orchestratePlan.runId,
              revision: orchestratePlan.revision + 1,
            }),
            mismatchedOrchestrateLink: client[WS_METHODS.proposalsFindByOrchestrateRevision]({
              sourceThreadId: defaultThreadId,
              runId: mismatchedOrchestratePlan.runId,
              revision: mismatchedOrchestratePlan.revision,
            }).pipe(Effect.flip),
            attempt: client[WS_METHODS.proposalsLatestImplementationAttempt]({
              sourceThreadId: defaultThreadId,
              proposalId,
              revision: 1,
            }),
          }),
        ),
      )

      assert.equal(Reflect.get(globalThis, '__proposalNarrativeExecuted'), false)
      assert.equal(response.narrative?.document.source, source)
      assertTrue(
        response.narrative?.document.document.diagnostics.some(
          (diagnostic) => diagnostic.severity === 'error',
        ) === true,
      )
      assert.equal(response.linked?.revision.revisionId, revisionId)
      assert.equal(response.orchestrateLinked?.revision.revisionId, revisionId)
      assert.equal(response.orchestrateLinked?.orchestratePlan.revision, 6)
      assert.equal(response.missingOrchestrateLink, null)
      assert.equal(response.mismatchedOrchestrateLink._tag, 'ProposalError')
      if (response.mismatchedOrchestrateLink._tag === 'ProposalError')
      {
        assert.equal(response.mismatchedOrchestrateLink.code, 'identity-mismatch')
      }
      assert.deepEqual(exactLookupInputs, [
        {
          sourceThreadId: defaultThreadId,
          runId: orchestratePlan.runId,
          revision: orchestratePlan.revision,
        },
        {
          sourceThreadId: defaultThreadId,
          runId: mismatchedOrchestratePlan.runId,
          revision: mismatchedOrchestratePlan.revision,
        },
      ])
      assert.equal(response.attempt?.outcome, 'matched')
      Reflect.deleteProperty(globalThis, '__proposalNarrativeExecuted')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect('routes websocket rpc projects.searchEntries excludes gitignored files', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: 't3-ws-project-search-gitignored-',
      })
      yield* fs.writeFileString(path.join(workspaceDir, '.gitignore'), '.venv/\n')
      yield* fs.makeDirectory(path.join(workspaceDir, '.venv', 'lib'), { recursive: true })
      yield* fs.writeFileString(
        path.join(workspaceDir, '.venv', 'lib', 'ignored-search-target.ts'),
        'export const ignored = true;',
      )
      yield* fs.makeDirectory(path.join(workspaceDir, 'src'), { recursive: true })
      yield* fs.writeFileString(
        path.join(workspaceDir, 'src', 'tracked.ts'),
        'export const ok = 1;',
      )

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
            listWorkspaceFiles: () =>
              Effect.succeed({
                paths: ['src/tracked.ts'],
                truncated: false,
                freshness: {
                  source: 'live-local',
                  observedAt: TEST_EPOCH,
                  expiresAt: Option.none(),
                },
              }),
            filterIgnoredPaths: (_cwd, relativePaths) =>
              Effect.succeed(
                relativePaths.filter((relativePath) => !relativePath.startsWith('.venv/')),
              ),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: 'ignored-search-target',
            limit: 10,
          }),
        ),
      )

      assert.equal(response.entries.length, 0)
      assert.equal(response.truncated, false)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect('preserves structured workspace rpc failures', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: 't3-ws-workspace-errors-',
      })
      const outsideDir = yield* fs.makeTempDirectoryScoped({
        prefix: 't3-ws-workspace-errors-outside-',
      })
      const outsideFile = path.join(outsideDir, 'outside.txt')
      yield* fs.writeFileString(outsideFile, 'outside\n')
      yield* fs.symlink(outsideFile, path.join(workspaceDir, 'linked-outside.txt'))
      const resolvedOutsideFile = yield* fs.realPath(outsideFile)

      yield* buildAppUnderTest()

      const invalidWorkspace = path.join(workspaceDir, 'missing-workspace')
      const missingBrowseParent = path.join(workspaceDir, 'missing-browse')
      const sensitiveQuery = 'authorization: Bearer secret-token'
      const wsUrl = yield* getWsServerUrl('/ws')
      const results = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            search: client[WS_METHODS.projectsSearchEntries]({
              cwd: invalidWorkspace,
              query: sensitiveQuery,
              limit: 10,
            }).pipe(Effect.result),
            list: client[WS_METHODS.projectsListEntries]({ cwd: invalidWorkspace }).pipe(
              Effect.result,
            ),
            read: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: 'linked-outside.txt',
            }).pipe(Effect.result),
            browse: client[WS_METHODS.filesystemBrowse]({
              cwd: workspaceDir,
              partialPath: './missing-browse/child',
            }).pipe(Effect.result),
          }),
        ),
      )

      if (
        results.search._tag !== 'Failure' ||
        results.search.failure._tag !== 'ProjectSearchEntriesError'
      )
      {
        assert.fail('Expected a ProjectSearchEntriesError')
      }
      const searchError = results.search.failure
      assert.equal(
        searchError.message,
        `Failed to search workspace entries in '${invalidWorkspace}'.`,
      )
      assert.equal(searchError.cwd, invalidWorkspace)
      assert.equal(searchError.queryLength, sensitiveQuery.length)
      assert.notProperty(searchError, 'query')
      assert.notInclude(searchError.message, 'Bearer')
      assert.notInclude(searchError.message, 'secret-token')
      assert.equal(searchError.limit, 10)
      assert.equal(searchError.failure, 'workspace_root_not_found')
      assert.equal(searchError.normalizedCwd, invalidWorkspace)
      assert.isDefined(searchError.cause)

      if (
        results.list._tag !== 'Failure' ||
        results.list.failure._tag !== 'ProjectListEntriesError'
      )
      {
        assert.fail('Expected a ProjectListEntriesError')
      }
      const listError = results.list.failure
      assert.equal(listError.message, `Failed to list workspace entries in '${invalidWorkspace}'.`)
      assert.equal(listError.cwd, invalidWorkspace)
      assert.equal(listError.failure, 'workspace_root_not_found')
      assert.equal(listError.normalizedCwd, invalidWorkspace)
      assert.isDefined(listError.cause)

      if (results.read._tag !== 'Failure' || results.read.failure._tag !== 'ProjectReadFileError')
      {
        assert.fail('Expected a ProjectReadFileError')
      }
      const readError = results.read.failure
      assert.equal(
        readError.message,
        `Failed to read workspace file 'linked-outside.txt' in '${workspaceDir}'.`,
      )
      assert.equal(readError.cwd, workspaceDir)
      assert.equal(readError.relativePath, 'linked-outside.txt')
      assert.equal(readError.failure, 'resolved_path_outside_root')
      assert.equal(readError.resolvedPath, resolvedOutsideFile)
      assert.isDefined(readError.cause)

      if (
        results.browse._tag !== 'Failure' ||
        results.browse.failure._tag !== 'FilesystemBrowseError'
      )
      {
        assert.fail('Expected a FilesystemBrowseError')
      }
      const browseError = results.browse.failure
      assert.equal(
        browseError.message,
        `Failed to browse filesystem path './missing-browse/child' from '${workspaceDir}'.`,
      )
      assert.equal(browseError.cwd, workspaceDir)
      assert.equal(browseError.partialPath, './missing-browse/child')
      assert.equal(browseError.failure, 'read_directory_failed')
      assert.equal(browseError.parentPath, missingBrowseParent)
      assert.isDefined(browseError.cause)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('reports workspace root stat failures without relabeling them as missing', () =>
    Effect.gen(function* ()
    {
      if ((yield* HostProcessPlatform) === 'win32') return

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const blockedRoot = yield* fs.makeTempDirectoryScoped({
        prefix: 't3-ws-workspace-stat-error-',
      })
      const workspaceRoot = path.join(blockedRoot, 'workspace')
      yield* fs.makeDirectory(workspaceRoot)
      yield* fs.chmod(blockedRoot, 0o000)

      const result = yield* Effect.gen(function* ()
      {
        yield* buildAppUnderTest()
        const wsUrl = yield* getWsServerUrl('/ws')
        return yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsListEntries]({ cwd: workspaceRoot }).pipe(Effect.result),
          ),
        )
      }).pipe(Effect.ensuring(fs.chmod(blockedRoot, 0o700).pipe(Effect.ignore)))

      if (result._tag !== 'Failure' || result.failure._tag !== 'ProjectListEntriesError')
      {
        assert.fail('Expected a ProjectListEntriesError')
      }
      const error = result.failure
      assert.equal(error.failure, 'workspace_root_stat_failed')
      assert.equal(error.normalizedCwd, workspaceRoot)
      assert.equal(error.detail, 'validate-existing')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc projects.writeFile', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-ws-project-write-' })

      yield* buildAppUnderTest()

      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: 'nested/created.txt',
            contents: 'written-by-rpc',
          }),
        ),
      )

      assert.equal(response.relativePath, 'nested/created.txt')
      const persisted = yield* fs.readFileString(path.join(workspaceDir, 'nested', 'created.txt'))
      assert.equal(persisted, 'written-by-rpc')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('creates a missing workspace root during websocket project.create dispatch', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-ws-project-create-' })
      const missingWorkspaceRoot = path.join(parentDir, 'nested', 'new-project')

      yield* buildAppUnderTest()

      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'project.create',
            commandId: CommandId.make('cmd-project-create-missing-root'),
            projectId: ProjectId.make('project-create-missing-root'),
            title: 'New Project',
            workspaceRoot: missingWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make('codex'),
              model: 'gpt-5-codex',
            },
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
        ),
      )
      const stat = yield* fs.stat(missingWorkspaceRoot)

      assert.isAtLeast(response.sequence, 0)
      assert.equal(stat.type, 'Directory')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('rejects imported continuation consent when the target source identity changed', () =>
    Effect.gen(function* ()
    {
      const providerInstanceId = ProviderInstanceId.make('shared-provider')
      const dispatch = vi.fn((_: OrchestrationCommand) => Effect.succeed({ sequence: 1 }))

      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([
              {
                instanceId: providerInstanceId,
                driver: ProviderDriverKind.make('codex'),
                continuation: { groupKey: 'codex:home:/provider-home-b' },
                enabled: true,
                installed: true,
                version: '1.0.0',
                status: 'ready',
                auth: { status: 'authenticated' },
                checkedAt: '2026-01-01T00:00:00.000Z',
                availability: 'available',
                models: [],
                slashCommands: [],
                skills: [],
              },
            ]),
          },
          orchestrationEngine: {
            dispatch,
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.turn.start',
            commandId: CommandId.make('cmd-import-continuation-driver-mismatch'),
            threadId: ThreadId.make('thread-imported-driver-mismatch'),
            message: {
              messageId: MessageId.make('message-imported-driver-mismatch'),
              role: 'user',
              text: 'continue imported work',
              attachments: [],
            },
            modelSelection: {
              instanceId: providerInstanceId,
              model: 'claude-sonnet-4-5',
            },
            runtimeMode: 'approval-required',
            interactionMode: 'default',
            importContinuationConsent: {
              originContentHash: 'imported-content-hash',
              activityId: EventId.make('activity-import-continuation'),
              driverKind: ProviderDriverKind.make('codex'),
              targetProviderInstanceId: providerInstanceId,
              continuation: {
                state: 'history-only',
                providerInstanceId,
                continuationIdentity: {
                  driverKind: ProviderDriverKind.make('codex'),
                  continuationKey: `codex:instance:${providerInstanceId}`,
                },
                reason: 'Native continuation could not be verified.',
              },
            },
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
        ).pipe(Effect.result),
      )

      assertTrue(result._tag === 'Failure')
      assertTrue(result.failure._tag === 'OrchestrationDispatchCommandError')
      assert.include(
        result.failure.message,
        'no longer resolves to the accepted continuation source',
      )
      assert.equal(dispatch.mock.calls.length, 0)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc projects.writeFile errors', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: 't3-ws-project-write-' })

      yield* buildAppUnderTest()

      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: '../escape.txt',
            contents: 'nope',
          }),
        ).pipe(Effect.result),
      )

      if (result._tag !== 'Failure' || result.failure._tag !== 'ProjectWriteFileError')
      {
        assert.fail('Expected a ProjectWriteFileError')
      }
      const writeError = result.failure
      assert.equal(
        writeError.message,
        `Failed to write workspace file '../escape.txt' in '${workspaceDir}'.`,
      )
      assert.equal(writeError.cwd, workspaceDir)
      assert.equal(writeError.relativePath, '../escape.txt')
      assert.equal(writeError.failure, 'workspace_path_outside_root')
      assert.isDefined(writeError.cause)
      assert.notProperty(writeError, 'contents')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc shell.openInEditor errors', () =>
    Effect.gen(function* ()
    {
      let openedInput: { cwd: string; editor: EditorId } | null = null
      const externalLauncherError = new ExternalLauncherCommandNotFoundError({
        editor: 'cursor',
        command: 'cursor',
      })
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: (input) =>
            {
              openedInput = input
              return Effect.fail(externalLauncherError)
            },
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: '/tmp/project',
            editor: 'cursor',
          }),
        ).pipe(Effect.result),
      )

      assert.deepEqual(openedInput, { cwd: '/tmp/project', editor: 'cursor' })
      assertFailure(result, externalLauncherError)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc git methods', () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const worktreePath = yield* fs.makeTempDirectoryScoped({ prefix: 't3-ws-rpc-worktree-' })
      const demoPr = {
        number: 1,
        title: 'Demo PR',
        url: 'https://example.com/pr/1',
        baseBranch: 'main',
        headBranch: 'feature/demo',
        state: 'open' as const,
      }
      const cleanStatus = {
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: true,
        refName: 'main',
        hasWorkingTreeChanges: false,
        workingTree: { files: [] as const, insertions: 0, deletions: 0 },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }
      const stackedCommitResult = {
        action: 'commit' as const,
        branch: { status: 'skipped_not_requested' as const },
        commit: {
          status: 'created' as const,
          commitSha: 'abc123',
          subject: 'feat: demo',
        },
        push: { status: 'skipped_not_requested' as const },
        pr: { status: 'skipped_not_requested' as const },
        toast: {
          title: 'Committed abc123',
          description: 'feat: demo',
          cta: {
            kind: 'run_action' as const,
            label: 'Push',
            action: { kind: 'push' as const },
          },
        },
      }

      yield* buildAppUnderTest({
        config: {
          cwd: '/tmp/repo',
        },
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () => Effect.succeed(cleanStatus),
            remoteStatus: () =>
              Effect.succeed({
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            status: () => Effect.succeed(cleanStatus),
            runStackedAction: (input, options) =>
              Effect.gen(function* ()
              {
                yield* options?.progressReporter?.publish({
                  actionId: options.actionId ?? input.actionId,
                  cwd: input.cwd,
                  action: input.action,
                  kind: 'phase_started',
                  phase: 'commit',
                  label: 'Committing...',
                }) ?? Effect.void
                yield* options?.progressReporter?.publish({
                  actionId: options.actionId ?? input.actionId,
                  cwd: input.cwd,
                  action: input.action,
                  kind: 'action_finished',
                  result: stackedCommitResult,
                }) ?? Effect.void
                return stackedCommitResult
              }),
            resolvePullRequest: () => Effect.succeed({ pullRequest: demoPr }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: demoPr,
                branch: 'feature/demo',
                worktreePath: null,
              }),
          },
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: 'pulled',
                refName: 'main',
                upstreamRef: 'origin/main',
              }),
            listRefs: () =>
              Effect.succeed({
                refs: [
                  {
                    name: 'main',
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: worktreePath, refName: 'feature/demo' },
              }),
            removeWorktree: () => Effect.void,
            createRef: (input) => Effect.succeed({ refName: input.refName }),
            switchRef: (input) => Effect.succeed({ refName: input.refName }),
          },
          vcsStatusBroadcaster: {
            refreshStatus: () => Effect.succeed(cleanStatus),
          },
          reviewService: {
            getDiffPreview: (input) =>
              Effect.succeed({
                cwd: input.cwd,
                generatedAt: DateTime.nowUnsafe(),
                sources: [
                  {
                    id: 'working-tree',
                    kind: 'working-tree',
                    title: 'Dirty worktree',
                    baseRef: 'HEAD',
                    headRef: null,
                    diff: 'dirty-diff',
                    diffHash: 'hash-dirty',
                    truncated: false,
                  },
                  {
                    id: 'branch-range',
                    kind: 'branch-range',
                    title: 'Against main',
                    baseRef: 'main',
                    headRef: 'feature/demo',
                    diff: 'base-diff',
                    diffHash: 'hash-base',
                    truncated: false,
                  },
                ],
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: '/tmp/repo' })),
      )
      assert.equal(pull.status, 'pulled')

      const refreshedStatus = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRefreshStatus]({ cwd: '/tmp/repo' }),
        ),
      )
      assert.equal(refreshedStatus.isRepo, true)

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: 'action-1',
            cwd: '/tmp/repo',
            action: 'commit',
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      )
      const lastStackedEvent = stackedEvents.at(-1)
      assert.equal(lastStackedEvent?.kind, 'action_finished')
      if (lastStackedEvent?.kind === 'action_finished')
      {
        assert.equal(lastStackedEvent.result.action, 'commit')
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: '/tmp/repo',
            reference: '1',
          }),
        ),
      )
      assert.equal(resolvedPr.pullRequest.number, 1)

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: '/tmp/repo',
            reference: '1',
            mode: 'local',
          }),
        ),
      )
      assert.equal(prepared.branch, 'feature/demo')

      const refs = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsListRefs]({ cwd: '/tmp/repo' })),
      )
      assert.equal(refs.refs[0]?.name, 'main')

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateWorktree]({
            cwd: '/tmp/repo',
            refName: 'main',
            path: null,
          }),
        ),
      )
      assert.equal(worktree.worktree.refName, 'feature/demo')

      // removeWorktree canonicalizes via realPath before the mocked driver runs
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRemoveWorktree]({
            cwd: '/tmp/repo',
            path: worktreePath,
          }),
        ),
      )

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateRef]({
            cwd: '/tmp/repo',
            refName: 'feature/new',
          }),
        ),
      )

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsSwitchRef]({
            cwd: '/tmp/repo',
            refName: 'main',
          }),
        ),
      )

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsInit]({
            cwd: '/tmp/repo',
          }),
        ),
      )

      const diffPreview = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.reviewGetDiffPreview]({ cwd: '/tmp/repo' }),
        ),
      )
      assert.equal(diffPreview.sources[0]?.diff, 'dirty-diff')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc git.pull errors', () =>
    Effect.gen(function* ()
    {
      const gitError = new GitCommandError({
        operation: 'pull',
        command: 'git pull --ff-only',
        cwd: '/tmp/repo',
        detail: 'upstream missing',
      })
      let invalidationCalls = 0
      let statusCalls = 0
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() =>
              {
                invalidationCalls += 1
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() =>
              {
                invalidationCalls += 1
              }),
            invalidateStatus: () =>
              Effect.sync(() =>
              {
                invalidationCalls += 1
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: 'main',
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() =>
              {
                statusCalls += 1
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }
              }),
            status: () =>
              Effect.sync(() =>
              {
                statusCalls += 1
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: 'main',
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: '/tmp/repo' })).pipe(
          Effect.result,
        ),
      )

      assertFailure(result, gitError)
      assert.equal(invalidationCalls, 0)
      assert.equal(statusCalls, 0)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc git.runStackedAction errors after refreshing git status', () =>
    Effect.gen(function* ()
    {
      const gitError = new GitCommandError({
        operation: 'commit',
        command: 'git commit',
        cwd: '/tmp/repo',
        detail: 'nothing to commit',
      })
      let invalidationCalls = 0
      let statusCalls = 0
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() =>
              {
                invalidationCalls += 1
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() =>
              {
                invalidationCalls += 1
              }),
            invalidateStatus: () =>
              Effect.sync(() =>
              {
                invalidationCalls += 1
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: 'feature/demo',
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() =>
              {
                statusCalls += 1
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }
              }),
            status: () =>
              Effect.sync(() =>
              {
                statusCalls += 1
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: 'feature/demo',
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }
              }),
            runStackedAction: () => Effect.fail(gitError),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: 'action-1',
            cwd: '/tmp/repo',
            action: 'commit',
          }).pipe(Stream.runCollect, Effect.result),
        ),
      )

      assertFailure(result, gitError)
      assert.equal(invalidationCalls, 0)
      assert.equal(statusCalls, 0)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('completes websocket rpc git.pull before background git status refresh finishes', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: 'pulled' as const,
                refName: 'main',
                upstreamRef: 'origin/main',
              }),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: 'main',
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sleep(Duration.seconds(2)).pipe(
                Effect.as({
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              ),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const startedAt = yield* Clock.currentTimeMillis
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: '/tmp/repo' })),
      )
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt

      assert.equal(result.status, 'pulled')
      assertTrue(elapsedMs < 1_000)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect(
    'completes websocket rpc git.runStackedAction before background git status refresh finishes',
    () =>
      Effect.gen(function* ()
      {
        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: 'feature/demo',
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: 'commit' as const,
                  branch: { status: 'skipped_not_requested' as const },
                  commit: {
                    status: 'created' as const,
                    commitSha: 'abc123',
                    subject: 'feat: demo',
                  },
                  push: { status: 'skipped_not_requested' as const },
                  pr: { status: 'skipped_not_requested' as const },
                  toast: {
                    title: 'Committed abc123',
                    description: 'feat: demo',
                    cta: {
                      kind: 'run_action' as const,
                      label: 'Push',
                      action: {
                        kind: 'push' as const,
                      },
                    },
                  },
                }),
            },
          },
        })

        const wsUrl = yield* getWsServerUrl('/ws')
        const startedAt = yield* Clock.currentTimeMillis
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: 'action-1',
              cwd: '/tmp/repo',
              action: 'commit',
            }).pipe(Stream.runCollect),
          ),
        )
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt

        assertTrue(elapsedMs < 1_000)
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect(
    'starts a background local git status refresh after a successful git.runStackedAction',
    () =>
      Effect.gen(function* ()
      {
        const localRefreshStarted = yield* Deferred.make<void>()

        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Deferred.succeed(localRefreshStarted, undefined).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.succeed({
                      isRepo: true,
                      hasPrimaryRemote: true,
                      isDefaultRef: false,
                      refName: 'feature/demo',
                      hasWorkingTreeChanges: false,
                      workingTree: { files: [], insertions: 0, deletions: 0 },
                    }),
                  ),
                ),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: 'commit' as const,
                  branch: { status: 'skipped_not_requested' as const },
                  commit: {
                    status: 'created' as const,
                    commitSha: 'abc123',
                    subject: 'feat: demo',
                  },
                  push: { status: 'skipped_not_requested' as const },
                  pr: { status: 'skipped_not_requested' as const },
                  toast: {
                    title: 'Committed abc123',
                    description: 'feat: demo',
                    cta: {
                      kind: 'run_action' as const,
                      label: 'Push',
                      action: {
                        kind: 'push' as const,
                      },
                    },
                  },
                }),
            },
          },
        })

        const wsUrl = yield* getWsServerUrl('/ws')
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: 'action-1',
              cwd: '/tmp/repo',
              action: 'commit',
            }).pipe(Stream.runCollect),
          ),
        )

        yield* Deferred.await(localRefreshStarted)
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc orchestration methods', () =>
    Effect.gen(function* ()
    {
      const now = '2026-01-01T00:00:00.000Z'
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.make('project-a'),
            title: 'Project A',
            workspaceRoot: '/tmp/project-a',
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.make('thread-1'),
            projectId: ProjectId.make('project-a'),
            title: 'Thread A',
            modelSelection: defaultModelSelection,
            interactionMode: 'default' as const,
            runtimeMode: 'full-access' as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            origin: null,
            settledOverride: null,
            settledAt: null,
            latestTurn: null,
            providerSwitch: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            orchestratePlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      }

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make('thread-1'),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: 'turn-diff',
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make('thread-1'),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: 'full-diff',
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.session.stop',
            commandId: CommandId.make('cmd-1'),
            threadId: ThreadId.make('thread-1'),
            createdAt: now,
          }),
        ),
      )
      assert.equal(dispatchResult.sequence, 7)

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.make('thread-1'),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      )
      assert.equal(turnDiffResult.diff, 'turn-diff')

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.make('thread-1'),
            toTurnCount: 1,
          }),
        ),
      )
      assert.equal(fullDiffResult.diff, 'full-diff')
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc orchestration shell snapshot errors', () =>
    Effect.gen(function* ()
    {
      const projectionError = new PersistenceSqlError({
        operation: 'ProjectionSnapshotQuery.getShellSnapshot:test',
        detail: 'failed to read projection shell snapshot',
      })
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getShellSnapshot: () => Effect.fail(projectionError),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(Stream.runCollect),
        ).pipe(Effect.result),
      )

      assertTrue(result._tag === 'Failure')
      assertTrue(result.failure._tag === 'OrchestrationGetSnapshotError')
      assertTrue(result.failure.cause instanceof Error)
      assert.include(result.failure.cause.message, projectionError.message)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect(
    'imports missing-workspace history through the authenticated websocket handler using the configured server cwd',
    () =>
      Effect.gen(function* ()
      {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const testRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: 't3-ws-import-handler-',
        })
        const codexHome = path.join(testRoot, 'codex-home')
        const sessionDirectory = path.join(codexHome, 'sessions', '2026', '01', '01')
        const historicalWorkspaceRoot = path.join(testRoot, 'missing-workspace')
        const nativeSessionId = 'ws-import-native'
        const sourcePath = path.join(
          sessionDirectory,
          `rollout-2026-01-01T00-00-00-${nativeSessionId}.jsonl`,
        )
        yield* fileSystem.makeDirectory(sessionDirectory, { recursive: true })
        yield* fileSystem.writeFileString(
          sourcePath,
          [
            `{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"${nativeSessionId}","cwd":"${historicalWorkspaceRoot}","model_provider":"openai"}}`,
            `{"timestamp":"2026-01-01T00:00:00.000Z","type":"turn_context","payload":{"cwd":"${historicalWorkspaceRoot}","model":"gpt-test"}}`,
            '{"timestamp":"2026-01-01T00:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"Import over WebSocket"}}',
          ].join('\n'),
        )

        const providerInstanceId = ProviderInstanceId.make('codex')
        const projects: OrchestrationProjectShell[] = []
        const threads: OrchestrationThreadShell[] = []
        const events: OrchestrationEvent[] = []
        const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>()
        let importFinalizedCheckCount = 0
        let sequence = 0
        const shellSnapshot = () => ({
          snapshotSequence: sequence,
          projects: [...projects],
          threads: [...threads],
          updatedAt: '2026-01-01T00:00:10.000Z',
        })
        const importReconciliationContext = () => ({
          projects: projects.map((project) => ({
            projectId: project.id,
            workspaceRoot: project.workspaceRoot,
          })),
          threads: threads.flatMap((thread) =>
            thread.origin === null
              ? []
              : [
                  {
                    threadId: thread.id,
                    projectId: thread.projectId,
                    modelSelection: thread.modelSelection,
                    origin: thread.origin,
                    archived: thread.archivedAt !== null,
                  },
                ],
          ),
        })
        const dispatch = (command: OrchestrationCommand) =>
          Effect.gen(function* ()
          {
            sequence += 1
            if (command.type === 'project.create')
            {
              projects.push({
                id: command.projectId,
                title: command.title,
                workspaceRoot: command.workspaceRoot,
                defaultModelSelection: command.defaultModelSelection ?? null,
                scripts: [],
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              })
            }
            else if (command.type === 'thread.create')
            {
              const thread: OrchestrationThreadShell = {
                id: command.threadId,
                projectId: command.projectId,
                title: command.title,
                modelSelection: command.modelSelection,
                runtimeMode: command.runtimeMode,
                interactionMode: command.interactionMode,
                branch: command.branch,
                worktreePath: command.worktreePath,
                latestTurn: null,
                providerSwitch: null,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
                archivedAt: null,
                origin: command.origin ?? null,
                settledOverride: null,
                settledAt: null,
                session: null,
                latestUserMessageAt: null,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                hasActionableProposedPlan: false,
              }
              threads.push(thread)
              const event: OrchestrationEvent = {
                sequence,
                eventId: EventId.make(`event-ws-import-${sequence}`),
                aggregateKind: 'thread',
                aggregateId: command.threadId,
                type: 'thread.created',
                occurredAt: command.createdAt,
                commandId: command.commandId,
                causationEventId: null,
                correlationId: command.commandId,
                metadata: {},
                payload: {
                  threadId: command.threadId,
                  projectId: command.projectId,
                  title: command.title,
                  modelSelection: command.modelSelection,
                  runtimeMode: command.runtimeMode,
                  interactionMode: command.interactionMode,
                  branch: command.branch,
                  worktreePath: command.worktreePath,
                  origin: command.origin ?? null,
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                },
              }
              events.push(event)
              yield* PubSub.publish(domainEvents, event)
            }
            return { sequence }
          })
        const settings = {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              enabled: true,
              homePath: 'codex-home',
            },
          },
        }

        const config = yield* buildAppUnderTest({
          config: { cwd: testRoot },
          layers: {
            serverSettings: {
              getSettings: Effect.succeed(settings),
            },
            providerRegistry: {
              getProviders: Effect.succeed([
                {
                  instanceId: providerInstanceId,
                  driver: ProviderDriverKind.make('codex'),
                  enabled: true,
                  installed: true,
                  version: '1.0.0',
                  status: 'ready',
                  auth: { status: 'authenticated' },
                  checkedAt: '2026-01-01T00:00:00.000Z',
                  availability: 'available',
                  models: [
                    {
                      slug: 'gpt-test',
                      name: 'GPT Test',
                      isCustom: false,
                      isDefault: true,
                      capabilities: null,
                    },
                  ],
                  slashCommands: [],
                  skills: [],
                },
              ]),
            },
            orchestrationEngine: {
              dispatch,
              readEvents: (afterSequenceExclusive = 0) =>
                Stream.fromIterable(
                  events.filter((event) => event.sequence > afterSequenceExclusive),
                ),
              streamDomainEvents: Stream.fromPubSub(domainEvents),
              latestSequence: Effect.sync(() => sequence),
            },
            projectionSnapshotQuery: {
              getSnapshot: () => Effect.die('full snapshot must not be used by session import'),
              getShellSnapshot: () => Effect.sync(shellSnapshot),
              getArchivedShellSnapshot: () =>
                Effect.sync(() => ({
                  snapshotSequence: sequence,
                  projects: [],
                  threads: [],
                  updatedAt: '2026-01-01T00:00:10.000Z',
                })),
              getImportReconciliationContext: () => Effect.sync(importReconciliationContext),
              getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
                Effect.sync(() =>
                  Option.fromNullishOr(
                    projects.find((project) => project.workspaceRoot === workspaceRoot),
                  ).pipe(Option.map((project) => ({ ...project, deletedAt: null }))),
                ),
              getProjectShellById: (projectId) =>
                Effect.sync(() =>
                  Option.fromNullishOr(projects.find((project) => project.id === projectId)),
                ),
              getThreadShellById: (threadId) =>
                Effect.sync(() =>
                  Option.fromNullishOr(threads.find((thread) => thread.id === threadId)),
                ),
              isThreadImportFinalized: () =>
                Effect.sync(() =>
                {
                  importFinalizedCheckCount += 1
                  return true
                }),
            },
          },
        })
        const holdingWorkspaceRoot = path.join(config.stateDir, 'imported-history')

        const { response: readExchangeResponse, body: readToken } = yield* exchangeAccessToken(
          defaultDesktopBootstrapToken,
          { scope: 'orchestration:read' },
        )
        assert.equal(readExchangeResponse.status, 200)
        const readTicketResponse = yield* HttpClient.post('/api/auth/websocket-ticket', {
          headers: {
            authorization: `Bearer ${readToken.access_token ?? ''}`,
          },
        })
        const readTicket = (yield* readTicketResponse.json) as { readonly ticket: string }
        const readWsUrl = `${yield* getWsServerUrl('/ws', {
          authenticated: false,
        })}?wsTicket=${encodeURIComponent(readTicket.ticket)}`
        const readAccess = yield* Effect.scoped(
          withWsRpcClient(readWsUrl, (client) =>
            Effect.gen(function* ()
            {
              const snapshot = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
                Stream.runHead,
              )
              const scan = yield* client[ORCHESTRATION_WS_METHODS.importScan]({})
              const deniedImport = yield* client[ORCHESTRATION_WS_METHODS.importSessions]({
                items: [
                  {
                    source: 'codex-cli',
                    sourcePath,
                    providerInstanceId,
                  },
                ],
              }).pipe(Effect.flip)
              return { snapshot, scan, deniedImport }
            }),
          ),
        )
        assert.equal(Option.getOrThrow(readAccess.snapshot).kind, 'snapshot')
        assert.ok(
          readAccess.scan.candidates.some(
            (candidate) => candidate.nativeSessionId === nativeSessionId,
          ),
        )
        assert.equal(readAccess.deniedImport._tag, 'EnvironmentAuthorizationError')
        if (readAccess.deniedImport._tag === 'EnvironmentAuthorizationError')
        {
          assert.equal(readAccess.deniedImport.requiredScope, 'orchestration:operate')
        }

        const operateWsUrl = yield* getWsServerUrl('/ws')
        const imported = yield* Effect.scoped(
          withWsRpcClient(operateWsUrl, (client) =>
            Effect.gen(function* ()
            {
              const shellUpdateFiber = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell](
                {},
              ).pipe(
                Stream.filter((item) => item.kind === 'thread-upserted'),
                Stream.runHead,
                Effect.forkScoped,
              )
              yield* Effect.sleep(Duration.millis(20)).pipe(TestClock.withLive)
              const result = yield* client[ORCHESTRATION_WS_METHODS.importSessions]({
                items: [
                  {
                    source: 'codex-cli',
                    sourcePath,
                    providerInstanceId,
                  },
                ],
              })
              assert.deepEqual(result.failed, [])
              assert.equal(result.imported.length, 1)
              assert.deepEqual(result.imported[0]?.continuation, {
                state: 'history-only',
                providerInstanceId,
                continuationIdentity: null,
                reason: 'the original workspace is unavailable',
              })
              yield* TestClock.adjust(Duration.millis(50))
              const shellUpdate = Option.getOrThrow(yield* Fiber.join(shellUpdateFiber))
              return { result, shellUpdate }
            }),
          ),
        )

        assert.equal(imported.shellUpdate.kind, 'thread-upserted')
        if (imported.shellUpdate.kind === 'thread-upserted')
        {
          assert.equal(imported.shellUpdate.thread.origin?.providerInstanceId, providerInstanceId)
          assert.equal(
            imported.shellUpdate.thread.origin?.originalWorkspaceRoot,
            historicalWorkspaceRoot,
          )
        }
        assert.equal(projects.length, 1)
        assert.equal(projects[0]?.title, 'Imported history')
        assert.equal(projects[0]?.workspaceRoot, holdingWorkspaceRoot)
        assert.isTrue(yield* fileSystem.exists(holdingWorkspaceRoot))
        assert.isFalse(yield* fileSystem.exists(historicalWorkspaceRoot))

        yield* fileSystem.remove(holdingWorkspaceRoot, { recursive: true, force: true })
        const retryWithMissingHoldingRoot = yield* Effect.scoped(
          withWsRpcClient(operateWsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.importSessions]({
              items: [
                {
                  source: 'codex-cli',
                  sourcePath,
                  providerInstanceId,
                },
              ],
            }),
          ),
        )
        assert.equal(retryWithMissingHoldingRoot.imported.length, 0)
        assert.equal(retryWithMissingHoldingRoot.failed.length, 1)
        assert.include(retryWithMissingHoldingRoot.failed[0]?.message ?? '', holdingWorkspaceRoot)
        assert.isFalse(yield* fileSystem.exists(holdingWorkspaceRoot))
        assert.isFalse(yield* fileSystem.exists(historicalWorkspaceRoot))
        yield* fileSystem.makeDirectory(holdingWorkspaceRoot, { recursive: true })

        yield* fileSystem.writeFileString(
          sourcePath,
          [
            `{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"${nativeSessionId}","cwd":"${historicalWorkspaceRoot}","model_provider":"openai"}}`,
            `{"timestamp":"2026-01-01T00:00:00.000Z","type":"turn_context","payload":{"cwd":"${historicalWorkspaceRoot}","model":"gpt-test"}}`,
            '{"timestamp":"2026-01-01T00:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"Import over WebSocket"}}',
            '{"timestamp":"2026-01-01T00:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"New source activity"}}',
          ].join('\n'),
        )
        const changedSourceResult = yield* Effect.scoped(
          withWsRpcClient(operateWsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.importSessions]({
              items: [
                {
                  source: 'codex-cli',
                  sourcePath,
                  providerInstanceId,
                },
              ],
            }),
          ),
        )
        assert.deepEqual(changedSourceResult.failed, [])
        assert.equal(changedSourceResult.skipped.length, 1)
        assert.include(
          changedSourceResult.skipped[0]?.reason ?? '',
          'original session has new activity',
        )
        assert.equal(importFinalizedCheckCount, 1)

        const scan = yield* Effect.scoped(
          withWsRpcClient(operateWsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.importScan]({}),
          ),
        )
        const importedCandidate = scan.candidates.find(
          (candidate) => candidate.nativeSessionId === nativeSessionId,
        )
        assert.equal(importedCandidate?.alreadyImportedThreadId, threads[0]?.id)
        assert.equal(importedCandidate?.alreadyImportedProviderInstanceId, providerInstanceId)
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('marks an empty shell catch-up replay as synchronized when requested', () =>
    Effect.gen(function* ()
    {
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEvents: () => Stream.empty,
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const firstItem = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.runHead),
        ),
      )

      assert.deepEqual(Option.getOrThrow(firstItem), { kind: 'synchronized' })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('marks a socket thread snapshot as synchronized when requested', () =>
    Effect.gen(function* ()
    {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 1, thread })),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      )

      assert.equal(items[0]?.kind, 'snapshot')
      assert.deepEqual(items[1], { kind: 'synchronized' })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('buffers shell events published while the fallback snapshot loads', () =>
    Effect.gen(function* ()
    {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>()
      const deletedEvent = {
        sequence: 2,
        eventId: EventId.make('event-shell-thread-deleted'),
        aggregateKind: 'thread',
        aggregateId: defaultThreadId,
        occurredAt: '2026-01-01T00:00:01.000Z',
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: 'thread.deleted',
        payload: {
          threadId: defaultThreadId,
          deletedAt: '2026-01-01T00:00:01.000Z',
        },
      } satisfies Extract<OrchestrationEvent, { type: 'thread.deleted' }>

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.gen(function* ()
              {
                yield* PubSub.publish(liveEvents, deletedEvent)
                return {
                  snapshotSequence: 1,
                  projects: [],
                  threads: [makeDefaultOrchestrationThreadShell()],
                  updatedAt: '2026-01-01T00:00:00.000Z',
                }
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      ).pipe(Effect.timeout('2 seconds'))

      assert.equal(items[0]?.kind, 'snapshot')
      assert.equal(items[1]?.kind, 'thread-removed')
      assert.deepEqual(items[2], { kind: 'synchronized' })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect('buffers orchestrate plan upserts published while the initial snapshot loads', () =>
    Effect.gen(function* ()
    {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>()
      const planEvent = {
        sequence: 2,
        eventId: EventId.make('event-orchestrate-plan'),
        aggregateKind: 'thread',
        aggregateId: defaultThreadId,
        occurredAt: '2026-01-01T00:00:01.000Z',
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: 'thread.orchestrate-plan-upserted',
        payload: {
          threadId: defaultThreadId,
          plan: {
            runId: 'run-snapshot-race',
            revision: 1,
            turnId: TurnId.make('turn-snapshot-race'),
            workflow: 'snapshot race',
            task: 'Deliver the live plan revision.',
            stages: [
              {
                id: 'stage-1',
                provider: 'codex',
                model: null,
                mode: 'edit',
                workers: 1,
              },
            ],
            totalWorkers: 1,
            maxWorkers: 1,
            source: 'tool',
            leadModelSelection: null,
            status: 'pending',
            createdAt: '2026-01-01T00:00:01.000Z',
            updatedAt: '2026-01-01T00:00:01.000Z',
          },
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      } satisfies Extract<OrchestrationEvent, { type: 'thread.orchestrate-plan-upserted' }>

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* ()
              {
                yield* PubSub.publish(liveEvents, planEvent)
                return Option.some({ snapshotSequence: 1, thread })
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      ).pipe(Effect.timeout('2 seconds'))

      assert.equal(items[0]?.kind, 'snapshot')
      assert.equal(items[1]?.kind, 'event')
      assert.equal(items[1]?.kind === 'event' ? items[1].event.sequence : null, 2)
      assert.equal(
        items[1]?.kind === 'event' ? items[1].event.type : null,
        'thread.orchestrate-plan-upserted',
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect('replays an orchestrate plan response before the synchronization marker', () =>
    Effect.gen(function* ()
    {
      const readEventsCalls: Array<readonly [number, number | undefined]> = []
      const responseEvent = {
        sequence: 2,
        eventId: EventId.make('event-orchestrate-plan-response'),
        aggregateKind: 'thread',
        aggregateId: defaultThreadId,
        occurredAt: '2026-01-01T00:00:02.000Z',
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: 'thread.orchestrate-plan-response-requested',
        payload: {
          threadId: defaultThreadId,
          runId: 'run-bounded-replay',
          revision: 1,
          decision: 'approve',
          createdAt: '2026-01-01T00:00:02.000Z',
        },
      } satisfies Extract<
        OrchestrationEvent,
        { type: 'thread.orchestrate-plan-response-requested' }
      >

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            readEvents: (afterSequence, limit) =>
              Stream.sync(() =>
              {
                readEventsCalls.push([afterSequence, limit])
                return responseEvent
              }),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () => Effect.die('snapshot should not load during replay'),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 1,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      )

      assert.deepEqual(readEventsCalls, [[1, 1]])
      assert.deepEqual(
        Array.from(items, (item) => item.kind),
        ['event', 'synchronized'],
      )
      assert.equal(items[0]?.kind === 'event' ? items[0].event.type : null, responseEvent.type)
      assert.isFalse(Array.from(items).some((item) => item.kind === 'snapshot'))
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('subscribeShell sends a fresh snapshot instead of replaying a large gap', () =>
    Effect.gen(function* ()
    {
      let readEventsCalls = 0
      const snapshotThreadId = ThreadId.make('thread-from-snapshot')
      const now = '2026-01-01T00:00:00.000Z'

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            // head is far ahead of the client's afterSequence (gap > 1000).
            latestSequence: Effect.succeed(100_000),
            readEvents: () =>
              Stream.sync(() =>
              {
                readEventsCalls += 1
                return {
                  sequence: 1,
                  eventId: EventId.make('event-should-not-be-read'),
                  aggregateKind: 'thread',
                  aggregateId: snapshotThreadId,
                  occurredAt: now,
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  type: 'thread.created',
                  payload: {} as never,
                } satisfies OrchestrationEvent
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 100_000,
                projects: [],
                threads: [makeDefaultOrchestrationThreadShell({ id: snapshotThreadId })],
                updatedAt: now,
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      )

      const [first, second] = Array.from(items)
      // large gap => fresh snapshot, and the unbounded replay is never started.
      assert.equal(first?.kind, 'snapshot')
      if (first?.kind === 'snapshot')
      {
        assert.equal(first.snapshot.threads[0]?.id, snapshotThreadId)
      }
      assert.equal(second?.kind, 'synchronized')
      assert.equal(readEventsCalls, 0)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('subscribeShell replaces a cursor ahead of the authoritative head', () =>
    Effect.gen(function* ()
    {
      let readEventsCalls = 0

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            readEvents: () =>
              Stream.sync(() =>
              {
                readEventsCalls += 1
                return {} as OrchestrationEvent
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 5,
                projects: [],
                threads: [],
                updatedAt: '2026-01-01T00:00:00.000Z',
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 10 }).pipe(
            Stream.runHead,
          ),
        ),
      )

      assert.equal(Option.getOrThrow(first).kind, 'snapshot')
      assert.equal(readEventsCalls, 0)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('subscribeThread sends a fresh snapshot instead of replaying a large gap', () =>
    Effect.gen(function* ()
    {
      let readEventsCalls = 0
      const thread = makeDefaultOrchestrationReadModel().threads[0]!

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(100_000),
            readEvents: () =>
              Stream.sync(() =>
              {
                readEventsCalls += 1
                return {} as OrchestrationEvent
              }),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 100_000, thread })),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      )

      assert.equal(items[0]?.kind, 'snapshot')
      assert.deepEqual(items[1], { kind: 'synchronized' })
      assert.equal(readEventsCalls, 0)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('subscribeShell coalesces a per-thread burst without stalling other threads', () =>
    Effect.gen(function* ()
    {
      const busyThreadId = ThreadId.make('thread-busy')
      const newThreadId = ThreadId.make('thread-new')
      const now = '2026-01-01T00:00:00.000Z'
      const shellFetches: Array<string> = []
      let replayLimit: number | undefined

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: 'thread',
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: 'thread.message-sent',
          payload: {} as never,
        }) satisfies OrchestrationEvent

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make('event-created'),
        aggregateKind: 'thread',
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: 'thread.created',
        payload: {} as never,
      }

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(50),
            // a burst of message-sent deltas for the busy thread, plus one
            // thread.created for a different thread, all within one batch.
            readEvents: (_afterSequence, limit) =>
            {
              replayLimit = limit
              return Stream.fromIterable([
                ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
                createdEvent,
              ])
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() =>
              {
                shellFetches.push(threadId)
                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }))
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      )

      const collected = Array.from(items)
      const upsertedIds = collected.flatMap((item) =>
        item.kind === 'thread-upserted' ? [item.thread.id] : [],
      )
      // both threads surface, and the busy thread's 20-event burst collapses to
      // a single shell refetch (not 20). The new thread is not stuck behind it.
      assert.include(upsertedIds, busyThreadId)
      assert.include(upsertedIds, newThreadId)
      assert.equal(collected[2]?.kind, 'synchronized')
      assert.equal(shellFetches.filter((id) => id === busyThreadId).length, 1)
      assert.equal(replayLimit, 50)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('subscribeShell coalesces live bursts after the synchronization marker', () =>
    Effect.gen(function* ()
    {
      const busyThreadId = ThreadId.make('thread-live-busy')
      const newThreadId = ThreadId.make('thread-live-new')
      const now = '2026-01-01T00:00:00.000Z'
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>()
      const synchronized = yield* Deferred.make<void>()
      const shellFetches: Array<string> = []
      const observedLiveThreadIds = new Set<string>()

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-live-${sequence}`),
          aggregateKind: 'thread',
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: 'thread.message-sent',
          payload: {} as never,
        }) satisfies OrchestrationEvent

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make('event-live-created'),
        aggregateKind: 'thread',
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: 'thread.created',
        payload: {} as never,
      }

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() =>
              {
                shellFetches.push(threadId)
                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }))
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        Effect.gen(function* ()
        {
          const itemsFiber = yield* withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              requestCompletionMarker: true,
            }).pipe(
              Stream.tap((item) =>
                item.kind === 'synchronized'
                  ? Deferred.succeed(synchronized, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Stream.takeUntil((item) =>
              {
                if (item.kind === 'thread-upserted')
                {
                  observedLiveThreadIds.add(item.thread.id)
                }
                return (
                  observedLiveThreadIds.has(busyThreadId) && observedLiveThreadIds.has(newThreadId)
                )
              }),
              Stream.runCollect,
            ),
          ).pipe(Effect.forkScoped)

          yield* Deferred.await(synchronized)
          for (const event of [
            ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
            createdEvent,
          ])
          {
            yield* PubSub.publish(liveEvents, event)
          }

          return yield* Fiber.join(itemsFiber)
        }),
      ).pipe(Effect.timeout('2 seconds'))

      assert.equal(items[0]?.kind, 'snapshot')
      assert.equal(items[1]?.kind, 'synchronized')
      const liveUpsertedIds = Array.from(items)
        .slice(2)
        .flatMap((item) => (item.kind === 'thread-upserted' ? [item.thread.id] : []))
      assert.include(liveUpsertedIds, busyThreadId)
      assert.include(liveUpsertedIds, newThreadId)
      assert.isBelow(shellFetches.filter((id) => id === busyThreadId).length, 20)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer), TestClock.withLive),
  )

  it.effect('subscribeShell coalescing still emits a removal for a deleted thread', () =>
    Effect.gen(function* ()
    {
      const goneThreadId = ThreadId.make('thread-gone')
      const now = '2026-01-01T00:00:00.000Z'

      const makeThreadEvent = (
        sequence: number,
        type: 'thread.deleted' | 'thread.message-sent',
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: 'thread',
          aggregateId: goneThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload: type === 'thread.deleted' ? { threadId: goneThreadId, deletedAt: now } : {},
        }) as OrchestrationEvent

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            // a thread.deleted followed, within the same coalescing window, by a
            // later refetchable event for the same thread. The later event wins
            // coalescing; its shell refetch returns none (the row is gone), which
            // must still surface a removal rather than be swallowed.
            readEvents: () =>
              Stream.fromIterable([
                makeThreadEvent(1, 'thread.deleted'),
                makeThreadEvent(2, 'thread.message-sent'),
              ]),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.none()),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      )

      const [first] = Array.from(items)
      assert.equal(first?.kind, 'thread-removed')
      assert.equal(first?.kind === 'thread-removed' ? first.threadId : null, goneThreadId)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('subscribeShell retries a transient shell projection refetch failure', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('thread-transient-refetch')
      const now = '2026-01-01T00:00:00.000Z'
      let attempts = 0

      const event: OrchestrationEvent = {
        sequence: 1,
        eventId: EventId.make('event-transient-refetch'),
        aggregateKind: 'thread',
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: 'thread.message-sent',
        payload: {} as never,
      }

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(1),
            readEvents: () => Stream.make(event),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.suspend(() =>
              {
                attempts += 1
                return attempts === 1
                  ? Effect.fail(
                      new PersistenceSqlError({
                        operation: 'test.shell-refetch',
                        detail: 'transient failure',
                      }),
                    )
                  : Effect.succeed(
                      Option.some(makeDefaultOrchestrationThreadShell({ id: threadId })),
                    )
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      )

      const [first] = Array.from(items)
      assert.equal(first?.kind, 'thread-upserted')
      assert.equal(first?.kind === 'thread-upserted' ? first.thread.id : null, threadId)
      assert.equal(attempts, 2)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('subscribeShell coalescing still removes a project after a trailing update', () =>
    Effect.gen(function* ()
    {
      const projectId = ProjectId.make('project-gone')
      const now = '2026-01-01T00:00:00.000Z'

      const makeProjectEvent = (
        sequence: number,
        type: 'project.deleted' | 'project.meta-updated',
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-project-${sequence}`),
          aggregateKind: 'project',
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload:
            type === 'project.deleted'
              ? { projectId, deletedAt: now }
              : { projectId, title: 'Still deleted', updatedAt: now },
        }) as OrchestrationEvent

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            readEvents: () =>
              Stream.fromIterable([
                makeProjectEvent(1, 'project.deleted'),
                makeProjectEvent(2, 'project.meta-updated'),
              ]),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () => Effect.succeed(Option.none()),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      )

      const [first] = Array.from(items)
      assert.equal(first?.kind, 'project-removed')
      assert.equal(first?.kind === 'project-removed' ? first.projectId : null, projectId)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('dispatches archive without transport-local provider or terminal cleanup', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('thread-archive')
      const effects: string[] = []
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const now = '2026-01-01T00:00:00.000Z'

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() =>
              {
                effects.push(`terminal.close:${input.threadId}`)
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                effects.push(`dispatch:${command.type}`)
                return { sequence: dispatchedCommands.length }
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: 'ready',
                      providerName: 'claudeAgent',
                      runtimeMode: 'full-access',
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.archive',
            commandId: CommandId.make('cmd-thread-archive'),
            threadId,
          }),
        ),
      )

      assert.equal(dispatchResult.sequence, 1)
      assert.deepEqual(effects, ['dispatch:thread.archive'])
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ['thread.archive'],
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('archives without consulting transport-local thread session state', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('thread-archive-precheck')
      const effects: string[] = []
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const now = '2026-01-01T00:00:00.000Z'
      let archived = false

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() =>
              {
                effects.push(`terminal.close:${input.threadId}`)
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                effects.push(`dispatch:${command.type}`)
                if (command.type === 'thread.archive')
                {
                  archived = true
                }
                return { sequence: dispatchedCommands.length }
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.sync(() =>
              {
                effects.push(`query:thread-shell:${archived ? 'archived' : 'active'}`)
                return archived
                  ? Option.none()
                  : Option.some(
                      makeDefaultOrchestrationThreadShell({
                        id: threadId,
                        updatedAt: now,
                        session: {
                          threadId,
                          status: 'ready',
                          providerName: 'claudeAgent',
                          runtimeMode: 'full-access',
                          activeTurnId: null,
                          lastError: null,
                          updatedAt: now,
                        },
                      }),
                    )
              }),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.archive',
            commandId: CommandId.make('cmd-thread-archive-precheck'),
            threadId,
          }),
        ),
      )

      assert.equal(dispatchResult.sequence, 1)
      assert.deepEqual(effects, ['dispatch:thread.archive'])
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ['thread.archive'],
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect.each([
    {
      name: 'the thread has no session',
      threadId: ThreadId.make('thread-archive-no-session'),
      commandId: CommandId.make('cmd-thread-archive-no-session'),
      session: null,
    },
    {
      name: 'the thread session is already stopped',
      threadId: ThreadId.make('thread-archive-stopped-session'),
      commandId: CommandId.make('cmd-thread-archive-stopped-session'),
      session: {
        threadId: ThreadId.make('thread-archive-stopped-session'),
        status: 'stopped' as const,
        providerName: 'claudeAgent' as const,
        runtimeMode: 'full-access' as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  ])('archives without dispatching session stop when $name', ({ threadId, commandId, session }) =>
    Effect.gen(function* ()
    {
      const effects: string[] = []
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const now = '2026-01-01T00:00:00.000Z'

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() =>
              {
                effects.push(`terminal.close:${input.threadId}`)
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                effects.push(`dispatch:${command.type}`)
                return { sequence: dispatchedCommands.length }
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session,
                  }),
                ),
              ),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.archive',
            commandId,
            threadId,
          }),
        ),
      )

      assert.equal(dispatchResult.sequence, 1)
      assert.deepEqual(effects, ['dispatch:thread.archive'])
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ['thread.archive'],
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('does not invoke the obsolete session-stop path during archive', () =>
    Effect.gen(function* ()
    {
      const threadId = ThreadId.make('thread-archive-stop-die')
      const effects: string[] = []
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const now = '2026-01-01T00:00:00.000Z'

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() =>
              {
                effects.push(`terminal.close:${input.threadId}`)
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
            {
              dispatchedCommands.push(command)
              effects.push(`dispatch:${command.type}`)
              if (command.type === 'thread.session.stop')
              {
                return Effect.die(new Error('simulated archive stop defect'))
              }
              return Effect.succeed({ sequence: dispatchedCommands.length })
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: 'ready',
                      providerName: 'claudeAgent',
                      runtimeMode: 'full-access',
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.archive',
            commandId: CommandId.make('cmd-thread-archive-stop-die'),
            threadId,
          }),
        ),
      )

      assert.equal(dispatchResult.sequence, 1)
      assert.deepEqual(effects, ['dispatch:thread.archive'])
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ['thread.archive'],
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect(
    'bootstraps first-send worktree turns on the server before dispatching turn start',
    () =>
      Effect.gen(function* ()
      {
        const dispatchedCommands: Array<OrchestrationCommand> = []
        const bootstrapGitOperations: string[] = []
        const refreshStatus = vi.fn((_: string) =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: 't3code/bootstrap-refName',
            hasWorkingTreeChanges: false,
            workingTree: {
              files: [],
              insertions: 0,
              deletions: 0,
            },
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          }),
        )
        const remoteExists = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['remoteExists']>[0]) =>
            Effect.sync(() =>
            {
              bootstrapGitOperations.push('remote-exists')
              return true
            }),
        )
        const fetchRemote = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['fetchRemote']>[0]) =>
            Effect.sync(() =>
            {
              bootstrapGitOperations.push('fetch')
            }),
        )
        const fetchedOriginCommit = '0123456789abcdef0123456789abcdef01234567'
        const resolveRemoteTrackingCommit = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['resolveRemoteTrackingCommit']>[0]) =>
            Effect.sync(() =>
            {
              bootstrapGitOperations.push('resolve-remote-commit')
              return {
                commitSha: fetchedOriginCommit,
                remoteRefName: 'origin/main',
              }
            }),
        )
        const createWorktree = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['createWorktree']>[0]) =>
            Effect.sync(() =>
            {
              bootstrapGitOperations.push('create-worktree')
              return {
                worktree: {
                  refName: 't3code/bootstrap-refName',
                  path: '/tmp/bootstrap-worktree',
                },
              }
            }),
        )
        const runForThread = vi.fn(
          (
            _: Parameters<
              ProjectSetupScriptRunner.ProjectSetupScriptRunner['Service']['runForThread']
            >[0],
          ) =>
            Effect.succeed({
              status: 'started' as const,
              scriptId: 'setup',
              scriptName: 'Setup',
              terminalId: 'setup-setup',
              cwd: '/tmp/bootstrap-worktree',
            }),
        )

        yield* buildAppUnderTest({
          layers: {
            gitVcsDriver: {
              remoteExists,
              fetchRemote,
              resolveRemoteTrackingCommit,
              createWorktree,
            },
            vcsStatusBroadcaster: {
              refreshStatus,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() =>
                {
                  dispatchedCommands.push(command)
                  return { sequence: dispatchedCommands.length }
                }),
              readEvents: () => Stream.empty,
            },
            projectSetupScriptRunner: {
              runForThread,
            },
          },
        })

        const createdAt = '2026-01-01T00:00:00.000Z'
        const wsUrl = yield* getWsServerUrl('/ws')
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: 'thread.turn.start',
              commandId: CommandId.make('cmd-bootstrap-turn-start'),
              threadId: ThreadId.make('thread-bootstrap'),
              message: {
                messageId: MessageId.make('msg-bootstrap'),
                role: 'user',
                text: 'hello',
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: 'full-access',
              interactionMode: 'default',
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: 'Bootstrap Thread',
                  modelSelection: defaultModelSelection,
                  runtimeMode: 'full-access',
                  interactionMode: 'default',
                  branch: 'main',
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: '/tmp/project',
                  baseBranch: 'main',
                  branch: 't3code/bootstrap-refName',
                  startFromOrigin: true,
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        )

        assert.equal(response.sequence, 5)
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          [
            'thread.create',
            'thread.meta.update',
            'thread.activity.append',
            'thread.activity.append',
            'thread.turn.start',
          ],
        )
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: '/tmp/project',
          refName: fetchedOriginCommit,
          newRefName: 't3code/bootstrap-refName',
          baseRefName: 'main',
          path: null,
        })
        assert.deepEqual(fetchRemote.mock.calls[0]?.[0], {
          cwd: '/tmp/project',
          remoteName: 'origin',
        })
        assert.deepEqual(resolveRemoteTrackingCommit.mock.calls[0]?.[0], {
          cwd: '/tmp/project',
          refName: 'main',
          fallbackRemoteName: 'origin',
        })
        assert.deepEqual(bootstrapGitOperations, [
          'remote-exists',
          'fetch',
          'resolve-remote-commit',
          'create-worktree',
        ])
        assert.deepEqual(runForThread.mock.calls[0]?.[0], {
          threadId: ThreadId.make('thread-bootstrap'),
          projectId: defaultProjectId,
          projectCwd: '/tmp/project',
          worktreePath: '/tmp/bootstrap-worktree',
        })
        assert.deepEqual(refreshStatus.mock.calls[0]?.[0], '/tmp/bootstrap-worktree')

        const setupActivities = dispatchedCommands.filter(
          (command): command is Extract<OrchestrationCommand, { type: 'thread.activity.append' }> =>
            command.type === 'thread.activity.append',
        )
        assert.deepEqual(
          setupActivities.map((command) => command.activity.kind),
          ['setup-script.requested', 'setup-script.started'],
        )
        const finalCommand = dispatchedCommands[4]
        assertTrue(finalCommand?.type === 'thread.turn.start')
        if (finalCommand?.type === 'thread.turn.start')
        {
          assert.equal(finalCommand.bootstrap, undefined)
        }
      }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('drains deletion cleanup through the re-created thread event', () =>
    Effect.gen(function* ()
    {
      const trace: Array<string> = []
      const drainRequested = yield* Deferred.make<void>()
      const cleanupDone = yield* Deferred.make<void>()
      yield* buildAppUnderTest({
        layers: {
          threadDeletionReactor: {
            drainThrough: (sequence) =>
              Effect.gen(function* ()
              {
                trace.push(`drain:${sequence}`)
                yield* Deferred.succeed(drainRequested, undefined)
                yield* Deferred.await(cleanupDone)
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() =>
              {
                trace.push(command.type)
                return { sequence: trace.length }
              }),
            readEvents: () => Stream.empty,
          },
        },
      })

      const createdAt = '2026-01-01T00:00:00.000Z'
      const threadId = ThreadId.make('thread-retry-after-delete')
      const wsUrl = yield* getWsServerUrl('/ws')

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* ()
          {
            const directCreate = yield* Effect.forkChild(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: 'thread.create',
                commandId: CommandId.make('cmd-retry-create'),
                threadId,
                projectId: defaultProjectId,
                title: 'Retry',
                modelSelection: defaultModelSelection,
                runtimeMode: 'full-access',
                interactionMode: 'default',
                branch: null,
                worktreePath: null,
                createdAt,
              }),
            )
            yield* Deferred.await(drainRequested)
            assert.deepEqual(trace, ['thread.create', 'drain:1'])
            yield* Deferred.succeed(cleanupDone, undefined)
            yield* Fiber.join(directCreate)
          }),
        ),
      )
      assert.deepEqual(trace, ['thread.create', 'drain:1'])

      trace.length = 0
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.turn.start',
            commandId: CommandId.make('cmd-retry-bootstrap'),
            threadId,
            message: {
              messageId: MessageId.make('msg-retry-bootstrap'),
              role: 'user',
              text: 'hello',
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: 'full-access',
            interactionMode: 'default',
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: 'Retry',
                modelSelection: defaultModelSelection,
                runtimeMode: 'full-access',
                interactionMode: 'default',
                branch: null,
                worktreePath: null,
                createdAt,
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ),
      )
      assert.deepEqual(trace, ['thread.create', 'drain:1', 'thread.turn.start'])
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('falls back to the local base branch when startFromOrigin is set without origin', () =>
    Effect.gen(function* ()
    {
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const remoteExists = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['remoteExists']>[0]) =>
          Effect.succeed(false),
      )
      const fetchRemote = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['fetchRemote']>[0]) => Effect.void,
      )
      const resolveRemoteTrackingCommit = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['resolveRemoteTrackingCommit']>[0]) =>
          Effect.succeed({
            commitSha: '0123456789abcdef0123456789abcdef01234567',
            remoteRefName: 'origin/main',
          }),
      )
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['createWorktree']>[0]) =>
          Effect.succeed({
            worktree: {
              refName: 't3code/bootstrap-refName',
              path: '/tmp/bootstrap-worktree',
            },
          }),
      )

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            remoteExists,
            fetchRemote,
            resolveRemoteTrackingCommit,
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                return { sequence: dispatchedCommands.length }
              }),
            readEvents: () => Stream.empty,
          },
        },
      })

      const createdAt = '2026-01-01T00:00:00.000Z'
      const wsUrl = yield* getWsServerUrl('/ws')
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.turn.start',
            commandId: CommandId.make('cmd-bootstrap-turn-start-no-origin'),
            threadId: ThreadId.make('thread-bootstrap-no-origin'),
            message: {
              messageId: MessageId.make('msg-bootstrap-no-origin'),
              role: 'user',
              text: 'hello',
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: 'full-access',
            interactionMode: 'default',
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: 'Bootstrap Thread',
                modelSelection: defaultModelSelection,
                runtimeMode: 'full-access',
                interactionMode: 'default',
                branch: 'main',
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: '/tmp/project',
                baseBranch: 'main',
                branch: 't3code/bootstrap-refName',
                startFromOrigin: true,
              },
            },
            createdAt,
          }),
        ),
      )

      assert.deepEqual(remoteExists.mock.calls[0]?.[0], {
        cwd: '/tmp/project',
        remoteName: 'origin',
      })
      assert.equal(fetchRemote.mock.calls.length, 0)
      assert.equal(resolveRemoteTrackingCommit.mock.calls.length, 0)
      assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
        cwd: '/tmp/project',
        refName: 'main',
        newRefName: 't3code/bootstrap-refName',
        baseRefName: 'main',
        path: null,
      })
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('records setup-script failures without aborting bootstrap turn start', () =>
    Effect.gen(function* ()
    {
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['createWorktree']>[0]) =>
          Effect.succeed({
            worktree: {
              refName: 't3code/bootstrap-refName',
              path: '/tmp/bootstrap-worktree',
            },
          }),
      )
      const runForThread = vi.fn(
        (
          input: Parameters<
            ProjectSetupScriptRunner.ProjectSetupScriptRunner['Service']['runForThread']
          >[0],
        ) =>
          Effect.fail(
            new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
              threadId: input.threadId,
              worktreePath: input.worktreePath,
              operation: 'openTerminal',
              cause: { message: 'pty unavailable' },
            }),
          ),
      )

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                return { sequence: dispatchedCommands.length }
              }),
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      })

      const createdAt = '2026-01-01T00:00:00.000Z'
      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.turn.start',
            commandId: CommandId.make('cmd-bootstrap-turn-start-setup-failure'),
            threadId: ThreadId.make('thread-bootstrap-setup-failure'),
            message: {
              messageId: MessageId.make('msg-bootstrap-setup-failure'),
              role: 'user',
              text: 'hello',
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: 'full-access',
            interactionMode: 'default',
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: 'Bootstrap Thread',
                modelSelection: defaultModelSelection,
                runtimeMode: 'full-access',
                interactionMode: 'default',
                branch: 'main',
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: '/tmp/project',
                baseBranch: 'main',
                branch: 't3code/bootstrap-refName',
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      )

      assert.equal(response.sequence, 4)
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ['thread.create', 'thread.meta.update', 'thread.activity.append', 'thread.turn.start'],
      )
      const setupFailureActivity = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: 'thread.activity.append' }> =>
          command.type === 'thread.activity.append',
      )
      assert.equal(setupFailureActivity?.activity.kind, 'setup-script.failed')
      assert.deepEqual(setupFailureActivity?.activity.payload, {
        detail: 'pty unavailable',
        worktreePath: '/tmp/bootstrap-worktree',
      })
      assertTrue(dispatchedCommands.every((command) => command.type !== 'thread.delete'))
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('does not misattribute setup activity dispatch failures as setup launch failures', () =>
    Effect.gen(function* ()
    {
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['createWorktree']>[0]) =>
          Effect.succeed({
            worktree: {
              refName: 't3code/bootstrap-refName',
              path: '/tmp/bootstrap-worktree',
            },
          }),
      )
      const runForThread = vi.fn(
        (
          _: Parameters<
            ProjectSetupScriptRunner.ProjectSetupScriptRunner['Service']['runForThread']
          >[0],
        ) =>
          Effect.succeed({
            status: 'started' as const,
            scriptId: 'setup',
            scriptName: 'Setup',
            terminalId: 'setup-setup',
            cwd: '/tmp/bootstrap-worktree',
          }),
      )
      let setupActivityAppendAttempt = 0

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
            {
              if (
                command.type === 'thread.activity.append' &&
                command.activity.kind.startsWith('setup-script.')
              )
              {
                setupActivityAppendAttempt += 1
                if (setupActivityAppendAttempt === 2)
                {
                  return Effect.fail(
                    new OrchestrationListenerCallbackError({
                      listener: 'domain-event',
                      detail: 'failed to append setup-script.started activity',
                    }),
                  )
                }
              }

              return Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                return { sequence: dispatchedCommands.length }
              })
            },
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      })

      const createdAt = '2026-01-01T00:00:00.000Z'
      const wsUrl = yield* getWsServerUrl('/ws')
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.turn.start',
            commandId: CommandId.make('cmd-bootstrap-turn-start-setup-activity-failure'),
            threadId: ThreadId.make('thread-bootstrap-setup-activity-failure'),
            message: {
              messageId: MessageId.make('msg-bootstrap-setup-activity-failure'),
              role: 'user',
              text: 'hello',
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: 'full-access',
            interactionMode: 'default',
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: 'Bootstrap Thread',
                modelSelection: defaultModelSelection,
                runtimeMode: 'full-access',
                interactionMode: 'default',
                branch: 'main',
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: '/tmp/project',
                baseBranch: 'main',
                branch: 't3code/bootstrap-refName',
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      )

      assert.equal(response.sequence, 4)
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ['thread.create', 'thread.meta.update', 'thread.activity.append', 'thread.turn.start'],
      )
      const setupActivities = dispatchedCommands.filter(
        (command): command is Extract<OrchestrationCommand, { type: 'thread.activity.append' }> =>
          command.type === 'thread.activity.append',
      )
      assert.deepEqual(
        setupActivities.map((command) => command.activity.kind),
        ['setup-script.requested'],
      )
      assertTrue(
        setupActivities.every((command) => command.activity.kind !== 'setup-script.failed'),
      )
      assertTrue(dispatchedCommands.every((command) => command.type !== 'thread.delete'))
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('cleans up created bootstrap threads when worktree creation defects', () =>
    Effect.gen(function* ()
    {
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['createWorktree']>[0]) =>
          Effect.die(new Error('worktree exploded')),
      )

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                return { sequence: dispatchedCommands.length }
              }),
            readEvents: () => Stream.empty,
          },
        },
      })

      const createdAt = '2026-01-01T00:00:00.000Z'
      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.turn.start',
            commandId: CommandId.make('cmd-bootstrap-turn-start-defect'),
            threadId: ThreadId.make('thread-bootstrap-defect'),
            message: {
              messageId: MessageId.make('msg-bootstrap-defect'),
              role: 'user',
              text: 'hello',
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: 'full-access',
            interactionMode: 'default',
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: 'Bootstrap Thread',
                modelSelection: defaultModelSelection,
                runtimeMode: 'full-access',
                interactionMode: 'default',
                branch: 'main',
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: '/tmp/project',
                baseBranch: 'main',
                branch: 't3code/bootstrap-refName',
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      )

      assertTrue(result._tag === 'Failure')
      assertTrue(result.failure._tag === 'OrchestrationDispatchCommandError')
      assert.include(result.failure.message, 'worktree exploded')
      assert.strictEqual(result.failure.bootstrapThreadDisposition, 'deleted')
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ['thread.create', 'thread.delete'],
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('does not report a deleted bootstrap thread when cleanup fails', () =>
    Effect.gen(function* ()
    {
      const dispatchedCommands: Array<OrchestrationCommand> = []
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver['Service']['createWorktree']>[0]) =>
          Effect.die(new Error('worktree exploded')),
      )

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
            {
              if (command.type === 'thread.delete')
              {
                return Effect.sync(() =>
                {
                  dispatchedCommands.push(command)
                  return { sequence: dispatchedCommands.length }
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new OrchestrationListenerCallbackError({
                        listener: 'domain-event',
                        detail: 'thread cleanup exploded',
                      }),
                    ),
                  ),
                )
              }
              return Effect.sync(() =>
              {
                dispatchedCommands.push(command)
                return { sequence: dispatchedCommands.length }
              })
            },
            readEvents: () => Stream.empty,
          },
        },
      })

      const createdAt = '2026-01-01T00:00:00.000Z'
      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: 'thread.turn.start',
            commandId: CommandId.make('cmd-bootstrap-turn-start-cleanup-defect'),
            threadId: ThreadId.make('thread-bootstrap-cleanup-defect'),
            message: {
              messageId: MessageId.make('msg-bootstrap-cleanup-defect'),
              role: 'user',
              text: 'hello',
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: 'full-access',
            interactionMode: 'default',
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: 'Bootstrap Thread',
                modelSelection: defaultModelSelection,
                runtimeMode: 'full-access',
                interactionMode: 'default',
                branch: 'main',
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: '/tmp/project',
                baseBranch: 'main',
                branch: 't3code/bootstrap-refName',
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      )

      assertTrue(result._tag === 'Failure')
      assertTrue(result.failure._tag === 'OrchestrationDispatchCommandError')
      assert.include(result.failure.message, 'worktree exploded')
      assert.strictEqual(result.failure.bootstrapThreadDisposition, undefined)
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ['thread.create', 'thread.delete'],
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc terminal methods', () =>
    Effect.gen(function* ()
    {
      const snapshot = {
        threadId: 'thread-1',
        terminalId: 'default',
        cwd: '/tmp/project',
        worktreePath: null,
        status: 'running' as const,
        pid: 1234,
        history: '',
        exitCode: null,
        exitSignal: null,
        label: 'Primary',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: 'thread-1',
            terminalId: 'default',
            cwd: '/tmp/project',
          }),
        ),
      )
      assert.equal(opened.terminalId, 'default')

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: 'thread-1',
            terminalId: 'default',
            data: 'echo hi\n',
          }),
        ),
      )

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: 'thread-1',
            terminalId: 'default',
            cols: 120,
            rows: 40,
          }),
        ),
      )

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: 'thread-1',
            terminalId: 'default',
          }),
        ),
      )

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: 'thread-1',
            terminalId: 'default',
            cwd: '/tmp/project',
            cols: 120,
            rows: 40,
          }),
        ),
      )
      assert.equal(restarted.terminalId, 'default')

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: 'thread-1',
            terminalId: 'default',
          }),
        ),
      )
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )

  it.effect('routes websocket rpc terminal.write errors', () =>
    Effect.gen(function* ()
    {
      const terminalError = new TerminalNotRunningError({
        threadId: 'thread-1',
        terminalId: 'default',
      })
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      })

      const wsUrl = yield* getWsServerUrl('/ws')
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: 'thread-1',
            terminalId: 'default',
            data: 'echo fail\n',
          }),
        ).pipe(Effect.result),
      )

      assertFailure(result, terminalError)
    }).pipe(Effect.provide(loopbackHttpServerTestLayer)),
  )
})
