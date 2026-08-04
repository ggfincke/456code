// apps/web/src/composer-drafts/runtime.ts
// owns the live composer draft store and hooks
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from '@t3tools/client-runtime/environment'
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  type EnvironmentId,
  ModelSelection,
  type PreviewAnnotationPayload,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ServerProvider,
  ThreadId,
  defaultInstanceIdForDriver,
} from '@t3tools/contracts'
import { UnifiedSettings } from '@t3tools/contracts/settings'
import { createModelSelection, normalizeModelSlug } from '@t3tools/shared/model'
import * as Equal from 'effect/Equal'
import { useMemo } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import {
  type ElementContextDraft,
  type ElementContextSelection,
  elementContextDedupKey,
  newElementContextId,
} from '../lib/elementContext'
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
} from '../lib/terminalContext'
import { type ReviewCommentContext } from '../reviewCommentContext'

import {
  type ComposerDraftModelState,
  EMPTY_COMPOSER_DRAFT_MODEL_STATE,
  type EffectiveComposerModelState,
  deriveEffectiveComposerModelState,
  isProviderInteractionMode,
  isRuntimeMode,
  normalizeModelSelection,
  normalizeProviderDriverKind,
} from './model-selection'
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  type DraftThreadState,
  EMPTY_THREAD_DRAFT,
  PersistedComposerImageAttachment,
  type ProjectDraftSession,
  composerDebouncedStorage,
  composerImageDedupKey,
  createDraftThreadState,
  createEmptyThreadDraft,
  draftThreadsEqual,
  getComposerDraftState,
  isComposerThreadKeyInUse,
  isDraftThreadPromoting,
  isReviewCommentContext,
  logicalProjectDraftKey,
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  partializeComposerDraftStoreState,
  projectDraftKey,
  removeDraftThreadReferences,
  resolveComposerDraftKey,
  resolveComposerThreadId,
  revokeDraftThreadPreviewUrls,
  revokeObjectPreviewUrl,
  scopedThreadRefsEqual,
  shouldRemoveDraft,
  terminalContextDedupKey,
  toHydratedDraftThreadState,
  toHydratedThreadDraft,
  toProjectDraftSession,
  verifyPersistedAttachments,
} from './persistence'

/**
 * Persisted store for composer content plus draft-session metadata.
 *
 * The store intentionally models two domains:
 * - draft sessions keyed by `DraftId`
 * - server thread composer state keyed by `ScopedThreadRef`
 */
export interface ComposerDraftStoreState
{
  draftsByThreadKey: Record<string, ComposerThreadDraftState>
  draftThreadsByThreadKey: Record<string, DraftThreadState>
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>
  stickyActiveProvider: ProviderInstanceId | null
  // returns the editable composer content for a draft session or server thread.
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null
  // looks up the active draft session for a logical project identity.
  getDraftThreadByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null
  // reads mutable draft-session metadata by `DraftId`.
  getDraftSession: (draftId: DraftId) => DraftSessionState | null
  // resolves a server-thread ref back to a matching draft session when one exists.
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null
  listDraftThreadKeys: () => string[]
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean
  // creates or updates the draft session tracked for a logical project.
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId
      branch?: string | null
      worktreePath?: string | null
      createdAt?: string
      envMode?: DraftThreadEnvMode
      startFromOrigin?: boolean
      runtimeMode?: RuntimeMode
      interactionMode?: ProviderInteractionMode
    },
  ) => void
  // creates or updates the draft session tracked for a concrete project ref.
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId
      branch?: string | null
      worktreePath?: string | null
      createdAt?: string
      envMode?: DraftThreadEnvMode
      startFromOrigin?: boolean
      runtimeMode?: RuntimeMode
      interactionMode?: ProviderInteractionMode
    },
  ) => void
  // updates mutable draft-session metadata without touching composer content.
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      branch?: string | null
      worktreePath?: string | null
      projectRef?: ScopedProjectRef
      createdAt?: string
      envMode?: DraftThreadEnvMode
      startFromOrigin?: boolean
      runtimeMode?: RuntimeMode
      interactionMode?: ProviderInteractionMode
    },
  ) => void
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void
  // marks a draft session as being promoted to a real server thread.
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void
  // removes draft-session metadata after promotion is complete.
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void
  clearDraftThread: (threadRef: ComposerThreadTarget) => void
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: {
      // replace the stored entry outright instead of preserving its
      // existing options when the incoming selection has none. Used when
      // the selection is a complete snapshot (e.g. carried from another
      // thread) rather than a model-only change.
      replaceOptions?: boolean
    },
  ) => void
  // replace the model options for one or more providers in the draft.
  setModelOptions: (
    threadRef: ComposerThreadTarget,
    modelOptions:
      Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>> | null | undefined,
  ) => void
  applyStickyState: (threadRef: ComposerThreadTarget) => void
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined
      model?: string | null | undefined
      persistSticky?: boolean
    },
  ) => void
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void
  setInteractionMode: (
    threadRef: ComposerThreadTarget,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void
  addImage: (threadRef: ComposerThreadTarget, image: ComposerImageAttachment) => void
  addImages: (threadRef: ComposerThreadTarget, images: ComposerImageAttachment[]) => void
  removeImage: (threadRef: ComposerThreadTarget, imageId: string) => void
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean
  addTerminalContext: (threadRef: ComposerThreadTarget, context: TerminalContextDraft) => void
  addTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void
  // append a fresh element pick to the draft. Returns true when accepted,
  // false when deduped against an existing pick of the same element.
  addElementContext: (
    threadRef: ComposerThreadTarget,
    selection: ElementContextSelection,
  ) => boolean
  // replace the entire element-contexts list (used by send-failure retry to
  // restore the pre-send snapshot).
  setElementContexts: (
    threadRef: ComposerThreadTarget,
    contexts: ReadonlyArray<ElementContextDraft>,
  ) => void
  removeElementContext: (threadRef: ComposerThreadTarget, contextId: string) => void
  clearElementContexts: (threadRef: ComposerThreadTarget) => void
  addPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotation: PreviewAnnotationPayload,
  ) => void
  setPreviewAnnotations: (
    threadRef: ComposerThreadTarget,
    annotations: ReadonlyArray<PreviewAnnotationPayload>,
  ) => void
  removePreviewAnnotation: (threadRef: ComposerThreadTarget, annotationId: string) => void
  addReviewComment: (threadRef: ComposerThreadTarget, comment: ReviewCommentContext) => void
  setReviewComments: (
    threadRef: ComposerThreadTarget,
    comments: ReadonlyArray<ReviewCommentContext>,
  ) => void
  removeReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void
  clearPersistedAttachments: (threadRef: ComposerThreadTarget) => void
  syncPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => void
  clearComposerContent: (threadRef: ComposerThreadTarget) => void
  // clears only the prompt text and image attachments, preserving terminal /
  // element contexts, preview annotations, and review comments. Used by the
  // prompt stash, which can only round-trip text + images: clearing the
  // session-bound contexts would destroy state nothing can restore.
  clearComposerPromptAndImages: (threadRef: ComposerThreadTarget) => void
}

const composerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (setBase, get) =>
    {
      const set = setBase

      return {
        draftsByThreadKey: {},
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        stickyModelSelectionByProvider: {},
        stickyActiveProvider: null,
        getComposerDraft: (target) => getComposerDraftState(get(), target),
        getDraftThreadByLogicalProjectKey: (logicalProjectKey) =>
        {
          return get().getDraftSessionByLogicalProjectKey(logicalProjectKey)
        },
        getDraftSessionByLogicalProjectKey: (logicalProjectKey) =>
        {
          const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey)
          if (normalizedLogicalProjectKey.length === 0)
          {
            return null
          }
          const draftId =
            get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey]
          if (!draftId)
          {
            return null
          }
          const draftThread = get().draftThreadsByThreadKey[draftId]
          if (!draftThread || isDraftThreadPromoting(draftThread))
          {
            return null
          }
          return toProjectDraftSession(DraftId.make(draftId), draftThread)
        },
        getDraftThreadByProjectRef: (projectRef) =>
        {
          return get().getDraftSessionByProjectRef(projectRef)
        },
        getDraftSessionByProjectRef: (projectRef) =>
        {
          for (const [draftId, draftThread] of Object.entries(get().draftThreadsByThreadKey))
          {
            if (isDraftThreadPromoting(draftThread))
            {
              continue
            }
            if (
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId
            )
            {
              return toProjectDraftSession(DraftId.make(draftId), draftThread)
            }
          }
          return null
        },
        getDraftSession: (draftId) => get().draftThreadsByThreadKey[draftId] ?? null,
        getDraftSessionByRef: (threadRef) =>
        {
          for (const draftSession of Object.values(get().draftThreadsByThreadKey))
          {
            if (
              draftSession.environmentId === threadRef.environmentId &&
              draftSession.threadId === threadRef.threadId
            )
            {
              return draftSession
            }
          }
          return null
        },
        getDraftThread: (threadRef) =>
        {
          if (typeof threadRef === 'string')
          {
            return get().getDraftSession(DraftId.make(threadRef))
          }
          return get().getDraftSessionByRef(threadRef)
        },
        getDraftThreadByRef: (threadRef) =>
        {
          return get().getDraftSessionByRef(threadRef)
        },
        listDraftThreadKeys: () =>
          Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
            scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
          ),
        hasDraftThreadsInEnvironment: (environmentId) =>
          Object.values(get().draftThreadsByThreadKey).some(
            (draftThread) => draftThread.environmentId === environmentId,
          ),
        setLogicalProjectDraftThreadId: (logicalProjectKey, projectRef, draftId, options) =>
        {
          const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey)
          if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0)
          {
            return
          }
          set((state) =>
          {
            const existingThread = state.draftThreadsByThreadKey[draftId]
            const previousThreadKeyForLogicalProject =
              state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey]
            const nextDraftThread = createDraftThreadState(
              projectRef,
              options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
              normalizedLogicalProjectKey,
              existingThread,
              options,
            )
            const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId
            if (hasSameLogicalMapping && draftThreadsEqual(existingThread, nextDraftThread))
            {
              return state
            }
            const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {
              ...state.logicalProjectDraftThreadKeyByLogicalProjectKey,
              [normalizedLogicalProjectKey]: draftId,
            }
            const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
              ...state.draftThreadsByThreadKey,
              [draftId]: nextDraftThread,
            }
            let nextDraftsByThreadKey = state.draftsByThreadKey
            const previousDraftThread =
              previousThreadKeyForLogicalProject === undefined
                ? undefined
                : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject]
            if (
              previousThreadKeyForLogicalProject &&
              previousThreadKeyForLogicalProject !== draftId &&
              !isComposerThreadKeyInUse(
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
                previousThreadKeyForLogicalProject,
              ) &&
              !isDraftThreadPromoting(previousDraftThread)
            )
            {
              delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject]
              if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined)
              {
                nextDraftsByThreadKey = { ...state.draftsByThreadKey }
                delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject]
              }
            }
            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
              logicalProjectDraftThreadKeyByLogicalProjectKey:
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
            }
          })
        },
        setProjectDraftThreadId: (projectRef, draftId, options) =>
        {
          get().setLogicalProjectDraftThreadId(
            projectDraftKey(projectRef),
            projectRef,
            draftId,
            options,
          )
        },
        setDraftThreadContext: (threadRef, options) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const existing = state.draftThreadsByThreadKey[threadKey]
            if (!existing)
            {
              return state
            }
            const nextProjectRef = options.projectRef ?? {
              environmentId: existing.environmentId,
              projectId: existing.projectId,
            }
            if (
              nextProjectRef.projectId.length === 0 ||
              nextProjectRef.environmentId.length === 0
            )
            {
              return state
            }
            // mirror createDraftThreadState's machine-specific context reset
            const projectChanged =
              nextProjectRef.environmentId !== existing.environmentId ||
              nextProjectRef.projectId !== existing.projectId
            const nextWorktreePath =
              options.worktreePath === undefined
                ? projectChanged
                  ? null
                  : existing.worktreePath
                : (options.worktreePath ?? null)
            const nextBranch =
              options.branch === undefined
                ? projectChanged
                  ? null
                  : existing.branch
                : (options.branch ?? null)
            const nextStartFromOrigin =
              options.startFromOrigin === undefined
                ? existing.startFromOrigin
                : options.startFromOrigin
            const nextDraftThread: DraftThreadState = {
              threadId: existing.threadId,
              environmentId: nextProjectRef.environmentId,
              projectId: nextProjectRef.projectId,
              logicalProjectKey: existing.logicalProjectKey,
              createdAt:
                options.createdAt === undefined
                  ? existing.createdAt
                  : options.createdAt || existing.createdAt,
              runtimeMode: options.runtimeMode ?? existing.runtimeMode,
              interactionMode: options.interactionMode ?? existing.interactionMode,
              branch: nextBranch,
              worktreePath: nextWorktreePath,
              envMode:
                options.envMode ?? (nextWorktreePath ? 'worktree' : (existing.envMode ?? 'local')),
              startFromOrigin: nextStartFromOrigin,
              promotedTo: existing.promotedTo ?? null,
            }
            const isUnchanged =
              nextDraftThread.environmentId === existing.environmentId &&
              nextDraftThread.projectId === existing.projectId &&
              nextDraftThread.logicalProjectKey === existing.logicalProjectKey &&
              nextDraftThread.createdAt === existing.createdAt &&
              nextDraftThread.runtimeMode === existing.runtimeMode &&
              nextDraftThread.interactionMode === existing.interactionMode &&
              nextDraftThread.branch === existing.branch &&
              nextDraftThread.worktreePath === existing.worktreePath &&
              nextDraftThread.envMode === existing.envMode &&
              nextDraftThread.startFromOrigin === existing.startFromOrigin &&
              scopedThreadRefsEqual(nextDraftThread.promotedTo, existing.promotedTo)
            if (isUnchanged)
            {
              return state
            }
            return {
              draftThreadsByThreadKey: {
                ...state.draftThreadsByThreadKey,
                [threadKey]: nextDraftThread,
              },
            }
          })
        },
        clearProjectDraftThreadId: (projectRef) =>
        {
          set((state) =>
          {
            const matchingThreadEntry = Object.entries(state.draftThreadsByThreadKey).find(
              ([, draftThread]) =>
                draftThread.projectId === projectRef.projectId &&
                draftThread.environmentId === projectRef.environmentId,
            )
            if (!matchingThreadEntry)
            {
              return state
            }
            return removeDraftThreadReferences(state, matchingThreadEntry[0])
          })
        },
        clearProjectDraftThreadById: (projectRef, threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const draftThread = state.draftThreadsByThreadKey[threadKey]
            if (
              !draftThread ||
              draftThread.projectId !== projectRef.projectId ||
              draftThread.environmentId !== projectRef.environmentId
            )
            {
              return state
            }
            return removeDraftThreadReferences(state, threadKey)
          })
        },
        markDraftThreadPromoting: (threadRef, promotedTo) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey)
          {
            return
          }
          set((state) =>
          {
            const existing = state.draftThreadsByThreadKey[threadKey]
            if (!existing)
            {
              return state
            }
            const nextPromotedTo =
              promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId)
            if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo))
            {
              return state
            }
            return {
              draftThreadsByThreadKey: {
                ...state.draftThreadsByThreadKey,
                [threadKey]: {
                  ...existing,
                  promotedTo: nextPromotedTo,
                },
              },
            }
          })
        },
        finalizePromotedDraftThread: (threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const existing = state.draftThreadsByThreadKey[threadKey]
            if (!isDraftThreadPromoting(existing))
            {
              return state
            }
            return removeDraftThreadReferences(state, threadKey)
          })
        },
        clearDraftThread: (threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined
            const hasLogicalProjectMapping = Object.values(
              state.logicalProjectDraftThreadKeyByLogicalProjectKey,
            ).includes(threadKey)
            const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined
            if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft)
            {
              return state
            }
            return removeDraftThreadReferences(state, threadKey)
          })
        },
        setStickyModelSelection: (modelSelection) =>
        {
          const normalized = normalizeModelSelection(modelSelection)
          set((state) =>
          {
            if (!normalized)
            {
              return state
            }
            const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
              ...state.stickyModelSelectionByProvider,
              [normalized.instanceId]: normalized,
            }
            if (Equal.equals(state.stickyModelSelectionByProvider, nextMap))
            {
              return state.stickyActiveProvider === normalized.instanceId
                ? state
                : { stickyActiveProvider: normalized.instanceId }
            }
            return {
              stickyModelSelectionByProvider: nextMap,
              stickyActiveProvider: normalized.instanceId,
            }
          })
        },
        applyStickyState: (threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const stickyMap = state.stickyModelSelectionByProvider
            const stickyActiveProvider = state.stickyActiveProvider
            if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null)
            {
              return state
            }
            const existing = state.draftsByThreadKey[threadKey]
            const base = existing ?? createEmptyThreadDraft()
            const nextMap = { ...base.modelSelectionByProvider }
            for (const [provider, selection] of Object.entries(stickyMap))
            {
              if (selection)
              {
                // iteration key comes from the instance-keyed sticky map,
                // so coerce the string back to `ProviderInstanceId` for
                // the typed lookup.
                const instanceKey = provider as ProviderInstanceId
                const current = nextMap[instanceKey]
                nextMap[instanceKey] = {
                  ...selection,
                  model: current?.model ?? selection.model,
                }
              }
            }
            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              base.activeProvider === stickyActiveProvider
            )
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              modelSelectionByProvider: nextMap,
              activeProvider: stickyActiveProvider,
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
        },
        setPrompt: (threadRef, prompt) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt,
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
        },
        setTerminalContexts: (threadRef, contexts) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          const threadId = resolveComposerThreadId(get(), threadRef)
          if (!threadKey || !threadId)
          {
            return
          }
          const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts)
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt: ensureInlineTerminalContextPlaceholders(
                existing.prompt,
                normalizedContexts.length,
              ),
              terminalContexts: normalizedContexts,
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
        },
        setModelSelection: (threadRef, modelSelection, opts) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          const normalized = normalizeModelSelection(modelSelection)
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey]
            if (!existing && normalized === null)
            {
              return state
            }
            const base = existing ?? createEmptyThreadDraft()
            const nextMap = { ...base.modelSelectionByProvider }
            if (normalized)
            {
              const current = nextMap[normalized.instanceId]
              if (normalized.options !== undefined || opts?.replaceOptions)
              {
                // explicit options provided (or the caller passed a complete
                // snapshot whose absent options mean "no options") -> use the
                // selection as-is.
                nextMap[normalized.instanceId] = normalized as ModelSelection
              }
              else
              {
                // no options in selection -> preserve existing options, update provider+model
                nextMap[normalized.instanceId] = createModelSelection(
                  normalized.instanceId,
                  normalized.model,
                  current?.options,
                )
              }
            }
            const nextActiveProvider = normalized?.instanceId ?? base.activeProvider
            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              base.activeProvider === nextActiveProvider
            )
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              modelSelectionByProvider: nextMap,
              activeProvider: nextActiveProvider,
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
        },
        setModelOptions: (threadRef, modelOptions) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey]
            if (!existing && (!modelOptions || Object.keys(modelOptions).length === 0))
            {
              return state
            }
            const base = existing ?? createEmptyThreadDraft()
            const nextMap = { ...base.modelSelectionByProvider }
            for (const provider of ['codex', 'claudeAgent', 'cursor', 'opencode'] as const)
            {
              if (!modelOptions || !(provider in modelOptions)) continue
              const opts = modelOptions[provider]
              const driverKind = ProviderDriverKind.make(provider)
              const instanceKey = defaultInstanceIdForDriver(driverKind)
              const current = nextMap[instanceKey]
              if (opts && opts.length > 0)
              {
                nextMap[instanceKey] = createModelSelection(
                  instanceKey,
                  current?.model ?? DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL,
                  opts,
                )
              }
              else if (current?.options)
              {
                const { options: _, ...rest } = current
                nextMap[instanceKey] = rest as ModelSelection
              }
            }
            if (Equal.equals(base.modelSelectionByProvider, nextMap))
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              modelSelectionByProvider: nextMap,
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
        },
        setProviderModelOptions: (threadRef, provider, nextProviderOptions, options) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          const normalizedProvider = normalizeProviderDriverKind(provider)
          if (normalizedProvider === null)
          {
            return
          }
          const instanceKey = options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider)
          const fallbackModel =
            normalizeModelSlug(options?.model, normalizedProvider) ??
            DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
            DEFAULT_MODEL
          const providerOpts =
            nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined

          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey]
            const base = existing ?? createEmptyThreadDraft()

            // update the map entry for this provider
            const nextMap = { ...base.modelSelectionByProvider }
            const currentForProvider = nextMap[instanceKey]
            if (providerOpts)
            {
              nextMap[instanceKey] = createModelSelection(
                instanceKey,
                currentForProvider?.model ?? fallbackModel,
                providerOpts,
              )
            }
            else if (currentForProvider && (currentForProvider.options?.length ?? 0) > 0)
            {
              const { options: _, ...rest } = currentForProvider
              nextMap[instanceKey] = rest as ModelSelection
            }

            // handle sticky persistence
            let nextStickyMap = state.stickyModelSelectionByProvider
            let nextStickyActiveProvider = state.stickyActiveProvider
            if (options?.persistSticky === true)
            {
              nextStickyMap = { ...state.stickyModelSelectionByProvider }
              const stickyBase =
                nextStickyMap[instanceKey] ??
                base.modelSelectionByProvider[instanceKey] ??
                createModelSelection(instanceKey, fallbackModel)
              if (providerOpts)
              {
                nextStickyMap[instanceKey] = createModelSelection(
                  instanceKey,
                  stickyBase.model,
                  providerOpts,
                )
              }
              else if ((stickyBase.options?.length ?? 0) > 0)
              {
                const { options: _, ...rest } = stickyBase
                nextStickyMap[instanceKey] = rest as ModelSelection
              }
              nextStickyActiveProvider = options.instanceId
                ? instanceKey
                : (base.activeProvider ?? instanceKey)
            }

            if (
              Equal.equals(base.modelSelectionByProvider, nextMap) &&
              Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
              state.stickyActiveProvider === nextStickyActiveProvider
            )
            {
              return state
            }

            const nextDraft: ComposerThreadDraftState = {
              ...base,
              ...(options?.instanceId ? { activeProvider: instanceKey } : {}),
              modelSelectionByProvider: nextMap,
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

            return {
              draftsByThreadKey: nextDraftsByThreadKey,
              ...(options?.persistSticky === true
                ? {
                    stickyModelSelectionByProvider: nextStickyMap,
                    stickyActiveProvider: nextStickyActiveProvider,
                  }
                : {}),
            }
          })
        },
        setRuntimeMode: (threadRef, runtimeMode) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey]
            if (!existing && nextRuntimeMode === null)
            {
              return state
            }
            const base = existing ?? createEmptyThreadDraft()
            if (base.runtimeMode === nextRuntimeMode)
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              runtimeMode: nextRuntimeMode,
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
        },
        setInteractionMode: (threadRef, interactionMode) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          const nextInteractionMode = isProviderInteractionMode(interactionMode)
            ? interactionMode
            : null
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey]
            if (!existing && nextInteractionMode === null)
            {
              return state
            }
            const base = existing ?? createEmptyThreadDraft()
            if (base.interactionMode === nextInteractionMode)
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...base,
              interactionMode: nextInteractionMode,
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
        },
        addImage: (threadRef, image) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          const threadId = resolveComposerThreadId(get(), threadRef)
          if (!threadKey || !threadId)
          {
            return
          }
          get().addImages(typeof threadRef === 'string' ? DraftId.make(threadKey) : threadRef, [
            image,
          ])
        },
        addImages: (threadRef, images) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0 || images.length === 0)
          {
            return
          }
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const existingIds = new Set(existing.images.map((image) => image.id))
            const existingDedupKeys = new Set(
              existing.images.map((image) => composerImageDedupKey(image)),
            )
            const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl))
            const dedupedIncoming: ComposerImageAttachment[] = []
            for (const image of images)
            {
              const dedupKey = composerImageDedupKey(image)
              if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey))
              {
                // avoid revoking a blob URL that's still referenced by an accepted image.
                if (!acceptedPreviewUrls.has(image.previewUrl))
                {
                  revokeObjectPreviewUrl(image.previewUrl)
                }
                continue
              }
              dedupedIncoming.push(image)
              existingIds.add(image.id)
              existingDedupKeys.add(dedupKey)
              acceptedPreviewUrls.add(image.previewUrl)
            }
            if (dedupedIncoming.length === 0)
            {
              return state
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  images: [...existing.images, ...dedupedIncoming],
                },
              },
            }
          })
        },
        removeImage: (threadRef, imageId) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          const existing = get().draftsByThreadKey[threadKey]
          if (!existing)
          {
            return
          }
          const removedImage = existing.images.find((image) => image.id === imageId)
          if (removedImage)
          {
            revokeObjectPreviewUrl(removedImage.previewUrl)
          }
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current)
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              images: current.images.filter((image) => image.id !== imageId),
              nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
              persistedAttachments: current.persistedAttachments.filter(
                (attachment) => attachment.id !== imageId,
              ),
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
        },
        insertTerminalContext: (threadRef, prompt, context, index) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          const threadId = resolveComposerThreadId(get(), threadRef)
          if (!threadKey || !threadId)
          {
            return false
          }
          let inserted = false
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const normalizedContext = normalizeTerminalContextForThread(threadId, context)
            if (!normalizedContext)
            {
              return state
            }
            const dedupKey = terminalContextDedupKey(normalizedContext)
            if (
              existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
              existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
            )
            {
              return state
            }
            inserted = true
            const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index))
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              prompt,
              terminalContexts: [
                ...existing.terminalContexts.slice(0, boundedIndex),
                normalizedContext,
                ...existing.terminalContexts.slice(boundedIndex),
              ],
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: nextDraft,
              },
            }
          })
          return inserted
        },
        addTerminalContext: (threadRef, context) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          const threadId = resolveComposerThreadId(get(), threadRef)
          if (!threadKey || !threadId)
          {
            return
          }
          get().addTerminalContexts(
            typeof threadRef === 'string' ? DraftId.make(threadKey) : threadRef,
            [context],
          )
        },
        addTerminalContexts: (threadRef, contexts) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          const threadId = resolveComposerThreadId(get(), threadRef)
          if (!threadKey || !threadId || contexts.length === 0)
          {
            return
          }
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
              ...existing.terminalContexts,
              ...contexts,
            ]).slice(existing.terminalContexts.length)
            if (acceptedContexts.length === 0)
            {
              return state
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  prompt: ensureInlineTerminalContextPlaceholders(
                    existing.prompt,
                    existing.terminalContexts.length + acceptedContexts.length,
                  ),
                  terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
                },
              },
            }
          })
        },
        removeTerminalContext: (threadRef, contextId) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0 || contextId.length === 0)
          {
            return
          }
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current)
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              terminalContexts: current.terminalContexts.filter(
                (context) => context.id !== contextId,
              ),
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
        },
        clearTerminalContexts: (threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current || current.terminalContexts.length === 0)
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              terminalContexts: [],
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
        },
        addElementContext: (threadRef, selection) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          const threadId = resolveComposerThreadId(get(), threadRef)
          if (!threadKey || !threadId) return false
          let accepted = false
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const dedupKey = elementContextDedupKey(selection)
            if (
              existing.elementContexts.some((entry) => elementContextDedupKey(entry) === dedupKey)
            )
            {
              return state
            }
            accepted = true
            const draft: ElementContextDraft = {
              ...selection,
              id: newElementContextId(),
              threadId,
              pickedAt: new Date().toISOString(),
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  elementContexts: [...existing.elementContexts, draft],
                },
              },
            }
          })
          return accepted
        },
        setElementContexts: (threadRef, contexts) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey) return
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const nextDraft: ComposerThreadDraftState = {
              ...existing,
              elementContexts: [...contexts],
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
        },
        removeElementContext: (threadRef, contextId) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0 || contextId.length === 0) return
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current) return state
            const filtered = current.elementContexts.filter((entry) => entry.id !== contextId)
            if (filtered.length === current.elementContexts.length) return state
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              elementContexts: filtered,
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
        },
        clearElementContexts: (threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0) return
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current || current.elementContexts.length === 0) return state
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              elementContexts: [],
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
        },
        addPreviewAnnotation: (threadRef, annotation) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey) return
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const nextAnnotations = existing.previewAnnotations.filter(
              (entry) => entry.id !== annotation.id,
            )
            const compactAnnotation: PreviewAnnotationPayload = {
              ...annotation,
              screenshot: annotation.screenshot ? { ...annotation.screenshot, dataUrl: '' } : null,
            }
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  previewAnnotations: [...nextAnnotations, compactAnnotation],
                },
              },
            }
          })
        },
        setPreviewAnnotations: (threadRef, annotations) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey) return
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: { ...existing, previewAnnotations: [...annotations] },
              },
            }
          })
        },
        removePreviewAnnotation: (threadRef, annotationId) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey || !annotationId) return
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current) return state
            const previewAnnotations = current.previewAnnotations.filter(
              (entry) => entry.id !== annotationId,
            )
            if (previewAnnotations.length === current.previewAnnotations.length) return state
            const nextDraft = {
              ...current,
              previewAnnotations,
              images: current.images.filter((image) => image.id !== annotationId),
              persistedAttachments: current.persistedAttachments.filter(
                (image) => image.id !== annotationId,
              ),
              nonPersistedImageIds: current.nonPersistedImageIds.filter(
                (imageId) => imageId !== annotationId,
              ),
            }
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey }
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey]
            else nextDraftsByThreadKey[threadKey] = nextDraft
            return { draftsByThreadKey: nextDraftsByThreadKey }
          })
        },
        addReviewComment: (threadRef, comment) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey || !isReviewCommentContext(comment)) return
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const reviewComments = existing.reviewComments.filter(
              (entry) => entry.id !== comment.id,
            )
            return {
              draftsByThreadKey: {
                ...state.draftsByThreadKey,
                [threadKey]: {
                  ...existing,
                  reviewComments: [...reviewComments, { ...comment }],
                },
              },
            }
          })
        },
        setReviewComments: (threadRef, comments) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey) return
          const reviewComments = comments
            .filter(isReviewCommentContext)
            .map((comment) => ({ ...comment }))
          set((state) =>
          {
            const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft()
            const nextDraft = { ...existing, reviewComments }
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey }
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey]
            else nextDraftsByThreadKey[threadKey] = nextDraft
            return { draftsByThreadKey: nextDraftsByThreadKey }
          })
        },
        removeReviewComment: (threadRef, commentId) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey || !commentId) return
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current) return state
            const reviewComments = current.reviewComments.filter((entry) => entry.id !== commentId)
            if (reviewComments.length === current.reviewComments.length) return state
            const nextDraft = { ...current, reviewComments }
            const nextDraftsByThreadKey = { ...state.draftsByThreadKey }
            if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey]
            else nextDraftsByThreadKey[threadKey] = nextDraft
            return { draftsByThreadKey: nextDraftsByThreadKey }
          })
        },
        clearPersistedAttachments: (threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current)
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              persistedAttachments: [],
              nonPersistedImageIds: [],
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
        },
        syncPersistedAttachments: (threadRef, attachments) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef)
          if (!threadKey)
          {
            return
          }
          const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id))
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current)
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              // stage attempted attachments so persist middleware can try writing them.
              persistedAttachments: attachments,
              nonPersistedImageIds: current.nonPersistedImageIds.filter(
                (id) => !attachmentIdSet.has(id),
              ),
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
          Promise.resolve().then(() =>
          {
            verifyPersistedAttachments(threadKey, attachments, set)
          })
        },
        clearComposerContent: (threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current)
            {
              return state
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: '',
              images: [],
              nonPersistedImageIds: [],
              persistedAttachments: [],
              terminalContexts: [],
              elementContexts: [],
              previewAnnotations: [],
              reviewComments: [],
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
        },
        clearComposerPromptAndImages: (threadRef) =>
        {
          const threadKey = resolveComposerDraftKey(get(), threadRef) ?? ''
          if (threadKey.length === 0)
          {
            return
          }
          set((state) =>
          {
            const current = state.draftsByThreadKey[threadKey]
            if (!current)
            {
              return state
            }
            for (const image of current.images)
            {
              revokeObjectPreviewUrl(image.previewUrl)
            }
            const nextDraft: ComposerThreadDraftState = {
              ...current,
              prompt: ensureInlineTerminalContextPlaceholders('', current.terminalContexts.length),
              images: [],
              nonPersistedImageIds: [],
              persistedAttachments: [],
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
        },
      }
    },
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: createJSONStorage(() => composerDebouncedStorage),
      migrate: migratePersistedComposerDraftStoreState,
      partialize: partializeComposerDraftStoreState,
      merge: (persistedState, currentState) =>
      {
        const normalizedPersisted = normalizeCurrentPersistedComposerDraftStoreState(persistedState)
        const draftsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadKey).map(([threadKey, draft]) => [
            threadKey,
            toHydratedThreadDraft(draft),
          ]),
        )
        const draftThreadsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftThreadsByThreadKey).map(
            ([threadKey, draftThread]) => [threadKey, toHydratedDraftThreadState(draftThread)],
          ),
        ) as Record<string, DraftThreadState>
        return {
          ...currentState,
          draftsByThreadKey,
          draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            normalizedPersisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        }
      },
    },
  ),
)

