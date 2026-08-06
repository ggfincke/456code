// apps/web/src/components/settings/ImportSessionsPanel.logic.ts
// derive import-session candidate selection and announcement copy

import type {
  ImportScanCandidate,
  ImportSessionsRequest,
  ImportSessionsResult,
  ProviderInstanceId,
} from '@t3tools/contracts'

import type { ImportSessionProgress } from '../../hooks/useImportSessions'
import { importSourceDisplayName, importSourceDriverKind } from '../../lib/importSourcePresentation'
import type { ProviderInstanceEntry } from '../../providerInstances'

export interface CandidateProviderSelection
{
  readonly options: ReadonlyArray<{
    readonly entry: ProviderInstanceEntry | null
    readonly instanceId: ProviderInstanceId
    readonly selectable: boolean
  }>
  readonly providerInstanceId: ProviderInstanceId | null
  readonly blockedReason: string | null
}

export interface ImportCandidateGroup
{
  readonly key: string
  readonly title: string
  readonly candidates: ReadonlyArray<ImportScanCandidate>
}

export type BulkSelectionMode = 'all' | 'resumable' | 'transcript-only'

export const IMPORT_CANDIDATE_PAGE_SIZE = 50

export function boundImportCandidateGroups(
  groups: ReadonlyArray<ImportCandidateGroup>,
  requestedVisibleCount: number,
): {
  readonly groups: ReadonlyArray<ImportCandidateGroup>
  readonly hiddenCandidateCount: number
  readonly visibleCandidateCount: number
}
{
  const candidateCount = groups.reduce((total, group) => total + group.candidates.length, 0)
  const normalizedVisibleCount = Number.isFinite(requestedVisibleCount)
    ? Math.max(0, Math.floor(requestedVisibleCount))
    : 0
  const visibleCandidateCount = Math.min(candidateCount, normalizedVisibleCount)
  let remaining = visibleCandidateCount
  const visibleGroups = groups.flatMap((group) =>
  {
    if (remaining === 0)
    {
      return []
    }
    const candidates = group.candidates.slice(0, remaining)
    remaining -= candidates.length
    return candidates.length === 0 ? [] : [{ ...group, candidates }]
  })

  return {
    groups: visibleGroups,
    hiddenCandidateCount: candidateCount - visibleCandidateCount,
    visibleCandidateCount,
  }
}

export function nextImportCandidateVisibleCount(
  visibleCandidateCount: number,
  candidateCount: number,
): number
{
  return Math.min(candidateCount, visibleCandidateCount + IMPORT_CANDIDATE_PAGE_SIZE)
}

export function candidateKey(candidate: ImportScanCandidate): string
{
  return `${candidate.source}\u0000${candidate.sourcePath}`
}

export function candidateDomKey(candidate: ImportScanCandidate): string
{
  return encodeURIComponent(candidateKey(candidate))
}

export function candidateSourceLabel(candidate: ImportScanCandidate): string
{
  return importSourceDisplayName(candidate.source)
}

export function candidateDriverKind(candidate: ImportScanCandidate)
{
  return importSourceDriverKind(candidate.source)
}

export function candidateGroupPresentation(title: string): {
  readonly detail: string | null
  readonly label: string
}
{
  const normalized = title.replaceAll('\\', '/').replace(/\/+$/, '')
  const isPath =
    normalized.startsWith('/') || normalized.startsWith('~/') || /^[a-z]:\//i.test(normalized)
  if (!isPath)
  {
    return { detail: null, label: title }
  }
  return {
    detail: title,
    label: normalized.split('/').at(-1) || title,
  }
}

export function isImportTargetSelectable(entry: ProviderInstanceEntry | null): boolean
{
  return Boolean(
    entry && entry.enabled && entry.installed && entry.isAvailable && entry.status !== 'disabled',
  )
}

export function importRequestItemForCandidate(
  candidate: ImportScanCandidate,
  providerInstanceId: ProviderInstanceId | null,
): ImportSessionsRequest['items'][number] | null
{
  if (
    providerInstanceId === null ||
    candidate.alreadyImportedArchived ||
    candidate.messageCount === 0
  )
  {
    return null
  }
  if (
    candidate.alreadyImportedThreadId !== null &&
    candidate.alreadyImportedProviderInstanceId !== null &&
    candidate.alreadyImportedProviderInstanceId !== providerInstanceId
  )
  {
    return null
  }
  return {
    source: candidate.source,
    sourcePath: candidate.sourcePath,
    providerInstanceId,
  }
}

