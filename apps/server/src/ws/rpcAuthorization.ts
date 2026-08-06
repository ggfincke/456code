// apps/server/src/ws/rpcAuthorization.ts
// authorize and observe websocket rpc requests

import {
  AuthAccessReadScope,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
  AuthRelayWriteScope,
  type AuthSessionId,
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import type * as EnvironmentAuth from '../auth/EnvironmentAuth.ts'
import type * as PairingGrantStore from '../auth/PairingGrantStore.ts'
import type * as SessionStore from '../auth/SessionStore.ts'
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from '../observability/RpcInstrumentation.ts'

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
  [WS_METHODS.workersSubscribeActivity, AuthOrchestrationReadScope],
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
])

type RpcTraceAttributes = Parameters<typeof instrumentRpcEffect>[2]

export function makeRpcAuthorization(currentSession: EnvironmentAuth.AuthenticatedSession)
{
  const authorizationError = (requiredScope: AuthEnvironmentScope) =>
    new EnvironmentAuthorizationError({
      message: `The authenticated token is missing required scope: ${requiredScope}.`,
      requiredScope,
    })
  const authorizeEffect = <A, E, R>(
    requiredScope: AuthEnvironmentScope,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
    currentSession.scopes.includes(requiredScope)
      ? effect
      : Effect.fail(authorizationError(requiredScope))

  const authorizeStream = <A, E, R>(
    requiredScope: AuthEnvironmentScope,
    stream: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
    currentSession.scopes.includes(requiredScope)
      ? stream
      : Stream.fail(authorizationError(requiredScope))
  const requiredScopeForMethod = (method: string): AuthEnvironmentScope =>
  {
    const requiredScope = RPC_REQUIRED_SCOPE.get(method)
    if (requiredScope === undefined)
    {
      throw new Error(`RPC method ${method} has no declared authorization scope.`)
    }
    return requiredScope
  }

  const observeRpcEffect = <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: RpcTraceAttributes,
  ) =>
    instrumentRpcEffect(
      method,
      authorizeEffect(requiredScopeForMethod(method), effect),
      traceAttributes,
    )

  const observeRpcStream = <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: RpcTraceAttributes,
  ) =>
    instrumentRpcStream(
      method,
      authorizeStream(requiredScopeForMethod(method), stream),
      traceAttributes,
    )

  const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
    method: string,
    effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
    traceAttributes?: RpcTraceAttributes,
  ) =>
    instrumentRpcStreamEffect(
      method,
      authorizeEffect(requiredScopeForMethod(method), effect),
      traceAttributes,
    )

  return {
    observeRpcEffect,
    observeRpcStream,
    observeRpcStreamEffect,
  }
}

export function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent
{
  switch (change.type)
  {
    case 'pairingLinkUpserted':
      return {
        version: 1,
        revision,
        type: 'pairingLinkUpserted',
        payload: change.pairingLink,
      }
    case 'pairingLinkRemoved':
      return {
        version: 1,
        revision,
        type: 'pairingLinkRemoved',
        payload: { id: change.id },
      }
    case 'clientUpserted':
      return {
        version: 1,
        revision,
        type: 'clientUpserted',
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      }
    case 'clientRemoved':
      return {
        version: 1,
        revision,
        type: 'clientRemoved',
        payload: { sessionId: change.sessionId },
      }
  }
}
