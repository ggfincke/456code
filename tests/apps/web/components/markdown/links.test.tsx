// tests/apps/web/components/markdown/links.test.tsx
// verify mounted markdown file-link routing and lookup races

// @vitest-environment happy-dom

import { scopeThreadRef } from '@t3tools/client-runtime/environment'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { AsyncResult } from 'effect/unstable/reactivity'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  resolveWorkspaceFileActionTarget,
  type WorkspaceEntryCandidate,
  type WorkspaceFileActionSource,
} from '../../../../../apps/web/src/lib/workspaceBasenameLookup'

vi.mock('../../../../../apps/web/src/components/ui/tooltip', () => ({
  Tooltip: (props: { readonly children: ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { readonly render: ReactNode }) => props.render,
  TooltipPopup: (props: { readonly children: ReactNode }) => <span>{props.children}</span>,
}))
vi.mock('../../../../../apps/web/src/components/chat/FileTagChip', () => ({
  CHAT_FILE_TAG_CHIP_CLASS_NAME: 'file-chip',
  FileTagChipContent: (props: { readonly label: string }) => <span>{props.label}</span>,
}))
vi.mock('../../../../../apps/web/src/components/ui/toast', () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}))
vi.mock('../../../../../apps/web/src/browser/openFileInPreview', () => ({
  isBrowserPreviewFile: (path: string) => /\.(?:html?|pdf)$/i.test(path),
}))

import {
  extractMarkdownLinkHrefs,
  MarkdownExternalLinkContent,
  MarkdownFileLink,
} from '../../../../../apps/web/src/components/markdown/links'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make('environment-markdown-links'),
  ThreadId.make('thread-markdown-links'),
)

function deferred<T>()
{
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) =>
  {
    resolve = complete
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void>
{
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('MarkdownExternalLinkContent', () =>
{
  it('omits private favicon requests and retries public icons after a host failure or change', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const render = async (host: string) =>
    {
      await act(async () =>
      {
        root.render(
          <MarkdownExternalLinkContent host={host} plainText="Link">
            Link
          </MarkdownExternalLinkContent>,
        )
      })
    }

    try
    {
      await render('favicon-one.example.org')
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://www.google.com/s2/favicons?domain=favicon-one.example.org&sz=32',
      )

      await act(async () =>
      {
        container.querySelector('img')?.dispatchEvent(new Event('error', { bubbles: true }))
      })
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('svg')).not.toBeNull()

      await render('localhost')
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('svg')).not.toBeNull()

      await render('favicon-two.example.org')
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://www.google.com/s2/favicons?domain=favicon-two.example.org&sz=32',
      )
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})

describe('MarkdownFileLink', () =>
{
  it('extracts angle-bracketed markdown destinations containing spaces', () =>
  {
    expect(extractMarkdownLinkHrefs('[notes](<docs/Release Notes.md>)')).toEqual([
      'docs/Release Notes.md',
    ])
  })

  it('routes source files to the panel and preserves the editor modifier', async () =>
  {
    const platform = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const openInBrowser = vi.fn(async () => AsyncResult.success(undefined))
    const openInEditor = vi.fn(async () => AsyncResult.success(undefined))
    const openInPanel = vi.fn()
    const resolveTarget = vi.fn(async () => ({
      filePath: '/repo/src/My File.ts',
      targetPath: '/repo/src/My File.ts:10',
      workspaceRelativePath: 'src/My File.ts',
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try
    {
      await act(async () =>
      {
        root.render(
          <MarkdownFileLink
            href="/repo/src/My File.ts:10"
            filePath="/repo/src/My File.ts"
            targetPath="/repo/src/My File.ts:10"
            iconPath="/repo/src/My File.ts"
            displayPath="src/My File.ts:10"
            workspaceRelativePath="src/My File.ts"
            line={10}
            label="My File.ts"
            copyMarkdown="[My File.ts](<src/My File.ts:10>)"
            theme="dark"
            threadRef={THREAD_REF}
            onOpen={openInEditor}
            onResolveTarget={resolveTarget}
            onOpenInPanel={openInPanel}
            onOpenInBrowser={openInBrowser}
          />,
        )
      })
      const link = container.querySelector<HTMLAnchorElement>('a')
      expect(link).not.toBeNull()

      await act(async () =>
      {
        link?.click()
        await flushMicrotasks()
      })
      expect(openInPanel).toHaveBeenCalledWith('src/My File.ts', 10)
      expect(openInBrowser).not.toHaveBeenCalled()
      expect(openInEditor).not.toHaveBeenCalled()

      await act(async () =>
      {
        link?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
        await flushMicrotasks()
      })
      expect(openInEditor).toHaveBeenCalledWith('/repo/src/My File.ts:10')
      expect(openInPanel).toHaveBeenCalledTimes(1)
      expect(openInBrowser).not.toHaveBeenCalled()
    }
    finally
    {
      platform.mockRestore()
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('awaits bare preview resolution and prevents an older click from winning', async () =>
  {
    const firstSearch = deferred<ReadonlyArray<WorkspaceEntryCandidate>>()
    const openInBrowser = vi.fn(async () => AsyncResult.success(undefined))
    const openInEditor = vi.fn(async () => AsyncResult.success(undefined))
    const openInPanel = vi.fn()
    const resolveTarget = (source: WorkspaceFileActionSource) =>
      resolveWorkspaceFileActionTarget({
        source,
        cwd: '/repo',
        searchEntries: (basename) =>
          basename === 'index.html'
            ? firstSearch.promise
            : Promise.resolve([{ path: 'docs/report.pdf', kind: 'file' as const }]),
      })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try
    {
      await act(async () =>
      {
        root.render(
          <>
            <MarkdownFileLink
              href="/repo/index.html"
              filePath="/repo/index.html"
              targetPath="/repo/index.html"
              iconPath="/repo/index.html"
              displayPath="index.html"
              workspaceRelativePath="index.html"
              label="index.html"
              copyMarkdown="[index.html](index.html)"
              theme="dark"
              threadRef={THREAD_REF}
              onOpen={openInEditor}
              onResolveTarget={resolveTarget}
              onOpenInPanel={openInPanel}
              onOpenInBrowser={openInBrowser}
            />
            <MarkdownFileLink
              href="/repo/report.pdf"
              filePath="/repo/report.pdf"
              targetPath="/repo/report.pdf"
              iconPath="/repo/report.pdf"
              displayPath="report.pdf"
              workspaceRelativePath="report.pdf"
              label="report.pdf"
              copyMarkdown="[report.pdf](report.pdf)"
              theme="dark"
              threadRef={THREAD_REF}
              onOpen={openInEditor}
              onResolveTarget={resolveTarget}
              onOpenInPanel={openInPanel}
              onOpenInBrowser={openInBrowser}
            />
          </>,
        )
      })
      const links = container.querySelectorAll<HTMLAnchorElement>('a')

      act(() => links[0]?.click())
      await flushMicrotasks()
      expect(openInBrowser).not.toHaveBeenCalled()

      await act(async () =>
      {
        links[1]?.click()
        await flushMicrotasks()
      })
      expect(openInBrowser).toHaveBeenCalledTimes(1)
      expect(openInBrowser).toHaveBeenCalledWith('/repo/docs/report.pdf')

      await act(async () =>
      {
        firstSearch.resolve([{ path: 'stale/index.html', kind: 'file' }])
        await flushMicrotasks()
      })
      expect(openInBrowser).toHaveBeenCalledTimes(1)
      expect(openInPanel).not.toHaveBeenCalled()
      expect(openInEditor).not.toHaveBeenCalled()
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