export function resolveCandidateProviderSelection(
  candidate: ImportScanCandidate,
  providerEntries: ReadonlyArray<ProviderInstanceEntry>,
  explicitlySelectedInstanceId: ProviderInstanceId | null,
): CandidateProviderSelection
{
  const expectedDriverKind = candidateDriverKind(candidate)
  const entryByInstanceId = new Map(
    providerEntries
      .filter((entry) => entry.driverKind === expectedDriverKind)
      .map((entry) => [entry.instanceId, entry]),
  )
  const importedOwnerInstanceId =
    candidate.alreadyImportedThreadId === null ? null : candidate.alreadyImportedProviderInstanceId
  const compatibleInstanceIds =
    importedOwnerInstanceId === null
      ? [...new Set(candidate.providerInstanceIds)]
      : [importedOwnerInstanceId]
  const options = compatibleInstanceIds.map((instanceId) =>
  {
    const entry = entryByInstanceId.get(instanceId) ?? null
    return {
      entry,
      instanceId,
      selectable: isImportTargetSelectable(entry),
    }
  })
  const automaticInstanceId =
    compatibleInstanceIds.length === 1 && options[0]?.selectable ? compatibleInstanceIds[0]! : null
  const explicitOption =
    explicitlySelectedInstanceId === null
      ? null
      : (options.find(
          (option) => option.instanceId === explicitlySelectedInstanceId && option.selectable,
        ) ?? null)
  const providerInstanceId = explicitOption?.instanceId ?? automaticInstanceId

  if (compatibleInstanceIds.length === 0)
  {
    return {
      options,
      providerInstanceId: null,
      blockedReason: 'No configured provider instance matches this session source.',
    }
  }
  if (!options.some((option) => option.selectable))
  {
    return {
      options,
      providerInstanceId: null,
      blockedReason: 'Compatible provider instances are missing, disabled, or unavailable.',
    }
  }
  return {
    options,
    providerInstanceId,
    blockedReason: null,
  }
}

export function providerOptionLabel(option: CandidateProviderSelection['options'][number]): string
{
  if (option.entry === null)
  {
    return `${option.instanceId} — Missing`
  }
  if (!option.selectable)
  {
    return `${option.entry.displayName} — Unavailable`
  }
  if (option.entry.status === 'ready')
  {
    return option.entry.displayName
  }
  return `${option.entry.displayName} — ${option.entry.status}`
}

export function importSessionsAnnouncement(input: {
  readonly candidateCount: number
  readonly hasScanned: boolean
  readonly importError: string | null
  readonly importResult: ImportSessionsResult | null
  readonly importProgress?: ImportSessionProgress | null
  readonly isImporting: boolean
  readonly isScanning: boolean
  readonly scanError: string | null
  readonly scanTruncated: boolean
}): string
{
  if (input.importProgress?.phase === 'stopping')
  {
    return `Stopping after the current batch. ${input.importProgress.completed} of ${input.importProgress.total} sessions processed.`
  }
  if (input.importProgress?.phase === 'cancelled')
  {
    return `Import stopped after ${input.importProgress.completed} of ${input.importProgress.total} sessions. ${input.importProgress.imported} imported, ${input.importProgress.skipped} skipped, ${input.importProgress.failed} failed.`
  }
  if (input.isImporting)
  {
    return input.importProgress
      ? `Importing selected sessions. ${input.importProgress.completed} of ${input.importProgress.total} processed.`
      : 'Importing selected sessions.'
  }
  if (input.importError)
  {
    return `Import failed: ${input.importError}`
  }
  if (input.isScanning)
  {
    return 'Scanning for local sessions.'
  }
  if (input.scanError)
  {
    const importPrefix = input.importResult
      ? `Import complete. ${input.importResult.imported.length} imported, ${input.importResult.skipped.length} skipped, ${input.importResult.failed.length} failed. `
      : ''
    return `${importPrefix}Scan failed: ${input.scanError}`
  }
  if (input.importResult)
  {
    const imported = input.importResult.imported.length
    const skipped = input.importResult.skipped.length
    const failed = input.importResult.failed.length
    return `Import complete. ${imported} imported, ${skipped} skipped, ${failed} failed.`
  }
  if (!input.hasScanned)
  {
    return 'Ready to scan for local sessions.'
  }
  const found = `${input.candidateCount} ${
    input.candidateCount === 1 ? 'session' : 'sessions'
  } found.`
  return input.scanTruncated ? `${found} Results may be incomplete.` : found
}

export function candidateMessageCountLabel(messageCount: number | null): string | null
{
  return messageCount === null
    ? null
    : `${messageCount} ${messageCount === 1 ? 'message' : 'messages'}`
}
