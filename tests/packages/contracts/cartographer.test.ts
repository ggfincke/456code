// tests/packages/contracts/cartographer.test.ts
// verifies native architecture lifecycle and analysis transports

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import {
  ArchitectureRelativePath,
  CartographerEnsureProjectArchitectureInput,
  CartographerSubscribeProjectAtlasStatusInput,
  ProjectAtlasStatus,
} from '../../../packages/contracts/src/architectureProjections.ts'
import {
  CartographerError,
  CartographerGetDiffAnalysisInput,
  CartographerPrepareCurrentWorktreeArchitectureInput,
  CartographerRebuildProjectAtlasInput,
  CartographerRequestDiffAnalysisInput,
  DiffAnalysisErrorCode,
  DiffAnalysisGeneration,
  DiffAnalysisSource,
} from '../../../packages/contracts/src/cartographer.ts'
import { ExecutionEnvironmentCapabilities } from '../../../packages/contracts/src/environment.ts'
import { WS_METHODS } from '../../../packages/contracts/src/rpc.ts'

const strictOptions = { onExcessProperty: 'error' as const }
const decodeEnsureProject = Schema.decodeUnknownSync(
  CartographerEnsureProjectArchitectureInput,
  strictOptions,
)
const decodePrepareWorktree = Schema.decodeUnknownSync(
  CartographerPrepareCurrentWorktreeArchitectureInput,
  strictOptions,
)
const decodeRebuildProject = Schema.decodeUnknownSync(
  CartographerRebuildProjectAtlasInput,
  strictOptions,
)
const decodeSubscribeProjectStatus = Schema.decodeUnknownSync(
  CartographerSubscribeProjectAtlasStatusInput,
  strictOptions,
)
const decodeProjectStatus = Schema.decodeUnknownSync(ProjectAtlasStatus, strictOptions)
const decodeArchitectureRelativePath = Schema.decodeUnknownSync(ArchitectureRelativePath)
const decodeError = Schema.decodeUnknownSync(CartographerError, strictOptions)
const decodeDiffSource = Schema.decodeUnknownSync(DiffAnalysisSource, strictOptions)
const decodeRequestDiff = Schema.decodeUnknownSync(
  CartographerRequestDiffAnalysisInput,
  strictOptions,
)
const decodeGetDiff = Schema.decodeUnknownSync(CartographerGetDiffAnalysisInput, strictOptions)
const decodeDiffGeneration = Schema.decodeUnknownSync(DiffAnalysisGeneration, strictOptions)
const decodeDiffErrorCode = Schema.decodeUnknownSync(DiffAnalysisErrorCode)
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities, strictOptions)

