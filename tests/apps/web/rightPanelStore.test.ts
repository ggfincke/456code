// tests/apps/web/rightPanelStore.test.ts
// verifies thread-scoped right-panel surface persistence and transitions
import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import {
  type ArchitectureGenerationId,
  type ArchitectureGraphDigest,
  type ArchitectureImpactDescriptor,
  type DiffAnalysisId,
  type EnvironmentId,
  type OrchestratePlanRunId,
  type OrchestrationProposedPlanId,
  type ProjectId,
  type ProposalGenerationId,
  type ProposalId,
  type ProposalRevisionId,
  ThreadId,
} from '@t3tools/contracts'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  migratePersistedRightPanelState,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from '../../../apps/web/src/rightPanelStore'
import {
  architectureFileSurfaceId,
  createArchitectureImpactSurface,
  createRepositoryAtlasSurface,
} from '../../../apps/web/src/components/architecture/architectureResourceIdentity'

const refA = scopeThreadRef('env-1' as EnvironmentId, ThreadId.make('thread-A'))
const refB = scopeThreadRef('env-1' as EnvironmentId, ThreadId.make('thread-B'))
const repositoryGenerationId = 'a'.repeat(64) as ArchitectureGenerationId
const repositoryGraphDigest = `sha256:${'b'.repeat(64)}` as ArchitectureGraphDigest
const baseGraphDigest = `sha256:${'c'.repeat(64)}` as ArchitectureGraphDigest
const headGraphDigest = `sha256:${'d'.repeat(64)}` as ArchitectureGraphDigest

function impactDescriptor(descriptorId: string): ArchitectureImpactDescriptor
{
  const projectionDigest = `sha256:${'e'.repeat(64)}` as ArchitectureGraphDigest
  return {
    version: 1,
    descriptorId,
    threadId: refA.threadId,
    projectId: 'project-1' as ProjectId,
    target: {
      kind: 'plan',
      plan: { _tag: 'plan', planId: 'plan:thread-A:turn:impact' },
      state: 'active',
    },
    verifiedCandidate: {
      authority: 'verified',
      source: {
        kind: 'verified-proposal-impact',
        threadId: refA.threadId,
        generationId: 'proposal-generation-1' as ProposalGenerationId,
        proposalId: 'proposal-1' as ProposalId,
        revisionId: 'proposal-1:1' as ProposalRevisionId,
        baseTreeOid: '1'.repeat(40),
        headTreeOid: '2'.repeat(40),
        baseGraphDigest,
        headGraphDigest,
        projectionDigest,
      },
      projectionId: `projection-${descriptorId}`,
      projectionRevision: 1,
      projectionDigest,
      resultState: 'graph',
      freshness: 'fresh',
      generatedAt: '2026-08-20T12:00:00.000Z',
      publishedAt: '2026-08-20T12:00:00.000Z',
    },
    defaultAuthority: 'verified',
    resolvedAt: '2026-08-20T12:00:00.000Z',
  }
}

beforeEach(() =>
{
  useRightPanelStore.setState({ byThreadKey: {} })
})

