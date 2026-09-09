// tests/packages/effect-codex-app-server/schema.test.ts
// verify codex multi-agent and account compatibility across protocol decoders

import { assert, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import * as CodexSchema from 'effect-codex-app-server/schema'

const decodeResumeResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse)
const decodeNamespacedResumeResponse = Schema.decodeUnknownSync(CodexSchema.v2.ThreadResumeResponse)
const decodeReadResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadReadResponse)
const decodeRollbackResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadRollbackResponse)
const decodeForkResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadForkResponse)
const decodeTurnCompleted = Schema.decodeUnknownSync(CodexSchema.V2TurnCompletedNotification)
const decodeAccountResponse = Schema.decodeUnknownSync(CodexSchema.V2GetAccountResponse)

it.each([
  'ServerNotification',
  'V2AccountRateLimitsUpdatedNotification',
  'V2AccountUpdatedNotification',
  'V2GetAccountRateLimitsResponse',
  'V2GetAccountResponse',
] as const)('accepts existing and Codex 0.150 account plans in %s', (namespace) =>
{
  for (const planType of [
    'free',
    'go',
    'plus',
    'pro',
    'prolite',
    'team',
    'self_serve_business_prolite',
    'self_serve_business_usage_based',
    'business',
    'ent26',
    'enterprise_cbp_automation',
    'enterprise_cbp_usage_based',
    'enterprise',
    'edu',
    'edu_plus',
    'edu_pro',
    'unknown',
  ])
  {
    assert.isTrue(Schema.is(CodexSchema[`${namespace}__PlanType`])(planType))
  }
})

it.each([
  'self_serve_business_prolite',
  'ent26',
  'enterprise_cbp_automation',
  'edu_plus',
  'edu_pro',
] as const)('decodes a Codex 0.150 account response with plan %s', (planType) =>
{
  const response = {
    account: { type: 'chatgpt', email: 'user@example.com', planType },
    requiresOpenaiAuth: true,
  } as const
  assert.deepStrictEqual(decodeAccountResponse(response), response)
})

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

it('keeps async questions in live notifications and thread history', () =>
{
  const item = {
    type: 'agentMessage',
    id: 'question-1',
    text: 'Which package?\n- pnpm\n- npm\n\nWhat should it be named?',
    phase: 'final_answer',
    delivery: 'async',
    questions: [
      { title: 'Which package manager?', options: ['pnpm', 'npm'] },
      { title: 'What should it be named?' },
    ],
  } as const
  for (const schema of [
    CodexSchema.ServerNotification__ThreadItem,
    CodexSchema.V2ItemStartedNotification__ThreadItem,
    CodexSchema.V2ItemCompletedNotification__ThreadItem,
    CodexSchema.V2ThreadReadResponse__ThreadItem,
    CodexSchema.V2ThreadResumeResponse__ThreadItem,
  ])
  {
    assert.deepStrictEqual(Schema.decodeUnknownSync(schema)(item), item)
  }
})

it('preserves unknown or malformed async metadata on otherwise valid agent messages', () =>
{
  for (const metadata of [
    { delivery: 'notification', questions: { future: true } },
    { delivery: 'async', questions: [{ title: 42, options: 'free-form' }] },
  ])
  {
    const item = {
      type: 'agentMessage' as const,
      id: `ordinary-${metadata.delivery}`,
      text: 'ordinary assistant text',
      ...metadata,
    }
    for (const schema of [
      CodexSchema.V2ItemCompletedNotification__ThreadItem,
      CodexSchema.V2ThreadReadResponse__ThreadItem,
    ])
    {
      assert.deepStrictEqual(Schema.decodeUnknownSync(schema)(item), item)
    }
  }
})

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

it.each(['rateLimitExceeded', 'misalignmentPolicyViolation'] as const)(
  'decodes %s failures across thread history response namespaces',
  (codexErrorInfo) =>
  {
    const failedThread = {
      cliVersion: '0.151.0',
      createdAt: 0,
      cwd: '/tmp/project',
      ephemeral: false,
      id: 'thread-1',
      modelProvider: 'openai',
      preview: '',
      sessionId: 'session-1',
      source: 'cli',
      status: { type: 'idle' },
      turns: [
        {
          error: {
            codexErrorInfo,
            message: 'The turn stopped.',
          },
          id: 'turn-1',
          items: [],
          status: 'failed',
        },
      ],
      updatedAt: 0,
    } as const

    assert.deepStrictEqual(decodeReadResponse({ thread: failedThread }).thread, failedThread)
    assert.deepStrictEqual(
      decodeResumeResponse({
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        cwd: '/tmp/project',
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        sandbox: { type: 'dangerFullAccess' },
        thread: failedThread,
      }).thread,
      failedThread,
    )
    const resumeResponse = {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      cwd: '/tmp/project',
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      sandbox: { type: 'dangerFullAccess' },
      thread: failedThread,
    } as const
    assert.deepStrictEqual(decodeNamespacedResumeResponse(resumeResponse).thread, failedThread)
    assert.deepStrictEqual(decodeForkResponse(resumeResponse).thread, failedThread)
    assert.deepStrictEqual(decodeRollbackResponse({ thread: failedThread }).thread, failedThread)
    assert.deepStrictEqual(
      decodeTurnCompleted({ threadId: failedThread.id, turn: failedThread.turns[0] }).turn,
      failedThread.turns[0],
    )
  },
)