export const useComposerDraftStore = composerDraftStore

export function clearComposerDraftsEnvironment(environmentId: EnvironmentId): void
{
  useComposerDraftStore.setState((state) =>
  {
    const removedThreadKeys = new Set<string>()

    for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey))
    {
      if (draftThread.environmentId === environmentId)
      {
        removedThreadKeys.add(threadKey)
      }
    }
    for (const threadKey of Object.keys(state.draftsByThreadKey))
    {
      if (parseScopedThreadKey(threadKey)?.environmentId === environmentId)
      {
        removedThreadKeys.add(threadKey)
      }
    }
    for (const [logicalProjectKey, threadKey] of Object.entries(
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    ))
    {
      if (parseScopedProjectKey(logicalProjectKey)?.environmentId === environmentId)
      {
        removedThreadKeys.add(threadKey)
      }
    }

    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([logicalProjectKey, threadKey]) =>
          parseScopedProjectKey(logicalProjectKey)?.environmentId !== environmentId &&
          !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, string>
    const nextDraftThreads = Object.fromEntries(
      Object.entries(state.draftThreadsByThreadKey).filter(
        ([threadKey, draftThread]) =>
          draftThread.environmentId !== environmentId && !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, DraftThreadState>
    const nextDrafts = Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([threadKey, draft]) =>
      {
        if (!removedThreadKeys.has(threadKey))
        {
          return true
        }
        revokeDraftThreadPreviewUrls(draft)
        return false
      }),
    ) as Record<string, ComposerThreadDraftState>

    return {
      draftsByThreadKey: nextDrafts,
      draftThreadsByThreadKey: nextDraftThreads,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
    }
  })
  composerDebouncedStorage.flush()
}

