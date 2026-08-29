// tests/apps/web/composerDraftStore.test.ts
// covers persisted composer draft defaults

import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from '@t3tools/client-runtime/environment'
import * as Schema from 'effect/Schema'
import {
  defaultInstanceIdForDriver,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ProviderOptionSelection,
} from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'

// the composer draft's `modelSelectionByProvider` and
// `stickyModelSelectionByProvider` maps are keyed by `ProviderInstanceId`
// in production; these aliases keep the legacy-key migration tests concise.
const CODEX_INSTANCE = ProviderInstanceId.make('codex')
const CODEX_SECONDARY_INSTANCE = ProviderInstanceId.make('codex_secondary')
const CLAUDE_AGENT_INSTANCE = ProviderInstanceId.make('claudeAgent')
const CURSOR_INSTANCE = ProviderInstanceId.make('cursor')
const CODEX_DRIVER = ProviderDriverKind.make('codex')
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make('claudeAgent')
const CURSOR_DRIVER = ProviderDriverKind.make('cursor')

type ProviderOptionSelectionBag = ReadonlyArray<ProviderOptionSelection>
type ProviderOptionSelectionsByProvider = Partial<Record<string, ProviderOptionSelectionBag>>

function toSelections(
  options: Record<string, string | boolean | undefined> | undefined,
): ReadonlyArray<ProviderOptionSelection>
{
  const result: Array<ProviderOptionSelection> = []
  if (!options) return result
  for (const [id, value] of Object.entries(options))
  {
    if (typeof value === 'string' || typeof value === 'boolean')
    {
      result.push({ id, value })
    }
  }
  return result
}

function selectionsByProvider(
  options: Partial<Record<ProviderDriverKind, Record<string, string | boolean | undefined>>>,
): ProviderOptionSelectionsByProvider
{
  const result: ProviderOptionSelectionsByProvider = {}
  for (const [provider, bag] of Object.entries(options) as Array<
    [ProviderDriverKind, Record<string, string | boolean | undefined>]
  >)
  {
    result[provider] = toSelections(bag)
  }
  return result
}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  clearComposerDraftsEnvironment,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThread,
  markPromotedDraftThreadByRef,
  markPromotedDraftThreads,
  markPromotedDraftThreadsByRef,
  type ComposerImageAttachment,
  type ComposerFileAttachment,
  composerFileNeedsReattach,
  useComposerDraftStore,
  DraftId,
} from '../../../apps/web/src/composerDraftStore'
import {
  removeLocalStorageItem,
  setLocalStorageItem,
} from '../../../apps/web/src/hooks/useLocalStorage'
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from '../../../apps/web/src/lib/terminalContext'

function makeImage(input: {
  id: string
  previewUrl: string
  name?: string
  mimeType?: string
  sizeBytes?: number
  lastModified?: number
}): ComposerImageAttachment
{
  const name = input.name ?? 'image.png'
  const mimeType = input.mimeType ?? 'image/png'
  const sizeBytes = input.sizeBytes ?? 4
  const lastModified = input.lastModified ?? 1_700_000_000_000
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  })
  return {
    type: 'image',
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  }
}

function makeTerminalContext(input: {
  id: string
  text?: string
  terminalId?: string
  terminalLabel?: string
  lineStart?: number
  lineEnd?: number
}): TerminalContextDraft
{
  return {
    id: input.id,
    threadId: ThreadId.make('thread-dedupe'),
    terminalId: input.terminalId ?? 'default',
    terminalLabel: input.terminalLabel ?? 'Terminal 1',
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? 'git status\nOn branch main',
    createdAt: '2026-03-13T12:00:00.000Z',
  }
}

function resetComposerDraftStore()
{
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  })
}

function modelSelection(
  provider: ProviderDriverKind,
  model: string,
  options?: Record<string, string | boolean | undefined>,
): ModelSelection
{
  return createModelSelection(defaultInstanceIdForDriver(provider), model, toSelections(options))
}

function providerModelOptions(
  options: Partial<Record<string, Record<string, string | boolean | undefined>>>,
): ProviderOptionSelectionsByProvider
{
  return selectionsByProvider(options)
}

const TEST_ENVIRONMENT_ID = EnvironmentId.make('environment-local')
const OTHER_TEST_ENVIRONMENT_ID = EnvironmentId.make('environment-remote')
const LEGACY_TEST_ENVIRONMENT_ID = EnvironmentId.make('__legacy__')

function threadKeyFor(
  threadId: ThreadId,
  environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID,
): string
{
  if (environmentId === LEGACY_TEST_ENVIRONMENT_ID)
  {
    return threadId
  }
  return scopedThreadKey(scopeThreadRef(environmentId, threadId))
}

function draftFor(threadId: ThreadId, environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID)
{
  const store = useComposerDraftStore.getState().draftsByThreadKey
  return store[threadKeyFor(threadId, environmentId)] ?? store[threadId] ?? undefined
}

function draftByKey(key: string)
{
  return useComposerDraftStore.getState().draftsByThreadKey[key] ?? undefined
}

describe('composerDraftStore files', () =>
{
  beforeEach(() => resetComposerDraftStore())

  it('round-trips uploaded IDs and unfinished markers without persisting local bytes or losing explicit intent', () =>
  {
    const target = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make('file-roundtrip'))
    const bytes = new File(['pdf'], 'notes.pdf', { type: 'application/pdf' })
    const file: ComposerFileAttachment = {
      type: 'file',
      id: 'uploaded',
      name: bytes.name,
      mimeType: bytes.type,
      sizeBytes: bytes.size,
      file: bytes,
    }
    const store = useComposerDraftStore.getState()
    store.addFiles(target, [file, { ...file, id: 'unfinished', name: 'other.pdf' }])
    store.setFileUpload(target, file.id, TEST_ENVIRONMENT_ID, 'server-copy')
    store.setModelSelection(
      target,
      { instanceId: CODEX_INSTANCE, model: 'custom/model' },
      { explicit: true },
    )
    const { partialize, merge } = useComposerDraftStore.persist.getOptions()
    const persisted = partialize!(useComposerDraftStore.getState())
    expect(JSON.stringify(persisted)).not.toContain('"file":')
    const restored = merge!(persisted, useComposerDraftStore.getInitialState())
    const draft = restored.draftsByThreadKey[scopedThreadKey(target)]!
    expect(draft.modelSelectionExplicit).toBe(true)
    expect(draft.files[0]).toMatchObject({
      file: null,
      uploadedAttachmentId: 'server-copy',
      uploadEnvironmentId: TEST_ENVIRONMENT_ID,
    })
    expect(composerFileNeedsReattach(draft.files[1]!)).toBe(true)
    useComposerDraftStore.setState(restored)
    store.addFiles(target, [{ ...file, id: 'reattached', name: 'other.pdf' }])
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.files).toHaveLength(2)
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.files[1]?.file).toBe(bytes)
  })

  it('keeps file-only server copies in their environment while moving byte-backed files and enforcing the combined cap', () =>
  {
    const source = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make('file-source'))
    const destination = scopeThreadRef(
      EnvironmentId.make('other-file-environment'),
      ThreadId.make('file-target'),
    )
    const bytes = new File(['pdf'], 'move.pdf', { type: 'application/pdf' })
    const file: ComposerFileAttachment = {
      type: 'file',
      id: 'local',
      name: bytes.name,
      mimeType: bytes.type,
      sizeBytes: bytes.size,
      file: bytes,
      uploadedAttachmentId: 'old-copy',
      uploadEnvironmentId: TEST_ENVIRONMENT_ID,
    }
    const store = useComposerDraftStore.getState()
    store.addFiles(source, [file, { ...file, id: 'server-only', name: 'keep.pdf', file: null }])
    store.moveComposerPromptAndImages(source, destination)
    expect(store.getComposerDraft(source)?.files.map((entry) => entry.id)).toEqual(['server-only'])
    expect(store.getComposerDraft(destination)?.files[0]).toMatchObject({
      id: 'local',
      file: bytes,
    })
    expect(store.getComposerDraft(destination)?.files[0]?.uploadedAttachmentId).toBeUndefined()
    store.addImages(
      destination,
      Array.from({ length: 8 }, (_, index) =>
        makeImage({ id: `limit-${index}`, name: `image-${index}.png`, previewUrl: '' }),
      ),
    )
    expect(
      store.getComposerDraft(destination)!.images.length +
        store.getComposerDraft(destination)!.files.length,
    ).toBe(8)
  })
})

