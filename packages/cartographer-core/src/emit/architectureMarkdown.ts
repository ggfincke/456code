// packages/cartographer-core/src/emit/architectureMarkdown.ts
// render a cartographergraph as a markdown architecture report

import { aggregateGroupEdges, fileDegrees, graphGroups } from '../analyze/index.js'
import { JOURNEY_HOP_MAX_DEPTH } from '../analyze/journeyHops.js'
import type {
  CartographerGraph,
  GraphGroup,
  GraphJourney,
  GraphJourneyStop,
  GraphSystem,
} from '../contracts/types.js'

// keep Mermaid readable -> truncate past this many edges
const MERMAID_EDGE_CAP = 150
// block diagram budget: biggest blocks + heaviest edges survive (F26)
const MERMAID_BLOCK_NODE_CAP = 60
const MERMAID_BLOCK_EDGE_CAP = 150
const HOTSPOT_COUNT = 5

export function emitArchitectureMarkdown(graph: CartographerGraph): string
{
  const groups = graphGroups(graph)
  return [
    frontmatter(graph),
    '',
    '# Architecture',
    '',
    summaryLine(graph),
    '',
    '## Metrics',
    '',
    metricsTable(graph),
    '',
    ...systemsSection(graph.systems ?? []),
    ...journeysSection(graph.journeys ?? []),
    ...blocksSection(graph, groups),
    '## Hotspots',
    '',
    hotspotTables(graph),
    '## Import graph',
    '',
    mermaidBlock(graph, groups),
    '',
  ].join('\n')
}

// repo-controlled values are untrusted -> context-escape before every sink
// escape YAML, Markdown, code span & Mermaid contexts per F01

// JSON string literals are valid YAML double-quoted scalars
function yamlText(value: string): string
{
  return JSON.stringify(value)
}

