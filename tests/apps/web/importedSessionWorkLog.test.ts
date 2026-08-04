// tests/apps/web/importedSessionWorkLog.test.ts
// verifies imported parser activities render through work-log conventions

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFSP from 'node:fs/promises'

import { EventId, type OrchestrationThreadActivity } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { deriveMessagesTimelineRows } from '../../../apps/web/src/components/chat/MessagesTimeline.logic'
import { deriveActivePlanState, deriveWorkLogEntries } from '../../../apps/web/src/session-logic'

interface ImportedSession
{
  records: Array<
    | {
        kind: 'message'
      }
    | {
        kind: 'activity'
        activityKind: string
        createdAt: string
        payload: Record<string, unknown>
        sourceIndex: number
        summary: string
        tone: 'info' | 'tool' | 'error'
      }
  >
}

interface ParserModule
{
  parse: (input: { content: string; sourcePath: string; contentHash: string }) => ImportedSession
}

interface OpenCodeParserModule
{
  parseOpenCodeSessionBundle: (input: {
    sourcePath: string
    contentHash: string
    sessionId: string
    session: { relativePath: string; content: string }
    messages: ReadonlyArray<{
      message: { relativePath: string; content: string }
      parts: ReadonlyArray<{ relativePath: string; content: string }>
    }>
  }) => ImportedSession
}

interface AcpParserModule
{
  normalizeAcpSessionReplay: (input: {
    descriptor: {
      driverKind: 'cursor'
      providerInstanceId: string
      source: 'cursor-acp'
      sourcePath: string
      nativeSessionId: string
      cwd: string
      title: string
      updatedAt: string | null
    }
    notifications: ReadonlyArray<unknown>
    loadResponse: Record<string, unknown>
    fallbackActivityAt: string
  }) => ImportedSession
}

interface CompactorModule
{
  compactImportedSession: (session: ImportedSession) => ImportedSession
}

const compactorModulePath = '../../../apps/server/src/import/compactImportedSession.ts'

async function loadCompactor(): Promise<CompactorModule>
{
  return (await import(/* @vite-ignore */ compactorModulePath)) as CompactorModule
}

async function loadParser(
  relativePath: string,
  exportName: 'parseClaudeSession' | 'parseCodexRollout',
): Promise<ParserModule>
{
  const [module, compactor] = await Promise.all([
    import(/* @vite-ignore */ relativePath) as Promise<Record<string, unknown>>,
    loadCompactor(),
  ])
  const parse = module[exportName] as ParserModule['parse']
  return { parse: (input) => compactor.compactImportedSession(parse(input)) }
}

async function loadOpenCodeParser(relativePath: string): Promise<OpenCodeParserModule>
{
  const [module, compactor] = await Promise.all([
    import(/* @vite-ignore */ relativePath) as Promise<OpenCodeParserModule>,
    loadCompactor(),
  ])
  return {
    parseOpenCodeSessionBundle: (input) =>
      compactor.compactImportedSession(module.parseOpenCodeSessionBundle(input)),
  }
}

async function loadAcpParser(relativePath: string): Promise<AcpParserModule>
{
  const [module, compactor] = await Promise.all([
    import(/* @vite-ignore */ relativePath) as Promise<AcpParserModule>,
    loadCompactor(),
  ])
  return {
    normalizeAcpSessionReplay: (input) =>
      compactor.compactImportedSession(module.normalizeAcpSessionReplay(input)),
  }
}

async function readOpenCodeFixture(relativePath: string)
{
  const fixture = new URL(
    `../server/import/fixtures/opencode/storage/${relativePath}`,
    import.meta.url,
  )
  return {
    relativePath,
    content: await NodeFSP.readFile(fixture, 'utf8'),
  }
}

function importedActivities(session: ImportedSession): OrchestrationThreadActivity[]
{
  let activityIndex = 0
  return session.records.flatMap((record) =>
  {
    if (record.kind === 'message')
    {
      return []
    }

    const activity: OrchestrationThreadActivity = {
      id: EventId.make(`imported-activity-${activityIndex}`),
      createdAt: record.createdAt,
      kind: record.activityKind,
      summary: record.summary,
      tone: record.tone,
      payload: record.payload,
      turnId: null,
      sequence: record.sourceIndex,
    }
    activityIndex += 1
    return [activity]
  })
}

function visibleWorkEntries(activities: ReadonlyArray<OrchestrationThreadActivity>)
{
  const entries = deriveWorkLogEntries(activities)
  const firstEntry = entries[0]
  const rows = deriveMessagesTimelineRows({
    timelineEntries: entries.map((entry) => ({
      id: entry.id,
      kind: 'work' as const,
      createdAt: entry.createdAt,
      entry,
    })),
    isWorking: false,
    activeTurnStartedAt: null,
    expandedWorkGroupIds:
      firstEntry === undefined ? new Set() : new Set([`work-group:${firstEntry.id}`]),
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  })
  return rows.flatMap((row) => (row.kind === 'work' ? row.groupedEntries : []))
}