describe('composerDraftStore addImages', () =>
{
  const threadId = ThreadId.make('thread-dedupe')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>

  beforeEach(() =>
  {
    resetComposerDraftStore()
    originalRevokeObjectUrl = URL.revokeObjectURL
    revokeSpy = vi.fn()
    URL.revokeObjectURL = revokeSpy
  })

  afterEach(() =>
  {
    URL.revokeObjectURL = originalRevokeObjectUrl
  })

  it('deduplicates identical images in one batch by file signature', () =>
  {
    const first = makeImage({
      id: 'img-1',
      previewUrl: 'blob:first',
      name: 'same.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      lastModified: 12345,
    })
    const duplicate = makeImage({
      id: 'img-2',
      previewUrl: 'blob:duplicate',
      name: 'same.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      lastModified: 12345,
    })

    useComposerDraftStore.getState().addImages(threadRef, [first, duplicate])

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.images.map((image) => image.id)).toEqual(['img-1'])
    expect(revokeSpy).toHaveBeenCalledWith('blob:duplicate')
  })

  it('deduplicates against existing images across calls by file signature', () =>
  {
    const first = makeImage({
      id: 'img-a',
      previewUrl: 'blob:a',
      name: 'same.png',
      mimeType: 'image/png',
      sizeBytes: 9,
      lastModified: 777,
    })
    const duplicateLater = makeImage({
      id: 'img-b',
      previewUrl: 'blob:b',
      name: 'same.png',
      mimeType: 'image/png',
      sizeBytes: 9,
      lastModified: 999,
    })

    useComposerDraftStore.getState().addImage(threadRef, first)
    useComposerDraftStore.getState().addImage(threadRef, duplicateLater)

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.images.map((image) => image.id)).toEqual(['img-a'])
    expect(revokeSpy).toHaveBeenCalledWith('blob:b')
  })

  it('does not revoke blob URLs that are still used by an accepted duplicate image', () =>
  {
    const first = makeImage({
      id: 'img-shared',
      previewUrl: 'blob:shared',
    })
    const duplicateSameUrl = makeImage({
      id: 'img-shared',
      previewUrl: 'blob:shared',
    })

    useComposerDraftStore.getState().addImages(threadRef, [first, duplicateSameUrl])

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.images.map((image) => image.id)).toEqual(['img-shared'])
    expect(revokeSpy).not.toHaveBeenCalledWith('blob:shared')
  })
})

describe('composerDraftStore clearComposerContent', () =>
{
  const threadId = ThreadId.make('thread-clear')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>

  beforeEach(() =>
  {
    resetComposerDraftStore()
    originalRevokeObjectUrl = URL.revokeObjectURL
    revokeSpy = vi.fn()
    URL.revokeObjectURL = revokeSpy
  })

  afterEach(() =>
  {
    URL.revokeObjectURL = originalRevokeObjectUrl
  })

  it('does not revoke blob preview URLs when clearing composer content', () =>
  {
    const first = makeImage({
      id: 'img-optimistic',
      previewUrl: 'blob:optimistic',
    })
    useComposerDraftStore.getState().addImage(threadRef, first)

    useComposerDraftStore.getState().clearComposerContent(threadRef)

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft).toBeUndefined()
    expect(revokeSpy).not.toHaveBeenCalledWith('blob:optimistic')
  })
})

describe('composerDraftStore moveComposerPromptAndImages', () =>
{
  const sourceDraftId = DraftId.make('draft-move-source')
  const destinationDraftId = DraftId.make('draft-move-destination')
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>

  beforeEach(() =>
  {
    resetComposerDraftStore()
    originalRevokeObjectUrl = URL.revokeObjectURL
    revokeSpy = vi.fn()
    URL.revokeObjectURL = revokeSpy
  })

  afterEach(() =>
  {
    URL.revokeObjectURL = originalRevokeObjectUrl
  })

  it('moves prompt and images without revoking their preview URLs', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setPrompt(sourceDraftId, 'fix the login redirect')
    store.addImages(sourceDraftId, [makeImage({ id: 'img-move', previewUrl: 'blob:move' })])

    store.moveComposerPromptAndImages(sourceDraftId, destinationDraftId)

    expect(draftByKey(sourceDraftId)).toBeUndefined()
    const destination = draftByKey(destinationDraftId)
    expect(destination?.prompt).toBe('fix the login redirect')
    expect(destination?.images.map((image) => image.id)).toEqual(['img-move'])
    expect(revokeSpy).not.toHaveBeenCalled()
  })

  it('leaves session-bound contexts on the source draft', () =>
  {
    const sourceThreadId = ThreadId.make('thread-move-source')
    const sourceThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, sourceThreadId)
    const store = useComposerDraftStore.getState()
    store.addTerminalContext(sourceThreadRef, makeTerminalContext({ id: 'ctx-stay' }))
    store.setPrompt(sourceThreadRef, `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} explain this error`)

    store.moveComposerPromptAndImages(sourceThreadRef, destinationDraftId)

    expect(draftFor(sourceThreadId, TEST_ENVIRONMENT_ID)?.terminalContexts).toHaveLength(1)
    expect(draftFor(sourceThreadId, TEST_ENVIRONMENT_ID)?.prompt).toBe(
      INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
    )
    expect(draftByKey(destinationDraftId)?.prompt).toBe(' explain this error')
  })

  it('does nothing when source and destination resolve to the same draft', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setPrompt(sourceDraftId, 'keep me')

    store.moveComposerPromptAndImages(sourceDraftId, sourceDraftId)

    expect(draftByKey(sourceDraftId)?.prompt).toBe('keep me')
  })
})

describe('composerDraftStore syncPersistedAttachments', () =>
{
  const threadId = ThreadId.make('thread-sync-persisted')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)

  beforeEach(() =>
  {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY)
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    })
  })

  afterEach(() =>
  {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY)
  })

  it('treats malformed persisted draft storage as empty', async () =>
  {
    const image = makeImage({
      id: 'img-persisted',
      previewUrl: 'blob:persisted',
    })
    useComposerDraftStore.getState().addImage(threadRef, image)
    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 2,
        state: {
          draftsByThreadId: {
            [threadId]: {
              attachments: 'not-an-array',
            },
          },
        },
      },
      Schema.Unknown,
    )

    useComposerDraftStore.getState().syncPersistedAttachments(threadRef, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      },
    ])
    await Promise.resolve()

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.persistedAttachments).toEqual([])
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.nonPersistedImageIds).toEqual([image.id])
  })
})

