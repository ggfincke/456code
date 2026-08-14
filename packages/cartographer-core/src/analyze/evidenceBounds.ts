// packages/cartographer-core/src/analyze/evidenceBounds.ts
// policy-driven bounds w/ exact nested evidence totals & omissions

import { summarizeApiChanges, type ExportChange, type FileApiChange } from './diff.js'
import type { PatchValidation } from './patch.js'

export interface BoundedList<T>
{
  items: T[]
  total: number
  omitted: number
}

function assertEvidenceLimit(limit: number): void
{
  if (!Number.isSafeInteger(limit) || limit < 0)
  {
    throw new Error('evidence limit must be a safe nonnegative integer')
  }
}

export function boundList<T>(items: readonly T[], limit: number): BoundedList<T>
{
  assertEvidenceLimit(limit)
  const visible = items.slice(0, limit)
  return {
    items: visible,
    total: items.length,
    omitted: items.length - visible.length,
  }
}

export interface ApiEvidenceLimits
{
  files: number
  exportsPerFile: number
  consumersPerExport: number
}

export interface BoundedExportEvidence
{
  item: ExportChange
  totalConsumers: number
  omittedConsumers: number
}

export interface BoundedFileApiEvidence
{
  file: string
  removedExports: BoundedExportEvidence[]
  addedExports: BoundedExportEvidence[]
  totalExports: number
  omittedExports: number
  totalConsumers: number
  omittedConsumers: number
}

export interface BoundedApiEvidence
{
  files: BoundedFileApiEvidence[]
  totals: {
    files: number
    addedExports: number
    removedExports: number
    exports: number
    consumers: number
  }
  omitted: {
    files: number
    exports: number
    consumers: number
    total: number
  }
}

export function boundApiChanges(
  changes: readonly FileApiChange[],
  limits: ApiEvidenceLimits,
): BoundedApiEvidence
{
  assertEvidenceLimit(limits.files)
  assertEvidenceLimit(limits.exportsPerFile)
  assertEvidenceLimit(limits.consumersPerExport)
  const summary = summarizeApiChanges(changes)
  const boundedFiles = boundList(changes, limits.files)
  let includedExports = 0
  let includedConsumers = 0
  const files = boundedFiles.items.map((change) =>
  {
    const allExports = [
      ...change.removedExports.map((item) => ({ item, removed: true })),
      ...change.addedExports.map((item) => ({ item, removed: false })),
    ]
    const visibleExports = boundList(allExports, limits.exportsPerFile).items
    includedExports += visibleExports.length
    const totalConsumers = allExports.reduce(
      (total, entry) => total + (entry.item.brokenConsumers?.length ?? 0),
      0,
    )
    let fileIncludedConsumers = 0
    const boundExport = (entry: ExportChange): BoundedExportEvidence =>
    {
      const consumers = entry.brokenConsumers
      if (consumers === undefined)
      {
        return { item: entry, totalConsumers: 0, omittedConsumers: 0 }
      }
      const boundedConsumers = boundList(consumers, limits.consumersPerExport)
      fileIncludedConsumers += boundedConsumers.items.length
      return {
        item: { ...entry, brokenConsumers: boundedConsumers.items },
        totalConsumers: boundedConsumers.total,
        omittedConsumers: boundedConsumers.omitted,
      }
    }
    const removedExports = visibleExports
      .filter((entry) => entry.removed)
      .map((entry) => boundExport(entry.item))
    const addedExports = visibleExports
      .filter((entry) => !entry.removed)
      .map((entry) => boundExport(entry.item))
    includedConsumers += fileIncludedConsumers
    return {
      file: change.file,
      removedExports,
      addedExports,
      totalExports: allExports.length,
      omittedExports: allExports.length - visibleExports.length,
      totalConsumers,
      omittedConsumers: totalConsumers - fileIncludedConsumers,
    }
  })
  const exports = summary.addedExports + summary.removedExports
  const omitted = {
    files: boundedFiles.omitted,
    exports: exports - includedExports,
    consumers: summary.consumers - includedConsumers,
  }
  return {
    files,
    totals: {
      files: changes.length,
      addedExports: summary.addedExports,
      removedExports: summary.removedExports,
      exports,
      consumers: summary.consumers,
    },
    omitted: {
      ...omitted,
      total: omitted.files + omitted.exports + omitted.consumers,
    },
  }
}

export function projectBoundedApiChanges(evidence: BoundedApiEvidence): FileApiChange[]
{
  return evidence.files.map((file) => ({
    file: file.file,
    removedExports: file.removedExports.map((entry) => entry.item),
    addedExports: file.addedExports.map((entry) => entry.item),
  }))
}

export interface PatchValidationLimits
{
  cycles: number
  newBoundaries: number
  orphans: number
}

export interface BoundedPatchValidation
{
  cycles: BoundedList<PatchValidation['cycles'][number]>
  newBoundaries: BoundedList<PatchValidation['newBoundaries'][number]>
  orphans: BoundedList<PatchValidation['orphans'][number]>
  totals: PatchValidation['totals']
  omitted: number
}

export function boundPatchValidation(
  validation: PatchValidation,
  limits: PatchValidationLimits,
): BoundedPatchValidation
{
  const cycles = boundList(validation.cycles, limits.cycles)
  const newBoundaries = boundList(validation.newBoundaries, limits.newBoundaries)
  const orphans = boundList(validation.orphans, limits.orphans)
  return {
    cycles,
    newBoundaries,
    orphans,
    totals: validation.totals,
    omitted: cycles.omitted + newBoundaries.omitted + orphans.omitted,
  }
}
