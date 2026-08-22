// apps/web/src/components/files/SafeDocumentRenderer.tsx
// renders closed safe mdx documents with native authenticated host components

import type {
  EnvironmentId,
  MdxSafeDocument,
  MdxSafeDocumentComponentNode,
  MdxSafeDocumentDiagnostic,
  MdxSafeDocumentElementNode,
  MdxSafeDocumentNode,
  ThreadId,
} from '@t3tools/contracts'
import {
  normalizeMdxWorkspacePath,
  resolveMdxAnchorTarget,
  resolveMdxImageTarget,
} from '@t3tools/shared/filePreview'
import { Component, type ReactNode } from 'react'

import { useAssetUrlState } from '~/assets/assetUrls'
import { cn } from '~/lib/utils'

interface SafeDocumentRendererProps
{
  readonly document: MdxSafeDocument
  readonly source: string
  readonly documentPath: string
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly onOpenFile: (path: string, line?: number) => void
}

interface RenderContext
{
  readonly documentPath: string
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly onOpenFile: (path: string, line?: number) => void
}

const OPAQUE_REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u

function diagnosticLocation(diagnostic: MdxSafeDocumentDiagnostic): string | null
{
  const start = diagnostic.range?.start
  return start ? `line ${start.line}, column ${start.column}` : null
}