describe('composerDraftStore terminal contexts', () =>
{
  const threadId = ThreadId.make('thread-dedupe')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)

  beforeEach(() =>
  {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    })
  })

  it('deduplicates identical terminal contexts by selection signature', () =>
  {
    const first = makeTerminalContext({ id: 'ctx-1' })
    const duplicate = makeTerminalContext({ id: 'ctx-2' })

    useComposerDraftStore.getState().addTerminalContexts(threadRef, [first, duplicate])

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(['ctx-1'])
  })

  it('clears terminal contexts when clearing composer content', () =>
  {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadRef, makeTerminalContext({ id: 'ctx-1' }))

    useComposerDraftStore.getState().clearComposerContent(threadRef)

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined()
  })

  it('inserts terminal contexts at the requested inline prompt position', () =>
  {
    const firstInsertion = insertInlineTerminalContextPlaceholder('alpha beta', 6)
    const secondInsertion = insertInlineTerminalContextPlaceholder(firstInsertion.prompt, 0)

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(
          threadRef,
          firstInsertion.prompt,
          makeTerminalContext({ id: 'ctx-1' }),
          firstInsertion.contextIndex,
        ),
    ).toBe(true)
    expect(
      useComposerDraftStore.getState().insertTerminalContext(
        threadRef,
        secondInsertion.prompt,
        makeTerminalContext({
          id: 'ctx-2',
          terminalLabel: 'Terminal 2',
          lineStart: 9,
          lineEnd: 10,
        }),
        secondInsertion.contextIndex,
      ),
    ).toBe(true)

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.prompt).toBe(
      `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} alpha ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} beta`,
    )
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(['ctx-2', 'ctx-1'])
  })

  it('omits terminal context text from persisted drafts', () =>
  {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadRef, makeTerminalContext({ id: 'ctx-persist' }))

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown
      }
    }
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { terminalContexts?: Array<Record<string, unknown>> }>
    }

    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.terminalContexts?.[0],
      'Expected terminal context metadata to be persisted.',
    ).toMatchObject({
      id: 'ctx-persist',
      terminalId: 'default',
      terminalLabel: 'Terminal 1',
      lineStart: 4,
      lineEnd: 5,
    })
    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.terminalContexts?.[0]?.text,
    ).toBeUndefined()
  })

  it('hydrates persisted terminal contexts without in-memory snapshot text', () =>
  {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>
      }
    }
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
            attachments: [],
            terminalContexts: [
              {
                id: 'ctx-rehydrated',
                threadId,
                createdAt: '2026-03-13T12:00:00.000Z',
                terminalId: 'default',
                terminalLabel: 'Terminal 1',
                lineStart: 4,
                lineEnd: 5,
              },
            ],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    )

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]?.terminalContexts).toMatchObject([
      {
        id: 'ctx-rehydrated',
        terminalId: 'default',
        terminalLabel: 'Terminal 1',
        lineStart: 4,
        lineEnd: 5,
        text: '',
      },
    ])
  })

  it('sanitizes malformed persisted drafts during merge', () =>
  {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>
      }
    }
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: '',
            attachments: 'not-an-array',
            terminalContexts: 'not-an-array',
            provider: 'bogus-provider',
            modelOptions: 'not-an-object',
          },
        },
        draftThreadsByThreadId: 'not-an-object',
        projectDraftThreadIdByProjectKey: 'not-an-object',
      },
      useComposerDraftStore.getInitialState(),
    )

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]).toBeUndefined()
    expect(mergedState.draftThreadsByThreadKey).toEqual({})
    expect(mergedState.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({})
  })
})

describe('composerDraftStore element contexts', () =>
{
  const threadId = ThreadId.make('thread-element')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)
  const baseSelection = {
    pageUrl: 'https://example.com/dashboard',
    pageTitle: 'Dashboard',
    tagName: 'button',
    selector: 'button.submit',
    htmlPreview: '<button>Save</button>',
    componentName: 'SubmitButton',
    source: {
      functionName: 'SubmitButton',
      fileName: '/repo/Button.tsx',
      lineNumber: 12,
      columnNumber: 5,
    },
    styles: '.submit { color: white; }',
  } as const

  beforeEach(() =>
  {
    resetComposerDraftStore()
  })

  it('adds an element context and stamps id + threadId + pickedAt', () =>
  {
    const accepted = useComposerDraftStore.getState().addElementContext(threadRef, baseSelection)
    expect(accepted).toBe(true)
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.elementContexts).toHaveLength(1)
    const entry = draft?.elementContexts[0]!
    expect(entry.id.startsWith('el_')).toBe(true)
    expect(entry.threadId).toBe(threadId)
    expect(entry.pickedAt.length).toBeGreaterThan(0)
    expect(entry.componentName).toBe('SubmitButton')
  })

  it('dedupes by selector + tag + componentName + pageUrl signature', () =>
  {
    const store = useComposerDraftStore.getState()
    expect(store.addElementContext(threadRef, baseSelection)).toBe(true)
    const second = store.addElementContext(threadRef, {
      ...baseSelection,
      htmlPreview: '<button>Save 2</button>',
    })
    expect(second).toBe(false)
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.elementContexts).toHaveLength(1)
  })

  it('removeElementContext drops by id + leaves siblings intact', () =>
  {
    const store = useComposerDraftStore.getState()
    store.addElementContext(threadRef, baseSelection)
    store.addElementContext(threadRef, { ...baseSelection, selector: 'button.cancel' })
    const ids = draftFor(threadId, TEST_ENVIRONMENT_ID)!.elementContexts.map((c) => c.id)
    store.removeElementContext(threadRef, ids[0]!)
    const remaining = draftFor(threadId, TEST_ENVIRONMENT_ID)?.elementContexts
    expect(remaining?.map((c) => c.id)).toEqual([ids[1]])
  })

  it('setElementContexts replaces the slice and clearComposerContent wipes it', () =>
  {
    const store = useComposerDraftStore.getState()
    store.addElementContext(threadRef, baseSelection)
    store.setElementContexts(threadRef, [])
    // fully empty draft should be removed via shouldRemoveDraft.
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined()

    store.addElementContext(threadRef, baseSelection)
    store.clearComposerContent(threadRef)
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined()
  })

  it('persists element contexts via the partializer (round-trippable)', () =>
  {
    useComposerDraftStore.getState().addElementContext(threadRef, baseSelection)
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown
      }
    }
    const persisted = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { elementContexts?: Array<Record<string, unknown>> }>
    }
    const entry =
      persisted.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.elementContexts?.[0]
    expect(entry).toMatchObject({
      pageUrl: baseSelection.pageUrl,
      tagName: baseSelection.tagName,
      selector: baseSelection.selector,
      componentName: baseSelection.componentName,
    })
    // persistence does NOT include htmlPreview / styles oversize-clamping —
    // that happens at normalization time, before the value reaches the store.
    expect(typeof entry?.htmlPreview).toBe('string')
  })
})

describe('composerDraftStore review comments', () =>
{
  const threadId = ThreadId.make('thread-review-comment')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)
  const comment = {
    id: 'comment-1',
    sectionId: 'file:src/app.ts',
    sectionTitle: 'File comment',
    filePath: 'src/app.ts',
    startIndex: 1,
    endIndex: 2,
    rangeLabel: 'L2 to L3',
    text: 'Keep this configurable.',
    diff: '@@ -2,2 +2,2 @@\n two\n three',
  } as const

  beforeEach(() =>
  {
    resetComposerDraftStore()
  })

  it('upserts and removes review comments by id', () =>
  {
    const store = useComposerDraftStore.getState()
    store.addReviewComment(threadRef, comment)
    store.addReviewComment(threadRef, { ...comment, text: 'Updated comment.' })

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.reviewComments).toEqual([
      { ...comment, text: 'Updated comment.' },
    ])

    store.removeReviewComment(threadRef, comment.id)
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined()
  })

  it('persists review comments and clears them with composer content', () =>
  {
    const store = useComposerDraftStore.getState()
    store.addReviewComment(threadRef, comment)
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown
      }
    }
    const persisted = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { reviewComments?: Array<Record<string, unknown>> }>
    }

    expect(
      persisted.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.reviewComments?.[0],
    ).toMatchObject(comment)

    store.clearComposerContent(threadRef)
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined()
  })

  it('stores review comments against a new-thread draft id', () =>
  {
    const draftId = DraftId.make('draft-review-comment')
    useComposerDraftStore.getState().addReviewComment(draftId, comment)

    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.reviewComments).toEqual([
      comment,
    ])
  })
})

