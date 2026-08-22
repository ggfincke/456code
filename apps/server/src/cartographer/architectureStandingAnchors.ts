// apps/server/src/cartographer/architectureStandingAnchors.ts
// resolves exact graph selections against one pinned standing repository generation

// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from 'node:crypto'

import {
  type ArchitectureGraphProjectionEdge,
  type ArchitectureGraphProjectionEvidence,
  type ArchitectureGraphProjectionNode,
  type ArchitectureStandingAnchor,
  type ArchitectureStandingSource,
  type PlannedImpactMaterializedProjection,
  type PlannedImpactProjectionEdge,
  type PlannedImpactProjectionNode,
  type PlannedImpactStandingAnchor,
} from '@t3tools/contracts'
import {
  type AtlasIndexDominantCrosswalk,
  type AtlasIndexFileCrosswalk,
  type AtlasIndexStructureDirectory,
  type AtlasIndexV6,
} from '@t3tools/cartographer-core/server'

interface AnchorResolution
{
  readonly status: 'matched' | 'ambiguous' | 'unmatched'
  readonly lens: 'architecture' | 'structure'
  readonly candidateIds: string[]
  readonly candidateCount: ArchitectureStandingAnchor['candidateCount']
  readonly focusId?: string
  readonly nearestId?: string
  readonly disclosure: string
}

interface ProjectionSelections
{
  readonly nodes: ReadonlyArray<ArchitectureGraphProjectionNode>
  readonly edges: ReadonlyArray<ArchitectureGraphProjectionEdge>
}

interface ImpactProjectionSelections extends ProjectionSelections
{
  readonly evidence: ReadonlyArray<ArchitectureGraphProjectionEvidence>
}

