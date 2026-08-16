// tests/apps/web/browser/browserFaviconStore.test.ts
// verify bounded project-scoped favicon persistence and buffering

import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from '@t3tools/client-runtime/environment'
import { EnvironmentId, ProjectId, ThreadId } from '@t3tools/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('~/state/entities', () => ({ useThreadShell: () => null }))
vi.mock('~/state/session', () => ({ usePreparedConnection: () => ({ _tag: 'None' }) }))

import {
  flushPendingFaviconsForThread,
  lookupFavicon,
  recordFaviconForProject,
  recordFaviconForThread,
  registerFaviconProjectForThread,
  resetBrowserFaviconsForTests,
  resolveBrowserFaviconStorage,
  useBrowserFaviconStore,
} from '../../../../apps/web/src/browser/browserFaviconStore'

const environmentId = EnvironmentId.make('env-1')
const projectRef = scopeProjectRef(environmentId, ProjectId.make('project-1'))
const threadRef = scopeThreadRef(environmentId, ThreadId.make('thread-1'))
const PNG = 'data:image/png;base64,AAAA'
const favicon = (pageUrl: string, capturedAt: number, dataUrl = PNG) => ({
  pageUrl,
  capturedAt,
  dataUrl,
})

describe('browser favicon store', () =>
{
  beforeEach(resetBrowserFaviconsForTests)
  afterEach(() =>
  {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('isolates captures by environment, project, protocol, and port with exact offline aliases', () =>
  {
    const otherEnvironment = scopeProjectRef(
      EnvironmentId.make('env-2'),
      ProjectId.make('project-1'),
    )
    const otherProject = scopeProjectRef(environmentId, ProjectId.make('project-2'))
    recordFaviconForProject(projectRef, favicon('http://192.168.64.2:3000/app', 1), '192.168.64.2')
    recordFaviconForProject(otherEnvironment, favicon('http://localhost:3000/', 2), null)
    recordFaviconForProject(otherProject, favicon('http://localhost:3000/', 3), null)
    recordFaviconForProject(projectRef, favicon('https://localhost:3000/', 4), null)
    recordFaviconForProject(projectRef, favicon('http://localhost:5173/', 5), null)

    const byKey = useBrowserFaviconStore.getState().byKey
    expect(Object.keys(byKey)).toHaveLength(5)
    expect(lookupFavicon(byKey, projectRef, 'http://192.168.64.2:3000/other', null)).toBe(PNG)
    expect(lookupFavicon(byKey, projectRef, 'http://192.168.64.3:3000/', null)).toBeNull()
    expect(lookupFavicon(byKey, projectRef, 'https://192.168.64.2:3000/', null)).toBeNull()
    expect(lookupFavicon(byKey, otherProject, 'http://192.168.64.2:3000/', null)).toBeNull()
  })

  it('bounds transient buffers and flushes pending origins after metadata hydrates', () =>
  {
    for (let thread = 0; thread < 22; thread += 1)
    {
      const currentThreadRef = scopeThreadRef(environmentId, ThreadId.make(`thread-${thread}`))
      for (let port = 3_000; port < 3_012; port += 1)
      {
        recordFaviconForThread(
          currentThreadRef,
          favicon(`http://localhost:${port}/`, port),
          null,
          undefined,
        )
      }
      registerFaviconProjectForThread(currentThreadRef, projectRef)
    }
    for (let thread = 22; thread < 102; thread += 1)
    {
      registerFaviconProjectForThread(
        scopeThreadRef(environmentId, ThreadId.make(`thread-${thread}`)),
        projectRef,
      )
    }

    const buffered = useBrowserFaviconStore.getState()
    expect(Object.keys(buffered.pendingByThreadKey)).toHaveLength(20)
    expect(buffered.pendingByThreadKey['env-1:thread-0']).toBeUndefined()
    expect(buffered.pendingByThreadKey['env-1:thread-1']).toBeUndefined()
    expect(buffered.pendingByThreadKey['env-1:thread-21']).toBeDefined()
    expect(
      Object.values(buffered.pendingByThreadKey).every(
        (byOrigin) => Object.keys(byOrigin).length === 10,
      ),
    ).toBe(true)
    expect(Object.keys(buffered.projectRefByThreadKey)).toHaveLength(100)
    expect(buffered.projectRefByThreadKey['env-1:thread-0']).toBeUndefined()
    expect(buffered.projectRefByThreadKey['env-1:thread-1']).toBeUndefined()
    expect(buffered.projectRefByThreadKey['env-1:thread-101']).toEqual(projectRef)

    recordFaviconForThread(threadRef, favicon('http://localhost:8025/', 20_000), null, undefined)
    expect(flushPendingFaviconsForThread(threadRef, projectRef, '192.168.64.2')).toBe(true)
    expect(
      lookupFavicon(
        useBrowserFaviconStore.getState().byKey,
        projectRef,
        'http://localhost:8025/',
        null,
      ),
    ).toBe(PNG)
  })

  it('keeps its memory shadow authoritative when browser storage fails asymmetrically', () =>
  {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn(() => 'stale'),
        setItem: vi.fn(() =>
        {
          throw new Error('quota exceeded')
        }),
        removeItem: vi.fn(() =>
        {
          throw new Error('remove blocked')
        }),
      },
    })
    const storage = resolveBrowserFaviconStorage()

    storage.setItem('key', 'fresh')
    expect(storage.getItem('key')).toBe('fresh')
    storage.removeItem('key')
    expect(storage.getItem('key')).toBeNull()
  })

  it('rejects cross-environment project association without dropping a pending capture', () =>
  {
    const foreignProjectRef = scopeProjectRef(
      EnvironmentId.make('env-2'),
      ProjectId.make('project-1'),
    )
    const captured = favicon('http://192.168.64.2:3000/', 30_000)

    registerFaviconProjectForThread(threadRef, foreignProjectRef)
    expect(useBrowserFaviconStore.getState().projectRefByThreadKey).toEqual({})
    expect(recordFaviconForThread(threadRef, captured, foreignProjectRef, '192.168.64.2')).toBe(
      false,
    )
    const threadKey = scopedThreadKey(threadRef)
    const pendingBeforeFlush = useBrowserFaviconStore.getState().pendingByThreadKey[threadKey]
    expect(pendingBeforeFlush).toBeDefined()

    expect(flushPendingFaviconsForThread(threadRef, foreignProjectRef, '192.168.64.2')).toBe(false)
    expect(useBrowserFaviconStore.getState().pendingByThreadKey[threadKey]).toBe(pendingBeforeFlush)
    expect(useBrowserFaviconStore.getState().byKey).toEqual({})

    expect(flushPendingFaviconsForThread(threadRef, projectRef, '192.168.64.2')).toBe(true)
    expect(useBrowserFaviconStore.getState().pendingByThreadKey[threadKey]).toBeUndefined()
    expect(
      lookupFavicon(useBrowserFaviconStore.getState().byKey, projectRef, captured.pageUrl, null),
    ).toBe(PNG)
  })
})
