// tests/apps/server/import/openCodeSessionParser.test.ts
// verifies opencode storage loading, parsing, privacy, and deterministic identity

// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

import { afterEach, describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  discoverOpenCodeSessionMetadataFiles,
  loadOpenCodeSessionFromMetadata,
  resolveOpenCodeStorageRoot,
} from '../../../../apps/server/src/import/parsers/openCodeStorage.ts'
import { parseOpenCodeSessionBundle } from '../../../../apps/server/src/import/parsers/openCodeSessionParser.ts'
import { makeImportCountBudget } from '../../../../apps/server/src/import/discovery/resourceLimits.ts'

const fixtureStorageRoot = NodePath.resolve(
  NodeURL.fileURLToPath(new URL('./fixtures/opencode/storage', import.meta.url)),
)
const temporaryPaths: string[] = []
const encodeUnknownJsonString = Schema.encodeSync(Schema.UnknownFromJsonString)

async function temporaryStorage(): Promise<string>
{
  const temporaryRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), '456code-opencode-import-'),
  )
  temporaryPaths.push(temporaryRoot)
  const storageRoot = NodePath.join(temporaryRoot, 'storage')
  await NodeFSP.cp(fixtureStorageRoot, storageRoot, { recursive: true })
  return storageRoot
}

afterEach(async () =>
{
  await Promise.all(
    temporaryPaths.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  )
})

