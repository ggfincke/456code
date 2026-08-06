// apps/server/src/ws.ts
// serves authenticated websocket rpc handlers for server capabilities

import * as Cause from 'effect/Cause'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  CommandId,
  type ClientOrchestrationCommand,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  CartographerEmbedError,
  RelayClientInstallFailedError,
  type RelayClientStatus,
  ServerSelfUpdateError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from '@t3tools/contracts'
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from 'effect/unstable/http'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'

import * as CheckpointDiffQuery from './checkpointing/CheckpointDiffQuery.ts'
import * as ServerConfig from './config.ts'
import * as Keybindings from './keybindings.ts'
import * as ExternalLauncher from './process/externalLauncher.ts'
import * as OrchestrationEngine from './orchestration/Services/OrchestrationEngine.ts'
import * as ProjectionSnapshotQuery from './orchestration/Services/ProjectionSnapshotQuery.ts'
import { OrchestrationProjectionPipeline } from './orchestration/Services/ProjectionPipeline.ts'
import { ImportReplacementIntentRepository } from './persistence/Services/ImportReplacementIntents.ts'
import { AttachmentLifecycleRepository } from './persistence/Services/AttachmentLifecycle.ts'
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from './orchestration/Errors.ts'
import * as ImportContinuation from './import/continuationContract.ts'
import * as WorkspaceMdxDocument from './mdx/WorkspaceMdxDocument.ts'
import * as CartographerEmbedBroker from './cartographer/CartographerEmbedBroker.ts'
import * as ProposalGenerationService from './proposal/ProposalGenerationService.ts'
import * as ProposalImplementationAttemptService from './proposal/ProposalImplementationAttemptService.ts'
import * as ProposalService from './proposal/ProposalService.ts'
import { dispatchWithAttachmentLifecycle } from './orchestration/dispatchWithAttachmentLifecycle.ts'
import { makeProposalRpcHandlers } from './ws/handlers/proposalHandlers.ts'
import { makePreviewRpcHandlers } from './ws/handlers/previewHandlers.ts'
import { makeOrchestrationRpcHandlers } from './ws/handlers/orchestrationHandlers.ts'
import { makeVcsRpcHandlers } from './ws/handlers/vcsHandlers.ts'
import { makeWorkspaceRpcHandlers } from './ws/handlers/workspaceHandlers.ts'
import { makeRpcAuthorization, toAuthAccessStreamEvent } from './ws/rpcAuthorization.ts'
import * as ProviderRegistry from './provider/Services/ProviderRegistry.ts'
import * as ProviderMaintenanceRunner from './provider/providerMaintenanceRunner.ts'
import * as ServerLifecycleEvents from './serverLifecycleEvents.ts'
import * as ServerRuntimeStartup from './serverRuntimeStartup.ts'
import * as ServerSettings from './serverSettings.ts'
import * as TerminalManager from './terminal/Manager.ts'
import * as PreviewAutomationBroker from './mcp/PreviewAutomationBroker.ts'
import * as PreviewManager from './preview/Manager.ts'
import { issueAssetUrl } from './assets/AssetAccess.ts'
import * as PortScanner from './preview/PortScanner.ts'
import * as WorkspaceEntries from './workspace/WorkspaceEntries.ts'
import * as WorkspaceFileSystem from './workspace/WorkspaceFileSystem.ts'
import * as WorkspacePaths from './workspace/WorkspacePaths.ts'
import * as VcsStatusBroadcaster from './vcs/VcsStatusBroadcaster.ts'
import * as VcsProvisioningService from './vcs/VcsProvisioningService.ts'
import * as GitWorkflowService from './git/GitWorkflowService.ts'
import * as ReviewService from './review/ReviewService.ts'
import * as ProjectSetupScriptRunner from './project/ProjectSetupScriptRunner.ts'
import * as ServerEnvironment from './environment/ServerEnvironment.ts'
import * as EnvironmentAuth from './auth/EnvironmentAuth.ts'
import * as ProcessDiagnostics from './diagnostics/ProcessDiagnostics.ts'
import * as ProcessResourceMonitor from './diagnostics/ProcessResourceMonitor.ts'
import * as TraceDiagnostics from './diagnostics/TraceDiagnostics.ts'
import * as WorkerBrokerStore from './workers/WorkerBrokerStore.ts'
import * as WorkersStatusBroadcaster from './workers/WorkersStatusBroadcaster.ts'
import { readWorkersReadiness } from './workers/WorkersReadiness.ts'
import * as SourceControlDiscovery from './sourceControl/SourceControlDiscovery.ts'
import * as SourceControlRepositoryService from './sourceControl/SourceControlRepositoryService.ts'
import * as PairingGrantStore from './auth/PairingGrantStore.ts'
import * as SessionStore from './auth/SessionStore.ts'
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from './auth/http.ts'