// neutralize raw HTML, table pipes, code spans & brace expressions
function mdText(text: string): string
{
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll(/[\r\n]+/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
}

// text placed inside a `code span` in a table cell
function codeText(text: string): string
{
  return text
    .replaceAll(/[\r\n]+/g, ' ')
    .replaceAll('`', "'")
    .replaceAll('|', '\\|')
}

function frontmatter(graph: CartographerGraph): string
{
  const lines = [
    '---',
    'title: Architecture',
    'generatedBy: cartographer',
    `generatedAt: ${yamlText(graph.generatedAt)}`,
    `repoRoot: ${yamlText(graph.repoRoot)}`,
    ...(graph.gitRef ? [`gitRef: ${yamlText(graph.gitRef)}`] : []),
    `mode: ${graph.mode}`,
    `scope: ${yamlText(graph.scope)}`,
    `nodes: ${graph.nodes.length}`,
    `edges: ${graph.edges.length}`,
    `cycles: ${graph.metrics.cycles}`,
    'artifacts:',
    '  graphJson: ./graph.json',
    '---',
  ]
  return lines.join('\n')
}

function summaryLine(graph: CartographerGraph): string
{
  const ref = graph.gitRef ? ` at \`${codeText(graph.gitRef)}\`` : ''
  return (
    `Imports graph of \`${codeText(graph.scope)}\`${ref} — ` +
    `${graph.nodes.length} files, ${graph.edges.length} imports, ` +
    `${graph.metrics.cycles} cycle${graph.metrics.cycles === 1 ? '' : 's'}.`
  )
}

function metricsTable(graph: CartographerGraph): string
{
  const m = graph.metrics
  return [
    '| Metric | Value |',
    '| --- | ---: |',
    `| Files | ${graph.nodes.length} |`,
    `| Imports | ${graph.edges.length} |`,
    `| Cycles | ${m.cycles} |`,
    `| Orphans | ${m.orphans} |`,
    `| Max fan-in | ${m.maxFanIn} |`,
    `| Max fan-out | ${m.maxFanOut} |`,
  ].join('\n')
}

// block-level rollup -> table + aggregated mermaid, skipped for single-group graphs
function blocksSection(graph: CartographerGraph, groups: GraphGroup[]): string[]
{
  if (groups.length < 2)
  {
    return []
  }
  const groupEdges = aggregateGroupEdges(graph)
  const shortId = new Map(groups.map((g, index) => [g.id, `g${index}`]))

  const table = [
    '| Block | Files | Description |',
    '| --- | ---: | --- |',
    ...groups.map(
      (g) => `| ${mdText(g.label)} | ${g.fileCount} | ${mdText(g.description ?? '')} |`,
    ),
  ]

  // budget the diagram: biggest blocks first, then the heaviest edges whose
  // endpoints survived; exact omitted totals point back at graph.json
  const shownGroups = [...groups]
    .sort((a, b) => b.fileCount - a.fileCount || a.id.localeCompare(b.id))
    .slice(0, MERMAID_BLOCK_NODE_CAP)
  const shownGroupIds = new Set(shownGroups.map((g) => g.id))
  const shownEdges = groupEdges
    .filter((e) => shownGroupIds.has(e.from) && shownGroupIds.has(e.to))
    .slice(0, MERMAID_BLOCK_EDGE_CAP)

  const diagram = ['```mermaid', 'flowchart LR']
  for (const group of shownGroups)
  {
    diagram.push(`  ${shortId.get(group.id)}["${mermaidLabel(group.label)} (${group.fileCount})"]`)
  }
  for (const edge of shownEdges)
  {
    diagram.push(`  ${shortId.get(edge.from)} -->|${edge.count}| ${shortId.get(edge.to)}`)
  }
  diagram.push('```')
  const omittedGroups = groups.length - shownGroups.length
  const omittedEdges = groupEdges.length - shownEdges.length
  if (omittedGroups > 0 || omittedEdges > 0)
  {
    diagram.push(
      '',
      `_Showing ${shownGroups.length} of ${groups.length} blocks and ` +
        `${shownEdges.length} of ${groupEdges.length} block imports — see ` +
        '`graph.json` for the full rollup._',
    )
  }

  return ['## Blocks', '', ...table, '', ...diagram, '', '']
}

function systemRank(system: GraphSystem): number | undefined
{
  return system.rank !== undefined && Number.isInteger(system.rank) ? system.rank : undefined
}

function systemsSection(systems: GraphSystem[]): string[]
{
  if (systems.length === 0)
  {
    return []
  }
  const hasRanks = systems.some((system) => systemRank(system) !== undefined)
  const table = hasRanks
    ? [
        '| System | Rank | Files | Description |',
        '| --- | ---: | ---: | --- |',
        ...systems.map(
          (system) =>
            `| ${mdText(system.label)} | ${systemRank(system) ?? '—'} | ${system.fileCount} | ${mdText(system.description ?? '')} |`,
        ),
      ]
    : [
        '| System | Files | Description |',
        '| --- | ---: | --- |',
        ...systems.map(
          (system) =>
            `| ${mdText(system.label)} | ${system.fileCount} | ${mdText(system.description ?? '')} |`,
        ),
      ]
  return ['## Systems', '', ...table, '', '']
}

// how many intermediate files a hop names before it stops being readable
const HOP_VIA_CAP = 3

// one stop's verification verdict: what its glob resolved to this build
function stopResolution(stop: GraphJourneyStop): string
{
  if (stop.stale || !stop.resolved || stop.resolved.length === 0)
  {
    return '**STALE**'
  }
  const count = stop.resolvedTotal ?? stop.resolved.length
  return `${count} file${count === 1 ? '' : 's'}`
}

// hop from the previous stop; first stop & unverifiable hops say so
function stopHop(stop: GraphJourneyStop, index: number): string
{
  if (index === 0)
  {
    return '—'
  }
  if (stop.hopDepthExceeded)
  {
    return `search exceeded ${JOURNEY_HOP_MAX_DEPTH}-hop limit`
  }
  if (stop.hopDistance === undefined)
  {
    return 'no static path'
  }
  if (stop.hopDistance === 0)
  {
    return 'same file'
  }
  const intermediates = (stop.hopVia ?? []).slice(1, -1).slice(0, HOP_VIA_CAP)
  const via =
    intermediates.length > 0
      ? ` via ${intermediates.map((id) => `\`${codeText(id)}\``).join(', ')}`
      : ''
  return `${stop.hopDistance} hop${stop.hopDistance === 1 ? '' : 's'}${via}`
}

// authored lifecycle narrative + the build-time verification of each hop
function journeysSection(journeys: GraphJourney[]): string[]
{
  if (journeys.length === 0)
  {
    return []
  }
  const lines = ['## Journeys', '']
  for (const [journeyIndex, journey] of journeys.entries())
  {
    lines.push(`### ${mdText(journey.title)} (\`${codeText(journey.id)}\`)`, '')
    if (journey.why)
    {
      lines.push(mdText(journey.why), '')
    }
    const hasWhy = journey.stops.some((stop) => stop.why !== undefined)
    lines.push(
      hasWhy
        ? '| # | Stop | Timing | Target | Resolves | Hop from previous | Why |'
        : '| # | Stop | Timing | Target | Resolves | Hop from previous |',
      hasWhy
        ? '| ---: | --- | --- | --- | --- | --- | --- |'
        : '| ---: | --- | --- | --- | --- | --- |',
    )
    for (const [index, stop] of journey.stops.entries())
    {
      const cells = [
        String(index + 1),
        mdText(stop.title),
        stop.timing,
        `\`${codeText(stop.at)}\``,
        stopResolution(stop),
        stopHop(stop, index),
        ...(hasWhy ? [mdText(stop.why ?? '')] : []),
      ]
      lines.push(`| ${cells.join(' | ')} |`)
    }
    lines.push('')

    const diagram = [
      '```mermaid',
      'flowchart LR',
      '  classDef immediate fill:#dbeafe,stroke:#2563eb,color:#1e3a5f',
      '  classDef transaction fill:#fef3c7,stroke:#d97706,color:#78350f',
      '  classDef deferred fill:#ede9fe,stroke:#7c3aed,color:#3b0764',
    ]
    const nodeId = (index: number): string => `j${journeyIndex}s${index}`
    for (const [index, stop] of journey.stops.entries())
    {
      const stale = stop.stale ? ' — stale' : ''
      diagram.push(
        `  ${nodeId(index)}["${index + 1}. ${mermaidLabel(stop.title)}${stale}"]:::${stop.timing}`,
      )
    }
    for (const [index, stop] of journey.stops.entries())
    {
      if (index === 0)
      {
        continue
      }
      // a hop w/o a static import path is the runtime/HTTP/worker boundary
      diagram.push(
        stop.hopDepthExceeded
          ? `  ${nodeId(index - 1)} -.->|search depth exceeded| ${nodeId(index)}`
          : stop.hopDistance === undefined
            ? `  ${nodeId(index - 1)} -.->|no static import| ${nodeId(index)}`
            : `  ${nodeId(index - 1)} -->|${stop.hopDistance} hop${stop.hopDistance === 1 ? '' : 's'}| ${nodeId(index)}`,
      )
    }
    diagram.push('```', '')
    lines.push(...diagram)
  }
  return [...lines, '']
}

