// apps/web/src/components/architecture/ArchitectureSourceFilePanel.tsx
// reads and presents one immutable architecture-side source file

import type { EnvironmentId } from '@t3tools/contracts'
import { FileCode2, RotateCcw } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { projectEnvironment } from '~/state/projects'
import { useEnvironmentQuery } from '~/state/query'
import type { RightPanelSurface } from '~/rightPanelStore'

type FileSurface = Extract<RightPanelSurface, { readonly kind: 'file' }>
type ArchitectureFileSource = NonNullable<FileSurface['source']>

export interface ArchitectureSourceFilePanelProps
{
  readonly environmentId: EnvironmentId
  readonly source: ArchitectureFileSource
  readonly relativePath: string
  readonly revealLine: number | null
  readonly revealRequestId: number
}

function sideLabel(source: ArchitectureFileSource): string
{
  const side = source.side
  if (side === 'base') return 'Before'
  if (side === 'proposed') return 'Proposed'
  return 'After'
}

function sourceMatches(expected: ArchitectureFileSource, actual: ArchitectureFileSource): boolean
{
  if (
    expected.kind !== actual.kind ||
    expected.threadId !== actual.threadId ||
    expected.side !== actual.side ||
    expected.graphDigest !== actual.graphDigest
  )
  {
    return false
  }
  if (expected.kind === 'proposal-generation' && actual.kind === 'proposal-generation')
  {
    return expected.generationId === actual.generationId
  }
  return (
    expected.kind === 'diff-analysis' &&
    actual.kind === 'diff-analysis' &&
    expected.diffAnalysisId === actual.diffAnalysisId
  )
}

export function ArchitectureSourceFilePanel(props: ArchitectureSourceFilePanelProps)
{
  const viewportRef = useRef<HTMLDivElement>(null)
  const source = useEnvironmentQuery(
    projectEnvironment.getArchitectureSource({
      environmentId: props.environmentId,
      input: {
        threadId: props.source.threadId,
        source: props.source,
        relativePath: props.relativePath,
      },
    }),
  )
  const exactSource =
    source.data !== null &&
    source.data.relativePath === props.relativePath &&
    sourceMatches(props.source, source.data.source)
      ? source.data
      : null
  const identityError =
    source.data !== null && exactSource === null
      ? 'The source response did not match the selected immutable file identity.'
      : null
  useEffect(() =>
  {
    if (props.revealLine === null || exactSource === null) return
    viewportRef.current?.scrollTo({
      top: Math.max(0, props.revealLine - 1) * 20,
      behavior: 'auto',
    })
  }, [props.revealLine, props.revealRequestId, exactSource])

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-background"
      aria-label="Immutable architecture source"
    >
      <header className="surface-subheader h-auto min-h-12 gap-3 px-3 py-2">
        <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p
            className="truncate font-mono text-xs font-medium text-foreground"
            title={props.relativePath}
          >
            {props.relativePath}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {sideLabel(props.source)} · immutable analyzed source
          </p>
        </div>
        <Badge variant="outline">Read only</Badge>
      </header>
      {exactSource ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>Content digest</span>
          <code className="truncate">{exactSource.sourceDigest}</code>
          {props.revealLine !== null ? (
            <span className="ml-auto shrink-0">Line {props.revealLine}</span>
          ) : null}
        </div>
      ) : null}
      {(source.error !== null && source.data === null) || identityError !== null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-sm">
            <p className="text-sm font-medium text-foreground">Source unavailable</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {identityError ?? source.error}
            </p>
            <Button className="mt-4" size="sm" variant="outline" onClick={source.refresh}>
              <RotateCcw />
              Retry
            </Button>
          </div>
        </div>
      ) : exactSource === null ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground"
          role="status"
        >
          Loading immutable source…
        </div>
      ) : (
        <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto bg-card/20">
          <pre className="min-w-max p-4 font-mono text-xs leading-5 text-foreground selection:bg-primary/20">
            <code>{exactSource.content}</code>
          </pre>
        </div>
      )}
    </section>
  )
}
