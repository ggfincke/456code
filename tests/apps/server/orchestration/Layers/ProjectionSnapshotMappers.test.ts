// tests/apps/server/orchestration/Layers/ProjectionSnapshotMappers.test.ts
// verifies optional architecturePaths survive snapshot row mapping

import { ThreadId } from '@t3tools/contracts'
import { describe, expect, it } from 'vite-plus/test'

import { mapOrchestratePlanRow } from '../../../../../apps/server/src/orchestration/Layers/ProjectionSnapshotMappers.ts'

const row = {
  threadId: ThreadId.make('thread-1'),
  runId: 'run-1',
  revision: 2,
  turnId: null,
  workflow: 'implementation',
  task: 'Ship the change.',
  stages: [],
  totalWorkers: 0,
  maxWorkers: 0,
  source: 'tool' as const,
  leadModelSelection: null,
  status: 'pending' as const,
  sourceSequence: 41,
  createdAt: '2026-08-13T12:00:00.000Z',
  updatedAt: '2026-08-13T12:00:00.000Z',
}

describe('mapOrchestratePlanRow architecturePaths', () =>
{
  it('omits empty or null path lists', () =>
  {
    expect(
      mapOrchestratePlanRow({ ...row, architecturePaths: null }).architecturePaths,
    ).toBeUndefined()
    expect(
      mapOrchestratePlanRow({ ...row, architecturePaths: [] }).architecturePaths,
    ).toBeUndefined()
  })

  it('keeps bounded repository-relative paths', () =>
  {
    expect(
      mapOrchestratePlanRow({
        ...row,
        architecturePaths: ['src/api.ts', 'apps/web'],
      }).architecturePaths,
    ).toEqual(['src/api.ts', 'apps/web'])
  })
})