export function useComposerThreadDraft(threadRef: ComposerThreadTarget): ComposerThreadDraftState
{
  return useComposerDraftStore((state) =>
  {
    return getComposerDraftState(state, threadRef) ?? EMPTY_THREAD_DRAFT
  })
}

export function useComposerDraftModelState(
  threadRef: ComposerThreadTarget,
): ComposerDraftModelState
{
  return useComposerDraftStore(
    useShallow((state) =>
    {
      const draft = getComposerDraftState(state, threadRef)
      return draft
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE
    }),
  )
}

export function useEffectiveComposerModelState(input: {
  threadRef?: ComposerThreadTarget
  draftId?: DraftId
  providers: ReadonlyArray<ServerProvider>
  selectedProvider: ProviderDriverKind
  // when supplied, the draft's saved selection for this instance takes
  // precedence over the driver-kind bucket — so a custom `codex_personal`
  // instance reads its own model, not the default Codex's.
  selectedInstanceId?: ProviderInstanceId | null | undefined
  threadModelSelection: ModelSelection | null | undefined
  projectModelSelection: ModelSelection | null | undefined
  settings: UnifiedSettings
}): EffectiveComposerModelState
{
  const draft = useComposerDraftModelState(input.threadRef ?? input.draftId ?? DraftId.make(''))

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        providers: input.providers,
        selectedProvider: input.selectedProvider,
        selectedInstanceId: input.selectedInstanceId,
        threadModelSelection: input.threadModelSelection,
        projectModelSelection: input.projectModelSelection,
        settings: input.settings,
      }),
    [
      draft,
      input.providers,
      input.settings,
      input.projectModelSelection,
      input.selectedInstanceId,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  )
}

