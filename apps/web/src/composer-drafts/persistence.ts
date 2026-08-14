// apps/web/src/composer-drafts/persistence.ts
// defines composer draft schemas, migrations, and hydration
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from '@t3tools/client-runtime/environment'
import {
  type CollaborationMode,
  type EnvironmentId,
  ModelSelection,
  type PreviewAnnotationPayload,
  PreviewAnnotationPayloadSchema,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
  toWireInteractionMode,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { DeepMutable } from 'effect/Types'
import { getLocalStorageItem } from '../hooks/useLocalStorage'
import { type ElementContextDraft } from '../lib/elementContext'
import { createDebouncedStorage, createMemoryStorage } from '../lib/storage'
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from '../lib/terminalContext'
import { type ReviewCommentContext, ReviewCommentContextSchema } from '../reviewCommentContext'
import {
  type ChatImageAttachment,
  DEFAULT_COLLABORATION_MODE,
  DEFAULT_RUNTIME_MODE,
} from '../types'

import {
  EMPTY_MODEL_SELECTION_BY_PROVIDER,
  compactModelSelectionByProvider,
  isRuntimeMode,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizePersistedCollaborationMode,
  normalizeProviderInstanceId,
  normalizeProviderModelOptions,
} from './model-selection'
import { type ComposerDraftStoreState } from './runtime'

const isPreviewAnnotationPayload = Schema.is(PreviewAnnotationPayloadSchema)

export const isReviewCommentContext = Schema.is(ReviewCommentContextSchema)

export const COMPOSER_DRAFT_STORAGE_KEY = '456code:composer-drafts:v1'

export const COMPOSER_DRAFT_STORAGE_VERSION = 10

const DraftThreadEnvModeSchema = Schema.Literals(['local', 'worktree'])

export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type

export const DraftId = Schema.String.pipe(Schema.brand('DraftId'))

export type DraftId = typeof DraftId.Type

const COMPOSER_PERSIST_DEBOUNCE_MS = 300

export const composerDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage(),
  COMPOSER_PERSIST_DEBOUNCE_MS,
)

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
})

export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, 'previewUrl'>
{
  previewUrl: string
  file: File
}

const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
})

type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type

const PersistedElementContextStackFrame = Schema.Struct({
  functionName: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  lineNumber: Schema.NullOr(Schema.Number),
  columnNumber: Schema.NullOr(Schema.Number),
})

const PersistedElementContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  pickedAt: Schema.String,
  pageUrl: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  tagName: Schema.String,
  selector: Schema.NullOr(Schema.String),
  htmlPreview: Schema.String,
  componentName: Schema.NullOr(Schema.String),
  source: Schema.NullOr(PersistedElementContextStackFrame),
  styles: Schema.String,
})

type PersistedElementContextDraft = typeof PersistedElementContextDraft.Type

const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  elementContexts: Schema.optionalKey(Schema.Array(PersistedElementContextDraft)),
  previewAnnotations: Schema.optionalKey(Schema.Array(PreviewAnnotationPayloadSchema)),
  reviewComments: Schema.optionalKey(Schema.Array(ReviewCommentContextSchema)),
  // keyed by `ProviderInstanceId` (open branded slug) so custom provider
  // instances (e.g. `codex_personal`) round-trip alongside the built-in
  // `codex` / `claudeAgent` / ... entries. Every prior `ProviderDriverKind`
  // literal satisfies the `ProviderInstanceId` slug pattern, so existing
  // persisted drafts decode unchanged.
  //
  // the record's value schema is NOT wrapped in `Schema.optionalKey`:
  // that helper is only meaningful on property signatures with a known
  // key set, and `Schema.Record(<branded string>, …)` produces an index
  // signature at runtime (Schema rejects the combination). Absence of
  // an entry already encodes "no selection for this instance".
  modelSelectionByProvider: Schema.optionalKey(Schema.Record(ProviderInstanceId, ModelSelection)),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  orchestrate: Schema.optionalKey(Schema.Boolean),
  orchestrateMode: Schema.optionalKey(
    Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ),
})

type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type

// per-provider record of generic option selections. Used as a transient
// representation when migrating legacy v2 storage payloads and when
// deriving per-provider option bundles for downstream consumers.
export type ProviderOptionSelectionsByProvider = Partial<
  Record<string, ReadonlyArray<ProviderOptionSelection>>
>

export type LegacyCodexFields = {
  effort?: unknown
  codexFastMode?: unknown
  serviceTier?: unknown
}

type LegacyThreadModelFields = {
  provider?: unknown
  model?: unknown
  modelOptions?: unknown
}

type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null
  modelOptions?: unknown
}

type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields

type LegacyStickyModelFields = {
  stickyProvider?: unknown
  stickyModel?: unknown
  stickyModelOptions?: unknown
}

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null
  stickyModelOptions?: unknown
  projectDraftThreadIdByProjectId?: Record<string, string> | null
  draftsByThreadId?: Record<string, PersistedComposerThreadDraftState> | null
  draftThreadsByThreadId?: Record<string, PersistedDraftThreadState> | null
  projectDraftThreadIdByProjectKey?: Record<string, string> | null
  draftsByThreadKey?: Record<string, PersistedComposerThreadDraftState> | null
  draftThreadsByThreadKey?: Record<string, PersistedDraftThreadState> | null
  projectDraftThreadKeyByProjectKey?: Record<string, string> | null
  logicalProjectDraftThreadKeyByLogicalProjectKey?: Record<string, string> | null
}

