// tests/apps/server/provider/acp/AcpRuntimeModel.test.ts
// verify acp runtime model behavior

import { describe, expect, it } from 'vite-plus/test'

import type * as EffectAcpSchema from 'effect-acp/schema'

import {
  decideToolCallUpdateEmission,
  extractModelConfigId,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
  toolCallProgressLength,
  type AcpToolCallState,
} from '../../../../../apps/server/src/provider/acp/AcpRuntimeModel.ts'

describe('AcpRuntimeModel', () =>
{
  it('parses session mode state from typed ACP session setup responses', () =>
  {
    const modeState = parseSessionModeState({
      sessionId: 'session-1',
      modes: {
        currentModeId: ' code ',
        availableModes: [
          { id: ' ask ', name: ' Ask ', description: ' Request approval ' },
          { id: ' code ', name: ' Code ' },
        ],
      },
      configOptions: [],
    } satisfies EffectAcpSchema.NewSessionResponse)

    expect(modeState).toEqual({
      currentModeId: 'code',
      availableModes: [
        { id: 'ask', name: 'Ask', description: 'Request approval' },
        { id: 'code', name: 'Code' },
      ],
    })
  })

  it('extracts the model config id from typed ACP config options', () =>
  {
    const modelConfigId = extractModelConfigId({
      sessionId: 'session-1',
      configOptions: [
        {
          id: 'approval',
          name: 'Approval Mode',
          category: 'permission',
          type: 'select',
          currentValue: 'ask',
          options: [{ value: 'ask', name: 'Ask' }],
        },
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Auto' }],
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse)

    expect(modelConfigId).toBe('model')
  })

  it('detects Grok session replay updates from _meta.isReplay', () =>
  {
    expect(
      sessionUpdateIsReplay({
        _meta: { isReplay: true },
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed' },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true)
    expect(
      sessionUpdateIsReplay({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'live' },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false)
  })

  it('builds a synthetic load response from initialize model state', () =>
  {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: 'grok-build',
          availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse)

    expect(response.models?.currentModelId).toBe('grok-build')
    expect(response._meta).toMatchObject({ t3SessionLoadReady: 'replay_idle' })
  })

  it('accepts initialize model descriptions with null', () =>
  {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: 'grok-build',
          availableModels: [{ modelId: 'grok-build', name: 'Grok Build', description: null }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse)

    expect(response.models?.availableModels[0]?.description).toBeNull()
  })

  it('ignores malformed initialize model state in synthetic load responses', () =>
  {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: 'grok-build',
          availableModels: [null],
        },
        modeState: {
          currentModeId: 'code',
          availableModes: [{ id: 'code', name: 12 }],
        },
      },
    } as EffectAcpSchema.InitializeResponse)

    expect(response.models).toBeUndefined()
    expect(response.modes).toBeUndefined()
    expect(response._meta).toMatchObject({ t3SessionLoadReady: 'replay_idle' })
  })

  it('builds a synthetic load response with initialize mode state', () =>
  {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: 'code',
          availableModes: [
            { id: 'ask', name: 'Ask' },
            { id: 'code', name: 'Code' },
          ],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse)

    expect(response.modes?.currentModeId).toBe('code')
    expect(response.modes?.availableModes).toHaveLength(2)
  })

  it('projects typed ACP tool call updates into runtime events', () =>
  {
    const created = parseSessionUpdateEvent({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Terminal',
        kind: 'execute',
        status: 'pending',
        rawInput: {
          executable: 'bun',
          args: ['run', 'typecheck'],
        },
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Running checks',
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification)

    expect(created.events).toEqual([
      {
        _tag: 'ToolCallUpdated',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'execute',
          title: 'Ran command',
          status: 'pending',
          command: 'bun run typecheck',
          detail: 'bun run typecheck',
          data: {
            toolCallId: 'tool-1',
            kind: 'execute',
            command: 'bun run typecheck',
            rawInput: {
              executable: 'bun',
              args: ['run', 'typecheck'],
            },
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: 'Running checks',
                },
              },
            ],
          },
        },
        rawPayload: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Terminal',
            kind: 'execute',
            status: 'pending',
            rawInput: {
              executable: 'bun',
              args: ['run', 'typecheck'],
            },
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: 'Running checks',
                },
              },
            ],
          },
        },
      },
    ])

    const updated = parseSessionUpdateEvent({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: { exitCode: 0 },
      },
    } satisfies EffectAcpSchema.SessionNotification)

    expect(updated.events).toHaveLength(1)
    expect(updated.events[0]?._tag).toBe('ToolCallUpdated')
    const createdEvent = created.events[0]
    const updatedEvent = updated.events[0]
    if (createdEvent?._tag === 'ToolCallUpdated' && updatedEvent?._tag === 'ToolCallUpdated')
    {
      expect(mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall)).toMatchObject({
        toolCallId: 'tool-1',
        status: 'completed',
        title: 'Ran command',
        detail: 'bun run typecheck',
        command: 'bun run typecheck',
      })
    }
  })

  it('trims padded current mode updates before emitting a mode change', () =>
  {
    const result = parseSessionUpdateEvent({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: ' code ',
      },
    } satisfies EffectAcpSchema.SessionNotification)

    expect(result.modeId).toBe('code')
    expect(result.events).toEqual([
      {
        _tag: 'ModeChanged',
        modeId: 'code',
      },
    ])
  })

  it('projects typed ACP plan and content updates', () =>
  {
    const planResult = parseSessionUpdateEvent({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: ' Inspect state ', priority: 'high', status: 'completed' },
          { content: '', priority: 'medium', status: 'in_progress' },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification)

    expect(planResult.events).toEqual([
      {
        _tag: 'PlanUpdated',
        payload: {
          plan: [
            { step: 'Inspect state', status: 'completed' },
            { step: 'Step 2', status: 'inProgress' },
          ],
        },
        rawPayload: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: ' Inspect state ', priority: 'high', status: 'completed' },
              { content: '', priority: 'medium', status: 'in_progress' },
            ],
          },
        },
      },
    ])

    const contentResult = parseSessionUpdateEvent({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'hello from acp',
        },
      },
    } satisfies EffectAcpSchema.SessionNotification)

    expect(contentResult.events).toEqual([
      {
        _tag: 'ContentDelta',
        text: 'hello from acp',
        rawPayload: {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'hello from acp',
            },
          },
        },
      },
    ])
  })

  it('keeps permission request parsing compatible with loose extension payloads', () =>
  {
    const request = parsePermissionRequest({
      sessionId: 'session-1',
      options: [
        {
          optionId: 'allow-once',
          name: 'Allow once',
          kind: 'allow_once',
        },
      ],
      toolCall: {
        toolCallId: 'tool-1',
        title: '`cat package.json`',
        kind: 'execute',
        status: 'pending',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Not in allowlist',
            },
          },
        ],
      },
    })

    expect(request).toMatchObject({
      kind: 'execute',
      detail: 'cat package.json',
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'execute',
        status: 'pending',
        command: 'cat package.json',
      },
    })
  })

  it('bounds cumulative tool output and its raw payload to the latest 8,000 characters', () =>
  {
    const hugeText = Array.from(
      { length: 2_000 },
      (_, index) => `line ${index}: ${'x'.repeat(50)}`,
    ).join('\n')
    const rawStdout = `prefix-${'y'.repeat(20_000)}`
    const result = parseSessionUpdateEvent({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        kind: 'other',
        status: 'in_progress',
        rawOutput: { stdout: rawStdout },
        content: [{ type: 'content', content: { type: 'text', text: hugeText } }],
      },
    } satisfies EffectAcpSchema.SessionNotification)

    const event = result.events[0]
    if (event?._tag !== 'ToolCallUpdated')
    {
      throw new Error('expected a ToolCallUpdated event')
    }
    expect(event.toolCall.detail).toHaveLength(8_028)
    expect(event.toolCall.detail?.startsWith('[Earlier output truncated]')).toBe(true)
    expect(event.toolCall.detail?.endsWith(hugeText.slice(-100))).toBe(true)
    const rawOutput = event.toolCall.data.rawOutput as { readonly stdout: string }
    expect(rawOutput.stdout).toHaveLength(8_028)
    expect(rawOutput.stdout.endsWith(rawStdout.slice(-100))).toBe(true)

    const rawUpdate = (
      event.rawPayload as {
        readonly update: {
          readonly content: ReadonlyArray<{ readonly content: { readonly text: string } }>
          readonly rawOutput: { readonly stdout: string }
        }
      }
    ).update
    expect(rawUpdate.content[0]?.content.text).toHaveLength(8_028)
    expect(rawUpdate.rawOutput.stdout).toHaveLength(8_028)
    expect(JSON.stringify(event).length).toBeLessThan(hugeText.length + rawStdout.length)
  })

  it.each([' '.repeat(20_000), `${' '.repeat(12_000)}hello${' '.repeat(12_000)}`])(
    'bounds whitespace-only and padded text in retained content and raw payloads',
    (text) =>
    {
      const { events } = parseSessionUpdateEvent({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text } }],
          rawOutput: { stdout: text },
        },
      })
      const event = events[0]
      if (event?._tag !== 'ToolCallUpdated') throw new Error('expected tool update')
      const content = event.toolCall.data.content as ReadonlyArray<EffectAcpSchema.ToolCallContent>
      const entry = content[0]
      if (entry?.type !== 'content' || entry.content.type !== 'text')
        throw new Error('expected text')
      expect(entry.content.text.length).toBeLessThanOrEqual(8_028)
      if (text.trim()) expect(entry.content.text).toBe('hello')
      const raw = event.rawPayload as {
        update: { content: unknown; rawOutput: { stdout: string } }
      }
      expect(raw.update.content).toEqual(content)
      expect(raw.update.rawOutput.stdout.length).toBeLessThanOrEqual(8_028)
    },
  )

  it('keeps retained text on both sides of interleaved images and diffs', () =>
  {
    const first = 'a'.repeat(7_000)
    const last = 'b'.repeat(3_000)
    const image = {
      type: 'content',
      content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    } as const
    const diff = {
      type: 'diff',
      path: '/repo/file.ts',
      oldText: 'before',
      newText: 'after',
    } as const
    const { events } = parseSessionUpdateEvent({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'in_progress',
        content: [
          { type: 'content', content: { type: 'text', text: first } },
          image,
          diff,
          { type: 'content', content: { type: 'text', text: last } },
        ],
      },
    })
    const event = events[0]
    if (event?._tag !== 'ToolCallUpdated') throw new Error('expected tool update')
    const expected = [
      {
        type: 'content',
        content: { type: 'text', text: `[Earlier output truncated]\n\n${first.slice(-4_999)}` },
      },
      image,
      diff,
      { type: 'content', content: { type: 'text', text: last } },
    ]
    expect(event.toolCall.data.content).toEqual(expected)
    expect((event.rawPayload as { update: { content: unknown } }).update.content).toEqual(expected)
  })

  it('keeps non-text content in order when the retained tail fits the final text entry', () =>
  {
    const hugePrefix = 'x'.repeat(25_000)
    const hugeTail = 'y'.repeat(25_000)
    const result = parseSessionUpdateEvent({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        kind: 'edit',
        status: 'in_progress',
        content: [
          { type: 'content', content: { type: 'text', text: hugePrefix } },
          { type: 'diff', path: '/repo/file.ts', oldText: 'before', newText: 'after' },
          { type: 'content', content: { type: 'text', text: hugeTail } },
          { type: 'diff', path: '/repo/other.ts', oldText: 'old', newText: 'new' },
          { type: 'content', content: { type: 'text', text: '   ' } },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification)

    const event = result.events[0]
    if (event?._tag !== 'ToolCallUpdated')
    {
      throw new Error('expected a ToolCallUpdated event')
    }
    const content = event.toolCall.data.content as ReadonlyArray<EffectAcpSchema.ToolCallContent>
    expect(content).toHaveLength(3)
    expect(content[0]).toMatchObject({ type: 'diff', path: '/repo/file.ts' })
    expect(content[2]).toMatchObject({ type: 'diff', path: '/repo/other.ts' })
    const boundedText = content[1]
    if (boundedText?.type !== 'content' || boundedText.content.type !== 'text')
    {
      throw new Error('expected bounded text content')
    }
    expect(boundedText.content.text).toHaveLength(8_028)
    expect(boundedText.content.text.endsWith(hugeTail.slice(-100))).toBe(true)
  })

  describe('decideToolCallUpdateEmission', () =>
  {
    const toolCall = (
      detail: string | undefined,
      status?: AcpToolCallState['status'],
    ): AcpToolCallState => ({
      toolCallId: 'tool-1',
      title: 'Grok Tool',
      ...(status ? { status } : {}),
      ...(detail ? { detail } : {}),
      data: {},
    })

    it('coalesces small redraws until the tenth skipped update', () =>
    {
      let previous: AcpToolCallState | undefined
      let lastEmittedDetailLength: number | undefined = 0
      let skippedSinceEmit = 0
      const emittedIndices: Array<number> = []

      for (let index = 1; index <= 12; index += 1)
      {
        const next = toolCall('x'.repeat(index), 'inProgress')
        const decision = decideToolCallUpdateEmission({
          previous,
          next,
          lastEmittedDetailLength,
          skippedSinceEmit,
        })
        if (decision.emit)
        {
          emittedIndices.push(index)
          lastEmittedDetailLength = next.detail?.length
        }
        skippedSinceEmit = decision.skippedSinceEmit
        previous = next
      }

      expect(emittedIndices).toEqual([1, 11])
    })

    it('emits meaningful growth and every terminal state immediately', () =>
    {
      expect(
        decideToolCallUpdateEmission({
          previous: toolCall('x', 'inProgress'),
          next: toolCall('x'.repeat(257), 'inProgress'),
          lastEmittedDetailLength: 1,
          skippedSinceEmit: 2,
        }),
      ).toEqual({ emit: true, skippedSinceEmit: 0 })
      expect(
        decideToolCallUpdateEmission({
          previous: toolCall(undefined, 'pending'),
          next: toolCall(undefined, 'inProgress'),
          lastEmittedDetailLength: 0,
          skippedSinceEmit: 0,
        }),
      ).toEqual({ emit: true, skippedSinceEmit: 0 })
      for (const status of ['completed', 'failed'] as const)
      {
        expect(
          decideToolCallUpdateEmission({
            previous: toolCall('same', 'inProgress'),
            next: toolCall('same', status),
            lastEmittedDetailLength: 4,
            skippedSinceEmit: 3,
          }),
        ).toEqual({ emit: true, skippedSinceEmit: 0 })
      }
    })

    it.each(['content', 'rawOutput'] as const)(
      'coalesces changing %s while command detail is fixed',
      (field) =>
      {
        const withOutput = (length: number): AcpToolCallState => ({
          ...toolCall('echo progress', 'inProgress'),
          data:
            field === 'content'
              ? {
                  content: [
                    { type: 'content', content: { type: 'text', text: 'x'.repeat(length) } },
                  ],
                }
              : { rawOutput: { stdout: 'x'.repeat(length) } },
        })
        let previous = withOutput(300)
        let lastEmittedDetailLength = toolCallProgressLength(previous)
        let skippedSinceEmit = 0
        const emitted: number[] = []
        expect(
          decideToolCallUpdateEmission({
            previous,
            next: withOutput(300),
            lastEmittedDetailLength,
            skippedSinceEmit: 9,
          }),
        ).toEqual({ emit: false, skippedSinceEmit: 9 })
        for (const length of [301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 566])
        {
          const next = withOutput(length)
          const decision = decideToolCallUpdateEmission({
            previous,
            next,
            lastEmittedDetailLength,
            skippedSinceEmit,
          })
          if (decision.emit)
          {
            emitted.push(length)
            lastEmittedDetailLength = toolCallProgressLength(next)
          }
          previous = next
          skippedSinceEmit = decision.skippedSinceEmit
        }
        expect(emitted).toEqual([310, 566])
      },
    )
  })
})
