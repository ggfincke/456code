// apps/server/src/import/continuation/compactImportedSession.ts
// removes redundant imported tool payload copies before persistence

import type { ImportedActivityRecord, ImportedRecord, ImportedSession } from '../types.ts'

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectChangedFiles(
  value: unknown,
  target: Array<{ readonly path: string }>,
  seen: Set<string>,
  depth: number,
): void
{
  if (depth > 4 || target.length >= 12)
  {
    return
  }
  if (Array.isArray(value))
  {
    for (const item of value)
    {
      collectChangedFiles(item, target, seen, depth + 1)
      if (target.length >= 12)
      {
        return
      }
    }
    return
  }
  if (!isRecord(value))
  {
    return
  }

  for (const key of [
    'path',
    'filePath',
    'file_path',
    'relativePath',
    'filename',
    'newPath',
    'new_path',
    'oldPath',
    'old_path',
  ])
  {
    const path = value[key]
    if (typeof path !== 'string')
    {
      continue
    }
    const normalized = path.trim()
    if (normalized.length === 0 || seen.has(normalized))
    {
      continue
    }
    seen.add(normalized)
    target.push({ path: normalized })
    if (target.length >= 12)
    {
      return
    }
  }
  for (const key of ['changes', 'files', 'edits', 'patch', 'patches', 'operations', 'input'])
  {
    if (!(key in value))
    {
      continue
    }
    collectChangedFiles(value[key], target, seen, depth + 1)
    if (target.length >= 12)
    {
      return
    }
  }
}

function compactFileChangeItem(item: unknown): Record<string, unknown> | null
{
  if (!isRecord(item))
  {
    return null
  }
  if (Array.isArray(item.changes))
  {
    return { changes: item.changes }
  }
  const changes: Array<{ readonly path: string }> = []
  collectChangedFiles(item, changes, new Set(), 0)
  return changes.length === 0 ? null : { changes }
}

function compactActivity(record: ImportedActivityRecord): ImportedActivityRecord
{
  const data = isRecord(record.payload.data) ? record.payload.data : null
  if (data === null || typeof record.payload.itemType !== 'string')
  {
    return record
  }

  const compactData: Record<string, unknown> = {}
  for (const key of Object.keys(data))
  {
    if (key === 'rawInput' || key === 'rawOutput' || key === 'item')
    {
      continue
    }
    compactData[key] = data[key]
  }

  if (record.payload.itemType === 'mcp_tool_call' && data.item !== undefined)
  {
    compactData.item = data.item
  }
  else if (record.payload.itemType === 'file_change')
  {
    const item = compactFileChangeItem(data.item)
    if (item !== null)
    {
      compactData.item = item
    }
  }

  const payload = { ...record.payload }
  if (Object.keys(compactData).length === 0)
  {
    delete payload.data
  }
  else
  {
    payload.data = compactData
  }
  return {
    ...record,
    payload,
  }
}

function compactRecord(record: ImportedRecord): ImportedRecord
{
  return record.kind === 'activity' ? compactActivity(record) : record
}

export function compactImportedSession(session: ImportedSession): ImportedSession
{
  return {
    ...session,
    records: session.records.map(compactRecord),
  }
}
