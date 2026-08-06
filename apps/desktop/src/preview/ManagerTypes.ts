// apps/desktop/src/preview/ManagerTypes.ts
// shared preview tab state and manager operation context types

import type {
  DesktopPreviewColorScheme,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingFrame,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
} from '@t3tools/contracts'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import type * as Semaphore from 'effect/Semaphore'

export type PreviewNavStatus =
  | { kind: 'Idle' }
  | { kind: 'Loading'; url: string; title: string }
  | { kind: 'Success'; url: string; title: string }
  | {
      kind: 'LoadFailed'
      url: string
      title: string
      code: number
      description: string
    }

export interface PreviewTabState
{
  tabId: string
  webContentsId: number | null
  navStatus: PreviewNavStatus
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number
  colorScheme: DesktopPreviewColorScheme
  controller: 'human' | 'agent' | 'none'
  updatedAt: string
}

export interface PreviewTabRecord extends PreviewTabState
{
  readonly lifecycleGeneration: number
}

export type Listener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>
export type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>
export type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>

export type PreviewInputSignal =
  | { readonly kind: 'pointer'; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: 'key'; readonly key: string; readonly code: string }

export interface ManagedListeners
{
  readonly scope: Scope.Closeable
}

export interface PickSession
{
  readonly id: string
  readonly cancel: Effect.Effect<void>
}

export interface RecordingOwner
{
  readonly tabId: string
  readonly webContentsId: number
  readonly token: number
}

export type RecordingClaim =
  | { readonly claimed: true; readonly owner: RecordingOwner }
  | { readonly claimed: false; readonly owner: RecordingOwner }

export interface BrowserControlSession
{
  readonly webContentsId: number
  readonly semaphore: Semaphore.Semaphore
  readonly scope: Scope.Closeable
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void
}

export interface BrowserDiagnostics
{
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>
  readonly requests: ReadonlyMap<string, { url: string; method: string }>
}

export interface ExpectedAgentInput
{
  readonly signal: PreviewInputSignal
  readonly expiresAt: number
}

export interface PreviewOperationContext
{
  readonly operation: string
  readonly tabId?: string
  readonly webContentsId?: number
  readonly artifactPath?: string
}

export const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
]

export const DEFAULT_ZOOM_FACTOR = 1.0
export const ZOOM_EPSILON = 0.001
export const MAX_EVALUATION_BYTES = 64_000
export const MAX_VISIBLE_TEXT_LENGTH = 20_000
export const MAX_INTERACTIVE_ELEMENTS = 200
export const MAX_SCREENSHOT_WIDTH = 1280
export const DIAGNOSTIC_BUFFER_LIMIT = 200
export const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80
export const AGENT_CURSOR_MOVE_MS = 160
export const AGENT_CURSOR_CLICK_LEAD_MS = 40
