// packages/cartographer-core/src/store/snapshots.ts
// snapshot history in .cartographer/graph.db via node:sqlite

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import type * as NodeSqlite from 'node:sqlite'
import * as NodeURL from 'node:url'
import type { SnapshotMeta } from '../contracts/atlasContract.js'
import { assertGraphVersion, GRAPH_SCHEMA_VERSION } from '../contracts/types.js'
import type { CartographerGraph } from '../contracts/types.js'
import { assertNotSymlink, ensureOutDir } from './artifactFs.js'
import { outDirPath } from './paths.js'

export type { SnapshotMeta }

export class SnapshotCapabilityError extends Error
{
  readonly _tag = 'SnapshotCapabilityError'
  readonly code = 'node-sqlite-unavailable'

  constructor()
  {
    super('snapshot history requires the node:sqlite builtin')
    this.name = 'SnapshotCapabilityError'
  }
}

interface LegacyGraphV3 extends Omit<CartographerGraph, 'groups' | 'version'>
{
  version: 3
  groups?: CartographerGraph['groups']
}

export interface SnapshotPage
{
  snapshots: SnapshotMeta[]
  total: number
  ceiling: number
  nextBeforeId?: number
}

export interface SnapshotAccessOptions
{
  readonly immutableArtifacts?: boolean
}

export class SnapshotArtifactUnavailableError extends Error
{
  readonly _tag = 'SnapshotArtifactUnavailableError'
  readonly path: string

  constructor(path: string)
  {
    super(`prepared snapshot database is missing or unreadable at ${path}`)
    this.name = 'SnapshotArtifactUnavailableError'
    this.path = path
  }
}

// each row stores the full graph JSON -> cap history so graph.db can't grow forever
const SNAPSHOT_RETAIN_MAX = 100

// v3 remains structurally sufficient for diffing; upgrade only historical
// rows, while current graph.json reads keep the exact-version guard
function diffableSnapshot(
  graph: CartographerGraph | LegacyGraphV3,
  source: string,
): CartographerGraph
{
  if (graph.version === 3)
  {
    return {
      ...graph,
      version: GRAPH_SCHEMA_VERSION,
      groups: graph.groups ?? [],
    }
  }
  assertGraphVersion(graph.version, source)
  return graph
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  git_ref TEXT,
  scope TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  cycles INTEGER NOT NULL,
  graph_json TEXT NOT NULL
);
`

export function dbPath(root: string, outDir?: string): string
{
  return NodePath.join(outDirPath(root, outDir), 'graph.db')
}

function openDb(
  root: string,
  outDir?: string,
  options: SnapshotAccessOptions = {},
): NodeSqlite.DatabaseSync
{
  const path = dbPath(root, outDir)
  if (!options.immutableArtifacts)
  {
    ensureOutDir(root, outDir)
    // sqlite follows symlinks on open -> reject a planted graph.db link first
    assertNotSymlink(path, 'snapshot database')
  }
  // lazy builtin load keeps sqlite out of commands that never use snapshots
  const sqlite =
    typeof process.getBuiltinModule === 'function'
      ? (process.getBuiltinModule('node:sqlite') as typeof NodeSqlite | undefined)
      : undefined
  if (sqlite === undefined)
  {
    throw new SnapshotCapabilityError()
  }

  if (options.immutableArtifacts)
  {
    let stat
    try
    {
      stat = NodeFS.lstatSync(path)
    }
    catch
    {
      throw new SnapshotArtifactUnavailableError(path)
    }
    if (!stat.isFile() || stat.isSymbolicLink())
    {
      throw new SnapshotArtifactUnavailableError(path)
    }
    try
    {
      const url = NodeURL.pathToFileURL(path)
      url.searchParams.set('immutable', '1')
      return new sqlite.DatabaseSync(url, { readOnly: true })
    }
    catch
    {
      throw new SnapshotArtifactUnavailableError(path)
    }
  }

  const db = new sqlite.DatabaseSync(path)
  // WAL + busy wait -> concurrent watch/server/MCP processes don't hit SQLITE_BUSY
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

function withDb<T>(
  root: string,
  outDir: string | undefined,
  callback: (db: NodeSqlite.DatabaseSync) => T,
  options: SnapshotAccessOptions = {},
): T
{
  const db = openDb(root, outDir, options)
  try
  {
    return callback(db)
  }
  finally
  {
    db.close()
  }
}

export function recordSnapshot(graph: CartographerGraph, root: string, outDir?: string): number
{
  return withDb(root, outDir, (db) =>
  {
    const result = db
      .prepare(
        `INSERT INTO snapshots
           (created_at, git_ref, scope, node_count, edge_count, cycles, graph_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        graph.generatedAt,
        graph.gitRef ?? null,
        graph.scope,
        graph.nodes.length,
        graph.edges.length,
        graph.metrics.cycles,
        JSON.stringify(graph),
      )
    db.prepare(
      `DELETE FROM snapshots WHERE id NOT IN
         (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)`,
    ).run(SNAPSHOT_RETAIN_MAX)
    return Number(result.lastInsertRowid)
  })
}

