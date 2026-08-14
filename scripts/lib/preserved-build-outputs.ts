// scripts/lib/preserved-build-outputs.ts
// preserve generated build outputs across clean acceptance runs

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

export interface PreservedBuildOutputOperations
{
  readonly makeBackupRoot: () => string
  readonly exists: (path: string) => boolean
  readonly copy: (sourcePath: string, targetPath: string) => void
  readonly remove: (path: string) => void
}

export const nodePreservedBuildOutputOperations: PreservedBuildOutputOperations = {
  makeBackupRoot: () =>
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), '456code-release-smoke-backup-')),
  exists: NodeFS.existsSync,
  copy: (sourcePath, targetPath) =>
  {
    NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true })
    NodeFS.cpSync(sourcePath, targetPath, { recursive: true, preserveTimestamps: true })
  },
  remove: (path) => NodeFS.rmSync(path, { recursive: true, force: true }),
}

type PreservationStatus = 'unvisited' | 'initially-absent' | 'backed-up'

interface PreservedBuildOutput
{
  readonly outputPath: string
  readonly backupPath: string
  status: PreservationStatus
}

export function withPreservedBuildOutputs<Result>(
  outputPaths: ReadonlyArray<string>,
  run: () => Result,
  operations: PreservedBuildOutputOperations = nodePreservedBuildOutputOperations,
): Result
{
  const backupRoot = operations.makeBackupRoot()
  const outputs = outputPaths.map((outputPath, index): PreservedBuildOutput => ({
    outputPath,
    backupPath: NodePath.join(backupRoot, `output-${index}`),
    status: 'unvisited',
  }))
  let didStartRun = false
  let hasPrimaryError = false
  let primaryError: unknown
  let result: Result | undefined

  try
  {
    for (const output of outputs)
    {
      if (!operations.exists(output.outputPath))
      {
        output.status = 'initially-absent'
        continue
      }

      operations.copy(output.outputPath, output.backupPath)
      output.status = 'backed-up'
      operations.remove(output.outputPath)
    }

    didStartRun = true
    result = run()
  }
  catch (error)
  {
    hasPrimaryError = true
    primaryError = error
  }

  const restorationErrors: unknown[] = []
  for (const output of outputs)
  {
    if (output.status === 'initially-absent')
    {
      if (!didStartRun)
      {
        continue
      }
      try
      {
        operations.remove(output.outputPath)
      }
      catch (error)
      {
        restorationErrors.push(error)
      }
      continue
    }
    if (output.status !== 'backed-up')
    {
      continue
    }

    try
    {
      operations.remove(output.outputPath)
      operations.copy(output.backupPath, output.outputPath)
    }
    catch (error)
    {
      restorationErrors.push(error)
    }
  }

  if (restorationErrors.length === 0)
  {
    try
    {
      operations.remove(backupRoot)
    }
    catch (error)
    {
      restorationErrors.push(error)
    }
  }

  if (restorationErrors.length > 0)
  {
    throw new AggregateError(
      [...(hasPrimaryError ? [primaryError] : []), ...restorationErrors],
      `Release smoke output restoration failed. Recoverable backups remain at '${backupRoot}'.`,
    )
  }
  if (hasPrimaryError)
  {
    throw primaryError
  }
  return result as Result
}
