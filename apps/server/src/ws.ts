// apps/server/src/ws.ts
// serves authenticated websocket rpc handlers for server capabilities

import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  DEFAULT_MODEL_BY_PROVIDER,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  AuthAccessReadScope,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  CommandId,
  type ClientOrchestrationCommand,
  defaultInstanceIdForDriver,
  type DiscoveredLocalServerList,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  type ProjectId,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectReadMdxDocumentError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProposalError,
  CartographerEmbedError,
  RelayClientInstallFailedError,
  type RelayClientStatus,
  ServerSelfUpdateError,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  EnvironmentAuthorizationError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ImportContinuation from "./import/continuationContract.ts";
import * as WorkspaceMdxDocument from "./mdx/WorkspaceMdxDocument.ts";
import * as CartographerEmbedBroker from "./cartographer/CartographerEmbedBroker.ts";
import * as ProposalGenerationService from "./proposal/ProposalGenerationService.ts";
import * as ProposalImplementationAttemptService from "./proposal/ProposalImplementationAttemptService.ts";
import * as ProposalService from "./proposal/ProposalService.ts";

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
              state: "history-only",
              providerInstanceId: request.providerInstanceId,
              continuationIdentity: null,
              reason: "continuation module not wired",
            }),
        }),
      ),
    ),
  ),
);
import * as ImportDiscovery from "./import/discovery.ts";
import * as ImportSessions from "./import/importService.ts";
import {
  AcpImportError,
  loadAcpImportSessionsBatch,
  scanAcpImportCatalog,
} from "./import/acpImport.ts";
import { partitionAcpImportBytePolicy } from "./import/resourceLimits.ts";
import { resolveAcpImportSourceCatalog, resolveSourceCatalog } from "./import/sourceCatalog.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as WorkerBrokerStore from "./workers/WorkerBrokerStore.ts";
import * as WorkersStatusBroadcaster from "./workers/WorkersStatusBroadcaster.ts";
import { readWorkersReadiness } from "./workers/WorkersReadiness.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

// T3 Connect is not part of this build. The contract-defined cloud and
// self-update RPCs stay registered so the WS method registry is complete, and
// report themselves as unavailable instead of pretending to work.
const SERVER_SELF_UPDATE_UNAVAILABLE = "This server does not support remote updates.";
const RELAY_CLIENT_UNAVAILABLE_MESSAGE = "This server does not support the relay client.";
const RELAY_CLIENT_UNAVAILABLE_STATUS = {
  status: "unsupported",
  platform: "unsupported",
  arch: "unsupported",
  version: "",
} as const satisfies RelayClientStatus;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const EDITOR_DISCOVERY_TIMEOUT = Duration.seconds(5);
// leave room for catalog setup and the service's structured timeout result
const IMPORT_RPC_ENVELOPE_DEADLINE_MS = ImportSessions.IMPORT_REQUEST_DEADLINE_MS + 30_000;

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  discovery.pipe(
    Effect.timeoutOption(EDITOR_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(() => [])),
  );

interface ImportedThreadShellIndex {
  readonly find: (
    lookup: Omit<ImportSessions.ImportedThreadLookup, "contentHash">,
  ) => ImportSessions.ImportedThreadMatch | null;
  readonly findById: (threadId: ThreadId) => ImportSessions.ImportedThreadMatch | null;
  readonly addThread: (
    thread: OrchestrationShellSnapshot["threads"][number],
    archived: boolean,
  ) => void;
}

function importedSourcePathKey(source: string, sourcePath: string): string {
  return JSON.stringify([source, sourcePath]);
}

function importedNativeSessionKey(
  source: string,
  providerInstanceId: string | null,
  nativeSessionId: string,
): string {
  return JSON.stringify([source, providerInstanceId, nativeSessionId]);
}

function makeImportedThreadShellIndex(
  context: ProjectionSnapshotQuery.ProjectionImportReconciliationContext,
): ImportedThreadShellIndex {
  const bySourcePath = new Map<string, ImportSessions.ImportedThreadMatch>();
  const byNativeSession = new Map<string, ImportSessions.ImportedThreadMatch>();
  const byThreadId = new Map<ThreadId, ImportSessions.ImportedThreadMatch>();
  const projectWorkspaceRoots = new Map(
    context.projects.map((project) => [project.projectId, project.workspaceRoot]),
  );
  const addMatch = (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly modelSelection: OrchestrationThreadDetailSnapshot["thread"]["modelSelection"];
    readonly origin: NonNullable<OrchestrationThreadDetailSnapshot["thread"]["origin"]>;
    readonly archived: boolean;
  }) => {
    const workspaceRoot = projectWorkspaceRoots.get(thread.projectId);
    const match = {
      threadId: thread.id,
      projectId: thread.projectId,
      contentHash: thread.origin.contentHash,
      source: thread.origin.source,
      sourcePath: thread.origin.sourcePath,
      nativeSessionId: thread.origin.nativeSessionId,
      providerInstanceId: thread.origin.providerInstanceId,
      modelSelection: thread.modelSelection,
      archived: thread.archived,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(thread.origin.originalWorkspaceRoot === undefined
        ? {}
        : { originalWorkspaceRoot: thread.origin.originalWorkspaceRoot }),
    } satisfies ImportSessions.ImportedThreadMatch;
    byThreadId.set(thread.id, match);
    const sourcePathKey = importedSourcePathKey(thread.origin.source, thread.origin.sourcePath);
    if (!bySourcePath.has(sourcePathKey)) {
      bySourcePath.set(sourcePathKey, match);
    }
    if (thread.origin.nativeSessionId !== null) {
      const nativeSessionKey = importedNativeSessionKey(
        thread.origin.source,
        thread.origin.providerInstanceId,
        thread.origin.nativeSessionId,
      );
      if (!byNativeSession.has(nativeSessionKey)) {
        byNativeSession.set(nativeSessionKey, match);
      }
    }
  };
  const addThread: ImportedThreadShellIndex["addThread"] = (thread, archived) => {
    if (thread.origin === null) {
      return;
    }
    addMatch({
      id: thread.id,
      projectId: thread.projectId,
      modelSelection: thread.modelSelection,
      origin: thread.origin,
      archived,
    });
  };
  for (const thread of context.threads) {
    if (!thread.archived) {
      addMatch({
        id: thread.threadId,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        origin: thread.origin,
        archived: false,
      });
    }
  }
  for (const thread of context.threads) {
    if (thread.archived) {
      addMatch({
        id: thread.threadId,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        origin: thread.origin,
        archived: true,
      });
    }
  }
  return {
    addThread,
    findById: (threadId) => byThreadId.get(threadId) ?? null,
    find: (lookup) =>
      bySourcePath.get(importedSourcePathKey(lookup.source, lookup.sourcePath)) ??
      (lookup.nativeSessionId === null
        ? null
        : (byNativeSession.get(
            importedNativeSessionKey(
              lookup.source,
              lookup.providerInstanceId,
              lookup.nativeSessionId,
            ),
          ) ?? null)),
  };
}

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.provider-switched"
      | "thread.handoff-cleared";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set" ||
    event.type === "thread.provider-switched" ||
    event.type === "thread.handoff-cleared"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// when a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh snapshot
