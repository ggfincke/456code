// tests/apps/server/import/codexRolloutParser.test.ts
// verifies pure codex rollout transcript parsing
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from 'node:fs'

import { describe, expect, it } from '@effect/vitest'

import { parseCodexRollout } from '../../../../apps/server/src/import/codexRolloutParser.ts'

function fixture(name: string): string
{
  return NodeFS.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

describe('parseCodexRollout', () =>
{
  it('prefers event messages and preserves source order while pairing tools', () =>
  {
    const session = parseCodexRollout({
      content: fixture('codex-rollout-basic.jsonl'),
      sourcePath: '/home/test/.codex/sessions/rollout.jsonl',
      contentHash: 'codex-hash',
    })

    expect(
      session.records.map((record) =>
        record.kind === 'message'
          ? `${record.role}:${record.text}`
          : `${record.activityKind}:${record.summary}`,
      ),
    ).toEqual([
      'user:Fix the parser',
      'task.progress:Inspecting the transcript',
      'tool.completed:exec_command(...)',
      'assistant:The parser is fixed.',
    ])
    expect(session.records.map((record) => record.sourceIndex)).toEqual([3, 4, 5, 7])
    expect(session.records.filter((record) => record.kind === 'message')).toHaveLength(2)
    expect(
      session.records.some(
        (record) =>
          record.kind === 'activity' && typeof record.payload.omittedAttachmentCount === 'number',
      ),
    ).toBe(false)

    const tool = session.records.find(
      (record) => record.kind === 'activity' && record.summary === 'exec_command(...)',
    )
    expect(tool).toMatchObject({
      kind: 'activity',
      payload: {
        itemType: 'command_execution',
        title: 'exec_command',
        status: 'completed',
        detail: 'tests passed',
        data: {
          toolCallId: 'call-1',
          kind: 'execute',
          command: 'vp test',
          rawInput: { cmd: 'vp test' },
          rawOutput: { content: 'tests passed' },
          item: {
            command: 'vp test',
            input: { cmd: 'vp test' },
            result: { content: 'tests passed' },
          },
        },
      },
    })
    expect(
      session.records.find(
        (record) => record.kind === 'activity' && record.activityKind === 'task.progress',
      ),
    ).toMatchObject({
      payload: {
        summary: 'Inspecting the transcript',
        detail: 'Inspecting the transcript\nbefore editing.',
      },
    })

    expect(session.meta).toEqual({
      source: 'codex-cli',
      sourcePath: '/home/test/.codex/sessions/rollout.jsonl',
      contentHash: 'codex-hash',
      nativeSessionId: '019fab93-5678-7abc-8def-0123456789ab',
      cwd: '/workspace/latest',
      gitBranch: 'feature/import',
      model: 'gpt-5.4',
      title: 'Fix the parser',
      firstActivityAt: '2026-01-02T03:04:08.000Z',
      lastActivityAt: '2026-01-02T03:04:12.000Z',
    })
    expect(session.records[0]?.createdAt).toBe('2026-01-02T03:04:08.000Z')
  })

  it('uses the semantic Codex request for the title without removing wrapper messages', () =>
  {
    const nativeSessionId = '019fab93-1234-7abc-8def-1234567890ab'
    const sourcePath =
      `/home/test/.codex/sessions/2026/07/29/` +
      `rollout-2026-07-29T10-00-00-${nativeSessionId}.jsonl`
    const wrapper = [
      '# Files mentioned by the user:',
      '',
      '## My request for Codex:',
      'Import all provider sessions',
    ].join('\n')
    const content = [
      {
        timestamp: '2026-07-29T10:00:00Z',
        type: 'session_meta',
        payload: { id: nativeSessionId, cwd: '/workspace' },
      },
      {
        timestamp: '2026-07-29T10:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<recommended_plugins>' }],
        },
      },
      {
        timestamp: '2026-07-29T10:00:02Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<environment_context>Generated runtime metadata.</environment_context>',
        },
      },
      {
        timestamp: '2026-07-29T10:00:03Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: wrapper },
      },
      {
        timestamp: '2026-07-29T10:00:04Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Imported.' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')

    const session = parseCodexRollout({ content, sourcePath, contentHash: 'title-hash' })

    expect(session.meta.title).toBe('Import all provider sessions')
    expect(
      session.records
        .filter((record) => record.kind === 'message')
        .map((record) => `${record.role}:${record.text}`),
    ).toEqual([
      'user:<recommended_plugins>',
      'user:<environment_context>Generated runtime metadata.</environment_context>',
      `user:${wrapper}`,
      'assistant:Imported.',
    ])
  })

  it('falls back to response_item messages when the event stream has none', () =>
  {
    const session = parseCodexRollout({
      content: fixture('codex-rollout-imported-style.jsonl'),
      sourcePath: '/imported.jsonl',
      contentHash: 'imported-hash',
    })

    expect(session.records).toMatchObject([
      { kind: 'message', role: 'user', text: 'Imported question', sourceIndex: 1 },
      { kind: 'message', role: 'assistant', text: 'Imported answer', sourceIndex: 2 },
    ])
    expect(session.meta.model).toBeNull()
  })

  it('imports the legacy compact dialect without mixing wrapped rollout records', () =>
  {
    const nativeSessionId = 'cdaa53f0-08fe-4544-b9e2-667699bc3a1f'
    const sourcePath =
      `/home/test/.codex/sessions/2025/08/25/` +
      `rollout-2025-08-25T22-17-56-${nativeSessionId}.jsonl`
    const content = [
      {
        id: nativeSessionId,
        timestamp: '2025-08-25T22:17:56.879Z',
        instructions: 'legacy instructions are metadata, not transcript text',
        git: { branch: 'legacy-import' },
      },
      { record_type: 'state' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Import this legacy session' }],
      },
      {
        type: 'function_call',
        name: 'shell',
        call_id: 'legacy-call',
        arguments: '{"command":"vp test"}',
      },
      {
        type: 'function_call_output',
        call_id: 'legacy-call',
        output: 'focused tests passed',
      },
      {
        timestamp: '2025-08-25T22:17:57.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Do not duplicate this hybrid row' }],
        },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Legacy session imported' }],
      },
      { type: 'legacy_unknown', private: 'not retained' },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
    const input = { content, sourcePath, contentHash: 'legacy-compact-hash' }

    const session = parseCodexRollout(input)

    expect(session.meta).toEqual({
      source: 'codex-cli',
      sourcePath,
      contentHash: 'legacy-compact-hash',
      nativeSessionId,
      cwd: null,
      gitBranch: 'legacy-import',
      model: null,
      title: null,
      firstActivityAt: '2025-08-25T22:17:56.879Z',
      lastActivityAt: '2025-08-25T22:17:56.882Z',
    })
    expect(
      session.records.map((record) =>
        record.kind === 'message'
          ? `${record.role}:${record.text}`
          : `${record.activityKind}:${record.summary}`,
      ),
    ).toEqual([
      'user:Import this legacy session',
      'tool.completed:shell(...)',
      'assistant:Legacy session imported',
      'task.completed:Imported with 1 parsing warning',
    ])
    expect(session.records.map((record) => record.sourceIndex)).toEqual([2, 3, 6, 9])
    expect(session.records.map((record) => record.createdAt)).toEqual([
      '2025-08-25T22:17:56.879Z',
      '2025-08-25T22:17:56.880Z',
      '2025-08-25T22:17:56.881Z',
      '2025-08-25T22:17:56.882Z',
    ])
    expect(session.records[1]).toMatchObject({
      kind: 'activity',
      payload: {
        status: 'completed',
        detail: 'focused tests passed',
        data: {
          toolCallId: 'legacy-call',
          command: 'vp test',
          rawOutput: { content: 'focused tests passed' },
        },
      },
    })
    expect(session.warnings).toEqual(['unknown response item type "legacy_unknown" skipped'])
    expect(JSON.stringify(session)).not.toContain('Do not duplicate this hybrid row')
    expect(JSON.stringify(session)).not.toContain('legacy instructions are metadata')
    expect(JSON.stringify(session)).not.toContain('not retained')
    expect(parseCodexRollout(input)).toEqual(session)
  })

  it('keeps canonical rollout identity and metadata when parent metadata is embedded later', () =>
  {
    const childSessionId = '019fab93-1234-7abc-8def-1234567890ab'
    const parentSessionId = '019faacd-fe92-7fe0-a7a8-0bb220c0e893'
    const sourcePath = `/home/test/.codex/sessions/2026/07/28/rollout-2026-07-28T20-00-00-${childSessionId}.jsonl`
    const content = [
      {
        timestamp: '2026-07-28T20:00:00Z',
        type: 'session_meta',
        payload: {
          id: childSessionId,
          cwd: '/workspace/child',
          git: { branch: 'child-branch' },
        },
      },
      {
        timestamp: '2026-07-28T20:00:01Z',
        type: 'session_meta',
        payload: {
          id: parentSessionId,
          cwd: '/workspace/parent',
          git: { branch: 'parent-branch' },
        },
      },
      {
        timestamp: '2026-07-28T20:00:02Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Run the delegated task' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')

    const session = parseCodexRollout({
      content,
      sourcePath,
      contentHash: 'child-agent-rollout-hash',
    })

    expect(session.meta).toMatchObject({
      sourcePath,
      nativeSessionId: childSessionId,
      cwd: '/workspace/child',
      gitBranch: 'child-branch',
    })
    expect(session.warnings).toContain(
      'line 2: session metadata for a different rollout was ignored',
    )
  })

  it('silently omits current Codex developer and system response messages', () =>
  {
    const content = [
      {
        timestamp: '2026-01-01T00:00:00Z',
        type: 'session_meta',
        payload: { id: 'known-system-roles', cwd: '/repo' },
      },
      {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'private developer instructions' }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: 'private system instructions' }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:03Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'unexpected',
          content: [{ type: 'input_text', text: 'invalid role content' }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:04Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'retained user message' }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
    const session = parseCodexRollout({
      content,
      sourcePath: '/known-system-roles.jsonl',
      contentHash: 'known-system-roles-hash',
    })

    expect(JSON.stringify(session.records)).not.toContain('private developer instructions')
    expect(JSON.stringify(session.records)).not.toContain('private system instructions')
    expect(session.warnings).toEqual(['line 4: response message has an invalid role'])
  })

  it('preserves response-only history while deduplicating mixed message streams', () =>
  {
    const session = parseCodexRollout({
      content: fixture('codex-rollout-mixed-stream.jsonl'),
      sourcePath: '/mixed.jsonl',
      contentHash: 'mixed-hash',
    })

    expect(
      session.records.map((record) =>
        record.kind === 'message' ? `${record.role}:${record.text}` : record.summary,
      ),
    ).toEqual([
      'user:Imported prefix question',
      'assistant:Imported prefix answer',
      'user:Continue here',
      'assistant:Live suffix answer',
    ])
    expect(session.records.map((record) => record.sourceIndex)).toEqual([1, 2, 4, 5])
    expect(
      session.records.filter(
        (record) =>
          record.kind === 'message' && record.text.trim().replace(/\s+/g, ' ') === 'Continue here',
      ),
    ).toHaveLength(1)
  })

  it('collapses only adjacent cross-stream message pairs in either order', () =>
  {
    const content = [
      {
        timestamp: '2026-01-01T00:00:00Z',
        type: 'session_meta',
        payload: { id: 'mixed-order', cwd: '/repo' },
      },
      {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Repeat this' },
      },
      {
        timestamp: '2026-01-01T00:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: ' Repeat   this ' }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:03Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Between repeats' },
      },
      {
        timestamp: '2026-01-01T00:00:04Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Repeat this' }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:05Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Event comes second' }],
        },
      },
      {
        timestamp: '2026-01-01T00:00:06Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: ' Event comes second ' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')

    const session = parseCodexRollout({
      content,
      sourcePath: '/mixed-order.jsonl',
      contentHash: 'mixed-order-hash',
    })

    expect(
      session.records.map((record) =>
        record.kind === 'message' ? `${record.role}:${record.text}` : record.summary,
      ),
    ).toEqual([
      'user:Repeat this',
      'assistant:Between repeats',
      'user:Repeat this',
      'assistant:Event comes second',
    ])
    expect(session.records.map((record) => record.sourceIndex)).toEqual([1, 3, 4, 6])
  })

  it('imports paired tool searches without retaining definitions and warns on losses', () =>
  {
    const query = 'é'.repeat(524_300)
    const rawCallId = 'call-'.padEnd(600, 'x')
    const tools = [
      {
        type: 'namespace',
        name: 'private-group',
        description: 'PRIVATE_GROUP_DESCRIPTION',
        tools: Array.from({ length: 101 }, (_, index) => ({
          type: 'function',
          name: index === 0 ? 'é'.repeat(200) : `tool_${String(index).padStart(3, '0')}`,
          description: `PRIVATE_TOOL_DESCRIPTION_${index}`,
          parameters: { privateSchema: `PRIVATE_SCHEMA_${index}` },
        })),
      },
    ]
    const content = [
      {
        timestamp: '2026-01-01T00:00:00Z',
        type: 'session_meta',
        payload: { id: 'tool-search', cwd: '/repo' },
      },
      {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Find a tool' },
      },
      {
        timestamp: '2026-01-01T00:00:02Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          call_id: rawCallId,
          arguments: { query },
        },
      },
      {
        timestamp: '2026-01-01T00:00:03Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          call_id: rawCallId,
          tools,
        },
      },
      {
        timestamp: '2026-01-01T00:00:04Z',
        type: 'response_item',
        payload: { type: 'future_item', private: 'PRIVATE_UNKNOWN_PAYLOAD' },
      },
      {
        timestamp: '2026-01-01T00:00:05Z',
        type: 'response_item',
        payload: { type: 'future_item', private: 'PRIVATE_UNKNOWN_PAYLOAD_AGAIN' },
      },
      {
        timestamp: '2026-01-01T00:00:06Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          call_id: 'unpaired-search',
          arguments: { query: 'never completed' },
        },
      },
      {
        timestamp: '2026-01-01T00:00:07Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Found it' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')

    const session = parseCodexRollout({
      content,
      sourcePath: '/tool-search.jsonl',
      contentHash: 'tool-search-hash',
    })
    const toolSearch = session.records.find(
      (record) => record.kind === 'activity' && record.payload.itemType === 'dynamic_tool_call',
    )

    expect(toolSearch).toMatchObject({
      kind: 'activity',
      tone: 'tool',
      activityKind: 'tool.completed',
      payload: {
        title: 'Tool search',
        status: 'completed',
        data: {
          toolCallId: expect.stringMatching(/^[0-9a-f-]+$/),
          kind: 'search',
          rawOutput: {
            totalTools: 101,
            toolNames: expect.any(Array),
            truncated: true,
          },
          item: {
            result: {
              totalTools: 101,
              toolNames: expect.any(Array),
              truncated: true,
            },
          },
        },
      },
      sourceIndex: 2,
    })
    if (toolSearch?.kind !== 'activity') return
    const data = toolSearch.payload.data as {
      rawInput: { query: string }
      rawOutput: { toolNames: string[] }
      toolCallId: string
    }
    expect(new TextEncoder().encode(data.rawInput.query).byteLength).toBeLessThanOrEqual(1_048_576)
    expect(data.rawInput.query.endsWith('…')).toBe(true)
    expect(
      new TextEncoder().encode(data.rawOutput.toolNames[0] ?? '').byteLength,
    ).toBeLessThanOrEqual(256)
    expect(data.rawOutput.toolNames).toHaveLength(100)
    expect(data.toolCallId).not.toBe(rawCallId)
    expect(JSON.stringify(toolSearch)).not.toMatch(
      /PRIVATE_(?:GROUP_DESCRIPTION|TOOL_DESCRIPTION|SCHEMA)/,
    )
    expect(session.warnings.filter((warning) => warning.includes('future_item'))).toHaveLength(1)
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tool search query exceeded 1 MiB'),
        expect.stringContaining('tool search call id exceeded 512 bytes'),
        expect.stringContaining('tool name exceeded 256 bytes'),
        expect.stringContaining('tool search name list was capped'),
        expect.stringContaining('omitted 1 unpaired tool search call'),
      ]),
    )
    expect(
      parseCodexRollout({ content, sourcePath: '/tool-search.jsonl', contentHash: 'x' }).records,
    ).toEqual(session.records)
  })

  it('bounds metadata and ordinary tool identity without breaking raw call pairing', () =>
  {
    const oversizedMetadata = 'm'.repeat(700)
    const oversizedCwd = `/${'c'.repeat(4_096)}`
    const rawCallId = 'call-'.padEnd(700, 'x')
    const rawToolName = 'tool-'.padEnd(400, 'é')
    const content = [
      {
        timestamp: '2026-01-01T00:00:00Z',
        type: 'session_meta',
        payload: {
          id: oversizedMetadata,
          cwd: oversizedCwd,
          git: { branch: oversizedMetadata },
        },
      },
      {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'turn_context',
        payload: { model: oversizedMetadata },
      },
      {
        timestamp: '2026-01-01T00:00:02Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Run bounded tool' },
      },
      {
        timestamp: '2026-01-01T00:00:03Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: rawToolName,
          call_id: rawCallId,
          input: { value: 1 },
        },
      },
      {
        timestamp: '2026-01-01T00:00:04Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: rawCallId,
          output: 'bounded',
        },
      },
      {
        timestamp: '2026-01-01T00:00:05Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Done' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')

    const session = parseCodexRollout({
      content,
      sourcePath: '/bounded.jsonl',
      contentHash: 'bounded-hash',
    })
    const tool = session.records.find(
      (record) => record.kind === 'activity' && record.payload.itemType === 'dynamic_tool_call',
    )

    expect(session.meta).toMatchObject({
      nativeSessionId: null,
      cwd: null,
    })
    expect(session.meta.gitBranch).toHaveLength(512)
    expect(session.meta.model).toHaveLength(512)
    expect(tool).toMatchObject({
      kind: 'activity',
      payload: {
        status: 'completed',
        detail: 'bounded',
        data: {
          toolCallId: expect.stringMatching(/^[0-9a-f-]+$/),
        },
      },
    })
    if (tool?.kind !== 'activity') return
    expect(new TextEncoder().encode(String(tool.payload.title)).byteLength).toBeLessThanOrEqual(256)
    expect((tool.payload.data as { toolCallId: string }).toolCallId).not.toBe(rawCallId)
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('native session id was invalid or oversized'),
        expect.stringContaining('cwd exceeded 4096 characters'),
        expect.stringContaining('git branch exceeded 512 characters'),
        expect.stringContaining('model exceeded 512 characters'),
        expect.stringContaining('tool name exceeded 256 bytes'),
        expect.stringContaining('tool call id exceeded 512 bytes'),
      ]),
    )
  })

  it('omits unpaired calls with a visible warning and maps changed filenames', () =>
  {
    const content = [
      '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"one","cwd":"/repo"}}',
      '{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Change it"}}',
      '{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"custom_tool_call","name":"custom","call_id":"open","input":{"value":1}}}',
      '{"timestamp":"2026-01-01T00:00:01.500Z","type":"event_msg","payload":{"type":"patch_apply_end","files":["one.ts"]}}',
    ].join('\n')

    const session = parseCodexRollout({
      content,
      sourcePath: '/rollout.jsonl',
      contentHash: 'hash',
    })

    expect(
      session.records.some(
        (record) => record.kind === 'activity' && record.payload.itemType === 'dynamic_tool_call',
      ),
    ).toBe(false)
    expect(session.records[1]).toMatchObject({
      kind: 'activity',
      createdAt: '2026-01-01T00:00:01.500Z',
      payload: {
        itemType: 'file_change',
        data: {
          item: { changes: [{ path: 'one.ts' }] },
        },
      },
    })
    expect(session.records[2]).toMatchObject({
      kind: 'activity',
      tone: 'error',
      activityKind: 'task.completed',
      payload: {
        importWarningCount: 1,
        detail: 'omitted 1 unpaired tool call from imported transcript',
      },
    })
  })

  it('caps single-record file and tool collections before normalization', () =>
  {
    const files = Array.from({ length: 10_001 }, (_, index) => `src/file-${index}.ts`)
    const tools = Array.from({ length: 20_001 }, (_, index) => ({
      type: 'function',
      name: `tool_${index}`,
    }))
    const toolOutputBlocks = [
      ...Array.from({ length: 10_001 }, () => ({
        type: 'input_image',
        image_url: 'data:image/png;base64,private',
      })),
      { type: 'output_text', text: 'must-not-survive-after-cap' },
    ]
    const content = [
      {
        timestamp: '2026-01-01T00:00:00Z',
        type: 'session_meta',
        payload: { id: 'bounded-collections', cwd: '/repo' },
      },
      {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Inspect bounded collections' },
      },
      {
        timestamp: '2026-01-01T00:00:02Z',
        type: 'event_msg',
        payload: { type: 'patch_apply_end', files },
      },
      {
        timestamp: '2026-01-01T00:00:03Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          call_id: 'bounded-tool-search',
          arguments: { query: 'bounded tools' },
        },
      },
      {
        timestamp: '2026-01-01T00:00:04Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          call_id: 'bounded-tool-search',
          tools,
        },
      },
      {
        timestamp: '2026-01-01T00:00:05Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'bounded_output',
          call_id: 'bounded-output',
          input: {},
        },
      },
      {
        timestamp: '2026-01-01T00:00:06Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'bounded-output',
          output: toolOutputBlocks,
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')

    const session = parseCodexRollout({
      content,
      sourcePath: '/bounded-collections.jsonl',
      contentHash: 'bounded-collections-hash',
    })
    const patch = session.records.find(
      (record) => record.kind === 'activity' && record.payload.itemType === 'file_change',
    )
    const search = session.records.find(
      (record) =>
        record.kind === 'activity' &&
        record.payload.title === 'Tool search' &&
        record.payload.status === 'completed',
    )

    expect(patch).toMatchObject({
      kind: 'activity',
      payload: {
        data: {
          item: {
            changes: expect.any(Array),
          },
        },
      },
    })
    if (patch?.kind !== 'activity')
    {
      throw new Error('Expected a bounded file-change activity')
    }
    expect(
      (patch.payload.data as { item: { changes: ReadonlyArray<unknown> } }).item.changes.length,
    ).toBe(10_000)
    expect(search).toMatchObject({
      kind: 'activity',
      payload: {
        data: {
          rawOutput: {
            truncated: true,
          },
        },
      },
    })
    expect(JSON.stringify(session.records)).not.toContain('must-not-survive-after-cap')
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('changed files were capped at 10000 of 10001'),
        expect.stringContaining('nested tool search output was capped after 20000'),
        expect.stringContaining('tool output content was capped at 10000 of 10002 blocks'),
      ]),
    )
  })

  it('deduplicates image representations and omits every attachment payload', () =>
  {
    const input = {
      content: fixture('codex-rollout-attachments.jsonl'),
      sourcePath: '/rollout-attachments.jsonl',
      contentHash: 'attachments-hash',
    }
    const session = parseCodexRollout(input)
    const serialized = JSON.stringify(session.records)

    expect(session.records).toMatchObject([
      { kind: 'message', role: 'user', text: 'Compare the attachments', sourceIndex: 2 },
      {
        kind: 'activity',
        tone: 'tool',
        activityKind: 'tool.completed',
        summary: 'inspect_image(...)',
        payload: {
          detail: '[{"type":"input_text","text":"image inspected"}]',
          data: {
            rawOutput: {
              content: '[{"type":"input_text","text":"image inspected"}]',
            },
          },
        },
        sourceIndex: 3,
      },
      { kind: 'message', role: 'assistant', text: 'Compared.', sourceIndex: 5 },
      {
        kind: 'activity',
        tone: 'info',
        activityKind: 'task.completed',
        summary: 'Omitted 3 attachments from imported transcript',
        payload: {
          omittedAttachmentCount: 3,
          summary: 'Omitted 3 attachments from imported transcript',
          detail: 'Attachment payloads are not included in imported transcripts.',
        },
        createdAt: '2026-04-05T06:07:13.001Z',
        sourceIndex: 6,
      },
    ])
    expect(serialized).not.toContain('private-codex-image')
    expect(serialized).not.toContain('/private/codex-local.png')
    expect(serialized).not.toContain('private-tool-output-image')
    expect(parseCodexRollout(input).records).toEqual(session.records)
  })

  it('warns instead of throwing on malformed lines and empties zero-message sessions', () =>
  {
    const session = parseCodexRollout({
      content: [
        '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"empty"}}',
        'not json',
        '{"timestamp":"invalid","type":"event_msg","payload":{"type":"agent_reasoning","text":"ignored"}}',
      ].join('\n'),
      sourcePath: '/empty.jsonl',
      contentHash: 'empty-hash',
    })

    expect(session.records).toEqual([])
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('malformed JSON'),
        expect.stringContaining('invalid timestamp'),
        expect.stringContaining('no messages'),
      ]),
    )

    const metadataFree = parseCodexRollout({
      content:
        '{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"orphaned"}}',
      sourcePath: '/orphaned.jsonl',
      contentHash: 'orphaned-hash',
    })
    expect(metadataFree.records).toEqual([])
    expect(metadataFree.warnings).toContain('no session metadata found; session was not imported')
  })

  it('preserves supported nested message text and surfaces unsupported blocks', () =>
  {
    const session = parseCodexRollout({
      content: [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00Z',
          type: 'session_meta',
          payload: { id: 'nested-content', cwd: '/repo' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: [
              { type: 'text', text: 'Keep event text' },
              { type: 'future_event_block', privatePayload: 'PRIVATE_EVENT_BLOCK' },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:02Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Keep response text' },
              { type: 'future_response_block', privatePayload: 'PRIVATE_RESPONSE_BLOCK' },
            ],
          },
        }),
      ].join('\n'),
      sourcePath: '/nested-content.jsonl',
      contentHash: 'nested-content-hash',
    })

    expect(
      session.records
        .filter((record) => record.kind === 'message')
        .map((record) => `${record.role}:${record.text}`),
    ).toEqual(['user:Keep event text', 'assistant:Keep response text'])
    expect(session.warnings).toEqual([
      'line 2: 1 unsupported event user_message content block omitted',
      'line 3: 1 unsupported response message content block omitted',
    ])
    expect(session.records.at(-1)).toMatchObject({
      kind: 'activity',
      tone: 'error',
      payload: {
        importWarningCount: 2,
        detail: expect.stringContaining('unsupported response message content block'),
      },
    })
    expect(JSON.stringify(session)).not.toContain('PRIVATE_EVENT_BLOCK')
    expect(JSON.stringify(session)).not.toContain('PRIVATE_RESPONSE_BLOCK')
  })

  it('maps completed web search actions into canonical bounded activities', () =>
  {
    const session = parseCodexRollout({
      content: [
        {
          timestamp: '2026-01-01T00:00:00Z',
          type: 'session_meta',
          payload: { id: 'web-search-actions', cwd: '/repo' },
        },
        {
          timestamp: '2026-01-01T00:00:01Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Research this' },
        },
        {
          timestamp: '2026-01-01T00:00:02Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            id: 'search-1',
            status: 'completed',
            action: {
              type: 'search',
              query: 'site:example.com Codex',
              queries: ['site:example.com Codex', 'Codex documentation'],
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:03Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            id: 'search-2',
            status: 'completed',
            action: { type: 'search', queries: ['fallback query'] },
          },
        },
        {
          timestamp: '2026-01-01T00:00:04Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            id: 'open-1',
            status: 'completed',
            action: { type: 'open_page', url: 'https://example.com/docs' },
          },
        },
        {
          timestamp: '2026-01-01T00:00:05Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            id: 'find-1',
            status: 'completed',
            action: {
              type: 'find_in_page',
              pattern: 'installation',
              url: 'https://example.com/docs',
            },
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      sourcePath: '/web-search-actions.jsonl',
      contentHash: 'web-search-actions-hash',
    })
    const activities = session.records.filter(
      (record) => record.kind === 'activity' && record.payload.itemType === 'web_search',
    )

    expect(activities).toMatchObject([
      {
        activityKind: 'tool.completed',
        summary: 'Search web: site:example.com Codex',
        payload: {
          itemType: 'web_search',
          title: 'Web search',
          status: 'completed',
          detail: 'site:example.com Codex\nCodex documentation',
          data: {
            toolCallId: 'search-1',
            kind: 'search',
            rawInput: {
              type: 'search',
              query: 'site:example.com Codex',
              queries: ['site:example.com Codex', 'Codex documentation'],
            },
            item: {
              input: {
                type: 'search',
                query: 'site:example.com Codex',
                queries: ['site:example.com Codex', 'Codex documentation'],
              },
            },
          },
        },
      },
      {
        summary: 'Search web: fallback query',
        payload: {
          title: 'Web search',
          detail: 'fallback query',
          data: {
            rawInput: {
              type: 'search',
              query: 'fallback query',
              queries: ['fallback query'],
            },
          },
        },
      },
      {
        summary: 'Open page: https://example.com/docs',
        payload: {
          title: 'Open page',
          detail: 'https://example.com/docs',
          data: {
            rawInput: { type: 'open_page', url: 'https://example.com/docs' },
          },
        },
      },
      {
        summary: 'Find in page: installation',
        payload: {
          title: 'Find in page',
          detail: 'installation\nhttps://example.com/docs',
          data: {
            rawInput: {
              type: 'find_in_page',
              pattern: 'installation',
              url: 'https://example.com/docs',
            },
          },
        },
      },
    ])
    expect(session.warnings).toEqual([])
  })

  it('bounds web search fields and warns on unsupported or malformed actions', () =>
  {
    const oversizedQuery = 'é'.repeat(524_300)
    const session = parseCodexRollout({
      content: [
        {
          timestamp: '2026-01-01T00:00:00Z',
          type: 'session_meta',
          payload: { id: 'web-search-validation', cwd: '/repo' },
        },
        {
          timestamp: '2026-01-01T00:00:01Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Research safely' },
        },
        {
          timestamp: '2026-01-01T00:00:02Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            status: 'completed',
            action: {
              type: 'search',
              query: 'primary query',
              queries: [oversizedQuery, 'follow-up'],
            },
          },
        },
        {
          timestamp: '2026-01-01T00:00:03Z',
          type: 'response_item',
          payload: { type: 'web_search_call', status: 'completed' },
        },
        {
          timestamp: '2026-01-01T00:00:04Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'other', privatePayload: 'PRIVATE_UNSUPPORTED_WEB_ACTION' },
          },
        },
        {
          timestamp: '2026-01-01T00:00:05Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: null, queries: [] },
          },
        },
        {
          timestamp: '2026-01-01T00:00:06Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            status: 'in_progress',
            action: { type: 'search', query: 'PRIVATE_IN_PROGRESS_QUERY' },
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
      sourcePath: '/web-search-validation.jsonl',
      contentHash: 'web-search-validation-hash',
    })
    const activities = session.records.filter(
      (record) => record.kind === 'activity' && record.payload.itemType === 'web_search',
    )

    expect(activities).toHaveLength(1)
    const activity = activities[0]
    expect(activity).toMatchObject({
      kind: 'activity',
      payload: {
        itemType: 'web_search',
        data: {
          kind: 'search',
          rawInput: { type: 'search' },
        },
      },
    })
    if (activity?.kind !== 'activity') return
    const data = activity.payload.data as { rawInput: { queries: string[] } }
    expect(new TextEncoder().encode(data.rawInput.queries[0] ?? '').byteLength).toBeLessThanOrEqual(
      1_048_576,
    )
    expect(data.rawInput.queries[0]?.endsWith('…')).toBe(true)
    expect(data.rawInput.queries).toHaveLength(1)
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        'line 3: web search query 1 exceeded 1 MiB and was truncated',
        'line 3: web search query list exceeded 1 MiB and was truncated',
        'line 4: completed web search call had no valid action and was omitted',
        'line 5: unsupported completed web search action "other" was omitted',
        'line 6: completed web search action had no query and was omitted',
        'line 7: web search call with status "in_progress" was omitted',
      ]),
    )
    expect(session.warnings.some((warning) => warning.includes('unknown response item type'))).toBe(
      false,
    )
    const serialized = JSON.stringify(session)
    expect(serialized).not.toContain('PRIVATE_UNSUPPORTED_WEB_ACTION')
    expect(serialized).not.toContain('PRIVATE_IN_PROGRESS_QUERY')
  })

  it('clamps duplicate maximum Date timestamps without throwing', () =>
  {
    const maximumDate = '+275760-09-13T00:00:00.000Z'
    const session = parseCodexRollout({
      content: [
        JSON.stringify({
          timestamp: maximumDate,
          type: 'session_meta',
          payload: { id: 'maximum-date', cwd: '/repo' },
        }),
        JSON.stringify({
          timestamp: maximumDate,
          type: 'event_msg',
          payload: { type: 'user_message', message: 'At the limit' },
        }),
        JSON.stringify({
          timestamp: maximumDate,
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Still at the limit' },
        }),
      ].join('\n'),
      sourcePath: '/maximum-date.jsonl',
      contentHash: 'maximum-date-hash',
    })

    expect(session.records.map((record) => record.createdAt)).toEqual([maximumDate, maximumDate])
    expect(session.meta.firstActivityAt).toBe(maximumDate)
    expect(session.meta.lastActivityAt).toBe(maximumDate)
    expect(session.warnings).toEqual([])
  })

  it('surfaces a malformed tail inside the normalized transcript', () =>
  {
    const session = parseCodexRollout({
      content: [
        '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"tail","cwd":"/repo"}}',
        '{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Keep this"}}',
        '{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg"',
      ].join('\n'),
      sourcePath: '/tail.jsonl',
      contentHash: 'tail-hash',
    })

    expect(session.records.at(-1)).toMatchObject({
      kind: 'activity',
      tone: 'error',
      activityKind: 'task.completed',
      payload: {
        importWarningCount: 1,
        detail: 'line 3: malformed JSON skipped',
      },
    })
  })

  it('caps warning detail and reports how many warnings were omitted', () =>
  {
    const malformedLines = Array.from({ length: 105 }, () => 'not json')
    const session = parseCodexRollout({
      content: [
        '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"warnings","cwd":"/repo"}}',
        '{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Keep this"}}',
        ...malformedLines,
      ].join('\n'),
      sourcePath: '/warnings.jsonl',
      contentHash: 'warnings-hash',
    })

    expect(session.warnings).toHaveLength(101)
    expect(session.warnings.at(-1)).toBe(
      '5 additional parsing warnings omitted after the first 100',
    )
    expect(session.records.at(-1)).toMatchObject({
      kind: 'activity',
      payload: {
        importWarningCount: 105,
        omittedWarningCount: 5,
      },
    })
  })

  it('rejects JSONL beyond the hard physical-line cap', () =>
  {
    expect(() =>
      parseCodexRollout({
        content: `${'{}\n'.repeat(100_000)}{}`,
        sourcePath: '/too-many-lines.jsonl',
        contentHash: 'too-many-lines-hash',
      }),
    ).toThrow(/physical-line limit exceeded/)
  })

  it('truncates oversized messages at one MiB and surfaces the loss', () =>
  {
    const oversizedMessage = 'é'.repeat(524_300)
    const session = parseCodexRollout({
      content: [
        '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"large","cwd":"/repo"}}',
        JSON.stringify({
          timestamp: '2026-01-01T00:00:01Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: oversizedMessage },
        }),
      ].join('\n'),
      sourcePath: '/large.jsonl',
      contentHash: 'large-hash',
    })
    const message = session.records.find((record) => record.kind === 'message')

    expect(message?.kind).toBe('message')
    if (message?.kind !== 'message') return
    expect(new TextEncoder().encode(message.text).byteLength).toBeLessThanOrEqual(1_048_576)
    expect(message.text.endsWith('…')).toBe(true)
    expect(session.records.at(-1)).toMatchObject({
      kind: 'activity',
      payload: {
        importWarningCount: 1,
        detail: expect.stringContaining('user message exceeded 1 MiB and was truncated'),
      },
    })
  })
})
