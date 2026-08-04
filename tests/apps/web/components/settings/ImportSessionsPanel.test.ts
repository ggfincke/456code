// tests/apps/web/components/settings/ImportSessionsPanel.test.ts
// verifies bounded rendering, exact provider selection, and import announcements
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ImportScanCandidate,
  type ImportSessionsResult,
  type ServerProvider,
} from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import {
  boundImportCandidateGroups,
  candidateMessageCountLabel,
  IMPORT_CANDIDATE_PAGE_SIZE,
  importRequestItemForCandidate,
  importSessionsAnnouncement,
  nextImportCandidateVisibleCount,
  resolveCandidateProviderSelection,
} from '../../../../../apps/web/src/components/settings/ImportSessionsPanel'
import { deriveProviderInstanceEntries } from '../../../../../apps/web/src/providerInstances'

const now = '2026-07-25T12:00:00.000Z'

function candidate(
  providerInstanceIds: ReadonlyArray<string>,
  sourcePath = '/tmp/.codex/sessions/session.jsonl',
): ImportScanCandidate
{
  return {
    source: 'codex-cli',
    sourcePath,
    providerInstanceIds: providerInstanceIds.map((instanceId) =>
      ProviderInstanceId.make(instanceId),
    ),
    nativeSessionId: 'native-session',
    title: 'Imported work',
    cwd: '/tmp/project',
    gitBranch: 'main',
    model: 'gpt-5.4',
    messageCount: 4,
    modifiedAt: now,
    alreadyImportedThreadId: null,
    alreadyImportedProviderInstanceId: null,
    alreadyImportedArchived: false,
    matchedProjectId: ProjectId.make('project-1'),
    resumable: true,
  }
}

function provider(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider
{
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make('codex'),
    displayName: instanceId === 'codex_personal' ? 'Personal Codex' : 'Codex',
    enabled: true,
    installed: true,
    version: '1.0.0',
    status: 'ready',
    auth: { status: 'authenticated' },
    checkedAt: now,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }
}

describe('candidate rendering window', () =>
{
  it('bounds the initial rows and expands one accessible page at a time across groups', () =>
  {
    const candidates = Array.from({ length: 120 }, (_, index) =>
      candidate(['codex'], `/tmp/.codex/sessions/session-${index}.jsonl`),
    )
    const groups = [
      {
        key: 'project:first',
        title: 'First project',
        candidates: candidates.slice(0, 40),
      },
      {
        key: 'project:second',
        title: 'Second project',
        candidates: candidates.slice(40),
      },
    ]

    const initial = boundImportCandidateGroups(groups, IMPORT_CANDIDATE_PAGE_SIZE)
    expect(initial.visibleCandidateCount).toBe(50)
    expect(initial.hiddenCandidateCount).toBe(70)
    expect(initial.groups.map((group) => group.candidates.length)).toEqual([40, 10])

    const expandedCount = nextImportCandidateVisibleCount(
      initial.visibleCandidateCount,
      candidates.length,
    )
    const expanded = boundImportCandidateGroups(groups, expandedCount)
    expect(expanded.visibleCandidateCount).toBe(100)
    expect(expanded.hiddenCandidateCount).toBe(20)
    expect(expanded.groups.map((group) => group.candidates.length)).toEqual([40, 60])

    const complete = boundImportCandidateGroups(
      groups,
      nextImportCandidateVisibleCount(expanded.visibleCandidateCount, candidates.length),
    )
    expect(complete.visibleCandidateCount).toBe(120)
    expect(complete.hiddenCandidateCount).toBe(0)
    expect(complete.groups.map((group) => group.candidates.length)).toEqual([40, 80])
  })
})

describe('candidate transcript summaries', () =>
{
  it('omits unknown catalog counts without inventing a zero-message session', () =>
  {
    expect(candidateMessageCountLabel(null)).toBeNull()
  })
})

