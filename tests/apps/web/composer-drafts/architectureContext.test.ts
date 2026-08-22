// tests/apps/web/composer-drafts/architectureContext.test.ts
// verifies bounded concern transport, draft isolation, dedupe, and additive persistence

import { scopeThreadRef, scopedThreadKey } from '@t3tools/client-runtime/environment'
import type { ArchitectureGraphProjection } from '@t3tools/contracts'
import { EnvironmentId, ThreadId } from '@t3tools/contracts'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  appendArchitectureContextsToPrompt,
  buildArchitectureContextBlock,
  createArchitectureConcernContext,
  extractTrailingArchitectureContext,
} from '../../../../apps/web/src/composer-drafts/architectureContext'
import {
  createEmptyThreadDraft,
  useComposerDraftStore,
} from '../../../../apps/web/src/composerDraftStore'
import { appendPreviewAnnotationPrompt } from '../../../../apps/web/src/lib/previewAnnotation'
import {
  appendReviewCommentsToPrompt,
  buildFileReviewComment,
} from '../../../../apps/web/src/reviewCommentContext'

const environmentId = EnvironmentId.make('environment-architecture-context')
const threadId = ThreadId.make('thread-architecture-context')
const otherThreadId = ThreadId.make('thread-architecture-context-other')
const threadRef = scopeThreadRef(environmentId, threadId)
const generatedAt = '2026-08-20T12:00:00.000Z'

const projection = {
  projectionVersion: 1,
  projectionId: 'verified-architecture-context',
  projectionRevision: 1,
  kind: 'impact-diff',
  authority: 'verified',
  resultState: 'graph',
  freshness: 'stale',
  generatedAt,
  source: {
    kind: 'verified-proposal-impact',
    threadId,
    generationId: 'generation-architecture-context',
    proposalId: 'proposal-architecture-context',
    revisionId: 'revision-architecture-context',
    baseTreeOid: '1'.repeat(40),
    headTreeOid: '2'.repeat(40),
    baseGraphDigest: `sha256:${'3'.repeat(64)}`,
    headGraphDigest: `sha256:${'4'.repeat(64)}`,
    projectionDigest: `sha256:${'5'.repeat(64)}`,
  },
  lens: 'structure',
  semanticLevel: 'files',
  breadcrumbs: [],
  layoutVersion: 'semantic-impact-v1',
  totals: {
    nodes: { total: 1, returned: 1, omitted: 0 },
    edges: { total: 0, returned: 0, omitted: 0 },
    evidence: { total: 1, returned: 1, omitted: 0 },
    changedFiles: { total: 2, returned: 1, omitted: 1 },
  },
  nodes: [
    {
      id: 'file:src/api.ts',
      label: 'api.ts',
      semanticLevel: 'files',
      relativePath: 'src/api.ts',
      position: { x: 0, y: 0 },
      tintKey: '111111111111',
      state: 'affected',
      stateLabel: 'Affected',
      badge: 'affected',
      stroke: 'double',
      fileCount: 1,
      inbound: 2,
      outbound: 1,
      affectedConsumerCount: 2,
      evidenceRefs: ['evidence:api'],
    },
  ],
  edges: [],
  evidence: [
    {
      id: 'evidence:api',
      kind: 'api',
      state: 'affected',
      label: 'Public API <script> consumer changed.',
      paths: ['src/api.ts'],
      pathRefs: [{ path: 'src/api.ts', side: 'head' }],
    },
  ],
  anchors: [],
} as unknown as ArchitectureGraphProjection

function context()
{
  const created = createArchitectureConcernContext({
    environmentId,
    threadId,
    projection,
    selection: { kind: 'node', node: projection.nodes[0]! },
    capturedAt: generatedAt,
  })
  if (created === null) throw new Error('Expected a valid architecture concern fixture.')
  return created
}

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

describe('architecture concern context', () =>
{
  it('serializes once between preview annotations and review comments and round-trips safely', () =>
  {
    const architectureContext = context()
    const preview = appendPreviewAnnotationPrompt('Investigate this.', {
      id: 'preview-architecture-context',
      pageUrl: 'http://localhost:3000',
      pageTitle: 'Architecture review',
      comment: 'Check this graph selection.',
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: generatedAt,
    })
    const withArchitecture = appendArchitectureContextsToPrompt(preview, [
      architectureContext,
      { ...architectureContext, id: 'duplicate-resource-selection' },
    ])
    const prompt = appendReviewCommentsToPrompt(withArchitecture, [
      buildFileReviewComment({
        id: 'review-architecture-context',
        filePath: 'src/api.ts',
        startLine: 1,
        endLine: 1,
        text: 'Keep the API stable.',
        contents: 'export const api = true',
      }),
    ])

    expect(prompt.match(/<architecture_context>/gu)).toHaveLength(1)
    expect(prompt.indexOf('<preview_annotation>')).toBeLessThan(
      prompt.indexOf('<architecture_context>'),
    )
    expect(prompt.indexOf('<architecture_context>')).toBeLessThan(
      prompt.indexOf('<review_comment '),
    )
    expect(buildArchitectureContextBlock(architectureContext)).not.toContain('<script>')

    const extracted = extractTrailingArchitectureContext(withArchitecture)
    expect(extracted.promptText).toBe(preview)
    expect(extracted.context).toEqual(architectureContext)
  })

  it('deduplicates by exact resource authority and selection while isolating threads', () =>
  {
    const architectureContext = context()
    const store = useComposerDraftStore.getState()

    expect(store.addArchitectureContext(threadRef, architectureContext)).toBe('added')
    expect(
      store.addArchitectureContext(threadRef, {
        ...architectureContext,
        id: 'same-resource-authority-selection',
      }),
    ).toBe('duplicate')
    expect(
      store.addArchitectureContext(
        scopeThreadRef(environmentId, otherThreadId),
        architectureContext,
      ),
    ).toBe('invalid')
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(threadRef)]
        ?.architectureContexts,
    ).toEqual([architectureContext])

    store.removeArchitectureContext(threadRef, architectureContext.id)
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[scopedThreadKey(threadRef)],
    ).toBeUndefined()
  })

  it('round-trips valid contexts and drops one malformed context without losing the draft', () =>
  {
    const architectureContext = context()
    const initialState = useComposerDraftStore.getInitialState()
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (persistedState: unknown, currentState: typeof initialState) => typeof initialState
        partialize: (state: typeof initialState) => unknown
      }
    }
    const { merge, partialize } = persistApi.getOptions()
    const threadKey = scopedThreadKey(threadRef)
    const persisted = partialize({
      ...initialState,
      draftsByThreadKey: {
        [threadKey]: {
          ...createEmptyThreadDraft(),
          prompt: 'Preserve this draft.',
          architectureContexts: [architectureContext],
        },
      },
    }) as {
      draftsByThreadKey: Record<string, { architectureContexts?: unknown[] }>
    }
    persisted.draftsByThreadKey[threadKey]?.architectureContexts?.push({
      ...architectureContext,
      authority: 'planned',
    })

    const hydrated = merge(persisted, initialState)
    expect(hydrated.draftsByThreadKey[threadKey]?.prompt).toBe('Preserve this draft.')
    expect(hydrated.draftsByThreadKey[threadKey]?.architectureContexts).toEqual([
      architectureContext,
    ])
  })
})
