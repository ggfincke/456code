// apps/web/src/rpc/requestLatencyState.ts
// manage request latency state

import { useAtomValue } from '@effect/atom-react'
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'

import { appAtomRegistry } from './atomRegistry'

export const SLOW_RPC_ACK_THRESHOLD_MS = 15_000
export const LONG_RUNNING_RPC_ACK_THRESHOLD_MS = 120_000
export const MAX_TRACKED_RPC_ACK_REQUESTS = 256

export interface SlowRpcAckRequest
{
  readonly requestId: string
  readonly startedAt: string
  readonly startedAtMs: number
  readonly tag: string
  readonly thresholdMs: number
}

interface PendingRpcAckRequest
{
  readonly request: SlowRpcAckRequest
  readonly timeoutId: ReturnType<typeof setTimeout>
}

const pendingRpcAckRequests = new Map<string, PendingRpcAckRequest>()
const untrackedRpcAckMethods = [
  WS_METHODS.previewAutomationConnect,
  ORCHESTRATION_WS_METHODS.importSessions,
] as const
const longRunningRpcAckMethods = new Set<string>([
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.serverUpdateServer,
])

const slowRpcAckRequestsAtom = Atom.make<ReadonlyArray<SlowRpcAckRequest>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel('slow-rpc-ack-requests'),
)

function setSlowRpcAckRequests(requests: ReadonlyArray<SlowRpcAckRequest>)
{
  appAtomRegistry.set(slowRpcAckRequestsAtom, [...requests])
}

function getSlowRpcAckRequestsValue(): ReadonlyArray<SlowRpcAckRequest>
{
  return appAtomRegistry.get(slowRpcAckRequestsAtom)
}

function shouldTrackRpcAck(method: string): boolean
{
  return (
    !method.includes('subscribe') &&
    !untrackedRpcAckMethods.some((untrackedMethod) => method === untrackedMethod)
  )
}

function rpcAckThresholdMs(method: string): number
{
  return longRunningRpcAckMethods.has(method)
    ? LONG_RUNNING_RPC_ACK_THRESHOLD_MS
    : SLOW_RPC_ACK_THRESHOLD_MS
}

export function getSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest>
{
  return getSlowRpcAckRequestsValue()
}

// keep method identity separate from the display label so policy checks stay exact
export function trackRpcRequestSent(requestId: string, method: string, tag = method): void
{
  if (!shouldTrackRpcAck(method))
  {
    return
  }

  clearTrackedRpcRequest(requestId)
  evictOldestPendingRpcRequestIfNeeded()

  const startedAtMs = Date.now()
  const thresholdMs = rpcAckThresholdMs(method)
  const request: SlowRpcAckRequest = {
    requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    tag,
    thresholdMs,
  }
  const timeoutId = setTimeout(() =>
  {
    pendingRpcAckRequests.delete(requestId)
    appendSlowRpcAckRequest(request)
  }, thresholdMs)

  pendingRpcAckRequests.set(requestId, {
    request,
    timeoutId,
  })
}

export function acknowledgeRpcRequest(requestId: string): void
{
  clearTrackedRpcRequest(requestId)
  const slowRequests = getSlowRpcAckRequestsValue()
  if (!slowRequests.some((request) => request.requestId === requestId))
  {
    return
  }

  setSlowRpcAckRequests(slowRequests.filter((request) => request.requestId !== requestId))
}

export function clearAllTrackedRpcRequests(): void
{
  for (const pending of pendingRpcAckRequests.values())
  {
    clearTimeout(pending.timeoutId)
  }
  pendingRpcAckRequests.clear()
  setSlowRpcAckRequests([])
}

function clearTrackedRpcRequest(requestId: string): void
{
  const pending = pendingRpcAckRequests.get(requestId)
  if (!pending)
  {
    return
  }

  clearTimeout(pending.timeoutId)
  pendingRpcAckRequests.delete(requestId)
}

function appendSlowRpcAckRequest(request: SlowRpcAckRequest): void
{
  const requests = [...getSlowRpcAckRequestsValue(), request]
  if (requests.length <= MAX_TRACKED_RPC_ACK_REQUESTS)
  {
    setSlowRpcAckRequests(requests)
    return
  }

  setSlowRpcAckRequests(requests.slice(-MAX_TRACKED_RPC_ACK_REQUESTS))
}

function evictOldestPendingRpcRequestIfNeeded(): void
{
  while (pendingRpcAckRequests.size >= MAX_TRACKED_RPC_ACK_REQUESTS)
  {
    const oldestRequestId = pendingRpcAckRequests.keys().next().value
    if (oldestRequestId === undefined)
    {
      return
    }

    clearTrackedRpcRequest(oldestRequestId)
  }
}

export function resetRequestLatencyStateForTests(): void
{
  clearAllTrackedRpcRequests()
}

export function useSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest>
{
  return useAtomValue(slowRpcAckRequestsAtom)
}