// instead. this keeps both shell refetches and per-thread global event scans
// bounded by the event store's default page size.
// matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const RESUME_MAX_EVENT_GAP = 1_000;

const RPC_REQUIRED_SCOPE = new Map<string, AuthEnvironmentScope>([
  [ORCHESTRATION_WS_METHODS.dispatchCommand, AuthOrchestrationOperateScope],
  [ORCHESTRATION_WS_METHODS.importScan, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.importSessions, AuthOrchestrationOperateScope],
  [ORCHESTRATION_WS_METHODS.getTurnDiff, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.subscribeShell, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot, AuthOrchestrationReadScope],
  [ORCHESTRATION_WS_METHODS.subscribeThread, AuthOrchestrationReadScope],
  [WS_METHODS.serverProbe, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetConfig, AuthOrchestrationReadScope],
  [WS_METHODS.serverRefreshProviders, AuthOrchestrationOperateScope],
  [WS_METHODS.serverUpdateProvider, AuthOrchestrationOperateScope],
  [WS_METHODS.serverUpdateServer, AuthOrchestrationOperateScope],
  [WS_METHODS.serverUpsertKeybinding, AuthOrchestrationOperateScope],
  [WS_METHODS.serverRemoveKeybinding, AuthOrchestrationOperateScope],
  [WS_METHODS.serverGetSettings, AuthOrchestrationReadScope],
  [WS_METHODS.serverUpdateSettings, AuthOrchestrationOperateScope],
  [WS_METHODS.serverDiscoverSourceControl, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetTraceDiagnostics, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetProcessDiagnostics, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetProcessResourceHistory, AuthOrchestrationReadScope],
  [WS_METHODS.serverSignalProcess, AuthOrchestrationOperateScope],
  [WS_METHODS.workersList, AuthOrchestrationReadScope],
  [WS_METHODS.workersReadiness, AuthOrchestrationReadScope],
  [WS_METHODS.workersListRuns, AuthOrchestrationReadScope],
  [WS_METHODS.workersGetJob, AuthOrchestrationReadScope],
  [WS_METHODS.workersGetRun, AuthOrchestrationReadScope],
  [WS_METHODS.workersSubscribe, AuthOrchestrationReadScope],
  [WS_METHODS.cloudGetRelayClientStatus, AuthRelayWriteScope],
  [WS_METHODS.cloudInstallRelayClient, AuthRelayWriteScope],
  [WS_METHODS.sourceControlLookupRepository, AuthOrchestrationReadScope],
  [WS_METHODS.sourceControlCloneRepository, AuthOrchestrationOperateScope],
  [WS_METHODS.sourceControlPublishRepository, AuthOrchestrationOperateScope],
  [WS_METHODS.projectsListEntries, AuthOrchestrationReadScope],
  [WS_METHODS.projectsReadFile, AuthOrchestrationReadScope],
  [WS_METHODS.projectsReadMdxDocument, AuthOrchestrationReadScope],
  [WS_METHODS.projectsSearchEntries, AuthOrchestrationReadScope],
  [WS_METHODS.projectsWriteFile, AuthOrchestrationOperateScope],
  [WS_METHODS.proposalsList, AuthOrchestrationReadScope],
  [WS_METHODS.proposalsGet, AuthOrchestrationReadScope],
  [WS_METHODS.proposalsDiff, AuthOrchestrationReadScope],
  [WS_METHODS.proposalsNarrative, AuthOrchestrationReadScope],
  [WS_METHODS.proposalsFindByPlan, AuthOrchestrationReadScope],
  [WS_METHODS.proposalsStartGeneration, AuthOrchestrationOperateScope],
  [WS_METHODS.proposalsGetGeneration, AuthOrchestrationReadScope],
  [WS_METHODS.proposalsLatestGeneration, AuthOrchestrationReadScope],
  [WS_METHODS.proposalsLatestImplementationAttempt, AuthOrchestrationReadScope],
  [WS_METHODS.cartographerIssueEmbed, AuthOrchestrationOperateScope],
  [WS_METHODS.cartographerCloseEmbed, AuthOrchestrationOperateScope],
  [WS_METHODS.shellOpenInEditor, AuthOrchestrationOperateScope],
  [WS_METHODS.filesystemBrowse, AuthOrchestrationReadScope],
  [WS_METHODS.assetsCreateUrl, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeVcsStatus, AuthOrchestrationReadScope],
  [WS_METHODS.vcsRefreshStatus, AuthOrchestrationReadScope],
  [WS_METHODS.vcsPull, AuthOrchestrationOperateScope],
  [WS_METHODS.gitRunStackedAction, AuthOrchestrationOperateScope],
  [WS_METHODS.gitResolvePullRequest, AuthOrchestrationOperateScope],
  [WS_METHODS.gitPreparePullRequestThread, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsListRefs, AuthOrchestrationReadScope],
  [WS_METHODS.vcsCreateWorktree, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsRemoveWorktree, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsCreateRef, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsSwitchRef, AuthOrchestrationOperateScope],
  [WS_METHODS.vcsInit, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewGetDiffPreview, AuthReviewWriteScope],
  [WS_METHODS.terminalOpen, AuthTerminalOperateScope],
  [WS_METHODS.terminalAttach, AuthTerminalOperateScope],
  [WS_METHODS.terminalWrite, AuthTerminalOperateScope],
  [WS_METHODS.terminalResize, AuthTerminalOperateScope],
  [WS_METHODS.terminalClear, AuthTerminalOperateScope],
  [WS_METHODS.terminalRestart, AuthTerminalOperateScope],
  [WS_METHODS.terminalClose, AuthTerminalOperateScope],
  [WS_METHODS.subscribeTerminalEvents, AuthTerminalOperateScope],
  [WS_METHODS.subscribeTerminalMetadata, AuthTerminalOperateScope],
  [WS_METHODS.previewOpen, AuthOrchestrationOperateScope],
  [WS_METHODS.previewNavigate, AuthOrchestrationOperateScope],
  [WS_METHODS.previewResize, AuthOrchestrationOperateScope],
  [WS_METHODS.previewRefresh, AuthOrchestrationOperateScope],
  [WS_METHODS.previewClose, AuthOrchestrationOperateScope],
  [WS_METHODS.previewList, AuthOrchestrationReadScope],
  [WS_METHODS.previewReportStatus, AuthOrchestrationOperateScope],
  [WS_METHODS.previewAutomationConnect, AuthOrchestrationOperateScope],
  [WS_METHODS.previewAutomationRespond, AuthOrchestrationOperateScope],
  [WS_METHODS.previewAutomationFocusHost, AuthOrchestrationOperateScope],
  [WS_METHODS.subscribePreviewEvents, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeDiscoveredLocalServers, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeServerConfig, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeServerLifecycle, AuthOrchestrationReadScope],
  [WS_METHODS.subscribeAuthAccess, AuthAccessReadScope],
]);

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  cartographerEmbedBroker: CartographerEmbedBroker.CartographerEmbedBroker["Service"],
  authenticatedOrigin: string | undefined,
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const crypto = yield* Crypto.Crypto;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const path = yield* Path.Path;
      const proposalService = yield* ProposalService.ProposalService;
      const proposalGenerationService = yield* ProposalGenerationService.ProposalGenerationService;
      const proposalImplementationAttemptService =
        yield* ProposalImplementationAttemptService.ProposalImplementationAttemptService;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.automaticGitFetchInterval),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const workerBrokerStore = yield* WorkerBrokerStore.WorkerBrokerStore;
      const workersStatusBroadcaster = yield* WorkersStatusBroadcaster.WorkersStatusBroadcaster;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const requiredScopeForMethod = (method: string): AuthEnvironmentScope => {
        const requiredScope = RPC_REQUIRED_SCOPE.get(method);
        if (requiredScope === undefined) {
          throw new Error(`RPC method ${method} has no declared authorization scope.`);
        }
        return requiredScope;
      };
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForMethod(method), effect),
          traceAttributes,
        );
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

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
        );

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
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
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectUpsertOrRemove(event.payload.projectId, event.sequence);
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return threadUpsertOrRemove(event.payload.threadId, event.sequence);
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
        }
      };

      // Coalescing makes each projection read represent every event for that
      // aggregate in the current window. Retry a typed persistence failure once
      // so a brief read failure cannot strand the shell at its previous state.
      // If both attempts fail, log and drop the stream item; treating an error as
      // a missing row would incorrectly remove a still-active aggregate.
      const retryShellProjectionRead = <A, E>(
        aggregateKind: "project" | "thread",
        aggregateId: string,
        read: Effect.Effect<A, E>,
      ): Effect.Effect<Option.Option<A>, never, never> =>
        read.pipe(
          Effect.retry({ times: 1 }),
          Effect.map(Option.some),
          Effect.tapError((error) =>
            Effect.logWarning("orchestration shell projection refetch failed", {
              aggregateKind,
              aggregateId,
              error,
            }),
          ),
          Effect.orElseSucceed(() => Option.none()),
        );

      const projectUpsertOrRemove = (
        projectId: ProjectId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "project",
          projectId,
          projectionSnapshotQuery.getProjectShellById(projectId),
        ).pipe(
          Effect.map(
            Option.flatMap((project) =>
              Option.match(project, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-removed" as const,
                    sequence,
                    projectId,
                  }),
                onSome: (nextProject) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-upserted" as const,
                    sequence,
                    project: nextProject,
                  }),
              }),
            ),
          ),
        );

      // Refetch a thread's shell and emit an upsert if it is still active, or a
      // `thread-removed` if the projection has no active row for it. Emitting a
      // removal on a `none` (rather than dropping the event) is what keeps
      // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
      // into a later refetchable event for the same thread, the refetch returns
      // `none` for the now-inactive row and this still tells the sidebar to drop
      // it. A `thread-removed` the client does not have is a harmless no-op. The
      // projection commits in the same transaction before the event publishes,
      // so a `none` reliably means the thread is deleted or archived, not
      // not-yet-persisted.
      const threadUpsertOrRemove = (
        threadId: ThreadId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "thread",
          threadId,
          projectionSnapshotQuery.getThreadShellById(threadId),
        ).pipe(
          Effect.map(
            Option.flatMap((thread) =>
              Option.match(thread, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-removed" as const,
                    sequence,
                    threadId,
                  }),
                onSome: (nextThread) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-upserted" as const,
                    sequence,
                    thread: nextThread,
                  }),
              }),
            ),
          ),
        );

      // Turn a batch of domain events into shell stream items, coalescing by
      // aggregate first. `toShellStreamEvent` re-reads the *current* projected
      // shell for an aggregate, so within a batch only the latest event per
      // aggregate matters: a burst of streaming `thread.message-sent` deltas for
      // one thread collapses into a single shell refetch, and an unrelated
      // `thread.created` in the same batch is never stuck behind those DB reads.
      //
      // Input events arrive in ascending sequence; we keep the last (highest
      // sequence) event per aggregate, then re-sort ascending before emitting so
      // the client — which applies shell items strictly by increasing sequence
      // and drops any `sequence <= snapshotSequence` — never skips a coalesced
      // item. The refetch runs with bounded concurrency (order-preserving).
      const SHELL_REFETCH_CONCURRENCY = 8;
      const coalesceShellEvents = (
        events: ReadonlyArray<OrchestrationEvent>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
        Effect.gen(function* () {
          if (events.length === 0) {
            return [];
          }
          const latestByAggregate = new Map<string, OrchestrationEvent>();
          for (const event of events) {
            latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
          }
          const survivors = Array.from(latestByAggregate.values()).sort(
            (left, right) => left.sequence - right.sequence,
          );
          const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
            concurrency: SHELL_REFETCH_CONCURRENCY,
          });
          return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
        });

      // Small time/size window over which to coalesce shell events. The window
      // bounds the worst-case added latency for a brand-new thread to appear in
      // the sidebar (imperceptible), while collapsing high-frequency streaming
      // traffic so it can't serialize the shell stream behind per-event DB reads.
      const SHELL_COALESCE_WINDOW = Duration.millis(50);
      const SHELL_COALESCE_MAX_CHUNK = 512;
      const coalesceShellStream = <E, R>(
        stream: Stream.Stream<OrchestrationEvent, E, R>,
      ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
        stream.pipe(
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellEvents),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      type ShellLiveInput =
        | { readonly kind: "event"; readonly event: OrchestrationEvent }
        | { readonly kind: "synchronized" };

      // A completion marker is queued alongside raw live events so it cannot
      // overtake an event still waiting in the coalescing window. Split each
      // batch at markers and coalesce only the event segments on either side.
      const coalesceShellLiveInputs = (
        inputs: ReadonlyArray<ShellLiveInput>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
        Effect.gen(function* () {
          const output: Array<OrchestrationShellStreamItem> = [];
          let pendingEvents: Array<OrchestrationEvent> = [];

          for (const input of inputs) {
            if (input.kind === "event") {
              pendingEvents.push(input.event);
              continue;
            }

            output.push(...(yield* coalesceShellEvents(pendingEvents)));
            pendingEvents = [];
            output.push({ kind: "synchronized" });
          }

          output.push(...(yield* coalesceShellEvents(pendingEvents)));
          return output;
        });

      const coalesceShellLiveStream = <E, R>(
        stream: Stream.Stream<ShellLiveInput, E, R>,
      ): Stream.Stream<OrchestrationShellStreamItem, E, R> =>
        stream.pipe(
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellLiveInputs),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    orchestrationEngine.dispatch({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail = projectSetupScriptCompatibilityDetail(input.error);
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
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
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
              if (bootstrap.prepareWorktree.startFromOrigin) {
                yield* gitWorkflow.fetchRemote({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                });
                const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  refName: bootstrap.prepareWorktree.baseBranch,
                  fallbackRemoteName: "origin",
                });
                worktreeBaseRef = resolvedRemoteBase.commitSha;
              }
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: worktreeBaseRef,
                newRefName: bootstrap.prepareWorktree.branch,
                baseRefName: bootstrap.prepareWorktree.baseBranch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const prevalidateImportContinuationProvider = (
        command: ClientOrchestrationCommand,
      ): Effect.Effect<void, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          if (command.type !== "thread.turn.start" || !command.importContinuationConsent) {
            return;
          }
          const consent = command.importContinuationConsent;
          const providers = yield* providerRegistry.getProviders;
          const target = providers.find(
            (provider) => provider.instanceId === consent.targetProviderInstanceId,
          );
          const continuationIdentity = consent.continuation.continuationIdentity;
          if (
            continuationIdentity !== null &&
            target?.driver === consent.driverKind &&
            continuationIdentity.driverKind === consent.driverKind &&
            target.continuation?.groupKey === continuationIdentity.continuationKey
          ) {
            return;
          }
          return yield* new OrchestrationDispatchCommandError({
            message: `Imported continuation provider instance '${consent.targetProviderInstanceId}' no longer resolves to the accepted continuation source.`,
          });
        });

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

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
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              yield* prevalidateImportContinuationProvider(command);
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.orElseSucceed(() => false),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // Coalesce the live shell stream per aggregate over a small window
              // so bursts of high-frequency events (streaming message deltas,
              // activity appends) collapse into a single shell refetch and never
              // serialize a brand-new thread's `thread.created` behind hundreds
              // of per-event DB reads. See coalesceShellStream.
              // Attach live delivery into a scope-bound buffer BEFORE loading any
              // snapshot or draining catch-up, otherwise an event published while
              // the snapshot query is in flight is lost (it is past the snapshot's
              // sequence but the live subscription is not attached yet). Every
              // path below emits from this same buffered live tail. Overlapping
              // events are deduped by sequence on the client.
              const liveBuffer = yield* Queue.unbounded<ShellLiveInput>();
              yield* Effect.forkScoped(
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.runForEach((event) =>
                    Queue.offer(liveBuffer, { kind: "event" as const, event }),
                  ),
                ),
                { startImmediately: true },
              );
              const bufferedLiveStream = coalesceShellLiveStream(Stream.fromQueue(liveBuffer));

              const loadSnapshot = projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              // Offer the completion marker into the same queue as live events.
              // Anything buffered while snapshot/replay work was in flight is
              // therefore delivered before the client is told it is synchronized.
              const synchronizedThenLive =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        Queue.offer(liveBuffer, { kind: "synchronized" as const }).pipe(
                          Effect.andThen(Queue.takeAll(liveBuffer)),
                          Effect.flatMap(coalesceShellLiveInputs),
                        ),
                      ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. If the client is too far
              // behind, we fall back to a fresh snapshot instead of an unbounded
              // replay (see below).
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                // Gap too large: replaying every intervening event (each a shell
                // refetch) is far more expensive than a single O(active-threads)
                // snapshot. A cursor ahead of this engine's authoritative state
                // is also invalid, so reset it with a snapshot. Send the snapshot
                // followed by the buffered live tail, exactly as the
                // no-afterSequence path does.
                if (replayGap < 0 || replayGap > RESUME_MAX_EVENT_GAP) {
                  const snapshot = yield* loadSnapshot;
                  return Stream.concat(
                    Stream.make({ kind: "snapshot" as const, snapshot }),
                    synchronizedThenLive,
                  );
                }
                const catchUpStream = coalesceShellStream(
                  // Replay only through the head captured above. Newer events
                  // are already covered by the live subscription, so this bound
                  // cannot chase a moving event-store head or grow the live
                  // buffer indefinitely while waiting for an empty page.
                  orchestrationEngine.readEvents(afterSequence, replayGap),
                ).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, synchronizedThenLive);
              }

              const snapshot = yield* loadSnapshot;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.importScan]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.importScan,
            Effect.gen(function* () {
              const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const [reconciliationContext, settings] = yield* Effect.all([
                projectionSnapshotQuery.getImportReconciliationContext(),
                serverSettings.getSettings,
              ]);
              const importedThreadIndex = makeImportedThreadShellIndex(reconciliationContext);
              const discovery = yield* ImportDiscovery.make.pipe(
                Effect.provideService(
                  ImportDiscovery.ImportDiscoveryDeps,
                  ImportDiscovery.ImportDiscoveryDeps.of({
                    findImportedThread: (lookup) =>
                      Effect.succeed(importedThreadIndex.find(lookup)),
                    findProjectByWorkspaceRoot: (normalizedRoot) =>
                      Effect.succeed(
                        reconciliationContext.projects.find(
                          (project) => project.workspaceRoot === normalizedRoot,
                        )?.projectId ?? null,
                      ),
                    normalizeWorkspaceRoot: (workspaceRoot) =>
                      workspacePaths.normalizeWorkspaceRoot(workspaceRoot),
                    scanAcpSource: (descriptor) =>
                      scanAcpImportCatalog(descriptor.connection).pipe(
                        Effect.provideService(
                          ChildProcessSpawner.ChildProcessSpawner,
                          childProcessSpawner,
                        ),
                      ),
                  }),
                ),
              );
              return yield* discovery.scan(settings, { cwd: config.cwd });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load session import scan context",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.importSessions]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.importSessions,
            Effect.gen(function* () {
              const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const [providers, settings] = yield* Effect.all([
                providerRegistry.getProviders,
                serverSettings.getSettings,
              ]);
              const requestedSources = new Set(input.items.map((item) => item.source));
              const needsFileCatalog =
                requestedSources.has("codex-cli") ||
                requestedSources.has("claude-code") ||
                requestedSources.has("opencode");
              const needsAcpCatalog =
                requestedSources.has("cursor") || requestedSources.has("grok");
              const [sourceCatalog, acpSourceCatalog] = yield* Effect.all(
                [
                  needsFileCatalog
                    ? resolveSourceCatalog(settings, { cwd: config.cwd })
                    : Effect.succeed({ descriptors: [], errors: [] }),
                  needsAcpCatalog
                    ? resolveAcpImportSourceCatalog(settings, { cwd: config.cwd })
                    : Effect.succeed({ descriptors: [], errors: [] }),
                ],
                { concurrency: "unbounded" },
              );
              const fallbackModelSelection =
                ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection();
              const importedHistoryWorkspaceRoot = path.join(config.stateDir, "imported-history");
              let importReconciliationContext =
                yield* projectionSnapshotQuery.getImportReconciliationContext();
              let importedThreadIndex = makeImportedThreadShellIndex(importReconciliationContext);
              let importedProjectByWorkspaceRoot = new Map(
                importReconciliationContext.projects.map((project) => [
                  project.workspaceRoot,
                  project.projectId,
                ]),
              );
              let importedThreadIndexDirty = false;
              const refreshImportedThreadIndex = Effect.gen(function* () {
                importReconciliationContext =
                  yield* projectionSnapshotQuery.getImportReconciliationContext();
                importedThreadIndex = makeImportedThreadShellIndex(importReconciliationContext);
                importedProjectByWorkspaceRoot = new Map(
                  importReconciliationContext.projects.map((project) => [
                    project.workspaceRoot,
                    project.projectId,
                  ]),
                );
                importedThreadIndexDirty = false;
              });
              const dispatchImportCommand = (command: OrchestrationCommand) =>
                dispatchNormalizedCommand(command).pipe(
                  Effect.tapError(() =>
                    command.type === "project.create" ||
                    command.type === "thread.create" ||
                    command.type === "thread.archive" ||
                    command.type === "thread.delete"
                      ? Effect.sync(() => {
                          importedThreadIndexDirty = true;
                        })
                      : Effect.void,
                  ),
                  Effect.tap(() => {
                    if (command.type === "thread.archive" || command.type === "thread.delete") {
                      return Effect.sync(() => {
                        importedThreadIndexDirty = true;
                      });
                    }
                    if (command.type === "project.create") {
                      return projectionSnapshotQuery.getProjectShellById(command.projectId).pipe(
                        Effect.flatMap(
                          Option.match({
                            onNone: () =>
                              Effect.sync(() => {
                                importedThreadIndexDirty = true;
                              }),
                            onSome: (project) =>
                              Effect.sync(() => {
                                importedProjectByWorkspaceRoot.set(
                                  project.workspaceRoot,
                                  project.id,
                                );
                              }),
                          }),
                        ),
                        Effect.catch(() =>
                          Effect.sync(() => {
                            importedThreadIndexDirty = true;
                          }),
                        ),
                      );
                    }
                    return command.type === "thread.create"
                      ? projectionSnapshotQuery.getThreadShellById(command.threadId).pipe(
                          Effect.flatMap(
                            Option.match({
                              onNone: () =>
                                Effect.sync(() => {
                                  importedThreadIndexDirty = true;
                                }),
                              onSome: (thread) =>
                                Effect.sync(() => {
                                  importedThreadIndex.addThread(thread, false);
                                }),
                            }),
                          ),
                          Effect.catch(() =>
                            Effect.sync(() => {
                              importedThreadIndexDirty = true;
                            }),
                          ),
                        )
                      : Effect.void;
                  }),
                );
              const importService = yield* ImportSessions.make.pipe(
                Effect.provideService(
                  ImportSessions.ImportServiceDeps,
                  ImportSessions.ImportServiceDeps.of({
                    dispatch: dispatchImportCommand,
                    findThreadByContentHash: (lookup) =>
                      Effect.suspend(() =>
                        importedThreadIndexDirty
                          ? refreshImportedThreadIndex.pipe(
                              Effect.map(() => importedThreadIndex.find(lookup)),
                            )
                          : Effect.succeed(importedThreadIndex.find(lookup)),
                      ),
                    findThreadById: (threadId) =>
                      Effect.suspend(() =>
                        importedThreadIndexDirty
                          ? refreshImportedThreadIndex.pipe(
                              Effect.map(() => importedThreadIndex.findById(threadId)),
                            )
                          : Effect.succeed(importedThreadIndex.findById(threadId)),
                      ),
                    findProjectByWorkspaceRoot: (normalizedRoot) =>
                      Effect.suspend(() =>
                        importedThreadIndexDirty
                          ? refreshImportedThreadIndex.pipe(
                              Effect.map(
                                () => importedProjectByWorkspaceRoot.get(normalizedRoot) ?? null,
                              ),
                            )
                          : Effect.succeed(
                              importedProjectByWorkspaceRoot.get(normalizedRoot) ?? null,
                            ),
                      ),
                    isImportFinalized: (threadId) =>
                      projectionSnapshotQuery.isThreadImportFinalized(threadId),
                    normalizeWorkspaceRoot: (workspaceRoot) =>
                      workspacePaths.normalizeWorkspaceRoot(workspaceRoot),
                    resolveImportWorkspaceRoot: (request) => {
                      if (request.recordedWorkspaceRoot === null) {
                        return workspacePaths
                          .normalizeWorkspaceRoot(importedHistoryWorkspaceRoot, {
                            createIfMissing: true,
                          })
                          .pipe(Effect.map((workspaceRoot) => ({ workspaceRoot })));
                      }
                      if (request.originalWorkspaceRoot !== undefined) {
                        if (request.existingWorkspaceRoot === undefined) {
                          return Effect.fail(
                            new OrchestrationDispatchCommandError({
                              message:
                                "The imported thread project is missing its selected workspace root",
                            }),
                          );
                        }
                        return workspacePaths
                          .normalizeWorkspaceRoot(request.existingWorkspaceRoot)
                          .pipe(
                            Effect.map((workspaceRoot) => ({
                              workspaceRoot,
                              originalWorkspaceRoot: request.originalWorkspaceRoot,
                            })),
                          );
                      }
                      return workspacePaths
                        .normalizeWorkspaceRoot(request.recordedWorkspaceRoot)
                        .pipe(
                          Effect.map((workspaceRoot) => ({ workspaceRoot })),
                          Effect.catchTag("WorkspaceRootNotExistsError", (missingWorkspace) =>
                            workspacePaths
                              .normalizeWorkspaceRoot(importedHistoryWorkspaceRoot, {
                                createIfMissing: true,
                              })
                              .pipe(
                                Effect.map((workspaceRoot) => ({
                                  workspaceRoot,
                                  originalWorkspaceRoot: missingWorkspace.normalizedWorkspaceRoot,
                                })),
                              ),
                          ),
                        );
                    },
                    resolveImportTarget: (driver, requestedInstanceId, compatibleInstanceIds) => {
                      const compatibleIds = new Set(compatibleInstanceIds);
                      const eligibleProviders = providers.filter(
                        (candidate) =>
                          candidate.driver === driver &&
                          compatibleIds.has(candidate.instanceId) &&
                          candidate.enabled &&
                          candidate.installed &&
                          candidate.availability !== "unavailable",
                      );
                      if (requestedInstanceId !== null && !compatibleIds.has(requestedInstanceId)) {
                        return Effect.succeed(null);
                      }
                      const defaultInstanceId = defaultInstanceIdForDriver(driver);
                      const provider =
                        requestedInstanceId === null
                          ? (eligibleProviders.find(
                              (candidate) => candidate.instanceId === defaultInstanceId,
                            ) ?? eligibleProviders[0])
                          : eligibleProviders.find(
                              (candidate) => candidate.instanceId === requestedInstanceId,
                            );
                      if (provider === undefined) return Effect.succeed(null);
                      const model =
                        provider.models.find((candidate) => candidate.isDefault)?.slug ??
                        provider.models[0]?.slug ??
                        DEFAULT_MODEL_BY_PROVIDER[driver] ??
                        fallbackModelSelection.model;
                      return Effect.succeed({
                        defaultModelSelection: {
                          instanceId: provider.instanceId,
                          model,
                        },
                        availableModels: provider.models.map((candidate) => candidate.slug),
                      });
                    },
                    threadExistsInShell: (threadId) =>
                      projectionSnapshotQuery
                        .getThreadShellById(threadId)
                        .pipe(Effect.map(Option.isSome)),
                    fallbackModelSelection,
                    sourceDescriptors: sourceCatalog.descriptors,
                    loadAcpSessionsBatch: ({
                      source,
                      sourcePaths,
                      providerInstanceId,
                      maximumBytes,
                      wireUsage,
                    }) => {
                      const descriptor = acpSourceCatalog.descriptors.find(
                        (candidate) =>
                          candidate.source === source &&
                          candidate.providerInstanceId === providerInstanceId,
                      );
                      if (descriptor === undefined) {
                        const error = new AcpImportError(
                          "invalid-source",
                          `No configured ${source} import source exists for provider instance '${providerInstanceId}'.`,
                        );
                        return Effect.succeed(
                          sourcePaths.map((sourcePath) => ({
                            sourcePath,
                            descriptor: null,
                            session: null,
                            error,
                          })),
                        );
                      }
                      const boundedBytePolicy = partitionAcpImportBytePolicy(
                        maximumBytes,
                        descriptor.connection.policy,
                      );
                      if (boundedBytePolicy === null) {
                        const error = new AcpImportError(
                          "limit-exceeded",
                          `The remaining ACP import byte budget is too small to load provider instance '${providerInstanceId}'.`,
                        );
                        return Effect.succeed(
                          sourcePaths.map((sourcePath) => ({
                            sourcePath,
                            descriptor: null,
                            session: null,
                            error,
                          })),
                        );
                      }
                      return loadAcpImportSessionsBatch(
                        {
                          ...descriptor.connection,
                          policy: {
                            ...descriptor.connection.policy,
                            ...boundedBytePolicy,
                          },
                          wireUsage,
                        },
                        sourcePaths,
                      ).pipe(
                        Effect.provideService(
                          ChildProcessSpawner.ChildProcessSpawner,
                          childProcessSpawner,
                        ),
                      );
                    },
                  }),
                ),
                Effect.provide(ImportContinuationFromContext),
              );
              return yield* importService.importSessions(input);
            }).pipe(
              Effect.timeoutOption(IMPORT_RPC_ENVELOPE_DEADLINE_MS),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new OrchestrationDispatchCommandError({
                        message: `Session import initialization and execution exceeded ${IMPORT_RPC_ENVELOPE_DEADLINE_MS}ms`,
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to initialize session import"),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event: projectActivityEvent(event),
                })),
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
              yield* Effect.forkScoped(
                liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
              );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer);
              const loadSnapshot = projectionSnapshotQuery
                .getThreadDetailSnapshot(input.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );
              const afterCatchUp =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        Queue.offer(liveBuffer, { kind: "synchronized" as const }),
                      ).pipe(Stream.drain),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;
              const snapshotThenLive = (snapshot: OrchestrationThreadDetailSnapshot) =>
                Stream.concat(
                  Stream.make({
                    kind: "snapshot" as const,
                    snapshot: projectThreadDetailSnapshot(snapshot),
                  }),
                  afterCatchUp,
                );

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // Bound the catch-up at the head captured before reading so it
              // cannot chase a moving store. Stale or invalid cursors get a fresh
              // detail snapshot instead of scanning the full global event history.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                if (replayGap < 0 || replayGap > RESUME_MAX_EVENT_GAP) {
                  const snapshot = yield* loadSnapshot;
                  if (Option.isNone(snapshot)) {
                    return yield* new OrchestrationGetSnapshotError({
                      message: `Thread ${input.threadId} was not found`,
                      cause: input.threadId,
                    });
                  }
                  return snapshotThenLive(snapshot.value);
                }
                const catchUpStream = orchestrationEngine.readEvents(afterSequence, replayGap).pipe(
                  Stream.filter(isThisThreadDetailEvent),
                  Stream.map((event) => ({
                    kind: "event" as const,
                    event: projectActivityEvent(event),
                  })),
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to replay thread ${input.threadId} events`,
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, afterCatchUp);
              }

              const snapshot = yield* loadSnapshot;

              if (Option.isNone(snapshot)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }
              return snapshotThenLive(snapshot.value);
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateServer]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateServer,
            Effect.fail(new ServerSelfUpdateError({ reason: SERVER_SELF_UPDATE_UNAVAILABLE })),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings
              .updateSettings(patch)
              .pipe(Effect.map(ServerSettings.redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
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
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.workersList]: (input) =>
          observeRpcEffect(WS_METHODS.workersList, workerBrokerStore.list(input), {
            "rpc.aggregate": "workers",
          }),
        [WS_METHODS.workersReadiness]: (_input) =>
          observeRpcEffect(
            WS_METHODS.workersReadiness,
            workerBrokerStore
              .list({})
              .pipe(Effect.flatMap((snapshot) => readWorkersReadiness(snapshot.stateDir))),
            { "rpc.aggregate": "workers" },
          ),
        [WS_METHODS.workersListRuns]: (input) =>
          observeRpcEffect(WS_METHODS.workersListRuns, workerBrokerStore.listRuns(input), {
            "rpc.aggregate": "workers",
          }),
        [WS_METHODS.workersGetJob]: (input) =>
          observeRpcEffect(WS_METHODS.workersGetJob, workerBrokerStore.getJob(input), {
            "rpc.aggregate": "workers",
          }),
        [WS_METHODS.workersGetRun]: (input) =>
          observeRpcEffect(WS_METHODS.workersGetRun, workerBrokerStore.getRun(input), {
            "rpc.aggregate": "workers",
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(
            WS_METHODS.cloudGetRelayClientStatus,
            Effect.succeed(RELAY_CLIENT_UNAVAILABLE_STATUS),
            {
              "rpc.aggregate": "cloud",
            },
          ),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.fail(
              new RelayClientInstallFailedError({
                reason: "unsupported_platform",
                message: RELAY_CLIENT_UNAVAILABLE_MESSAGE,
              }),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadMdxDocument]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadMdxDocument,
            Effect.gen(function* () {
              const contextNotFound = () =>
                new ProjectReadMdxDocumentError({
                  threadId: input.threadId,
                  relativePath: input.relativePath,
                  failure: "workspace_context_not_found",
                });
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.threadId)
                .pipe(Effect.mapError(() => contextNotFound()));
              if (Option.isNone(thread)) {
                return yield* contextNotFound();
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(Effect.mapError(() => contextNotFound()));
              if (Option.isNone(project)) {
                return yield* contextNotFound();
              }

              const workspaceRoot = thread.value.worktreePath ?? project.value.workspaceRoot;
              return yield* WorkspaceMdxDocument.readWorkspaceMdxDocument({
                ...input,
                workspaceRoot,
              }).pipe(
                Effect.mapError((cause) =>
                  cause._tag === "ProjectReadMdxDocumentError"
                    ? cause
                    : new ProjectReadFileError({
                        cwd: workspaceRoot,
                        relativePath: input.relativePath,
                        ...projectFileFailureContext(cause),
                        cause,
                      }),
                ),
              );
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.proposalsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsList,
            Effect.gen(function* () {
              const environmentId = yield* serverEnvironment.getEnvironmentId;
              if (input.environmentId !== environmentId) {
                return yield* new ProposalError({
                  operation: "WsProposals.list",
                  code: "identity-mismatch",
                  detail: "The requested proposal environment does not match this server.",
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(input.projectId)
                .pipe(
                  Effect.mapError(
                    () =>
                      new ProposalError({
                        operation: "WsProposals.list",
                        code: "identity-mismatch",
                        detail: "The requested proposal project could not be verified.",
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new ProposalError({
                  operation: "WsProposals.list",
                  code: "identity-mismatch",
                  detail: "The requested proposal project was not found.",
                });
              }
              if (input.sourceThreadId !== undefined) {
                const thread = yield* projectionSnapshotQuery
                  .getThreadShellById(input.sourceThreadId)
                  .pipe(
                    Effect.mapError(
                      () =>
                        new ProposalError({
                          operation: "WsProposals.list",
                          code: "identity-mismatch",
                          detail: "The requested proposal thread could not be verified.",
                        }),
                    ),
                  );
                if (Option.isNone(thread) || thread.value.projectId !== input.projectId) {
                  return yield* new ProposalError({
                    operation: "WsProposals.list",
                    code: "identity-mismatch",
                    detail: "The requested proposal thread does not belong to this project.",
                  });
                }
              }
              return yield* proposalService.list(input);
            }),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.proposalsGet]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsGet,
            Effect.gen(function* () {
              const selected = yield* proposalService.get(input);
              const environmentId = yield* serverEnvironment.getEnvironmentId;
              if (selected.proposal.environmentId !== environmentId) {
                return yield* new ProposalError({
                  operation: "WsProposals.get",
                  code: "identity-mismatch",
                  detail: "The proposal does not belong to this server environment.",
                  proposalId: input.proposalId,
                });
              }
              return selected;
            }),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.proposalsDiff]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsDiff,
            Effect.gen(function* () {
              const selected = yield* proposalService.get(input);
              const environmentId = yield* serverEnvironment.getEnvironmentId;
              if (selected.proposal.environmentId !== environmentId) {
                return yield* new ProposalError({
                  operation: "WsProposals.diff",
                  code: "identity-mismatch",
                  detail: "The proposal does not belong to this server environment.",
                  proposalId: input.proposalId,
                });
              }
              return yield* proposalService.diff(input);
            }),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.proposalsNarrative]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsNarrative,
            Effect.gen(function* () {
              const selected = yield* proposalService.get(input);
              const environmentId = yield* serverEnvironment.getEnvironmentId;
              if (selected.proposal.environmentId !== environmentId) {
                return yield* new ProposalError({
                  operation: "WsProposals.narrative",
                  code: "identity-mismatch",
                  detail: "The proposal does not belong to this server environment.",
                  proposalId: input.proposalId,
                });
              }
              const narrative = yield* proposalService.narrative(input);
              if (narrative === null) return null;
              const document = yield* WorkspaceMdxDocument.compileSafeDocumentSource({
                threadId: selected.proposal.sourceThreadId,
                relativePath: "proposal-narrative.mdx",
                source: narrative.source,
              });
              return {
                proposalId: narrative.proposalId,
                revisionId: narrative.revisionId,
                revision: narrative.revision,
                sourceSha256: narrative.sourceSha256,
                document,
              };
            }),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.proposalsFindByPlan]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsFindByPlan,
            Effect.gen(function* () {
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.sourceThreadId)
                .pipe(
                  Effect.mapError(
                    () =>
                      new ProposalError({
                        operation: "WsProposals.findByPlan",
                        code: "identity-mismatch",
                        detail: "The proposal source thread could not be verified.",
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new ProposalError({
                  operation: "WsProposals.findByPlan",
                  code: "identity-mismatch",
                  detail: "The proposal source thread was not found.",
                });
              }
              const linked = yield* proposalService.findLatestByPlan(input);
              if (linked === null) return null;
              const environmentId = yield* serverEnvironment.getEnvironmentId;
              if (
                linked.proposal.environmentId !== environmentId ||
                linked.proposal.projectId !== thread.value.projectId
              ) {
                return yield* new ProposalError({
                  operation: "WsProposals.findByPlan",
                  code: "identity-mismatch",
                  detail: "The linked proposal is outside the authenticated thread scope.",
                  proposalId: linked.proposal.proposalId,
                });
              }
              return linked;
            }),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.proposalsStartGeneration]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsStartGeneration,
            Effect.gen(function* () {
              const thread = yield* projectionSnapshotQuery.getThreadShellById(input.threadId).pipe(
                Effect.mapError(
                  () =>
                    new ProposalError({
                      operation: "WsProposals.startGeneration",
                      code: "identity-mismatch",
                      detail: "The proposal thread could not be verified.",
                      proposalId: input.proposalId,
                    }),
                ),
              );
              const selected = yield* proposalService.get({
                proposalId: input.proposalId,
                ...(input.revision === undefined ? {} : { revision: input.revision }),
              });
              const environmentId = yield* serverEnvironment.getEnvironmentId;
              if (
                Option.isNone(thread) ||
                selected.proposal.environmentId !== environmentId ||
                selected.proposal.projectId !== thread.value.projectId ||
                selected.proposal.sourceThreadId !== input.threadId
              ) {
                return yield* new ProposalError({
                  operation: "WsProposals.startGeneration",
                  code: "identity-mismatch",
                  detail: "The proposal revision is outside the authenticated thread scope.",
                  proposalId: input.proposalId,
                });
              }
              return yield* proposalGenerationService.start(input);
            }),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.proposalsGetGeneration]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsGetGeneration,
            proposalGenerationService.get(input),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.proposalsLatestGeneration]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsLatestGeneration,
            proposalGenerationService.latest(input),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.proposalsLatestImplementationAttempt]: (input) =>
          observeRpcEffect(
            WS_METHODS.proposalsLatestImplementationAttempt,
            Effect.gen(function* () {
              const selected = yield* proposalService.get({
                proposalId: input.proposalId,
                ...(input.revision === undefined ? {} : { revision: input.revision }),
              });
              const environmentId = yield* serverEnvironment.getEnvironmentId;
              if (
                selected.proposal.environmentId !== environmentId ||
                selected.proposal.sourceThreadId !== input.sourceThreadId
              ) {
                return yield* new ProposalError({
                  operation: "WsProposals.latestImplementationAttempt",
                  code: "identity-mismatch",
                  detail: "The proposal revision is outside the authenticated thread scope.",
                  proposalId: input.proposalId,
                });
              }
              return yield* proposalImplementationAttemptService.latestForProposal(input).pipe(
                Effect.mapError(
                  () =>
                    new ProposalError({
                      operation: "WsProposals.latestImplementationAttempt",
                      code: "persistence-failed",
                      detail: "The proposal implementation status could not be read.",
                      proposalId: input.proposalId,
                    }),
                ),
              );
            }),
            { "rpc.aggregate": "proposal" },
          ),
        [WS_METHODS.cartographerIssueEmbed]: (input) =>
          observeRpcEffect(
            WS_METHODS.cartographerIssueEmbed,
            Effect.gen(function* () {
              if (authenticatedOrigin === undefined || input.parentOrigin !== authenticatedOrigin) {
                return yield* new CartographerEmbedError({
                  failure: "start_failed",
                  message:
                    "The Cartographer parent origin does not match the authenticated client.",
                });
              }
              const contextNotFound = () =>
                new CartographerEmbedError({
                  failure: "workspace_context_not_found" as const,
                  message: "The Cartographer workspace context was not found.",
                });
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.threadId)
                .pipe(Effect.mapError(contextNotFound));
              if (Option.isNone(thread)) {
                return yield* contextNotFound();
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(Effect.mapError(contextNotFound));
              if (Option.isNone(project)) {
                return yield* contextNotFound();
              }
              const generationTarget =
                input.generationId === undefined
                  ? null
                  : yield* proposalGenerationService.resolveEmbedTarget(
                      input.threadId,
                      input.generationId,
                    );
              const workspaceRoot =
                generationTarget === null
                  ? (thread.value.worktreePath ?? project.value.workspaceRoot)
                  : generationTarget.proposedRoot;
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
              });
            }),
            { "rpc.aggregate": "cartographer" },
          ),
        [WS_METHODS.cartographerCloseEmbed]: (input) =>
          observeRpcEffect(
            WS_METHODS.cartographerCloseEmbed,
            Effect.gen(function* () {
              const contextNotFound = () =>
                new CartographerEmbedError({
                  failure: "workspace_context_not_found" as const,
                  message: "The Cartographer workspace context was not found.",
                });
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.threadId)
                .pipe(Effect.mapError(contextNotFound));
              if (Option.isNone(thread)) {
                return yield* contextNotFound();
              }
              yield* cartographerEmbedBroker.releaseSession(input.threadId, input.sessionId);
            }),
            { "rpc.aggregate": "cartographer" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWriteFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              if (input.resource._tag !== "workspace-file") {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.resource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.workersSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.workersSubscribe,
            workersStatusBroadcaster.streamSnapshots(input),
            {
              "rpc.aggregate": "workers",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
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
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
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
            { "rpc.aggregate": "terminal" },
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
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan();
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                });
                yield* portDiscovery.subscribe((servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, { servers, scannedAt });
                  }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const cartographerEmbedBroker = yield* CartographerEmbedBroker.CartographerEmbedBroker;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
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
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
