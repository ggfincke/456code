// tests/apps/mobile/lib/projectThreadStartTurn.test.ts
// verify mobile bootstrap turns preserve explicit runtime warning acknowledgements

import { ProjectId, ProviderInstanceId } from '@t3tools/contracts'
import { expect, it, vi } from 'vite-plus/test'

vi.mock('../../../../apps/mobile/src/lib/uuid', () => ({
  uuidv4: () => 'unused-attachment-id',
}))

import { buildProjectThreadStartTurnInput } from '../../../../apps/mobile/src/lib/projectThreadStartTurn'

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
