// apps/server/src/ws/handlers/orchestrationImportHandlers.ts
// adapts import websocket rpc calls to the scoped import runtime

import {
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  ORCHESTRATION_WS_METHODS,
  type WsRpcGroup,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import * as ServerConfig from '../../config.ts'
import * as ImportDiscovery from '../../import/discovery/discovery.ts'
import * as ImportService from '../../import/importService.ts'
import * as ServerRuntimeStartup from '../../serverRuntimeStartup.ts'
import type * as ServerSettings from '../../serverSettings.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'

type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>
type ImportRpcHandlers = Pick<
  WsRpcHandlers,
  typeof ORCHESTRATION_WS_METHODS.importScan | typeof ORCHESTRATION_WS_METHODS.importSessions
>

export interface OrchestrationImportHandlerDependencies
{
  readonly config: ServerConfig.ServerConfig['Service']
  readonly importDiscovery: ImportDiscovery.ImportDiscovery['Service']
  readonly importService: ImportService.ImportService['Service']
  readonly serverSettings: ServerSettings.ServerSettingsService['Service']
  readonly startup: ServerRuntimeStartup.ServerRuntimeStartup['Service']
  readonly toDispatchCommandError: (
    cause: unknown,
    fallbackMessage: string,
  ) => OrchestrationDispatchCommandError
  readonly observeRpcEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcEffect']
}

export const IMPORT_RPC_ENVELOPE_DEADLINE_MS = ImportService.IMPORT_REQUEST_DEADLINE_MS + 30_000

export function makeOrchestrationImportHandlers({
  config,
  importDiscovery,
  importService,
  serverSettings,
  startup,
  toDispatchCommandError,
  observeRpcEffect,
}: OrchestrationImportHandlerDependencies)
{
  return {
    [ORCHESTRATION_WS_METHODS.importScan]: (_input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.importScan,
        serverSettings.getSettings.pipe(
          Effect.flatMap((settings) => importDiscovery.scan(settings, { cwd: config.cwd })),
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: 'Failed to load session import scan context',
                cause,
              }),
          ),
        ),
        { 'rpc.aggregate': 'orchestration' },
      ),
    [ORCHESTRATION_WS_METHODS.importSessions]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.importSessions,
        startup.enqueueCommand(importService.importSessions(input)).pipe(
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
            toDispatchCommandError(cause, 'Failed to initialize session import'),
          ),
        ),
        { 'rpc.aggregate': 'orchestration' },
      ),
  } satisfies ImportRpcHandlers
}