function uniqueSorted(values: Iterable<string>): string[]
{
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function resolutionForCandidates(input: {
  readonly lens: AnchorResolution['lens']
  readonly candidateIds: Iterable<string>
  readonly matchedDisclosure: string
  readonly ambiguousDisclosure: string
  readonly unmatchedDisclosure: string
  readonly nearestId?: string
}): AnchorResolution
{
  const allCandidateIds = uniqueSorted(input.candidateIds)
  const candidateIds = allCandidateIds.slice(0, 60)
  const candidateCount = {
    total: allCandidateIds.length,
    returned: candidateIds.length,
    omitted: allCandidateIds.length - candidateIds.length,
  }
  const omissionDisclosure =
    candidateCount.omitted === 0
      ? ''
      : ` ${candidateCount.omitted} additional exact candidates are omitted from this bounded projection.`
  if (allCandidateIds.length === 1)
  {
    return {
      status: 'matched',
      lens: input.lens,
      candidateIds,
      candidateCount,
      focusId: candidateIds[0]!,
      disclosure: `${input.matchedDisclosure}${omissionDisclosure}`,
    }
  }
  if (allCandidateIds.length > 1)
  {
    return {
      status: 'ambiguous',
      lens: input.lens,
      candidateIds,
      candidateCount,
      disclosure: `${input.ambiguousDisclosure}${omissionDisclosure}`,
    }
  }
  return {
    status: 'unmatched',
    lens: input.lens,
    candidateIds: [],
    candidateCount,
    ...(input.nearestId === undefined ? {} : { nearestId: input.nearestId }),
    disclosure: input.unmatchedDisclosure,
  }
}

function materializeAnchor(
  selectionId: string,
  source: ArchitectureStandingSource,
  resolution: AnchorResolution,
  stale: boolean,
): ArchitectureStandingAnchor
{
  return {
    selectionId,
    status: stale ? 'stale' : resolution.status,
    source,
    lens: resolution.lens,
    candidateIds: resolution.candidateIds,
    candidateCount: resolution.candidateCount,
    ...(resolution.focusId === undefined ? {} : { focusId: resolution.focusId }),
    ...(resolution.nearestId === undefined ? {} : { nearestId: resolution.nearestId }),
    disclosure: stale
      ? `This anchor stays pinned to an older Repository Map generation. ${resolution.disclosure}`
      : resolution.disclosure,
  }
}

function crosswalkResolution(
  row: AtlasIndexDominantCrosswalk | undefined,
  lens: AnchorResolution['lens'],
): AnchorResolution
{
  return resolutionForCandidates({
    lens,
    candidateIds: row?.targetIds ?? [],
    matchedDisclosure: 'Opened the exact dominant membership in this Repository Map generation.',
    ambiguousDisclosure:
      'This selection has tied dominant memberships; all exact candidates are highlighted.',
    unmatchedDisclosure: 'This selection has no exact membership in the other lens.',
    ...(lens === 'structure' ? { nearestId: 'dirs:.' } : {}),
  })
}

function fileMembershipById(index: AtlasIndexV6): Map<string, AtlasIndexFileCrosswalk>
{
  return new Map(index.crosswalks.files.map((membership) => [membership.fileId, membership]))
}

function directoryById(index: AtlasIndexV6): Map<string, AtlasIndexStructureDirectory>
{
  return new Map(index.structure.directories.map((directory) => [directory.id, directory]))
}

function directoryKey(id: string): string
{
  return id.startsWith('dirs:') ? id.slice('dirs:'.length) : id
}

function isDirectoryAncestor(ancestorId: string, descendantId: string): boolean
{
  const ancestor = directoryKey(ancestorId)
  const descendant = directoryKey(descendantId)
  return ancestor === '.' || descendant === ancestor || descendant.startsWith(`${ancestor}/`)
}

function deepestCommonDirectory(
  index: AtlasIndexV6,
  directoryIds: ReadonlyArray<string>,
): string | undefined
{
  if (directoryIds.length === 0) return undefined
  return index.structure.directories
    .filter((directory) =>
      directoryIds.every((directoryId) => isDirectoryAncestor(directory.id, directoryId)),
    )
    .sort(
      (left, right) =>
        directoryKey(right.id).split('/').length - directoryKey(left.id).split('/').length ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )[0]?.id
}

function closestExistingDirectory(index: AtlasIndexV6, path: string): string
{
  const directories = directoryById(index)
  let candidate = path
  if (fileMembershipById(index).has(candidate))
  {
    return fileMembershipById(index).get(candidate)!.directoryId
  }
  while (candidate !== '.')
  {
    const direct = `dirs:${candidate}`
    if (directories.has(direct)) return direct
    const slash = candidate.lastIndexOf('/')
    candidate = slash < 0 ? '.' : candidate.slice(0, slash)
  }
  return index.structure.rootId
}

function filesWithinDirectory(index: AtlasIndexV6, directoryId: string): AtlasIndexFileCrosswalk[]
{
  return index.crosswalks.files.filter((membership) =>
    isDirectoryAncestor(directoryId, membership.directoryId),
  )
}

function filesForPaths(
  index: AtlasIndexV6,
  paths: ReadonlyArray<string>,
): AtlasIndexFileCrosswalk[]
{
  const memberships = fileMembershipById(index)
  const directories = directoryById(index)
  const matched = new Map<string, AtlasIndexFileCrosswalk>()
  for (const path of paths)
  {
    const exact = memberships.get(path)
    if (exact !== undefined)
    {
      matched.set(exact.fileId, exact)
      continue
    }
    const directoryId = `dirs:${path}`
    if (!directories.has(directoryId)) continue
    for (const membership of filesWithinDirectory(index, directoryId))
    {
      matched.set(membership.fileId, membership)
    }
  }
  return [...matched.values()]
}

function dominantCandidates(values: ReadonlyArray<string>): string[]
{
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const top = Math.max(0, ...counts.values())
  return uniqueSorted([...counts].filter(([, count]) => count === top).map(([value]) => value))
}

function evidencePaths(
  node: ArchitectureGraphProjectionNode,
  evidence: ReadonlyMap<string, ArchitectureGraphProjectionEvidence>,
): string[]
{
  return uniqueSorted([
    ...(node.relativePath === undefined ? [] : [node.relativePath]),
    ...node.evidenceRefs.flatMap((reference) => evidence.get(reference)?.paths ?? []),
  ])
}

function directImpactResolution(
  index: AtlasIndexV6,
  node: ArchitectureGraphProjectionNode,
): AnchorResolution | undefined
{
  if (node.semanticLevel === 'systems' && index.units.systems.some((unit) => unit.id === node.id))
  {
    return resolutionForCandidates({
      lens: 'architecture',
      candidateIds: [node.id],
      matchedDisclosure: 'This system exists in the pinned Repository Map generation.',
      ambiguousDisclosure: '',
      unmatchedDisclosure: '',
    })
  }
  if (node.semanticLevel === 'blocks' && index.units.blocks.some((unit) => unit.id === node.id))
  {
    return resolutionForCandidates({
      lens: 'architecture',
      candidateIds: [node.id],
      matchedDisclosure: 'This block exists in the pinned Repository Map generation.',
      ambiguousDisclosure: '',
      unmatchedDisclosure: '',
    })
  }
  if (
    node.semanticLevel === 'dirs' &&
    index.structure.directories.some((directory) => directory.id === node.id)
  )
  {
    return resolutionForCandidates({
      lens: 'structure',
      candidateIds: [node.id],
      matchedDisclosure: 'This directory exists in the pinned Repository Map generation.',
      ambiguousDisclosure: '',
      unmatchedDisclosure: '',
    })
  }
  if (
    node.semanticLevel === 'files' &&
    index.crosswalks.files.some((membership) => membership.fileId === node.id)
  )
  {
    return resolutionForCandidates({
      lens: 'structure',
      candidateIds: [node.id],
      matchedDisclosure: 'This file exists in the pinned Repository Map generation.',
      ambiguousDisclosure: '',
      unmatchedDisclosure: '',
    })
  }
  return undefined
}

function resolveImpactNode(
  index: AtlasIndexV6,
  node: ArchitectureGraphProjectionNode,
  evidence: ReadonlyMap<string, ArchitectureGraphProjectionEvidence>,
): AnchorResolution
{
  const direct = directImpactResolution(index, node)
  if (direct !== undefined) return direct
  const paths = evidencePaths(node, evidence)
  const memberships = filesForPaths(index, paths)
  if (node.semanticLevel === 'systems' || node.semanticLevel === 'blocks')
  {
    const candidateIds = dominantCandidates(
      memberships.map((membership) =>
        node.semanticLevel === 'systems' ? membership.systemId : membership.blockId,
      ),
    )
    if (node.state === 'added' && candidateIds.length > 0)
    {
      return {
        status: 'unmatched',
        lens: 'architecture',
        candidateIds: [],
        candidateCount: { total: 0, returned: 0, omitted: 0 },
        ...(candidateIds.length === 1 ? { nearestId: candidateIds[0] } : {}),
        disclosure:
          'This added semantic object is not present in the pinned generation; the nearest existing membership is shown without claiming a match.',
      }
    }
    return resolutionForCandidates({
      lens: 'architecture',
      candidateIds,
      matchedDisclosure:
        'Repository file membership resolved this semantic object to one exact existing candidate.',
      ambiguousDisclosure:
        'Repository file membership is tied across exact semantic candidates; no label match was used.',
      unmatchedDisclosure:
        'This semantic object is not present in the pinned Repository Map generation.',
    })
  }

  const exactFiles = uniqueSorted(
    paths.filter((path) => index.crosswalks.files.some((membership) => membership.fileId === path)),
  )
  if (exactFiles.length > 0)
  {
    return resolutionForCandidates({
      lens: 'structure',
      candidateIds: exactFiles,
      matchedDisclosure: 'An exact file identity matched the pinned Repository Map generation.',
      ambiguousDisclosure:
        'Multiple exact file identities matched; all candidates are highlighted.',
      unmatchedDisclosure: '',
    })
  }
  const exactDirectories = uniqueSorted(
    paths
      .map((path) => `dirs:${path}`)
      .filter((id) => index.structure.directories.some((directory) => directory.id === id)),
  )
  if (exactDirectories.length > 0)
  {
    return resolutionForCandidates({
      lens: 'structure',
      candidateIds: exactDirectories,
      matchedDisclosure:
        'An exact directory identity matched the pinned Repository Map generation.',
      ambiguousDisclosure:
        'Multiple exact directory identities matched; all candidates are highlighted.',
      unmatchedDisclosure: '',
    })
  }
  const nearestDirectories = paths.map((path) => closestExistingDirectory(index, path))
  const nearestId = deepestCommonDirectory(index, nearestDirectories) ?? index.structure.rootId
  return {
    status: 'unmatched',
    lens: 'structure',
    candidateIds: [],
    candidateCount: { total: 0, returned: 0, omitted: 0 },
    nearestId,
    disclosure:
      'This object is not present in the pinned Repository Map generation; the nearest existing parent is shown.',
  }
}

function semanticMemberships(
  index: AtlasIndexV6,
  node: ArchitectureGraphProjectionNode,
  evidence: ReadonlyMap<string, ArchitectureGraphProjectionEvidence>,
  additionalPaths: ReadonlyArray<string> = [],
): { systems: Set<string>; blocks: Set<string>; directories: Set<string> }
{
  const systems = new Set<string>()
  const blocks = new Set<string>()
  const directories = new Set<string>()
  const block = index.units.blocks.find((unit) => unit.id === node.id)
  if (node.semanticLevel === 'systems' && index.units.systems.some((unit) => unit.id === node.id))
  {
    systems.add(node.id)
  }
  if (block !== undefined)
  {
    blocks.add(block.id)
    if (block.parent !== undefined) systems.add(block.parent)
  }
  const paths = uniqueSorted([...evidencePaths(node, evidence), ...additionalPaths])
  const directDirectory =
    node.semanticLevel === 'dirs' &&
    index.structure.directories.some((directory) => directory.id === node.id)
      ? node.id
      : undefined
  const memberships =
    directDirectory === undefined
      ? filesForPaths(index, [node.id, ...paths])
      : filesWithinDirectory(index, directDirectory)
  for (const membership of memberships)
  {
    systems.add(membership.systemId)
    blocks.add(membership.blockId)
    directories.add(membership.directoryId)
  }
  return { systems, blocks, directories }
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): string[]
{
  return uniqueSorted([...left].filter((value) => right.has(value)))
}

function resolveRelationship(
  index: AtlasIndexV6,
  edge: ArchitectureGraphProjectionEdge,
  nodes: ReadonlyMap<string, ArchitectureGraphProjectionNode>,
  evidence: ReadonlyMap<string, ArchitectureGraphProjectionEvidence>,
): AnchorResolution
{
  const from = nodes.get(edge.from)
  const to = nodes.get(edge.to)
  if (from === undefined || to === undefined)
  {
    return {
      status: 'unmatched',
      lens: 'architecture',
      candidateIds: [],
      candidateCount: { total: 0, returned: 0, omitted: 0 },
      disclosure: 'The relationship endpoints are unavailable in this bounded projection.',
    }
  }
  const relationshipPaths = uniqueSorted(
    edge.evidenceRefs.flatMap((reference) => evidence.get(reference)?.paths ?? []),
  )
  const fromMembership = semanticMemberships(index, from, evidence, relationshipPaths)
  const toMembership = semanticMemberships(index, to, evidence, relationshipPaths)
  const systems = intersection(fromMembership.systems, toMembership.systems)
  if (systems.length > 0)
  {
    return resolutionForCandidates({
      lens: 'architecture',
      candidateIds: systems,
      matchedDisclosure: 'The relationship opens at the broadest exact common system membership.',
      ambiguousDisclosure:
        'The relationship has tied common system memberships; all candidates are highlighted.',
      unmatchedDisclosure: '',
    })
  }
  const blocks = intersection(fromMembership.blocks, toMembership.blocks)
  if (blocks.length > 0)
  {
    return resolutionForCandidates({
      lens: 'architecture',
      candidateIds: blocks,
      matchedDisclosure: 'The relationship opens at its exact common block membership.',
      ambiguousDisclosure:
        'The relationship has tied common block memberships; all candidates are highlighted.',
      unmatchedDisclosure: '',
    })
  }
  const nearestId = deepestCommonDirectory(index, [
    ...fromMembership.directories,
    ...toMembership.directories,
  ])
  return {
    status: 'unmatched',
    lens: 'structure',
    candidateIds: [],
    candidateCount: { total: 0, returned: 0, omitted: 0 },
    nearestId: nearestId ?? index.structure.rootId,
    disclosure:
      'No common semantic anchor exists in this generation; the nearest shared repository context is shown.',
  }
}

export function resolveImpactStandingAnchors(input: {
  readonly index: AtlasIndexV6
  readonly source: ArchitectureStandingSource
  readonly projection: ImpactProjectionSelections
  readonly stale: boolean
}): ArchitectureStandingAnchor[]
{
  const evidence = new Map(input.projection.evidence.map((item) => [item.id, item]))
  const nodes = new Map(input.projection.nodes.map((node) => [node.id, node]))
  return [
    ...input.projection.nodes.map((node) =>
      materializeAnchor(
        node.id,
        input.source,
        resolveImpactNode(input.index, node, evidence),
        input.stale,
      ),
    ),
    ...input.projection.edges.map((edge) =>
      materializeAnchor(
        edge.id,
        input.source,
        resolveRelationship(input.index, edge, nodes, evidence),
        input.stale,
      ),
    ),
  ].slice(0, 180)
}

function crossLensNodeResolution(
  index: AtlasIndexV6,
  node: ArchitectureGraphProjectionNode,
  currentLens: 'architecture' | 'structure',
): AnchorResolution
{
  if (node.semanticLevel === 'files')
  {
    const exists = index.crosswalks.files.some((membership) => membership.fileId === node.id)
    return resolutionForCandidates({
      lens: currentLens === 'architecture' ? 'structure' : 'architecture',
      candidateIds: exists ? [node.id] : [],
      matchedDisclosure: 'The exact file identity is preserved across Repository Map lenses.',
      ambiguousDisclosure: '',
      unmatchedDisclosure: 'This file has no exact cross-lens identity in the pinned generation.',
      ...(currentLens === 'architecture' ? { nearestId: index.structure.rootId } : {}),
    })
  }
  if (node.semanticLevel === 'systems')
  {
    return crosswalkResolution(
      index.crosswalks.systemsToDirectories.find((row) => row.sourceId === node.id),
      'structure',
    )
  }
  if (node.semanticLevel === 'blocks')
  {
    return crosswalkResolution(
      index.crosswalks.blocksToDirectories.find((row) => row.sourceId === node.id),
      'structure',
    )
  }
  const block = index.crosswalks.directoriesToBlocks.find((row) => row.sourceId === node.id)
  if (block !== undefined && block.targetIds.length > 0)
  {
    return crosswalkResolution(block, 'architecture')
  }
  return crosswalkResolution(
    index.crosswalks.directoriesToSystems.find((row) => row.sourceId === node.id),
    'architecture',
  )
}

function crossLensRelationshipResolution(
  index: AtlasIndexV6,
  currentLens: 'architecture' | 'structure',
  edge: ArchitectureGraphProjectionEdge,
  nodes: ReadonlyMap<string, ArchitectureGraphProjectionNode>,
): AnchorResolution
{
  const from = nodes.get(edge.from)
  const to = nodes.get(edge.to)
  if (from === undefined || to === undefined)
  {
    return {
      status: 'unmatched',
      lens: currentLens === 'architecture' ? 'structure' : 'architecture',
      candidateIds: [],
      candidateCount: { total: 0, returned: 0, omitted: 0 },
      disclosure: 'The relationship endpoints are unavailable in this bounded projection.',
    }
  }
  if (currentLens === 'structure')
  {
    return resolveRelationship(index, edge, nodes, new Map())
  }
  const fromResolution = crossLensNodeResolution(index, from, currentLens)
  const toResolution = crossLensNodeResolution(index, to, currentLens)
  const common = intersection(
    new Set(fromResolution.candidateIds),
    new Set(toResolution.candidateIds),
  )
  if (common.length > 0)
  {
    return resolutionForCandidates({
      lens: 'structure',
      candidateIds: common,
      matchedDisclosure: 'The relationship opens at its broadest common directory anchor.',
      ambiguousDisclosure:
        'The relationship has tied common directory anchors; all candidates are highlighted.',
      unmatchedDisclosure: '',
    })
  }
  const memberships = fileMembershipById(index)
  const endpointDirectories = [from.id, to.id]
    .map((id) => memberships.get(id)?.directoryId)
    .filter((id): id is string => id !== undefined)
  return {
    status: 'unmatched',
    lens: 'structure',
    candidateIds: [],
    candidateCount: { total: 0, returned: 0, omitted: 0 },
    nearestId: deepestCommonDirectory(index, endpointDirectories) ?? index.structure.rootId,
    disclosure:
      'No common exact directory anchor exists; the nearest shared repository context is shown.',
  }
}

export function resolveStandingCrossLensAnchors(input: {
  readonly index: AtlasIndexV6
  readonly source: ArchitectureStandingSource
  readonly lens: 'architecture' | 'structure'
  readonly projection: ProjectionSelections
  readonly stale: boolean
}): ArchitectureStandingAnchor[]
{
  const nodes = new Map(input.projection.nodes.map((node) => [node.id, node]))
  return [
    ...input.projection.nodes.map((node) =>
      materializeAnchor(
        node.id,
        input.source,
        crossLensNodeResolution(input.index, node, input.lens),
        input.stale,
      ),
    ),
    ...input.projection.edges.map((edge) =>
      materializeAnchor(
        edge.id,
        input.source,
        crossLensRelationshipResolution(input.index, input.lens, edge, nodes),
        input.stale,
      ),
    ),
  ].slice(0, 180)
}

export function unavailableImpactStandingAnchors(input: {
  readonly source: ArchitectureStandingSource
  readonly projection: ProjectionSelections
}): ArchitectureStandingAnchor[]
{
  return [
    ...input.projection.nodes.map((node) => ({
      selectionId: node.id,
      status: 'stale' as const,
      source: input.source,
      lens:
        node.semanticLevel === 'systems' || node.semanticLevel === 'blocks'
          ? ('architecture' as const)
          : ('structure' as const),
      candidateIds: [],
      candidateCount: { total: 0, returned: 0, omitted: 0 },
      disclosure:
        'The pinned Repository Map generation is no longer available. Open a newer projection explicitly to resolve this selection.',
    })),
    ...input.projection.edges.map((edge) => ({
      selectionId: edge.id,
      status: 'stale' as const,
      source: input.source,
      lens: 'architecture' as const,
      candidateIds: [],
      candidateCount: { total: 0, returned: 0, omitted: 0 },
      disclosure:
        'The pinned Repository Map generation is no longer available. Open a newer projection explicitly to resolve this relationship.',
    })),
  ].slice(0, 180)
}

function plannedSemanticLevel(value: string): ArchitectureGraphProjectionNode['semanticLevel']
{
  const normalized = value.trim().toLowerCase()
  if (normalized === 'system' || normalized === 'systems') return 'systems'
  if (
    normalized === 'block' ||
    normalized === 'blocks' ||
    normalized === 'component' ||
    normalized === 'module' ||
    normalized === 'service'
  )
    return 'blocks'
  if (
    normalized === 'dir' ||
    normalized === 'directory' ||
    normalized === 'package' ||
    normalized === 'folder'
  )
    return 'dirs'
  return 'files'
}

function plannedTreatment(state: PlannedImpactProjectionNode['state'])
{
  switch (state)
  {
    case 'added':
      return { stateLabel: 'Added' as const, badge: 'plus' as const, stroke: 'solid' as const }
    case 'removed':
      return { stateLabel: 'Removed' as const, badge: 'minus' as const, stroke: 'dashed' as const }
    case 'affected':
      return {
        stateLabel: 'Affected' as const,
        badge: 'affected' as const,
        stroke: 'double' as const,
      }
  }
}

function standingPosition(
  index: AtlasIndexV6,
  id: string,
): { readonly x: number; readonly y: number } | undefined
{
  return (
    index.units.systems.find((unit) => unit.id === id)?.position ??
    index.units.blocks.find((unit) => unit.id === id)?.position ??
    index.structure.directories.find((directory) => directory.id === id)?.position ??
    index.crosswalks.files.find((membership) => membership.fileId === id)?.position
  )
}

function standingTint(id: string): string
{
  return NodeCrypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12)
}

