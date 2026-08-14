// packages/cartographer-core/src/emit/pr-summary.ts
// render a graphdiff as a markdown pr comment body

import {
  boundApiChanges,
  formatEdgeEndpoints,
  summarizeApiChanges,
  type BoundedExportEvidence,
  type EdgeEndpoints,
  type ExportChange,
  type GraphDiff,
  type ViolationDelta,
} from '../analyze/index.js'
import type { CartographerGraph } from '../contracts/types.js'

// keep PR comments scannable -> cap each change list
const LIST_CAP = 20
const API_EXPORT_CAP = 100
const CONSUMER_CAP = 8
const PR_SUMMARY_MAX_BYTES = 60_000

export function formatPrSummary(
  diff: GraphDiff,
  base: CartographerGraph,
  head: CartographerGraph,
): string
{
  const sections = [
    '### Architecture check',
    '',
    driftLine(diff),
    '',
    gateLine(diff),
    '',
    metricsDeltaTable(base, head),
    '',
    ...violationsSection(diff, head),
    ...apiChangesSection(diff),
    ...changeList('Added files', diff.addedNodes),
    ...changeList('Removed files', diff.removedNodes),
    ...movedSection(diff),
    ...edgeChangeList('Added imports', diff.addedEdges),
    ...edgeChangeList('Removed imports', diff.removedEdges),
  ]
  const detailed = `${sections.join('\n').trimEnd()}\n`
  return Buffer.byteLength(detailed, 'utf-8') <= PR_SUMMARY_MAX_BYTES
    ? detailed
    : countOnlySummary(diff, base, head)
}

// a fixed-shape fallback keeps the posted body safe even when evidence names
// themselves are enormous; full detail remains available outside the comment
function countOnlySummary(
  diff: GraphDiff,
  base: CartographerGraph,
  head: CartographerGraph,
): string
{
  const api = summarizeApiChanges(diff.apiChanges)
  const rows: Array<[string, number]> = [
    ['Added files', diff.addedNodes.length],
    ['Removed files', diff.removedNodes.length],
    ['Moved files', diff.movedNodes.length],
    ['Added imports', diff.addedEdges.length],
    ['Removed imports', diff.removedEdges.length],
    ['Moved imports', diff.movedEdges],
    ['New rule violations', diff.newViolations.length],
    ['Resolved rule violations', diff.resolvedViolations.length],
    ['Public API files', api.apiFiles],
    ['Added exports', api.addedExports],
    ['Removed exports', api.removedExports],
    ['Broken importers', api.consumers],
  ]
  const lines = [
    '### Architecture check',
    '',
    diff.changed ? '**Architecture drift detected.**' : '**No architectural drift.**',
    '',
    gateLine(diff),
    '',
    metricsDeltaTable(base, head),
    '',
    '| Change | Count |',
    '| --- | ---: |',
    ...rows.map(([label, count]) => `| ${label} | ${count} |`),
    '',
    '_Detailed evidence exceeded the safe PR-comment size. Run `cartographer diff` or inspect the uploaded `pr-diff.json` artifact for the complete result._',
  ]
  return `${lines.join('\n').trimEnd()}\n`
}

function gateLine(diff: GraphDiff): string
{
  const violations = diff.newViolations
  const errors = violations.filter((violation) => violation.severity === 'error').length
  if (errors > 0)
  {
    return `**Gate failed:** ${errors} newly introduced error-severity rule violation(s).`
  }
  if (violations.length > 0)
  {
    return `**Gate passes:** ${violations.length} new rule violation(s), but none have error severity.`
  }
  if (diff.changed)
  {
    return '**Informational:** structure changed with no new rule violations; the gate passes.'
  }
  return '**Gate passes:** no new error-severity rule violations.'
}