export function listSnapshots(
  root: string,
  outDir?: string,
  options: SnapshotAccessOptions = {},
): SnapshotMeta[]
{
  return withDb(
    root,
    outDir,
    (db) =>
    {
      const rows = db
        .prepare(
          `SELECT id, created_at, git_ref, scope, node_count, edge_count, cycles
         FROM snapshots ORDER BY id DESC`,
        )
        .all() as Array<Record<string, unknown>>
      return rows.map(snapshotMeta)
    },
    options,
  )
}

function snapshotMeta(row: Record<string, unknown>): SnapshotMeta
{
  return {
    id: Number(row.id),
    createdAt: String(row.created_at),
    ...(row.git_ref ? { gitRef: String(row.git_ref) } : {}),
    scope: String(row.scope),
    nodes: Number(row.node_count),
    edges: Number(row.edge_count),
    cycles: Number(row.cycles),
  }
}

export function listSnapshotPage(
  root: string,
  limit: number,
  beforeId?: number,
  ceilingId?: number,
  outDir?: string,
  options: SnapshotAccessOptions = {},
): SnapshotPage
{
  return withDb(
    root,
    outDir,
    (db) =>
    {
      const ceiling =
        ceilingId ??
        Number(
          (
            db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM snapshots').get() as
              { id: number } | undefined
          )?.id ?? 0,
        )
      const total = Number(
        (
          db.prepare('SELECT COUNT(*) AS count FROM snapshots WHERE id <= ?').get(ceiling) as
            { count: number } | undefined
        )?.count ?? 0,
      )
      const rows = (
        beforeId === undefined
          ? db
              .prepare(
                `SELECT id, created_at, git_ref, scope, node_count, edge_count, cycles
             FROM snapshots WHERE id <= ? ORDER BY id DESC LIMIT ?`,
              )
              .all(ceiling, limit + 1)
          : db
              .prepare(
                `SELECT id, created_at, git_ref, scope, node_count, edge_count, cycles
             FROM snapshots WHERE id <= ? AND id < ? ORDER BY id DESC LIMIT ?`,
              )
              .all(ceiling, beforeId, limit + 1)
      ) as Array<Record<string, unknown>>
      const hasMore = rows.length > limit
      const visible = rows.slice(0, limit).map(snapshotMeta)
      return {
        snapshots: visible,
        total,
        ceiling,
        ...(hasMore && visible.length > 0 ? { nextBeforeId: visible[visible.length - 1]!.id } : {}),
      }
    },
    options,
  )
}

export function getSnapshotMeta(
  root: string,
  id: number,
  outDir?: string,
  options: SnapshotAccessOptions = {},
): SnapshotMeta | undefined
{
  return withDb(
    root,
    outDir,
    (db) =>
    {
      const row = db
        .prepare(
          `SELECT id, created_at, git_ref, scope, node_count, edge_count, cycles
         FROM snapshots WHERE id = ?`,
        )
        .get(id) as Record<string, unknown> | undefined
      return row ? snapshotMeta(row) : undefined
    },
    options,
  )
}

export function loadSnapshot(
  root: string,
  id: number,
  outDir?: string,
  options: SnapshotAccessOptions = {},
): CartographerGraph
{
  return withDb(
    root,
    outDir,
    (db) =>
    {
      const row = db.prepare('SELECT graph_json FROM snapshots WHERE id = ?').get(id) as
        { graph_json: string } | undefined
      if (!row)
      {
        throw new Error(`no snapshot #${id} -> run \`cartographer snapshots\` to list`)
      }
      const graph = JSON.parse(row.graph_json) as CartographerGraph | LegacyGraphV3
      return diffableSnapshot(graph, `snapshot #${id}`)
    },
    options,
  )
}
