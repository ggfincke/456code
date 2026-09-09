// apps/web/src/onboarding/projectImport.logic.ts
// groups bounded import candidates by repository identity

import type { ImportScanCandidate } from '@t3tools/contracts'
import { normalizeProjectPathForComparison } from '@t3tools/shared/path'

export interface OnboardingImportGroup
{
  readonly key: string
  readonly title: string
  readonly candidates: ReadonlyArray<ImportScanCandidate>
  readonly latestActivityAt: string | null
}

function latestActivity(candidates: ReadonlyArray<ImportScanCandidate>): string | null
{
  return candidates.reduce<string | null>((latest, candidate) =>
  {
    if (candidate.modifiedAt === null) return latest
    return latest === null || candidate.modifiedAt > latest ? candidate.modifiedAt : latest
  }, null)
}

export function groupOnboardingImportCandidates(
  candidates: ReadonlyArray<ImportScanCandidate>,
): ReadonlyArray<OnboardingImportGroup>
{
  const groups = new Map<string, ImportScanCandidate[]>()
  for (const candidate of candidates)
  {
    const repositoryKey = candidate.repositoryIdentity?.canonicalKey
    const key =
      repositoryKey === undefined
        ? candidate.cwd === null
          ? 'directory:none'
          : `directory:${normalizeProjectPathForComparison(candidate.cwd)}`
        : `repository:${repositoryKey}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .map(([key, group]) =>
    {
      const repository = group.find(
        (candidate) => candidate.repositoryIdentity !== null,
      )?.repositoryIdentity
      return {
        key,
        title:
          repository?.displayName ??
          (repository?.owner && repository.name
            ? `${repository.owner}/${repository.name}`
            : (group[0]?.cwd ?? 'No recorded directory')),
        candidates: group.toSorted((left, right) =>
          (right.modifiedAt ?? '').localeCompare(left.modifiedAt ?? ''),
        ),
        latestActivityAt: latestActivity(group),
      }
    })
    .toSorted((left, right) =>
      (right.latestActivityAt ?? '').localeCompare(left.latestActivityAt ?? ''),
    )
}

export function recentOnboardingImportCandidateKeys(
  candidates: ReadonlyArray<ImportScanCandidate>,
  now = Date.now(),
): ReadonlySet<string>
{
  const cutoff = now - 30 * 24 * 60 * 60 * 1_000
  return new Set(
    candidates
      .filter((candidate) =>
      {
        const modifiedAt =
          candidate.modifiedAt === null ? Number.NaN : Date.parse(candidate.modifiedAt)
        return modifiedAt >= cutoff && modifiedAt <= now
      })
      .map((candidate) => `${candidate.source}\0${candidate.sourcePath}`),
  )
}