describe('composerDraftStore project draft thread mapping', () =>
{
  const projectId = ProjectId.make('project-a')
  const otherProjectId = ProjectId.make('project-b')
  const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, projectId)
  const otherProjectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, otherProjectId)
  const remoteProjectRef = scopeProjectRef(OTHER_TEST_ENVIRONMENT_ID, projectId)
  const threadId = ThreadId.make('thread-a')
  const otherThreadId = ThreadId.make('thread-b')
  const draftId = DraftId.make('draft-a')
  const otherDraftId = DraftId.make('draft-b')
  const sharedDraftId = DraftId.make('draft-shared')
  const localDraftId = DraftId.make('draft-local')
  const remoteDraftId = DraftId.make('draft-remote')

  beforeEach(() =>
  {
    resetComposerDraftStore()
  })

  it('clears composer data for one environment without touching another', () =>
  {
    const store = useComposerDraftStore.getState()
    const localThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)
    const remoteThreadRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, otherThreadId)
    const originalRevokeObjectUrl = URL.revokeObjectURL
    const revokeSpy = vi.fn<(url: string) => void>()
    URL.revokeObjectURL = revokeSpy

    try
    {
      store.setProjectDraftThreadId(projectRef, localDraftId, { threadId })
      store.setProjectDraftThreadId(remoteProjectRef, remoteDraftId, {
        threadId: otherThreadId,
      })
      store.setPrompt(localDraftId, 'local draft')
      store.setPrompt(remoteDraftId, 'remote draft')
      store.addImage(localDraftId, makeImage({ id: 'img-local', previewUrl: 'blob:local-draft' }))
      store.setPrompt(localThreadRef, 'local thread draft')
      store.setPrompt(remoteThreadRef, 'remote thread draft')

      clearComposerDraftsEnvironment(TEST_ENVIRONMENT_ID)

      const next = useComposerDraftStore.getState()
      expect(next.getDraftThreadByProjectRef(projectRef)).toBeNull()
      expect(next.getDraftThreadByProjectRef(remoteProjectRef)).not.toBeNull()
      expect(next.getComposerDraft(localDraftId)).toBeNull()
      expect(next.getComposerDraft(remoteDraftId)?.prompt).toBe('remote thread draft')
      expect(next.getComposerDraft(localThreadRef)).toBeNull()
      expect(next.getComposerDraft(remoteThreadRef)?.prompt).toBe('remote thread draft')
      expect(revokeSpy).toHaveBeenCalledWith('blob:local-draft')
    }
    finally
    {
      URL.revokeObjectURL = originalRevokeObjectUrl
    }
  })

  it('stores and reads project draft thread ids via actions', () =>
  {
    const store = useComposerDraftStore.getState()
    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(store.getDraftThread(draftId)).toBeNull()

    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: 'feature/test',
      worktreePath: '/tmp/worktree-test',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toMatchObject({
      threadId,
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      logicalProjectKey: scopedProjectKey(projectRef),
      branch: 'feature/test',
      worktreePath: '/tmp/worktree-test',
      envMode: 'worktree',
      runtimeMode: 'full-access',
      collaborationMode: { baseMode: 'default', orchestrate: false },
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      logicalProjectKey: scopedProjectKey(projectRef),
      branch: 'feature/test',
      worktreePath: '/tmp/worktree-test',
      envMode: 'worktree',
      runtimeMode: 'full-access',
      collaborationMode: { baseMode: 'default', orchestrate: false },
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('rotates a failed bootstrap thread id without losing its draft', () =>
  {
    const store = useComposerDraftStore.getState()
    const retryThreadId = ThreadId.make('thread-retry')
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: 'feature/test',
      worktreePath: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      envMode: 'worktree',
      startFromOrigin: true,
      runtimeMode: 'full-access',
      collaborationMode: { baseMode: 'default', orchestrate: false },
    })
    store.setPrompt(draftId, 'keep this prompt')
    markPromotedDraftThread(threadId)

    store.setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
      threadId: retryThreadId,
      createdAt: '2026-01-01T00:01:00.000Z',
    })

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      threadId: retryThreadId,
      branch: 'feature/test',
      worktreePath: null,
      createdAt: '2026-01-01T00:01:00.000Z',
      envMode: 'worktree',
      startFromOrigin: true,
      runtimeMode: 'full-access',
      collaborationMode: { baseMode: 'default', orchestrate: false },
      promotedTo: null,
    })
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      'keep this prompt',
    )
  })

  it('persists Plan with Orchestrate in draft thread context', () =>
  {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown
      }
    }
    const { merge, partialize } = persistApi.getOptions()
    useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      collaborationMode: { baseMode: 'plan', orchestrate: true },
    })

    const persisted = partialize(useComposerDraftStore.getState()) as {
      draftThreadsByThreadKey: Record<string, { interactionMode: string; orchestrate?: boolean }>
    }
    expect(Object.values(persisted.draftThreadsByThreadKey)).toContainEqual(
      expect.objectContaining({ interactionMode: 'plan', orchestrate: true }),
    )

    const rehydrated = merge(persisted, useComposerDraftStore.getInitialState())
    expect(Object.values(rehydrated.draftThreadsByThreadKey)[0]?.collaborationMode).toEqual({
      baseMode: 'plan',
      orchestrate: true,
    })
  })

  it('clears only matching project draft mapping entries', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'hello')

    store.clearProjectDraftThreadById(projectRef, otherDraftId)
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    )

    store.clearProjectDraftThreadById(projectRef, draftId)
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull()
    expect(draftByKey(draftId)).toBeUndefined()
  })

  it('clears project draft mapping by project id', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'hello')
    store.clearProjectDraftThreadId(projectRef)
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull()
    expect(draftByKey(draftId)).toBeUndefined()
  })

  it("revokes draft image blob URLs when clearing a project's draft thread", () =>
  {
    const store = useComposerDraftStore.getState()
    const originalRevokeObjectUrl = URL.revokeObjectURL
    const revokeSpy = vi.fn<(url: string) => void>()
    URL.revokeObjectURL = revokeSpy

    try
    {
      store.setProjectDraftThreadId(projectRef, draftId, { threadId })
      store.addImage(draftId, makeImage({ id: 'img-project-clear', previewUrl: 'blob:clear' }))

      store.clearProjectDraftThreadId(projectRef)

      expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
      expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull()
      expect(revokeSpy).toHaveBeenCalledWith('blob:clear')

      // same revoke path via clear-by-id API.
      store.setProjectDraftThreadId(projectRef, draftId, { threadId })
      store.addImage(
        draftId,
        makeImage({ id: 'img-project-clear-by-id', previewUrl: 'blob:clear-by-id' }),
      )
      store.clearProjectDraftThreadById(projectRef, draftId)

      expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
      expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull()
      expect(revokeSpy).toHaveBeenCalledWith('blob:clear-by-id')
    }
    finally
    {
      URL.revokeObjectURL = originalRevokeObjectUrl
    }
  })

  it('clears orphaned composer drafts when remapping a project to a new draft thread', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'orphan me')

    store.setProjectDraftThreadId(projectRef, otherDraftId, { threadId: otherThreadId })

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      otherThreadId,
    )
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull()
    expect(draftByKey(draftId)).toBeUndefined()
  })

  it('keeps composer drafts when the thread is still mapped by another project', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setProjectDraftThreadId(otherProjectRef, sharedDraftId, { threadId })
    store.setPrompt(sharedDraftId, 'keep me')

    store.clearProjectDraftThreadId(projectRef)

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectRef(otherProjectRef)?.threadId,
    ).toBe(threadId)
    expect(draftByKey(sharedDraftId)?.prompt).toBe('keep me')
  })

  it('clears draft registration independently', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'remove me')
    store.clearDraftThread(draftId)
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull()
    expect(draftByKey(draftId)).toBeUndefined()
  })

  it('marks a promoted draft by thread id without deleting composer state', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'promote me')

    markPromotedDraftThread(threadId)

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.promotedTo).toEqual(
      scopeThreadRef(TEST_ENVIRONMENT_ID, threadId),
    )
    expect(draftByKey(draftId)?.prompt).toBe('promote me')
  })

  it('reads local draft composer state through a scoped thread ref', () =>
  {
    const store = useComposerDraftStore.getState()
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)

    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'scoped access')

    expect(store.getComposerDraft(draftId)?.prompt).toBe('scoped access')
    expect(store.getComposerDraft(threadRef)?.prompt).toBe('scoped access')
  })

  it('does not clear composer drafts for existing server threads during single or iterable promotion cleanup', () =>
  {
    const store = useComposerDraftStore.getState()
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)
    store.setPrompt(threadRef, 'keep me')

    markPromotedDraftThread(threadId)
    expect(useComposerDraftStore.getState().getDraftThread(threadRef)).toBeNull()
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe('keep me')

    markPromotedDraftThreads([threadId])
    expect(useComposerDraftStore.getState().getDraftThread(threadRef)).toBeNull()
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe('keep me')
  })

  it('marks promoted drafts from an iterable of server thread ids', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'promote me')
    store.setProjectDraftThreadId(otherProjectRef, otherDraftId, { threadId: otherThreadId })
    store.setPrompt(otherDraftId, 'keep me')

    markPromotedDraftThreads([threadId])

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.promotedTo).toEqual(
      scopeThreadRef(TEST_ENVIRONMENT_ID, threadId),
    )
    expect(draftByKey(draftId)?.prompt).toBe('promote me')
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectRef(otherProjectRef)?.threadId,
    ).toBe(otherThreadId)
    expect(draftByKey(otherDraftId)?.prompt).toBe('keep me')
  })

  it('marks every matching scoped draft when multiple environments share a thread id', () =>
  {
    const store = useComposerDraftStore.getState()
    const localThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)
    const remoteThreadRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId)

    store.setProjectDraftThreadId(projectRef, localDraftId, { threadId })
    store.setPrompt(localDraftId, 'local draft')
    store.setProjectDraftThreadId(remoteProjectRef, remoteDraftId, { threadId })
    store.setPrompt(remoteDraftId, 'remote draft')

    markPromotedDraftThread(threadId)

    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(store.getDraftThreadByProjectRef(remoteProjectRef)).toBeNull()
    expect(store.getDraftThreadByRef(localThreadRef)?.promotedTo).toEqual(localThreadRef)
    expect(store.getDraftThreadByRef(remoteThreadRef)?.promotedTo).toEqual(remoteThreadRef)
    expect(draftByKey(localDraftId)?.prompt).toBe('local draft')
    expect(draftByKey(remoteDraftId)?.prompt).toBe('remote draft')
  })

  it('only marks promoted drafts for matching environment refs via single or iterable ByRef APIs', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'promote me')
    const wrongEnvRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId)

    markPromotedDraftThreadByRef(wrongEnvRef)
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    )
    expect(draftByKey(draftId)?.prompt).toBe('promote me')

    markPromotedDraftThreadsByRef([wrongEnvRef])
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    )
    expect(draftByKey(draftId)?.prompt).toBe('promote me')
  })

  it('finalizes a promoted draft after the canonical thread route is active', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'promote me')
    markPromotedDraftThread(threadId)

    finalizePromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId))

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull()
    expect(draftByKey(draftId)).toBeUndefined()
  })

  it('finalizes a matching materialized draft even when promotion was not pre-marked', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, { threadId })
    store.setPrompt(draftId, 'promote me')

    finalizePromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId))

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull()
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull()
    expect(draftByKey(draftId)).toBeUndefined()
  })

  it('updates branch context on an existing draft thread', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: 'main',
      worktreePath: null,
    })
    store.setDraftThreadContext(draftId, {
      branch: 'feature/next',
      worktreePath: '/tmp/feature-next',
    })
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    )
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: 'feature/next',
      worktreePath: '/tmp/feature-next',
      envMode: 'worktree',
    })
  })

  it('stores the start-from-origin choice with the draft thread', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      envMode: 'worktree',
      startFromOrigin: true,
    })

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.startFromOrigin).toBe(true)

    store.setDraftThreadContext(draftId, { startFromOrigin: false })

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.startFromOrigin).toBe(false)
  })

  it('preserves existing branch and worktree when setProjectDraftThreadId receives undefined', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: 'main',
      worktreePath: '/tmp/main-worktree',
    })
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null
      worktreePath?: string | null
    }
    store.setProjectDraftThreadId(projectRef, draftId, runtimeUndefinedOptions)

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: 'main',
      worktreePath: '/tmp/main-worktree',
      envMode: 'worktree',
    })
  })

  it('preserves worktree env mode without a worktree path', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: 'feature/base',
      worktreePath: null,
      envMode: 'worktree',
    })
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null
      worktreePath?: string | null
      envMode?: 'local' | 'worktree'
    }
    store.setProjectDraftThreadId(projectRef, draftId, runtimeUndefinedOptions)

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: 'feature/base',
      worktreePath: null,
      envMode: 'worktree',
    })
  })

  it('clears branch and worktree but keeps env mode when moving a draft to another environment', () =>
  {
    const expected = {
      environmentId: OTHER_TEST_ENVIRONMENT_ID,
      projectId,
      branch: null,
      worktreePath: null,
      envMode: 'worktree',
      startFromOrigin: true,
    }
    const seedLocalWorktreeDraft = () =>
    {
      resetComposerDraftStore()
      useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
        threadId,
        branch: 'feature/local-only',
        worktreePath: '/tmp/local-worktree',
        envMode: 'worktree',
        startFromOrigin: true,
      })
    }

    seedLocalWorktreeDraft()
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), remoteProjectRef, draftId, {
        threadId,
      })
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject(expected)

    seedLocalWorktreeDraft()
    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      projectRef: remoteProjectRef,
    })
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject(expected)
  })
})