type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields

const PersistedDraftThreadState = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.String,
  projectId: ProjectId,
  logicalProjectKey: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  orchestrate: Schema.optionalKey(Schema.Boolean),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
  startFromOrigin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  promotedTo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        environmentId: Schema.String,
        threadId: Schema.String,
      }),
    ),
  ),
})

type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadKey: Schema.Record(Schema.String, PersistedComposerThreadDraftState),
  draftThreadsByThreadKey: Schema.Record(Schema.String, PersistedDraftThreadState),
  logicalProjectDraftThreadKeyByLogicalProjectKey: Schema.Record(Schema.String, Schema.String),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ModelSelection),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
})

type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type

const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
})

/**
 * Composer content keyed by either a draft session (`DraftId`) or a real server
 * thread (`ScopedThreadRef`). This is the editable payload shown in the composer.
 */
export interface ComposerThreadDraftState
{
  prompt: string
  images: ComposerImageAttachment[]
  nonPersistedImageIds: string[]
  persistedAttachments: PersistedComposerImageAttachment[]
  terminalContexts: TerminalContextDraft[]
  // element-pick attachments captured from the in-app preview browser. The
  // full payload (selector / html / styles / source frame) is persisted
  // inline because — unlike terminal contexts — there's no live session to
  // re-derive the snapshot from on reload.
  elementContexts: ElementContextDraft[]
  previewAnnotations: PreviewAnnotationPayload[]
  reviewComments: ReviewCommentContext[]
  // per-instance model selection. Keyed by `ProviderInstanceId` (open
  // branded slug) so a default `codex` instance and a user-authored
  // `codex_personal` instance each persist their own selected model. Every
  // historical `ProviderDriverKind` literal (`codex` / `claudeAgent` / `cursor` /
  // `opencode`) also satisfies the `ProviderInstanceId` slug pattern, so
  // legacy kind-keyed drafts round-trip unchanged.
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>
  // routing key of the last picked instance (see `modelSelectionByProvider`).
  activeProvider: ProviderInstanceId | null
  runtimeMode: RuntimeMode | null
  collaborationMode: CollaborationMode | null
}

/**
 * Mutable routing and execution context for a pre-thread draft session.
 *
 * Unlike a real server thread, a draft session can still change target
 * environment/worktree configuration before the first send.
 */
export interface DraftSessionState
{
  threadId: ThreadId
  environmentId: EnvironmentId
  projectId: ProjectId
  logicalProjectKey: string
  createdAt: string
  runtimeMode: RuntimeMode
  collaborationMode: CollaborationMode
  branch: string | null
  worktreePath: string | null
  envMode: DraftThreadEnvMode
  startFromOrigin: boolean
  promotedTo?: ScopedThreadRef | null
}

export type DraftThreadState = DraftSessionState

/**
 * Draft session metadata paired with its stable draft-session identity.
 */
export interface ProjectDraftSession extends DraftSessionState
{
  draftId: DraftId
}

// app-facing composer identity:
// - `DraftId` for pre-thread draft sessions
// - `ScopedThreadRef` for server-backed threads
//
// raw `ThreadId` is intentionally excluded so callers cannot drop environment
// identity for real threads.
export type ComposerThreadTarget = ScopedThreadRef | DraftId

const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
})

const EMPTY_IMAGES: ComposerImageAttachment[] = []

const EMPTY_IDS: string[] = []

const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = []

const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = []

const EMPTY_ELEMENT_CONTEXTS: ElementContextDraft[] = []

const EMPTY_PREVIEW_ANNOTATIONS: PreviewAnnotationPayload[] = []

const EMPTY_REVIEW_COMMENTS: ReviewCommentContext[] = []

export const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: '',
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  elementContexts: EMPTY_ELEMENT_CONTEXTS,
  previewAnnotations: EMPTY_PREVIEW_ANNOTATIONS,
  reviewComments: EMPTY_REVIEW_COMMENTS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  collaborationMode: null,
})

// canonical factory for a blank `ComposerThreadDraftState`. Exported so tests
// (and any other call sites) can build a draft without re-declaring every
// slice — adding a new field to the interface (e.g. `elementContexts`) only
// has to be reflected here, not in every stub.
export function createEmptyThreadDraft(): ComposerThreadDraftState
{
  return {
    prompt: '',
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    collaborationMode: null,
  }
}

export function composerImageDedupKey(image: ComposerImageAttachment): string
{
  // keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`
}

