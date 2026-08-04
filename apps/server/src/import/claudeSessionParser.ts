// apps/server/src/import/claudeSessionParser.ts
// parses claude code jsonl into inert imported records
// @effect-diagnostics globalDate:off

import type {
  ImportedActivityRecord,
  ImportedRecord,
  ImportedSession,
  ImportedSessionMeta,
  ParseInput,
} from './types.ts'
import { deterministicId } from './ids.ts'
import { claudeExplicitTitle, claudeSemanticTitle } from './importTitle.ts'
import {
  addWarning,
  appendParsingWarningActivity,
  applyStrictlyIncreasingTimestamps,
  incrementJsonlRecordCount,
  iterateJsonlPhysicalLines,
  materializeWarnings,
  truncateUtf8,
  type WarningState,
} from './parserSupport.ts'
import { IMPORT_NORMALIZED_SESSION_MAX_RECORDS } from './resourceLimits.ts'

interface ParsedClaudeLine
{
  readonly parentUuid: string | null
  readonly sessionId: string | null
  readonly sourceIndex: number
  readonly type: string | null
  readonly uuid: string | null
  readonly value: Record<string, unknown>
}

const skippedTypes = new Set([
  'system',
  'queue-operation',
  'last-prompt',
  'pr-link',
  'progress',
  'file-history-snapshot',
  'summary',
])
const knownTypes = new Set(['user', 'assistant', 'ai-title', 'custom-title'])
const omittedContentBlockTypes = new Set(['attachment', 'document', 'image'])
const fileAttachmentTypes = new Set([
  'compact_file_reference',
  'directory',
  'edited_text_file',
  'file',
  'nested_memory',
  'opened_file_in_ide',
  'plan_file_reference',
])
const administrativeAttachmentTypes = new Set([
  'agent_listing_delta',
  'command_permissions',
  'date_change',
  'deferred_tools_delta',
  'hook_additional_context',
  'mcp_instructions_delta',
  'skill_listing',
  'task_reminder',
  'ultrathink_effort',
])
const summaryLimit = 120
const maxPhysicalLines = 100_000
const maxJsonlRecords = 100_000
const maxFieldBytes = 1_048_576
const maxCwdCharacters = 4_096
const maxMetadataCharacters = 512
const maxToolCallIdBytes = 512
const maxToolNameBytes = 256
const maxCollectionItems = 25_000
const maxNestedCollectionDepth = 8
const maxNestedCollectionNodes = 25_000
const omittedAttachmentDetail = 'Attachment payloads are not included in imported transcripts.'
const uuidFileNamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const safeNativeSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u

class NormalizedRecordLimitError extends Error
{
  constructor()
  {
    super(
      `session import normalized record limit exceeded: maximum is ${IMPORT_NORMALIZED_SESSION_MAX_RECORDS}`,
    )
    this.name = 'NormalizedRecordLimitError'
  }
}

