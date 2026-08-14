// tests/scripts/lib/preserved-build-outputs.test.ts
// verify release-smoke build output preservation under filesystem failures

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { afterEach, describe, it } from 'vite-plus/test'

import {
  nodePreservedBuildOutputOperations,
  withPreservedBuildOutputs,
} from '../../../scripts/lib/preserved-build-outputs.ts'

const tempRoots: string[] = []

function makeTempRoot(): string
{
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), '456code-output-backup-test-'))
  tempRoots.push(root)
  return root
}

function writeMarker(root: string, marker: string): void
{
  NodeFS.mkdirSync(root, { recursive: true })
  NodeFS.writeFileSync(NodePath.join(root, 'marker.txt'), marker)
}

function readMarker(root: string): string
{
  return NodeFS.readFileSync(NodePath.join(root, 'marker.txt'), 'utf8')
}

afterEach(() =>
{
  for (const root of tempRoots.splice(0))
  {
    NodeFS.rmSync(root, { recursive: true, force: true })
  }
})

describe('withPreservedBuildOutputs', () =>
{
  it('rolls back completed backups without touching the failed or unvisited outputs', () =>
  {
    const root = makeTempRoot()
    const backupRoot = NodePath.join(root, 'backup')
    const first = NodePath.join(root, 'first')
    const failed = NodePath.join(root, 'failed')
    const unvisited = NodePath.join(root, 'unvisited')
    const initiallyAbsent = NodePath.join(root, 'initially-absent')
    writeMarker(first, 'first-original')
    writeMarker(failed, 'failed-original')
    writeMarker(unvisited, 'unvisited-original')
    NodeFS.mkdirSync(backupRoot)
    const removedPaths: string[] = []
    let didRun = false

    const operations = {
      ...nodePreservedBuildOutputOperations,
      makeBackupRoot: () => backupRoot,
      copy: (sourcePath: string, targetPath: string) =>
      {
        if (sourcePath === failed)
        {
          throw new Error('injected backup failure')
        }
        nodePreservedBuildOutputOperations.copy(sourcePath, targetPath)
      },
      remove: (path: string) =>
      {
        removedPaths.push(path)
        nodePreservedBuildOutputOperations.remove(path)
      },
    }

    NodeAssert.throws(
      () =>
        withPreservedBuildOutputs(
          [first, failed, unvisited, initiallyAbsent],
          () =>
          {
            didRun = true
          },
          operations,
        ),
      /injected backup failure/u,
    )
    NodeAssert.equal(didRun, false)
    NodeAssert.equal(readMarker(first), 'first-original')
    NodeAssert.equal(readMarker(failed), 'failed-original')
    NodeAssert.equal(readMarker(unvisited), 'unvisited-original')
    NodeAssert.equal(NodeFS.existsSync(initiallyAbsent), false)
    NodeAssert.equal(removedPaths.includes(failed), false)
    NodeAssert.equal(removedPaths.includes(unvisited), false)
    NodeAssert.equal(removedPaths.includes(initiallyAbsent), false)
    NodeAssert.equal(NodeFS.existsSync(backupRoot), false)
  })

  it('retains the independent backup root when restoration fails', () =>
  {
    const root = makeTempRoot()
    const backupRoot = NodePath.join(root, 'recovery-backup')
    const output = NodePath.join(root, 'output')
    const initiallyAbsent = NodePath.join(root, 'initially-absent')
    writeMarker(output, 'original')
    NodeFS.mkdirSync(backupRoot)

    const operations = {
      ...nodePreservedBuildOutputOperations,
      makeBackupRoot: () => backupRoot,
      copy: (sourcePath: string, targetPath: string) =>
      {
        if (sourcePath.startsWith(`${backupRoot}${NodePath.sep}`) && targetPath === output)
        {
          throw new Error('injected restoration failure')
        }
        nodePreservedBuildOutputOperations.copy(sourcePath, targetPath)
      },
    }

    NodeAssert.throws(
      () =>
        withPreservedBuildOutputs(
          [output, initiallyAbsent],
          () =>
          {
            writeMarker(output, 'generated')
            writeMarker(initiallyAbsent, 'generated')
          },
          operations,
        ),
      new RegExp(`Recoverable backups remain at '${backupRoot.replaceAll('\\', '\\\\')}'`, 'u'),
    )
    NodeAssert.equal(NodeFS.existsSync(output), false)
    NodeAssert.equal(NodeFS.existsSync(initiallyAbsent), false)
    NodeAssert.equal(readMarker(NodePath.join(backupRoot, 'output-0')), 'original')
  })
})
