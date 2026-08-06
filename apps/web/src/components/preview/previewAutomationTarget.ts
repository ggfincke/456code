// apps/web/src/components/preview/previewAutomationTarget.ts
// determine whether preview automation session sync

import type { PreviewSessionSnapshot } from '@t3tools/contracts'

interface PreviewAutomationSessionIndex
{
  readonly snapshot: PreviewSessionSnapshot | null
  readonly sessions: Readonly<Record<string, PreviewSessionSnapshot>>
}

export type PreviewAutomationTargetResolution =
  | {
      readonly kind: 'resolved'
      readonly tabId: string
      readonly snapshot: PreviewSessionSnapshot
    }
  | {
      readonly kind: 'missing-explicit'
      readonly tabId: string
      readonly snapshot: null
    }
  | {
      readonly kind: 'no-current-target'
      readonly tabId: null
      readonly snapshot: null
    }

export type PreviewAutomationOpenTabResolution =
  | { readonly kind: 'reuse'; readonly tabId: string }
  | { readonly kind: 'create'; readonly tabId: null }
  | { readonly kind: 'missing-explicit'; readonly tabId: string }

export function needsPreviewAutomationSessionSync(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
): boolean
{
  return (
    Object.keys(state.sessions).length === 0 ||
    requestedTabId === undefined ||
    state.sessions[requestedTabId] === undefined
  )
}

export function resolvePreviewAutomationTarget(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | null,
): PreviewAutomationTargetResolution
{
  if (requestedTabId !== null)
  {
    const snapshot = state.sessions[requestedTabId]
    return snapshot
      ? { kind: 'resolved', tabId: snapshot.tabId, snapshot }
      : { kind: 'missing-explicit', tabId: requestedTabId, snapshot: null }
  }
  return state.snapshot
    ? { kind: 'resolved', tabId: state.snapshot.tabId, snapshot: state.snapshot }
    : { kind: 'no-current-target', tabId: null, snapshot: null }
}

export function resolvePreviewAutomationOpenTab(
  state: PreviewAutomationSessionIndex,
  requestedTabId: string | undefined,
  reuseExistingTab: boolean,
): PreviewAutomationOpenTabResolution
{
  if (!reuseExistingTab) return { kind: 'create', tabId: null }
  const target = resolvePreviewAutomationTarget(state, requestedTabId ?? null)
  if (target.kind === 'resolved')
  {
    return { kind: 'reuse', tabId: target.tabId }
  }
  return target.kind === 'missing-explicit' ? target : { kind: 'create', tabId: null }
}