// prefer a continuation implementation provided by the server layer graph
// (see server.ts providing ImportContinuationLive onto the ws route layer);
// harness graphs without one fall back to an inert bind so imports still work
const ImportContinuationFromContext = Layer.effect(
  ImportContinuation.ImportContinuationDeps,
  Effect.serviceOption(ImportContinuation.ImportContinuationDeps).pipe(
    Effect.map(
      Option.getOrElse(() =>
        ImportContinuation.ImportContinuationDeps.of({
          bind: (request) =>
            Effect.succeed({
              state: 'history-only',
              providerInstanceId: request.providerInstanceId,
              continuationIdentity: null,
              reason: 'continuation module not wired',
            }),
        }),
      ),
    ),
  ),
)

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError)
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError)
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
)

const readOrchestrationCommandErrorCode = (error: unknown): string | undefined =>
  isOrchestrationCommandInvariantError(error) ||
  isOrchestrationCommandPreviouslyRejectedError(error)
    ? error.code
    : undefined

// T3 Connect is not part of this build. The contract-defined cloud and
// self-update RPCs stay registered so the WS method registry is complete, and
// report themselves as unavailable instead of pretending to work.
const SERVER_SELF_UPDATE_UNAVAILABLE = 'This server does not support remote updates.'
const RELAY_CLIENT_UNAVAILABLE_MESSAGE = 'This server does not support the relay client.'
const RELAY_CLIENT_UNAVAILABLE_STATUS = {
  status: 'unsupported',
  platform: 'unsupported',
  arch: 'unsupported',
  version: '',
} as const satisfies RelayClientStatus

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)
const EDITOR_DISCOVERY_TIMEOUT = Duration.seconds(5)

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  discovery.pipe(
    Effect.timeoutOption(EDITOR_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(() => [])),
  )

function unexpectedCompatibilityError(error: never): never
{
  throw new Error(`Unhandled compatibility error: ${String(error)}`)
}

