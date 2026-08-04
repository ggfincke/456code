// tests/apps/web/components/files/projectFilesQueryState.test.ts
// verifies optimistic source confirmation & MDX query invalidation

import type { ProjectReadFileResult } from '@t3tools/contracts'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import { AsyncResult } from 'effect/unstable/reactivity'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  clearConfirmedProjectFileQueryData,
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  confirmProjectMdxFileQueryData,
  getProjectMdxDocumentQueryAtom,
  getOptimisticProjectFileQueryData,
  isConfirmedProjectFileQuerySuperseded,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from '../../../../../apps/web/src/components/files/projectFilesQueryState'
import { appAtomRegistry } from '../../../../../apps/web/src/rpc/atomRegistry'
import { projectEnvironment } from '../../../../../apps/web/src/state/projects'

const environmentId = EnvironmentId.make('environment-project-files-query-test')
const threadId = ThreadId.make('thread-project-files-query-test')

describe('project files queries', () =>
{
  afterEach(() =>
  {
    clearProjectFileQueryData(environmentId, '/repo', 'convex.json')
    clearProjectFileQueryData(environmentId, '/repo', 'docs/guide.mdx')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the latest optimistic draft when an older write finishes', () =>
  {
    vi.stubGlobal('window', {})
    const initial = {
      relativePath: 'convex.json',
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult
    setProjectFileQueryData(environmentId, '/repo', 'convex.json', '{"nodeVersion":"220"}')
    setProjectFileQueryData(environmentId, '/repo', 'convex.json', '{"nodeVersion":"22"}')

    expect(getOptimisticProjectFileQueryData(environmentId, '/repo', 'convex.json')?.contents).toBe(
      '{"nodeVersion":"22"}',
    )

    expect(
      confirmProjectFileQueryData(environmentId, '/repo', 'convex.json', '{"nodeVersion":"220"}'),
    ).toBe(false)

    expect(resolveProjectFileQueryData(environmentId, '/repo', 'convex.json', initial)).toEqual({
      relativePath: 'convex.json',
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    })

    expect(
      confirmProjectFileQueryData(environmentId, '/repo', 'convex.json', '{"nodeVersion":"22"}'),
    ).toBe(true)
  })

  it('invalidates MDX only when the latest persisted source is confirmed', () =>
  {
    vi.stubGlobal('window', {})
    const refresh = vi.spyOn(appAtomRegistry, 'refresh').mockImplementation(() =>
    {})
    const mdxQueryAtom = getProjectMdxDocumentQueryAtom(environmentId, threadId, 'docs/guide.mdx')
    setProjectFileQueryData(environmentId, '/repo', 'docs/guide.mdx', '# Older')
    setProjectFileQueryData(environmentId, '/repo', 'docs/guide.mdx', '# Latest')

    expect(
      confirmProjectMdxFileQueryData(environmentId, '/repo', threadId, 'docs/guide.mdx', '# Older'),
    ).toBe(false)
    expect(refresh).not.toHaveBeenCalled()

    expect(
      confirmProjectMdxFileQueryData(
        environmentId,
        '/repo',
        threadId,
        'docs/guide.mdx',
        '# Latest',
      ),
    ).toBe(true)
    expect(refresh).toHaveBeenCalledWith(mdxQueryAtom)
  })

  it('releases a confirmed optimistic file only after a newer settled read succeeds', () =>
  {
    const data = {
      relativePath: 'docs/guide.mdx',
      contents: '# Saved',
      byteLength: 7,
      truncated: false,
    } satisfies ProjectReadFileResult
    const confirmedAgainst = AsyncResult.success(data)
    const optimisticFile = { data, confirmedAgainst }

    expect(
      isConfirmedProjectFileQuerySuperseded(
        optimisticFile,
        AsyncResult.success(data, { waiting: true }),
      ),
    ).toBe(false)
    expect(
      isConfirmedProjectFileQuerySuperseded(
        optimisticFile,
        AsyncResult.failure(Cause.fail(new Error('read failed'))),
      ),
    ).toBe(false)
    expect(isConfirmedProjectFileQuerySuperseded(optimisticFile, AsyncResult.success(data))).toBe(
      true,
    )
  })

  it('does not clear a newer optimistic edit while releasing an older confirmation', () =>
  {
    const atom = projectEnvironment.optimisticFile({
      environmentId,
      cwd: '/repo',
      relativePath: 'docs/guide.mdx',
    })
    const confirmedFile = {
      confirmedAgainst: AsyncResult.success(null),
      data: {
        relativePath: 'docs/guide.mdx',
        contents: '# Confirmed',
        byteLength: 11,
        truncated: false,
      },
    }
    appAtomRegistry.set(atom, confirmedFile)
    setProjectFileQueryData(environmentId, '/repo', 'docs/guide.mdx', '# Newer edit')

    expect(
      clearConfirmedProjectFileQueryData(environmentId, '/repo', 'docs/guide.mdx', confirmedFile),
    ).toBe(false)
    expect(
      getOptimisticProjectFileQueryData(environmentId, '/repo', 'docs/guide.mdx')?.contents,
    ).toBe('# Newer edit')

    appAtomRegistry.set(atom, confirmedFile)
    expect(
      clearConfirmedProjectFileQueryData(environmentId, '/repo', 'docs/guide.mdx', confirmedFile),
    ).toBe(true)
    expect(getOptimisticProjectFileQueryData(environmentId, '/repo', 'docs/guide.mdx')).toBeNull()
  })
})
