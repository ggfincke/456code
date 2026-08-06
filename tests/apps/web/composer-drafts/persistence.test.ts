// tests/apps/web/composer-drafts/persistence.test.ts
// covers persisted composer image hydration

import { describe, expect, it } from 'vite-plus/test'

import {
  createEmptyThreadDraft,
  useComposerDraftStore,
} from '../../../../apps/web/src/composerDraftStore'

describe('composer draft persistence', () =>
{
  it('hydrates persisted base64 image bytes through the store merge path', async () =>
  {
    const threadKey = 'thread-image-draft'
    const initialState = useComposerDraftStore.getInitialState()
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (persistedState: unknown, currentState: typeof initialState) => typeof initialState
        partialize: (state: typeof initialState) => unknown
      }
    }
    const { merge, partialize } = persistApi.getOptions()
    const persistedState = partialize({
      ...initialState,
      draftsByThreadKey: {
        [threadKey]: {
          ...createEmptyThreadDraft(),
          prompt: 'Keep this image attached.',
          persistedAttachments: [
            {
              id: 'image-1',
              name: 'image.png',
              mimeType: 'image/png',
              sizeBytes: 4,
              dataUrl: 'data:image/png;base64,AQIDBA==',
            },
          ],
        },
      },
    })

    const hydratedState = merge(persistedState, initialState)
    const hydratedDraft = hydratedState.draftsByThreadKey[threadKey]

    expect(hydratedDraft?.prompt).toBe('Keep this image attached.')
    expect(hydratedDraft?.images).toHaveLength(1)
    expect(hydratedDraft?.images[0]).toMatchObject({
      id: 'image-1',
      mimeType: 'image/png',
    })
    expect(hydratedDraft?.images[0]?.file.size).toBe(4)
    expect(Array.from(new Uint8Array(await hydratedDraft!.images[0]!.file.arrayBuffer()))).toEqual([
      1, 2, 3, 4,
    ])
  })
})
