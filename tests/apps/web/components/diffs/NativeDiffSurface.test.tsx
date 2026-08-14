// tests/apps/web/components/diffs/NativeDiffSurface.test.tsx
// verifies checkpoint and proposal diffs share one exact native renderer
import type { ArchitectureProposalSource, ScopedThreadRef } from '@t3tools/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('~/hooks/useSettings', () => ({
  useClientSettings: () => ({ wordWrap: false }),
}))

vi.mock('~/hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: 'light' as const }),
}))

vi.mock('~/lib/utils', () => ({
  cn: (...values: ReadonlyArray<string | false | null | undefined>) =>
    values.filter(Boolean).join(' '),
}))

vi.mock('../../../../../apps/web/src/components/diffs/AnnotatableCodeView', () => ({
  AnnotatableCodeView: (props: {
    readonly files: ReadonlyArray<{
      readonly fileDiff: unknown
      readonly fileKey: string
      readonly filePath: string
      readonly collapsed: boolean
    }>
    readonly sectionId: string
    readonly renderHeaderPrefix: (
      fileDiff: unknown,
      fileKey: string,
      collapsed: boolean,
    ) => ReactNode
    readonly options: {
      readonly diffStyle: string
      readonly theme: string
    }
  }) => (
    <div
      data-shared-pierre-renderer
      data-section-id={props.sectionId}
      data-diff-style={props.options.diffStyle}
      data-theme={props.options.theme}
    >
      {props.files.map((file) => (
        <span key={file.filePath}>
          {props.renderHeaderPrefix(file.fileDiff, file.fileKey, file.collapsed)}
          {file.filePath}
        </span>
      ))}
    </div>
  ),
}))

import {
  NativeDiffSurface,
  useNativeDiffSurfaceController,
} from '../../../../../apps/web/src/components/diffs/NativeDiffSurface'
import { ProposalDiffPanel } from '../../../../../apps/web/src/components/proposals/ProposalDiffPanel'

const threadRef = {
  environmentId: 'environment-native-diff-test',
  threadId: 'thread-native-diff-test',
} as ScopedThreadRef

const currentPatch = `diff --git a/src/current.ts b/src/current.ts
index 3367afd..2c18d46 100644
--- a/src/current.ts
+++ b/src/current.ts
@@ -1 +1 @@
-export const value = "before"
+export const value = "after"`

const proposalPatch = `diff --git a/src/existing.ts b/src/existing.ts
index 3367afd..2c18d46 100644
--- a/src/existing.ts
+++ b/src/existing.ts
@@ -1 +1 @@
-export const existing = false
+export const existing = true
diff --git a/src/proposed.ts b/src/proposed.ts
new file mode 100644
index 0000000..94bdbb4
--- /dev/null
+++ b/src/proposed.ts
@@ -0,0 +1 @@
+export const proposed = true`

const prefixedRenamePatch = `diff --git a/a/old.ts b/b/new.ts
similarity index 50%
rename from a/old.ts
rename to b/new.ts
index 3367afd..2c18d46 100644
--- a/a/old.ts
+++ b/b/new.ts
@@ -1 +1 @@
-export const value = false
+export const value = true`

const beforeSource = {
  kind: 'proposal-generation',
  threadId: threadRef.threadId,
  generationId: 'generation-native-diff-test',
  side: 'base',
  graphDigest: `sha256:${'a'.repeat(64)}`,
} as ArchitectureProposalSource

const proposedSource = {
  ...beforeSource,
  side: 'proposed',
  graphDigest: `sha256:${'b'.repeat(64)}`,
} as ArchitectureProposalSource

function CurrentDiffSurface()
{
  const controller = useNativeDiffSurfaceController({
    source: {
      patch: currentPatch,
      cacheScope: 'checkpoint:test',
    },
    collapseScopeKey: 'checkpoint:test',
  })

  return (
    <NativeDiffSurface
      controller={controller}
      collapseScopeKey="checkpoint:test"
      sectionId="checkpoint:test"
      sectionTitle="Current checkpoint"
      composerDraftTarget={threadRef}
      resolvedTheme="light"
      renderMode="stacked"
      wordWrap={false}
      loading={false}
      loadingLabel="Loading checkpoint diff..."
      emptyMessage="No checkpoint diff."
    />
  )
}

describe('NativeDiffSurface', () =>
{
  it('renders checkpoint and immutable proposal sources through the same exact surface', () =>
  {
    const markup = renderToStaticMarkup(
      <>
        <CurrentDiffSurface />
        <ProposalDiffPanel
          proposal={{
            revisionNumber: 7,
            snapshotTreeOid: '0123456789abcdef0123456789abcdef01234567',
            exactDiff: proposalPatch,
            operationCount: 1,
            byteCount: 29,
          }}
          composerDraftTarget={threadRef}
        />
      </>,
    )

    expect(markup.match(/data-native-diff-surface/g)).toHaveLength(2)
    expect(markup.match(/data-shared-pierre-renderer/g)).toHaveLength(2)
    expect(markup).toContain('src/current.ts')
    expect(markup).toContain('src/existing.ts')
    expect(markup).toContain('src/proposed.ts')
    expect(markup).not.toContain('data-native-diff-source-actions')
    expect(markup).toContain(
      'Preview of proposal revision 7 against workspace snapshot 0123456789abcdef0123456789abcdef01234567',
    )
    expect(markup).toContain('1 operation · 29 bytes')
  })

  it('offers only exact side-specific actions for immutable proposal files', () =>
  {
    const markup = renderToStaticMarkup(
      <ProposalDiffPanel
        proposal={{
          revisionNumber: 7,
          snapshotTreeOid: '0123456789abcdef0123456789abcdef01234567',
          exactDiff: proposalPatch,
        }}
        composerDraftTarget={threadRef}
        fileActions={{
          beforeSource,
          proposedSource,
          onOpenFile: vi.fn(),
        }}
      />,
    )

    expect(markup.match(/data-native-diff-source-actions/g)).toHaveLength(2)
    expect(markup).toContain('Open Before version of src/existing.ts')
    expect(markup).toContain('Open Proposed version of src/existing.ts')
    expect(markup).not.toContain('Open Before version of src/proposed.ts')
    expect(markup).toContain('Open Proposed version of src/proposed.ts')
  })

  it('preserves parser-normalized top-level a and b paths for immutable actions', () =>
  {
    const markup = renderToStaticMarkup(
      <ProposalDiffPanel
        proposal={{
          revisionNumber: 8,
          snapshotTreeOid: '0123456789abcdef0123456789abcdef01234567',
          exactDiff: prefixedRenamePatch,
        }}
        composerDraftTarget={threadRef}
        fileActions={{
          beforeSource,
          proposedSource,
          onOpenFile: vi.fn(),
        }}
      />,
    )

    expect(markup).toContain('Open Before version of a/old.ts')
    expect(markup).toContain('Open Proposed version of b/new.ts')
  })
})
