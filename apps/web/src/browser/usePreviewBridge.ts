// apps/web/src/browser/usePreviewBridge.ts
// synchronize desktop preview bridge state through a React hook

'use client'

import type {
  DesktopPreviewTabState,
  PreviewReportStatusInput,
  ScopedThreadRef,
  ThreadId,
} from '@t3tools/contracts'
import { parseScopedThreadKey, scopedThreadKey } from '@t3tools/client-runtime/environment'
import * as Option from 'effect/Option'
import { useEffect, useEffectEvent, useMemo, useRef } from 'react'

import { previewEnvironment } from '~/state/preview'
import { usePreparedConnection } from '~/state/session'
import { useAtomCommand } from '~/state/use-atom-command'

import {
  flushPendingFaviconsForThread,
  recordFaviconForThread,
  useFaviconProjectRefForThread,
} from './browserFaviconStore'
import { useBrowserPointerStore } from './browserPointerStore'
import { previewBridge } from './previewBridge'
import { applyPreviewDesktopState, type DesktopPreviewOverlay } from './previewStateStore'

// mirrors low-latency desktop state into the store and reflects navigation
// events back to the server. Webview lifetime is owned by ElectronBrowserHost.
export function usePreviewBridge(input: {
  threadRef: ScopedThreadRef
  tabId: string
  runtimeTabId: string
}): void
{
  const { threadRef, tabId, runtimeTabId } = input
  const clearBrowserPointer = useBrowserPointerStore((state) => state.clear)
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, 'preview status report')
  const bridge = previewBridge
  const threadKey = scopedThreadKey(threadRef)
  const stableThreadRef = useMemo(() =>
  {
    const parsed = parseScopedThreadKey(threadKey)
    if (!parsed) throw new Error(`Invalid scoped thread key: ${threadKey}`)
    return parsed
  }, [threadKey])
  const { environmentId, threadId } = stableThreadRef
  const projectRef = useFaviconProjectRefForThread(stableThreadRef)
  const preparedConnection = usePreparedConnection(environmentId)
  const environmentHostname = Option.isSome(preparedConnection)
    ? new URL(preparedConnection.value.httpBaseUrl).hostname
    : undefined

  // one bridge subscription does both jobs (mirror state + forward to
  // server) so the desktop bridge keeps a single listener entry per tab.
  const lastReportedUrl = useRef<string | null>(null)
  const lastReportedKind = useRef<DesktopPreviewTabState['navStatus']['kind'] | null>(null)
  const lastReportedTitle = useRef<string | null>(null)
  const lastReportedCanGoBack = useRef<boolean | null>(null)
  const lastReportedCanGoForward = useRef<boolean | null>(null)
  const lastDesktopNavStatus = useRef<DesktopPreviewTabState['navStatus'] | null>(null)
  const handleStateChange = useEffectEvent(
    (changedTabId: string, state: DesktopPreviewTabState): void =>
    {
      if (changedTabId !== runtimeTabId) return
      if (shouldClearBrowserPointer(lastDesktopNavStatus.current, state.navStatus))
      {
        clearBrowserPointer(runtimeTabId)
      }
      lastDesktopNavStatus.current = state.navStatus
      applyPreviewDesktopState(stableThreadRef, tabId, projectDesktopState(state))
      if (state.favicon)
      {
        recordFaviconForThread(stableThreadRef, state.favicon, projectRef, environmentHostname)
      }
      const reported = buildReportInput({
        threadId,
        tabId,
        state,
        lastReportedUrl: lastReportedUrl.current,
        lastReportedKind: lastReportedKind.current,
        lastReportedTitle: lastReportedTitle.current,
        lastReportedCanGoBack: lastReportedCanGoBack.current,
        lastReportedCanGoForward: lastReportedCanGoForward.current,
      })
      if (!reported) return
      lastReportedUrl.current = reported.lastReportedUrl
      lastReportedKind.current = reported.lastReportedKind
      lastReportedTitle.current = reported.lastReportedTitle
      lastReportedCanGoBack.current = reported.lastReportedCanGoBack
      lastReportedCanGoForward.current = reported.lastReportedCanGoForward
      void reportStatus({
        environmentId,
        input: reported.input,
      })
    },
  )
  useEffect(() =>
  {
    if (!bridge || typeof window === 'undefined') return
    lastReportedUrl.current = null
    lastReportedKind.current = null
    lastReportedTitle.current = null
    lastReportedCanGoBack.current = null
    lastReportedCanGoForward.current = null
    lastDesktopNavStatus.current = null
    return bridge.onStateChange(handleStateChange)
  }, [bridge, runtimeTabId, stableThreadRef, tabId])
  useEffect(() =>
  {
    if (!projectRef) return
    flushPendingFaviconsForThread(stableThreadRef, projectRef, environmentHostname)
  }, [environmentHostname, projectRef, stableThreadRef])
}

