// tests/apps/web/state/projectSearch.test.tsx
// verify web search debounce bounds and suppression of stale response data

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EnvironmentId } from '@t3tools/contracts'
import { beforeEach, afterEach, expect, it, vi } from 'vite-plus/test'

const mocks = vi.hoisted(() => ({
  searchEntries: vi.fn((input: unknown) => input),
  searchContents: vi.fn((input: unknown) => input),
  pending: false,
  data: {
    entries: [
      { path: 'old.ts', kind: 'file' },
      { path: 'folder', kind: 'directory' },
    ],
    matches: [{ path: 'old.ts', lineNumber: 4, lineContent: 'old', matchRanges: [] }],
    truncated: false,
    regexFallbackError: undefined as string | undefined,
  },
}))
vi.mock('../../../../apps/web/src/state/projects', () => ({
  projectEnvironment: { searchEntries: mocks.searchEntries, searchContents: mocks.searchContents },
}))
vi.mock('../../../../apps/web/src/state/query', () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : mocks.data,
    error: null,
    isPending: atom !== null && mocks.pending,
  }),
}))
vi.mock('../../../../apps/web/src/state/presentation', () => ({
  environmentPresentations: {},
}))
vi.mock('../../../../apps/web/src/state/orchestration', () => ({ orchestrationEnvironment: {} }))
vi.mock('../../../../apps/web/src/state/threads', () => ({ useEnvironmentThread: vi.fn() }))
vi.mock('../../../../apps/web/src/state/vcs', () => ({ vcsEnvironment: {} }))

import {
  useProjectContentSearch,
  useProjectFileSearch,
} from '../../../../apps/web/src/state/queries'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const environmentId = EnvironmentId.make('remote')
let root: Root
let container: HTMLDivElement
let content: ReturnType<typeof useProjectContentSearch>
let files: ReturnType<typeof useProjectFileSearch>

function Probe({ query, mode }: { query: string; mode: 'files' | 'content' })
{
  const fileResult = useProjectFileSearch({ environmentId, cwd: '/task-worktree', query })
  const contentResult = useProjectContentSearch({
    environmentId,
    cwd: '/task-worktree',
    query: mode === 'content' ? query : '',
    caseSensitive: true,
    wholeWord: true,
    useRegex: true,
  })
  files = fileResult
  content = contentResult
  return null
}

beforeEach(() =>
{
  vi.useFakeTimers()
  mocks.pending = false
  mocks.searchEntries.mockClear()
  mocks.searchContents.mockClear()
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() =>
{
  act(() => root.unmount())
  vi.useRealTimers()
})

it('browses empty filenames with file-only bounded requests and suppresses debouncing or pending rows', () =>
{
  act(() => root.render(<Probe query="" mode="files" />))
  expect(mocks.searchEntries).toHaveBeenLastCalledWith({
    environmentId,
    input: { cwd: '/task-worktree', query: '', kind: 'file', limit: 200 },
  })
  expect(mocks.searchContents).not.toHaveBeenCalled()
  expect(files.entries).toEqual([{ path: 'old.ts', kind: 'file' }])
  act(() => root.render(<Probe query="new" mode="files" />))
  expect(files.entries).toEqual([])
  mocks.pending = true
  act(() => vi.advanceTimersByTime(200))
  expect(files.entries).toEqual([])
  expect(files.isPending).toBe(true)
})

it('preserves whitespace and flags, bounds input, and hides old content matches until a new request settles', () =>
{
  act(() => root.render(<Probe query=" old " mode="content" />))
  expect(mocks.searchContents).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      cwd: '/task-worktree',
      query: ' old ',
      caseSensitive: true,
      wholeWord: true,
      useRegex: true,
      limit: 500,
    },
  })
  expect(content.matches).toHaveLength(1)
  act(() => root.render(<Probe query="new" mode="content" />))
  expect(content.matches).toEqual([])
  expect(content.isPending).toBe(true)
  mocks.pending = true
  act(() => vi.advanceTimersByTime(200))
  expect(content.matches).toEqual([])
  mocks.searchContents.mockClear()
  act(() => root.render(<Probe query={'x'.repeat(257)} mode="content" />))
  act(() => vi.advanceTimersByTime(200))
  expect(mocks.searchContents).not.toHaveBeenCalled()
  expect(content.error).toContain('256')
  expect(content.matches).toEqual([])
})
