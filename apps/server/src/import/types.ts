// apps/server/src/import/types.ts
// shared transcript import contracts

export type ImportSource = 'codex-cli' | 'claude-code' | 'opencode' | 'cursor' | 'grok'
export interface ImportedMessageRecord
{
  kind: 'message'
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  sourceIndex: number
}
export interface ImportedActivityRecord
{
  kind: 'activity'
  tone: 'info' | 'tool' | 'error'
  activityKind: string
  summary: string
  payload: Record<string, unknown>
  createdAt: string
  sourceIndex: number
}
export type ImportedRecord = ImportedMessageRecord | ImportedActivityRecord
export interface ImportedSessionMeta
{
  source: ImportSource
  sourcePath: string
  contentHash: string
  nativeSessionId: string | null
  cwd: string | null
  gitBranch: string | null
  model: string | null
  title: string | null
  firstActivityAt: string | null
  lastActivityAt: string | null
}
export interface ImportedSession
{
  meta: ImportedSessionMeta
  records: ImportedRecord[]
  warnings: string[]
}
export interface ParseInput
{
  content: string
  sourcePath: string
  contentHash: string
}