describe('resolveCandidateProviderSelection', () =>
{
  it('safely selects the sole exact compatible provider without returning null', () =>
  {
    const entries = deriveProviderInstanceEntries([provider('codex_personal')])

    expect(
      resolveCandidateProviderSelection(candidate(['codex_personal']), entries, null),
    ).toMatchObject({
      providerInstanceId: ProviderInstanceId.make('codex_personal'),
      blockedReason: null,
    })
  })

  it('requires an explicit exact choice when multiple compatible instances exist', () =>
  {
    const entries = deriveProviderInstanceEntries([provider('codex'), provider('codex_personal')])
    const importCandidate = candidate(['codex', 'codex_personal'])

    expect(resolveCandidateProviderSelection(importCandidate, entries, null)).toMatchObject({
      providerInstanceId: null,
      blockedReason: null,
    })
    expect(
      resolveCandidateProviderSelection(
        importCandidate,
        entries,
        ProviderInstanceId.make('codex_personal'),
      ),
    ).toMatchObject({
      providerInstanceId: ProviderInstanceId.make('codex_personal'),
      blockedReason: null,
    })
  })

  it('rejects missing and unavailable exact instances instead of substituting by driver', () =>
  {
    const entries = deriveProviderInstanceEntries([
      provider('codex'),
      provider('codex_personal', {
        availability: 'unavailable',
        enabled: false,
        installed: false,
        status: 'disabled',
      }),
    ])
    const result = resolveCandidateProviderSelection(
      candidate(['codex_personal']),
      entries,
      ProviderInstanceId.make('codex'),
    )

    expect(result.providerInstanceId).toBeNull()
    expect(result.blockedReason).toContain('missing, disabled, or unavailable')
    expect(result.options).toEqual([
      expect.objectContaining({
        instanceId: ProviderInstanceId.make('codex_personal'),
        selectable: false,
      }),
    ])
  })

  it('excludes a reused instance id when the live provider has the wrong driver', () =>
  {
    const reusedInstanceId = ProviderInstanceId.make('codex_personal')
    const entries = deriveProviderInstanceEntries([
      provider('codex_personal', {
        driver: ProviderDriverKind.make('claudeAgent'),
        displayName: 'Claude Personal',
      }),
    ])

    const result = resolveCandidateProviderSelection(
      candidate(['codex_personal']),
      entries,
      reusedInstanceId,
    )

    expect(result).toMatchObject({
      providerInstanceId: null,
      blockedReason: 'Compatible provider instances are missing, disabled, or unavailable.',
      options: [
        {
          entry: null,
          instanceId: reusedInstanceId,
          selectable: false,
        },
      ],
    })
  })

  it('builds an exact repair request for an already-imported candidate', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex_personal')
    const alreadyImported = {
      ...candidate(['codex_personal']),
      alreadyImportedThreadId: ThreadId.make('thread-partially-imported'),
      alreadyImportedProviderInstanceId: providerInstanceId,
    }

    expect(importRequestItemForCandidate(alreadyImported, providerInstanceId)).toEqual({
      source: 'codex-cli',
      sourcePath: '/tmp/.codex/sessions/session.jsonl',
      providerInstanceId,
    })
    expect(importRequestItemForCandidate(alreadyImported, null)).toBeNull()
    expect(
      importRequestItemForCandidate(alreadyImported, ProviderInstanceId.make('codex')),
    ).toBeNull()
  })

  it('never builds a repair request for an archived imported thread', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex_personal')
    const archivedImport = {
      ...candidate(['codex_personal']),
      alreadyImportedThreadId: ThreadId.make('thread-archived'),
      alreadyImportedProviderInstanceId: providerInstanceId,
      alreadyImportedArchived: true,
    }

    expect(importRequestItemForCandidate(archivedImport, providerInstanceId)).toBeNull()
  })

  it('never builds an import request for a zero-message artifact', () =>
  {
    const providerInstanceId = ProviderInstanceId.make('codex')
    const emptyArtifact = {
      ...candidate(['codex']),
      messageCount: 0,
    }

    expect(importRequestItemForCandidate(emptyArtifact, providerInstanceId)).toBeNull()
  })

  it('locks a multi-instance repair to the original exact provider owner after rescan', () =>
  {
    const originalOwner = ProviderInstanceId.make('codex_personal')
    const alreadyImported = {
      ...candidate(['codex', 'codex_personal']),
      alreadyImportedThreadId: ThreadId.make('thread-partially-imported'),
      alreadyImportedProviderInstanceId: originalOwner,
    }
    const entries = deriveProviderInstanceEntries([provider('codex'), provider('codex_personal')])

    expect(
      resolveCandidateProviderSelection(alreadyImported, entries, ProviderInstanceId.make('codex')),
    ).toMatchObject({
      providerInstanceId: originalOwner,
      options: [
        {
          instanceId: originalOwner,
          selectable: true,
        },
      ],
    })
  })
})