describe('cartographer contracts', () =>
{
  it('accepts literal Git path characters and rejects NUL bytes', () =>
  {
    for (const relativePath of [
      'src/ spaced.ts ',
      'src/*.ts',
      'src/[literal].ts',
      'src/tab\tname.ts',
      'src/newline\nname.ts',
    ])
    {
      expect(decodeArchitectureRelativePath(relativePath)).toBe(relativePath)
    }
    expect(() => decodeArchitectureRelativePath('src/nul\u0000name.ts')).toThrow()
  })

  it('pins headless project and current-worktree lifecycle methods', () =>
  {
    expect(decodeEnsureProject({ projectId: 'project-architecture' })).toEqual({
      projectId: 'project-architecture',
    })
    expect(decodePrepareWorktree({ threadId: 'thread-architecture' })).toEqual({
      threadId: 'thread-architecture',
    })
    expect(decodeRebuildProject({ projectId: 'project-architecture' })).toEqual({
      projectId: 'project-architecture',
    })
    expect(decodeSubscribeProjectStatus({ projectId: 'project-architecture' })).toEqual({
      projectId: 'project-architecture',
    })

    expect(WS_METHODS.cartographerEnsureProjectArchitecture).toBe(
      'cartographer.ensureProjectArchitecture',
    )
    expect(WS_METHODS.cartographerPrepareCurrentWorktreeArchitecture).toBe(
      'cartographer.prepareCurrentWorktreeArchitecture',
    )
    expect(WS_METHODS.cartographerRebuildProjectAtlas).toBe('cartographer.rebuildProjectAtlas')
    expect(WS_METHODS.subscribeProjectAtlasStatus).toBe('cartographer.subscribeProjectAtlasStatus')
  })

  it('binds ready project status to one exact sealed source', () =>
  {
    const generationId = 'a'.repeat(64)
    const graphDigest = `sha256:${'b'.repeat(64)}`
    expect(
      decodeProjectStatus({
        state: 'ready',
        source: {
          kind: 'standing-project-generation',
          projectId: 'project-architecture',
          generationId,
          side: 'analyzed',
          graphDigest,
        },
        freshness: { builtAt: '2026-08-09T12:00:00.000Z', dirty: false },
        lastBuildError: null,
      }),
    ).toMatchObject({
      state: 'ready',
      source: { projectId: 'project-architecture', generationId, graphDigest },
    })
    expect(() =>
      decodeProjectStatus({
        state: 'ready',
        source: {
          kind: 'standing-project-generation',
          projectId: 'project-architecture',
          generationId,
          side: 'analyzed',
        },
        freshness: { builtAt: '2026-08-09T12:00:00.000Z', dirty: false },
        lastBuildError: null,
      }),
    ).toThrow()
  })

  it('keeps the analysis failure family and capability presentation-neutral', () =>
  {
    for (const failure of [
      'unsupported',
      'workspace_context_not_found',
      'generation_not_found',
      'snapshot_failed',
      'context_start_failed',
      'context_not_found',
      'diff_analysis_not_found',
    ] as const)
    {
      expect(
        decodeError({
          _tag: 'CartographerError',
          failure,
          message: `failure: ${failure}`,
        }).failure,
      ).toBe(failure)
    }

    expect(decodeCapabilities({ repositoryIdentity: true })).toEqual({
      repositoryIdentity: true,
    })
    expect(() => decodeCapabilities({ repositoryIdentity: true, atlas: true })).toThrow()
  })

  it('round-trips normalized diff targets through request and exact read inputs', () =>
  {
    const checkpoint = {
      sourceKind: 'checkpoint' as const,
      threadId: 'thread-diff-contract',
      fromTurnCount: 1,
      toTurnCount: 2,
    }
    const review = {
      sourceKind: 'review' as const,
      cwd: '/workspace/repository',
      kind: 'branch-range' as const,
      baseRef: 'main',
    }
    const treePair = {
      sourceKind: 'tree-pair' as const,
      cwd: '/workspace/repository',
      baseTreeOid: 'a'.repeat(40),
      headTreeOid: 'b'.repeat(40),
    }

    expect(decodeDiffSource(checkpoint)).toEqual(checkpoint)
    expect(decodeDiffSource(review)).toEqual(review)
    expect(decodeDiffSource(treePair)).toEqual(treePair)
    expect(
      decodeRequestDiff({ owner: { threadId: checkpoint.threadId }, source: checkpoint }),
    ).toEqual({ owner: { threadId: checkpoint.threadId }, source: checkpoint })
    expect(
      decodeGetDiff({
        owner: { projectId: 'project-diff-contract' },
        source: review,
        diffAnalysisId: 'diff-analysis-contract',
      }),
    ).toEqual({
      owner: { projectId: 'project-diff-contract' },
      source: review,
      diffAnalysisId: 'diff-analysis-contract',
    })
    expect(() =>
      decodeGetDiff({
        owner: { projectId: 'project-diff-contract' },
        diffAnalysisId: 'diff-analysis-contract',
      }),
    ).toThrow()
  })

  it('pins the diff failure family, ready generation, and native RPC names', () =>
  {
    const failures = [
      'invalid-source',
      'thread-not-found',
      'workspace-path-missing',
      'repository-out-of-scope',
      'not-git-repository',
      'repository-identity-failed',
      'checkpoint-ref-missing',
      'base-ref-missing',
      'merge-base-missing',
      'tree-object-missing',
      'dirty-submodule',
      'unsupported',
      'limit-exceeded',
      'materialization-failed',
      'analysis-timeout',
      'analysis-failed',
      'analysis-manifest-invalid',
      'artifact-invalid',
      'request-cancelled',
      'server-restarted',
      'persistence-failed',
    ] as const
    expect(failures.map((failure) => decodeDiffErrorCode(failure))).toEqual(failures)

    expect(
      decodeDiffGeneration({
        version: 1,
        diffAnalysisId: 'diff-analysis-ready',
        sourceKind: 'tree-pair',
        state: 'ready',
        baseTreeOid: 'a'.repeat(40),
        headTreeOid: 'b'.repeat(40),
        analyzerVersion: 'cartographer-test',
        analysisPolicyVersion: 'diff-analysis-v1',
        sourceCurrent: true,
        baseGraphArtifact: 'base-graph-ref',
        headGraphArtifact: 'head-graph-ref',
        impactArtifact: 'impact-ref',
        artifactByteLength: 4096,
        errorCode: null,
        createdAt: '2026-08-09T12:00:00.000Z',
        updatedAt: '2026-08-09T12:00:01.000Z',
        lastAccessedAt: '2026-08-09T12:00:02.000Z',
      }),
    ).toMatchObject({ diffAnalysisId: 'diff-analysis-ready', artifactByteLength: 4096 })
    expect(WS_METHODS.cartographerRequestDiffAnalysis).toBe('cartographer.requestDiffAnalysis')
    expect(WS_METHODS.cartographerGetDiffAnalysis).toBe('cartographer.getDiffAnalysis')
    expect(WS_METHODS.cartographerGetArchitectureImpact).toBe('cartographer.getArchitectureImpact')
  })
})