describe('composerDraftStore modelSelection', () =>
{
  const threadId = ThreadId.make('thread-model-options')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)

  beforeEach(() =>
  {
    resetComposerDraftStore()
  })

  it('stores a model selection in the draft', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, 'gpt-5.3-codex', {
        reasoningEffort: 'xhigh',
        fastMode: true,
      }),
    )

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(
      modelSelection(CODEX_DRIVER, 'gpt-5.3-codex', {
        reasoningEffort: 'xhigh',
        fastMode: true,
      }),
    )
  })

  it('keeps default-only model selections on the draft', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, 'gpt-5.4'))

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, 'gpt-5.4'))
  })

  it('replaces only the targeted provider options on the current model selection', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', {
        effort: 'max',
        fastMode: true,
      }),
    )
    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', {
        effort: 'max',
        fastMode: true,
      }),
    )

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
      {
        persistSticky: true,
      },
    )

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', {
        thinking: false,
      }),
    )
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', {
        thinking: false,
      }),
    )
  })

  it.each([
    {
      label: 'claude default-state overrides',
      setup: (store: ReturnType<typeof useComposerDraftStore.getState>) =>
      {
        store.setModelSelection(
          threadRef,
          modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', {
            effort: 'max',
          }),
        )
        store.setProviderModelOptions(
          threadRef,
          CLAUDE_AGENT_DRIVER,
          toSelections({ thinking: true }),
        )
      },
      expectedInstance: CLAUDE_AGENT_INSTANCE,
      expected: () =>
        modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', {
          thinking: true,
        }),
      expectEmptySticky: true,
    },
    {
      label: 'Cursor reset overrides',
      setup: (store: ReturnType<typeof useComposerDraftStore.getState>) =>
      {
        store.setModelSelection(
          threadRef,
          modelSelection(CURSOR_DRIVER, 'claude-opus-4-6', {
            reasoning: 'xhigh',
            fastMode: true,
            thinking: false,
          }),
        )
        store.setProviderModelOptions(
          threadRef,
          CURSOR_DRIVER,
          toSelections({ reasoning: 'medium', fastMode: false, thinking: true }),
        )
      },
      expectedInstance: CURSOR_INSTANCE,
      expected: () =>
        modelSelection(CURSOR_DRIVER, 'claude-opus-4-6', {
          reasoning: 'medium',
          fastMode: false,
          thinking: true,
        }),
      expectEmptySticky: false,
    },
  ])(
    'keeps explicit $label on the selection',
    ({ setup, expectedInstance, expected, expectEmptySticky }) =>
    {
      const store = useComposerDraftStore.getState()
      setup(store)
      expect(
        draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[expectedInstance],
      ).toEqual(expected())
      if (expectEmptySticky)
      {
        expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({})
      }
    },
  )
  it('preserves the selected Cursor model when only traits change', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setProviderModelOptions(threadRef, CURSOR_DRIVER, toSelections({ reasoning: 'high' }), {
      model: 'gpt-5.4',
      persistSticky: true,
    })

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, 'gpt-5.4', {
        reasoning: 'high',
      }),
    )
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, 'gpt-5.4', {
        reasoning: 'high',
      }),
    )
  })

  it.each([
    { label: 'omitted', options: undefined },
    { label: 'disabled', options: { persistSticky: false as const } },
  ])('updates only the draft when sticky persistence is $label', ({ options }) =>
  {
    const store = useComposerDraftStore.getState()

    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', { effort: 'max' }),
    )
    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', { effort: 'max' }),
    )

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
      options,
    )

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', {
        thinking: false,
      }),
    )
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', { effort: 'max' }))
  })

  it('does not clear other provider options when setting options for a single provider', () =>
  {
    const store = useComposerDraftStore.getState()

    // set options for both providers
    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: 'max' },
      }),
    )

    // now set options for only codex — claudeAgent should be untouched
    store.setModelOptions(threadRef, providerModelOptions({ codex: { reasoningEffort: 'xhigh' } }))

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelSelection(CODEX_INSTANCE, 'gpt-5.4', toSelections({ reasoningEffort: 'xhigh' }))
        .options,
    )
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelSelection(
        CLAUDE_AGENT_INSTANCE,
        'claude-opus-4-6',
        toSelections({ effort: 'max' }),
      ).options,
    )
  })

  it('preserves other provider options when switching the active model selection', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: 'max' },
      }),
    )

    store.setModelSelection(threadRef, modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6'))

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6', { effort: 'max' }),
    )
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelSelection(CODEX_INSTANCE, 'gpt-5.4', toSelections({ fastMode: true })).options,
    )
    expect(draft?.activeProvider).toBe('claudeAgent')
  })

  it('creates the first sticky snapshot from provider option changes', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, 'gpt-5.4'))

    store.setProviderModelOptions(threadRef, CODEX_DRIVER, toSelections({ fastMode: true }), {
      persistSticky: true,
    })

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, 'gpt-5.4', {
        fastMode: true,
      }),
    )
  })

  it('stores provider option changes on a selected custom instance', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: 'low' }),
      {
        instanceId: CODEX_SECONDARY_INSTANCE,
        model: 'gpt-5-codex',
        persistSticky: true,
      },
    )

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        instanceId: CODEX_SECONDARY_INSTANCE,
        options: [{ id: 'reasoningEffort', value: 'low' }],
      }),
    )
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE)
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe(CODEX_SECONDARY_INSTANCE)
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toBe(
      undefined,
    )
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        instanceId: CODEX_SECONDARY_INSTANCE,
        options: [{ id: 'reasoningEffort', value: 'low' }],
      }),
    )
  })
})

