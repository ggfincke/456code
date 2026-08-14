// tests/apps/web/components/architecture/ConnectedArchitectureImpactSurface.test.tsx
// verifies Impact opens immutable file resources immediately after its parent tab

// @vitest-environment happy-dom

import type {
  ArchitectureProposalSource,
  EnvironmentId,
  ProposalGenerationId,
  ScopedThreadRef,
} from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

const harness = vi.hoisted(() => ({
  refresh: vi.fn(),
}))

vi.mock('~/state/projects', () => ({
  projectEnvironment: {
    getArchitectureImpact: (input: unknown) => ({ kind: 'architecture-impact', input }),
  },
}))

vi.mock('~/state/query', () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    hasSettled: true,
    refresh: harness.refresh,
  }),
}))

vi.mock('../../../../../apps/web/src/components/architecture/ArchitectureImpactSurface', () => ({
  ArchitectureImpactSurface: (props: {
    readonly onOpenFile: (
      source: ArchitectureProposalSource,
      relativePath: string,
      line?: number,
    ) => void
  }) => (
    <button type="button" onClick={() => props.onOpenFile(source, 'src/impact.ts', 12)}>
      Open exact impact file
    </button>
  ),
}))

import { ConnectedArchitectureImpactSurface } from '../../../../../apps/web/src/components/architecture/ConnectedArchitectureImpactSurface'
import { createArchitectureImpactSurface } from '../../../../../apps/web/src/components/architecture/architectureResourceIdentity'
import {
  selectThreadRightPanelState,
  useRightPanelStore,
} from '../../../../../apps/web/src/stores/rightPanelStore'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const threadRef = {
  environmentId: 'environment-connected-impact' as EnvironmentId,
  threadId: 'thread-connected-impact',
} as ScopedThreadRef
const generationId = 'generation-connected-impact' as ProposalGenerationId
const source = {
  kind: 'proposal-generation',
  threadId: threadRef.threadId,
  generationId,
  side: 'proposed',
  graphDigest: `sha256:${'a'.repeat(64)}`,
} as ArchitectureProposalSource
const surface = createArchitectureImpactSurface({
  threadId: threadRef.threadId,
  comparison: { kind: 'proposal-generation', generationId },
})

afterEach(() =>
{
  useRightPanelStore.getState().removeThread(threadRef)
  vi.clearAllMocks()
})

describe('ConnectedArchitectureImpactSurface', () =>
{
  it('opens an immutable source directly after the Impact parent', async () =>
  {
    useRightPanelStore.getState().openArchitectureSurface(threadRef, surface)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
      {
        root.render(<ConnectedArchitectureImpactSurface threadRef={threadRef} surface={surface} />)
      })
      const open = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Open exact impact file',
      )
      await act(async () => open?.click())

      const state = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      )
      expect(state.surfaces.map((entry) => entry.kind)).toEqual(['architecture-impact', 'file'])
      expect(state.surfaces[1]).toMatchObject({
        kind: 'file',
        relativePath: 'src/impact.ts',
        revealLine: 12,
        source,
      })
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
