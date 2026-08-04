// tests/apps/server/import/compactImportedSession.test.ts
// verifies redundant imported tool payloads are compacted without losing display data

import { describe, expect, it } from '@effect/vitest'

import { compactImportedSession } from '../../../../apps/server/src/import/compactImportedSession.ts'
import type {
  ImportedActivityRecord,
  ImportedSession,
} from '../../../../apps/server/src/import/types.ts'

function sessionWithActivity(activity: ImportedActivityRecord): ImportedSession
{
  return {
    meta: {
      source: 'codex-cli',
      sourcePath: '/rollout.jsonl',
      contentHash: 'hash',
      nativeSessionId: 'native',
      cwd: '/repo',
      gitBranch: null,
      model: null,
      title: null,
      firstActivityAt: activity.createdAt,
      lastActivityAt: activity.createdAt,
    },
    records: [activity],
    warnings: [],
  }
}

function activity(itemType: string, data: Record<string, unknown>): ImportedActivityRecord
{
  return {
    kind: 'activity',
    tone: 'tool',
    activityKind: 'tool.completed',
    summary: 'Tool',
    payload: {
      itemType,
      title: 'Tool',
      status: 'completed',
      detail: 'visible output',
      data,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceIndex: 0,
  }
}

describe('compactImportedSession', () =>
{
  it('drops duplicate ordinary tool input and output while retaining display fields', () =>
  {
    const compacted = compactImportedSession(
      sessionWithActivity(
        activity('command_execution', {
          toolCallId: 'call-1',
          kind: 'execute',
          command: 'vp test',
          rawInput: { command: 'vp test', private: 'duplicate input' },
          rawOutput: { content: 'visible output' },
          item: {
            input: { command: 'vp test', private: 'duplicate input' },
            result: { content: 'visible output' },
          },
        }),
      ),
    )

    expect(compacted.records[0]).toMatchObject({
      kind: 'activity',
      payload: {
        detail: 'visible output',
        data: {
          toolCallId: 'call-1',
          kind: 'execute',
          command: 'vp test',
        },
      },
    })
    expect(JSON.stringify(compacted)).not.toContain('duplicate input')
  })

  it('keeps one MCP item copy while removing its raw duplicates', () =>
  {
    const item = {
      input: { query: 'current state' },
      result: { content: 'visible output' },
    }
    const compacted = compactImportedSession(
      sessionWithActivity(
        activity('mcp_tool_call', {
          toolCallId: 'call-2',
          rawInput: item.input,
          rawOutput: item.result,
          item,
        }),
      ),
    )

    expect(compacted.records[0]).toMatchObject({
      kind: 'activity',
      payload: {
        data: {
          toolCallId: 'call-2',
          item,
        },
      },
    })
    const serialized = JSON.stringify(compacted)
    expect(serialized.match(/current state/gu)).toHaveLength(1)
    expect(serialized.match(/visible output/gu)).toHaveLength(2)
  })

  it('reduces file-change items to their visible changed paths', () =>
  {
    const compacted = compactImportedSession(
      sessionWithActivity(
        activity('file_change', {
          kind: 'edit',
          rawInput: { file_path: 'src/a.ts', privatePatch: 'duplicate patch' },
          rawOutput: { content: 'duplicate output' },
          item: {
            input: { file_path: 'src/a.ts', privatePatch: 'duplicate patch' },
            result: { content: 'duplicate output' },
          },
        }),
      ),
    )

    expect(compacted.records[0]).toMatchObject({
      kind: 'activity',
      payload: {
        data: {
          kind: 'edit',
          item: {
            changes: [{ path: 'src/a.ts' }],
          },
        },
      },
    })
    expect(JSON.stringify(compacted)).not.toContain('duplicate patch')
    expect(JSON.stringify(compacted)).not.toContain('duplicate output')
  })
})