describe('composerDraftStore setModelSelection', () =>
{
  const threadId = ThreadId.make('thread-model')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)

  beforeEach(() =>
  {
    resetComposerDraftStore()
  })

  it('keeps explicit model overrides instead of coercing to null', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, 'gpt-5.3-codex'))

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, 'gpt-5.3-codex'))
  })

  // the projection reconciler passes a complete snapshot: options the thread no
  // longer projects have to disappear, or the next turn is sent with them.
  it('drops options the projection no longer carries under replaceOptions', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, 'gpt-5.3-codex', { reasoningEffort: 'high' }),
    )
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, 'gpt-5.4'), {
      replaceOptions: true,
    })

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, 'gpt-5.4'))
  })

  // a picker row changes the model only, so the options the user already chose
  // must survive it
  it('preserves existing options for a direct picker change', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, 'gpt-5.3-codex', { reasoningEffort: 'high' }),
    )
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, 'gpt-5.4'))

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, 'gpt-5.4', { reasoningEffort: 'high' }))
  })
})

describe('composerDraftStore sticky composer settings', () =>
{
  beforeEach(() =>
  {
    resetComposerDraftStore()
  })

  it('stores a sticky model selection', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setStickyModelSelection(
      modelSelection(CODEX_DRIVER, 'gpt-5.3-codex', {
        reasoningEffort: 'medium',
        fastMode: true,
      }),
    )

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, 'gpt-5.3-codex', {
        reasoningEffort: 'medium',
        fastMode: true,
      }),
    )
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe('codex')
  })

  it('normalizes empty sticky model options by dropping selection options', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setStickyModelSelection(modelSelection(CODEX_DRIVER, 'gpt-5.4'))

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, 'gpt-5.4'),
    )
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe('codex')
  })

  it('drops empty cursor model options when normalizing sticky state', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setStickyModelSelection(
      modelSelection(CURSOR_DRIVER, 'gpt-5.4', {
        reasoning: undefined,
        fastMode: undefined,
        thinking: undefined,
        contextWindow: undefined,
      }),
    )

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(modelSelection(CURSOR_DRIVER, 'gpt-5.4'))
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe('cursor')
  })

  it('applies sticky activeProvider to new drafts', () =>
  {
    const store = useComposerDraftStore.getState()
    const threadId = ThreadId.make('thread-sticky-active-provider')
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)

    store.setStickyModelSelection(modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6'))
    store.applyStickyState(threadRef)

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6'),
      },
      activeProvider: 'claudeAgent',
    })
  })

  it('uses project defaults above sticky state and replaces stale draft seeds on reuse', () =>
  {
    const store = useComposerDraftStore.getState()
    const draftId = DraftId.make('project-default-draft')
    const sticky = modelSelection(CODEX_DRIVER, 'gpt-5.4', { reasoningEffort: 'high' })
    const projectDefault = modelSelection(CODEX_DRIVER, 'gpt-5.3-codex')
    store.setStickyModelSelection(sticky)
    store.applyStickyState(draftId, projectDefault)
    expect(draftByKey(draftId)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(projectDefault)
    expect(draftByKey(draftId)?.modelSelectionExplicit).not.toBe(true)

    // an old viewed-thread seed must not become another precedence tier
    store.setModelSelection(draftId, modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6'))
    store.applyStickyState(draftId, null)
    expect(draftByKey(draftId)?.activeProvider).toBe(CODEX_INSTANCE)
    expect(draftByKey(draftId)?.modelSelectionByProvider).toEqual({ [CODEX_INSTANCE]: sticky })

    const updatedDefault = createModelSelection(CODEX_SECONDARY_INSTANCE, 'custom-project-model')
    store.applyStickyState(draftId, updatedDefault)
    expect(draftByKey(draftId)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE)
    expect(draftByKey(draftId)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE]).toEqual(
      updatedDefault,
    )
    store.applyStickyState(draftId, updatedDefault)
    expect(draftByKey(draftId)?.modelSelectionExplicit).not.toBe(true)

    resetComposerDraftStore()
    store.applyStickyState(draftId)
    expect(draftByKey(draftId)).toBeUndefined()
  })

  it('pins an identical human model re-selection and keeps unavailable custom choices', () =>
  {
    const store = useComposerDraftStore.getState()
    const draftId = DraftId.make('explicit-project-default-draft')
    const selection = createModelSelection(CODEX_SECONDARY_INSTANCE, 'temporarily-unavailable', [
      { id: 'reasoningEffort', value: 'high' },
    ])
    store.applyStickyState(draftId, selection)
    store.setModelSelection(draftId, selection, { explicit: true })
    expect(draftByKey(draftId)?.modelSelectionExplicit).toBe(true)

    store.setStickyModelSelection(modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6'))
    store.applyStickyState(draftId, modelSelection(CODEX_DRIVER, 'gpt-5.4'))
    expect(draftByKey(draftId)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE)
    expect(draftByKey(draftId)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE]).toEqual(
      selection,
    )
    store.clearComposerContent(draftId)
    expect(draftByKey(draftId)?.modelSelectionExplicit).toBe(true)
  })

  it.each([
    { label: 'added', initialOptions: undefined, nextOptions: { reasoningEffort: 'high' } },
    {
      label: 'changed',
      initialOptions: { reasoningEffort: 'low' },
      nextOptions: { reasoningEffort: 'high' },
    },
    { label: 'cleared', initialOptions: { reasoningEffort: 'low' }, nextOptions: undefined },
  ])('persists the project model when its traits are $label', ({ initialOptions, nextOptions }) =>
  {
    const store = useComposerDraftStore.getState()
    const draftId = DraftId.make('project-traits-draft')
    const nextDraftId = DraftId.make('next-no-default-draft')
    const projectDefault = createModelSelection(
      CODEX_SECONDARY_INSTANCE,
      'project-model',
      toSelections(initialOptions),
    )
    store.setStickyModelSelection(
      createModelSelection(
        CODEX_SECONDARY_INSTANCE,
        'sticky-model',
        toSelections({ fastMode: true }),
      ),
    )
    store.applyStickyState(draftId, projectDefault)

    store.setProviderModelOptions(draftId, CODEX_DRIVER, toSelections(nextOptions), {
      instanceId: CODEX_SECONDARY_INSTANCE,
      model: projectDefault.model,
      persistSticky: true,
    })

    const expectedSelection = createModelSelection(
      CODEX_SECONDARY_INSTANCE,
      projectDefault.model,
      toSelections(nextOptions),
    )
    expect(draftByKey(draftId)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE]).toEqual(
      expectedSelection,
    )
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(expectedSelection)
    store.applyStickyState(nextDraftId)
    expect(draftByKey(nextDraftId)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE)
    expect(draftByKey(nextDraftId)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE]).toEqual(
      expectedSelection,
    )
  })

  it('pins identical human trait choices, including the default options of a fresh draft', () =>
  {
    const store = useComposerDraftStore.getState()
    const draftId = DraftId.make('explicit-traits-draft')
    const selection = modelSelection(CODEX_DRIVER, 'gpt-5.4', { reasoningEffort: 'high' })
    store.applyStickyState(draftId, selection)
    store.setProviderModelOptions(draftId, CODEX_DRIVER, selection.options, {
      instanceId: CODEX_INSTANCE,
      model: selection.model,
    })
    expect(draftByKey(draftId)?.modelSelectionExplicit).toBe(true)
    store.applyStickyState(draftId, modelSelection(CLAUDE_AGENT_DRIVER, 'claude-opus-4-6'))
    expect(draftByKey(draftId)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(selection)

    const freshDraftId = DraftId.make('explicit-default-traits-draft')
    store.setProviderModelOptions(freshDraftId, CODEX_DRIVER, undefined, {
      instanceId: CODEX_SECONDARY_INSTANCE,
      model: 'custom-default-model',
    })
    store.applyStickyState(freshDraftId, selection)
    expect(draftByKey(freshDraftId)).toMatchObject({
      activeProvider: CODEX_SECONDARY_INSTANCE,
      modelSelectionExplicit: true,
      modelSelectionByProvider: {
        [CODEX_SECONDARY_INSTANCE]: createModelSelection(
          CODEX_SECONDARY_INSTANCE,
          'custom-default-model',
        ),
      },
    })
  })

  it('round-trips explicit intent while legacy selections remain replaceable seeds', () =>
  {
    const store = useComposerDraftStore.getState()
    const draftId = DraftId.make('persisted-explicit-draft')
    const legacyDraftId = DraftId.make('persisted-legacy-seed')
    const selection = createModelSelection(CODEX_SECONDARY_INSTANCE, 'custom-saved-model')
    store.setModelSelection(draftId, selection, { explicit: true })
    store.setModelSelection(legacyDraftId, selection)
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        version: number
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown
      }
    }
    const { merge, partialize, version } = persistApi.getOptions()
    expect(version).toBe(11)
    const hydrated = merge(partialize(useComposerDraftStore.getState()), store)
    expect(hydrated.draftsByThreadKey[draftId]?.modelSelectionExplicit).toBe(true)
    expect(hydrated.draftsByThreadKey[legacyDraftId]?.modelSelectionExplicit).not.toBe(true)
    useComposerDraftStore.setState(hydrated)
    const projectDefault = modelSelection(CODEX_DRIVER, 'gpt-5.4')
    store.applyStickyState(draftId, projectDefault)
    store.applyStickyState(legacyDraftId, projectDefault)
    expect(draftByKey(draftId)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE]).toEqual(
      selection,
    )
    expect(draftByKey(legacyDraftId)?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      projectDefault,
    )
  })

  it.each(['', 'Keep this pending work.'])(
    'preserves concrete project metadata when a path-keyed explicit draft reloads with prompt %j',
    (prompt) =>
    {
      const store = useComposerDraftStore.getState()
      const draftId = DraftId.make('persisted-path-keyed-draft')
      const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make('project-alpha'))
      const logicalProjectKey = `${TEST_ENVIRONMENT_ID}:/workspace/alpha`
      const selection = createModelSelection(CODEX_SECONDARY_INSTANCE, 'custom-saved-model')
      store.setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
        threadId: ThreadId.make('path-keyed-thread'),
        createdAt: '2026-08-29T12:00:00.000Z',
        branch: 'feature/alpha',
        envMode: 'worktree',
        startFromOrigin: true,
        collaborationMode: { baseMode: 'plan', orchestrate: true },
      })
      store.setModelSelection(draftId, selection, { explicit: true })
      store.setPrompt(draftId, prompt)
      const before = store.getDraftSession(draftId)
      const persistApi = useComposerDraftStore.persist as unknown as {
        getOptions: () => {
          merge: (
            persistedState: unknown,
            currentState: ReturnType<typeof useComposerDraftStore.getState>,
          ) => ReturnType<typeof useComposerDraftStore.getState>
          partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown
        }
      }
      const { merge, partialize } = persistApi.getOptions()
      const hydrated = merge(partialize(useComposerDraftStore.getState()), store)
      expect(hydrated.draftThreadsByThreadKey[draftId]).toEqual(before)
      expect(hydrated.logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey]).toBe(
        draftId,
      )
      expect(hydrated.draftsByThreadKey[draftId]).toMatchObject({
        prompt,
        activeProvider: CODEX_SECONDARY_INSTANCE,
        modelSelectionByProvider: { [CODEX_SECONDARY_INSTANCE]: selection },
        modelSelectionExplicit: true,
      })
    },
  )

  it('retains composer content and execution modes when a late project default replaces a seed', () =>
  {
    const store = useComposerDraftStore.getState()
    const draftId = DraftId.make('late-project-default-draft')
    store.setProjectDraftThreadId(
      scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make('project')),
      draftId,
    )
    store.setPrompt(draftId, 'Keep this pending work.')
    store.addImage(draftId, makeImage({ id: 'pending-image', previewUrl: 'blob:pending-image' }))
    store.addTerminalContext(draftId, makeTerminalContext({ id: 'pending-terminal' }))
    store.setRuntimeMode(draftId, 'full-access')
    store.setInteractionMode(draftId, { baseMode: 'plan', orchestrate: true })
    store.applyStickyState(draftId, modelSelection(CODEX_DRIVER, 'gpt-5.4'))
    const before = draftByKey(draftId)!
    const { activeProvider: _active, modelSelectionByProvider: _models, ...content } = before
    store.applyStickyState(draftId, createModelSelection(CODEX_SECONDARY_INSTANCE, 'custom-model'))
    expect(draftByKey(draftId)).toMatchObject(content)
    expect(draftByKey(draftId)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE)
  })
})

