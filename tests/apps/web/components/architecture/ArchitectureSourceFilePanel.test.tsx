// tests/apps/web/components/architecture/ArchitectureSourceFilePanel.test.tsx
// verifies exact immutable source reads stay read-only in the native file tab

// @vitest-environment happy-dom

import type { ArchitectureProposalSource, EnvironmentId } from '@t3tools/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vite-plus/test'

const harness = vi.hoisted(() => ({
  query: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('~/state/projects', () => ({
  projectEnvironment: {
    getArchitectureSource: (input: unknown) => ({ kind: 'architecture-source', input }),
  },
}))

vi.mock('~/state/query', () => ({
  useEnvironmentQuery: (query: unknown) =>
  {
    harness.query(query)
    return {
      data: {
        version: 1,
        source,
        relativePath: 'src/added.ts',
        sourceDigest: `sha256:${'d'.repeat(64)}`,
        content: 'export const added = true\n',
      },
      error: null,
      isPending: false,
      hasSettled: true,
      refresh: harness.refresh,
    }
  },
}))

import { ArchitectureSourceFilePanel } from '../../../../../apps/web/src/components/architecture/ArchitectureSourceFilePanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const environmentId = 'environment-source-panel' as EnvironmentId
const source = {
  kind: 'proposal-generation',
  threadId: 'thread-source-panel',
  generationId: 'generation-source-panel',
  side: 'proposed',
  graphDigest: `sha256:${'a'.repeat(64)}`,
} as unknown as ArchitectureProposalSource

describe('ArchitectureSourceFilePanel', () =>
{
  it('reads the selected proposal side and exposes no editing surface', async () =>
  {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try
    {
      await act(async () =>
      {
        root.render(
          <ArchitectureSourceFilePanel
            environmentId={environmentId}
            source={source}
            relativePath="src/added.ts"
            revealLine={null}
            revealRequestId={0}
          />,
        )
      })

      expect(harness.query).toHaveBeenCalledWith({
        kind: 'architecture-source',
        input: {
          environmentId,
          input: {
            threadId: source.threadId,
            source,
            relativePath: 'src/added.ts',
          },
        },
      })
      expect(container.textContent).toContain('Proposed · immutable analyzed source')
      expect(container.textContent).toContain('Read only')
      expect(container.textContent).toContain('export const added = true')
      expect(container.querySelector('textarea')).toBeNull()
      expect(container.querySelector('[contenteditable="true"]')).toBeNull()
    }
    finally
    {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