// quoted-string context: quotes end the label, angle brackets can reach
// HTML-interpreting renderers -> map both to inert lookalikes
function mermaidLabel(text: string): string
{
  return text
    .replaceAll(/[\r\n]+/g, ' ')
    .replaceAll('"', "'")
    .replaceAll('<', '‹')
    .replaceAll('>', '›')
}

function hotspotTables(graph: CartographerGraph): string
{
  const { fanIn, fanOut } = fileDegrees(graph.edges)

  const top = (map: Map<string, number>): Array<[string, number]> =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, HOTSPOT_COUNT)

  const table = (title: string, header: string, rows: Array<[string, number]>): string[] =>
    rows.length === 0
      ? []
      : [
          `### ${title}`,
          '',
          `| File | ${header} |`,
          '| --- | ---: |',
          ...rows.map(([id, count]) => `| \`${codeText(id)}\` | ${count} |`),
          '',
        ]

  return [
    ...table('Most imported (fan-in)', 'Dependents', top(fanIn)),
    ...table('Most imports (fan-out)', 'Dependencies', top(fanOut)),
  ].join('\n')
}

function mermaidBlock(graph: CartographerGraph, groups: GraphGroup[]): string
{
  if (graph.edges.length === 0)
  {
    return '_No internal imports found._'
  }

  const shown = graph.edges.slice(0, MERMAID_EDGE_CAP)
  const shownIds = new Set(shown.flatMap((edge) => [edge.from, edge.to]))
  const ids = new Map<string, string>()
  const shortId = (id: string): string =>
  {
    let short = ids.get(id)
    if (!short)
    {
      short = `n${ids.size}`
      ids.set(id, short)
    }
    return short
  }

  const groupOf = new Map(graph.nodes.map((n) => [n.id, n.group]))
  const lines = ['```mermaid', 'flowchart TD']

  // declare shown nodes inside a subgraph per block
  for (const [index, group] of groups.entries())
  {
    const members = [...shownIds].filter((id) => groupOf.get(id) === group.id)
    if (members.length === 0)
    {
      continue
    }
    lines.push(`  subgraph sg${index}["${mermaidLabel(group.label)}"]`)
    for (const id of members)
    {
      lines.push(`    ${shortId(id)}["${mermaidLabel(id)}"]`)
    }
    lines.push('  end')
  }
  // nodes outside any known group (stale graph.json) -> declare flat
  for (const id of shownIds)
  {
    if (!ids.has(id))
    {
      lines.push(`  ${shortId(id)}["${mermaidLabel(id)}"]`)
    }
  }

  for (const edge of shown)
  {
    lines.push(`  ${shortId(edge.from)} --> ${shortId(edge.to)}`)
  }
  lines.push('```')

  if (graph.edges.length > MERMAID_EDGE_CAP)
  {
    lines.push(
      '',
      `_Showing ${MERMAID_EDGE_CAP} of ${graph.edges.length} imports — see \`graph.json\` for the full graph._`,
    )
  }
  return lines.join('\n')
}