describe('composerDraftStore provider-scoped option updates', () =>
{
  const threadId = ThreadId.make('thread-provider')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)

  beforeEach(() =>
  {
    resetComposerDraftStore()
  })

  it('retains off-provider option memory without changing the active selection', () =>
  {
    const store = useComposerDraftStore.getState()
    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, 'gpt-5.3-codex', {
        reasoningEffort: 'medium',
      }),
    )
    store.setProviderModelOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ effort: 'max' }))
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, 'gpt-5.3-codex', { reasoningEffort: 'medium' }),
    )
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelSelection(
        CLAUDE_AGENT_INSTANCE,
        'claude-opus-4-6',
        toSelections({ effort: 'max' }),
      ).options,
    )
    expect(draft?.activeProvider).toBe('codex')
  })
})

describe('composerDraftStore runtime and interaction settings', () =>
{
  const threadId = ThreadId.make('thread-settings')
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId)

  beforeEach(() =>
  {
    resetComposerDraftStore()
  })

  it('stores runtime mode overrides in the composer draft', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setRuntimeMode(threadRef, 'approval-required')

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.runtimeMode).toBe('approval-required')
  })

  it('stores base mode overrides in the composer draft', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setInteractionMode(threadRef, { baseMode: 'plan', orchestrate: false })

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.collaborationMode).toEqual({
      baseMode: 'plan',
      orchestrate: false,
    })
  })

  it('stores Orchestrate as a modifier without replacing Plan', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setInteractionMode(threadRef, { baseMode: 'plan', orchestrate: true })

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.collaborationMode).toEqual({
      baseMode: 'plan',
      orchestrate: true,
    })
  })

  it('round-trips legacy orchestrate mode with preview annotations', () =>
  {
    const annotation: PreviewAnnotationPayload = {
      id: 'annotation-1',
      pageUrl: 'http://localhost:3000',
      pageTitle: 'Dashboard',
      comment: 'Align these cards.',
      elements: [],
      regions: [{ id: 'region-1', rect: { x: 10, y: 20, width: 100, height: 80 } }],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: '2026-07-31T12:00:00.000Z',
    }
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown
      }
    }
    const { merge, partialize } = persistApi.getOptions()
    const hydratedLegacyState = merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: '',
            attachments: [],
            previewAnnotations: [annotation],
            orchestrateMode: true,
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    )
    const rehydratedState = merge(
      partialize(hydratedLegacyState),
      useComposerDraftStore.getInitialState(),
    )

    expect(rehydratedState.draftsByThreadKey[threadKeyFor(threadId)]).toMatchObject({
      collaborationMode: { baseMode: 'default', orchestrate: true },
      previewAnnotations: [annotation],
    })
  })

  it('round-trips Plan with Orchestrate and migrates the legacy enum', () =>
  {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown
      }
    }
    const { merge, partialize } = persistApi.getOptions()
    const store = useComposerDraftStore.getState()
    store.setInteractionMode(threadRef, { baseMode: 'plan', orchestrate: true })

    const persisted = partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey: Record<string, { interactionMode?: string; orchestrate?: boolean }>
    }
    expect(persisted.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]).toMatchObject({
      interactionMode: 'plan',
      orchestrate: true,
    })
    const rehydrated = merge(persisted, useComposerDraftStore.getInitialState())
    expect(
      rehydrated.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.collaborationMode,
    ).toEqual({
      baseMode: 'plan',
      orchestrate: true,
    })

    const migratedLegacyEnum = merge(
      {
        draftsByThreadKey: {
          [threadKeyFor(threadId)]: {
            prompt: '',
            attachments: [],
            interactionMode: 'orchestrate',
          },
        },
        draftThreadsByThreadKey: {
          'legacy-draft-session': {
            threadId,
            environmentId: TEST_ENVIRONMENT_ID,
            projectId: ProjectId.make('project-settings'),
            logicalProjectKey: 'project-settings',
            createdAt: '2026-01-01T00:00:00.000Z',
            runtimeMode: 'full-access',
            interactionMode: 'orchestrate',
            branch: null,
            worktreePath: null,
            envMode: 'local',
            startFromOrigin: false,
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    )
    expect(migratedLegacyEnum.draftsByThreadKey[threadKeyFor(threadId)]?.collaborationMode).toEqual(
      {
        baseMode: 'default',
        orchestrate: true,
      },
    )
    expect(Object.values(migratedLegacyEnum.draftThreadsByThreadKey)[0]?.collaborationMode).toEqual(
      {
        baseMode: 'default',
        orchestrate: true,
      },
    )
  })

  it('removes empty settings-only drafts when overrides are cleared', () =>
  {
    const store = useComposerDraftStore.getState()

    store.setRuntimeMode(threadRef, 'approval-required')
    store.setInteractionMode(threadRef, { baseMode: 'plan', orchestrate: false })
    store.setRuntimeMode(threadRef, null)
    store.setInteractionMode(threadRef, null)

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined()
  })
})
