// tests/apps/mobile/state/threads/use-composer-drafts.test.ts
// verifies composer draft persistence and exact environment cleanup boundaries

import { afterEach, describe, expect, it } from '@effect/vitest'
import { EnvironmentId, ProviderInstanceId } from '@t3tools/contracts'
import { vi } from 'vite-plus/test'

const persistedDraftFile = vi.hoisted(() => ({
  exists: false,
  payload: '',
  writes: [] as Array<string>,
  writeError: null as Error | null,
  readResult: null as Promise<string> | null,
}))

vi.mock('expo-file-system', () => ({
  Paths: { document: '/documents' },
  Directory: class
  {
    exists = true
    create(): void
    {}
  },
  File: class
  {
    get exists(): boolean
    {
      return persistedDraftFile.exists
    }
    create(): void
    {
      persistedDraftFile.exists = true
    }
    text(): Promise<string>
    {
      return persistedDraftFile.readResult ?? Promise.resolve(persistedDraftFile.payload)
    }
    write(payload: string): void
    {
      if (persistedDraftFile.writeError !== null)
      {
        throw persistedDraftFile.writeError
      }
      persistedDraftFile.payload = payload
      persistedDraftFile.writes.push(payload)
    }
  },
}))

import { appAtomRegistry } from '../../../../../apps/mobile/src/state/atom-registry'
import {
  clearComposerDraftContentState,
  clearComposerDraftsEnvironment,
  composerDraftsAtom,
  decodePersistedComposerDrafts,
  decodePersistedComposerState,
  type ComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContentState,
  removeComposerDraftsForEnvironment,
  restoreComposerDraftSnapshotState,
  stickyComposerModelSelectionAtom,
} from '../../../../../apps/mobile/src/state/threads/use-composer-drafts'

const DRAFT: ComposerDraft = {
  text: 'hello',
  attachments: [],
}

afterEach(() =>
{
  appAtomRegistry.set(composerDraftsAtom, {})
  appAtomRegistry.set(stickyComposerModelSelectionAtom, null)
  persistedDraftFile.exists = false
  persistedDraftFile.payload = ''
  persistedDraftFile.readResult = null
  persistedDraftFile.writeError = null
  persistedDraftFile.writes = []
  vi.useRealTimers()
})

