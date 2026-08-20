// tests/apps/server/orchestration/Layers/ProviderRuntimeEventMapping.test.ts
// verifies bounded persistence for streaming provider tool activity

import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { runtimeEventToActivities } from '../../../../../apps/server/src/orchestration/Layers/ProviderRuntimeEventMapping.ts'

const base = {
  provider: ProviderDriverKind.make('codex'),
  createdAt: '2026-08-16T00:00:00.000Z',
  threadId: ThreadId.make('thread-streaming-tool'),
  turnId: TurnId.make('turn-streaming-tool'),
  itemId: RuntimeItemId.make('item-streaming-tool'),
} as const

describe('runtimeEventToActivities tool streaming persistence', () =>
{
  const accumulatedOutput = [
    'first line of output',
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join('\n')
  const streamingData = {
    toolCallId: 'tool-call-1',
    kind: 'execute',
    command: 'blender --render',
    rawOutput: { stderr: accumulatedOutput },
    content: [{ type: 'content', content: { type: 'text', text: accumulatedOutput } }],
    item: {
      aggregatedOutput: accumulatedOutput,
      result: { content: accumulatedOutput },
    },
  }

  it('bounds updates while retaining output summaries and the full terminal completion', () =>
  {
    const update = {
      ...base,
      type: 'item.updated',
      eventId: EventId.make('event-streaming-tool-updated'),
      payload: {
        itemType: 'command_execution',
        status: 'inProgress',
        title: 'Render',
        detail: accumulatedOutput,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent
    const completed = {
      ...base,
      type: 'item.completed',
      eventId: EventId.make('event-streaming-tool-completed'),
      payload: {
        itemType: 'command_execution',
        status: 'completed',
        title: 'Render',
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent

    const updatePayload = runtimeEventToActivities(update)[0]?.payload as Record<string, unknown>
    const updateData = updatePayload.data as Record<string, unknown>
    const updateItem = updateData.item as Record<string, unknown>
    expect(updatePayload.toolCallId).toBe('item-streaming-tool')
    expect(updateData.toolCallId).toBe('tool-call-1')
    expect(updateItem.aggregatedOutput).toBe('first line of output')
    expect(updateItem.result).toEqual({ content: 'first line of output' })
    expect(updateData.rawOutput).toEqual({ content: 'first line of output' })
    expect(updateData.content).toBeUndefined()
    expect(JSON.stringify(updateData).length).toBeLessThan(1_000)

    const mcpUpdate = {
      ...update,
      eventId: EventId.make('event-streaming-mcp-updated'),
      payload: {
        ...update.payload,
        itemType: 'mcp_tool_call',
        data: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-call-1',
            tool: 'render',
            server: 'graphics',
            arguments: { scene: 'demo.blend' },
            result: {
              content: [{ type: 'text', text: accumulatedOutput }],
            },
          },
        },
      },
    } satisfies ProviderRuntimeEvent
    const mcpPayload = runtimeEventToActivities(mcpUpdate)[0]?.payload as Record<string, unknown>
    const mcpData = mcpPayload.data as Record<string, unknown>
    expect(mcpData.item).toMatchObject({
      tool: 'render',
      server: 'graphics',
      result: { content: 'first line of output' },
    })
    expect(JSON.stringify(mcpData).length).toBeLessThan(1_000)

    const completedPayload = runtimeEventToActivities(completed)[0]?.payload as Record<
      string,
      unknown
    >
    expect(completedPayload.toolCallId).toBe('item-streaming-tool')
    expect(completedPayload.data).toEqual(streamingData)

    const started = {
      ...update,
      type: 'item.started',
      eventId: EventId.make('event-streaming-tool-started'),
      payload: { itemType: 'command_execution', title: 'Render' },
    } satisfies ProviderRuntimeEvent
    expect(runtimeEventToActivities(started)[0]?.payload).toMatchObject({
      itemType: 'command_execution',
      toolCallId: 'item-streaming-tool',
      data: { toolCallId: 'item-streaming-tool' },
    })
  })
})