function DiagnosticsList({
  diagnostics,
  assertive,
}: {
  readonly diagnostics: ReadonlyArray<MdxSafeDocumentDiagnostic>
  readonly assertive: boolean
})
{
  if (diagnostics.length === 0) return null

  return (
    <section
      className={cn(
        'border-b px-4 py-3 text-xs',
        assertive
          ? 'border-destructive/25 bg-destructive/8 text-destructive'
          : 'border-amber-500/20 bg-amber-500/8 text-amber-800 dark:text-amber-200',
      )}
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
    >
      <p className="font-medium">
        {assertive ? 'MDX preview is unavailable.' : 'MDX preview diagnostics'}
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {diagnostics.map((diagnostic) =>
        {
          const location = diagnosticLocation(diagnostic)
          return (
            <li
              key={`${diagnostic.code}:${diagnostic.ruleId}:${location ?? 'document'}:${diagnostic.message}`}
            >
              <code>{diagnostic.code}</code>
              {location ? ` at ${location}` : ''}: {diagnostic.message}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function SourceFallback({
  source,
  diagnostics,
  rendererMessage,
}: {
  readonly source: string
  readonly diagnostics: ReadonlyArray<MdxSafeDocumentDiagnostic>
  readonly rendererMessage?: string
})
{
  const fallbackDiagnostics =
    rendererMessage === undefined
      ? diagnostics
      : [
          ...diagnostics,
          {
            code: 'MDX_RENDER',
            ruleId: '456code/mdx-render',
            severity: 'error',
            message: rendererMessage,
            source: '456code',
          } satisfies MdxSafeDocumentDiagnostic,
        ]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DiagnosticsList diagnostics={fallbackDiagnostics} assertive />
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4 text-xs">
        <code>{source}</code>
      </pre>
    </div>
  )
}

function WorkspaceMdxImage({
  environmentId,
  threadId,
  path,
  fragment,
  alt,
  title,
}: {
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
  readonly path: string
  readonly fragment: string | null
  readonly alt: string
  readonly title: string | undefined
})
{
  const assetUrl = useAssetUrlState(environmentId, {
    _tag: 'workspace-file',
    threadId,
    path,
  })

  if (assetUrl._tag === 'Failure')
  {
    return (
      <span className="text-destructive" role="alert">
        Unable to load workspace image.
      </span>
    )
  }
  if (assetUrl._tag === 'Loading')
  {
    return (
      <span className="text-muted-foreground" role="status">
        Loading workspace image…
      </span>
    )
  }

  const src = fragment === null ? assetUrl.url : `${assetUrl.url}#${encodeURIComponent(fragment)}`
  return <img src={src} alt={alt} title={title} />
}

function renderChildren(
  children: ReadonlyArray<MdxSafeDocumentNode>,
  context: RenderContext,
  keyPath: string,
): ReactNode
{
  return children.map((child, index) => renderMdxSafeNode(child, context, `${keyPath}.${index}`))
}

function renderAnchor(
  node: Extract<MdxSafeDocumentElementNode, { readonly tag: 'a' }>,
  context: RenderContext,
  keyPath: string,
): ReactNode
{
  const target = resolveMdxAnchorTarget(context.documentPath, node.props.href)
  const children = renderChildren(node.children, context, keyPath)

  switch (target.kind)
  {
    case 'workspace':
      return (
        <button
          key={keyPath}
          type="button"
          className="cursor-pointer text-left text-primary underline underline-offset-2"
          title={node.props.title}
          onClick={() => context.onOpenFile(target.path)}
        >
          {children}
        </button>
      )
    case 'external':
    {
      const opensNewContext =
        target.href.startsWith('http://') || target.href.startsWith('https://')
      return (
        <a
          key={keyPath}
          href={target.href}
          title={node.props.title}
          target={opensNewContext ? '_blank' : undefined}
          rel={opensNewContext ? 'noopener noreferrer' : undefined}
        >
          {children}
        </a>
      )
    }
    case 'rejected':
      throw new Error(`Unsafe MDX link target (${target.reason}).`)
  }
}

function renderImage(
  node: Extract<MdxSafeDocumentElementNode, { readonly tag: 'img' }>,
  context: RenderContext,
  keyPath: string,
): ReactNode
{
  const target = resolveMdxImageTarget(context.documentPath, node.props.src)
  if (target.kind === 'rejected')
  {
    throw new Error(`Unsafe MDX image target (${target.reason}).`)
  }

  return (
    <WorkspaceMdxImage
      key={keyPath}
      environmentId={context.environmentId}
      threadId={context.threadId}
      path={target.path}
      fragment={target.fragment}
      alt={node.props.alt}
      title={node.props.title}
    />
  )
}

function tableCellClass(align: 'left' | 'right' | 'center' | undefined): string | undefined
{
  switch (align)
  {
    case 'left':
      return 'text-left'
    case 'right':
      return 'text-right'
    case 'center':
      return 'text-center'
    case undefined:
      return undefined
  }
}

function renderElement(
  node: MdxSafeDocumentElementNode,
  context: RenderContext,
  keyPath: string,
): ReactNode
{
  const children = renderChildren(node.children, context, keyPath)

  switch (node.tag)
  {
    case 'a':
      return renderAnchor(node, context, keyPath)
    case 'blockquote':
      return <blockquote key={keyPath}>{children}</blockquote>
    case 'br':
      return <br key={keyPath} />
    case 'code':
      return (
        <code key={keyPath} data-language={node.props.language}>
          {children}
        </code>
      )
    case 'del':
      return <del key={keyPath}>{children}</del>
    case 'em':
      return <em key={keyPath}>{children}</em>
    case 'h1':
      return <h1 key={keyPath}>{children}</h1>
    case 'h2':
      return <h2 key={keyPath}>{children}</h2>
    case 'h3':
      return <h3 key={keyPath}>{children}</h3>
    case 'h4':
      return <h4 key={keyPath}>{children}</h4>
    case 'h5':
      return <h5 key={keyPath}>{children}</h5>
    case 'h6':
      return <h6 key={keyPath}>{children}</h6>
    case 'hr':
      return <hr key={keyPath} />
    case 'img':
      return renderImage(node, context, keyPath)
    case 'li':
      return (
        <li
          key={keyPath}
          className={node.props.checked === undefined ? undefined : 'task-list-item'}
        >
          {node.props.checked === undefined ? null : (
            <input
              type="checkbox"
              checked={node.props.checked}
              readOnly
              disabled
              aria-label={node.props.checked ? 'Completed task' : 'Incomplete task'}
            />
          )}
          {children}
        </li>
      )
    case 'ol':
      return (
        <ol key={keyPath} start={node.props.start}>
          {children}
        </ol>
      )
    case 'p':
      return <p key={keyPath}>{children}</p>
    case 'pre':
      return <pre key={keyPath}>{children}</pre>
    case 'strong':
      return <strong key={keyPath}>{children}</strong>
    case 'table':
      return (
        <div key={keyPath} className="chat-markdown-table-container">
          <table>{children}</table>
        </div>
      )
    case 'tbody':
      return <tbody key={keyPath}>{children}</tbody>
    case 'td':
      return (
        <td key={keyPath} className={tableCellClass(node.props.align)}>
          {children}
        </td>
      )
    case 'th':
      return (
        <th key={keyPath} className={tableCellClass(node.props.align)}>
          {children}
        </th>
      )
    case 'thead':
      return <thead key={keyPath}>{children}</thead>
    case 'tr':
      return <tr key={keyPath}>{children}</tr>
    case 'ul':
      return <ul key={keyPath}>{children}</ul>
    default:
    {
      const unsupported: never = node
      throw new Error(`Unsupported MDX element '${String(unsupported)}'.`)
    }
  }
}

function calloutClass(type: string | undefined): string
{
  switch (type)
  {
    case 'tip':
    case 'hint':
    case 'success':
      return 'border-emerald-500/35 bg-emerald-500/8'
    case 'warning':
    case 'caution':
    case 'important':
    case 'todo':
    case 'attention':
      return 'border-amber-500/35 bg-amber-500/8'
    case 'danger':
    case 'failure':
    case 'bug':
      return 'border-destructive/35 bg-destructive/8'
    case 'note':
    case 'info':
    case 'summary':
    case 'question':
    case 'quote':
    case 'example':
    case undefined:
      return 'border-primary/25 bg-primary/6'
    default:
      throw new Error(`Unsupported MDX callout type '${type}'.`)
  }
}

function requireNoChildren(node: {
  readonly name: string
  readonly children: ReadonlyArray<MdxSafeDocumentNode>
}): void
{
  if (node.children.length > 0)
  {
    throw new Error(`${node.name} does not accept children.`)
  }
}

function requireOpaqueId(componentName: string, id: string): void
{
  if (!OPAQUE_REFERENCE_ID_PATTERN.test(id))
  {
    throw new Error(`${componentName} contains an invalid opaque reference id.`)
  }
}

function renderComponent(
  node: MdxSafeDocumentComponentNode,
  context: RenderContext,
  keyPath: string,
): ReactNode
{
  switch (node.name)
  {
    case 'Callout':
      if (node.children.length === 0)
      {
        throw new Error('Callout requires document children.')
      }
      return (
        <aside
          key={keyPath}
          className={cn('my-4 rounded-md border px-4 py-3', calloutClass(node.props.type))}
        >
          {node.props.title ? <p className="mb-1 font-semibold">{node.props.title}</p> : null}
          {renderChildren(node.children, context, keyPath)}
        </aside>
      )
    case 'FileReference':
    {
      requireNoChildren(node)
      const target = normalizeMdxWorkspacePath(node.props.path)
      if (target.kind === 'rejected')
      {
        throw new Error(`Unsafe FileReference path (${target.reason}).`)
      }
      return (
        <button
          key={keyPath}
          type="button"
          className="rounded border border-border/70 bg-muted/35 px-2 py-1 font-mono text-xs text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => context.onOpenFile(target.path, node.props.line)}
        >
          {node.props.label ?? target.path}
          {node.props.line === undefined ? null : `:${node.props.line}`}
        </button>
      )
    }
    case 'SymbolReference':
    {
      requireNoChildren(node)
      requireOpaqueId(node.name, node.props.id)
      const label = node.props.label ?? node.props.id
      if (node.props.path === undefined)
      {
        return (
          <code key={keyPath} className="rounded bg-muted px-1.5 py-0.5">
            {label}
          </code>
        )
      }
      const target = normalizeMdxWorkspacePath(node.props.path)
      if (target.kind === 'rejected')
      {
        throw new Error(`Unsafe SymbolReference path (${target.reason}).`)
      }
      return (
        <button
          key={keyPath}
          type="button"
          className="rounded border border-border/70 bg-muted/35 px-2 py-1 font-mono text-xs text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => context.onOpenFile(target.path, node.props.line)}
        >
          {label}
        </button>
      )
    }
    case 'DiffReference':
      requireNoChildren(node)
      requireOpaqueId(node.name, node.props.id)
      return (
        <span
          key={keyPath}
          className="inline-flex rounded border border-border/70 bg-muted/35 px-2 py-1 font-mono text-xs"
          title="Diff details are unavailable in this MDX viewer."
        >
          {node.props.label ?? node.props.id}
        </span>
      )
    case 'ArchitectureImpact':
      requireOpaqueId(node.name, node.props.id)
      return (
        <aside
          key={keyPath}
          className="my-4 rounded-md border border-border/70 bg-muted/25 px-4 py-3"
        >
          <p className="font-semibold">{node.props.title ?? 'Impact Diff'}</p>
          <p className="text-xs text-muted-foreground">
            Architecture analysis is unavailable in this MDX viewer.
          </p>
          {renderChildren(node.children, context, keyPath)}
        </aside>
      )
    default:
    {
      const unsupported: never = node
      throw new Error(`Unsupported MDX component '${String(unsupported)}'.`)
    }
  }
}

export function renderMdxSafeNode(
  node: MdxSafeDocumentNode,
  context: RenderContext,
  keyPath: string,
): ReactNode
{
  switch (node.type)
  {
    case 'text':
      return node.value
    case 'element':
      return renderElement(node, context, keyPath)
    case 'component':
      return renderComponent(node, context, keyPath)
    default:
    {
      const unsupported: never = node
      throw new Error(`Unsupported MDX node '${String(unsupported)}'.`)
    }
  }
}

class SafeDocumentRenderBoundary extends Component<
  {
    readonly source: string
    readonly diagnostics: ReadonlyArray<MdxSafeDocumentDiagnostic>
    readonly children: ReactNode
  },
  { readonly error: Error | null }
>
{
  override state: { readonly error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { readonly error: Error }
  {
    return {
      error: rendererError(error),
    }
  }

  override render(): ReactNode
  {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <SourceFallback
        source={this.props.source}
        diagnostics={this.props.diagnostics}
        rendererMessage={this.state.error.message}
      />
    )
  }
}

function rendererError(error: unknown): Error
{
  return error instanceof Error ? error : new Error('The MDX renderer failed.')
}

export function SafeDocumentRenderer({
  document,
  source,
  documentPath,
  environmentId,
  threadId,
  onOpenFile,
}: SafeDocumentRendererProps)
{
  if (document.version !== 1)
  {
    return (
      <SourceFallback
        source={source}
        diagnostics={[]}
        rendererMessage={`Unsupported SafeDocument version '${String(document.version)}'.`}
      />
    )
  }

  const errorDiagnostics = document.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  )
  if (errorDiagnostics.length > 0)
  {
    return <SourceFallback source={source} diagnostics={document.diagnostics} />
  }

  const nonErrorDiagnostics = document.diagnostics.filter(
    (diagnostic) => diagnostic.severity !== 'error',
  )
  const context: RenderContext = {
    documentPath,
    environmentId,
    threadId,
    onOpenFile,
  }
  const resetKey = `${documentPath}:${source}`
  let renderedChildren: ReactNode
  try
  {
    renderedChildren = renderChildren(document.root.children, context, 'root')
  }
  catch (error)
  {
    return (
      <SourceFallback
        source={source}
        diagnostics={document.diagnostics}
        rendererMessage={rendererError(error).message}
      />
    )
  }

  return (
    <SafeDocumentRenderBoundary key={resetKey} source={source} diagnostics={document.diagnostics}>
      <div className="min-h-0 flex-1 overflow-auto">
        <DiagnosticsList diagnostics={nonErrorDiagnostics} assertive={false} />
        <article className="chat-markdown mx-auto max-w-4xl px-6 py-5">{renderedChildren}</article>
      </div>
    </SafeDocumentRenderBoundary>
  )
}