describe('imported session work-log compatibility', () =>
{
  it('renders full Codex reasoning, command output, and changed filenames', async () =>
  {
    const parser = await loadParser(
      '../../../apps/server/src/import/codexRolloutParser.ts',
      'parseCodexRollout',
    )
    const session = parser.parse({
      content: [
        '{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"codex-render","cwd":"/repo"}}',
        '{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Fix it"}}',
        '{"timestamp":"2026-01-01T00:00:02Z","type":"event_msg","payload":{"type":"agent_reasoning","text":"Inspecting the parser\\nChecking renderer conventions."}}',
        '{"timestamp":"2026-01-01T00:00:03Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\\"cmd\\":\\"vp test\\"}"}}',
        '{"timestamp":"2026-01-01T00:00:04Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"tests passed\\n12 files checked"}}',
        '{"timestamp":"2026-01-01T00:00:05Z","type":"event_msg","payload":{"type":"patch_apply_end","files":["apps/server/src/import/parser.ts","tests/parser.test.ts"]}}',
        '{"timestamp":"2026-01-01T00:00:06Z","type":"event_msg","payload":{"type":"agent_message","message":"Done."}}',
      ].join('\n'),
      sourcePath: '/codex-render.jsonl',
      contentHash: 'codex-render-hash',
    })

    const activities = importedActivities(session)
    const entries = deriveWorkLogEntries(activities)
    expect(entries.find((entry) => entry.tone === 'thinking')).toMatchObject({
      label: 'Inspecting the parser',
      detail: 'Inspecting the parser\nChecking renderer conventions.',
    })
    expect(entries.find((entry) => entry.itemType === 'command_execution')).toMatchObject({
      command: 'vp test',
      detail: 'tests passed\n12 files checked',
      itemType: 'command_execution',
      toolTitle: 'exec_command',
      toolLifecycleStatus: 'completed',
    })
    expect(entries.find((entry) => entry.itemType === 'file_change')).toMatchObject({
      changedFiles: ['apps/server/src/import/parser.ts', 'tests/parser.test.ts'],
      itemType: 'file_change',
    })
    expect(visibleWorkEntries(activities).find((entry) => entry.tone === 'thinking')).toMatchObject(
      {
        label: 'Inspecting the parser',
        detail: 'Inspecting the parser\nChecking renderer conventions.',
      },
    )
  })

  it('renders Claude reasoning, command input/output, and edit filenames', async () =>
  {
    const parser = await loadParser(
      '../../../apps/server/src/import/claudeSessionParser.ts',
      'parseClaudeSession',
    )
    const session = parser.parse({
      content: [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-render',
          cwd: '/repo',
          timestamp: '2026-01-01T00:00:00Z',
          message: { content: 'Fix it' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-render',
          cwd: '/repo',
          timestamp: '2026-01-01T00:00:01Z',
          message: {
            content: [
              { type: 'thinking', thinking: 'Inspecting the source\nChecking the target.' },
              { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'vp test' } },
              {
                type: 'tool_use',
                id: 'edit-1',
                name: 'Edit',
                input: { file_path: 'apps/server/src/import/parser.ts' },
              },
              { type: 'text', text: 'Done.' },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-render',
          cwd: '/repo',
          timestamp: '2026-01-01T00:00:02Z',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'bash-1',
                content: [{ type: 'text', text: 'tests passed\n12 files checked' }],
              },
              {
                type: 'tool_result',
                tool_use_id: 'edit-1',
                content: [{ type: 'text', text: 'updated parser' }],
              },
            ],
          },
        }),
      ].join('\n'),
      sourcePath: '/claude-render.jsonl',
      contentHash: 'claude-render-hash',
    })

    const activities = importedActivities(session)
    const entries = deriveWorkLogEntries(activities)
    expect(entries.find((entry) => entry.tone === 'thinking')).toMatchObject({
      label: 'Inspecting the source',
      detail: 'Inspecting the source\nChecking the target.',
    })
    expect(entries.find((entry) => entry.itemType === 'command_execution')).toMatchObject({
      command: 'vp test',
      detail: 'tests passed\n12 files checked',
      itemType: 'command_execution',
      toolTitle: 'Bash',
      toolLifecycleStatus: 'completed',
    })
    expect(entries.find((entry) => entry.itemType === 'file_change')).toMatchObject({
      changedFiles: ['apps/server/src/import/parser.ts'],
      detail: 'updated parser',
      itemType: 'file_change',
      toolTitle: 'Edit',
    })
    expect(visibleWorkEntries(activities).find((entry) => entry.tone === 'thinking')).toMatchObject(
      {
        label: 'Inspecting the source',
        detail: 'Inspecting the source\nChecking the target.',
      },
    )
  })

  it('renders OpenCode fixture reasoning and completed command details', async () =>
  {
    const parser = await loadOpenCodeParser(
      '../../../apps/server/src/import/openCodeSessionParser.ts',
    )
    const session = parser.parseOpenCodeSessionBundle({
      sourcePath: '/opencode/storage/session/prj_fixture/ses_imported.json',
      contentHash: 'opencode-render-hash',
      sessionId: 'ses_imported',
      session: await readOpenCodeFixture('session/prj_fixture/ses_imported.json'),
      messages: [
        {
          message: await readOpenCodeFixture('message/ses_imported/msg_001.json'),
          parts: [
            await readOpenCodeFixture('part/msg_001/prt_001.json'),
            await readOpenCodeFixture('part/msg_001/prt_002.json'),
          ],
        },
        {
          message: await readOpenCodeFixture('message/ses_imported/msg_002.json'),
          parts: [
            await readOpenCodeFixture('part/msg_002/prt_003.json'),
            await readOpenCodeFixture('part/msg_002/prt_004.json'),
            await readOpenCodeFixture('part/msg_002/prt_005.json'),
            await readOpenCodeFixture('part/msg_002/prt_006.json'),
          ],
        },
      ],
    })

    const activities = importedActivities(session)
    const entries = deriveWorkLogEntries(activities)
    const visibleEntries = visibleWorkEntries(activities)
    expect(entries.find((entry) => entry.tone === 'thinking')).toMatchObject({
      label: 'Inspecting the storage bundle.',
      detail: 'Inspecting the storage bundle.\nChecking renderer compatibility.',
    })
    expect(entries.find((entry) => entry.itemType === 'command_execution')).toMatchObject({
      command: 'vp test run importer',
      detail: 'focused tests passed',
      itemType: 'command_execution',
      toolTitle: 'Run focused importer tests',
      toolLifecycleStatus: 'completed',
    })
    expect(visibleEntries.find((entry) => entry.tone === 'thinking')).toMatchObject({
      detail: 'Inspecting the storage bundle.\nChecking renderer compatibility.',
    })
    expect(visibleEntries.find((entry) => entry.itemType === 'command_execution')).toMatchObject({
      command: 'vp test run importer',
      detail: 'focused tests passed',
    })
  })

  it('renders distinct ACP thoughts, plans, failed tool detail, and unfinished warnings', async () =>
  {
    const parser = await loadAcpParser('../../../apps/server/src/import/acpImport.ts')
    const nativeSessionId = 'acp-render-session'
    const session = parser.normalizeAcpSessionReplay({
      descriptor: {
        driverKind: 'cursor',
        providerInstanceId: 'cursor_personal',
        source: 'cursor-acp',
        sourcePath: 'acp://cursor/cursor_personal/acp-render-session',
        nativeSessionId,
        cwd: '/repo',
        title: 'ACP renderer fixture',
        updatedAt: null,
      },
      notifications: [
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            messageId: 'thought-one',
            content: { type: 'text', text: 'First thought\nwith full detail.' },
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            messageId: 'thought-two',
            content: { type: 'text', text: 'Second distinct thought.' },
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [
              {
                content: 'Inspect imported history',
                priority: 'high',
                status: 'completed',
              },
              {
                content: 'Repair the importer',
                priority: 'medium',
                status: 'in_progress',
              },
            ],
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'failed-tool',
            title: 'Terminal',
            kind: 'execute',
            status: 'pending',
            rawInput: { command: 'vp test run importer' },
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'failed-tool',
            status: 'failed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'focused tests failed' },
              },
            ],
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'unfinished-tool',
            title: 'Still inspecting',
            kind: 'read',
            status: 'in_progress',
            rawInput: {},
          },
        },
        {
          sessionId: nativeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'answer',
            content: { type: 'text', text: 'Done.' },
          },
        },
      ],
      loadResponse: {},
      fallbackActivityAt: '2026-07-26T12:00:00.000Z',
    })

    const activities = importedActivities(session)
    const entries = deriveWorkLogEntries(activities)
    const visibleEntries = visibleWorkEntries(activities)
    expect(entries.filter((entry) => entry.tone === 'thinking')).toMatchObject([
      {
        label: 'First thought with full detail.',
        detail: 'First thought\nwith full detail.',
      },
      {
        label: 'Second distinct thought.',
        detail: 'Second distinct thought.',
      },
    ])
    expect(deriveActivePlanState(activities, undefined)).toMatchObject({
      steps: [
        { step: 'Inspect imported history', status: 'completed' },
        { step: 'Repair the importer', status: 'inProgress' },
      ],
    })
    expect(entries.find((entry) => entry.itemType === 'command_execution')).toMatchObject({
      command: 'vp test run importer',
      detail: 'focused tests failed',
      toolLifecycleStatus: 'failed',
    })
    expect(entries.find((entry) => entry.label.includes('unfinished tool activity'))).toMatchObject(
      {
        detail: 'Still inspecting',
      },
    )
    expect(visibleEntries.map((entry) => entry.label)).toEqual([
      'First thought with full detail.',
      'Second distinct thought.',
      'Plan updated',
      'Ran command',
      'Omitted 1 unfinished tool activity from imported ACP history',
    ])
  })
})
