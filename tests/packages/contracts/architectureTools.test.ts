// tests/packages/contracts/architectureTools.test.ts
// verifies bounded architecture tool inputs, results, and typed failures

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import {
  ARCHITECTURE_API_CONSUMER_LIMIT,
  ARCHITECTURE_API_EXPORT_LIMIT,
  ARCHITECTURE_API_FILE_LIMIT,
  ARCHITECTURE_BLAST_PATH_LIMIT,
  ARCHITECTURE_BLAST_TARGET_MAX_LENGTH,
  ARCHITECTURE_PATCH_BOUNDARY_LIMIT,
  ARCHITECTURE_PATCH_CYCLE_LIMIT,
  ARCHITECTURE_PATCH_ISSUE_LIMIT,
  ARCHITECTURE_PATCH_MAX_BYTES,
  ARCHITECTURE_PATCH_MAX_DESCRIPTION_LENGTH,
  ARCHITECTURE_PATCH_MAX_EXPORTS,
  ARCHITECTURE_PATCH_MAX_NAME_LENGTH,
  ARCHITECTURE_PATCH_MAX_NOTE_LENGTH,
  ARCHITECTURE_PATCH_MAX_OPS,
  ARCHITECTURE_PATCH_MAX_PATH_LENGTH,
  ARCHITECTURE_PATCH_MAX_SYMBOLS,
  ARCHITECTURE_PATCH_ORPHAN_LIMIT,
  ARCHITECTURE_RESULT_LIST_LIMIT,
  ArchitectureBlastRadiusInput,
  ArchitectureBoundedList,
  ArchitectureFileApiChange,
  ArchitectureGraphDiffInput,
  ArchitectureGraphDiffResult,
  ArchitectureImpactInput,
  ArchitecturePatchGraphDiffResult,
  ArchitectureProposePatchInput,
  ArchitectureProposePatchResult,
  ArchitectureToolError,
  ArchitectureToolErrorCode,
} from '../../../packages/contracts/src/index.ts'

const strictDecode = <A>(schema: Schema.Decoder<A, never>) =>
  Schema.decodeUnknownSync(schema, {
    errors: 'all',
    onExcessProperty: 'error',
  })

const emptyList = <A>(items: readonly A[] = []) => ({
  items,
  total: items.length,
  omitted: 0,
})

const emptyDiff = {
  version: 1,
  summary: 'no architectural drift',
  base: { generatedAt: '2026-08-07T12:00:00.000Z', gitRef: 'abc1234' },
  head: { generatedAt: '2026-08-07T12:00:00.000Z', gitRef: 'abc1234' },
  changed: false,
  addedNodes: emptyList(),
  removedNodes: emptyList(),
  addedEdges: emptyList(),
  removedEdges: emptyList(),
  movedNodes: emptyList(),
  moveFlows: emptyList(),
  movedEdges: 0,
  apiChanges: emptyList(),
  newViolations: emptyList(),
  resolvedViolations: emptyList(),
} as const

const decodeArchitectureToolErrorCode = Schema.decodeUnknownSync(ArchitectureToolErrorCode)