// preserve the setup runner's broader pre-refactor message normalization.
function legacySetupFailureDescription(cause: unknown): string
{
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'message' in cause &&
    typeof cause.message === 'string'
  )
  {
    return cause.message
  }
  return String(cause)
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string
{
  switch (error._tag)
  {
    case 'ProjectSetupScriptOperationError':
      return legacySetupFailureDescription(error.cause)
    case 'ProjectSetupScriptProjectNotFoundError':
      return 'Project was not found for setup script execution.'
    default:
      return unexpectedCompatibilityError(error)
  }
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker['Service'],
  cartographerEmbedBroker: CartographerEmbedBroker.CartographerEmbedBroker['Service'],
  authenticatedOrigin: string | undefined,
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* ()
    {
      const currentSessionId = currentSession.sessionId
      const crypto = yield* Crypto.Crypto
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
      const projectionPipeline = yield* OrchestrationProjectionPipeline
      const importReplacementIntents = yield* ImportReplacementIntentRepository
      const attachmentLifecycle = yield* AttachmentLifecycleRepository
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery
      const keybindings = yield* Keybindings.Keybindings
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService
      const review = yield* ReviewService.ReviewService
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster
      const terminalManager = yield* TerminalManager.TerminalManager
      const previewManager = yield* PreviewManager.PreviewManager
      const portDiscovery = yield* PortScanner.PortDiscovery
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner
      const config = yield* ServerConfig.ServerConfig
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents
      const serverSettings = yield* ServerSettings.ServerSettingsService
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem
      const path = yield* Path.Path
      const proposalService = yield* ProposalService.ProposalService
      const proposalGenerationService = yield* ProposalGenerationService.ProposalGenerationService
      const proposalImplementationAttemptService =
        yield* ProposalImplementationAttemptService.ProposalImplementationAttemptService
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.automaticGitFetchInterval),
        Effect.catch((cause) =>
          Effect.logWarning('Failed to read automatic Git fetch interval setting', {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      )
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore
      const sessions = yield* SessionStore.SessionStore
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor
      const workerBrokerStore = yield* WorkerBrokerStore.WorkerBrokerStore
      const workersStatusBroadcaster = yield* WorkersStatusBroadcaster.WorkersStatusBroadcaster
      const { observeRpcEffect, observeRpcStream, observeRpcStreamEffect } =
        makeRpcAuthorization(currentSession)
      const workspaceRpcHandlers = makeWorkspaceRpcHandlers({
        workspaceEntries,
        workspaceFileSystem,
        externalLauncher,
        projectionSnapshotQuery,
        readWorkspaceMdxDocument: WorkspaceMdxDocument.readWorkspaceMdxDocument,
        issueAssetUrl,
        observeRpcEffect,
      })
      const proposalRpcHandlers = makeProposalRpcHandlers({
        proposalService,
        proposalGenerationService,
        proposalImplementationAttemptService,
        projectionSnapshotQuery,
        serverEnvironment,
        compileSafeDocumentSource: WorkspaceMdxDocument.compileSafeDocumentSource,
        observeRpcEffect,
      })
      const previewRpcHandlers = makePreviewRpcHandlers({
        previewManager,
        previewAutomationBroker,
        portDiscovery,
        observeRpcEffect,
        observeRpcStream,
        observeRpcStreamEffect,
      })
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
      {
        if (isOrchestrationDispatchCommandError(cause)) return cause
        const code = readOrchestrationCommandErrorCode(cause)
        return new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          ...(code === undefined ? {} : { code }),
          cause,
        })
      }
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, 'Failed to generate orchestration command identifier.'),
        ),
      )
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make))
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)))

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        )

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId
        readonly kind: 'setup-script.requested' | 'setup-script.started' | 'setup-script.failed'
        readonly summary: string
        readonly createdAt: string
        readonly payload: Record<string, unknown>
        readonly tone: 'info' | 'error'
      }) =>
        Effect.all({
          commandId: serverCommandId('setup-script-activity'),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            orchestrationEngine.dispatch({
              type: 'thread.activity.append',
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        )

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) =>
      {
        const error = Cause.squash(cause)
        if (isOrchestrationDispatchCommandError(error)) return error
        const code = readOrchestrationCommandErrorCode(error)
        return new OrchestrationDispatchCommandError({
          message:
            error instanceof Error ? error.message : 'Failed to bootstrap thread turn start.',
          ...(code === undefined ? {} : { code }),
          cause,
        })
      }

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: 'thread.turn.start' }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* ()
        {
          const bootstrap = command.bootstrap
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command
          let createdThread = false
          let targetProjectId = bootstrap?.createThread?.projectId
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId('bootstrap-thread-delete').pipe(
                  Effect.flatMap((commandId) =>
                    orchestrationEngine.dispatch({
                      type: 'thread.delete',
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError
            readonly requestedAt: string
            readonly worktreePath: string
          }) =>
          {
            const detail = projectSetupScriptCompatibilityDetail(input.error)
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: 'setup-script.failed',
              summary: 'Setup script failed to start',
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: 'error',
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning('bootstrap turn start failed to launch setup script', {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            )
          }

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string
            readonly worktreePath: string
            readonly scriptId: string
            readonly scriptName: string
            readonly terminalId: string
          }) =>
            Effect.gen(function* ()
            {
              const startedAt = yield* nowIso
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              }
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: 'setup-script.requested',
                  summary: 'Starting setup script',
                  createdAt: input.requestedAt,
                  payload,
                  tone: 'info',
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: 'setup-script.started',
                  summary: 'Setup script started',
                  createdAt: startedAt,
                  payload,
                  tone: 'info',
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    'bootstrap turn start launched setup script but failed to record setup activity',
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              )
            })

          const runSetupProgram = () =>
            Effect.gen(function* ()
            {
              if (!bootstrap?.runSetupScript || !targetWorktreePath)
              {
                return
              }
              const worktreePath = targetWorktreePath
              const requestedAt = yield* nowIso
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }),
                    onSuccess: (setupResult) =>
                    {
                      if (setupResult.status !== 'started')
                      {
                        return Effect.void
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      })
                    },
                  }),
                )
            })

          const bootstrapProgram = Effect.gen(function* ()
          {
            if (bootstrap?.createThread)
            {
              yield* orchestrationEngine.dispatch({
                type: 'thread.create',
                commandId: yield* serverCommandId('bootstrap-thread-create'),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              })
              createdThread = true
            }

            if (bootstrap?.prepareWorktree)
            {
              let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch
              if (bootstrap.prepareWorktree.startFromOrigin)
              {
                yield* gitWorkflow.fetchRemote({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: 'origin',
                })
                const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  refName: bootstrap.prepareWorktree.baseBranch,
                  fallbackRemoteName: 'origin',
                })
                worktreeBaseRef = resolvedRemoteBase.commitSha
              }
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: worktreeBaseRef,
                newRefName: bootstrap.prepareWorktree.branch,
                baseRefName: bootstrap.prepareWorktree.baseBranch,
                path: null,
              })
              targetWorktreePath = worktree.worktree.path
              yield* orchestrationEngine.dispatch({
                type: 'thread.meta.update',
                commandId: yield* serverCommandId('bootstrap-thread-meta-update'),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              })
              yield* refreshGitStatus(targetWorktreePath)
            }

            yield* runSetupProgram()

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand)
          })

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) =>
            {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause)
              if (Cause.hasInterruptsOnly(cause))
              {
                return Effect.fail(dispatchError)
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)))
            }),
          )
        })

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
      {
        const dispatchEffect =
          normalizedCommand.type === 'thread.turn.start' && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, 'Failed to dispatch orchestration command'),
                  ),
                )

        return dispatchWithAttachmentLifecycle(
          normalizedCommand,
          startup.enqueueCommand(dispatchEffect),
        ).pipe(
          Effect.provideService(AttachmentLifecycleRepository, attachmentLifecycle),
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, 'Failed to dispatch orchestration command'),
          ),
        )
      }

      const prevalidateImportContinuationProvider = (
        command: ClientOrchestrationCommand,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> =>
        Effect.gen(function* ()
        {
          if (command.type !== 'thread.turn.start' || !command.importContinuationConsent)
          {
            return
          }
          const consent = command.importContinuationConsent
          const providers = yield* providerRegistry.getProviders
          const target = providers.find(
            (provider) => provider.instanceId === consent.targetProviderInstanceId,
          )
          const continuationIdentity = consent.continuation.continuationIdentity
          if (
            continuationIdentity !== null &&
            target?.driver === consent.driverKind &&
            continuationIdentity.driverKind === consent.driverKind &&
            target.continuation?.groupKey === continuationIdentity.continuationKey
          )
          {
            return
          }
          return yield* new OrchestrationDispatchCommandError({
            message: `Imported continuation provider instance '${consent.targetProviderInstanceId}' no longer resolves to the accepted continuation source.`,
          })
        })

      const loadServerConfig = Effect.gen(function* ()
      {
        const keybindingsConfig = yield* keybindings.loadConfigState
        const providers = yield* providerRegistry.getProviders
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        )
        const environment = yield* serverEnvironment.getDescriptor
        const auth = yield* serverAuth.getDescriptor()

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: yield* resolveAvailableEditorsForConfig(
            externalLauncher.resolveAvailableEditors(),
          ),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
          shellResumeCompletionMarker: true,
          threadResumeCompletionMarker: true,
        }
      })

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid)
      const vcsRpcHandlers = makeVcsRpcHandlers({
        gitWorkflow,
        vcsProvisioning,
        vcsStatusBroadcaster,
        automaticGitFetchInterval,
        refreshGitStatus,
        observeRpcEffect,
        observeRpcStream,
      })

      const orchestrationRpcHandlers = makeOrchestrationRpcHandlers({
        checkpointDiffQuery,
        childProcessSpawner,
        config,
        importReplacementIntents,
        importContinuationFromContext: ImportContinuationFromContext,
        orchestrationEngine,
        path,
        projectionPipeline,
        projectionSnapshotQuery,
        providerRegistry,
        serverSettings,
        terminalManager,
        workspacePaths,
        dispatchNormalizedCommand,
        nowIso,
        prevalidateImportContinuationProvider,
        toDispatchCommandError,
        observeRpcEffect,
        observeRpcStreamEffect,
      })

      return WsRpcGroup.of({
        ...orchestrationRpcHandlers,
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            'rpc.aggregate': 'server',
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            'rpc.aggregate': 'server',
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { 'rpc.aggregate': 'server' },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              'rpc.aggregate': 'server',
            },
          ),
        [WS_METHODS.serverUpdateServer]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateServer,
            Effect.fail(new ServerSelfUpdateError({ reason: SERVER_SELF_UPDATE_UNAVAILABLE })),
            {
              'rpc.aggregate': 'server',
            },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* ()
            {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule)
              return { keybindings: keybindingsConfig, issues: [] }
            }),
            { 'rpc.aggregate': 'server' },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* ()
            {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule)
              return { keybindings: keybindingsConfig, issues: [] }
            }),
            { 'rpc.aggregate': 'server' },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              'rpc.aggregate': 'server',
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings
              .updateSettings(patch)
              .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
            {
              'rpc.aggregate': 'server',
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              'rpc.aggregate': 'server',
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              'rpc.aggregate': 'server',
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            'rpc.aggregate': 'server',
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              'rpc.aggregate': 'server',
            },
          ),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            'rpc.aggregate': 'server',
          }),
        [WS_METHODS.workersList]: (input) =>
          observeRpcEffect(WS_METHODS.workersList, workerBrokerStore.list(input), {
            'rpc.aggregate': 'workers',
          }),
        [WS_METHODS.workersReadiness]: (_input) =>
          observeRpcEffect(
            WS_METHODS.workersReadiness,
            workerBrokerStore
              .list({})
              .pipe(Effect.flatMap((snapshot) => readWorkersReadiness(snapshot.stateDir))),
            { 'rpc.aggregate': 'workers' },
          ),
        [WS_METHODS.workersListRuns]: (input) =>
          observeRpcEffect(WS_METHODS.workersListRuns, workerBrokerStore.listRuns(input), {
            'rpc.aggregate': 'workers',
          }),
        [WS_METHODS.workersGetJob]: (input) =>
          observeRpcEffect(WS_METHODS.workersGetJob, workerBrokerStore.getJob(input), {
            'rpc.aggregate': 'workers',
          }),
        [WS_METHODS.workersGetRun]: (input) =>
          observeRpcEffect(WS_METHODS.workersGetRun, workerBrokerStore.getRun(input), {
            'rpc.aggregate': 'workers',
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(
            WS_METHODS.cloudGetRelayClientStatus,
            Effect.succeed(RELAY_CLIENT_UNAVAILABLE_STATUS),
            {
              'rpc.aggregate': 'cloud',
            },
          ),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.fail(
              new RelayClientInstallFailedError({
                reason: 'unsupported_platform',
                message: RELAY_CLIENT_UNAVAILABLE_MESSAGE,
              }),
            ),
            { 'rpc.aggregate': 'cloud' },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              'rpc.aggregate': 'source-control',
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              'rpc.aggregate': 'source-control',
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              'rpc.aggregate': 'source-control',
            },
          ),
        ...workspaceRpcHandlers,
        ...proposalRpcHandlers,
        [WS_METHODS.cartographerIssueEmbed]: (input) =>
          observeRpcEffect(
            WS_METHODS.cartographerIssueEmbed,
            Effect.gen(function* ()
            {
              if (authenticatedOrigin === undefined || input.parentOrigin !== authenticatedOrigin)
              {
                return yield* new CartographerEmbedError({
                  failure: 'start_failed',
                  message:
                    'The Cartographer parent origin does not match the authenticated client.',
                })
              }
              const contextNotFound = () =>
                new CartographerEmbedError({
                  failure: 'workspace_context_not_found' as const,
                  message: 'The Cartographer workspace context was not found.',
                })
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.threadId)
                .pipe(Effect.mapError(contextNotFound))
              if (Option.isNone(thread))
              {
                return yield* contextNotFound()
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(Effect.mapError(contextNotFound))
              if (Option.isNone(project))
              {
                return yield* contextNotFound()
              }
              const generationTarget =
                input.generationId === undefined
                  ? null
                  : yield* proposalGenerationService.resolveEmbedTarget(
                      input.threadId,
                      input.generationId,
                    )
              const workspaceRoot =
                generationTarget === null
                  ? (thread.value.worktreePath ?? project.value.workspaceRoot)
                  : generationTarget.proposedRoot
              return yield* cartographerEmbedBroker.issue({
                threadId: input.threadId,
                ...(generationTarget === null
                  ? {}
                  : {
                      generationId: generationTarget.generation.generationId,
                      baseGraphPath: generationTarget.baseGraphPath,
                      proposedGraphPath: generationTarget.proposedGraphPath,
                      impactPath: generationTarget.impactPath,
                    }),
                workspaceRoot,
                parentOrigin: authenticatedOrigin,
                theme: input.theme,
              })
            }),
            { 'rpc.aggregate': 'cartographer' },
          ),
        [WS_METHODS.cartographerCloseEmbed]: (input) =>
          observeRpcEffect(
            WS_METHODS.cartographerCloseEmbed,
            Effect.gen(function* ()
            {
              const contextNotFound = () =>
                new CartographerEmbedError({
                  failure: 'workspace_context_not_found' as const,
                  message: 'The Cartographer workspace context was not found.',
                })
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.threadId)
                .pipe(Effect.mapError(contextNotFound))
              if (Option.isNone(thread))
              {
                return yield* contextNotFound()
              }
              yield* cartographerEmbedBroker.releaseSession(input.threadId, input.sessionId)
            }),
            { 'rpc.aggregate': 'cartographer' },
          ),
        ...vcsRpcHandlers,
        [WS_METHODS.workersSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.workersSubscribe,
            workersStatusBroadcaster.streamSnapshots(input),
            {
              'rpc.aggregate': 'workers',
            },
          ),
        [WS_METHODS.workersSubscribeActivity]: (input) =>
          observeRpcStream(
            WS_METHODS.workersSubscribeActivity,
            workersStatusBroadcaster.streamActivity(input),
            {
              'rpc.aggregate': 'workers',
            },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            'rpc.aggregate': 'review',
          }),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            'rpc.aggregate': 'terminal',
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { 'rpc.aggregate': 'terminal' },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            'rpc.aggregate': 'terminal',
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            'rpc.aggregate': 'terminal',
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            'rpc.aggregate': 'terminal',
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            'rpc.aggregate': 'terminal',
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            'rpc.aggregate': 'terminal',
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { 'rpc.aggregate': 'terminal' },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { 'rpc.aggregate': 'terminal' },
          ),
        ...previewRpcHandlers,
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* ()
            {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: 'keybindingsUpdated' as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              )
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: 'providerStatuses' as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              )
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: 'settingsUpdated' as const,
                  payload: { settings },
                })),
              )

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped)

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              )

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: 'snapshot' as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              )
            }),
            { 'rpc.aggregate': 'server' },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* ()
            {
              const liveQueue = yield* Stream.toQueue(lifecycleEvents.stream, {
                capacity: 'unbounded',
              })
              const snapshot = yield* lifecycleEvents.snapshot
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              )
              const liveEvents = Stream.fromQueue(liveQueue).pipe(
                Stream.catchCause(() => Stream.empty),
                Stream.filter((event) => event.sequence > snapshot.sequence),
              )
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents)
            }),
            { 'rpc.aggregate': 'server' },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* ()
            {
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges)
              const liveQueue = yield* Stream.toQueue(accessChanges, { capacity: 'unbounded' })
              const initialSnapshot = yield* loadAuthAccessSnapshot()
              const revisionRef = yield* Ref.make(1)

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = Stream.fromQueue(
                liveQueue,
              ).pipe(
                Stream.catchCause(() => Stream.empty),
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              )

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: 'snapshot' as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              )
            }),
            { 'rpc.aggregate': 'auth' },
          ),
      })
    }),
  )

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* ()
  {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker
    const cartographerEmbedBroker = yield* CartographerEmbedBroker.CartographerEmbedBroker
    return HttpRouter.add(
      'GET',
      '/ws',
      Effect.gen(function* ()
      {
        const request = yield* HttpServerRequest.HttpServerRequest
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth
        const sessions = yield* SessionStore.SessionStore
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal('internal_error', error),
          ),
        )
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(
              session,
              previewAutomationBroker,
              cartographerEmbedBroker,
              request.headers.origin,
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(ProviderMaintenanceRunner.layer),
            ),
          ),
        )
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        )
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    )
  }),
)
