// tests/apps/server/import/discovery.test.ts
// verifies lightweight session catalogs across file and acp source layouts

// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off

import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

import {
  DEFAULT_SERVER_SETTINGS,
  IMPORT_SCAN_MAX_CANDIDATES,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  ThreadId,
} from '@t3tools/contracts'
import { afterEach, describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'

import type { AcpImportCatalogEntry } from '../../../../apps/server/src/import/parsers/acpImport.ts'
import {
  ImportDiscoveryDeps,
  make,
} from '../../../../apps/server/src/import/discovery/discovery.ts'

const temporaryPaths: string[] = []
const fixtureRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL('./fixtures', import.meta.url)))
const CURSOR = ProviderDriverKind.make('cursor')
const CODEX_DEFAULT = ProviderInstanceId.make('codex')
const CLAUDE_DEFAULT = ProviderInstanceId.make('claudeAgent')
const OPENCODE_DEFAULT = ProviderInstanceId.make('opencode')
const DISCOVERY_PATH = '/usr/bin:/bin'
const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString)

function codexSessionContent(nativeSessionId: string): string
{
  return [
    `{"timestamp":"2026-02-03T00:00:00Z","type":"session_meta","payload":{"id":"${nativeSessionId}","cwd":"/workspace/catalog","git":{"branch":"main"}}}`,
    '{"timestamp":"2026-02-03T00:00:01Z","type":"turn_context","payload":{"cwd":"/workspace/catalog","model":"gpt-5.6"}}',
    `{"timestamp":"2026-02-03T00:00:02Z","type":"event_msg","payload":{"type":"user_message","message":"${nativeSessionId}"}}`,
  ].join('\n')
}

function cursorCatalogEntry(
  providerInstanceId: ProviderInstanceId,
  nativeSessionId: string,
): AcpImportCatalogEntry
{
  return {
    driverKind: 'cursor',
    providerInstanceId,
    source: 'cursor-acp',
    sourcePath: `acp://cursor/${encodeURIComponent(
      providerInstanceId,
    )}/${encodeURIComponent(nativeSessionId)}`,
    nativeSessionId,
    cwd: '/workspace/cursor',
    title: `Cursor ${nativeSessionId}`,
    updatedAt: '2026-02-03T00:00:02.000Z',
  }
}

function isolatedImportSettings(
  providerInstances: ServerSettings['providerInstances'],
): ServerSettings
{
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        enabled: false,
      },
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        enabled: false,
      },
      cursor: {
        ...DEFAULT_SERVER_SETTINGS.providers.cursor,
        enabled: false,
      },
      grok: {
        ...DEFAULT_SERVER_SETTINGS.providers.grok,
        enabled: false,
      },
      opencode: {
        ...DEFAULT_SERVER_SETTINGS.providers.opencode,
        enabled: false,
      },
      coral: {
        ...DEFAULT_SERVER_SETTINGS.providers.coral,
        enabled: false,
      },
    },
    providerInstances,
  }
}

async function temporaryHome(): Promise<string>
{
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), '456code-import-discovery-'))
  temporaryPaths.push(path)
  return path
}

function defaultDeps(
  overrides: Partial<Parameters<typeof ImportDiscoveryDeps.of>[0]> = {},
): ReturnType<typeof ImportDiscoveryDeps.of>
{
  return ImportDiscoveryDeps.of({
    findImportedThread: () => Effect.succeed(null),
    findProjectByWorkspaceRoot: () => Effect.succeed(null),
    normalizeWorkspaceRoot: (root) => Effect.succeed(root),
    scanAcpSource: () => Effect.succeed([]),
    ...overrides,
  })
}

afterEach(async () =>
{
  await Promise.all(temporaryPaths.splice(0).map((path) => NodeFSP.rm(path, { recursive: true })))
})