describe('importSessionsAnnouncement', () =>
{
  it('announces acknowledged progress and stop-after-batch state', () =>
  {
    const base = {
      candidateCount: 5_188,
      hasScanned: true,
      importError: null,
      importResult: null,
      isImporting: true,
      isScanning: false,
      scanError: null,
      scanTruncated: false,
    } as const

    expect(
      importSessionsAnnouncement({
        ...base,
        importProgress: {
          phase: 'running',
          total: 5_188,
          completed: 50,
          imported: 49,
          skipped: 1,
          failed: 0,
        },
      }),
    ).toBe('Importing selected sessions. 50 of 5188 processed.')
    expect(
      importSessionsAnnouncement({
        ...base,
        importProgress: {
          phase: 'stopping',
          total: 5_188,
          completed: 50,
          imported: 49,
          skipped: 1,
          failed: 0,
        },
      }),
    ).toBe('Stopping after the current batch. 50 of 5188 sessions processed.')
  })

  it('announces the partial outcome when an import is stopped', () =>
  {
    expect(
      importSessionsAnnouncement({
        candidateCount: 5_188,
        hasScanned: true,
        importError: null,
        importProgress: {
          phase: 'cancelled',
          total: 5_188,
          completed: 75,
          imported: 70,
          skipped: 3,
          failed: 2,
        },
        importResult: {
          imported: [],
          skipped: [],
          failed: [],
        },
        isImporting: false,
        isScanning: false,
        scanError: null,
        scanTruncated: false,
      }),
    ).toBe('Import stopped after 75 of 5188 sessions. 70 imported, 3 skipped, 2 failed.')
  })

  it('announces complete imported, skipped, and failed outcome counts', () =>
  {
    const result = {
      imported: [
        {
          sourcePath: '/tmp/imported.jsonl',
          threadId: ThreadId.make('thread-1'),
          projectId: ProjectId.make('project-1'),
          messageCount: 4,
          activityCount: 2,
          continuation: {
            state: 'verified',
            providerInstanceId: ProviderInstanceId.make('codex'),
            continuationIdentity: {
              driverKind: ProviderDriverKind.make('codex'),
              continuationKey: 'codex:test-source',
            },
            reason: null,
          },
        },
      ],
      skipped: [
        {
          sourcePath: '/tmp/skipped.jsonl',
          reason: 'Already imported.',
          threadId: null,
        },
      ],
      failed: [
        {
          sourcePath: '/tmp/failed.jsonl',
          message: 'Could not parse.',
        },
      ],
    } satisfies ImportSessionsResult

    expect(
      importSessionsAnnouncement({
        candidateCount: 3,
        hasScanned: true,
        importError: null,
        importResult: result,
        isImporting: false,
        isScanning: false,
        scanError: null,
        scanTruncated: false,
      }),
    ).toBe('Import complete. 1 imported, 1 skipped, 1 failed.')
  })

  it('announces failures ahead of stale candidate counts', () =>
  {
    expect(
      importSessionsAnnouncement({
        candidateCount: 9,
        hasScanned: true,
        importError: null,
        importResult: null,
        isImporting: false,
        isScanning: false,
        scanError: 'The source root is unavailable.',
        scanTruncated: false,
      }),
    ).toBe('Scan failed: The source root is unavailable.')
  })

  it('announces when a successful scan returned only a partial catalog', () =>
  {
    expect(
      importSessionsAnnouncement({
        candidateCount: 10_000,
        hasScanned: true,
        importError: null,
        importResult: null,
        isImporting: false,
        isScanning: false,
        scanError: null,
        scanTruncated: true,
      }),
    ).toBe('10000 sessions found. Results may be incomplete.')
  })
})