function violationsSection(diff: GraphDiff, head: CartographerGraph): string[]
{
  const violations = diff.newViolations
  const resolved = diff.resolvedViolations.length
  if (violations.length === 0 && resolved === 0)
  {
    return []
  }
  const lines: string[] = []
  if (violations.length > 0)
  {
    const whyByRule = new Map((head.rules ?? []).map((rule) => [rule.id, rule.why]))
    lines.push(
      `<details open><summary>New rule violations (${violations.length})</summary>`,
      '',
      ...violations.slice(0, LIST_CAP).map((violation) => formatViolation(violation, whyByRule)),
    )
    if (violations.length > LIST_CAP)
    {
      lines.push(`- …plus ${violations.length - LIST_CAP} more`)
    }
    lines.push('', '</details>', '')
  }
  lines.push(`Resolved rule violations: **${resolved}**.`, '')
  return lines
}

function formatViolation(
  violation: ViolationDelta,
  whyByRule: ReadonlyMap<string, string | undefined>,
): string
{
  const why = whyByRule.get(violation.rule)
  return `- **${violation.severity}** \`${violation.rule}\`: \`${violation.from}\` -> \`${violation.to}\`${why ? ` — ${why}` : ''}`
}

function driftLine(diff: GraphDiff): string
{
  const refs =
    diff.baseGitRef || diff.headGitRef
      ? ` (\`${diff.baseGitRef ?? '?'}\` -> \`${diff.headGitRef ?? '?'}\`)`
      : ''
  if (!diff.changed)
  {
    return `**No architectural drift.**${refs}`
  }
  const parts: string[] = []
  if (diff.addedNodes.length > 0)
  {
    parts.push(`+${diff.addedNodes.length} file(s)`)
  }
  if (diff.removedNodes.length > 0)
  {
    parts.push(`-${diff.removedNodes.length} file(s)`)
  }
  if (diff.movedNodes.length > 0)
  {
    parts.push(`${diff.movedNodes.length} moved file(s)`)
  }
  if (diff.addedEdges.length > 0)
  {
    parts.push(`+${diff.addedEdges.length} import(s)`)
  }
  if (diff.removedEdges.length > 0)
  {
    parts.push(`-${diff.removedEdges.length} import(s)`)
  }
  if (diff.movedEdges > 0)
  {
    parts.push(`${diff.movedEdges} moved import(s)`)
  }
  const apiSummary = summarizeApiChanges(diff.apiChanges)
  const apiTotal = apiSummary.addedExports + apiSummary.removedExports
  if (apiTotal > 0)
  {
    parts.push(`${apiTotal} exported-symbol change(s)`)
  }
  if (diff.newViolations.length > 0)
  {
    parts.push(`${diff.newViolations.length} new rule violation(s)`)
  }
  if (diff.resolvedViolations.length > 0)
  {
    parts.push(`${diff.resolvedViolations.length} resolved rule violation(s)`)
  }
  return `**Drift:** ${parts.join(', ')}${refs}`
}

// public-API drift w/ the current consumers each removed export breaks
function apiChangesSection(diff: GraphDiff): string[]
{
  if (diff.apiChanges.length === 0)
  {
    return []
  }
  const evidence = boundApiChanges(diff.apiChanges, {
    files: LIST_CAP,
    exportsPerFile: API_EXPORT_CAP,
    consumersPerExport: CONSUMER_CAP,
  })
  const lines = [
    `<details open><summary>Public API changes (${diff.apiChanges.length} file(s))</summary>`,
    '',
  ]
  for (const change of evidence.files)
  {
    lines.push(`**\`${change.file}\`**`)
    for (const removed of change.removedExports)
    {
      lines.push(`- removed ${exportLabel(removed.item)}${consumerNote(removed)}`)
    }
    for (const added of change.addedExports)
    {
      lines.push(`- added ${exportLabel(added.item)}`)
    }
    const omitted: string[] = []
    if (change.omittedExports > 0)
    {
      omitted.push(`${change.omittedExports} export change(s)`)
    }
    if (change.omittedConsumers > 0)
    {
      omitted.push(`${change.omittedConsumers} importer name(s)`)
    }
    if (omitted.length > 0)
    {
      lines.push(`- …omitted for this file: ${omitted.join(', ')}`)
    }
    lines.push('')
  }
  if (evidence.omitted.files > 0)
  {
    lines.push(`…plus ${evidence.omitted.files} more file(s)`, '')
  }
  if (evidence.omitted.total > 0)
  {
    lines.push(
      `…omitted overall: ${evidence.omitted.files} API-change file(s), ${evidence.omitted.exports} export change(s), ${evidence.omitted.consumers} importer name(s)`,
      '',
    )
  }
  lines.push('</details>', '')
  return lines
}

