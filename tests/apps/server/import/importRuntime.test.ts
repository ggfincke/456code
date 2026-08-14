// tests/apps/server/import/importRuntime.test.ts
// verifies canonical import projection indexing in the root-owned runtime

import { expect, it } from '@effect/vitest'
import { ProjectId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'

import { makeImportedThreadShellIndex } from '../../../../apps/server/src/import/importRuntime.ts'
import type { ProjectionImportReconciliationContext } from '../../../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts'

const providerInstanceId = ProviderInstanceId.make('codex')
const modelSelection = { instanceId: providerInstanceId, model: 'gpt-default' }

it('prefers the active imported thread when projection order places its archived duplicate first', () =>
{
  const activeThreadId = ThreadId.make('active-import')
  const archivedThreadId = ThreadId.make('archived-import')
  const sourcePath = '/tmp/shared-import.jsonl'
  const origin = {
    kind: 'imported' as const,
    source: 'codex-cli' as const,
    sourcePath,
    contentHash: 'content-hash',
    nativeSessionId: 'native-session',
    providerInstanceId,
    importedAt: '2026-01-01T00:00:00.000Z',
  }
  const context = {
    projects: [
      { projectId: ProjectId.make('archived-project'), workspaceRoot: '/archived' },
      { projectId: ProjectId.make('active-project'), workspaceRoot: '/active' },
    ],
    threads: [
      {
        threadId: archivedThreadId,
        projectId: ProjectId.make('archived-project'),
        modelSelection,
        origin,
        archived: true,
      },
      {
        threadId: activeThreadId,
        projectId: ProjectId.make('active-project'),
        modelSelection,
        origin,
        archived: false,
      },
    ],
  } satisfies ProjectionImportReconciliationContext

  const match = makeImportedThreadShellIndex(context).find({
    source: 'codex-cli',
    sourcePath,
    nativeSessionId: 'native-session',
    providerInstanceId,
  })

  expect(match).toMatchObject({ threadId: activeThreadId, archived: false })
})
