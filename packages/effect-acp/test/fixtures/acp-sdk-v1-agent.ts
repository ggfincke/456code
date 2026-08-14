// packages/effect-acp/test/fixtures/acp-sdk-v1-agent.ts
// serves deterministic official sdk v1 conformance scenarios over stdio

import * as NodeStream from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { z } from 'zod'

const newSessionId = 'sdk-v1-session::new/opaque'
const storedSessionId = 'sdk-v1-session::stored/opaque'
const toolCallId = 'sdk-v1-tool::opaque/call?one'
const permissionOptionId = 'sdk-v1-permission::opaque/allow?once'
const fixedTimestamp = '2026-08-12T12:00:00.000Z'

interface FixtureSession
{
  readonly sessionId: string
  readonly cwd: string
  active: boolean
  closed: boolean
}

const sessions = new Map<string, FixtureSession>([
  [
    storedSessionId,
    {
      sessionId: storedSessionId,
      cwd: '/tmp/sdk-v1-stored',
      active: false,
      closed: false,
    },
  ],
])
const promptControllers = new Map<string, AbortController>()
let closeCount = 0
let genericCancelCount = 0
let loadReplayCount = 0
let resumeReplayCount = 0
let sessionCancelCount = 0

const waitForAbort = (signal: AbortSignal) =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )

const findPromptText = (prompt: acp.PromptRequest['prompt']) =>
{
  for (const block of prompt)
  {
    if (block.type === 'text')
    {
      return block.text
    }
  }
  return ''
}

const sessionUpdate = (
  client: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate,
  marker?: string,
) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update,
    ...(marker ? { _meta: { fixtureMarker: marker } } : {}),
  })

const fixtureStatus = () => ({
  closeCount,
  deletedSessionIds: [],
  genericCancelCount,
  loadReplayCount,
  resumeReplayCount,
  sessionCancelCount,
  sessions: [...sessions.values()]
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    .map((session) => ({ ...session, updatedAt: fixedTimestamp })),
})