function shouldClearBrowserPointer(
  previous: DesktopPreviewTabState['navStatus'] | null,
  current: DesktopPreviewTabState['navStatus'],
): boolean
{
  if (!previous) return false
  if (current.kind === 'Loading' && previous.kind !== 'Loading') return true
  if (current.kind === 'Idle' || previous.kind === 'Idle') return false
  return current.url !== previous.url
}

const originOf = (url: string): string | null =>
{
  try
  {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  }
  catch
  {
    return null
  }
}

export function projectDesktopState(state: DesktopPreviewTabState): DesktopPreviewOverlay
{
  const navOrigin = state.navStatus.kind === 'Idle' ? null : originOf(state.navStatus.url)
  return {
    hasWebContents: state.webContentsId !== null,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.navStatus.kind === 'Loading',
    zoomFactor: state.zoomFactor,
    colorScheme: state.colorScheme,
    audioMuted: state.audioMuted,
    audible: state.audible,
    controller: state.controller,
    favicon:
      navOrigin !== null && state.favicon && originOf(state.favicon.pageUrl) === navOrigin
        ? state.favicon
        : null,
  }
}

// decide whether a state change warrants an RPC to the server, and shape
// the report payload.
//
// - Idle never reports — the tab is post-close or pre-load and the server
//   already knows the canonical state from `open` / `closed`.
// - We dedupe identical navigation, title, and history state.
// - LoadFailed always reports (the server uses it to emit `failed`).
function buildReportInput(args: {
  readonly threadId: ThreadId
  readonly tabId: string
  readonly state: DesktopPreviewTabState
  readonly lastReportedUrl: string | null
  readonly lastReportedKind: DesktopPreviewTabState['navStatus']['kind'] | null
  readonly lastReportedTitle: string | null
  readonly lastReportedCanGoBack: boolean | null
  readonly lastReportedCanGoForward: boolean | null
}): {
  readonly input: PreviewReportStatusInput
  readonly lastReportedUrl: string
  readonly lastReportedKind: DesktopPreviewTabState['navStatus']['kind']
  readonly lastReportedTitle: string
  readonly lastReportedCanGoBack: boolean
  readonly lastReportedCanGoForward: boolean
} | null
{
  const {
    threadId,
    tabId,
    state,
    lastReportedUrl,
    lastReportedKind,
    lastReportedTitle,
    lastReportedCanGoBack,
    lastReportedCanGoForward,
  } = args
  const status = state.navStatus
  if (status.kind === 'Idle') return null

  // skip if we've already reported the same kind+url. LoadFailed always
  // reports (rapid duplicate failures are unusual and worth surfacing).
  const sameAsLast =
    status.kind !== 'LoadFailed' &&
    status.kind === lastReportedKind &&
    status.url === lastReportedUrl &&
    status.title === lastReportedTitle &&
    state.canGoBack === lastReportedCanGoBack &&
    state.canGoForward === lastReportedCanGoForward
  if (sameAsLast) return null

  const base = {
    threadId,
    tabId,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
  }
  if (status.kind === 'LoadFailed')
  {
    return {
      input: {
        ...base,
        navStatus: {
          _tag: 'LoadFailed',
          url: status.url,
          title: status.title,
          code: status.code,
          description: status.description,
        },
      },
      lastReportedUrl: status.url,
      lastReportedKind: 'LoadFailed',
      lastReportedTitle: status.title,
      lastReportedCanGoBack: state.canGoBack,
      lastReportedCanGoForward: state.canGoForward,
    }
  }
  return {
    input: {
      ...base,
      navStatus: { _tag: status.kind, url: status.url, title: status.title },
    },
    lastReportedUrl: status.url,
    lastReportedKind: status.kind,
    lastReportedTitle: status.title,
    lastReportedCanGoBack: state.canGoBack,
    lastReportedCanGoForward: state.canGoForward,
  }
}