describe('rightPanelStore', () =>
{
  it('drops the legacy singleton terminal surface during migration', () =>
  {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          'env-1:thread-A': {
            activeSurfaceId: 'terminal',
            surfaces: [
              { id: 'browser:tab-a', kind: 'preview', resourceId: 'tab-a' },
              { id: 'terminal', kind: 'terminal' },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: 'browser:tab-a', kind: 'preview', resourceId: 'tab-a' }],
        },
      },
    })
  })

  it('upgrades saved single-session terminal surfaces to split-capable surfaces', () =>
  {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          'env-1:thread-A': {
            isOpen: true,
            activeSurfaceId: 'terminal:term-1',
            surfaces: [{ id: 'terminal:term-1', kind: 'terminal', resourceId: 'term-1' }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: true,
          activeSurfaceId: 'terminal:term-1',
          surfaces: [
            {
              id: 'terminal:term-1',
              kind: 'terminal',
              resourceId: 'term-1',
              terminalIds: ['term-1'],
              activeTerminalId: 'term-1',
            },
          ],
        },
      },
    })
  })

  it('upgrades saved file surfaces with neutral reveal state', () =>
  {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          'env-1:thread-A': {
            isOpen: true,
            activeSurfaceId: 'file:src/index.ts',
            surfaces: [{ id: 'file:src/index.ts', kind: 'file', relativePath: 'src/index.ts' }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: true,
          activeSurfaceId: 'file:src/index.ts',
          surfaces: [
            {
              id: 'file:src/index.ts',
              kind: 'file',
              relativePath: 'src/index.ts',
              revealLine: null,
              revealRequestId: 0,
            },
          ],
        },
      },
    })
  })

  it('drops a retired persisted Atlas surface', () =>
  {
    expect(
      migratePersistedRightPanelState(
        {
          byThreadKey: {
            'env-1:thread-A': {
              isOpen: true,
              activeSurfaceId: 'atlas',
              surfaces: [{ id: 'atlas', kind: 'atlas' }],
            },
          },
        },
        8,
      ),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: true,
          activeSurfaceId: null,
          surfaces: [],
        },
      },
    })
  })

  it('drops retired, spoofed, payload-bearing, duplicate, and unknown migration entries', () =>
  {
    expect(
      migratePersistedRightPanelState(
        {
          byThreadKey: {
            'env-1:thread-A': {
              isOpen: true,
              activeSurfaceId: 'atlas',
              surfaces: [
                { id: 'atlas:spoofed', kind: 'atlas' },
                { id: 'atlas', kind: 'atlas', projectId: 'spoofed-project' },
                { id: 'atlas', kind: 'atlas' },
                { id: 'atlas', kind: 'atlas' },
                { id: 'future', kind: 'future-surface', payload: true },
              ],
            },
          },
        },
        8,
      ),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: true,
          activeSurfaceId: null,
          surfaces: [],
        },
      },
    })
  })

  it('builds canonical injective architecture resource identities', () =>
  {
    const first = createArchitectureImpactSurface({
      kind: 'exact-impact',
      descriptor: impactDescriptor('1'.repeat(64)),
    })
    const same = createArchitectureImpactSurface({
      kind: 'exact-impact',
      descriptor: impactDescriptor('1'.repeat(64)),
    })
    const other = createArchitectureImpactSurface({
      kind: 'exact-impact',
      descriptor: impactDescriptor('2'.repeat(64)),
    })

    expect(first.id).toBe(same.id)
    expect(first.id).not.toBe(other.id)
    expect(first.id).toContain('%5B')
  })

  it('migrates current architecture resources and drops retired architecture resources', () =>
  {
    const impact = createArchitectureImpactSurface({
      kind: 'exact-impact',
      descriptor: impactDescriptor('3'.repeat(64)),
    })
    const repository = createRepositoryAtlasSurface({
      kind: 'standing-project-generation',
      projectId: 'project-1' as ProjectId,
      generationId: repositoryGenerationId,
      side: 'analyzed',
      graphDigest: repositoryGraphDigest,
    })
    const retiredImpact = {
      id: 'architecture-impact:retired-comparison',
      kind: 'architecture-impact',
      target: {
        threadId: refA.threadId,
        comparison: {
          kind: 'proposal-generation',
          generationId: 'proposal-generation-retired',
        },
      },
    }
    const retiredScope = {
      id: 'architecture-scope:retired',
      kind: 'architecture-scope',
      source: repository.target,
      scope: { level: 'dirs', id: 'dirs:apps/server/src' },
    }
    const retiredAdvanced = {
      id: 'advanced-atlas:retired',
      kind: 'advanced-atlas',
      target: { kind: 'project', projectId: 'project-1' },
    }

    expect(
      migratePersistedRightPanelState(
        {
          byThreadKey: {
            'env-1:thread-A': {
              isOpen: true,
              activeSurfaceId: repository.id,
              surfaces: [
                impact,
                repository,
                retiredImpact,
                retiredScope,
                retiredAdvanced,
                impact,
                { ...repository, id: `${repository.id}:spoofed` },
              ],
            },
          },
        },
        11,
      ),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: true,
          activeSurfaceId: repository.id,
          surfaces: [impact, repository],
        },
      },
    })
  })

  it('preserves contract-valid architecture paths and rejects NUL-bearing resources', () =>
  {
    const source = {
      kind: 'proposal-generation' as const,
      threadId: refA.threadId,
      generationId: 'proposal-generation-paths' as ProposalGenerationId,
      side: 'proposed' as const,
      graphDigest: headGraphDigest,
    }
    const validPaths = [
      'src/ spaced.ts ',
      'src/*.ts',
      'src/[literal].ts',
      'src/tab\tname.ts',
      'src/newline\nname.ts',
    ]
    const files = validPaths.map((relativePath) => ({
      id: architectureFileSurfaceId(source, relativePath),
      kind: 'file' as const,
      relativePath,
      revealLine: null,
      revealRequestId: 0,
      source,
    }))
    const nulPath = 'src/nul\u0000name.ts'
    const nulFile = {
      id: architectureFileSurfaceId(source, nulPath),
      kind: 'file' as const,
      relativePath: nulPath,
      revealLine: null,
      revealRequestId: 0,
      source,
    }

    expect(
      migratePersistedRightPanelState(
        {
          byThreadKey: {
            'env-1:thread-A': {
              isOpen: true,
              activeSurfaceId: files[0]?.id,
              surfaces: [...files, nulFile],
            },
          },
        },
        12,
      ),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: true,
          activeSurfaceId: files[0]?.id,
          surfaces: files,
        },
      },
    })
  })

  it('deduplicates architecture resources and inserts explicit children adjacently', () =>
  {
    const impact = createArchitectureImpactSurface({
      kind: 'exact-impact',
      descriptor: impactDescriptor('4'.repeat(64)),
    })

    useRightPanelStore.getState().open(refA, 'plan')
    useRightPanelStore.getState().open(refA, 'diff')
    useRightPanelStore.getState().openArchitectureSurface(refA, impact, 'plan')
    useRightPanelStore.getState().openArchitectureSurface(refA, impact, 'diff')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: impact.id,
      surfaces: [{ id: 'plan', kind: 'plan' }, impact, { id: 'diff', kind: 'diff' }],
    })
  })

  it('inserts live and immutable architecture file children adjacently without duplicating them', () =>
  {
    const repository = createRepositoryAtlasSurface({
      kind: 'standing-project-generation',
      projectId: 'project-1' as ProjectId,
      generationId: repositoryGenerationId,
      side: 'analyzed',
      graphDigest: repositoryGraphDigest,
    })
    const proposalSource = {
      kind: 'proposal-generation' as const,
      threadId: refA.threadId,
      generationId: 'proposal-generation-1' as ProposalGenerationId,
      side: 'proposed' as const,
      graphDigest: headGraphDigest,
    }

    useRightPanelStore.getState().open(refA, 'plan')
    useRightPanelStore.getState().openArchitectureSurface(refA, repository, 'plan')
    useRightPanelStore.getState().open(refA, 'diff')
    useRightPanelStore
      .getState()
      .openFile(refA, 'apps/server/src/server.ts', undefined, repository.id)
    useRightPanelStore
      .getState()
      .openArchitectureFile(refA, proposalSource, 'apps/web/src/App.tsx', 8, repository.id)
    useRightPanelStore
      .getState()
      .openArchitectureFile(refA, proposalSource, 'apps/web/src/App.tsx', 21, repository.id)

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: architectureFileSurfaceId(proposalSource, 'apps/web/src/App.tsx'),
      surfaces: [
        { id: 'plan', kind: 'plan' },
        repository,
        {
          id: architectureFileSurfaceId(proposalSource, 'apps/web/src/App.tsx'),
          kind: 'file',
          relativePath: 'apps/web/src/App.tsx',
          revealLine: 21,
          revealRequestId: 2,
          source: proposalSource,
        },
        {
          id: 'file:apps/server/src/server.ts',
          kind: 'file',
          relativePath: 'apps/server/src/server.ts',
          revealLine: null,
          revealRequestId: 1,
        },
        { id: 'diff', kind: 'diff' },
      ],
    })
  })

  it('open sets the active panel for a thread', () =>
  {
    useRightPanelStore.getState().open(refA, 'preview')
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe('preview')
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBeNull()
  })

  it('opening a different kind keeps both surfaces and activates the new one', () =>
  {
    useRightPanelStore.getState().open(refA, 'plan')
    useRightPanelStore.getState().open(refA, 'preview')
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe('preview')
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2)
  })

  it('reopening an inactive singleton activates its existing surface', () =>
  {
    useRightPanelStore.getState().open(refA, 'diff')
    useRightPanelStore.getState().open(refA, 'plan')
    useRightPanelStore.getState().open(refA, 'diff')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'diff',
      surfaces: [
        { id: 'diff', kind: 'diff' },
        { id: 'plan', kind: 'plan' },
      ],
    })
  })

  it('keeps files as a singleton surface', () =>
  {
    useRightPanelStore.getState().open(refA, 'files')
    useRightPanelStore.getState().open(refA, 'files')
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [{ id: 'files', kind: 'files' }],
    })
  })

  it('keeps Repository Atlas home as a payload-free singleton surface', () =>
  {
    useRightPanelStore.getState().open(refA, 'repository-atlas-home')
    useRightPanelStore.getState().open(refA, 'repository-atlas-home')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'repository-atlas-home',
      surfaces: [{ id: 'repository-atlas-home', kind: 'repository-atlas-home' }],
    })

    useRightPanelStore.getState().toggle(refA, 'repository-atlas-home')
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: 'repository-atlas-home',
      surfaces: [{ id: 'repository-atlas-home', kind: 'repository-atlas-home' }],
    })

    useRightPanelStore.getState().toggle(refA, 'repository-atlas-home')
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'repository-atlas-home',
      surfaces: [{ id: 'repository-atlas-home', kind: 'repository-atlas-home' }],
    })
  })

  it('keeps Explorer as a validated singleton only while a workspace is available', () =>
  {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          'env-1:thread-A': {
            isOpen: true,
            activeSurfaceId: 'explorer',
            surfaces: [
              { id: 'explorer', kind: 'explorer' },
              { id: 'explorer:spoofed', kind: 'explorer' },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: true,
          activeSurfaceId: 'explorer',
          surfaces: [{ id: 'explorer', kind: 'explorer', target: null }],
        },
      },
    })

    useRightPanelStore.getState().open(refA, 'explorer')
    useRightPanelStore.getState().open(refA, 'explorer')
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'explorer',
      surfaces: [{ id: 'explorer', kind: 'explorer', target: null }],
    })

    useRightPanelStore.getState().openExplorer(refA, {
      kind: 'plan',
      planId: 'plan-current' as OrchestrationProposedPlanId,
    })
    useRightPanelStore.getState().openExplorer(refA, {
      kind: 'plan',
      planId: 'plan-revised' as OrchestrationProposedPlanId,
    })
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'explorer',
      surfaces: [
        {
          id: 'explorer',
          kind: 'explorer',
          target: { kind: 'plan', planId: 'plan-revised' },
        },
      ],
    })

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false)
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('migrates legacy plan targets and validates v10 target arms exactly', () =>
  {
    const legacy = migratePersistedRightPanelState(
      {
        byThreadKey: {
          'env-1:thread-A': {
            isOpen: true,
            activeSurfaceId: 'explorer',
            surfaces: [{ id: 'explorer', kind: 'explorer', planId: 'plan-legacy' }],
          },
        },
      },
      9,
    )
    expect(legacy.byThreadKey['env-1:thread-A']?.surfaces).toEqual([
      {
        id: 'explorer',
        kind: 'explorer',
        target: { kind: 'plan', planId: 'plan-legacy' },
      },
    ])

    const current = migratePersistedRightPanelState(
      {
        byThreadKey: {
          'env-1:thread-A': {
            isOpen: true,
            activeSurfaceId: 'explorer',
            surfaces: [
              {
                id: 'explorer',
                kind: 'explorer',
                target: {
                  kind: 'orchestrate',
                  threadId: 'thread-A',
                  runId: 'run-3',
                  revision: 3,
                },
              },
            ],
          },
          'env-1:thread-B': {
            isOpen: true,
            activeSurfaceId: 'explorer',
            surfaces: [
              {
                id: 'explorer',
                kind: 'explorer',
                target: {
                  kind: 'orchestrate',
                  threadId: 'thread-B',
                  runId: 'run-4',
                  revision: 4,
                  fallbackPlanId: 'plan-spoofed',
                },
              },
            ],
          },
          'env-1:thread-C': {
            isOpen: true,
            activeSurfaceId: 'explorer',
            surfaces: [
              {
                id: 'explorer',
                kind: 'explorer',
                target: { kind: 'plan', planId: 'plan-current' },
              },
              {
                id: 'explorer',
                kind: 'explorer',
                target: {
                  kind: 'orchestrate',
                  threadId: 'thread-C',
                  runId: 'run-duplicate',
                  revision: 1,
                },
              },
            ],
          },
          'env-1:thread-D': {
            isOpen: true,
            activeSurfaceId: 'explorer',
            surfaces: [
              {
                id: 'explorer',
                kind: 'explorer',
                target: {
                  kind: 'orchestrate',
                  threadId: 'thread-D',
                  runId: 'run-invalid',
                  revision: -1,
                },
              },
            ],
          },
        },
      },
      10,
    )
    expect(current.byThreadKey['env-1:thread-A']?.surfaces).toEqual([
      {
        id: 'explorer',
        kind: 'explorer',
        target: {
          kind: 'orchestrate',
          threadId: 'thread-A',
          runId: 'run-3',
          revision: 3,
        },
      },
    ])
    expect(current.byThreadKey['env-1:thread-B']?.surfaces).toEqual([])
    expect(current.byThreadKey['env-1:thread-C']?.surfaces).toEqual([
      {
        id: 'explorer',
        kind: 'explorer',
        target: { kind: 'plan', planId: 'plan-current' },
      },
    ])
    expect(current.byThreadKey['env-1:thread-D']?.surfaces).toEqual([])

    useRightPanelStore.getState().openExplorer(refA, {
      kind: 'orchestrate',
      threadId: refA.threadId,
      runId: 'run-3' as OrchestratePlanRunId,
      revision: 3,
    })
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: 'explorer',
      kind: 'explorer',
      target: {
        kind: 'orchestrate',
        threadId: 'thread-A',
        runId: 'run-3',
        revision: 3,
      },
    })
  })

  it('replaces the standalone file browser with peer file surfaces', () =>
  {
    useRightPanelStore.getState().open(refA, 'files')
    useRightPanelStore.getState().openFile(refA, 'src/index.ts')
    useRightPanelStore.getState().openFile(refA, 'src/index.ts')
    useRightPanelStore.getState().openFile(refA, 'README.md')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:README.md',
      surfaces: [
        {
          id: 'file:src/index.ts',
          kind: 'file',
          relativePath: 'src/index.ts',
          revealLine: null,
          revealRequestId: 2,
        },
        {
          id: 'file:README.md',
          kind: 'file',
          relativePath: 'README.md',
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    })
  })

  it('updates line reveal requests when reopening a file surface', () =>
  {
    useRightPanelStore.getState().openFile(refA, 'src/index.ts', 42)
    useRightPanelStore.getState().openFile(refA, 'src/index.ts', 87)

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/index.ts',
      surfaces: [
        {
          id: 'file:src/index.ts',
          kind: 'file',
          relativePath: 'src/index.ts',
          revealLine: 87,
          revealRequestId: 2,
        },
      ],
    })

    useRightPanelStore.getState().openFile(refA, 'src/index.ts')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/index.ts',
      surfaces: [
        {
          id: 'file:src/index.ts',
          kind: 'file',
          relativePath: 'src/index.ts',
          revealLine: null,
          revealRequestId: 3,
        },
      ],
    })
  })

  it('keeps immutable architecture files distinct by source and preserves them on workspace loss', () =>
  {
    const baseSource = {
      kind: 'proposal-generation' as const,
      threadId: refA.threadId,
      generationId: 'proposal-generation-1' as ProposalGenerationId,
      side: 'base' as const,
      graphDigest: baseGraphDigest,
    }
    const proposedSource = {
      ...baseSource,
      side: 'proposed' as const,
      graphDigest: headGraphDigest,
    }

    useRightPanelStore.getState().openArchitectureFile(refA, baseSource, '../src/index.ts', 1)
    expect(useRightPanelStore.getState().byThreadKey).toEqual({})

    useRightPanelStore.getState().openArchitectureFile(refA, baseSource, 'src/index.ts', 12)
    useRightPanelStore.getState().openArchitectureFile(refA, baseSource, 'src/index.ts', 24)
    useRightPanelStore.getState().openArchitectureFile(refA, proposedSource, 'src/index.ts', 36)
    useRightPanelStore.getState().openFile(refA, 'src/index.ts', 48)

    const beforeReconciliation = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      refA,
    )
    expect(beforeReconciliation.surfaces).toEqual([
      {
        id: architectureFileSurfaceId(baseSource, 'src/index.ts'),
        kind: 'file',
        relativePath: 'src/index.ts',
        revealLine: 24,
        revealRequestId: 2,
        source: baseSource,
      },
      {
        id: architectureFileSurfaceId(proposedSource, 'src/index.ts'),
        kind: 'file',
        relativePath: 'src/index.ts',
        revealLine: 36,
        revealRequestId: 1,
        source: proposedSource,
      },
      {
        id: 'file:src/index.ts',
        kind: 'file',
        relativePath: 'src/index.ts',
        revealLine: 48,
        revealRequestId: 1,
      },
    ])
    expect(new Set(beforeReconciliation.surfaces.map((surface) => surface.id)).size).toBe(3)

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false)

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: architectureFileSurfaceId(proposedSource, 'src/index.ts'),
      surfaces: beforeReconciliation.surfaces.slice(0, 2),
    })
  })

  it('migrates exact architecture file identities and rejects mutable or spoofed variants', () =>
  {
    const source = {
      kind: 'diff-analysis' as const,
      threadId: refA.threadId,
      diffAnalysisId: 'diff-analysis-1' as DiffAnalysisId,
      side: 'head' as const,
      graphDigest: headGraphDigest,
    }
    useRightPanelStore.getState().openArchitectureFile(refA, source, 'src/index.ts', 7)
    const surface = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)
    if (surface?.kind !== 'file') throw new Error('expected an architecture file surface')

    expect(
      migratePersistedRightPanelState(
        {
          byThreadKey: {
            'env-1:thread-A': {
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: [
                surface,
                surface,
                { ...surface, id: `${surface.id}:spoofed` },
                { ...surface, source: { ...source, side: 'base' } },
                { ...surface, mutableRoot: '/tmp/spoofed' },
              ],
            },
          },
        },
        11,
      ),
    ).toEqual({
      byThreadKey: {
        'env-1:thread-A': {
          isOpen: true,
          activeSurfaceId: surface.id,
          surfaces: [surface],
        },
      },
    })
  })

  it('removes persisted file surfaces when their workspace no longer exists', () =>
  {
    useRightPanelStore.getState().openFile(refA, 'src/index.ts')
    useRightPanelStore.getState().open(refA, 'plan')
    useRightPanelStore.getState().openFile(refA, 'README.md')

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false)

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'plan',
      surfaces: [{ id: 'plan', kind: 'plan' }],
    })

    useRightPanelStore.getState().openFile(refB, 'conductor.json')
    useRightPanelStore.getState().reconcileFileSurfaces(refB, false)
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('drops Repository Atlas home on workspace loss without resurrecting it', () =>
  {
    useRightPanelStore.getState().open(refA, 'plan')
    useRightPanelStore.getState().open(refA, 'repository-atlas-home')

    useRightPanelStore.getState().reconcileFileSurfaces(refA, true)

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'repository-atlas-home',
      surfaces: [
        { id: 'plan', kind: 'plan' },
        { id: 'repository-atlas-home', kind: 'repository-atlas-home' },
      ],
    })

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false)

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'plan',
      surfaces: [{ id: 'plan', kind: 'plan' }],
    })

    useRightPanelStore.getState().reconcileFileSurfaces(refA, true)

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'plan',
      surfaces: [{ id: 'plan', kind: 'plan' }],
    })
  })

  it('close hides the panel without clearing its selected surface', () =>
  {
    useRightPanelStore.getState().open(refA, 'plan')
    useRightPanelStore.getState().close(refA)
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull()
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: 'plan',
      surfaces: [{ id: 'plan', kind: 'plan' }],
    })
  })

  it('toggles empty panel visibility without creating a surface', () =>
  {
    useRightPanelStore.getState().toggleVisibility(refA)
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    })

    useRightPanelStore.getState().toggleVisibility(refA)
    expect(useRightPanelStore.getState().byThreadKey).toEqual({})
  })

  it('toggle hides the panel without discarding the active surface', () =>
  {
    useRightPanelStore.getState().toggle(refA, 'diff')
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe('diff')
    useRightPanelStore.getState().toggle(refA, 'diff')
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull()
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: 'diff',
      surfaces: [{ id: 'diff', kind: 'diff' }],
    })
  })

  it('toggle to a different kind switches active', () =>
  {
    useRightPanelStore.getState().toggle(refA, 'preview')
    useRightPanelStore.getState().toggle(refA, 'plan')
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe('plan')
  })

  it('removeThread clears persisted state', () =>
  {
    useRightPanelStore.getState().open(refA, 'plan')
    useRightPanelStore.getState().removeThread(refA)
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull()
  })

  it('tracks one surface per browser session', () =>
  {
    useRightPanelStore.getState().openBrowser(refA, 'tab-a')
    useRightPanelStore.getState().openBrowser(refA, 'tab-b')

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)
    expect(state.surfaces.map((surface) => surface.id)).toEqual(['browser:tab-a', 'browser:tab-b'])
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: 'browser:tab-b',
      kind: 'preview',
      resourceId: 'tab-b',
    })
  })

  it('tracks one surface per terminal session', () =>
  {
    useRightPanelStore.getState().openTerminal(refA, 'term-1')
    useRightPanelStore.getState().openTerminal(refA, 'term-2')

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)
    expect(state.surfaces).toEqual([
      {
        id: 'terminal:term-1',
        kind: 'terminal',
        resourceId: 'term-1',
        terminalIds: ['term-1'],
        activeTerminalId: 'term-1',
      },
      {
        id: 'terminal:term-2',
        kind: 'terminal',
        resourceId: 'term-2',
        terminalIds: ['term-2'],
        activeTerminalId: 'term-2',
      },
    ])
    expect(state.activeSurfaceId).toBe('terminal:term-2')
  })

  it('tracks split panes and the active pane within a terminal surface', () =>
  {
    useRightPanelStore.getState().openTerminal(refA, 'term-1')
    useRightPanelStore.getState().splitTerminal(refA, 'terminal:term-1', 'term-2')

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: 'terminal:term-1',
      kind: 'terminal',
      resourceId: 'term-1',
      terminalIds: ['term-1', 'term-2'],
      activeTerminalId: 'term-2',
    })

    useRightPanelStore.getState().activateTerminal(refA, 'terminal:term-1', 'term-1')
    useRightPanelStore.getState().closeTerminal(refA, 'terminal:term-1', 'term-1')
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: 'terminal:term-1',
      kind: 'terminal',
      resourceId: 'term-1',
      terminalIds: ['term-2'],
      activeTerminalId: 'term-2',
    })
  })

  it('tracks vertical layout for a terminal surface', () =>
  {
    useRightPanelStore.getState().openTerminal(refA, 'term-1')
    useRightPanelStore.getState().splitTerminal(refA, 'terminal:term-1', 'term-2', 'vertical')

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: 'terminal:term-1',
      kind: 'terminal',
      resourceId: 'term-1',
      terminalIds: ['term-1', 'term-2'],
      activeTerminalId: 'term-2',
      splitDirection: 'vertical',
    })
  })

  it('closing the final terminal pane removes its surface and closes the panel', () =>
  {
    useRightPanelStore.getState().openTerminal(refA, 'term-1')
    useRightPanelStore.getState().closeTerminal(refA, 'terminal:term-1', 'term-1')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('closing the active surface activates a neighboring surface', () =>
  {
    useRightPanelStore.getState().openBrowser(refA, 'tab-a')
    useRightPanelStore.getState().openTerminal(refA, 'term-1')
    useRightPanelStore.getState().closeSurface(refA, 'terminal:term-1')

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      'browser:tab-a',
    )
  })

  it('closing the final surface closes the panel', () =>
  {
    useRightPanelStore.getState().openTerminal(refA, 'term-1')
    useRightPanelStore.getState().closeSurface(refA, 'terminal:term-1')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('closing other surfaces keeps the selected surface active', () =>
  {
    useRightPanelStore.getState().openBrowser(refA, 'tab-a')
    useRightPanelStore.getState().openFile(refA, 'src/index.ts')
    useRightPanelStore.getState().openTerminal(refA, 'term-1')

    useRightPanelStore.getState().closeOtherSurfaces(refA, 'file:src/index.ts')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/index.ts',
      surfaces: [
        {
          id: 'file:src/index.ts',
          kind: 'file',
          relativePath: 'src/index.ts',
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    })
  })

  it('closing surfaces to the right activates the selected surface when active was removed', () =>
  {
    useRightPanelStore.getState().openBrowser(refA, 'tab-a')
    useRightPanelStore.getState().openFile(refA, 'src/index.ts')
    useRightPanelStore.getState().openTerminal(refA, 'term-1')

    useRightPanelStore.getState().closeSurfacesToRight(refA, 'browser:tab-a')

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:tab-a',
      surfaces: [{ id: 'browser:tab-a', kind: 'preview', resourceId: 'tab-a' }],
    })
  })

  it('closing all surfaces closes the panel', () =>
  {
    useRightPanelStore.getState().openBrowser(refA, 'tab-a')
    useRightPanelStore.getState().openFile(refA, 'src/index.ts')

    useRightPanelStore.getState().closeAllSurfaces(refA)

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('reconciles browser surfaces without deleting other surface kinds', () =>
  {
    useRightPanelStore.getState().openTerminal(refA, 'term-1')
    useRightPanelStore.getState().openBrowser(refA, 'tab-a')
    useRightPanelStore.getState().openBrowser(refA, 'tab-b')
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ['tab-b', 'tab-c'])

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(['terminal:term-1', 'browser:tab-b', 'browser:tab-c'])
  })
})
