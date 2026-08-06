// apps/server/src/ws/handlers/previewHandlers.ts
// builds preview websocket rpc handlers from narrow concrete dependencies

import { type DiscoveredLocalServerList, WS_METHODS, type WsRpcGroup } from '@t3tools/contracts'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'

import type * as PreviewAutomationBroker from '../../mcp/PreviewAutomationBroker.ts'
import type * as PreviewManager from '../../preview/Manager.ts'
import type * as PortScanner from '../../preview/PortScanner.ts'
import type { makeRpcAuthorization } from '../rpcAuthorization.ts'

type WsRpcHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>
type PreviewRpcMethod =
  | typeof WS_METHODS.previewOpen
  | typeof WS_METHODS.previewNavigate
  | typeof WS_METHODS.previewResize
  | typeof WS_METHODS.previewRefresh
  | typeof WS_METHODS.previewClose
  | typeof WS_METHODS.previewList
  | typeof WS_METHODS.previewReportStatus
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.previewAutomationRespond
  | typeof WS_METHODS.previewAutomationFocusHost
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
type PreviewRpcHandlers = Pick<WsRpcHandlers, PreviewRpcMethod>

interface PreviewRpcHandlerDependencies
{
  readonly previewManager: PreviewManager.PreviewManager['Service']
  readonly previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker['Service']
  readonly portDiscovery: PortScanner.PortDiscovery['Service']
  readonly observeRpcEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcEffect']
  readonly observeRpcStream: ReturnType<typeof makeRpcAuthorization>['observeRpcStream']
  readonly observeRpcStreamEffect: ReturnType<typeof makeRpcAuthorization>['observeRpcStreamEffect']
}

export function makePreviewRpcHandlers({
  previewManager,
  previewAutomationBroker,
  portDiscovery,
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
}: PreviewRpcHandlerDependencies)
{
  return {
    [WS_METHODS.previewOpen]: (input) =>
      observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
        'rpc.aggregate': 'preview',
      }),
    [WS_METHODS.previewNavigate]: (input) =>
      observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
        'rpc.aggregate': 'preview',
      }),
    [WS_METHODS.previewResize]: (input) =>
      observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
        'rpc.aggregate': 'preview',
      }),
    [WS_METHODS.previewRefresh]: (input) =>
      observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
        'rpc.aggregate': 'preview',
      }),
    [WS_METHODS.previewClose]: (input) =>
      observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
        'rpc.aggregate': 'preview',
      }),
    [WS_METHODS.previewList]: (input) =>
      observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
        'rpc.aggregate': 'preview',
      }),
    [WS_METHODS.previewReportStatus]: (input) =>
      observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
        'rpc.aggregate': 'preview',
      }),
    [WS_METHODS.previewAutomationConnect]: (input) =>
      observeRpcStreamEffect(
        WS_METHODS.previewAutomationConnect,
        previewAutomationBroker.connect(input),
        { 'rpc.aggregate': 'preview-automation' },
      ),
    [WS_METHODS.previewAutomationRespond]: (input) =>
      observeRpcEffect(
        WS_METHODS.previewAutomationRespond,
        previewAutomationBroker.respond(input),
        { 'rpc.aggregate': 'preview-automation' },
      ),
    [WS_METHODS.previewAutomationFocusHost]: (input) =>
      observeRpcEffect(
        WS_METHODS.previewAutomationFocusHost,
        previewAutomationBroker.focusHost(input),
        { 'rpc.aggregate': 'preview-automation' },
      ),
    [WS_METHODS.subscribePreviewEvents]: (_input) =>
      observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
        'rpc.aggregate': 'preview',
      }),
    [WS_METHODS.subscribeDiscoveredLocalServers]: (_input) =>
      observeRpcStream(
        WS_METHODS.subscribeDiscoveredLocalServers,
        Stream.callback<DiscoveredLocalServerList>((queue) =>
          Effect.gen(function* ()
          {
            yield* portDiscovery.retain
            const setupLock = yield* Semaphore.make(1)
            const publishServers = (servers: DiscoveredLocalServerList['servers']) =>
              Effect.gen(function* ()
              {
                const scannedAt = DateTime.formatIso(yield* DateTime.now)
                yield* Queue.offer(queue, { servers, scannedAt })
              })

            yield* setupLock.withPermit(
              Effect.gen(function* ()
              {
                yield* portDiscovery.subscribe((servers) =>
                  setupLock.withPermit(publishServers(servers)),
                )
                yield* publishServers(yield* portDiscovery.scan())
              }),
            )
          }),
        ),
        { 'rpc.aggregate': 'preview' },
      ),
  } satisfies PreviewRpcHandlers
}
