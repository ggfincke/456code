// packages/client-runtime/src/state/workspace/diffAnalysis.ts
// owns normalized diff-analysis targets and environment RPC atoms

import {
  type DiffAnalysisGeneration,
  type DiffAnalysisOwner,
  type DiffAnalysisSource,
  type EnvironmentId,
  WS_METHODS,
} from '@t3tools/contracts'
import { Atom } from 'effect/unstable/reactivity'

import type { EnvironmentRegistry } from '../../connection/registry.ts'
import {
  type AtomCommand,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from '../runtime.ts'

export interface DiffAnalysisTarget
{
  readonly environmentId: EnvironmentId
  readonly input: {
    readonly owner: DiffAnalysisOwner
    readonly source: DiffAnalysisSource
  }
}

export interface DiffAnalysisGenerationTarget extends DiffAnalysisTarget
{
  readonly generation: DiffAnalysisGeneration
}

function normalizeNonEmpty(value: string): string
{
  return value.trim()
}

export function normalizeDiffAnalysisSource(source: DiffAnalysisSource): DiffAnalysisSource
{
  switch (source.sourceKind)
  {
    case 'checkpoint':
      return source
    case 'review':
    {
      const baseRef = source.baseRef?.trim()
      return {
        sourceKind: 'review',
        cwd: normalizeNonEmpty(source.cwd),
        kind: source.kind,
        ...(baseRef ? { baseRef } : {}),
      }
    }
    case 'tree-pair':
      return {
        sourceKind: 'tree-pair',
        cwd: normalizeNonEmpty(source.cwd),
        baseTreeOid: normalizeNonEmpty(source.baseTreeOid).toLowerCase(),
        headTreeOid: normalizeNonEmpty(source.headTreeOid).toLowerCase(),
      }
    case 'commit-pair':
      return {
        sourceKind: 'commit-pair',
        cwd: normalizeNonEmpty(source.cwd),
        baseCommitOid: normalizeNonEmpty(source.baseCommitOid).toLowerCase(),
        headCommitOid: normalizeNonEmpty(source.headCommitOid).toLowerCase(),
      }
  }
}

export function normalizeDiffAnalysisTarget(target: DiffAnalysisTarget): DiffAnalysisTarget
{
  return {
    environmentId: target.environmentId,
    input: {
      owner: target.input.owner,
      source: normalizeDiffAnalysisSource(target.input.source),
    },
  }
}

export function shouldPollDiffAnalysisGeneration(
  generation: DiffAnalysisGeneration | null,
): boolean
{
  if (generation === null) return true
  return (
    generation.state === 'queued' ||
    generation.state === 'preparing' ||
    generation.state === 'analyzing'
  )
}

export function diffAnalysisSourceKey(source: DiffAnalysisSource): string
{
  const normalized = normalizeDiffAnalysisSource(source)
  switch (normalized.sourceKind)
  {
    case 'checkpoint':
      return JSON.stringify([
        'checkpoint',
        normalized.threadId,
        normalized.fromTurnCount,
        normalized.toTurnCount,
      ])
    case 'review':
      return JSON.stringify(['review', normalized.cwd, normalized.kind, normalized.baseRef ?? null])
    case 'tree-pair':
      return JSON.stringify([
        'tree-pair',
        normalized.cwd,
        normalized.baseTreeOid,
        normalized.headTreeOid,
      ])
    case 'commit-pair':
      return JSON.stringify([
        'commit-pair',
        normalized.cwd,
        normalized.baseCommitOid,
        normalized.headCommitOid,
      ])
  }
}

export function diffAnalysisTargetKey(target: DiffAnalysisTarget): string
{
  return JSON.stringify([
    target.environmentId,
    'threadId' in target.input.owner
      ? ['thread', target.input.owner.threadId]
      : ['project', target.input.owner.projectId],
    diffAnalysisSourceKey(target.input.source),
  ])
}

export function diffAnalysisGenerationKey(target: DiffAnalysisGenerationTarget): string
{
  return JSON.stringify([diffAnalysisTargetKey(target), target.generation.diffAnalysisId])
}

function normalizeCommandTarget<A, E>(
  command: AtomCommand<DiffAnalysisTarget, A, E>,
): AtomCommand<DiffAnalysisTarget, A, E>
{
  return {
    ...command,
    run: (registry, target) => command.run(registry, normalizeDiffAnalysisTarget(target)),
  }
}

function normalizeDiffAnalysisReadTarget(
  target: DiffAnalysisTarget | DiffAnalysisGenerationTarget,
)
{
  const normalized = normalizeDiffAnalysisTarget(target)
  return {
    ...normalized,
    input: {
      ...normalized.input,
      ...('generation' in target ? { diffAnalysisId: target.generation.diffAnalysisId } : {}),
    },
  }
}

export function createDiffAnalysisEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
)
{
  const scheduler = createAtomCommandScheduler()
  const getDiffAnalysis = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: 'environment-data:cartographer:get-diff-analysis',
    tag: WS_METHODS.cartographerGetDiffAnalysis,
    staleTimeMs: 0,
  })
  const requestDiffAnalysis = createEnvironmentRpcCommand(runtime, {
    label: 'environment-data:cartographer:request-diff-analysis',
    tag: WS_METHODS.cartographerRequestDiffAnalysis,
    scheduler,
    concurrency: {
      mode: 'singleFlight',
      key: diffAnalysisTargetKey,
    },
  })

  return {
    getDiffAnalysis: (target: DiffAnalysisTarget | DiffAnalysisGenerationTarget) =>
      getDiffAnalysis(normalizeDiffAnalysisReadTarget(target)),
    requestDiffAnalysis: normalizeCommandTarget(requestDiffAnalysis),
  }
}