function pushImportedRecord(records: ImportedRecord[], record: ImportedRecord): void
{
  if (records.length >= IMPORT_NORMALIZED_SESSION_MAX_RECORDS)
  {
    throw new NormalizedRecordLimitError()
  }
  records.push(record)
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null
{
  return typeof value === 'string' && value.length > 0 ? value : null
}

function truncate(value: string, limit: number): string
{
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function summarize(value: string): string
{
  const firstLine = value.trim().split(/\r?\n/, 1)[0] ?? ''
  return truncate(firstLine, summaryLimit)
}

function boundTextField(value: string, fieldDescription: string, warnings: WarningState): string
{
  const bounded = truncateUtf8(value, maxFieldBytes)
  if (bounded === value)
  {
    return value
  }
  addWarning(warnings, `${fieldDescription} exceeded 1 MiB and was truncated`)
  return bounded
}

function boundMetadataField(
  value: string | null,
  fieldDescription: string,
  warnings: WarningState,
): string | null
{
  if (value === null || value.length <= maxMetadataCharacters)
  {
    return value
  }
  addWarning(
    warnings,
    `${fieldDescription} exceeded ${maxMetadataCharacters} characters and was truncated`,
  )
  return truncate(value, maxMetadataCharacters)
}

function safeCwd(value: string | null, sourceIndex: number, warnings: WarningState): string | null
{
  if (value === null || value.length <= maxCwdCharacters)
  {
    return value
  }
  addWarning(
    warnings,
    `line ${sourceIndex + 1}: cwd exceeded ${maxCwdCharacters} characters and was omitted`,
  )
  return null
}

function safeNativeSessionId(value: string | null, warnings: WarningState): string | null
{
  if (
    value === null ||
    value.length > maxMetadataCharacters ||
    !safeNativeSessionIdPattern.test(value)
  )
  {
    if (value !== null)
    {
      addWarning(warnings, 'Claude native session id was invalid or oversized and was omitted')
    }
    return null
  }
  return value
}

function boundToolName(value: string, sourceIndex: number, warnings: WarningState): string
{
  const bounded = truncateUtf8(value, maxToolNameBytes)
  if (bounded === value)
  {
    return value
  }
  addWarning(warnings, `line ${sourceIndex + 1}: tool name exceeded 256 bytes and was truncated`)
  return bounded
}

function boundStableToolCallId(value: string, sourceIndex: number, warnings: WarningState): string
{
  if (truncateUtf8(value, maxToolCallIdBytes) === value)
  {
    return value
  }
  addWarning(
    warnings,
    `line ${sourceIndex + 1}: tool call id exceeded 512 bytes and was replaced with a stable id`,
  )
  return deterministicId(value, 'claude-import-tool-call')
}

function normalizeTimestamp(value: unknown): string | null
{
  if (typeof value !== 'string' && typeof value !== 'number')
  {
    return null
  }

  try
  {
    return new Date(value).toISOString()
  }
  catch
  {
    return null
  }
}

function stringifyValue(value: unknown): string
{
  if (typeof value === 'string')
  {
    return value
  }
  if (value === undefined)
  {
    return ''
  }
  try
  {
    return JSON.stringify(value) ?? String(value)
  }
  catch
  {
    return String(value)
  }
}

function normalizeToolInput(
  value: unknown,
  sourceIndex: number,
  warnings: WarningState,
): { command: string | null; value: unknown }
{
  const serialized = stringifyValue(value)
  const bounded = boundTextField(serialized, `line ${sourceIndex + 1}: tool input`, warnings)
  const structuredValue = bounded === serialized ? value : bounded
  const inputRecord = isRecord(structuredValue) ? structuredValue : null
  const commandValue = inputRecord?.command
  const command =
    typeof commandValue === 'string'
      ? commandValue.trim()
      : Array.isArray(commandValue)
        ? commandValue
            .filter((part): part is string => typeof part === 'string')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .join(' ')
        : null
  return {
    command:
      command !== null && command.length > 0
        ? boundTextField(command, `line ${sourceIndex + 1}: tool command`, warnings)
        : null,
    value: structuredValue,
  }
}

function toolKind(itemType: string): string
{
  if (itemType === 'command_execution')
  {
    return 'execute'
  }
  if (itemType === 'file_change')
  {
    return 'edit'
  }
  if (itemType === 'web_search')
  {
    return 'search'
  }
  return 'tool'
}

function mapToolName(name: string): string
{
  if (name === 'Bash')
  {
    return 'command_execution'
  }
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit')
  {
    return 'file_change'
  }
  if (name === 'WebSearch' || name === 'WebFetch')
  {
    return 'web_search'
  }
  return name.startsWith('mcp__') ? 'mcp_tool_call' : 'dynamic_tool_call'
}

function toolInputHint(input: unknown): string
{
  if (typeof input === 'string')
  {
    return input.trim()
  }
  if (!isRecord(input))
  {
    return ''
  }

  for (const key of ['command', 'file_path', 'path', 'query', 'url'])
  {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0)
    {
      return value.trim()
    }
  }

  return Object.keys(input).slice(0, 2).join(', ')
}

function toolResultId(block: Record<string, unknown>): string | null
{
  return asString(block.tool_use_id) ?? asString(block.id)
}

function countOmittedContentAttachments(
  value: unknown,
  sourceIndex: number,
  warnings: WarningState,
): number
{
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [{ depth: 0, value }]
  let count = 0
  let inspectedNodes = 1
  let truncated = false
  while (pending.length > 0 && inspectedNodes < maxNestedCollectionNodes)
  {
    const current = pending.pop()!
    if (current.depth > maxNestedCollectionDepth)
    {
      truncated = true
      continue
    }
    if (!Array.isArray(current.value))
    {
      continue
    }
    if (current.value.length > maxCollectionItems)
    {
      truncated = true
    }
    const limit = Math.min(current.value.length, maxCollectionItems)
    for (let index = 0; index < limit; index += 1)
    {
      if (inspectedNodes >= maxNestedCollectionNodes)
      {
        truncated = true
        break
      }
      inspectedNodes += 1
      const blockValue = current.value[index]
      if (!isRecord(blockValue))
      {
        continue
      }
      const blockType = asString(blockValue.type)
      if (blockType !== null && omittedContentBlockTypes.has(blockType))
      {
        count += 1
        continue
      }
      if (blockType === 'tool_result')
      {
        pending.push({ depth: current.depth + 1, value: blockValue.content })
      }
    }
  }
  if (pending.length > 0)
  {
    truncated = true
  }
  if (truncated)
  {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: nested attachment inspection was capped at ${maxNestedCollectionNodes} values and depth ${maxNestedCollectionDepth}`,
    )
  }
  return count
}

function withoutOmittedContentAttachments(
  value: unknown,
  sourceIndex: number,
  warnings: WarningState,
): unknown
{
  if (!Array.isArray(value))
  {
    return value
  }

  if (value.length > maxCollectionItems)
  {
    addWarning(
      warnings,
      `line ${sourceIndex + 1}: tool result content was capped at ${maxCollectionItems} of ${value.length} blocks`,
    )
  }
  return value
    .slice(0, maxCollectionItems)
    .filter(
      (blockValue) =>
        !isRecord(blockValue) ||
        typeof blockValue.type !== 'string' ||
        !omittedContentBlockTypes.has(blockValue.type),
    )
}

function toolResultContent(
  block: Record<string, unknown>,
  sourceIndex: number,
  warnings: WarningState,
): string
{
  const content = withoutOmittedContentAttachments(block.content, sourceIndex, warnings)
  if (
    Array.isArray(content) &&
    content.every(
      (contentBlock) =>
        isRecord(contentBlock) &&
        contentBlock.type === 'text' &&
        typeof contentBlock.text === 'string',
    )
  )
  {
    return boundTextField(
      content.map((contentBlock) => (contentBlock as Record<string, unknown>).text).join('\n'),
      `line ${sourceIndex + 1}: tool output`,
      warnings,
    )
  }
  return boundTextField(stringifyValue(content), `line ${sourceIndex + 1}: tool output`, warnings)
}

function toolFileChanges(
  input: unknown,
  sourceIndex: number,
  warnings: WarningState,
): Array<{ path: string }>
{
  if (!isRecord(input))
  {
    return []
  }

  const candidates = [
    input.file_path,
    input.path,
    input.filePath,
    input.relativePath,
    input.filename,
    input.newPath,
    input.oldPath,
  ]
  const changes: Array<{ path: string }> = []
  const seen = new Set<string>()
  for (const candidate of candidates)
  {
    if (typeof candidate !== 'string' || candidate.trim().length === 0)
    {
      continue
    }
    const path = boundTextField(
      candidate.trim(),
      `line ${sourceIndex + 1}: changed file path`,
      warnings,
    )
    if (!seen.has(path))
    {
      changes.push({ path })
      seen.add(path)
    }
  }
  return changes
}

function completeToolActivity(
  activity: ImportedActivityRecord,
  output: string,
  failed: boolean,
): void
{
  activity.tone = failed ? 'error' : 'tool'
  activity.payload.status = failed ? 'failed' : 'completed'
  activity.payload.detail = output
  const data = isRecord(activity.payload.data) ? activity.payload.data : {}
  const item = isRecord(data.item) ? data.item : {}
  item.result = { content: output }
  data.item = item
  data.rawOutput = { content: output }
  activity.payload.data = data
}

function appendOmittedAttachmentActivity(
  records: ImportedRecord[],
  omittedAttachmentCount: number,
  createdAt: string | null,
  sourceIndex: number,
): void
{
  const fallbackCreatedAt = records.at(-1)?.createdAt
  const activityCreatedAt = createdAt ?? fallbackCreatedAt
  if (omittedAttachmentCount === 0 || activityCreatedAt === undefined)
  {
    return
  }

  const noun = omittedAttachmentCount === 1 ? 'attachment' : 'attachments'
  const summary = `Omitted ${omittedAttachmentCount} ${noun} from imported transcript`
  pushImportedRecord(records, {
    kind: 'activity',
    tone: 'info',
    activityKind: 'task.completed',
    summary,
    payload: {
      omittedAttachmentCount,
      summary,
      detail: omittedAttachmentDetail,
    },
    createdAt: activityCreatedAt,
    sourceIndex,
  })
}

function emptyMeta(input: ParseInput): ImportedSessionMeta
{
  return {
    source: 'claude-code',
    sourcePath: input.sourcePath,
    contentHash: input.contentHash,
    nativeSessionId: null,
    cwd: null,
    gitBranch: null,
    model: null,
    title: null,
    firstActivityAt: null,
    lastActivityAt: null,
  }
}

function finalize(
  meta: ImportedSessionMeta,
  records: ImportedRecord[],
  warnings: WarningState,
  hasMetadata: boolean,
): ImportedSession
{
  const messageCount = records.filter((record) => record.kind === 'message').length
  if (!hasMetadata)
  {
    addWarning(warnings, 'no session metadata found; session was not imported')
  }
  if (messageCount === 0)
  {
    addWarning(warnings, 'no messages found; session was not imported')
  }
  if (!hasMetadata || messageCount === 0)
  {
    return { meta, records: [], warnings: materializeWarnings(warnings) }
  }

  applyStrictlyIncreasingTimestamps(records)
  meta.firstActivityAt = records[0]?.createdAt ?? null
  meta.lastActivityAt = records.at(-1)?.createdAt ?? null
  return { meta, records, warnings: materializeWarnings(warnings) }
}

function trustedSessionIdFromPath(sourcePath: string): string | null
{
  const fileName = sourcePath.split(/[\\/]/u).at(-1)
  if (fileName?.endsWith('.jsonl') !== true)
  {
    return null
  }
  const sessionId = fileName.slice(0, -'.jsonl'.length)
  return uuidFileNamePattern.test(sessionId) ? sessionId : null
}

function selectCanonicalSessionId(
  lines: ReadonlyArray<ParsedClaudeLine>,
  sourcePath: string,
): string | null
{
  const trustedSessionId = trustedSessionIdFromPath(sourcePath)
  if (trustedSessionId !== null)
  {
    return trustedSessionId
  }

  const graphSessions = new Map<string, { count: number; lastSourceIndex: number }>()
  for (const line of lines)
  {
    if (line.uuid === null || line.sessionId === null)
    {
      continue
    }
    const current = graphSessions.get(line.sessionId)
    graphSessions.set(line.sessionId, {
      count: (current?.count ?? 0) + 1,
      lastSourceIndex: Math.max(current?.lastSourceIndex ?? -1, line.sourceIndex),
    })
  }
  const selectedGraphSession = [...graphSessions.entries()].toSorted(
    ([leftId, left], [rightId, right]) =>
      right.count - left.count ||
      right.lastSourceIndex - left.lastSourceIndex ||
      leftId.localeCompare(rightId),
  )[0]?.[0]
  if (selectedGraphSession !== undefined)
  {
    return selectedGraphSession
  }

  return lines.findLast((line) => line.sessionId !== null)?.sessionId ?? null
}

function graphContainsCycle(nodes: ReadonlyMap<string, ParsedClaudeLine>): boolean
{
  const fullyVisited = new Set<string>()
  for (const startUuid of nodes.keys())
  {
    if (fullyVisited.has(startUuid))
    {
      continue
    }
    const currentPath = new Set<string>()
    const pathOrder: string[] = []
    let currentUuid: string | null = startUuid
    while (currentUuid !== null && nodes.has(currentUuid) && !fullyVisited.has(currentUuid))
    {
      if (currentPath.has(currentUuid))
      {
        return true
      }
      currentPath.add(currentUuid)
      pathOrder.push(currentUuid)
      currentUuid = nodes.get(currentUuid)?.parentUuid ?? null
    }
    for (const uuid of pathOrder)
    {
      fullyVisited.add(uuid)
    }
  }
  return false
}

function parentChainReachesUuid(
  nodes: ReadonlyMap<string, ParsedClaudeLine>,
  parentUuid: string | null,
  targetUuid: string,
): boolean
{
  const visited = new Set<string>()
  let currentUuid = parentUuid
  while (currentUuid !== null && nodes.has(currentUuid) && !visited.has(currentUuid))
  {
    if (currentUuid === targetUuid)
    {
      return true
    }
    visited.add(currentUuid)
    currentUuid = nodes.get(currentUuid)?.parentUuid ?? null
  }
  return false
}

function graphChildren(
  nodes: ReadonlyMap<string, ParsedClaudeLine>,
): ReadonlyMap<string, ReadonlyArray<string>>
{
  const mutableChildren = new Map<string, string[]>()
  for (const [uuid, node] of nodes)
  {
    if (node.parentUuid === null || !nodes.has(node.parentUuid))
    {
      continue
    }
    const children = mutableChildren.get(node.parentUuid) ?? []
    children.push(uuid)
    mutableChildren.set(node.parentUuid, children)
  }
  return mutableChildren
}

function latestNode(
  uuids: ReadonlyArray<string>,
  nodes: ReadonlyMap<string, ParsedClaudeLine>,
): string | null
{
  return (
    [...uuids].toSorted((left, right) =>
    {
      const sourceOrder =
        (nodes.get(right)?.sourceIndex ?? -1) - (nodes.get(left)?.sourceIndex ?? -1)
      return sourceOrder !== 0 ? sourceOrder : left.localeCompare(right)
    })[0] ?? null
  )
}

function selectClaudeGraphAncestry(
  sessionLines: ReadonlyArray<ParsedClaudeLine>,
  warnings: WarningState,
): ParsedClaudeLine[] | null
{
  const nodes = new Map<string, ParsedClaudeLine>()
  const duplicateLines: ParsedClaudeLine[] = []
  for (const line of sessionLines)
  {
    if (line.uuid === null)
    {
      continue
    }
    if (nodes.has(line.uuid))
    {
      duplicateLines.push(line)
      continue
    }
    nodes.set(line.uuid, line)
  }

  let canonicalizedDuplicateCount = 0
  for (const line of duplicateLines)
  {
    const uuid = line.uuid
    if (uuid === null)
    {
      continue
    }
    const previous = nodes.get(uuid)
    if (previous === undefined)
    {
      nodes.set(uuid, line)
      continue
    }
    const previousHasParentCycle = parentChainReachesUuid(nodes, previous.parentUuid, uuid)
    nodes.set(uuid, line)
    if (!previousHasParentCycle && parentChainReachesUuid(nodes, line.parentUuid, uuid))
    {
      nodes.set(uuid, previous)
      addWarning(
        warnings,
        `line ${line.sourceIndex + 1}: ignored later duplicate Claude UUID "${truncate(uuid, summaryLimit)}" because it creates a parent-chain cycle; retained the earlier occurrence`,
      )
      continue
    }
    canonicalizedDuplicateCount += 1
  }
  if (canonicalizedDuplicateCount > 0)
  {
    const noun = canonicalizedDuplicateCount === 1 ? 'record' : 'records'
    addWarning(
      warnings,
      `canonicalized ${canonicalizedDuplicateCount} duplicate Claude UUID ${noun} to the last occurrence`,
    )
  }
  if (nodes.size === 0)
  {
    return []
  }

  const children = graphChildren(nodes)
  const anchorRecords = sessionLines
    .filter((line) => line.type === 'last-prompt')
    .map((line) => ({
      leafUuid: asString(line.value.leafUuid),
      sourceIndex: line.sourceIndex,
    }))
  const validAnchors = anchorRecords.filter(
    (anchor): anchor is { leafUuid: string; sourceIndex: number } =>
      anchor.leafUuid !== null && nodes.has(anchor.leafUuid),
  )
  const invalidAnchorCount = anchorRecords.length - validAnchors.length
  if (invalidAnchorCount > 0)
  {
    const noun = invalidAnchorCount === 1 ? 'anchor' : 'anchors'
    addWarning(warnings, `ignored ${invalidAnchorCount} invalid Claude last-prompt ${noun}`)
  }

  const anchor = validAnchors.at(-1)
  let endpointUuid: string | null = null
  if (anchor !== undefined)
  {
    const reachableAfterAnchor = new Set<string>()
    const stack = [...(children.get(anchor.leafUuid) ?? [])]
    const visited = new Set<string>()
    while (stack.length > 0)
    {
      const uuid = stack.pop()
      if (uuid === undefined || visited.has(uuid))
      {
        continue
      }
      visited.add(uuid)
      const node = nodes.get(uuid)
      if (node !== undefined && node.sourceIndex > anchor.sourceIndex)
      {
        reachableAfterAnchor.add(uuid)
      }
      stack.push(...(children.get(uuid) ?? []))
    }
    const descendantEndpoints = [...reachableAfterAnchor].filter((uuid) =>
      (children.get(uuid) ?? []).every((childUuid) => !reachableAfterAnchor.has(childUuid)),
    )
    endpointUuid =
      latestNode(descendantEndpoints, nodes) ??
      (nodes.has(anchor.leafUuid) ? anchor.leafUuid : null)
    if (descendantEndpoints.length > 1)
    {
      addWarning(
        warnings,
        `Claude last-prompt anchor has ${descendantEndpoints.length} reachable descendant endpoints; imported the latest`,
      )
    }
  }
  else
  {
    const leaves = [...nodes.keys()].filter((uuid) => (children.get(uuid) ?? []).length === 0)
    endpointUuid = latestNode(leaves, nodes)
    if (leaves.length > 1)
    {
      addWarning(
        warnings,
        `Claude session graph has ${leaves.length} leaves and no valid last-prompt anchor; imported the latest`,
      )
    }
  }

  if (endpointUuid === null)
  {
    if (graphContainsCycle(nodes))
    {
      addWarning(warnings, 'Claude session graph contains a cycle; transcript history was rejected')
      return null
    }
    addWarning(warnings, 'Claude session graph has no importable endpoint')
    return null
  }

  const reverseAncestry: ParsedClaudeLine[] = []
  const ancestryUuids = new Set<string>()
  let currentUuid: string | null = endpointUuid
  while (currentUuid !== null)
  {
    if (ancestryUuids.has(currentUuid))
    {
      addWarning(
        warnings,
        'Claude selected session graph contains a cycle; transcript history was rejected',
      )
      return null
    }
    ancestryUuids.add(currentUuid)
    const current = nodes.get(currentUuid)
    if (current === undefined)
    {
      addWarning(
        warnings,
        `Claude session history is incomplete before UUID "${truncate(currentUuid, summaryLimit)}"; imported the reachable suffix`,
      )
      break
    }
    reverseAncestry.push(current)
    currentUuid = current.parentUuid
  }
  return reverseAncestry.toReversed()
}

function applySessionWideTitle(
  meta: ImportedSessionMeta,
  sessionLines: ReadonlyArray<ParsedClaudeLine>,
  warnings: WarningState,
): boolean
{
  let customTitleSeen = false
  let titleSeen = false
  for (const line of sessionLines)
  {
    if (line.type !== 'ai-title' && line.type !== 'custom-title')
    {
      continue
    }
    const title = claudeExplicitTitle(
      asString(line.value.aiTitle) ??
        asString(line.value.customTitle) ??
        asString(line.value.title) ??
        asString(line.value.content),
    )
    if (title === null)
    {
      addWarning(warnings, `line ${line.sourceIndex + 1}: ${line.type} has no title text`)
      continue
    }
    titleSeen = true
    const boundedTitle = boundMetadataField(
      title,
      `line ${line.sourceIndex + 1}: session title`,
      warnings,
    )
    if (boundedTitle === null)
    {
      continue
    }
    if (line.type === 'custom-title')
    {
      meta.title = boundedTitle
      customTitleSeen = true
    }
    else if (!customTitleSeen)
    {
      meta.title = boundedTitle
    }
  }
  return titleSeen
}

function classifyAttachment(line: ParsedClaudeLine, unknownTypes: Map<string, number>): number
{
  const attachment = isRecord(line.value.attachment) ? line.value.attachment : null
  const subtype = asString(attachment?.type)
  if (subtype !== null && fileAttachmentTypes.has(subtype))
  {
    return 1
  }
  if (subtype !== null && administrativeAttachmentTypes.has(subtype))
  {
    return 0
  }
  const warningToken = subtype ?? '<missing>'
  unknownTypes.set(warningToken, (unknownTypes.get(warningToken) ?? 0) + 1)
  return 0
}

interface CanonicalPrompt
{
  readonly blocks: ReadonlyArray<string>
  readonly imageCount: number
  readonly text: string
}

interface QueuedTaskNotification
{
  readonly status: 'completed' | 'failed' | 'killed' | null
  readonly summary: string
}

function canonicalPrompt(value: unknown): CanonicalPrompt | null
{
  if (typeof value === 'string')
  {
    const text = value.replace(/\r\n?/gu, '\n').trim()
    return text.length === 0 ? null : { blocks: [`text:${text}`], imageCount: 0, text }
  }
  const content = isRecord(value) && Array.isArray(value.content) ? value.content : value
  if (!Array.isArray(content))
  {
    return null
  }
  if (content.length > maxCollectionItems)
  {
    return null
  }

  const blocks: string[] = []
  const textParts: string[] = []
  let imageCount = 0
  for (const blockValue of content)
  {
    if (!isRecord(blockValue))
    {
      return null
    }
    const blockType = asString(blockValue.type)
    if (blockType === 'text' && typeof blockValue.text === 'string')
    {
      const text = blockValue.text.replace(/\r\n?/gu, '\n').trim()
      blocks.push(`text:${text}`)
      textParts.push(text)
      continue
    }
    if (blockType === 'image')
    {
      const source = isRecord(blockValue.source) ? blockValue.source : {}
      const mediaType = asString(source.media_type) ?? asString(source.mediaType) ?? ''
      const payload = stringifyValue(source.data ?? source.url ?? source.path ?? source)
      blocks.push(`image:${mediaType}:${deterministicId(payload, 'claude-queued-image')}`)
      imageCount += 1
      continue
    }
    return null
  }

  return {
    blocks,
    imageCount,
    text: textParts.filter((text) => text.length > 0).join('\n'),
  }
}

function parseQueuedTaskNotification(prompt: string): QueuedTaskNotification | null
{
  const trimmed = prompt.trim()
  const rootMatch = /^<task-notification>([\s\S]*)<\/task-notification>$/u.exec(trimmed)
  if (rootMatch === null)
  {
    return null
  }

  const scalarNames = new Set(['task-id', 'summary', 'status'])
  const children = new Map<string, string>()
  const content = rootMatch[1] ?? ''
  const tagPattern = /<(\/?)([a-z][a-z0-9-]*)(?:\s[^<>]*)?(\/?)>/gu
  const stack: string[] = []
  let directChildName: string | null = null
  let directChildStart = 0
  let directChildHasNestedContent = false
  for (const tagMatch of content.matchAll(tagPattern))
  {
    const tagIndex = tagMatch.index
    const name = tagMatch[2]
    if (name === undefined)
    {
      return null
    }
    const closing = tagMatch[1] === '/'
    const selfClosing = tagMatch[3] === '/'
    const tagEnd = tagIndex + tagMatch[0].length
    if (closing)
    {
      if (selfClosing || stack.pop() !== name)
      {
        return null
      }
      if (stack.length === 0)
      {
        if (directChildName !== name)
        {
          return null
        }
        if (scalarNames.has(name))
        {
          if (directChildHasNestedContent || children.has(name))
          {
            return null
          }
          children.set(name, content.slice(directChildStart, tagIndex).trim())
        }
        directChildName = null
      }
    }
    else if (stack.length === 0)
    {
      directChildName = name
      directChildStart = tagEnd
      directChildHasNestedContent = false
      if (selfClosing)
      {
        if (scalarNames.has(name))
        {
          if (children.has(name))
          {
            return null
          }
          children.set(name, '')
        }
        directChildName = null
      }
      else
      {
        stack.push(name)
      }
    }
    else
    {
      directChildHasNestedContent = true
      if (!selfClosing)
      {
        stack.push(name)
      }
    }
  }
  if (stack.length > 0 || directChildName !== null)
  {
    return null
  }

  const taskId = children.get('task-id') ?? ''
  const summary = children.get('summary') ?? ''
  if (taskId.length === 0 || taskId.length > maxMetadataCharacters || summary.length === 0)
  {
    return null
  }
  const statusValue = children.get('status')
  const status =
    statusValue === 'completed' || statusValue === 'failed' || statusValue === 'killed'
      ? statusValue
      : null
  return {
    status,
    summary,
  }
}

function isDuplicateQueuedPrompt(
  timelineLines: ReadonlyArray<ParsedClaudeLine>,
  currentIndex: number,
  queuedPrompt: CanonicalPrompt,
): boolean
{
  for (let index = currentIndex + 1; index < timelineLines.length; index += 1)
  {
    const candidate = timelineLines[index]
    if (candidate === undefined)
    {
      continue
    }
    if (candidate.type === 'attachment')
    {
      const attachment = isRecord(candidate.value.attachment) ? candidate.value.attachment : null
      if (attachment?.type === 'queued_command')
      {
        return false
      }
      continue
    }
    if (candidate.type !== 'user')
    {
      continue
    }
    const message = isRecord(candidate.value.message) ? candidate.value.message : null
    const ordinaryPrompt = canonicalPrompt(message?.content)
    return (
      ordinaryPrompt !== null &&
      ordinaryPrompt.blocks.length === queuedPrompt.blocks.length &&
      ordinaryPrompt.blocks.every((block, blockIndex) => block === queuedPrompt.blocks[blockIndex])
    )
  }
  return false
}

export function parseClaudeSession(input: ParseInput): ImportedSession
{
  const warnings: WarningState = { details: [], omittedCount: 0, totalCount: 0 }
  const meta = emptyMeta(input)
  const parsedLines: ParsedClaudeLine[] = []
  let lastSourceIndex = -1
  let parsedRecordCount = 0

  for (const { line: rawLine, sourceIndex } of iterateJsonlPhysicalLines(
    input.content,
    maxPhysicalLines,
  ))
  {
    lastSourceIndex = sourceIndex
    if (rawLine.trim().length === 0)
    {
      continue
    }

    let parsedValue: unknown
    try
    {
      parsedValue = JSON.parse(rawLine)
    }
    catch
    {
      addWarning(warnings, `line ${sourceIndex + 1}: malformed JSON skipped`)
      continue
    }
    if (!isRecord(parsedValue))
    {
      addWarning(warnings, `line ${sourceIndex + 1}: expected a JSON object`)
      continue
    }
    parsedRecordCount = incrementJsonlRecordCount(parsedRecordCount, maxJsonlRecords)
    const line = parsedValue
    if (line.isSidechain === true)
    {
      continue
    }
    parsedLines.push({
      parentUuid: asString(line.parentUuid),
      sessionId: asString(line.sessionId),
      sourceIndex,
      type: asString(line.type),
      uuid: asString(line.uuid),
      value: line,
    })
  }

  const canonicalSessionId = selectCanonicalSessionId(parsedLines, input.sourcePath)
  const trustedSessionId = trustedSessionIdFromPath(input.sourcePath)
  if (trustedSessionId !== null)
  {
    const ownershipMismatchCount = parsedLines.filter(
      (line) => line.sessionId !== null && line.sessionId !== trustedSessionId,
    ).length
    if (ownershipMismatchCount > 0)
    {
      const noun = ownershipMismatchCount === 1 ? 'record' : 'records'
      addWarning(
        warnings,
        `ignored ${ownershipMismatchCount} Claude ${noun} whose session id did not match the transcript filename`,
      )
    }
  }
  const sessionLines = parsedLines.filter((line) =>
    canonicalSessionId === null ? line.sessionId === null : line.sessionId === canonicalSessionId,
  )
  meta.nativeSessionId = safeNativeSessionId(canonicalSessionId, warnings)
  let hasMetadata = canonicalSessionId !== null
  const titleSeen = applySessionWideTitle(meta, sessionLines, warnings)
  hasMetadata ||= titleSeen

  const graphExists = sessionLines.some((line) => line.uuid !== null)
  const graphAncestry = selectClaudeGraphAncestry(sessionLines, warnings)
  if (graphAncestry === null)
  {
    return finalize(meta, [], warnings, hasMetadata)
  }
  if (graphExists)
  {
    const uuidlessVisibleCount = sessionLines.filter(
      (line) => line.uuid === null && (line.type === 'user' || line.type === 'assistant'),
    ).length
    if (uuidlessVisibleCount > 0)
    {
      const noun = uuidlessVisibleCount === 1 ? 'record' : 'records'
      addWarning(
        warnings,
        `skipped ${uuidlessVisibleCount} UUID-less visible Claude ${noun} because graph history is available`,
      )
    }
  }

  const timelineLines = graphExists ? graphAncestry : sessionLines
  const records: ImportedRecord[] = []
  const pendingTools = new Map<string, ImportedActivityRecord>()
  const incompleteToolActivities = new Set<ImportedActivityRecord>()
  const warnedUnknownTypes = new Set<string>()
  const unknownAttachmentTypes = new Map<string, number>()
  let omittedAttachmentCount = 0
  let lastOmittedAttachmentAt: string | null = null

  for (let timelineIndex = 0; timelineIndex < timelineLines.length; timelineIndex += 1)
  {
    const parsedLine = timelineLines[timelineIndex]
    if (parsedLine === undefined)
    {
      continue
    }
    const line = parsedLine.value
    const sourceIndex = parsedLine.sourceIndex
    const sessionId = parsedLine.sessionId
    const cwd = asString(line.cwd)
    const gitBranch = asString(line.gitBranch)
    hasMetadata ||= sessionId !== null || cwd !== null || gitBranch !== null
    meta.cwd = safeCwd(cwd, sourceIndex, warnings) ?? meta.cwd
    meta.gitBranch =
      boundMetadataField(gitBranch, `line ${sourceIndex + 1}: git branch`, warnings) ??
      meta.gitBranch

    const type = parsedLine.type
    if (type === null)
    {
      addWarning(warnings, `line ${sourceIndex + 1}: missing type skipped`)
      continue
    }
    if (type === 'attachment')
    {
      const attachment = isRecord(line.attachment) ? line.attachment : null
      if (attachment?.type === 'queued_command')
      {
        const prompt = attachment.prompt
        if (typeof prompt === 'string' && /^<task-notification(?:\s|>)/u.test(prompt.trim()))
        {
          const notification = parseQueuedTaskNotification(prompt)
          if (notification === null)
          {
            addWarning(
              warnings,
              `line ${sourceIndex + 1}: malformed queued task notification was omitted`,
            )
            continue
          }
          const createdAt = normalizeTimestamp(line.timestamp)
          if (createdAt === null)
          {
            addWarning(
              warnings,
              `line ${sourceIndex + 1}: queued task notification has an invalid timestamp`,
            )
            continue
          }
          const summary = truncate(
            boundMetadataField(
              notification.summary,
              `line ${sourceIndex + 1}: queued task summary`,
              warnings,
            ) ?? '',
            summaryLimit,
          )
          pushImportedRecord(records, {
            kind: 'activity',
            tone:
              notification.status === 'failed' || notification.status === 'killed'
                ? 'error'
                : 'info',
            activityKind: 'task.completed',
            summary,
            payload: {
              summary,
              ...(notification.status === null ? {} : { status: notification.status }),
            },
            createdAt,
            sourceIndex,
          })
          continue
        }

        const queuedPrompt = canonicalPrompt(prompt)
        if (queuedPrompt === null)
        {
          addWarning(warnings, `line ${sourceIndex + 1}: unknown queued command shape was omitted`)
          continue
        }
        if (isDuplicateQueuedPrompt(timelineLines, timelineIndex, queuedPrompt))
        {
          continue
        }
        const createdAt = normalizeTimestamp(line.timestamp)
        omittedAttachmentCount += queuedPrompt.imageCount
        if (queuedPrompt.imageCount > 0)
        {
          lastOmittedAttachmentAt = createdAt ?? lastOmittedAttachmentAt
        }
        if (queuedPrompt.text.length === 0)
        {
          continue
        }
        if (createdAt === null)
        {
          addWarning(warnings, `line ${sourceIndex + 1}: queued command has an invalid timestamp`)
          continue
        }
        pushImportedRecord(records, {
          kind: 'message',
          role: 'user',
          text: boundTextField(
            queuedPrompt.text,
            `line ${sourceIndex + 1}: queued user message`,
            warnings,
          ),
          createdAt,
          sourceIndex,
        })
        continue
      }
      const attachmentCount = classifyAttachment(parsedLine, unknownAttachmentTypes)
      omittedAttachmentCount += attachmentCount
      if (attachmentCount > 0)
      {
        lastOmittedAttachmentAt = normalizeTimestamp(line.timestamp) ?? lastOmittedAttachmentAt
      }
      continue
    }
    if (skippedTypes.has(type) || type === 'ai-title' || type === 'custom-title')
    {
      continue
    }
    if (!knownTypes.has(type))
    {
      if (!warnedUnknownTypes.has(type))
      {
        addWarning(warnings, `unknown line type "${truncate(type, summaryLimit)}" skipped`)
        warnedUnknownTypes.add(type)
      }
      continue
    }

    const message = isRecord(line.message) ? line.message : null
    if (message === null)
    {
      addWarning(warnings, `line ${sourceIndex + 1}: malformed ${type} message skipped`)
      continue
    }

    if (type === 'assistant')
    {
      const model = asString(message.model)
      hasMetadata ||= model !== null
      meta.model =
        boundMetadataField(model, `line ${sourceIndex + 1}: model`, warnings) ?? meta.model
    }

    const content = message.content
    const contentAttachmentCount = countOmittedContentAttachments(content, sourceIndex, warnings)
    if (contentAttachmentCount > 0)
    {
      omittedAttachmentCount += contentAttachmentCount
      lastOmittedAttachmentAt = normalizeTimestamp(line.timestamp) ?? lastOmittedAttachmentAt
    }

    const createdAt = normalizeTimestamp(line.timestamp)
    if (createdAt === null)
    {
      addWarning(warnings, `line ${sourceIndex + 1}: invalid timestamp skipped`)
      continue
    }

    if (type === 'user' && meta.title === null)
    {
      const title = claudeSemanticTitle(
        line.isMeta,
        Array.isArray(content) ? content.slice(0, maxCollectionItems) : content,
      )
      meta.title = title === null ? null : truncate(title, maxMetadataCharacters)
    }

    if (typeof content === 'string')
    {
      const text = content.trim()
      if (type === 'user' && text.length > 0)
      {
        pushImportedRecord(records, {
          kind: 'message',
          role: 'user',
          text: boundTextField(text, `line ${sourceIndex + 1}: user message`, warnings),
          createdAt,
          sourceIndex,
        })
      }
      else if (type === 'assistant' && text.length > 0)
      {
        pushImportedRecord(records, {
          kind: 'message',
          role: 'assistant',
          text: boundTextField(text, `line ${sourceIndex + 1}: assistant message`, warnings),
          createdAt,
          sourceIndex,
        })
      }
      continue
    }
    if (!Array.isArray(content))
    {
      addWarning(warnings, `line ${sourceIndex + 1}: unsupported ${type} content skipped`)
      continue
    }

    let adjacentText: string[] = []
    let unsupportedContentBlockCount = 0
    if (content.length > maxCollectionItems)
    {
      addWarning(
        warnings,
        `line ${sourceIndex + 1}: ${type} content was capped at ${maxCollectionItems} of ${content.length} blocks`,
      )
    }
    const flushAdjacentText = () =>
    {
      const text = adjacentText.join('\n').trim()
      adjacentText = []
      if (text.length === 0)
      {
        return
      }
      pushImportedRecord(records, {
        kind: 'message',
        role: type === 'user' ? 'user' : 'assistant',
        text: boundTextField(text, `line ${sourceIndex + 1}: ${type} message`, warnings),
        createdAt,
        sourceIndex,
      })
    }

    for (const blockValue of content.slice(0, maxCollectionItems))
    {
      if (!isRecord(blockValue))
      {
        flushAdjacentText()
        unsupportedContentBlockCount += 1
        continue
      }
      const blockType = asString(blockValue.type)

      if (blockType === 'text' && typeof blockValue.text === 'string')
      {
        adjacentText.push(blockValue.text)
        continue
      }
      flushAdjacentText()

      if (type === 'user' && blockType === 'tool_result')
      {
        const id = toolResultId(blockValue)
        if (id === null)
        {
          addWarning(
            warnings,
            `line ${sourceIndex + 1}: tool result has no call id and was omitted`,
          )
          continue
        }
        const pending = pendingTools.get(id)
        if (pending !== undefined)
        {
          completeToolActivity(
            pending,
            toolResultContent(blockValue, sourceIndex, warnings),
            blockValue.is_error === true,
          )
          incompleteToolActivities.delete(pending)
          pendingTools.delete(id)
        }
        else
        {
          addWarning(warnings, `line ${sourceIndex + 1}: unpaired tool result was omitted`)
        }
        continue
      }

      if (
        type === 'assistant' &&
        blockType === 'thinking' &&
        typeof blockValue.thinking === 'string'
      )
      {
        const thinking = boundTextField(
          blockValue.thinking.trim(),
          `line ${sourceIndex + 1}: reasoning`,
          warnings,
        )
        if (thinking.length > 0)
        {
          const summary = summarize(thinking)
          pushImportedRecord(records, {
            kind: 'activity',
            tone: 'info',
            activityKind: 'task.progress',
            summary,
            payload: { summary, detail: thinking },
            createdAt,
            sourceIndex,
          })
        }
        continue
      }

      if (type === 'assistant' && blockType === 'tool_use')
      {
        const id = asString(blockValue.id)
        if (id === null)
        {
          addWarning(warnings, `line ${sourceIndex + 1}: tool call has no call id and was omitted`)
          continue
        }
        const name = boundToolName(asString(blockValue.name) ?? 'tool', sourceIndex, warnings)
        const hint = summarize(toolInputHint(blockValue.input))
        const itemType = mapToolName(name)
        const normalizedInput = normalizeToolInput(blockValue.input, sourceIndex, warnings)
        const changes = toolFileChanges(blockValue.input, sourceIndex, warnings)
        const item: Record<string, unknown> = {
          input: normalizedInput.value,
        }
        const data: Record<string, unknown> = {
          toolCallId: boundStableToolCallId(id, sourceIndex, warnings),
          kind: toolKind(itemType),
          rawInput: normalizedInput.value,
          item,
        }
        if (normalizedInput.command !== null)
        {
          item.command = normalizedInput.command
          data.command = normalizedInput.command
        }
        if (changes.length > 0)
        {
          item.changes = changes
        }
        const activity: ImportedActivityRecord = {
          kind: 'activity',
          tone: 'tool',
          activityKind: 'tool.completed',
          summary: truncate(hint.length > 0 ? `${name}: ${hint}` : name, summaryLimit),
          payload: {
            itemType,
            title: name,
            status: 'completed',
            data,
          },
          createdAt,
          sourceIndex,
        }
        pushImportedRecord(records, activity)
        incompleteToolActivities.add(activity)
        pendingTools.set(id, activity)
        continue
      }

      if (blockType !== null && omittedContentBlockTypes.has(blockType))
      {
        continue
      }
      unsupportedContentBlockCount += 1
    }
    flushAdjacentText()
    if (unsupportedContentBlockCount > 0)
    {
      const noun = unsupportedContentBlockCount === 1 ? 'block' : 'blocks'
      addWarning(
        warnings,
        `line ${sourceIndex + 1}: ${unsupportedContentBlockCount} unsupported ${type} content ${noun} omitted`,
      )
    }
  }

  for (const [subtype, count] of [...unknownAttachmentTypes].toSorted(([left], [right]) =>
    left.localeCompare(right),
  ))
  {
    const noun = count === 1 ? 'record' : 'records'
    addWarning(
      warnings,
      `unknown Claude attachment subtype "${truncate(subtype, summaryLimit)}" appeared in ${count} selected ${noun} and was omitted`,
    )
  }
  if (incompleteToolActivities.size > 0)
  {
    const noun = incompleteToolActivities.size === 1 ? 'call' : 'calls'
    addWarning(
      warnings,
      `omitted ${incompleteToolActivities.size} unpaired tool ${noun} from imported transcript`,
    )
  }
  const completedRecords = records.filter(
    (record) => record.kind !== 'activity' || !incompleteToolActivities.has(record),
  )
  appendOmittedAttachmentActivity(
    completedRecords,
    omittedAttachmentCount,
    lastOmittedAttachmentAt,
    lastSourceIndex + 1,
  )
  appendParsingWarningActivity(completedRecords, warnings, lastSourceIndex + 2, pushImportedRecord)
  meta.title ??= 'Imported session'
  return finalize(meta, completedRecords, warnings, hasMetadata)
}
