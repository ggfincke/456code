// tests/apps/mobile/lib/projectThreadStartTurn.test.ts
// verify mobile bootstrap turns preserve explicit runtime warning acknowledgements

import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from '@t3tools/contracts'
import { serializeAssistantCitation } from '@t3tools/shared/assistantCitations'
import { expect, it, vi } from 'vite-plus/test'

vi.mock('../../../../apps/mobile/src/lib/uuid', () => ({
  uuidv4: () => 'unused-attachment-id',
}))

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
} from '../../../../apps/mobile/src/lib/projectThreadStartTurn'

it('uses readable citation text for the thread title while preserving the wire prompt', () =>
{
  const citation = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make('source-environment'),
    threadId: ThreadId.make('source-thread'),
    messageId: MessageId.make('source-message'),
    text: 'Keep `cache[key]` shared.',
    comment: 'Why shared?',
    start: 0,
    end: 25,
    prefix: '',
    suffix: '',
  })

  expect(deriveThreadTitleFromPrompt(citation)).toBe(
    'Keep `cache[key]` shared. Comment: Why shared?',
  )
})

it('emits only the acknowledgement supplied after client confirmation', () =>
{
  const input = buildProjectThreadStartTurnInput({
    projectId: ProjectId.make('project-1'),
    projectCwd: '/workspace/project',
    threadId: 'thread-1',
    commandId: 'command-1',
    messageId: 'message-1',
    createdAt: '2026-08-23T12:00:00.000Z',
    text: 'Inspect the repository without changing it.',
    attachments: [],
    modelSelection: {
      instanceId: ProviderInstanceId.make('antigravity'),
      model: 'default',
    },
    runtimeMode: 'full-access',
    runtimeModeAcknowledgements: ['antigravity-full-access-v1'],
    interactionMode: { baseMode: 'default', orchestrate: false },
    workspaceMode: 'local',
    branch: 'main',
    worktreePath: null,
    startFromOrigin: false,
    worktreeBranchName: 'codex/unused',
  })

  expect(input.runtimeModeAcknowledgements).toEqual(['antigravity-full-access-v1'])
})
