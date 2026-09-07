// packages/client-runtime/src/rpc/protocol.ts
// create ws rpc protocol client

import { WsRpcGroup } from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import { RpcClient } from 'effect/unstable/rpc'
import * as RpcMessage from 'effect/unstable/rpc/RpcMessage'

let nextRequestId = 0n

// older servers require string request ids, while newer servers accept either type
export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup, {
  generateRequestId: () => RpcMessage.RequestId(String(nextRequestId++)),
})
type RpcClientFactory = typeof makeWsRpcProtocolClient
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never
