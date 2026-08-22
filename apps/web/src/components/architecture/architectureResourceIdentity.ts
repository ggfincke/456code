// apps/web/src/components/architecture/architectureResourceIdentity.ts
// defines canonical identities for native architecture right-panel resources

import {
  ArchitectureImpactDescriptor as ArchitectureImpactDescriptorContract,
  ArchitectureRelativePath,
  type ArchitectureDiffSource,
  type ArchitectureGenerationId,
  type ArchitectureGraphDigest,
  type ArchitectureImpactDescriptor,
  type ArchitectureProjectionSource,
  type ArchitectureProposalSource,
  type ArchitectureStandingSource,
  type DiffAnalysisId,
  type ProjectId,
  type ProposalGenerationId,
  type ThreadId,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'

export type ArchitectureImpactTarget = {
  readonly kind: 'exact-impact'
  readonly descriptor: ArchitectureImpactDescriptor
}
export type RepositoryAtlasTarget = ArchitectureStandingSource
export type ArchitectureResourceSource = ArchitectureProjectionSource

export type ArchitectureFileSource = ArchitectureProposalSource | ArchitectureDiffSource

export interface ArchitectureFileOpenTarget
{
  readonly source: ArchitectureProjectionSource
  readonly relativePath: ArchitectureRelativePath
}

export type ArchitectureImpactSurface = {
  readonly id: `architecture-impact:${string}`
  readonly kind: 'architecture-impact'
  readonly target: ArchitectureImpactTarget
}

export type RepositoryAtlasSurface = {
  readonly id: `repository-atlas:${string}`
  readonly kind: 'repository-atlas'
  readonly target: RepositoryAtlasTarget
}

export type ArchitectureRightPanelSurface = ArchitectureImpactSurface | RepositoryAtlasSurface

type CanonicalIdentity = readonly (string | CanonicalIdentity)[]

function isRecord(value: unknown): value is Record<string, unknown>
{
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean
{
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function isIdentityString(value: unknown): value is string
{
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function isGenerationId(value: unknown): value is ArchitectureGenerationId
{
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isGraphDigest(value: unknown): value is ArchitectureGraphDigest
{
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
}

const isArchitectureRelativePathContract = Schema.is(ArchitectureRelativePath)
const isArchitectureImpactDescriptorContract = Schema.is(ArchitectureImpactDescriptorContract)

export function isArchitectureRelativePath(value: string): boolean
{
  return isArchitectureRelativePathContract(value)
}

// fixed-order tuples avoid object-key ordering and delimiter collisions
function encodeCanonicalIdentity(identity: CanonicalIdentity): string
{
  return encodeURIComponent(JSON.stringify(identity))
}

function sourceIdentity(source: ArchitectureResourceSource): CanonicalIdentity
{
  switch (source.kind)
  {
    case 'proposal-generation':
      return [source.kind, source.threadId, source.generationId, source.side, source.graphDigest]
    case 'diff-analysis':
      return [source.kind, source.threadId, source.diffAnalysisId, source.side, source.graphDigest]
    case 'standing-project-generation':
      return [source.kind, source.projectId, source.generationId, source.side, source.graphDigest]
  }
}

export function architectureImpactSurfaceId(
  target: ArchitectureImpactTarget,
): ArchitectureImpactSurface['id']
{
  return `architecture-impact:${encodeCanonicalIdentity([
    target.kind,
    target.descriptor.descriptorId,
  ])}`
}

export function repositoryAtlasSurfaceId(
  target: RepositoryAtlasTarget,
): RepositoryAtlasSurface['id']
{
  return `repository-atlas:${encodeCanonicalIdentity(sourceIdentity(target))}`
}

export function architectureFileSurfaceId(
  source: ArchitectureFileSource,
  relativePath: string,
): `architecture-file:${string}`
{
  return `architecture-file:${encodeCanonicalIdentity([sourceIdentity(source), relativePath])}`
}

export function createArchitectureImpactSurface(
  target: ArchitectureImpactTarget,
): ArchitectureImpactSurface
{
  return {
    id: architectureImpactSurfaceId(target),
    kind: 'architecture-impact',
    target,
  }
}

export function createRepositoryAtlasSurface(
  target: RepositoryAtlasTarget,
): RepositoryAtlasSurface
{
  return {
    id: repositoryAtlasSurfaceId(target),
    kind: 'repository-atlas',
    target,
  }
}

export function decodeArchitectureResourceSource(
  value: unknown,
): ArchitectureResourceSource | null
{
  if (!isRecord(value)) return null
  if (
    value.kind === 'proposal-generation' &&
    hasExactKeys(value, ['kind', 'threadId', 'generationId', 'side', 'graphDigest']) &&
    isIdentityString(value.threadId) &&
    isIdentityString(value.generationId) &&
    (value.side === 'base' || value.side === 'proposed') &&
    isGraphDigest(value.graphDigest)
  )
  {
    return {
      kind: 'proposal-generation',
      threadId: value.threadId as ThreadId,
      generationId: value.generationId as ProposalGenerationId,
      side: value.side,
      graphDigest: value.graphDigest,
    }
  }
  if (
    value.kind === 'diff-analysis' &&
    hasExactKeys(value, ['kind', 'threadId', 'diffAnalysisId', 'side', 'graphDigest']) &&
    isIdentityString(value.threadId) &&
    isIdentityString(value.diffAnalysisId) &&
    (value.side === 'base' || value.side === 'head') &&
    isGraphDigest(value.graphDigest)
  )
  {
    return {
      kind: 'diff-analysis',
      threadId: value.threadId as ThreadId,
      diffAnalysisId: value.diffAnalysisId as DiffAnalysisId,
      side: value.side,
      graphDigest: value.graphDigest,
    }
  }
  if (
    value.kind === 'standing-project-generation' &&
    hasExactKeys(value, ['kind', 'projectId', 'generationId', 'side', 'graphDigest']) &&
    isIdentityString(value.projectId) &&
    isGenerationId(value.generationId) &&
    value.side === 'analyzed' &&
    isGraphDigest(value.graphDigest)
  )
  {
    return {
      kind: 'standing-project-generation',
      projectId: value.projectId as ProjectId,
      generationId: value.generationId,
      side: 'analyzed',
      graphDigest: value.graphDigest,
    }
  }
  return null
}

export function decodeArchitectureFileSource(value: unknown): ArchitectureFileSource | null
{
  const source = decodeArchitectureResourceSource(value)
  return source?.kind === 'standing-project-generation' ? null : source
}

function decodeImpactTarget(value: unknown): ArchitectureImpactTarget | null
{
  if (
    isRecord(value) &&
    value.kind === 'exact-impact' &&
    hasExactKeys(value, ['kind', 'descriptor']) &&
    isArchitectureImpactDescriptorContract(value.descriptor)
  )
  {
    return { kind: 'exact-impact', descriptor: value.descriptor }
  }
  return null
}

function decodeRepositoryTarget(value: unknown): RepositoryAtlasTarget | null
{
  const source = decodeArchitectureResourceSource(value)
  return source?.kind === 'standing-project-generation' ? source : null
}

export function decodeArchitectureRightPanelSurface(
  value: unknown,
): ArchitectureRightPanelSurface | null
{
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'kind', 'target'])) return null
  if (typeof value.id !== 'string') return null
  switch (value.kind)
  {
    case 'architecture-impact':
    {
      const target = decodeImpactTarget(value.target)
      if (target === null || value.id !== architectureImpactSurfaceId(target)) return null
      return createArchitectureImpactSurface(target)
    }
    case 'repository-atlas':
    {
      const target = decodeRepositoryTarget(value.target)
      if (target === null || value.id !== repositoryAtlasSurfaceId(target)) return null
      return createRepositoryAtlasSurface(target)
    }
    default:
      return null
  }
}