const app = acp
  .agent({ name: 'effect-acp-sdk-v1-conformance' })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: {
        close: {},
        list: {},
        resume: {},
      },
    },
    authMethods: [],
    agentInfo: {
      name: 'effect-acp-sdk-v1-conformance',
      version: '1.3.0',
    },
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) =>
  {
    sessions.set(newSessionId, {
      sessionId: newSessionId,
      cwd: params.cwd,
      active: true,
      closed: false,
    })
    return { sessionId: newSessionId }
  })
  .onRequest(acp.methods.agent.session.resume, ({ params }) =>
  {
    const session = sessions.get(params.sessionId)
    if (!session)
    {
      throw acp.RequestError.invalidParams({ sessionId: params.sessionId })
    }
    session.active = true
    session.closed = false
    return { _meta: { replayedUpdates: resumeReplayCount } }
  })
  .onRequest(acp.methods.agent.session.load, async ({ client, params }) =>
  {
    const session = sessions.get(params.sessionId)
    if (!session)
    {
      throw acp.RequestError.invalidParams({ sessionId: params.sessionId })
    }
    session.active = true
    session.closed = false

    await sessionUpdate(client, params.sessionId, {
      sessionUpdate: 'user_message_chunk',
      messageId: 'sdk-v1-history::user/1',
      content: { type: 'text', text: 'historical user message' },
    })
    loadReplayCount += 1
    await sessionUpdate(client, params.sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'sdk-v1-history::thought/1',
      content: { type: 'text', text: 'historical agent thought' },
    })
    loadReplayCount += 1
    await sessionUpdate(client, params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'sdk-v1-history::agent/1',
      content: { type: 'text', text: 'historical agent message' },
    })
    loadReplayCount += 1

    return { _meta: { replayedUpdates: loadReplayCount } }
  })
  .onRequest(acp.methods.agent.session.list, () => ({
    sessions: [...sessions.values()]
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: `Fixture ${session.sessionId}`,
        updatedAt: fixedTimestamp,
      })),
  }))
  .onRequest(acp.methods.agent.session.close, ({ params }) =>
  {
    const session = sessions.get(params.sessionId)
    if (!session)
    {
      throw acp.RequestError.invalidParams({ sessionId: params.sessionId })
    }
    closeCount += 1
    promptControllers.get(params.sessionId)?.abort('session/close')
    session.active = false
    session.closed = true
    return {}
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ client, params, signal }) =>
  {
    const session = sessions.get(params.sessionId)
    if (!session || !session.active)
    {
      throw acp.RequestError.invalidParams({ sessionId: params.sessionId })
    }

    const promptController = new AbortController()
    promptControllers.set(params.sessionId, promptController)
    const abortFromGenericCancellation = () => promptController.abort(signal.reason)
    signal.addEventListener('abort', abortFromGenericCancellation, { once: true })

    try
    {
      if (findPromptText(params.prompt) === 'wait-for-session-cancel')
      {
        await sessionUpdate(
          client,
          params.sessionId,
          {
            sessionUpdate: 'agent_thought_chunk',
            messageId: 'sdk-v1-message::cancel-ready',
            content: { type: 'text', text: 'waiting for session/cancel' },
          },
          'session-cancel-ready',
        )
        await waitForAbort(promptController.signal)
        return { stopReason: 'cancelled' }
      }

      await sessionUpdate(client, params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'sdk-v1-message::agent/1',
        content: { type: 'text', text: 'deterministic agent message' },
      })
      await sessionUpdate(client, params.sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'sdk-v1-message::thought/1',
        content: { type: 'text', text: 'deterministic agent thought' },
      })
      await sessionUpdate(client, params.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Inspect deterministic fixture',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/tmp/sdk-v1-fixture.txt' },
      })

      const permission = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId,
          title: 'Inspect deterministic fixture',
          kind: 'read',
          status: 'pending',
        },
        options: [
          {
            optionId: permissionOptionId,
            name: 'Allow deterministic fixture',
            kind: 'allow_once',
          },
        ],
      })
      if (
        permission.outcome.outcome !== 'selected' ||
        permission.outcome.optionId !== permissionOptionId
      )
      {
        throw acp.RequestError.internalError({ permissionOutcome: permission.outcome })
      }

      await sessionUpdate(client, params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        rawOutput: { content: 'fixture content' },
      })
      await sessionUpdate(client, params.sessionId, {
        sessionUpdate: 'usage_update',
        used: 13,
        size: 4096,
      })

      return {
        stopReason: 'end_turn',
        usage: {
          totalTokens: 13,
          inputTokens: 8,
          outputTokens: 5,
          thoughtTokens: 2,
        },
      }
    }
    finally
    {
      signal.removeEventListener('abort', abortFromGenericCancellation)
      promptControllers.delete(params.sessionId)
    }
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) =>
  {
    sessionCancelCount += 1
    promptControllers.get(params.sessionId)?.abort('session/cancel')
  })
  .onRequest('x/conformance/status', z.object({}), () => fixtureStatus())
  .onRequest(
    'x/conformance/block',
    z.object({ sessionId: z.string() }),
    async ({ client, params, signal }) =>
    {
      await sessionUpdate(
        client,
        params.sessionId,
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'sdk-v1-message::generic-cancel-ready',
          content: { type: 'text', text: 'waiting for $/cancel_request' },
        },
        'generic-cancel-ready',
      )
      await waitForAbort(signal)
      genericCancelCount += 1
      await sessionUpdate(
        client,
        params.sessionId,
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'sdk-v1-message::generic-cancel-observed',
          content: { type: 'text', text: '$/cancel_request observed' },
        },
        'generic-cancel-observed',
      )
      return { cancelled: true }
    },
  )

const output = NodeStream.Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
const input = NodeStream.Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
const connection = app.connect(acp.ndJsonStream(output, input))

await connection.closed
