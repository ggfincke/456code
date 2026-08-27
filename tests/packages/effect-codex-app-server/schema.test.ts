// tests/packages/effect-codex-app-server/schema.test.ts
// verify codex multi-agent compatibility across notification and response decoders

import { assert, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import * as CodexSchema from 'effect-codex-app-server/schema'

const decodeResumeResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse)

const namespaces = [
  'ServerNotification',
  'V2ItemCompletedNotification',
  'V2ItemStartedNotification',
  'V2ReviewStartResponse',
  'V2ThreadForkResponse',
  'V2ThreadListResponse',
  'V2ThreadMetadataUpdateResponse',
  'V2ThreadReadResponse',
  'V2ThreadResumeResponse',
  'V2ThreadRollbackResponse',
  'V2ThreadStartedNotification',
  'V2ThreadStartResponse',
  'V2ThreadUnarchiveResponse',
  'V2TurnCompletedNotification',
  'V2TurnStartedNotification',
  'V2TurnStartResponse',
] as const

it.each(namespaces)('accepts existing and Codex 0.150 multi-agent values in %s', (namespace) =>
{
  for (const tool of [
    'spawnAgent',
    'sendInput',
    'resumeAgent',
    'wait',
    'closeAgent',
    'sendMessage',
    'followupTask',
    'interruptAgent',
    'listAgents',
  ])
  {
    assert.isTrue(Schema.is(CodexSchema[`${namespace}__CollabAgentTool`])(tool))
  }
  for (const status of ['inProgress', 'completed', 'failed', 'interrupted'])
  {
    assert.isTrue(Schema.is(CodexSchema[`${namespace}__CollabAgentToolCallStatus`])(status))
  }
  for (const activity of ['started', 'interacted', 'interrupted', 'completed'])
  {
    assert.isTrue(Schema.is(CodexSchema[`${namespace}__SubAgentActivityKind`])(activity))
  }
})

it('decodes a resumed thread with an interrupted Codex 0.150 follow-up task', () =>
{
  const response = {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    cwd: '/tmp/project',
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    sandbox: { type: 'dangerFullAccess' },
    thread: {
      cliVersion: '0.150.0',
      createdAt: 0,
      cwd: '/tmp/project',
      ephemeral: false,
      id: 'root-thread',
      modelProvider: 'openai',
      preview: '',
      sessionId: 'session-1',
      source: 'cli',
      status: { type: 'idle' },
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          items: [
            {
              agentsStates: {},
              id: 'item-1',
              receiverThreadIds: ['child-thread'],
              senderThreadId: 'root-thread',
              status: 'interrupted',
              tool: 'followupTask',
              type: 'collabAgentToolCall',
            },
          ],
        },
      ],
      updatedAt: 0,
    },
  } as const
  const decoded = decodeResumeResponse(response)
  assert.deepStrictEqual(decoded.thread.turns?.[0]?.items[0], response.thread.turns[0]?.items[0])
})
