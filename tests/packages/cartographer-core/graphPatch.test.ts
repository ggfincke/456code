// tests/packages/cartographer-core/graphPatch.test.ts
// root-facade patch helper identity and canonical serialization regression

import { describe, expect, it } from 'vite-plus/test'

import {
  applyPatch,
  PatchEvaluationLimitError,
  patchToDiff,
  PatchSizeError,
  serializePatch,
  validatePatchStructure,
  type GraphPatch,
} from '../../../packages/cartographer-core/src/index.ts'
import {
  applyPatch as canonicalApplyPatch,
  patchToDiff as canonicalPatchToDiff,
  validatePatchStructure as canonicalValidatePatchStructure,
} from '../../../packages/cartographer-core/src/analyze/patch.ts'
import { PatchEvaluationLimitError as CanonicalPatchEvaluationLimitError } from '../../../packages/cartographer-core/src/analyze/patchEvaluation.ts'
import {
  PatchSizeError as CanonicalPatchSizeError,
  serializePatch as canonicalSerializePatch,
} from '../../../packages/cartographer-core/src/store/patches.ts'

describe('patch helper facade', () =>
{
  it('re-exports the canonical implementations and error classes', () =>
  {
    expect(applyPatch).toBe(canonicalApplyPatch)
    expect(patchToDiff).toBe(canonicalPatchToDiff)
    expect(validatePatchStructure).toBe(canonicalValidatePatchStructure)
    expect(PatchEvaluationLimitError).toBe(CanonicalPatchEvaluationLimitError)
    expect(PatchSizeError).toBe(CanonicalPatchSizeError)
    expect(serializePatch).toBe(canonicalSerializePatch)
  })

  it('keeps canonical pretty-json serialization with one trailing newline', () =>
  {
    const patch: GraphPatch = {
      version: 1,
      meta: {
        name: 'Move service',
        createdAt: '2026-08-07T00:00:00.000Z',
      },
      ops: [{ op: 'move_file', from: 'src/old.ts', to: 'src/new.ts' }],
    }

    expect(serializePatch(patch)).toBe(`${JSON.stringify(patch, null, 2)}\n`)
  })
})