// mark a draft thread as promoting once the server has materialized the same thread id.
//
// use the single-thread helper for live `thread.created` events and the
// iterable helper for bootstrap/recovery paths that discover multiple server
// threads at once.
export function markPromotedDraftThread(threadId: ThreadId): void
{
  const store = useComposerDraftStore.getState()
  const draftThreadTargets: ComposerThreadTarget[] = []
  for (const [draftId, draftThread] of Object.entries(store.draftThreadsByThreadKey))
  {
    if (draftThread.threadId === threadId)
    {
      draftThreadTargets.push(DraftId.make(draftId))
    }
  }
  if (draftThreadTargets.length === 0)
  {
    return
  }
  for (const draftThreadTarget of draftThreadTargets)
  {
    store.markDraftThreadPromoting(draftThreadTarget)
  }
}

export function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void
{
  const draftStore = useComposerDraftStore.getState()
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey))
  {
    if (
      draftThread.environmentId === threadRef.environmentId &&
      draftThread.threadId === threadRef.threadId
    )
    {
      draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef)
    }
  }
}

export function markPromotedDraftThreads(serverThreadIds: Iterable<ThreadId>): void
{
  for (const threadId of serverThreadIds)
  {
    markPromotedDraftThread(threadId)
  }
}

export function markPromotedDraftThreadsByRef(serverThreadRefs: Iterable<ScopedThreadRef>): void
{
  for (const threadRef of serverThreadRefs)
  {
    markPromotedDraftThreadByRef(threadRef)
  }
}

export function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void
{
  const draftStore = useComposerDraftStore.getState()
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey))
  {
    const promotedRef = draftThread.promotedTo
    const matches = promotedRef
      ? promotedRef.environmentId === threadRef.environmentId &&
        promotedRef.threadId === threadRef.threadId
      : draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId
    if (matches)
    {
      const target = DraftId.make(draftId)
      draftStore.markDraftThreadPromoting(target, threadRef)
      draftStore.finalizePromotedDraftThread(target)
    }
  }
}

export function finalizePromotedDraftThreadsByRef(
  serverThreadRefs: Iterable<ScopedThreadRef>,
): void
{
  for (const threadRef of serverThreadRefs)
  {
    finalizePromotedDraftThreadByRef(threadRef)
  }
}