// resolves provider-local claims once, then fixes ids and anchors on the appended revision.
export function anchorPlannedImpactProjection(input: {
  readonly index: AtlasIndexV6
  readonly source: ArchitectureStandingSource
  readonly projection: PlannedImpactMaterializedProjection
}): {
  readonly nodes: PlannedImpactProjectionNode[]
  readonly edges: PlannedImpactProjectionEdge[]
  readonly standingAnchors: PlannedImpactStandingAnchor[]
}
{
  const nodeEvidence = new Map(
    input.projection.nodes.map((node) => [
      node.id,
      `planned-anchor-evidence:object:${node.localId}`,
    ]),
  )
  const edgeEvidence = new Map(
    input.projection.edges.map((edge) => [
      edge.id,
      `planned-anchor-evidence:relationship:${edge.localId}`,
    ]),
  )
  const evidence: ArchitectureGraphProjectionEvidence[] = [
    ...input.projection.nodes.map((node) => ({
      id: nodeEvidence.get(node.id)!,
      kind: 'planned' as const,
      state: node.state,
      label: node.description ?? node.label,
      paths: [...node.pathHints],
    })),
    ...input.projection.edges.map((edge) => ({
      id: edgeEvidence.get(edge.id)!,
      kind: 'planned' as const,
      state: edge.state,
      label: edge.rationale ?? `${edge.relationshipKind} relationship`,
      paths: [...edge.pathHints],
    })),
  ]
  const nodes: ArchitectureGraphProjectionNode[] = input.projection.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    semanticLevel: plannedSemanticLevel(node.semanticLevel),
    ...(node.pathHints.length === 1 ? { relativePath: node.pathHints[0]! as never } : {}),
    position: node.position,
    tintKey: node.tintKey,
    state: node.state,
    ...plannedTreatment(node.state),
    fileCount: node.pathHints.length,
    inbound: input.projection.edges.filter((edge) => edge.to === node.id).length,
    outbound: input.projection.edges.filter((edge) => edge.from === node.id).length,
    affectedConsumerCount: 0,
    evidenceRefs: [nodeEvidence.get(node.id)!],
  }))
  const edges: ArchitectureGraphProjectionEdge[] = input.projection.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    relationshipKind: edge.relationshipKind,
    weight: edge.weight ?? 1,
    state: edge.state,
    stateLabel: plannedTreatment(edge.state).stateLabel,
    stroke: plannedTreatment(edge.state).stroke,
    evidenceRefs: [edgeEvidence.get(edge.id)!],
  }))
  const resolved = resolveImpactStandingAnchors({
    index: input.index,
    source: input.source,
    projection: { nodes, edges, evidence },
    stale: false,
  })
  const nodeById = new Map(input.projection.nodes.map((node) => [node.id, node]))
  const edgeById = new Map(input.projection.edges.map((edge) => [edge.id, edge]))
  const standingAnchors = resolved.map((anchor): PlannedImpactStandingAnchor =>
  {
    const node = nodeById.get(anchor.selectionId)
    const edge = edgeById.get(anchor.selectionId)
    const unavailable = anchor.status === 'stale'
    return {
      selectionKind: node === undefined ? 'relationship' : 'object',
      localId: node?.localId ?? edge!.localId,
      status: unavailable ? 'unmatched' : anchor.status,
      lens: anchor.lens,
      candidateIds: unavailable ? [] : [...anchor.candidateIds],
      candidateCount: unavailable
        ? { total: 0, returned: 0, omitted: 0 }
        : { ...anchor.candidateCount },
      ...(unavailable || anchor.focusId === undefined ? {} : { focusId: anchor.focusId }),
      ...(anchor.nearestId === undefined ? {} : { nearestId: anchor.nearestId }),
      disclosure: anchor.disclosure,
    }
  })
  const matchedFocuses = standingAnchors.flatMap((anchor) =>
  {
    if (
      anchor.selectionKind !== 'object' ||
      anchor.status !== 'matched' ||
      anchor.focusId === undefined
    )
    {
      return []
    }
    const node = input.projection.nodes.find((candidate) => candidate.localId === anchor.localId)
    return node?.state === 'added' ? [] : [anchor.focusId]
  })
  const focusCounts = new Map<string, number>()
  for (const focus of matchedFocuses) focusCounts.set(focus, (focusCounts.get(focus) ?? 0) + 1)
  const remappedIdByOriginal = new Map<string, string>()
  for (const anchor of standingAnchors)
  {
    if (
      anchor.selectionKind !== 'object' ||
      anchor.status !== 'matched' ||
      anchor.focusId === undefined ||
      focusCounts.get(anchor.focusId) !== 1
    )
      continue
    const node = input.projection.nodes.find((candidate) => candidate.localId === anchor.localId)
    if (node !== undefined && node.state !== 'added')
      remappedIdByOriginal.set(node.id, anchor.focusId)
  }
  return {
    nodes: input.projection.nodes.map((node) =>
    {
      const id = remappedIdByOriginal.get(node.id)
      const position = id === undefined ? undefined : standingPosition(input.index, id)
      return {
        ...node,
        ...(id === undefined ? {} : { id, tintKey: standingTint(id) }),
        ...(position === undefined ? {} : { position }),
      }
    }),
    edges: input.projection.edges.map((edge) => ({
      ...edge,
      from: remappedIdByOriginal.get(edge.from) ?? edge.from,
      to: remappedIdByOriginal.get(edge.to) ?? edge.to,
    })),
    standingAnchors,
  }
}