function exportLabel(change: ExportChange): string
{
  return `\`${change.name}\`${change.typeOnly ? ' (type)' : ''}`
}

function consumerNote(change: BoundedExportEvidence): string
{
  const consumers = change.item.brokenConsumers ?? []
  if (change.totalConsumers === 0)
  {
    return ' — no broken importers in the head graph'
  }
  const shown = consumers.map((consumer) => `\`${consumer}\``)
  const more = change.omittedConsumers > 0 ? ` +${change.omittedConsumers} more` : ''
  return ` — **currently breaks ${change.totalConsumers} importer(s):** ${shown.join(', ')}${more}`
}

function metricsDeltaTable(base: CartographerGraph, head: CartographerGraph): string
{
  const rows: Array<[string, number, number]> = [
    ['Files', base.nodes.length, head.nodes.length],
    ['Imports', base.edges.length, head.edges.length],
    ['Cycles', base.metrics.cycles, head.metrics.cycles],
    ['Orphans', base.metrics.orphans, head.metrics.orphans],
    ['Max fan-in', base.metrics.maxFanIn, head.metrics.maxFanIn],
    ['Max fan-out', base.metrics.maxFanOut, head.metrics.maxFanOut],
  ]
  const delta = (from: number, to: number): string =>
    to === from ? '—' : to > from ? `+${to - from}` : `${to - from}`
  return [
    '| Metric | Base | Head | Δ |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(([label, from, to]) => `| ${label} | ${from} | ${to} | ${delta(from, to)} |`),
  ].join('\n')
}

// moved pairs + dir-level flows; import churn that followed moves is a count
function movedSection(diff: GraphDiff): string[]
{
  if (diff.movedNodes.length === 0)
  {
    return []
  }
  const shownPairs = diff.movedNodes.slice(0, LIST_CAP)
  const lines = [
    `<details><summary>Moved files (${diff.movedNodes.length})</summary>`,
    '',
    ...shownPairs.map((m) => `- \`${m.from}\` -> \`${m.to}\``),
  ]
  if (diff.movedNodes.length > LIST_CAP)
  {
    lines.push(`- …plus ${diff.movedNodes.length - LIST_CAP} more`)
  }
  lines.push('', '</details>', '')
  if (diff.moveFlows.length > 0)
  {
    const shownFlows = diff.moveFlows.slice(0, LIST_CAP)
    lines.push(
      `<details><summary>Move flows (${diff.moveFlows.length})</summary>`,
      '',
      ...shownFlows.map((f) => `- \`${f.from}\` -> \`${f.to}\` (${f.count} file(s))`),
    )
    if (diff.moveFlows.length > LIST_CAP)
    {
      lines.push(`- …plus ${diff.moveFlows.length - LIST_CAP} more`)
    }
    lines.push('', '</details>', '')
  }
  return lines
}

function changeList(title: string, items: string[]): string[]
{
  return formattedChangeList(title, items, (item) => item)
}

function formattedChangeList<T>(title: string, items: T[], format: (item: T) => string): string[]
{
  if (items.length === 0)
  {
    return []
  }
  const shown = items.slice(0, LIST_CAP)
  const lines = [
    `<details><summary>${title} (${items.length})</summary>`,
    '',
    ...shown.map((item) => `- \`${format(item)}\``),
  ]
  if (items.length > LIST_CAP)
  {
    lines.push(`- …plus ${items.length - LIST_CAP} more`)
  }
  lines.push('', '</details>', '')
  return lines
}

function edgeChangeList(title: string, items: EdgeEndpoints[]): string[]
{
  return formattedChangeList(title, items, formatEdgeEndpoints)
}
