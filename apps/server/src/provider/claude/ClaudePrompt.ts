// apps/server/src/provider/claude/ClaudePrompt.ts
// builds pure Claude system prompts and user message payloads

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ModelSelection, ProviderInstanceId } from '@t3tools/contracts'
import { isBareProviderSlashCommand } from '@t3tools/shared/composerTrigger'
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionStringOptionValue,
  resolvePromptInjectedEffort,
} from '@t3tools/shared/model'

import { ORCHESTRATE_MODE_INSTRUCTIONS } from '../CollaborationModeInstructions.ts'
import { getClaudeModelCapabilities } from '../Layers/ClaudeProvider.ts'

type ClaudeSystemPrompt = {
  readonly type: 'preset'
  readonly preset: 'claude_code'
  readonly append?: string
}

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export function claudeSystemPrompt(orchestrate: boolean): ClaudeSystemPrompt
{
  // duplicate mode instructions across channels to preserve authority and request boundaries
  return orchestrate
    ? {
        type: 'preset',
        preset: 'claude_code',
        append: ORCHESTRATE_MODE_INSTRUCTIONS,
      }
    : { type: 'preset', preset: 'claude_code' }
}

export function buildPromptText(
  input: {
    readonly input?: string | undefined
    readonly modelSelection?: ModelSelection | undefined
    readonly attachments?: ReadonlyArray<unknown> | undefined
  },
  boundInstanceId: ProviderInstanceId,
): string
{
  const text = input.input?.trim() ?? ''
  if ((input.attachments?.length ?? 0) === 0 && isBareProviderSlashCommand(text))
  {
    return text
  }
  const rawEffort =
    input.modelSelection?.instanceId === boundInstanceId
      ? getModelSelectionStringOptionValue(input.modelSelection, 'effort')
      : null
  const claudeModel =
    input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined
  const caps = getClaudeModelCapabilities(claudeModel)

  const promptEffort = resolvePromptInjectedEffort(caps, rawEffort)
  return applyClaudePromptEffortPrefix(text, promptEffort)
}

export function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>
}): SDKUserMessage
{
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: input.sdkContent as unknown as SDKUserMessage['message']['content'],
    },
  } as SDKUserMessage
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: string
  readonly bytes: Uint8Array
}): Record<string, unknown>
{
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString('base64'),
    },
  }
}

export function isSupportedClaudeImageMimeType(mimeType: string): boolean
{
  return SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(mimeType)
}
