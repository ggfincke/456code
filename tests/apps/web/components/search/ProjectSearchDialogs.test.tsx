// tests/apps/web/components/search/ProjectSearchDialogs.test.tsx
// verify search option controls and keyboard selection reach the existing file navigation action

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vite-plus/test'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'

const mocks = vi.hoisted(() => ({
  openFile: vi.fn(),
  close: vi.fn(),
  contentInput: vi.fn(),
  fileInput: vi.fn(),
}))
vi.mock('../../../../../apps/web/src/hooks/useActiveProjectTarget', () => ({
  useActiveProjectTarget: () => ({
    environmentId: 'remote',
    cwd: '/task-worktree',
    projectName: 'Repo',
    threadRef: { environmentId: 'remote', threadId: 'task' },
  }),
}))
vi.mock('../../../../../apps/web/src/rightPanelStore', () => ({
  useRightPanelStore: { getState: () => ({ openFile: mocks.openFile }) },
}))
vi.mock('../../../../../apps/web/src/state/queries', () => ({
  useProjectFileSearch: (input: unknown) =>
  {
    mocks.fileInput(input)
    return {
      entries: [
        { path: 'src/first.ts', kind: 'file' },
        { path: 'src/second.ts', kind: 'file' },
      ],
      error: null,
      isPending: false,
      truncated: false,
    }
  },
  useProjectContentSearch: (input: unknown) =>
  {
    mocks.contentInput(input)
    return {
      matches: [
        {
          path: 'src/a.ts',
          lineNumber: 3,
          lineContent: '<script> first',
          matchRanges: [{ start: 9, end: 14 }],
        },
        {
          path: 'src/b.ts',
          lineNumber: 42,
          lineContent: 'second result',
          matchRanges: [{ start: 0, end: 6 }],
        },
      ],
      error: null,
      isPending: false,
      hasQuery: true,
      truncated: true,
      regexFallbackError: 'Invalid regular expression; showing literal matches instead.',
    }
  },
}))

import { CommandDialog } from '../../../../../apps/web/src/components/ui/command'
import { ProjectContentSearch } from '../../../../../apps/web/src/components/search/ProjectContentSearch'
import { ProjectFilePicker } from '../../../../../apps/web/src/components/files/ProjectFilePicker'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
let root: Root
let container: HTMLDivElement

beforeEach(() =>
{
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  vi.clearAllMocks()
})
afterEach(() =>
{
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function key(key: string)
{
  await act(async () =>
    document
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
  )
}

it('forwards search flags and opens the keyboard-selected content match at its line', async () =>
{
  await act(async () =>
    root.render(
      <CommandDialog open>
        <ProjectContentSearch onOpenChange={mocks.close} />
      </CommandDialog>,
    ),
  )
  expect(document.body.textContent?.match(/Invalid regular expression/g)).toHaveLength(1)
  expect(document.body.textContent).toContain('showing literal matches instead.')
  expect(document.body.textContent).toContain('Results were limited.')
  expect(document.querySelector('script')).toBeNull()
  await act(async () =>
  {
    document.querySelector<HTMLButtonElement>('[aria-label="Match case"]')!.click()
    document.querySelector<HTMLButtonElement>('[aria-label="Match whole word"]')!.click()
    document.querySelector<HTMLButtonElement>('[aria-label="Use regular expression"]')!.click()
  })
  expect(mocks.contentInput).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cwd: '/task-worktree',
      caseSensitive: true,
      wholeWord: true,
      useRegex: true,
    }),
  )
  await key('ArrowDown')
  await key('Enter')
  expect(mocks.openFile).toHaveBeenCalledWith(
    { environmentId: EnvironmentId.make('remote'), threadId: ThreadId.make('task') },
    'src/b.ts',
    42,
  )
  expect(mocks.close).toHaveBeenCalledWith(false)
})

it('browses without a filename query and opens the selected path without a line override', async () =>
{
  await act(async () =>
    root.render(
      <CommandDialog open>
        <ProjectFilePicker onOpenChange={mocks.close} />
      </CommandDialog>,
    ),
  )
  expect(mocks.fileInput).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: '', cwd: '/task-worktree' }),
  )
  await key('ArrowDown')
  await key('Enter')
  expect(mocks.openFile).toHaveBeenCalledWith(
    { environmentId: EnvironmentId.make('remote'), threadId: ThreadId.make('task') },
    'src/second.ts',
  )
})
