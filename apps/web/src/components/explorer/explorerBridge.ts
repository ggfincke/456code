// apps/web/src/components/explorer/explorerBridge.ts
// validates the isolated cartographer frame message contract

export const CARTOGRAPHER_BRIDGE_VERSION = 1 as const
export const CARTOGRAPHER_BRIDGE_PROTOCOL = 'cartographer.embed' as const

export type CartographerLifecycleState = 'ready' | 'indexing' | 'stale' | 'error' | 'shutdown'

export type CartographerFrameMessage =
  | {
      readonly protocol: typeof CARTOGRAPHER_BRIDGE_PROTOCOL
      readonly version: typeof CARTOGRAPHER_BRIDGE_VERSION
      readonly type: 'lifecycle'
      readonly state: CartographerLifecycleState
      readonly message?: string
    }
  | {
      readonly protocol: typeof CARTOGRAPHER_BRIDGE_PROTOCOL
      readonly version: typeof CARTOGRAPHER_BRIDGE_VERSION
      readonly type: 'selection-changed'
      readonly file: string | null
    }
  | {
      readonly protocol: typeof CARTOGRAPHER_BRIDGE_PROTOCOL
      readonly version: typeof CARTOGRAPHER_BRIDGE_VERSION
      readonly type: 'open-source'
      readonly file: string
      readonly line?: number
    }
  | {
      readonly protocol: typeof CARTOGRAPHER_BRIDGE_PROTOCOL
      readonly version: typeof CARTOGRAPHER_BRIDGE_VERSION
      readonly type: 'fatal-error'
      readonly message: string
    }

export type CartographerHostMessage =
  | {
      readonly protocol: typeof CARTOGRAPHER_BRIDGE_PROTOCOL
      readonly version: typeof CARTOGRAPHER_BRIDGE_VERSION
      readonly type: 'theme-changed'
      readonly theme: 'light' | 'dark'
    }
  | {
      readonly protocol: typeof CARTOGRAPHER_BRIDGE_PROTOCOL
      readonly version: typeof CARTOGRAPHER_BRIDGE_VERSION
      readonly type: 'proposal-generation-changed'
      readonly generationId: string
    }
  | {
      readonly protocol: typeof CARTOGRAPHER_BRIDGE_PROTOCOL
      readonly version: typeof CARTOGRAPHER_BRIDGE_VERSION
      readonly type: 'shutdown'
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSafeWorkspacePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !value.includes('\0') &&
  !value.startsWith('/') &&
  !value.startsWith('\\') &&
  !/^[A-Za-z]:[/\\]/u.test(value) &&
  !value.split(/[\\/]/u).some((segment) => segment === '..')

export function decodeCartographerFrameMessage(value: unknown): CartographerFrameMessage | null
{
  if (
    !isRecord(value) ||
    value.protocol !== CARTOGRAPHER_BRIDGE_PROTOCOL ||
    value.version !== CARTOGRAPHER_BRIDGE_VERSION ||
    typeof value.type !== 'string'
  )
  {
    return null
  }

  switch (value.type)
  {
    case 'lifecycle':
      if (
        value.state !== 'ready' &&
        value.state !== 'indexing' &&
        value.state !== 'stale' &&
        value.state !== 'error' &&
        value.state !== 'shutdown'
      )
      {
        return null
      }
      if (value.message !== undefined && typeof value.message !== 'string')
      {
        return null
      }
      return {
        protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
        version: CARTOGRAPHER_BRIDGE_VERSION,
        type: 'lifecycle',
        state: value.state,
        ...(typeof value.message === 'string' ? { message: value.message.slice(0, 2_000) } : {}),
      }
    case 'selection-changed':
      if (value.file !== null && !isSafeWorkspacePath(value.file))
      {
        return null
      }
      return {
        protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
        version: CARTOGRAPHER_BRIDGE_VERSION,
        type: 'selection-changed',
        file: value.file,
      }
    case 'open-source':
    {
      if (!isSafeWorkspacePath(value.file))
      {
        return null
      }
      const line =
        typeof value.line === 'number' &&
        Number.isSafeInteger(value.line) &&
        value.line >= 1 &&
        value.line <= 2_147_483_647
          ? value.line
          : undefined
      if (value.line !== undefined && line === undefined)
      {
        return null
      }
      return {
        protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
        version: CARTOGRAPHER_BRIDGE_VERSION,
        type: 'open-source',
        file: value.file,
        ...(line === undefined ? {} : { line }),
      }
    }
    case 'fatal-error':
      return typeof value.message === 'string' && value.message.length > 0
        ? {
            protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
            version: CARTOGRAPHER_BRIDGE_VERSION,
            type: 'fatal-error',
            message: value.message.slice(0, 2_000),
          }
        : null
    default:
      return null
  }
}

export function readCartographerFrameMessage(
  event: MessageEvent,
  input: {
    readonly frameWindow: Window | null
    readonly expectedOrigin: string
  },
): CartographerFrameMessage | null
{
  if (event.source !== input.frameWindow || event.origin !== input.expectedOrigin)
  {
    return null
  }
  return decodeCartographerFrameMessage(event.data)
}

export function postCartographerHostMessage(
  frameWindow: Window | null,
  expectedOrigin: string,
  message: CartographerHostMessage,
): boolean
{
  if (!frameWindow || expectedOrigin.length === 0) return false
  try
  {
    frameWindow.postMessage(message, expectedOrigin)
    return true
  }
  catch
  {
    return false
  }
}