describe('OpenCode session import', () =>
{
  it('resolves XDG data roots against cwd and otherwise falls back through HOME', () =>
  {
    const cwd = '/server/workspace'
    expect(
      resolveOpenCodeStorageRoot({
        environment: {
          HOME: '/home/provider',
          XDG_DATA_HOME: '/provider/data',
        },
        homePath: '/home/host',
        cwd,
      }),
    ).toBe(NodePath.join('/provider/data', 'opencode', 'storage'))
    expect(
      resolveOpenCodeStorageRoot({
        environment: {
          HOME: '/home/provider',
          XDG_DATA_HOME: 'relative-data-is-invalid',
        },
        homePath: '/home/host',
        cwd,
      }),
    ).toBe(NodePath.join(cwd, 'relative-data-is-invalid', 'opencode', 'storage'))
    expect(
      resolveOpenCodeStorageRoot({
        environment: {},
        homePath: '/home/host',
        cwd,
      }),
    ).toBe(NodePath.join('/home/host', '.local', 'share', 'opencode', 'storage'))
  })

  it.effect('discovers metadata and maps semantic records with strict timestamps', () =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const candidates = yield* discoverOpenCodeSessionMetadataFiles(storageRoot)

      expect(candidates).toEqual([
        NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json'),
      ])

      const loaded = yield* loadOpenCodeSessionFromMetadata(candidates[0]!)
      expect(loaded.session.meta).toMatchObject({
        source: 'opencode',
        nativeSessionId: 'ses_imported',
        cwd: '/workspace/opencode-fixture',
        model: 'openai/gpt-5.2',
        title: 'OpenCode import fixture',
        contentHash: loaded.contentHash,
      })
      expect(
        loaded.session.records.map((record) =>
          record.kind === 'message'
            ? `${record.role}:${record.text}`
            : `${record.activityKind}:${record.summary}`,
        ),
      ).toEqual([
        'user:Build the OpenCode importer.',
        'task.progress:Inspecting the storage bundle.',
        'tool.completed:Run focused importer tests',
        'assistant:The OpenCode importer is ready.',
        'tool.completed:Applied changes to 2 files',
        'task.completed:Omitted 2 attachments from imported transcript',
      ])
      expect(loaded.session.records.map((record) => record.createdAt)).toEqual([
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.001Z',
        '2026-01-01T00:00:00.002Z',
        '2026-01-01T00:00:00.003Z',
        '2026-01-01T00:00:00.004Z',
        '2026-01-01T00:00:00.005Z',
      ])

      const tool = loaded.session.records.find(
        (record) => record.kind === 'activity' && record.summary === 'Run focused importer tests',
      )
      expect(tool).toMatchObject({
        kind: 'activity',
        tone: 'tool',
        payload: {
          itemType: 'command_execution',
          title: 'Run focused importer tests',
          detail: 'focused tests passed',
          name: 'bash',
          status: 'completed',
          data: {
            toolCallId: 'call_001',
            kind: 'execute',
            rawInput: '{"command":"vp test run importer"}',
            rawOutput: {
              content: 'focused tests passed',
            },
            command: 'vp test run importer',
            item: {
              input: {
                command: 'vp test run importer',
              },
              command: 'vp test run importer',
              result: {
                content: 'focused tests passed',
              },
            },
          },
        },
      })
    }),
  )

  it('bounds direct Unicode content, metadata, and tool identifiers with renderer-safe payloads', () =>
  {
    const oversized = 'é'.repeat(524_300)
    const oversizedCwd = `/${'c'.repeat(4_096)}`
    const oversizedMetadata = 'm'.repeat(700)
    const oversizedCallId = 'call-'.padEnd(700, 'x')
    const oversizedToolName = 'tool-'.padEnd(400, 'é')
    const session = parseOpenCodeSessionBundle({
      sourcePath: '/storage/session/project/ses_direct.json',
      contentHash: 'direct-hash',
      sessionId: 'ses_direct',
      session: {
        relativePath: 'session/project/ses_direct.json',
        content: encodeUnknownJsonString({
          id: 'ses_direct',
          projectID: 'project',
          directory: oversizedCwd,
          title: oversizedMetadata,
        }),
      },
      messages: [
        {
          message: {
            relativePath: 'message/ses_direct/msg_user.json',
            content: encodeUnknownJsonString({
              id: 'msg_user',
              sessionID: 'ses_direct',
              role: 'user',
              time: { created: 1767225600000 },
            }),
          },
          parts: [
            {
              relativePath: 'part/msg_user/prt_user_text.json',
              content: encodeUnknownJsonString({
                id: 'prt_user_text',
                sessionID: 'ses_direct',
                messageID: 'msg_user',
                type: 'text',
                text: oversized,
              }),
            },
          ],
        },
        {
          message: {
            relativePath: 'message/ses_direct/msg_assistant.json',
            content: encodeUnknownJsonString({
              id: 'msg_assistant',
              sessionID: 'ses_direct',
              role: 'assistant',
              providerID: oversizedMetadata,
              modelID: oversizedMetadata,
              time: { created: 1767225601000 },
            }),
          },
          parts: [
            {
              relativePath: 'part/msg_assistant/prt_reasoning.json',
              content: encodeUnknownJsonString({
                id: 'prt_reasoning',
                sessionID: 'ses_direct',
                messageID: 'msg_assistant',
                type: 'reasoning',
                text: oversized,
              }),
            },
            {
              relativePath: 'part/msg_assistant/prt_tool_command.json',
              content: encodeUnknownJsonString({
                id: 'prt_tool_command',
                sessionID: 'ses_direct',
                messageID: 'msg_assistant',
                type: 'tool',
                tool: 'bash',
                callID: oversizedCallId,
                state: {
                  status: 'completed',
                  title: oversizedMetadata,
                  input: { command: oversized },
                  output: 'command complete',
                },
              }),
            },
            {
              relativePath: 'part/msg_assistant/prt_tool_name.json',
              content: encodeUnknownJsonString({
                id: 'prt_tool_name',
                sessionID: 'ses_direct',
                messageID: 'msg_assistant',
                type: 'tool',
                tool: oversizedToolName,
                callID: 'short-call',
                state: {
                  status: 'completed',
                  input: null,
                  output: 'dynamic complete',
                },
              }),
            },
            {
              relativePath: 'part/msg_assistant/prt_assistant_text.json',
              content: encodeUnknownJsonString({
                id: 'prt_assistant_text',
                sessionID: 'ses_direct',
                messageID: 'msg_assistant',
                type: 'text',
                text: 'Done',
              }),
            },
          ],
        },
      ],
    })
    const userMessage = session.records.find(
      (record) => record.kind === 'message' && record.role === 'user',
    )
    const reasoning = session.records.find(
      (record) => record.kind === 'activity' && record.activityKind === 'task.progress',
    )
    const command = session.records.find(
      (record) => record.kind === 'activity' && record.payload.itemType === 'command_execution',
    )
    const dynamic = session.records.find(
      (record) =>
        record.kind === 'activity' &&
        record.payload.itemType === 'dynamic_tool_call' &&
        record.payload.name !== 'bash',
    )
    const warningActivities = session.records.filter(
      (record) =>
        record.kind === 'activity' && typeof record.payload.importWarningCount === 'number',
    )

    expect(session.meta).toMatchObject({
      nativeSessionId: 'ses_direct',
      cwd: null,
    })
    expect(session.meta.title).toHaveLength(512)
    expect(session.meta.model).toHaveLength(512)
    expect(userMessage?.kind).toBe('message')
    if (userMessage?.kind !== 'message') return
    expect(new TextEncoder().encode(userMessage.text).byteLength).toBeLessThanOrEqual(1_048_576)
    expect(userMessage.text.endsWith('…')).toBe(true)
    expect(reasoning).toMatchObject({
      kind: 'activity',
      payload: {
        summary: expect.any(String),
        detail: expect.any(String),
      },
    })
    if (reasoning?.kind !== 'activity') return
    expect(reasoning.payload).not.toHaveProperty('text')
    expect(
      new TextEncoder().encode(String(reasoning.payload.detail)).byteLength,
    ).toBeLessThanOrEqual(1_048_576)
    expect(command).toMatchObject({
      kind: 'activity',
      payload: {
        itemType: 'command_execution',
        data: {
          toolCallId: expect.stringMatching(/^[0-9a-f-]+$/),
          command: expect.any(String),
        },
      },
    })
    if (command?.kind !== 'activity') return
    const commandData = command.payload.data as { command: string; toolCallId: string }
    expect(commandData.toolCallId).not.toBe(oversizedCallId)
    expect(new TextEncoder().encode(commandData.command).byteLength).toBeLessThanOrEqual(1_048_576)
    expect(String(command.payload.title)).toHaveLength(512)
    expect(dynamic?.kind).toBe('activity')
    if (dynamic?.kind !== 'activity') return
    expect(new TextEncoder().encode(String(dynamic.payload.name)).byteLength).toBeLessThanOrEqual(
      256,
    )
    expect(warningActivities).toHaveLength(1)
    expect(session.records.at(-1)).toBe(warningActivities[0])
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cwd exceeded 4096 characters'),
        expect.stringContaining('session title exceeded 512 characters'),
        expect.stringContaining('model exceeded 512 characters'),
        expect.stringContaining('reasoning exceeded 1048576 bytes'),
        expect.stringContaining('tool call id'),
        expect.stringContaining('tool name exceeded 256 bytes'),
      ]),
    )
  })

  it('keeps todo tools dynamic and renders retries as terminal errors', () =>
  {
    const session = parseOpenCodeSessionBundle({
      sourcePath: '/storage/session/project/ses_semantics.json',
      contentHash: 'semantics-hash',
      sessionId: 'ses_semantics',
      session: {
        relativePath: 'session/project/ses_semantics.json',
        content: encodeUnknownJsonString({ id: 'ses_semantics', projectID: 'project' }),
      },
      messages: [
        {
          message: {
            relativePath: 'message/ses_semantics/msg_user.json',
            content: encodeUnknownJsonString({
              id: 'msg_user',
              sessionID: 'ses_semantics',
              role: 'user',
              time: { created: 1767225600000 },
            }),
          },
          parts: [
            {
              relativePath: 'part/msg_user/prt_text.json',
              content: encodeUnknownJsonString({
                id: 'prt_text',
                sessionID: 'ses_semantics',
                messageID: 'msg_user',
                type: 'text',
                text: 'Track the work',
              }),
            },
            {
              relativePath: 'part/msg_user/prt_todo.json',
              content: encodeUnknownJsonString({
                id: 'prt_todo',
                sessionID: 'ses_semantics',
                messageID: 'msg_user',
                type: 'tool',
                tool: 'todowrite',
                callID: 'todo-call',
                state: {
                  status: 'completed',
                  input: { todos: ['one'] },
                  output: 'updated',
                },
              }),
            },
            {
              relativePath: 'part/msg_user/prt_retry.json',
              content: encodeUnknownJsonString({
                id: 'prt_retry',
                sessionID: 'ses_semantics',
                messageID: 'msg_user',
                type: 'retry',
                attempt: 2,
                error: 'provider failed',
              }),
            },
          ],
        },
      ],
    })

    expect(
      session.records.find(
        (record) => record.kind === 'activity' && record.payload.name === 'todowrite',
      ),
    ).toMatchObject({
      kind: 'activity',
      payload: { itemType: 'dynamic_tool_call' },
    })
    expect(
      session.records.find(
        (record) => record.kind === 'activity' && record.summary.includes('retried'),
      ),
    ).toMatchObject({
      kind: 'activity',
      tone: 'error',
      activityKind: 'task.completed',
      payload: {
        summary: 'OpenCode retried the assistant response',
        detail: 'provider failed',
        attempt: 2,
      },
    })
  })

  it.effect('emits one count-only omission summary without retaining attachment payloads', () =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const sourcePath = NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json')
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(storageRoot, 'part', 'msg_002', 'prt_004_image.json'),
          encodeUnknownJsonString({
            id: 'prt_004_image',
            sessionID: 'ses_imported',
            messageID: 'msg_002',
            type: 'tool',
            callID: 'call_private_image',
            tool: 'view_image',
            state: {
              status: 'completed',
              input: {
                path: '/private/opencode-image-tool-input.png',
              },
              output: 'data:image/png;base64,private-opencode-image-result',
              title: 'Inspect image',
              metadata: {},
              time: {
                start: 1767225600000,
                end: 1767225600000,
              },
            },
          }),
        ),
      )
      const loaded = yield* loadOpenCodeSessionFromMetadata(sourcePath)
      const serializedRecords = encodeUnknownJsonString(loaded.session.records)

      expect(serializedRecords).not.toContain('private-user-image')
      expect(serializedRecords).not.toContain('private-tool-image')
      expect(serializedRecords).not.toContain('opencode-user-image')
      expect(serializedRecords).not.toContain('opencode-tool-image')
      expect(serializedRecords).not.toContain('/private/opencode-one.ts')
      expect(serializedRecords).not.toContain('opencode-image-tool-input')
      expect(serializedRecords).not.toContain('private-opencode-image-result')
      expect(
        loaded.session.records.filter(
          (record) =>
            record.kind === 'activity' && typeof record.payload.omittedAttachmentCount === 'number',
        ),
      ).toEqual([
        expect.objectContaining({
          kind: 'activity',
          tone: 'info',
          activityKind: 'task.completed',
          summary: 'Omitted 3 attachments from imported transcript',
          payload: {
            omittedAttachmentCount: 3,
            summary: 'Omitted 3 attachments from imported transcript',
            detail: 'Attachment payloads are not included in imported transcripts.',
          },
        }),
      ])
    }),
  )

  it.effect(
    'omits live pending and running tool states instead of importing them as completed',
    () =>
      Effect.gen(function* ()
      {
        const storageRoot = yield* Effect.promise(() => temporaryStorage())
        const sourcePath = NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json')
        const partDirectory = NodePath.join(storageRoot, 'part', 'msg_002')
        for (const [partId, status] of [
          ['prt_pending', 'pending'],
          ['prt_running', 'running'],
        ] as const)
        {
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(partDirectory, `${partId}.json`),
              encodeUnknownJsonString({
                id: partId,
                sessionID: 'ses_imported',
                messageID: 'msg_002',
                type: 'tool',
                callID: `call_${status}`,
                tool: 'bash',
                state: {
                  status,
                  input: { command: `private-${status}-command` },
                  title: `${status} tool must remain unfinished`,
                  ...(status === 'running'
                    ? {
                        time: {
                          start: 1767225600000,
                        },
                      }
                    : {}),
                },
              }),
            ),
          )
        }

        const loaded = yield* loadOpenCodeSessionFromMetadata(sourcePath)
        const serializedRecords = encodeUnknownJsonString(loaded.session.records)

        expect(serializedRecords).not.toContain('private-pending-command')
        expect(serializedRecords).not.toContain('private-running-command')
        expect(serializedRecords).not.toContain('pending tool must remain unfinished')
        expect(serializedRecords).not.toContain('running tool must remain unfinished')
        expect(
          loaded.session.records.filter(
            (record) =>
              record.kind === 'activity' &&
              record.activityKind === 'tool.completed' &&
              (record.payload.status === 'pending' || record.payload.status === 'running'),
          ),
        ).toEqual([])
        expect(loaded.session.warnings).toEqual(
          expect.arrayContaining([
            expect.stringContaining("incomplete tool status 'pending'"),
            expect.stringContaining("incomplete tool status 'running'"),
          ]),
        )
        expect(loaded.session.records.at(-1)).toMatchObject({
          kind: 'activity',
          tone: 'error',
          activityKind: 'task.completed',
          payload: {
            importWarningCount: 2,
            omittedWarningCount: 0,
          },
        })
      }),
  )

  it.effect('hashes the complete sorted bundle deterministically for idempotent imports', () =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const sourcePath = NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json')
      const first = yield* loadOpenCodeSessionFromMetadata(sourcePath)
      const second = yield* loadOpenCodeSessionFromMetadata(sourcePath)

      expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(second.contentHash).toBe(first.contentHash)

      const administrativePart = NodePath.join(storageRoot, 'part', 'msg_002', 'prt_007.json')
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          administrativePart,
          encodeUnknownJsonString({
            id: 'prt_007',
            sessionID: 'ses_imported',
            messageID: 'msg_002',
            type: 'step-start',
            snapshot: 'complete-bundle-hash-probe',
          }),
        ),
      )
      const changed = yield* loadOpenCodeSessionFromMetadata(sourcePath)

      expect(changed.contentHash).not.toBe(first.contentHash)
      expect(changed.session.records).toEqual(first.session.records)
      expect(changed.modifiedAt >= first.modifiedAt).toBe(true)
    }),
  )

  it.effect('enforces aggregate byte and JSON-file budgets across the whole bundle', () =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const sourcePath = NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json')

      const byteLimited = yield* loadOpenCodeSessionFromMetadata(sourcePath, {
        maximumBytes: 500,
      }).pipe(Effect.result)
      const fileLimited = yield* loadOpenCodeSessionFromMetadata(sourcePath, {
        maximumJsonFiles: 2,
      }).pipe(Effect.result)

      expect(byteLimited._tag).toBe('Failure')
      if (byteLimited._tag === 'Failure')
      {
        expect(byteLimited.failure.detail).toContain('byte budget exceeded')
      }
      expect(fileLimited._tag).toBe('Failure')
      if (fileLimited._tag === 'Failure')
      {
        expect(fileLimited.failure.detail).toContain('exceeds 2 JSON files')
      }
    }),
  )

  it.effect('shares one JSON-file budget across multiple session loads', () =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const sourcePath = NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json')
      const baseline = yield* loadOpenCodeSessionFromMetadata(sourcePath)
      const requestFileBudget = makeImportCountBudget(baseline.fileCount)

      yield* loadOpenCodeSessionFromMetadata(sourcePath, {
        jsonFileBudget: requestFileBudget,
      })
      const second = yield* loadOpenCodeSessionFromMetadata(sourcePath, {
        jsonFileBudget: requestFileBudget,
      }).pipe(Effect.result)

      expect(requestFileBudget.consumedCount).toBe(baseline.fileCount)
      expect(second._tag).toBe('Failure')
      if (second._tag === 'Failure')
      {
        expect(second.failure.detail).toContain(`exceeds ${baseline.fileCount} JSON files`)
      }
    }),
  )

  it.effect('applies candidate and traversal limits during OpenCode enumeration', () =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const secondProject = NodePath.join(storageRoot, 'session', 'prj_second')
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(secondProject, { recursive: true })
        await NodeFSP.writeFile(
          NodePath.join(secondProject, 'ses_second.json'),
          encodeUnknownJsonString({
            id: 'ses_second',
            projectID: 'prj_second',
            directory: '/workspace/second',
          }),
        )
      })
      const candidateBudget = makeImportCountBudget(1)
      const candidates = yield* discoverOpenCodeSessionMetadataFiles(storageRoot, {
        candidateBudget,
      })
      const traversalBudget = makeImportCountBudget(1)
      const traversalResult = yield* discoverOpenCodeSessionMetadataFiles(storageRoot, {
        traversalBudget,
      }).pipe(Effect.result)

      expect(candidates).toHaveLength(1)
      expect(candidateBudget.truncated).toBe(true)
      expect(traversalResult._tag).toBe('Success')
      expect(traversalBudget.truncated).toBe(true)
    }),
  )

  it.effect('rejects metadata outside the native storage layout', () =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const misplaced = NodePath.join(storageRoot, 'ses_misplaced.json')
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          misplaced,
          '{"id":"ses_misplaced","directory":"/workspace","title":"misplaced"}',
        ),
      )

      const result = yield* loadOpenCodeSessionFromMetadata(misplaced).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Success')
      {
        throw new Error('expected misplaced OpenCode metadata to fail')
      }
      expect(result.failure.operation).toBe('layout')
      expect(result.failure.detail).toContain('storage/session/<project>/<session>.json layout')
    }),
  )

  it.effect.each([
    {
      label: 'metadata filename disagrees with native session id',
      metadata: {
        id: 'ses_different',
        projectID: 'prj_fixture',
        directory: '/workspace/opencode-fixture',
        title: 'Mismatched metadata',
        version: '1.2.3',
        time: {
          created: 1767225600000,
          updated: 1767225601000,
        },
      },
      expectedWarnings: [
        'session metadata id does not match its storage filename',
        'no valid session metadata found; session was not imported',
      ],
    },
    {
      label: 'metadata project id disagrees with enclosing directory',
      metadata: {
        id: 'ses_imported',
        projectID: 'prj_other',
        directory: '/workspace/opencode-fixture',
        title: 'Mismatched project metadata',
        version: '1.2.3',
        time: {
          created: 1767225600000,
          updated: 1767225601000,
        },
      },
      expectedWarnings: [
        'session metadata project id does not match its enclosing storage directory',
        'no valid session metadata found; session was not imported',
      ],
    },
  ])('rejects OpenCode metadata when $label', ({ metadata, expectedWarnings }) =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const sourcePath = NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json')
      yield* Effect.promise(() => NodeFSP.writeFile(sourcePath, encodeUnknownJsonString(metadata)))

      const loaded = yield* loadOpenCodeSessionFromMetadata(sourcePath)
      expect(loaded.session.meta.nativeSessionId).toBeNull()
      expect(loaded.session.records).toEqual([])
      expect(loaded.session.warnings).toEqual(expect.arrayContaining(expectedWarnings))
    }),
  )

  it.effect('rejects corrupt part filenames and every duplicate part id', () =>
    Effect.gen(function* ()
    {
      const storageRoot = yield* Effect.promise(() => temporaryStorage())
      const sourcePath = NodePath.join(storageRoot, 'session', 'prj_fixture', 'ses_imported.json')
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(storageRoot, 'part', 'msg_002', 'prt_corrupt.json'),
          encodeUnknownJsonString({
            id: 'prt_not_the_filename',
            sessionID: 'ses_imported',
            messageID: 'msg_002',
            type: 'text',
            text: 'corrupt part content',
          }),
        ),
      )
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(storageRoot, 'part', 'msg_001', 'prt_005.json'),
          encodeUnknownJsonString({
            id: 'prt_005',
            sessionID: 'ses_imported',
            messageID: 'msg_001',
            type: 'text',
            text: 'duplicate part content',
          }),
        ),
      )

      const loaded = yield* loadOpenCodeSessionFromMetadata(sourcePath)
      const serializedRecords = encodeUnknownJsonString(loaded.session.records)

      expect(serializedRecords).not.toContain('corrupt part content')
      expect(serializedRecords).not.toContain('duplicate part content')
      expect(serializedRecords).not.toContain('The OpenCode importer is ready.')
      expect(loaded.session.warnings).toEqual(
        expect.arrayContaining([
          "part 'part/msg_002/prt_corrupt.json' id does not match its filename and was skipped",
          "duplicate OpenCode part id 'prt_005' was skipped",
        ]),
      )
    }),
  )

  it.effect('rejects message-directory and part-file symlink escapes from storage', () =>
    Effect.gen(function* ()
    {
      const messageEscapeStorage = yield* Effect.promise(() => temporaryStorage())
      const escapedMessageDirectory = NodePath.join(
        NodePath.dirname(messageEscapeStorage),
        'escaped-message-directory',
      )
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(escapedMessageDirectory)
        await NodeFSP.writeFile(
          NodePath.join(escapedMessageDirectory, 'msg_escaped.json'),
          encodeUnknownJsonString({
            id: 'msg_escaped',
            sessionID: 'ses_imported',
            role: 'user',
            time: { created: 1767225600000 },
          }),
        )
        const nativeMessageDirectory = NodePath.join(
          messageEscapeStorage,
          'message',
          'ses_imported',
        )
        await NodeFSP.rm(nativeMessageDirectory, { recursive: true })
        await NodeFSP.symlink(escapedMessageDirectory, nativeMessageDirectory)
      })

      const escapedDirectoryResult = yield* loadOpenCodeSessionFromMetadata(
        NodePath.join(messageEscapeStorage, 'session', 'prj_fixture', 'ses_imported.json'),
      ).pipe(Effect.result)
      expect(escapedDirectoryResult._tag).toBe('Failure')
      if (escapedDirectoryResult._tag === 'Success')
      {
        throw new Error('expected escaped OpenCode message directory to fail')
      }
      expect(escapedDirectoryResult.failure.operation).toBe('layout')
      expect(escapedDirectoryResult.failure.detail).toBe(
        'OpenCode transcript path escapes its storage root',
      )

      const partEscapeStorage = yield* Effect.promise(() => temporaryStorage())
      const escapedPartFile = NodePath.join(
        NodePath.dirname(partEscapeStorage),
        'escaped-part.json',
      )
      yield* Effect.promise(async () =>
      {
        await NodeFSP.writeFile(
          escapedPartFile,
          encodeUnknownJsonString({
            id: 'prt_escaped',
            sessionID: 'ses_imported',
            messageID: 'msg_002',
            type: 'text',
            text: 'escaped part content',
          }),
        )
        await NodeFSP.symlink(
          escapedPartFile,
          NodePath.join(partEscapeStorage, 'part', 'msg_002', 'prt_escaped.json'),
        )
      })

      const escapedFileResult = yield* loadOpenCodeSessionFromMetadata(
        NodePath.join(partEscapeStorage, 'session', 'prj_fixture', 'ses_imported.json'),
      ).pipe(Effect.result)
      expect(escapedFileResult._tag).toBe('Failure')
      if (escapedFileResult._tag === 'Success')
      {
        throw new Error('expected escaped OpenCode part file to fail')
      }
      expect(escapedFileResult.failure.operation).toBe('layout')
      expect(escapedFileResult.failure.detail).toBe(
        'OpenCode transcript path escapes its storage root',
      )
    }),
  )
})
