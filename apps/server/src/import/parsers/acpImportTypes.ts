// apps/server/src/import/parsers/acpImportTypes.ts
// shared ACP import types and error class

import type * as EffectAcpClient from 'effect-acp/client'
import type * as EffectAcpSchema from 'effect-acp/schema'
import type { ImportedActivityRecord, ImportedMessageRecord, ImportedRecord } from '../types.ts'

export type AcpImportDriverKind = 'cursor' | 'grok'
export type AcpImportSource = 'cursor-acp' | 'grok-acp'

export interface AcpImportWireUsage
{
  consumedBytes: number
}

export interface AcpImportPolicy
{
  readonly initializeTimeoutMs: number
  readonly authenticateTimeoutMs: number
  readonly listPageTimeoutMs: number
  readonly loadTimeoutMs: number
  readonly shutdownGraceMs: number
  readonly postResponseReplayGraceMs: number
  readonly hangingReplayIdleMs: number
  readonly maxPages: number
  readonly maxSessions: number
  readonly maxCatalogBytes: number
  readonly maxReplayNotificationsPerSession: number
  readonly maxReplayBytesPerSession: number
  readonly maxReplayNotificationsPerConnection: number
  readonly maxReplayBytesPerConnection: number
  readonly maxNormalizedBytesPerConnection: number
  readonly batchLoadTimeoutMs: number
}

export interface AcpImportConnectionOptions
{
  readonly driverKind: AcpImportDriverKind
  readonly providerInstanceId: string
  readonly cwd: string
  readonly binaryPath?: string
  readonly apiEndpoint?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly policy?: Partial<AcpImportPolicy>
  readonly wireUsage?: AcpImportWireUsage
}

export interface AcpImportCatalogEntry
{
  readonly driverKind: AcpImportDriverKind
  readonly providerInstanceId: string
  readonly source: AcpImportSource
  readonly sourcePath: string
  readonly nativeSessionId: string
  readonly cwd: string
  readonly title: string | null
  readonly updatedAt: string | null
}

export interface AcpImportedSessionMeta
{
  readonly source: AcpImportSource
  readonly sourcePath: string
  readonly contentHash: string
  readonly nativeSessionId: string
  readonly cwd: string
  readonly gitBranch: null
  readonly model: string | null
  readonly title: string | null
  readonly firstActivityAt: string | null
  readonly lastActivityAt: string | null
}

/**
 * Intermediate shaped exactly like the shared importer record model except for
 * its ACP-specific source literal. The integration layer can widen ImportSource
 * without making this process-backed catalog depend on shared contract edits.
 */
export interface AcpImportedSession
{
  readonly meta: AcpImportedSessionMeta
  readonly records: ReadonlyArray<ImportedRecord>
  readonly warnings: ReadonlyArray<string>
}

export type AcpImportCatalogLoadResult =
  | {
      readonly descriptor: AcpImportCatalogEntry
      readonly session: AcpImportedSession
      readonly error: null
      readonly consumedWireBytes?: number
    }
  | {
      readonly descriptor: AcpImportCatalogEntry
      readonly session: null
      readonly error: AcpImportError
      readonly consumedWireBytes?: number
    }

export interface AcpImportBatchLoadResult
{
  readonly sourcePath: string
  readonly descriptor: AcpImportCatalogEntry | null
  readonly session: AcpImportedSession | null
  readonly error: AcpImportError | null
  readonly consumedWireBytes?: number
}

export class AcpImportError extends Error
{
  readonly code:
    | 'spawn-failed'
    | 'initialize-failed'
    | 'authenticate-failed'
    | 'unsupported-list'
    | 'unsupported-load'
    | 'list-failed'
    | 'load-failed'
    | 'invalid-pagination'
    | 'invalid-source'
    | 'timeout'
    | 'limit-exceeded'
  override readonly cause: unknown

  constructor(
    code: AcpImportError['code'],
    message: string,
    options?: { readonly cause?: unknown },
  )
  {
    super(message)
    this.name = 'AcpImportError'
    this.code = code
    this.cause = options?.cause
  }
}

export interface ConnectedAcpImportClient
{
  readonly client: EffectAcpClient.AcpClient['Service']
  readonly initializeResult: EffectAcpSchema.InitializeResponse
  readonly policy: AcpImportPolicy
  readonly replayRouter: AcpReplayRouter
}

export interface ReplayCapture
{
  readonly sessionId: string
  readonly notifications: Array<EffectAcpSchema.SessionNotification>
  notificationCount: number
  byteCount: number
  foreignNotificationCount: number
  lastMatchingActivityAtMs: number | undefined
  limitError: AcpImportError | undefined
}

export interface ReplayCaptureSnapshot
{
  readonly notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>
  readonly foreignNotificationCount: number
}

export interface AcpReplayRouter
{
  readonly begin: (sessionId: string) => ReplayCapture
  readonly finish: (capture: ReplayCapture) => ReplayCaptureSnapshot
  readonly abort: (capture: ReplayCapture) => void
  readonly route: (notification: EffectAcpSchema.SessionNotification, nowMs: number) => void
}

export interface MutableToolReplay
{
  readonly sourceIndex: number
  readonly toolCallId: string
  title: string | undefined
  kind: string | undefined
  status: EffectAcpSchema.ToolCallStatus | undefined
  command: string | undefined
  contentTextOutput: string | undefined
  rawInput: unknown
  rawOutput: unknown
  locations: ReadonlyArray<NormalizedToolLocation>
  omittedContentItemCount: number
  omittedLocationCount: number
  attachmentCount: number
}

export interface PendingMessage
{
  readonly role: 'user' | 'assistant'
  readonly messageId: string | null
  readonly sourceIndex: number
  readonly chunks: string[]
}

export interface PendingThought
{
  readonly messageId: string | null
  readonly sourceIndex: number
  readonly chunks: string[]
}

export interface NormalizedToolLocation
{
  readonly path: string
  readonly line?: number
}

export type ReplayRecord =
  Omit<ImportedMessageRecord, 'createdAt'> | Omit<ImportedActivityRecord, 'createdAt'>