export function terminalContextDedupKey(context: TerminalContextDraft): string
{
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`
}

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null
{
  const terminalId = context.terminalId.trim()
  const terminalLabel = context.terminalLabel.trim()
  if (terminalId.length === 0 || terminalLabel.length === 0)
  {
    return null
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart))
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd))
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  }
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[]
{
  const existingIds = new Set<string>()
  const existingDedupKeys = new Set<string>()
  const normalizedContexts: TerminalContextDraft[] = []

  for (const context of contexts)
  {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context)
    if (!normalizedContext)
    {
      continue
    }
    const dedupKey = terminalContextDedupKey(normalizedContext)
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey))
    {
      continue
    }
    normalizedContexts.push(normalizedContext)
    existingIds.add(normalizedContext.id)
    existingDedupKeys.add(dedupKey)
  }

  return normalizedContexts
}

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean
{
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.elementContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    draft.reviewComments.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.collaborationMode === null
  )
}

export function revokeObjectPreviewUrl(previewUrl: string): void
{
  if (typeof URL === 'undefined')
  {
    return
  }
  if (!previewUrl.startsWith('blob:'))
  {
    return
  }
  URL.revokeObjectURL(previewUrl)
}

export function revokeDraftThreadPreviewUrls(draft: ComposerThreadDraftState | undefined): void
{
  if (!draft)
  {
    return
  }
  for (const image of draft.images)
  {
    revokeObjectPreviewUrl(image.previewUrl)
  }
}

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null
{
  if (!value || typeof value !== 'object')
  {
    return null
  }
  const candidate = value as Record<string, unknown>
  const id = candidate.id
  const name = candidate.name
  const mimeType = candidate.mimeType
  const sizeBytes = candidate.sizeBytes
  const dataUrl = candidate.dataUrl
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof mimeType !== 'string' ||
    typeof sizeBytes !== 'number' ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== 'string' ||
    id.length === 0 ||
    dataUrl.length === 0
  )
  {
    return null
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  }
}

function normalizePersistedElementContextDraft(
  value: unknown,
): PersistedElementContextDraft | null
{
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const id = candidate.id
  const threadId = candidate.threadId
  const pickedAt = candidate.pickedAt
  const pageUrl = candidate.pageUrl
  const tagName = candidate.tagName
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof threadId !== 'string' ||
    threadId.length === 0 ||
    typeof pickedAt !== 'string' ||
    pickedAt.length === 0 ||
    typeof pageUrl !== 'string' ||
    pageUrl.length === 0 ||
    typeof tagName !== 'string' ||
    tagName.length === 0
  )
  {
    return null
  }
  const sourceCandidate = candidate.source
  let source: PersistedElementContextDraft['source'] = null
  if (sourceCandidate && typeof sourceCandidate === 'object')
  {
    const sourceRecord = sourceCandidate as Record<string, unknown>
    source = {
      functionName:
        typeof sourceRecord.functionName === 'string' ? sourceRecord.functionName : null,
      fileName: typeof sourceRecord.fileName === 'string' ? sourceRecord.fileName : null,
      lineNumber:
        typeof sourceRecord.lineNumber === 'number' && Number.isFinite(sourceRecord.lineNumber)
          ? sourceRecord.lineNumber
          : null,
      columnNumber:
        typeof sourceRecord.columnNumber === 'number' && Number.isFinite(sourceRecord.columnNumber)
          ? sourceRecord.columnNumber
          : null,
    }
  }
  return {
    id,
    threadId: threadId as ThreadId,
    pickedAt,
    pageUrl,
    pageTitle: typeof candidate.pageTitle === 'string' ? candidate.pageTitle : null,
    tagName,
    selector: typeof candidate.selector === 'string' ? candidate.selector : null,
    htmlPreview: typeof candidate.htmlPreview === 'string' ? candidate.htmlPreview : '',
    componentName: typeof candidate.componentName === 'string' ? candidate.componentName : null,
    source,
    styles: typeof candidate.styles === 'string' ? candidate.styles : '',
  }
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null
{
  if (!value || typeof value !== 'object')
  {
    return null
  }
  const candidate = value as Record<string, unknown>
  const id = candidate.id
  const threadId = candidate.threadId
  const createdAt = candidate.createdAt
  const lineStart = candidate.lineStart
  const lineEnd = candidate.lineEnd
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof threadId !== 'string' ||
    threadId.length === 0 ||
    typeof createdAt !== 'string' ||
    createdAt.length === 0 ||
    typeof lineStart !== 'number' ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== 'number' ||
    !Number.isFinite(lineEnd)
  )
  {
    return null
  }
  const terminalId = typeof candidate.terminalId === 'string' ? candidate.terminalId.trim() : ''
  const terminalLabel =
    typeof candidate.terminalLabel === 'string' ? candidate.terminalLabel.trim() : ''
  if (terminalId.length === 0 || terminalLabel.length === 0)
  {
    return null
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart))
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd))
  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  }
}

function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode
{
  if (value === 'local' || value === 'worktree')
  {
    return value
  }
  return fallbackWorktreePath ? 'worktree' : 'local'
}

export function projectDraftKey(projectRef: ScopedProjectRef): string
{
  return scopedProjectKey(projectRef)
}

export function logicalProjectDraftKey(logicalProjectKey: string): string
{
  return logicalProjectKey.trim()
}

// runtime composer storage key for app-facing identities only.
//
// draft sessions are keyed by `DraftId`. Real threads are keyed by
// `ScopedThreadRef` so environment identity is always preserved.
function composerTargetKey(target: ScopedThreadRef | DraftId): string
{
  if (typeof target === 'string')
  {
    return target.trim()
  }
  return scopedThreadKey(target)
}

// legacy persisted data may still be keyed by a raw `ThreadId`. This helper is
// intentionally migration-only so live code cannot accidentally accept that
// incomplete identity.
function normalizeLegacyComposerStorageKey(
  threadKeyOrId: string,
  options?: {
    environmentId?: EnvironmentId
  },
): string
{
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId)
  if (parsedThreadRef)
  {
    return composerTargetKey(parsedThreadRef)
  }
  if (options?.environmentId)
  {
    return composerTargetKey(scopeThreadRef(options.environmentId, threadKeyOrId as ThreadId))
  }
  return threadKeyOrId
}

function composerThreadRefFromKey(threadKey: string): ScopedThreadRef | null
{
  return parseScopedThreadKey(threadKey)
}

type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  'draftsByThreadKey' | 'draftThreadsByThreadKey'
>

function normalizeComposerTarget(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ComposerThreadTarget | null
{
  if (typeof target === 'string')
  {
    const draftId = target.trim()
    return draftId.length > 0 ? DraftId.make(draftId) : null
  }
  return target
}

export function resolveComposerDraftKey(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): string | null
{
  const normalizedTarget = normalizeComposerTarget(state, target)
  if (!normalizedTarget)
  {
    return null
  }
  if (typeof normalizedTarget !== 'string')
  {
    const scopedKey = composerTargetKey(normalizedTarget)
    if (state.draftsByThreadKey[scopedKey])
    {
      return scopedKey
    }
    for (const [draftId, draftSession] of Object.entries(state.draftThreadsByThreadKey))
    {
      if (
        draftSession.environmentId === normalizedTarget.environmentId &&
        draftSession.threadId === normalizedTarget.threadId
      )
      {
        return draftId
      }
    }
    return scopedKey
  }
  const threadKey = composerTargetKey(normalizedTarget)
  return threadKey.length > 0 ? threadKey : null
}

export function resolveComposerThreadId(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ThreadId | null
{
  const normalizedTarget = normalizeComposerTarget(state, target)
  if (!normalizedTarget)
  {
    return null
  }
  if (typeof normalizedTarget !== 'string')
  {
    return normalizedTarget.threadId
  }
  return state.draftThreadsByThreadKey[normalizedTarget]?.threadId ?? null
}

export function getComposerDraftState(
  state: Pick<ComposerDraftStoreState, 'draftsByThreadKey' | 'draftThreadsByThreadKey'>,
  target: ComposerThreadTarget,
): ComposerThreadDraftState | null
{
  const threadKey = resolveComposerDraftKey(state, target)
  if (!threadKey)
  {
    return null
  }
  return state.draftsByThreadKey[threadKey] ?? null
}

export function isComposerThreadKeyInUse(
  mappings: Record<string, string>,
  threadKey: string,
): boolean
{
  return Object.values(mappings).includes(threadKey)
}

export function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession
{
  return {
    draftId,
    ...draftSession,
  }
}

export function createDraftThreadState(
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
  logicalProjectKey: string,
  existingThread: DraftThreadState | undefined,
  options?: {
    threadId?: ThreadId
    branch?: string | null
    worktreePath?: string | null
    createdAt?: string
    envMode?: DraftThreadEnvMode
    startFromOrigin?: boolean
    runtimeMode?: RuntimeMode
    collaborationMode?: CollaborationMode
  },
): DraftThreadState
{
  // project changes drop machine-specific branch and worktree context
  // env mode and start-from-origin intent carry across machines
  const projectChanged =
    existingThread !== undefined &&
    (existingThread.environmentId !== projectRef.environmentId ||
      existingThread.projectId !== projectRef.projectId)
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null)
  const nextBranch =
    options?.branch === undefined
      ? projectChanged
        ? null
        : (existingThread?.branch ?? null)
      : (options.branch ?? null)
  const nextStartFromOrigin =
    options?.startFromOrigin === undefined
      ? (existingThread?.startFromOrigin ?? false)
      : options.startFromOrigin
  return {
    threadId,
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    logicalProjectKey,
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    collaborationMode:
      options?.collaborationMode ?? existingThread?.collaborationMode ?? DEFAULT_COLLABORATION_MODE,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    envMode:
      options?.envMode ?? (nextWorktreePath ? 'worktree' : (existingThread?.envMode ?? 'local')),
    startFromOrigin: nextStartFromOrigin,
    promotedTo: null,
  }
}

export function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean
{
  if (!left || !right)
  {
    return left === right
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId
}

export function isDraftThreadPromoting(draftThread: DraftThreadState | null | undefined): boolean
{
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined
}

export function draftThreadsEqual(
  left: DraftThreadState | undefined,
  right: DraftThreadState,
): boolean
{
  return (
    !!left &&
    left.threadId === right.threadId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.logicalProjectKey === right.logicalProjectKey &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.collaborationMode.baseMode === right.collaborationMode.baseMode &&
    left.collaborationMode.orchestrate === right.collaborationMode.orchestrate &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode &&
    left.startFromOrigin === right.startFromOrigin &&
    scopedThreadRefsEqual(left.promotedTo, right.promotedTo)
  )
}

export function removeDraftThreadReferences(
  state: Pick<
    ComposerDraftStoreState,
    | 'draftThreadsByThreadKey'
    | 'draftsByThreadKey'
    | 'logicalProjectDraftThreadKeyByLogicalProjectKey'
  >,
  threadKey: string,
): Pick<
  ComposerDraftStoreState,
  | 'draftThreadsByThreadKey'
  | 'draftsByThreadKey'
  | 'logicalProjectDraftThreadKeyByLogicalProjectKey'
>
{
  const nextLogicalMappings = Object.fromEntries(
    Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
      ([, draftThreadKey]) => draftThreadKey !== threadKey,
    ),
  ) as Record<string, string>
  const { [threadKey]: _removedDraftThread, ...restDraftThreadsByThreadKey } =
    state.draftThreadsByThreadKey
  const { [threadKey]: removedComposerDraft, ...restDraftsByThreadKey } = state.draftsByThreadKey
  revokeDraftThreadPreviewUrls(removedComposerDraft)
  return {
    draftsByThreadKey: restDraftsByThreadKey,
    draftThreadsByThreadKey: restDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
  }
}

function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectKey: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  'draftThreadsByThreadKey' | 'logicalProjectDraftThreadKeyByLogicalProjectKey'
>
{
  const draftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {}
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>()
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === 'object'
  )
  {
    for (const [projectKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    ))
    {
      if (typeof threadId !== 'string' || threadId.length === 0)
      {
        continue
      }
      const projectRef = parseScopedProjectKey(projectKey)
      if (!projectRef)
      {
        continue
      }
      const parsedThreadRef = parseScopedThreadKey(threadId)
      if (parsedThreadRef)
      {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId)
        continue
      }
      environmentIdByThreadId.set(threadId as ThreadId, projectRef.environmentId)
    }
  }
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === 'object')
  {
    for (const [threadKeyOrId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    ))
    {
      if (typeof threadKeyOrId !== 'string' || threadKeyOrId.length === 0)
      {
        continue
      }
      if (!rawDraftThread || typeof rawDraftThread !== 'object')
      {
        continue
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId)
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId)
      const threadId =
        parsedThreadRef?.threadId ??
        (typeof candidateDraftThread.threadId === 'string' &&
        candidateDraftThread.threadId.length > 0
          ? (candidateDraftThread.threadId as ThreadId)
          : (threadKeyOrId as ThreadId))
      const environmentId =
        parsedThreadRef?.environmentId ??
        (typeof candidateDraftThread.environmentId === 'string' &&
        candidateDraftThread.environmentId.length > 0
          ? (candidateDraftThread.environmentId as EnvironmentId)
          : environmentIdByThreadId.get(threadKeyOrId as ThreadId))
      const projectId = candidateDraftThread.projectId
      const createdAt = candidateDraftThread.createdAt
      const branch = candidateDraftThread.branch
      const worktreePath = candidateDraftThread.worktreePath
      const startFromOrigin = candidateDraftThread.startFromOrigin === true
      const normalizedWorktreePath = typeof worktreePath === 'string' ? worktreePath : null
      const promotedToCandidate = candidateDraftThread.promotedTo
      const promotedToRecord =
        promotedToCandidate && typeof promotedToCandidate === 'object'
          ? (promotedToCandidate as Record<string, unknown>)
          : null
      const promotedTo =
        promotedToRecord &&
        typeof promotedToRecord.environmentId === 'string' &&
        promotedToRecord.environmentId.length > 0 &&
        typeof promotedToRecord.threadId === 'string' &&
        promotedToRecord.threadId.length > 0
          ? scopeThreadRef(
              promotedToRecord.environmentId as EnvironmentId,
              promotedToRecord.threadId as ThreadId,
            )
          : null
      if (typeof projectId !== 'string' || projectId.length === 0 || environmentId === undefined)
      {
        continue
      }
      const normalizedEnvironmentId = environmentId as EnvironmentId
      const collaborationMode =
        normalizePersistedCollaborationMode(
          candidateDraftThread.interactionMode,
          candidateDraftThread.orchestrate,
        ) ?? DEFAULT_COLLABORATION_MODE
      const wireMode = toWireInteractionMode(collaborationMode)
      draftThreadsByThreadKey[threadKey] = {
        threadId,
        environmentId: normalizedEnvironmentId,
        projectId: projectId as ProjectId,
        logicalProjectKey:
          typeof candidateDraftThread.logicalProjectKey === 'string' &&
          candidateDraftThread.logicalProjectKey.length > 0
            ? candidateDraftThread.logicalProjectKey
            : parsedThreadRef
              ? projectDraftKey(scopeProjectRef(normalizedEnvironmentId, projectId as ProjectId))
              : threadKeyOrId,
        createdAt:
          typeof createdAt === 'string' && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode: isRuntimeMode(candidateDraftThread.runtimeMode)
          ? candidateDraftThread.runtimeMode
          : DEFAULT_RUNTIME_MODE,
        interactionMode: wireMode.interactionMode,
        orchestrate: wireMode.orchestrate,
        branch: typeof branch === 'string' ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
        startFromOrigin,
        promotedTo,
      }
    }
  }

  const logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {}
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === 'object'
  )
  {
    for (const [logicalProjectKey, threadKeyOrId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    ))
    {
      if (typeof threadKeyOrId !== 'string' || threadKeyOrId.length === 0)
      {
        continue
      }
      const projectRef = parseScopedProjectKey(logicalProjectKey)
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId)
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId)
      logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] = threadKey
      if (parsedThreadRef)
      {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId)
      }
      if (!projectRef)
      {
        const existingDraftThread = draftThreadsByThreadKey[threadKey]
        if (existingDraftThread && !existingDraftThread.logicalProjectKey)
        {
          draftThreadsByThreadKey[threadKey] = {
            ...existingDraftThread,
            logicalProjectKey,
          }
        }
        continue
      }
      if (!draftThreadsByThreadKey[threadKey])
      {
        draftThreadsByThreadKey[threadKey] = {
          threadId: parsedThreadRef?.threadId ?? (threadKey as ThreadId),
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
          createdAt: new Date().toISOString(),
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: toWireInteractionMode(DEFAULT_COLLABORATION_MODE).interactionMode,
          orchestrate: DEFAULT_COLLABORATION_MODE.orchestrate,
          branch: null,
          worktreePath: null,
          envMode: 'local',
          startFromOrigin: false,
          promotedTo: null,
        }
      }
      else if (
        draftThreadsByThreadKey[threadKey]?.projectId !== projectRef.projectId ||
        draftThreadsByThreadKey[threadKey]?.environmentId !== projectRef.environmentId
      )
      {
        draftThreadsByThreadKey[threadKey] = {
          ...draftThreadsByThreadKey[threadKey]!,
          threadId: draftThreadsByThreadKey[threadKey]!.threadId,
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
        }
      }
    }
  }

  return { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey }
}

function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
  draftThreadsByThreadKey: PersistedComposerDraftStoreState['draftThreadsByThreadKey'],
): PersistedComposerDraftStoreState['draftsByThreadKey']
{
  if (!rawDraftMap || typeof rawDraftMap !== 'object')
  {
    return {}
  }

  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>()
  for (const [threadKey, draftThread] of Object.entries(draftThreadsByThreadKey))
  {
    const parsedThreadRef = composerThreadRefFromKey(threadKey)
    if (!parsedThreadRef)
    {
      continue
    }
    environmentIdByThreadId.set(
      parsedThreadRef.threadId,
      draftThread.environmentId as EnvironmentId,
    )
  }

  const nextDraftsByThreadKey: DeepMutable<PersistedComposerDraftStoreState['draftsByThreadKey']> =
    {}
  for (const [threadKeyOrId, draftValue] of Object.entries(
    rawDraftMap as Record<string, unknown>,
  ))
  {
    if (typeof threadKeyOrId !== 'string' || threadKeyOrId.length === 0)
    {
      continue
    }
    if (!draftValue || typeof draftValue !== 'object')
    {
      continue
    }
    const draftCandidate = draftValue as PersistedComposerThreadDraftState
    const promptCandidate = typeof draftCandidate.prompt === 'string' ? draftCandidate.prompt : ''
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) =>
        {
          const normalized = normalizePersistedAttachment(entry)
          return normalized ? [normalized] : []
        })
      : []
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) =>
        {
          const normalized = normalizePersistedTerminalContextDraft(entry)
          return normalized ? [normalized] : []
        })
      : []
    const elementContexts = Array.isArray(draftCandidate.elementContexts)
      ? draftCandidate.elementContexts.flatMap((entry) =>
        {
          const normalized = normalizePersistedElementContextDraft(entry)
          return normalized ? [normalized] : []
        })
      : []
    const previewAnnotations = Array.isArray(draftCandidate.previewAnnotations)
      ? draftCandidate.previewAnnotations.filter(isPreviewAnnotationPayload)
      : []
    const reviewComments = Array.isArray(draftCandidate.reviewComments)
      ? draftCandidate.reviewComments.filter(isReviewCommentContext)
      : []
    const runtimeMode = isRuntimeMode(draftCandidate.runtimeMode)
      ? draftCandidate.runtimeMode
      : null
    const collaborationMode = normalizePersistedCollaborationMode(
      draftCandidate.interactionMode,
      draftCandidate.orchestrate === true || draftCandidate.orchestrateMode === true,
    )
    const prompt = ensureInlineTerminalContextPlaceholders(promptCandidate, terminalContexts.length)
    // if the draft already has the v3 shape, use it directly
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState
    let modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {}
    let activeProvider: ProviderInstanceId | null = null

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === 'object'
    )
    {
      // v3 format
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >
      activeProvider = normalizeProviderInstanceId(draftCandidate.activeProvider)
    }
    else
    {
      // v2 or legacy format: migrate
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? (legacyDraftCandidate.modelOptions as unknown),
          legacyCodex: legacyDraftCandidate,
        },
      )
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      )
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      )
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      )
      activeProvider = modelSelection?.instanceId ?? null
    }

    const hasModelData = Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      terminalContexts.length === 0 &&
      elementContexts.length === 0 &&
      previewAnnotations.length === 0 &&
      reviewComments.length === 0 &&
      !hasModelData &&
      !runtimeMode &&
      !collaborationMode
    )
    {
      continue
    }
    const parsedThreadRef = parseScopedThreadKey(threadKeyOrId)
    const normalizedThreadKey =
      parsedThreadRef !== null
        ? normalizeLegacyComposerStorageKey(threadKeyOrId)
        : draftThreadsByThreadKey[threadKeyOrId] !== undefined
          ? threadKeyOrId
          : (() =>
            {
              const environmentId = environmentIdByThreadId.get(threadKeyOrId as ThreadId)
              return environmentId
                ? normalizeLegacyComposerStorageKey(threadKeyOrId, { environmentId })
                : threadKeyOrId
            })()
    const wireMode = collaborationMode ? toWireInteractionMode(collaborationMode) : null
    nextDraftsByThreadKey[normalizedThreadKey] = {
      prompt,
      attachments,
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(elementContexts.length > 0 ? { elementContexts } : {}),
      ...(previewAnnotations.length > 0 ? { previewAnnotations } : {}),
      ...(reviewComments.length > 0 ? { reviewComments } : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(modelSelectionByProvider),
            activeProvider,
          }
        : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(wireMode
        ? {
            interactionMode: wireMode.interactionMode,
            orchestrate: wireMode.orchestrate,
          }
        : {}),
    }
  }

  return nextDraftsByThreadKey
}

export function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState
{
  if (!persistedState || typeof persistedState !== 'object')
  {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE
  }
  const candidate = persistedState as LegacyPersistedComposerDraftStoreState
  const rawDraftMap = candidate.draftsByThreadKey ?? candidate.draftsByThreadId
  const rawDraftThreadsByThreadId =
    candidate.draftThreadsByThreadKey ?? candidate.draftThreadsByThreadId
  const rawProjectDraftThreadIdByProjectKey =
    candidate.logicalProjectDraftThreadKeyByLogicalProjectKey ??
    candidate.projectDraftThreadKeyByProjectKey ??
    candidate.projectDraftThreadIdByProjectKey ??
    candidate.projectDraftThreadIdByProjectId

  // migrate sticky state from v2 (dual) to v3 (consolidated)
  const stickyModelOptions = normalizeProviderModelOptions(candidate.stickyModelOptions) ?? {}
  const normalizedStickyModelSelection = normalizeModelSelection(candidate.stickyModelSelection, {
    provider: candidate.stickyProvider ?? 'codex',
    model: candidate.stickyModel,
    modelOptions: stickyModelOptions,
  })
  const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
    normalizedStickyModelSelection,
    stickyModelOptions,
  )
  const stickyModelSelection = legacySyncModelSelectionOptions(
    normalizedStickyModelSelection,
    nextStickyModelOptions,
  )
  const stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
    stickyModelSelection,
    nextStickyModelOptions,
  )
  const stickyActiveProvider = normalizeProviderInstanceId(candidate.stickyProvider) ?? null

  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(rawDraftThreadsByThreadId, rawProjectDraftThreadIdByProjectKey)
  const draftsByThreadKey = normalizePersistedDraftsByThreadId(rawDraftMap, draftThreadsByThreadKey)
  return {
    draftsByThreadKey,
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  }
}

export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState
{
  const persistedDraftsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState['draftsByThreadKey']
  > = {}
  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey))
  {
    if (typeof threadKey !== 'string' || threadKey.length === 0)
    {
      continue
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.elementContexts.length === 0 &&
      draft.previewAnnotations.length === 0 &&
      draft.reviewComments.length === 0 &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.collaborationMode === null
    )
    {
      continue
    }
    const wireMode = draft.collaborationMode ? toWireInteractionMode(draft.collaborationMode) : null
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
            })),
          }
        : {}),
      ...(draft.elementContexts.length > 0
        ? {
            elementContexts: draft.elementContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              pickedAt: context.pickedAt,
              pageUrl: context.pageUrl,
              pageTitle: context.pageTitle,
              tagName: context.tagName,
              selector: context.selector,
              htmlPreview: context.htmlPreview,
              componentName: context.componentName,
              source: context.source,
              styles: context.styles,
            })),
          }
        : {}),
      ...(draft.previewAnnotations.length > 0
        ? {
            previewAnnotations: draft.previewAnnotations.map(
              (annotation) => ({ ...annotation }) as DeepMutable<PreviewAnnotationPayload>,
            ),
          }
        : {}),
      ...(draft.reviewComments.length > 0
        ? {
            reviewComments: draft.reviewComments.map((comment) => ({ ...comment })),
          }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(
              draft.modelSelectionByProvider,
            ),
            activeProvider: draft.activeProvider,
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(wireMode
        ? {
            interactionMode: wireMode.interactionMode,
            orchestrate: wireMode.orchestrate,
          }
        : {}),
    }
    persistedDraftsByThreadKey[threadKey] = persistedDraft
  }
  const persistedDraftThreadsByThreadKey = Object.fromEntries(
    Object.entries(state.draftThreadsByThreadKey).map(([threadKey, draftThread]) =>
    {
      const wireMode = toWireInteractionMode(draftThread.collaborationMode)
      const { collaborationMode: _collaborationMode, ...persistedDraftThread } = draftThread
      return [
        threadKey,
        {
          ...persistedDraftThread,
          interactionMode: wireMode.interactionMode,
          orchestrate: wireMode.orchestrate,
        },
      ]
    }),
  ) as DeepMutable<PersistedComposerDraftStoreState['draftThreadsByThreadKey']>
  return {
    draftsByThreadKey: persistedDraftsByThreadKey,
    draftThreadsByThreadKey: persistedDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
  }
}

export function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState
{
  if (!persistedState || typeof persistedState !== 'object')
  {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState
  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadKey ??
        normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.logicalProjectDraftThreadKeyByLogicalProjectKey ??
        normalizedPersistedState.projectDraftThreadKeyByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectId,
    )

  // handle both v3 (modelSelectionByProvider) and v2/legacy formats
  let stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {}
  let stickyActiveProvider: ProviderInstanceId | null = null
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === 'object'
  )
  {
    stickyModelSelectionByProvider =
      normalizedPersistedState.stickyModelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >
    stickyActiveProvider = normalizeProviderInstanceId(
      normalizedPersistedState.stickyActiveProvider,
    )
  }
  else
  {
    // legacy migration path
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {}
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider,
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    )
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    )
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    )
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    )
    stickyActiveProvider = normalizeProviderInstanceId(normalizedPersistedState.stickyProvider)
  }

  return {
    draftsByThreadKey: normalizePersistedDraftsByThreadId(
      normalizedPersistedState.draftsByThreadKey ?? normalizedPersistedState.draftsByThreadId,
      draftThreadsByThreadKey,
    ),
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  }
}

function readPersistedAttachmentIdsFromStorage(threadKey: string): string[]
{
  if (threadKey.length === 0)
  {
    return []
  }
  try
  {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    )
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION)
    {
      return []
    }
    return (persisted.state.draftsByThreadKey[threadKey]?.attachments ?? []).map(
      (attachment) => attachment.id,
    )
  }
  catch
  {
    return []
  }
}

export function verifyPersistedAttachments(
  threadKey: string,
  attachments: PersistedComposerImageAttachment[],
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void
{
  let persistedIdSet = new Set<string>()
  try
  {
    composerDebouncedStorage.flush()
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadKey))
  }
  catch
  {
    persistedIdSet = new Set()
  }
  set((state) =>
  {
    const current = state.draftsByThreadKey[threadKey]
    if (!current)
    {
      return state
    }
    const imageIdSet = new Set(current.images.map((image) => image.id))
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    )
    const nonPersistedImageIds: string[] = []
    for (const image of current.images)
    {
      if (!persistedIdSet.has(image.id))
      {
        nonPersistedImageIds.push(image.id)
      }
    }
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    }
    const nextDraftsByThreadKey = { ...state.draftsByThreadKey }
    if (shouldRemoveDraft(nextDraft))
    {
      delete nextDraftsByThreadKey[threadKey]
    }
    else
    {
      nextDraftsByThreadKey[threadKey] = nextDraft
    }
    return { draftsByThreadKey: nextDraftsByThreadKey }
  })
}

function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null
{
  const commaIndex = attachment.dataUrl.indexOf(',')
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex)
  const payload = commaIndex === -1 ? '' : attachment.dataUrl.slice(commaIndex + 1)
  if (payload.length === 0)
  {
    return null
  }
  try
  {
    const isBase64 = header.includes(';base64')
    if (!isBase64)
    {
      const decodedText = decodeURIComponent(payload)
      const inferredMimeType =
        header.startsWith('data:') && header.includes(';')
          ? header.slice('data:'.length, header.indexOf(';'))
          : attachment.mimeType
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      })
    }
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1)
    {
      bytes[index] = binary.charCodeAt(index)
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType })
  }
  catch
  {
    return null
  }
}

export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[]
{
  return attachments.flatMap((attachment) =>
  {
    const file = hydratePersistedComposerImageAttachment(attachment)
    if (!file) return []

    return [
      {
        type: 'image' as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
      } satisfies ComposerImageAttachment,
    ]
  })
}

export function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState
{
  // the persisted draft is already in v3 shape (migration handles older formats)
  const modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {}
  const activeProvider = normalizeProviderInstanceId(persistedDraft.activeProvider) ?? null

  return {
    prompt: persistedDraft.prompt,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: '',
      })) ?? [],
    elementContexts:
      persistedDraft.elementContexts?.map((context) => ({
        ...context,
      })) ?? [],
    previewAnnotations:
      persistedDraft.previewAnnotations?.map((annotation) => ({ ...annotation })) ?? [],
    reviewComments: persistedDraft.reviewComments?.map((comment) => ({ ...comment })) ?? [],
    modelSelectionByProvider,
    activeProvider,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    collaborationMode: normalizePersistedCollaborationMode(
      persistedDraft.interactionMode,
      persistedDraft.orchestrate === true || persistedDraft.orchestrateMode === true,
    ),
  }
}

export function toHydratedDraftThreadState(
  persistedDraftThread: PersistedDraftThreadState,
): DraftThreadState
{
  return {
    threadId: persistedDraftThread.threadId,
    environmentId: persistedDraftThread.environmentId as EnvironmentId,
    projectId: persistedDraftThread.projectId,
    logicalProjectKey:
      persistedDraftThread.logicalProjectKey ??
      projectDraftKey(
        scopeProjectRef(
          persistedDraftThread.environmentId as EnvironmentId,
          persistedDraftThread.projectId,
        ),
      ),
    createdAt: persistedDraftThread.createdAt,
    runtimeMode: persistedDraftThread.runtimeMode,
    collaborationMode:
      normalizePersistedCollaborationMode(
        persistedDraftThread.interactionMode,
        persistedDraftThread.orchestrate,
      ) ?? DEFAULT_COLLABORATION_MODE,
    branch: persistedDraftThread.branch,
    worktreePath: persistedDraftThread.worktreePath,
    envMode: persistedDraftThread.envMode,
    startFromOrigin: persistedDraftThread.startFromOrigin,
    promotedTo: persistedDraftThread.promotedTo
      ? scopeThreadRef(
          persistedDraftThread.promotedTo.environmentId as EnvironmentId,
          persistedDraftThread.promotedTo.threadId as ThreadId,
        )
      : null,
  }
}
