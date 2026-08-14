// tests/packages/contracts/orchestrateArchitecturePaths.test.ts
// verifies optional architecturePaths validation on orchestrate plan revisions

import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

import { ARCHITECTURE_BLAST_PATH_LIMIT } from '../../../packages/contracts/src/architectureTools.ts'
import { OrchestratePlanRevision } from '../../../packages/contracts/src/orchestration.ts'

const decodeRevision = Schema.decodeUnknownSync(OrchestratePlanRevision)

function revision(architecturePaths?: ReadonlyArray<string>)
{
  return {
    runId: 'run-architecture-paths',
    revision: 1,
    turnId: null,
    workflow: 'implementation',
    task: 'Ship the change.',
    stages: [],
    totalWorkers: 0,
    maxWorkers: 0,
    source: 'tool',
    status: 'pending',
    createdAt: '2026-08-13T12:00:00.000Z',
    updatedAt: '2026-08-13T12:00:00.000Z',
    ...(architecturePaths === undefined ? {} : { architecturePaths }),
  }
}

describe('OrchestratePlanRevision architecturePaths', () =>
{
  it('omits the field when the agent does not supply paths', () =>
  {
    expect(decodeRevision(revision()).architecturePaths).toBeUndefined()
  })

  it('accepts bounded repository-relative files and directories', () =>
  {
    expect(decodeRevision(revision(['src/api.ts', 'apps/web'])).architecturePaths).toEqual([
      'src/api.ts',
      'apps/web',
    ])
  })

  it('rejects parent segments and over-limit path lists', () =>
  {
    expect(() => decodeRevision(revision(['src/../secret.ts']))).toThrow()
    expect(() =>
      decodeRevision(
        revision(Array.from({ length: ARCHITECTURE_BLAST_PATH_LIMIT + 1 }, () => 'src/a.ts')),
      ),
    ).toThrow()
  })
})