describe('mobile composer drafts', () =>
{
  it('keeps sticky preferences outside drafts while clearing only successful new-task selectors', () =>
  {
    const selection = {
      instanceId: ProviderInstanceId.make('custom-instance'),
      model: 'custom-model',
      options: [{ id: 'reasoningEffort', value: 'xhigh' }],
    }
    const draftKey = 'new-task:environment-1:project-1'
    const pendingKey = 'pending-task:message-1'
    const selectedDraft: ComposerDraft = {
      ...DRAFT,
      modelSelection: selection,
      runtimeMode: 'approval-required',
      workspaceSelection: { mode: 'worktree', branch: 'main', worktreePath: null },
    }
    const document = decodePersistedComposerState({
      schemaVersion: 1,
      stickyModelSelection: selection,
      drafts: {
        [draftKey]: selectedDraft,
        [pendingKey]: { ...selectedDraft, text: 'pending edits' },
        'new-task:environment-1:model-only': {
          text: '',
          attachments: [],
          modelSelection: selection,
        },
        'new-task:environment-1:share-receipt': {
          text: '',
          attachments: [],
          importedShareIds: ['share-1'],
        },
      },
    })
    const cleared = clearComposerDraftContentState(document.drafts, draftKey, {
      clearModelSelection: true,
      clearWorkspaceSelection: true,
    })

    expect(cleared[draftKey]).toEqual({
      text: '',
      attachments: [],
      runtimeMode: 'approval-required',
      orchestrate: false,
    })
    expect(cleared[pendingKey]).toBe(document.drafts[pendingKey])
    expect(document.drafts[draftKey]?.modelSelection).toEqual(selection)
    expect(document.drafts['new-task:environment-1:model-only']?.modelSelection).toEqual(selection)
    expect(document.drafts['new-task:environment-1:share-receipt']?.importedShareIds).toEqual([
      'share-1',
    ])
    expect(document.stickyModelSelection).toEqual(selection)
  })

  it('replays pre-hydration draft edits and keeps the last manual sticky pick in serialized writes', async () =>
  {
    vi.resetModules()
    vi.useFakeTimers()
    const drafts = await import('../../../../../apps/mobile/src/state/threads/use-composer-drafts')
    const { appAtomRegistry: registry } =
      await import('../../../../../apps/mobile/src/state/atom-registry')
    const oldSelection = { instanceId: ProviderInstanceId.make('codex'), model: 'old-model' }
    const selected = {
      ...oldSelection,
      model: 'chosen-model',
      options: [{ id: 'effort', value: 'high' }],
    }
    const draftKey = 'new-task:environment-1:project-1'
    const removedKey = 'environment-1:removed-thread'
    persistedDraftFile.exists = true
    const read = Promise.withResolvers<string>()
    persistedDraftFile.readResult = read.promise

    drafts.setStickyComposerModelSelection(oldSelection)
    drafts.setStickyComposerModelSelection(selected)
    drafts.clearComposerDraft(removedKey)
    drafts.appendComposerDraftText(draftKey, ' + edit')
    await vi.advanceTimersByTimeAsync(500)
    expect(persistedDraftFile.writes).toEqual([])

    read.resolve(
      JSON.stringify({
        schemaVersion: 1,
        stickyModelSelection: { ...oldSelection, model: 'persisted-model' },
        drafts: {
          [draftKey]: { ...DRAFT, text: 'disk draft', modelSelection: oldSelection },
          [removedKey]: DRAFT,
          'environment-2:retained': DRAFT,
        },
      }),
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(registry.get(drafts.composerDraftsAtom)[draftKey]?.text).toBe('disk draft + edit')
    expect(registry.get(drafts.composerDraftsAtom)[removedKey]).toBeUndefined()
    expect(registry.get(drafts.stickyComposerModelSelectionAtom)).toEqual(selected)
    expect(persistedDraftFile.writes).toHaveLength(1)

    await Promise.all([
      drafts.mergeComposerDraftContent(draftKey, {
        text: 'share',
        attachments: [],
        sourceShareId: 'share-1',
      }),
      drafts.clearComposerDraftsEnvironment(EnvironmentId.make('environment-2')),
    ])
    const documents = persistedDraftFile.writes.map((payload) => JSON.parse(payload))
    expect(documents.map((document) => document.stickyModelSelection)).toEqual([
      selected,
      selected,
      selected,
    ])
    expect(documents[1].drafts['environment-2:retained']).toBeDefined()
    expect(documents[2].drafts['environment-2:retained']).toBeUndefined()
    expect(documents[2].drafts[draftKey]).toMatchObject({
      text: 'disk draft + edit\n\nshare',
      importedShareIds: ['share-1'],
      modelSelection: oldSelection,
    })
  })

  it('persists a sticky-only pre-hydration change without losing an untouched draft or share receipt', async () =>
  {
    vi.resetModules()
    vi.useFakeTimers()
    const drafts = await import('../../../../../apps/mobile/src/state/threads/use-composer-drafts')
    const selected = {
      instanceId: ProviderInstanceId.make('custom-instance'),
      model: 'custom-model',
    }
    persistedDraftFile.exists = true
    const read = Promise.withResolvers<string>()
    persistedDraftFile.readResult = read.promise
    drafts.setStickyComposerModelSelection(selected)
    read.resolve(
      JSON.stringify({
        schemaVersion: 1,
        drafts: {
          'new-task:environment-1:project-1': DRAFT,
          'new-task:environment-1:receipt': {
            text: '',
            attachments: [],
            importedShareIds: ['share-1'],
          },
        },
      }),
    )
    await vi.advanceTimersByTimeAsync(200)

    expect(persistedDraftFile.writes).toHaveLength(1)
    expect(drafts.decodePersistedComposerState(JSON.parse(persistedDraftFile.writes[0]!))).toEqual({
      stickyModelSelection: selected,
      drafts: {
        'new-task:environment-1:project-1': { ...DRAFT, orchestrate: false },
        'new-task:environment-1:receipt': {
          text: '',
          attachments: [],
          importedShareIds: ['share-1'],
          orchestrate: false,
        },
      },
    })
  })

  it('hydrates selector state even when the message content is empty', () =>
  {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          'new-task:environment-1:project-1': {
            text: '',
            attachments: [],
            modelSelection: {
              instanceId: 'codex',
              model: 'gpt-5.4',
              options: [{ id: 'reasoningEffort', value: 'xhigh' }],
            },
            runtimeMode: 'approval-required',
            interactionMode: 'plan',
            workspaceSelection: {
              mode: 'worktree',
              branch: 'main',
              worktreePath: null,
            },
          },
        },
      }),
    ).toEqual({
      'new-task:environment-1:project-1': {
        text: '',
        attachments: [],
        modelSelection: {
          instanceId: 'codex',
          model: 'gpt-5.4',
          options: [{ id: 'reasoningEffort', value: 'xhigh' }],
        },
        runtimeMode: 'approval-required',
        interactionMode: 'plan',
        orchestrate: false,
        workspaceSelection: {
          mode: 'worktree',
          branch: 'main',
          worktreePath: null,
        },
      },
    })
  })

  it('keeps legacy content-only drafts and rejects invalid selector state', () =>
  {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          'environment-1:thread-1': DRAFT,
        },
      }),
    ).toEqual({
      'environment-1:thread-1': { ...DRAFT, orchestrate: false },
    })

    expect(() =>
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          'environment-1:thread-1': {
            ...DRAFT,
            runtimeMode: 'sometimes-safe',
          },
        },
      }),
    ).toThrow()
  })

  it('persists the orchestration modifier and normalizes legacy orchestrate drafts', () =>
  {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          'environment-1:thread-1': {
            ...DRAFT,
            interactionMode: 'plan',
            orchestrate: true,
          },
          'environment-1:thread-2': {
            ...DRAFT,
            interactionMode: 'orchestrate',
          },
        },
      }),
    ).toEqual({
      'environment-1:thread-1': {
        ...DRAFT,
        interactionMode: 'plan',
        orchestrate: true,
      },
      'environment-1:thread-2': {
        ...DRAFT,
        interactionMode: 'default',
        orchestrate: true,
      },
    })
  })

  it('clears sent content without clearing the selected model or workspace', () =>
  {
    const draftKey = 'environment-1:thread-1'
    const draft: ComposerDraft = {
      text: 'send this',
      attachments: [],
      importedShareIds: ['share-1'],
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.4',
        options: [{ id: 'reasoningEffort', value: 'xhigh' }],
      },
      workspaceSelection: {
        mode: 'worktree',
        branch: 'main',
        worktreePath: null,
      },
    }

    expect(clearComposerDraftContentState({ [draftKey]: draft }, draftKey)).toEqual({
      [draftKey]: {
        modelSelection: draft.modelSelection,
        workspaceSelection: draft.workspaceSelection,
        text: '',
        attachments: [],
      },
    })
  })

  it('reads the latest selector state synchronously for send', () =>
  {
    const draftKey = 'environment-1:thread-1'
    const selectedDraft: ComposerDraft = {
      text: 'send this',
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make('codex'),
        model: 'gpt-5.4',
        options: [{ id: 'reasoningEffort', value: 'xhigh' }],
      },
    }
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: selectedDraft })

    expect(getComposerDraftSnapshot(draftKey)).toEqual(selectedDraft)
  })

  it('merges shared content into a project draft without duplicating retries', () =>
  {
    const draftKey = 'new-task:environment-1:project-1'
    const sharedAttachment = {
      id: 'share-1:image:0',
      type: 'image' as const,
      name: 'Screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      dataUrl: 'data:image/png;base64,YWJj',
      previewUri: 'data:image/png;base64,YWJj',
    }
    const existing: Record<string, ComposerDraft> = {
      [draftKey]: { text: 'Existing context', attachments: [] },
    }
    const content = {
      text: 'Shared note',
      attachments: [sharedAttachment],
      sourceShareId: 'share-1',
    }

    const merged = mergeComposerDraftContentState(existing, draftKey, content)
    expect(merged[draftKey]).toMatchObject({
      text: 'Existing context\n\nShared note',
      attachments: [sharedAttachment],
      importedShareIds: ['share-1'],
    })
    expect(mergeComposerDraftContentState(merged, draftKey, content)).toBe(merged)

    const edited = {
      ...merged,
      [draftKey]: { ...merged[draftKey]!, text: 'User edited the imported context' },
    }
    expect(mergeComposerDraftContentState(edited, draftKey, content)).toBe(edited)
  })

  it('preserves existing images when shared content exceeds the draft attachment limit', () =>
  {
    const draftKey = 'new-task:environment-1:project-1'
    const image = (id: string) => ({
      id,
      type: 'image' as const,
      name: `${id}.png`,
      mimeType: 'image/png',
      sizeBytes: 3,
      dataUrl: 'data:image/png;base64,YWJj',
      previewUri: 'data:image/png;base64,YWJj',
    })
    const existingImage = image('existing')
    const sharedImages = Array.from({ length: 8 }, (_, index) => image(`shared-${index}`))

    const merged = mergeComposerDraftContentState(
      { [draftKey]: { text: '', attachments: [existingImage] } },
      draftKey,
      { text: '', attachments: sharedImages },
    )

    expect(merged[draftKey]?.attachments).toHaveLength(8)
    expect(merged[draftKey]?.attachments[0]).toEqual(existingImage)
    expect(merged[draftKey]?.attachments.at(-1)?.id).toBe('shared-6')
  })

  it('restores the exact draft captured before an interrupted share import', () =>
  {
    const draftKey = 'new-task:environment-1:project-1'
    const beforeImport: ComposerDraft = {
      text: 'Existing context',
      attachments: [],
      runtimeMode: 'approval-required',
    }
    const imported: ComposerDraft = {
      ...beforeImport,
      text: 'Existing context\n\nShared note',
      importedShareIds: ['share-1'],
    }

    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, beforeImport),
    ).toEqual({ [draftKey]: beforeImport })
    expect(
      restoreComposerDraftSnapshotState({ [draftKey]: imported }, draftKey, {
        text: '',
        attachments: [],
      }),
    ).toEqual({})
  })

  it('removes only drafts owned by the selected environment', () =>
  {
    const environmentId = EnvironmentId.make('environment-cloud')
    const retainedEnvironmentId = EnvironmentId.make('environment-local')

    expect(
      removeComposerDraftsForEnvironment(
        {
          [`${environmentId}:thread-cloud`]: DRAFT,
          [`new-task:${environmentId}:project-cloud`]: DRAFT,
          [`${retainedEnvironmentId}:thread-local`]: DRAFT,
          [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
      [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
    })
  })

  it('does not remove prefix-colliding environment drafts', () =>
  {
    const environmentId = EnvironmentId.make('environment-1')

    expect(
      removeComposerDraftsForEnvironment(
        {
          'environment-1:thread-1': DRAFT,
          'new-task:environment-1:project-1': DRAFT,
          'environment-10:thread-1': DRAFT,
          'new-task:environment-10:project-1': DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      'environment-10:thread-1': DRAFT,
      'new-task:environment-10:project-1': DRAFT,
    })
  })

  it('surfaces the serialized document write failure during environment cleanup', async () =>
  {
    const environmentId = EnvironmentId.make('environment-1')
    appAtomRegistry.set(composerDraftsAtom, {
      'environment-1:thread-1': DRAFT,
      'environment-10:thread-1': DRAFT,
    })
    persistedDraftFile.writeError = new Error('disk full')

    await expect(clearComposerDraftsEnvironment(environmentId)).rejects.toMatchObject({
      _tag: 'ComposerDraftPersistenceError',
      operation: 'write',
    })
    expect(appAtomRegistry.get(composerDraftsAtom)).toEqual({
      'environment-10:thread-1': DRAFT,
    })
  })

  it('writes cleanup as a full document through the persistence queue', async () =>
  {
    const environmentId = EnvironmentId.make('environment-1')
    const orchestratedDraft: ComposerDraft = {
      ...DRAFT,
      interactionMode: 'plan',
      orchestrate: true,
    }
    appAtomRegistry.set(composerDraftsAtom, {
      'environment-1:thread-1': DRAFT,
      'environment-10:thread-1': orchestratedDraft,
    })

    await clearComposerDraftsEnvironment(environmentId)

    expect(persistedDraftFile.writes).toHaveLength(1)
    expect(JSON.parse(persistedDraftFile.writes[0]!)).toEqual({
      schemaVersion: 1,
      drafts: { 'environment-10:thread-1': orchestratedDraft },
    })
  })

  it('orders concurrent environment cleanup documents through the shared queue', async () =>
  {
    const first = EnvironmentId.make('environment-1')
    const tenth = EnvironmentId.make('environment-10')
    appAtomRegistry.set(composerDraftsAtom, {
      'environment-1:thread-1': DRAFT,
      'environment-10:thread-1': DRAFT,
    })

    await Promise.all([
      clearComposerDraftsEnvironment(first),
      clearComposerDraftsEnvironment(tenth),
    ])

    expect(persistedDraftFile.writes.map((payload) => JSON.parse(payload).drafts)).toEqual([
      { 'environment-10:thread-1': DRAFT },
      {},
    ])
  })
})