describe('architecture tool contracts', () =>
{
  it('pins the exact shared limit policy', () =>
  {
    expect({
      resultList: ARCHITECTURE_RESULT_LIST_LIMIT,
      apiFiles: ARCHITECTURE_API_FILE_LIMIT,
      apiExports: ARCHITECTURE_API_EXPORT_LIMIT,
      apiConsumers: ARCHITECTURE_API_CONSUMER_LIMIT,
      blastPaths: ARCHITECTURE_BLAST_PATH_LIMIT,
      blastTarget: ARCHITECTURE_BLAST_TARGET_MAX_LENGTH,
      patchIssues: ARCHITECTURE_PATCH_ISSUE_LIMIT,
      patchCycles: ARCHITECTURE_PATCH_CYCLE_LIMIT,
      patchBoundaries: ARCHITECTURE_PATCH_BOUNDARY_LIMIT,
      patchOrphans: ARCHITECTURE_PATCH_ORPHAN_LIMIT,
      patchOps: ARCHITECTURE_PATCH_MAX_OPS,
      patchBytes: ARCHITECTURE_PATCH_MAX_BYTES,
      patchPath: ARCHITECTURE_PATCH_MAX_PATH_LENGTH,
      patchDescription: ARCHITECTURE_PATCH_MAX_DESCRIPTION_LENGTH,
      patchNote: ARCHITECTURE_PATCH_MAX_NOTE_LENGTH,
      patchExports: ARCHITECTURE_PATCH_MAX_EXPORTS,
      patchSymbols: ARCHITECTURE_PATCH_MAX_SYMBOLS,
      patchName: ARCHITECTURE_PATCH_MAX_NAME_LENGTH,
    }).toEqual({
      resultList: 200,
      apiFiles: 100,
      apiExports: 50,
      apiConsumers: 25,
      blastPaths: 400,
      blastTarget: 713,
      patchIssues: 200,
      patchCycles: 20,
      patchBoundaries: 50,
      patchOrphans: 200,
      patchOps: 2_000,
      patchBytes: 1_048_576,
      patchPath: 512,
      patchDescription: 2_000,
      patchNote: 500,
      patchExports: 200,
      patchSymbols: 200,
      patchName: 200,
    })
  })

  it('accepts only canonical selectors without caller-supplied authority or paths', () =>
  {
    const decodeBlast = strictDecode(ArchitectureBlastRadiusInput)
    const decodeDiff = strictDecode(ArchitectureGraphDiffInput)
    const decodeImpact = strictDecode(ArchitectureImpactInput)

    expect(
      decodeBlast({
        context: {
          kind: 'proposal-generation',
          generationId: 'proposal-generation-contract',
          graph: 'proposed',
        },
        target: 'src/auth/session.ts#refreshToken',
        direction: 'upstream',
        maxDepth: 3,
      }),
    ).toMatchObject({ context: { kind: 'proposal-generation', graph: 'proposed' } })
    expect(
      decodeDiff({
        comparison: {
          kind: 'diff-analysis',
          diffAnalysisId: 'diff-analysis-contract',
        },
      }),
    ).toEqual({
      comparison: {
        kind: 'diff-analysis',
        diffAnalysisId: 'diff-analysis-contract',
      },
    })
    expect(
      decodeImpact({
        threadId: 'thread-architecture-impact',
        comparison: {
          kind: 'proposal-generation',
          generationId: 'proposal-generation-contract',
        },
      }),
    ).toEqual({
      threadId: 'thread-architecture-impact',
      comparison: {
        kind: 'proposal-generation',
        generationId: 'proposal-generation-contract',
      },
    })
    expect(() =>
      decodeImpact({
        comparison: {
          kind: 'proposal-generation',
          generationId: 'proposal-generation-contract',
        },
      }),
    ).toThrow()
    expect(() =>
      decodeBlast({
        context: {
          kind: 'current-thread-worktree',
          root: '/spoofed/root',
        },
        target: 'src/index.ts',
      }),
    ).toThrow()
    expect(() =>
      decodeDiff({
        comparison: {
          kind: 'proposal-generation',
          generationId: 'proposal-generation-contract',
          basePath: '/spoofed/base.json',
        },
      }),
    ).toThrow()
    expect(() =>
      decodeDiff({
        comparison: {
          kind: 'arbitrary-pair',
          baseContextId: 'base',
          headContextId: 'head',
        },
      }),
    ).toThrow()
    expect(() =>
      decodeBlast({
        context: { kind: 'current-thread-worktree' },
        target: `src/${'x'.repeat(509)}`,
      }),
    ).toThrow()
    expect(() =>
      decodeBlast({
        context: { kind: 'current-thread-worktree' },
        target: `src/index.ts#${'x'.repeat(201)}`,
      }),
    ).toThrow()
    expect(() =>
      decodeBlast({
        context: { kind: 'current-thread-worktree' },
        target: '../src/index.ts',
      }),
    ).toThrow()
  })

  it('mirrors all five GraphPatch v1 operations and rejects noncanonical inputs', () =>
  {
    const decodePatch = strictDecode(ArchitectureProposePatchInput)
    const input = {
      context: { kind: 'standing-project' as const },
      ops: [
        {
          op: 'add_file' as const,
          path: 'src/new.ts',
          description: 'new session boundary',
          exports: ['createSession'],
          note: 'introduce the owner',
        },
        {
          op: 'move_file' as const,
          from: 'src/old.ts',
          to: 'src/moved.ts',
        },
        {
          op: 'add_import' as const,
          from: 'src/new.ts',
          to: 'src/moved.ts',
          symbols: ['Moved'],
          typeOnly: true as const,
        },
        {
          op: 'remove_import' as const,
          from: 'src/legacy.ts',
          to: 'src/old.ts',
        },
        {
          op: 'remove_file' as const,
          path: 'src/legacy.ts',
        },
      ],
    }

    expect(decodePatch(input).ops.map((operation) => operation.op)).toEqual([
      'add_file',
      'move_file',
      'add_import',
      'remove_import',
      'remove_file',
    ])
    expect(() => decodePatch({ context: input.context, ops: [] })).toThrow()
    expect(() =>
      decodePatch({
        context: input.context,
        ops: [{ op: 'add_import', from: 'src/new.ts', to: 'src/moved.ts', typeOnly: false }],
      }),
    ).toThrow()
    for (const path of ['/absolute.ts', 'src\\windows.ts', 'src/../escape.ts', 'src//alias.ts'])
    {
      expect(() =>
        decodePatch({
          context: input.context,
          ops: [{ op: 'remove_file', path }],
        }),
      ).toThrow()
    }
    expect(() =>
      decodePatch({
        context: { kind: 'diff-analysis', diffAnalysisId: 'diff-analysis-contract' },
        ops: [{ op: 'remove_file', path: 'src/file.ts' }],
      }),
    ).toThrow()
  })

  it('enforces exact bounded-list and nested API evidence invariants', () =>
  {
    const decodeBounded = strictDecode(ArchitectureBoundedList(Schema.String, 2))
    const decodeApiChange = strictDecode(ArchitectureFileApiChange)
    const decodeGraphDiff = strictDecode(ArchitectureGraphDiffResult)
    const decodePatchDiff = strictDecode(ArchitecturePatchGraphDiffResult)
    const exports = (count: number) =>
      emptyList(Array.from({ length: count }, (_, index) => ({ name: `symbol${index}` })))

    expect(decodeBounded({ items: ['a', 'b'], total: 3, omitted: 1 })).toEqual({
      items: ['a', 'b'],
      total: 3,
      omitted: 1,
    })
    expect(() => decodeBounded({ items: ['a'], total: 3, omitted: 1 })).toThrow()
    expect(() => decodeBounded({ items: ['a', 'b', 'c'], total: 3, omitted: 0 })).toThrow()

    expect(
      decodeApiChange({
        file: 'src/api.ts',
        addedExports: exports(25),
        removedExports: exports(25),
      }).addedExports.items,
    ).toHaveLength(25)
    expect(() =>
      decodeApiChange({
        file: 'src/api.ts',
        addedExports: exports(26),
        removedExports: exports(25),
      }),
    ).toThrow()
    expect(() =>
      decodeApiChange({
        file: 'src/api.ts',
        addedExports: emptyList([
          {
            name: 'removedContract',
            brokenConsumers: emptyList(
              Array.from(
                { length: ARCHITECTURE_API_CONSUMER_LIMIT + 1 },
                (_, index) => `src/consumer${index}.ts`,
              ),
            ),
          },
        ]),
        removedExports: emptyList(),
      }),
    ).toThrow()

    const graphDiff = {
      ...emptyDiff,
      apiTotals: {
        files: 3,
        addedExports: 8,
        removedExports: 5,
        brokenConsumers: 13,
      },
    }
    expect(decodeGraphDiff(graphDiff).apiTotals).toEqual(graphDiff.apiTotals)
    expect(() => decodeGraphDiff(emptyDiff)).toThrow()
    expect(decodePatchDiff(emptyDiff).apiChanges.total).toBe(0)
    expect(() => decodePatchDiff(graphDiff)).toThrow()
  })

  it('pins ephemeral result invariants and unified error metadata', () =>
  {
    const decodeResult = strictDecode(ArchitectureProposePatchResult)
    const decodeError = strictDecode(ArchitectureToolError)
    const result = {
      version: 1,
      summary: 'no architectural drift',
      issues: emptyList([{ opIndex: 0, severity: 'error', message: 'file does not exist' }]),
      issueTotals: { errors: 1, warnings: 0 },
      validation: {
        cycles: emptyList(),
        newBoundaries: emptyList(),
        orphans: emptyList(),
      },
      diff: emptyDiff,
      staleness: {
        stale: true,
        reasons: ['dirty-tree'],
        graph: emptyDiff.base,
        workingTree: { gitRef: 'abc1234', dirty: true },
      },
    } as const

    expect(decodeResult(result).issues.total).toBe(1)
    expect(() => decodeResult({ ...result, issueTotals: { errors: 0, warnings: 0 } })).toThrow()
    expect(() =>
      decodeResult({
        ...result,
        diff: {
          ...result.diff,
          apiChanges: { items: [], total: 1, omitted: 1 },
        },
      }),
    ).toThrow()
    expect(() =>
      decodeResult({
        ...result,
        staleness: { ...result.staleness, stale: false },
      }),
    ).toThrow()

    const codes = [
      'capability-unavailable',
      'identity-mismatch',
      'not-found',
      'context-not-ready',
      'target-not-found',
      'unsupported',
      'invalid-patch',
      'limit-exceeded',
      'evaluation-failed',
      'persistence-failed',
    ] as const
    expect(codes.map((code) => decodeArchitectureToolErrorCode(code))).toEqual(codes)
    expect(
      decodeError({
        _tag: 'ArchitectureToolError',
        operation: 'architecture_blast_radius',
        code: 'context-not-ready',
        detail: 'prepare the current worktree architecture first',
        recovery: 'prepare_current_worktree_architecture',
      }).recovery,
    ).toBe('prepare_current_worktree_architecture')
    expect(
      decodeError({
        _tag: 'ArchitectureToolError',
        operation: 'architecture_propose_patch',
        code: 'limit-exceeded',
        detail: 'patch is too large',
        limit: { kind: 'bytes', scope: 'patch', actual: 1_048_577, limit: 1_048_576 },
      }).limit,
    ).toEqual({ kind: 'bytes', scope: 'patch', actual: 1_048_577, limit: 1_048_576 })
    expect(() =>
      decodeError({
        _tag: 'ArchitectureToolError',
        operation: 'architecture_graph_diff',
        code: 'context-not-ready',
        detail: 'analysis is still running',
      }),
    ).toThrow()
    expect(() =>
      decodeError({
        _tag: 'ArchitectureToolError',
        operation: 'architecture_graph_diff',
        code: 'not-found',
        detail: 'analysis was not found',
        recovery: 'complete_diff_analysis',
      }),
    ).toThrow()
  })
})
