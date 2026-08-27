// tests/packages/contracts/providerRuntime.test.ts
// verify provider runtime event behavior

import { describe, expect, it } from 'vite-plus/test'
import * as Schema from 'effect/Schema'

import { ProviderRuntimeEvent } from '../../../packages/contracts/src/providerRuntime.ts'

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent)

describe('ProviderRuntimeEvent', () =>
{
  it('decodes MCP elicitation approvals with persistent decision options', () =>
  {
    const parsed = decodeRuntimeEvent({
      type: 'request.opened',
      eventId: 'event-mcp-elicitation',
      provider: 'codex',
      createdAt: '2026-08-24T00:00:00.000Z',
      threadId: 'thread-1',
      requestId: 'request-safari',
      payload: {
        requestType: 'mcp_elicitation_approval',
        detail: 'Allow ChatGPT to use Safari?',
        appName: 'Safari',
        options: [
          { decision: 'decline', label: 'Decline' },
          { decision: 'acceptAlways', label: 'Always allow Safari' },
          { decision: 'accept', label: 'Approve' },
        ],
      },
    })

    expect(parsed.type).toBe('request.opened')
    if (parsed.type !== 'request.opened')
    {
      throw new Error('expected request.opened')
    }
    expect(parsed.payload).toMatchObject({
      requestType: 'mcp_elicitation_approval',
      appName: 'Safari',
    })
    expect(parsed.payload.options?.[1]).toEqual({
      decision: 'acceptAlways',
      label: 'Always allow Safari',
    })
  })

  it('accepts fork-provided driver kinds as branded slugs', () =>
  {
    const parsed = decodeRuntimeEvent({
      type: 'session.started',
      eventId: 'event-ollama-session',
      provider: 'ollama',
      providerInstanceId: 'ollama_local',
      createdAt: '2026-02-28T00:00:00.000Z',
      threadId: 'thread-1',
      payload: {
        message: 'started',
      },
    })

    expect(parsed.provider).toBe('ollama')
    expect(parsed.providerInstanceId).toBe('ollama_local')
  })

  it('decodes turn.plan.updated for plan rendering', () =>
  {
    const parsed = decodeRuntimeEvent({
      type: 'turn.plan.updated',
      eventId: 'event-1',
      provider: 'claudeAgent',
      sessionId: 'runtime-session-1',
      createdAt: '2026-02-28T00:00:00.000Z',
      threadId: 'thread-1',
      turnId: 'turn-1',
      payload: {
        explanation: 'Implement schema updates',
        plan: [
          { step: 'Define event union', status: 'completed' },
          { step: 'Wire adapter mapping', status: 'inProgress' },
        ],
      },
    })

    expect(parsed.type).toBe('turn.plan.updated')
    if (parsed.type !== 'turn.plan.updated')
    {
      throw new Error('expected turn.plan.updated')
    }
    expect(parsed.payload.plan).toHaveLength(2)
    expect(parsed.payload.plan[1]?.status).toBe('inProgress')
  })

  it('decodes user-input.requested with structured questions', () =>
  {
    const parsed = decodeRuntimeEvent({
      type: 'user-input.requested',
      eventId: 'event-2',
      provider: 'claudeAgent',
      sessionId: 'runtime-session-2',
      createdAt: '2026-02-28T00:00:01.000Z',
      threadId: 'thread-2',
      requestId: 'request-1',
      payload: {
        questions: [
          {
            id: 'sandbox_mode',
            header: 'Sandbox',
            question: 'Which mode should be used?',
            options: [
              {
                label: 'workspace-write',
                description: 'Allow edits in workspace only',
              },
              {
                label: 'danger-full-access',
                description: 'Allow unrestricted access',
              },
            ],
          },
        ],
      },
    })

    expect(parsed.type).toBe('user-input.requested')
    if (parsed.type !== 'user-input.requested')
    {
      throw new Error('expected user-input.requested')
    }
    expect(parsed.payload.questions[0]?.id).toBe('sandbox_mode')
    expect(parsed.payload.questions[0]?.options).toHaveLength(2)
  })

  it('decodes user-input.resolved with answer map', () =>
  {
    const parsed = decodeRuntimeEvent({
      type: 'user-input.resolved',
      eventId: 'event-3',
      provider: 'claudeAgent',
      sessionId: 'runtime-session-2',
      createdAt: '2026-02-28T00:00:02.000Z',
      threadId: 'thread-2',
      requestId: 'request-1',
      payload: {
        answers: {
          sandbox_mode: 'workspace-write',
        },
      },
    })

    expect(parsed.type).toBe('user-input.resolved')
    if (parsed.type !== 'user-input.resolved')
    {
      throw new Error('expected user-input.resolved')
    }
    expect(parsed.payload.answers.sandbox_mode).toBe('workspace-write')
  })

  it('rejects legacy message.delta type', () =>
  {
    expect(() =>
      decodeRuntimeEvent({
        type: 'message.delta',
        eventId: 'event-4',
        provider: 'codex',
        sessionId: 'runtime-session-3',
        createdAt: '2026-02-28T00:00:03.000Z',
        payload: { delta: 'legacy' },
      }),
    ).toThrow()
  })

  it('rejects empty branded canonical ids', () =>
  {
    expect(() =>
      decodeRuntimeEvent({
        type: 'runtime.error',
        eventId: 'event-5',
        provider: 'codex',
        sessionId: 'runtime-session-3',
        createdAt: '2026-02-28T00:00:03.000Z',
        threadId: '   ',
        payload: { message: 'boom' },
      }),
    ).toThrow()
  })
})