describe('ImportDiscovery', () =>
{
  it.effect('catalogs metadata and exactly counts a bounded unresolved tail', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const codexDirectory = NodePath.join(homePath, '.codex', 'sessions', '2026', '02', '03')
      const claudeDirectory = NodePath.join(homePath, '.claude', 'projects', 'repo')
      const claudeSessionId = '123e4567-e89b-42d3-a456-426614174000'
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(codexDirectory, { recursive: true })
        await NodeFSP.mkdir(claudeDirectory, { recursive: true })
        await NodeFSP.writeFile(
          NodePath.join(codexDirectory, 'rollout-2026-02-03-codex-session.jsonl'),
          codexSessionContent('codex-session'),
        )
        const claudeFixture = await NodeFSP.readFile(
          NodePath.join(fixtureRoot, 'claude-session-basic.jsonl'),
          'utf8',
        )
        await NodeFSP.writeFile(
          NodePath.join(claudeDirectory, `${claudeSessionId}.jsonl`),
          claudeFixture.replaceAll('123e4567-e89b-12d3-a456-426614174000', claudeSessionId),
        )
      })

      const importedThreadId = ThreadId.make('already-imported')
      const projectId = ProjectId.make('matched-project')
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          defaultDeps({
            findImportedThread: ({ nativeSessionId }) =>
              Effect.succeed(
                nativeSessionId === 'codex-session'
                  ? {
                      threadId: importedThreadId,
                      providerInstanceId: CODEX_DEFAULT,
                      archived: true,
                    }
                  : null,
              ),
            findProjectByWorkspaceRoot: (root) =>
              Effect.succeed(root === '/workspace/catalog' ? projectId : null),
          }),
        ),
      )

      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      })

      expect(result.truncated).toBe(false)
      expect(result.errors).toEqual([])
      expect(result.candidates).toHaveLength(2)
      expect(result.candidates.find((candidate) => candidate.source === 'codex-cli')).toMatchObject(
        {
          providerInstanceIds: [CODEX_DEFAULT],
          nativeSessionId: 'codex-session',
          cwd: '/workspace/catalog',
          gitBranch: 'main',
          model: 'gpt-5.6',
          messageCount: null,
          alreadyImportedThreadId: importedThreadId,
          alreadyImportedArchived: true,
          matchedProjectId: projectId,
          resumable: true,
        },
      )
      expect(
        result.candidates.find((candidate) => candidate.source === 'claude-code'),
      ).toMatchObject({
        providerInstanceIds: [CLAUDE_DEFAULT],
        nativeSessionId: claudeSessionId,
        messageCount: 2,
        resumable: true,
      })
    }),
  )

  it.effect("keeps a forked top-level Codex rollout's own catalog identity", () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const codexDirectory = NodePath.join(homePath, '.codex', 'sessions', '2026', '02', '03')
      const forkedSessionId = '123e4567-e89b-42d3-a456-426614174010'
      const parentSessionId = '123e4567-e89b-42d3-a456-426614174011'
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(codexDirectory, { recursive: true })
        await NodeFSP.writeFile(
          NodePath.join(codexDirectory, `rollout-2026-02-03T00-00-00-${forkedSessionId}.jsonl`),
          [
            encodeUnknownJsonString({
              timestamp: '2026-02-03T00:00:00Z',
              type: 'session_meta',
              payload: {
                id: forkedSessionId,
                cwd: '/workspace/catalog',
                git: { branch: 'main' },
                forked_from_id: parentSessionId,
              },
            }),
            '{"timestamp":"2026-02-03T00:00:01Z","type":"turn_context","payload":{"cwd":"/workspace/catalog","model":"gpt-5.6"}}',
            `{"timestamp":"2026-02-03T00:00:02Z","type":"event_msg","payload":{"type":"user_message","message":"${forkedSessionId}"}}`,
            `{"timestamp":"2026-02-03T00:00:03Z","type":"session_meta","payload":{"id":"${parentSessionId}","cwd":"/workspace/copied-parent","git":{"branch":"copied-parent"}}}`,
          ].join('\n'),
        )
      })

      const discovery = yield* make.pipe(Effect.provideService(ImportDiscoveryDeps, defaultDeps()))
      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      })
      const candidate = result.candidates.find((entry) => entry.nativeSessionId === forkedSessionId)

      expect(candidate).toMatchObject({
        source: 'codex-cli',
        nativeSessionId: forkedSessionId,
        cwd: '/workspace/catalog',
        gitBranch: 'main',
        resumable: true,
      })
      expect(result.candidates.some((entry) => entry.nativeSessionId === parentSessionId)).toBe(
        false,
      )
    }),
  )

  it.effect('catalogs legacy compact Codex header identity before exact tail parsing', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const codexDirectory = NodePath.join(homePath, '.codex', 'sessions', '2025', '09', '15')
      const nativeSessionId = '123e4567-e89b-42d3-a456-426614174020'
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(codexDirectory, { recursive: true })
        await NodeFSP.writeFile(
          NodePath.join(codexDirectory, `rollout-2025-09-15T15-42-56-${nativeSessionId}.jsonl`),
          [
            `{"id":"${nativeSessionId}","timestamp":"2025-09-15T19:42:56.906Z","instructions":null,"git":{"branch":"legacy-branch"}}`,
            '{"record_type":"state"}',
            '{"type":"message","role":"user","content":[{"type":"input_text","text":"legacy prompt"}]}',
          ].join('\n'),
        )
      })
      const discovery = yield* make.pipe(Effect.provideService(ImportDiscoveryDeps, defaultDeps()))

      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      })

      expect(result.errors).toEqual([])
      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: 'codex-cli',
          nativeSessionId,
          gitBranch: 'legacy-branch',
          messageCount: 1,
          resumable: true,
        }),
      ])
    }),
  )

  it.effect('catalogs flat Codex archives and excludes Codex and Claude child sessions', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const archiveDirectory = NodePath.join(homePath, '.codex', 'archived_sessions')
      const codexDirectory = NodePath.join(homePath, '.codex', 'sessions', '2026', '02', '03')
      const archivedSessionId = '123e4567-e89b-42d3-a456-426614174001'
      const archivedPath = NodePath.join(
        archiveDirectory,
        `rollout-2026-02-03T00-00-00-${archivedSessionId}.jsonl`,
      )
      const projectRoot = NodePath.join(homePath, '.claude', 'projects', 'repo')
      const parentSessionId = '123e4567-e89b-42d3-a456-426614174002'
      const subagentsRoot = NodePath.join(projectRoot, parentSessionId, 'subagents')
      const directAgentPath = NodePath.join(subagentsRoot, 'agent-direct_1.jsonl')
      const workflowRoot = NodePath.join(subagentsRoot, 'workflows', 'wf_123-test')
      const workflowAgentPath = NodePath.join(workflowRoot, 'agent-workflow_1.jsonl')
      const spawnedSubagentId = '123e4567-e89b-42d3-a456-426614174003'
      const transitionalSubagentId = '123e4567-e89b-42d3-a456-426614174004'
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(archiveDirectory, { recursive: true })
        await NodeFSP.mkdir(codexDirectory, { recursive: true })
        await NodeFSP.mkdir(workflowRoot, { recursive: true })
        await NodeFSP.writeFile(archivedPath, codexSessionContent(archivedSessionId))
        await NodeFSP.writeFile(
          directAgentPath,
          '{"isSidechain":true,"agentId":"direct_1","type":"user"}',
        )
        await NodeFSP.writeFile(
          workflowAgentPath,
          '{"isSidechain":true,"agentId":"workflow_1","type":"user"}',
        )
        await NodeFSP.writeFile(
          NodePath.join(codexDirectory, `rollout-2026-02-03T00-00-00-${spawnedSubagentId}.jsonl`),
          [
            encodeUnknownJsonString({
              timestamp: '2026-02-03T00:00:00Z',
              type: 'session_meta',
              payload: {
                id: spawnedSubagentId,
                cwd: '/workspace/spawned-child',
                source: {
                  subagent: {
                    thread_spawn: {
                      parent_thread_id: archivedSessionId,
                      depth: 1,
                    },
                  },
                },
              },
            }),
            `{"timestamp":"2026-02-03T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"${spawnedSubagentId}"}}`,
          ].join('\n'),
        )
        await NodeFSP.writeFile(
          NodePath.join(
            codexDirectory,
            `rollout-2026-02-03T00-00-01-${transitionalSubagentId}.jsonl`,
          ),
          [
            encodeUnknownJsonString({
              timestamp: '2026-02-03T00:00:00Z',
              type: 'session_meta',
              payload: {
                id: transitionalSubagentId,
                cwd: '/workspace/transitional-child',
                source: 'vscode',
                thread_source: 'subagent',
              },
            }),
            `{"timestamp":"2026-02-03T00:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"${transitionalSubagentId}"}}`,
          ].join('\n'),
        )
      })
      const discovery = yield* make.pipe(Effect.provideService(ImportDiscoveryDeps, defaultDeps()))

      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      })

      expect(result.truncated).toBe(false)
      expect(result.errors).toEqual([])
      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: 'codex-cli',
          nativeSessionId: archivedSessionId,
          resumable: false,
        }),
      ])
    }),
  )

  it.effect('exactly classifies a large Codex session inside the tail byte budget', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const codexDirectory = NodePath.join(homePath, '.codex', 'sessions', '2026', '02', '03')
      const sourcePath = NodePath.join(codexDirectory, 'rollout-large-session.jsonl')
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(codexDirectory, { recursive: true })
        await NodeFSP.writeFile(sourcePath, `${codexSessionContent('large-session')}\n`)
        await NodeFSP.truncate(sourcePath, 25 * 1024 * 1024 + 1)
      })
      const discovery = yield* make.pipe(Effect.provideService(ImportDiscoveryDeps, defaultDeps()))

      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      })

      expect(result.truncated).toBe(false)
      expect(result.errors).toEqual([])
      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: 'codex-cli',
          nativeSessionId: 'large-session',
          messageCount: 1,
          resumable: true,
        }),
      ])
    }),
  )

  it.effect('classifies a malformed metadata-only probe as nonactionable', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const codexDirectory = NodePath.join(homePath, '.codex', 'sessions', '2026', '02', '03')
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(codexDirectory, { recursive: true })
        await NodeFSP.writeFile(
          NodePath.join(codexDirectory, 'rollout-malformed.jsonl'),
          '{not-json}\n'.repeat(10_000),
        )
      })
      const discovery = yield* make.pipe(Effect.provideService(ImportDiscoveryDeps, defaultDeps()))

      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      })

      expect(result.truncated).toBe(false)
      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: 'codex-cli',
          nativeSessionId: null,
          cwd: null,
          messageCount: 0,
          resumable: false,
        }),
      ])
    }),
  )

  it.effect('catalogs top-level OpenCode metadata and excludes child sessions', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const dataRoot = NodePath.join(homePath, 'xdg-data')
      const storageRoot = NodePath.join(dataRoot, 'opencode', 'storage')
      const metadataDirectory = NodePath.join(storageRoot, 'session', 'prj_fixture')
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(metadataDirectory, { recursive: true })
        const rootMetadata = decodeUnknownJsonString(
          await NodeFSP.readFile(
            NodePath.join(
              fixtureRoot,
              'opencode',
              'storage',
              'session',
              'prj_fixture',
              'ses_imported.json',
            ),
            'utf8',
          ),
        ) as Record<string, unknown>
        await NodeFSP.writeFile(
          NodePath.join(metadataDirectory, 'ses_imported.json'),
          encodeUnknownJsonString(rootMetadata),
        )
        await NodeFSP.writeFile(
          NodePath.join(metadataDirectory, 'ses_child.json'),
          encodeUnknownJsonString({
            ...rootMetadata,
            id: 'ses_child',
            parentID: 'ses_imported',
            title: 'OpenCode child session',
          }),
        )
      })
      const projectId = ProjectId.make('opencode-project')
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          defaultDeps({
            findProjectByWorkspaceRoot: (root) =>
              Effect.succeed(root === '/workspace/opencode-fixture' ? projectId : null),
          }),
        ),
      )

      const result = yield* discovery.scan(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            opencode: {
              ...DEFAULT_SERVER_SETTINGS.providers.opencode,
              enabled: true,
            },
          },
        },
        {
          environment: {
            HOME: homePath,
            PATH: DISCOVERY_PATH,
            XDG_DATA_HOME: dataRoot,
          },
          homePath,
          cwd: homePath,
        },
      )

      expect(result.truncated).toBe(false)
      expect(result.errors).toEqual([])
      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: 'opencode',
          providerInstanceIds: [OPENCODE_DEFAULT],
          nativeSessionId: 'ses_imported',
          title: 'OpenCode import fixture',
          cwd: '/workspace/opencode-fixture',
          model: null,
          messageCount: 0,
          matchedProjectId: projectId,
          resumable: true,
        }),
      ])
    }),
  )

  it.effect('catalogs ACP list entries without transcript replay payloads', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const cursorId = ProviderInstanceId.make('cursor_catalog')
      const nativeSessionId = 'cursor/session 1'
      const importedThreadId = ThreadId.make('cursor-imported')
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          defaultDeps({
            findImportedThread: ({ providerInstanceId }) =>
              Effect.succeed(
                providerInstanceId === cursorId
                  ? {
                      threadId: importedThreadId,
                      providerInstanceId: cursorId,
                      archived: false,
                    }
                  : null,
              ),
            scanAcpSource: () => Effect.succeed([cursorCatalogEntry(cursorId, nativeSessionId)]),
          }),
        ),
      )

      const result = yield* discovery.scan(
        isolatedImportSettings({
          [cursorId]: {
            driver: CURSOR,
            enabled: true,
            config: {},
          },
        }),
        {
          environment: { HOME: homePath, PATH: DISCOVERY_PATH },
          homePath,
          cwd: homePath,
        },
      )

      expect(result.truncated).toBe(false)
      expect(result.errors).toEqual([])
      expect(result.candidates).toEqual([
        expect.objectContaining({
          source: 'cursor',
          providerInstanceIds: [cursorId],
          nativeSessionId,
          title: `Cursor ${nativeSessionId}`,
          model: null,
          messageCount: null,
          alreadyImportedThreadId: importedThreadId,
          resumable: true,
        }),
      ])
    }),
  )

  it.effect('caps a lightweight catalog explicitly instead of presenting it as complete', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const cursorId = ProviderInstanceId.make('cursor_catalog_cap')
      const catalog = Array.from({ length: IMPORT_SCAN_MAX_CANDIDATES + 1 }, (_, index) =>
        cursorCatalogEntry(cursorId, `session-${index.toString().padStart(5, '0')}`),
      )
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          defaultDeps({
            scanAcpSource: () => Effect.succeed(catalog),
          }),
        ),
      )

      const result = yield* discovery.scan(
        isolatedImportSettings({
          [cursorId]: {
            driver: CURSOR,
            enabled: true,
            config: {},
          },
        }),
        {
          environment: { HOME: homePath, PATH: DISCOVERY_PATH },
          homePath,
          cwd: homePath,
        },
      )

      expect(result.candidates).toHaveLength(IMPORT_SCAN_MAX_CANDIDATES)
      expect(result.truncated).toBe(true)
      expect(result.errors).toContainEqual({
        sourcePath: null,
        message: `scan reached the ${IMPORT_SCAN_MAX_CANDIDATES}-session candidate catalog limit`,
      })
    }),
  )

  it.effect('marks results partial when an authorized candidate cannot be enriched', () =>
    Effect.gen(function* ()
    {
      const homePath = yield* Effect.promise(() => temporaryHome())
      const codexDirectory = NodePath.join(homePath, '.codex', 'sessions', '2026', '02', '03')
      const sourcePath = NodePath.join(codexDirectory, 'rollout-lookup-failure.jsonl')
      yield* Effect.promise(async () =>
      {
        await NodeFSP.mkdir(codexDirectory, { recursive: true })
        await NodeFSP.writeFile(sourcePath, codexSessionContent('lookup-failure'))
      })
      const discovery = yield* make.pipe(
        Effect.provideService(
          ImportDiscoveryDeps,
          defaultDeps({
            findImportedThread: () => Effect.fail(new Error('lookup failed')),
          }),
        ),
      )

      const result = yield* discovery.scan(DEFAULT_SERVER_SETTINGS, {
        environment: { PATH: DISCOVERY_PATH },
        homePath,
        cwd: homePath,
      })

      expect(result.candidates).toEqual([])
      expect(result.truncated).toBe(true)
      expect(result.errors).toEqual([
        {
          sourcePath: yield* Effect.promise(() => NodeFSP.realpath(sourcePath)),
          message: 'lookup failed',
        },
      ])
    }),
  )

  it.effect('serializes scans per service scope and isolates independent service scopes', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const homePath = yield* Effect.promise(() => temporaryHome())
        const cursorId = ProviderInstanceId.make('cursor_overlap')
        const firstScanStarted = yield* Deferred.make<void>()
        let scanCallCount = 0
        const deps = defaultDeps({
          scanAcpSource: () =>
            Effect.suspend(() =>
            {
              scanCallCount += 1
              return scanCallCount === 1
                ? Deferred.succeed(firstScanStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed([])
            }),
        })
        const firstDiscovery = yield* make.pipe(Effect.provideService(ImportDiscoveryDeps, deps))
        const secondDiscovery = yield* make.pipe(Effect.provideService(ImportDiscoveryDeps, deps))
        const settings = isolatedImportSettings({
          [cursorId]: {
            driver: CURSOR,
            enabled: true,
            config: {},
          },
        })
        const scanOptions = {
          environment: { HOME: homePath, PATH: DISCOVERY_PATH },
          homePath,
          cwd: homePath,
        }

        const firstFiber = yield* firstDiscovery.scan(settings, scanOptions).pipe(Effect.forkScoped)
        yield* Deferred.await(firstScanStarted)
        const overlappingResult = yield* firstDiscovery.scan(settings, scanOptions)

        expect(overlappingResult.candidates).toEqual([])
        expect(overlappingResult.truncated).toBe(true)
        expect(overlappingResult.errors).toEqual([
          {
            sourcePath: null,
            message: 'scan skipped because another import scan is already in progress',
          },
        ])
        expect(scanCallCount).toBe(1)

        const independentResult = yield* secondDiscovery.scan(settings, scanOptions)
        expect(independentResult.truncated).toBe(false)
        expect(independentResult.errors).toEqual([])
        expect(scanCallCount).toBe(2)

        yield* Fiber.interrupt(firstFiber)
        const resultAfterInterrupt = yield* firstDiscovery.scan(settings, scanOptions)
        expect(resultAfterInterrupt.truncated).toBe(false)
        expect(resultAfterInterrupt.errors).toEqual([])
        expect(scanCallCount).toBe(3)
      }),
    ),
  )
})
