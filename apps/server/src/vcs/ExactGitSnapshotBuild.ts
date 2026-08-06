// apps/server/src/vcs/ExactGitSnapshotBuild.ts
// build fast-import and index-info payloads for exact snapshots

import { OBJECT_ID, exactError } from './ExactGitSnapshotGit.ts'

export interface SnapshotEntry
{
  readonly path: string
  readonly mode: string
  readonly content?: Buffer
  readonly existingOid?: string
}

export function buildFastImportInput(entries: ReadonlyArray<SnapshotEntry>): {
  readonly input: Buffer
  readonly entriesWithContent: ReadonlyArray<SnapshotEntry>
}
{
  const entriesWithContent = entries.filter(
    (entry): entry is SnapshotEntry & { readonly content: Buffer } => entry.content !== undefined,
  )
  const parts: Buffer[] = []
  for (const [index, entry] of entriesWithContent.entries())
  {
    parts.push(
      Buffer.from(`blob\nmark :${index + 1}\ndata ${entry.content.byteLength}\n`, 'ascii'),
      entry.content,
      Buffer.from('\n', 'ascii'),
    )
  }
  for (const index of entriesWithContent.keys())
  {
    parts.push(Buffer.from(`get-mark :${index + 1}\n`, 'ascii'))
  }
  parts.push(Buffer.from('done\n', 'ascii'))
  return { input: Buffer.concat(parts), entriesWithContent }
}
export function buildIndexInput(
  entries: ReadonlyArray<SnapshotEntry>,
  importedObjectIds: ReadonlyMap<SnapshotEntry, string>,
): Buffer
{
  return Buffer.concat(
    entries.map((entry) =>
    {
      const oid = entry.existingOid ?? importedObjectIds.get(entry)
      if (oid === undefined || !OBJECT_ID.test(oid))
      {
        throw exactError('git-failed', `Git object identity is missing for '${entry.path}'.`)
      }
      return Buffer.from(`${entry.mode} ${oid}\t${entry.path}\0`, 'utf8')
    }),
  )
}
