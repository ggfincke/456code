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
      return Promise.resolve(persistedDraftFile.payload)
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
  type ComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContentState,
  removeComposerDraftsForEnvironment,
  restoreComposerDraftSnapshotState,
} from '../../../../../apps/mobile/src/state/threads/use-composer-drafts'

const DRAFT: ComposerDraft = {
  text: 'hello',
  attachments: [],
}

afterEach(() =>
{
  appAtomRegistry.set(composerDraftsAtom, {})
  persistedDraftFile.writeError = null
  persistedDraftFile.writes = []
})

describe('mobile composer drafts', () =>
{
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
