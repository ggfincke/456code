// packages/client-runtime/src/state/terminalSession.ts
// manage terminal session state

import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from '@t3tools/contracts'

export interface TerminalSessionState
{
  readonly summary: TerminalSummary | null
  readonly buffer: string
  readonly status: TerminalSessionSnapshot['status'] | 'closed'
  readonly error: string | null
  readonly hasRunningSubprocess: boolean
  readonly updatedAt: string | null
  readonly version: number
}

export interface TerminalBufferState
{
  readonly buffer: string
  readonly status: TerminalSessionSnapshot['status'] | 'closed'
  readonly error: string | null
  readonly updatedAt: string | null
  readonly version: number
}

export interface KnownTerminalSessionTarget
{
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly terminalId: string
}

export interface KnownTerminalSession
{
  readonly target: KnownTerminalSessionTarget
  readonly state: TerminalSessionState
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string>
{
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId)
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: '',
  status: 'closed',
  error: null,
  updatedAt: null,
  version: 0,
})

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: '',
  status: 'closed',
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
})

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024
const TERMINAL_BUFFER_CHUNK_BYTES = 16 * 1024
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

interface TerminalBufferEncoding
{
  readonly chunks: ReadonlyArray<Uint8Array>
  readonly byteLength: number
}

const terminalBufferEncodingByState = new WeakMap<TerminalBufferState, TerminalBufferEncoding>()

function trimEncodedBuffer(
  encoding: TerminalBufferEncoding,
  maxBufferBytes: number,
): TerminalBufferEncoding
{
  if (maxBufferBytes <= 0 || encoding.byteLength === 0)
  {
    return { chunks: [], byteLength: 0 }
  }
  if (encoding.byteLength <= maxBufferBytes)
  {
    return encoding
  }

  let remainingDrop = encoding.byteLength - maxBufferBytes
  let chunkIndex = 0
  while (chunkIndex < encoding.chunks.length)
  {
    const chunk = encoding.chunks[chunkIndex]!
    if (remainingDrop < chunk.byteLength)
    {
      break
    }
    remainingDrop -= chunk.byteLength
    chunkIndex += 1
  }

  const chunks = encoding.chunks.slice(chunkIndex)
  const first = chunks[0]
  if (first !== undefined && remainingDrop > 0)
  {
    let start = remainingDrop
    while (start < first.byteLength && (first[start]! & 0b1100_0000) === 0b1000_0000)
    {
      start += 1
    }
    chunks[0] = first.slice(start)
  }

  const retainedChunks = chunks.filter((chunk) => chunk.byteLength > 0)
  return {
    chunks: retainedChunks,
    byteLength: retainedChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  }
}

function appendEncodedBuffer(
  current: TerminalBufferEncoding,
  encoded: Uint8Array,
  maxBufferBytes: number,
): TerminalBufferEncoding
{
  if (encoded.byteLength === 0)
  {
    return trimEncodedBuffer(current, maxBufferBytes)
  }

  const chunks = [...current.chunks]
  const last = chunks.at(-1)
  if (last !== undefined && last.byteLength + encoded.byteLength <= TERMINAL_BUFFER_CHUNK_BYTES)
  {
    const merged = new Uint8Array(last.byteLength + encoded.byteLength)
    merged.set(last)
    merged.set(encoded, last.byteLength)
    chunks[chunks.length - 1] = merged
  }
  else
  {
    chunks.push(encoded)
  }
  return trimEncodedBuffer(
    { chunks, byteLength: current.byteLength + encoded.byteLength },
    maxBufferBytes,
  )
}

function decodeEncodedBuffer(encoding: TerminalBufferEncoding): string
{
  return encoding.chunks.map((chunk) => textDecoder.decode(chunk)).join('')
}

function encodingForState(state: TerminalBufferState): TerminalBufferEncoding
{
  const cached = terminalBufferEncodingByState.get(state)
  if (cached !== undefined)
  {
    return cached
  }
  const encoded = textEncoder.encode(state.buffer)
  const encoding = {
    chunks: encoded.byteLength === 0 ? [] : [encoded],
    byteLength: encoded.byteLength,
  }
  terminalBufferEncodingByState.set(state, encoding)
  return encoding
}

function rememberEncoding(
  state: TerminalBufferState,
  encoding: TerminalBufferEncoding,
): TerminalBufferState
{
  terminalBufferEncodingByState.set(state, encoding)
  return state
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState
{
  const encoded = textEncoder.encode(snapshot.history)
  const sourceEncoding = {
    chunks: encoded.byteLength === 0 ? [] : [encoded],
    byteLength: encoded.byteLength,
  }
  const encoding = trimEncodedBuffer(sourceEncoding, maxBufferBytes)
  return rememberEncoding(
    {
      buffer:
        encoding.byteLength === sourceEncoding.byteLength
          ? snapshot.history
          : decodeEncodedBuffer(encoding),
      status: snapshot.status,
      error: null,
      updatedAt: snapshot.updatedAt,
      version: 1,
    },
    encoding,
  )
}

function latestTimestamp(left: string | null, right: string | null): string | null
{
  if (left === null) return right
  if (right === null) return left
  return Date.parse(left) >= Date.parse(right) ? left : right
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState
{
  return {
    summary,
    buffer: buffer.buffer,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
  }
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState
{
  switch (event.type)
  {
    case 'snapshot':
    case 'restarted':
      return terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes)
    case 'output':
    {
      const currentEncoding = encodingForState(current)
      const encoded = textEncoder.encode(event.data)
      const encoding = appendEncodedBuffer(currentEncoding, encoded, maxBufferBytes)
      return rememberEncoding(
        {
          ...current,
          buffer:
            encoding.byteLength === currentEncoding.byteLength + encoded.byteLength
              ? `${current.buffer}${event.data}`
              : decodeEncodedBuffer(encoding),
          status: current.status === 'closed' ? 'running' : current.status,
          error: null,
          version: current.version + 1,
        },
        encoding,
      )
    }
    case 'cleared':
      return rememberEncoding(
        {
          ...current,
          buffer: '',
          error: null,
          version: current.version + 1,
        },
        { chunks: [], byteLength: 0 },
      )
    case 'exited':
      return rememberEncoding(
        {
          ...current,
          status: 'exited',
          error: null,
          version: current.version + 1,
        },
        encodingForState(current),
      )
    case 'closed':
      return rememberEncoding(
        {
          ...current,
          status: 'closed',
          error: null,
          version: current.version + 1,
        },
        encodingForState(current),
      )
    case 'error':
      return rememberEncoding(
        {
          ...current,
          status: 'error',
          error: event.message,
          version: current.version + 1,
        },
        encodingForState(current),
      )
    case 'activity':
      return current
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary>
{
  if (event.type === 'snapshot')
  {
    return event.terminals
  }
  if (event.type === 'remove')
  {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    )
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  )
  return [...next, event.terminal]
}
