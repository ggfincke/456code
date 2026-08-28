// apps/web/src/types.ts
// defines shared web session, thread, and composer defaults

import type {
  ChatFileAttachment as ContractChatFileAttachment,
  ChatImageAttachment as ContractChatImageAttachment,
  ChatUnknownAttachment as ContractChatUnknownAttachment,
  CollaborationMode,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectScript as ContractProjectScript,
  ProviderInteractionMode,
  RuntimeMode,
} from '@t3tools/contracts'
import {
  ChatFileAttachment as ChatFileAttachmentSchema,
  ChatImageAttachment as ChatImageAttachmentSchema,
  normalizeCollaborationMode,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from '@t3tools/client-runtime/state/shell'

export type SessionPhase = 'disconnected' | 'connecting' | 'ready' | 'running'
export const DEFAULT_RUNTIME_MODE: RuntimeMode = 'full-access'

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = 'default'
export const DEFAULT_COLLABORATION_MODE: CollaborationMode = Object.freeze(
  normalizeCollaborationMode(DEFAULT_INTERACTION_MODE),
)
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280
export const DEFAULT_THREAD_TERMINAL_ID = 'term-1'
export const MAX_TERMINALS_PER_GROUP = 4
export type ProjectScript = ContractProjectScript

export interface ThreadTerminalGroup
{
  id: string
  terminalIds: string[]
  splitDirection?: 'horizontal' | 'vertical'
}

export interface ChatImageAttachment extends ContractChatImageAttachment
{
  readonly previewUrl?: string
}

export interface ChatFileAttachment extends ContractChatFileAttachment
{
  readonly previewUrl?: string
  readonly downloadable?: boolean
}

export type ChatUnknownAttachment = ContractChatUnknownAttachment
export type ChatAttachment = ChatImageAttachment | ChatFileAttachment | ChatUnknownAttachment

export const isImageAttachment: (attachment: ChatAttachment) => attachment is ChatImageAttachment =
  Schema.is(ChatImageAttachmentSchema)
export const isFileAttachment: (attachment: ChatAttachment) => attachment is ChatFileAttachment =
  Schema.is(ChatFileAttachmentSchema)

export interface ChatMessage extends Omit<OrchestrationMessage, 'attachments'>
{
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined
}

export type ProposedPlan = OrchestrationProposedPlan
export type TurnDiffFileChange = OrchestrationCheckpointFile
export type TurnDiffSummary = OrchestrationCheckpointSummary

export type Project = EnvironmentProject
export type Thread = EnvironmentThread
export type ThreadShell = EnvironmentThreadShell

export interface ThreadTurnState
{
  latestTurn: OrchestrationLatestTurn | null
}

export type SidebarThreadSummary = EnvironmentThreadShell
export type ThreadSession = OrchestrationSession
