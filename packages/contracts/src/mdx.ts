// packages/contracts/src/mdx.ts
// defines the closed safe mdx document and workspace read transport

import * as Schema from 'effect/Schema'

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from './baseSchemas.ts'

const MDX_PATH_MAX_LENGTH = 1024
const MDX_REFERENCE_MAX_LENGTH = 256
const MDX_SOURCE_MAX_LENGTH = 1024 * 1024
const MDX_DOCUMENT_MAX_NODES = 10_000
const MDX_DIAGNOSTIC_MAX_COUNT = 10_000
const MDX_JSON_STRING_MAX_LENGTH = 64 * 1024
const MDX_JSON_CONTAINER_MAX_ENTRIES = 512

const MdxPath = TrimmedNonEmptyString.check(Schema.isMaxLength(MDX_PATH_MAX_LENGTH))
const MdxReference = Schema.String.check(Schema.isMaxLength(MDX_REFERENCE_MAX_LENGTH))
const MdxOptionalReference = Schema.optionalKey(MdxReference)
const MdxNodeText = Schema.String.check(Schema.isMaxLength(MDX_SOURCE_MAX_LENGTH))

export type MdxSafeJsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<MdxSafeJsonValue>
  | { readonly [key: string]: MdxSafeJsonValue }

const MdxSafeJsonValueRef = Schema.suspend((): Schema.Codec<MdxSafeJsonValue> => MdxSafeJsonValue)

export const MdxSafeJsonValue: Schema.Codec<MdxSafeJsonValue> = Schema.Union([
  Schema.String.check(Schema.isMaxLength(MDX_JSON_STRING_MAX_LENGTH)),
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
  Schema.Array(MdxSafeJsonValueRef).check(Schema.isMaxLength(MDX_JSON_CONTAINER_MAX_ENTRIES)),
  Schema.Record(
    Schema.String.check(Schema.isMaxLength(MDX_REFERENCE_MAX_LENGTH)),
    MdxSafeJsonValueRef,
  ).check(Schema.isMaxProperties(MDX_JSON_CONTAINER_MAX_ENTRIES)),
])

const MdxSafeJsonRecord = Schema.Record(
  Schema.String.check(Schema.isMaxLength(MDX_REFERENCE_MAX_LENGTH)),
  MdxSafeJsonValueRef,
).check(Schema.isMaxProperties(MDX_JSON_CONTAINER_MAX_ENTRIES))

export const MdxSafeDocumentPoint = Schema.Struct({
  line: PositiveInt,
  column: PositiveInt,
  offset: Schema.optionalKey(NonNegativeInt),
})
export type MdxSafeDocumentPoint = typeof MdxSafeDocumentPoint.Type

export const MdxSafeDocumentRange = Schema.Struct({
  start: MdxSafeDocumentPoint,
  end: MdxSafeDocumentPoint,
})
export type MdxSafeDocumentRange = typeof MdxSafeDocumentRange.Type

export interface MdxSafeDocumentRootNode
{
  readonly type: 'root'
  readonly children: ReadonlyArray<MdxSafeDocumentNode>
  readonly source?: MdxSafeDocumentRange
}

export interface MdxSafeDocumentTextNode
{
  readonly type: 'text'
  readonly value: string
  readonly source?: MdxSafeDocumentRange
}

interface MdxSafeDocumentElementNodeBase<
  TTag extends MdxSafeDocumentElementTag,
  TProps extends object,
>
{
  readonly type: 'element'
  readonly tag: TTag
  readonly props: TProps
  readonly children: ReadonlyArray<MdxSafeDocumentNode>
  readonly source?: MdxSafeDocumentRange
}

export type MdxSafeDocumentElementTag =
  | 'a'
  | 'blockquote'
  | 'br'
  | 'code'
  | 'del'
  | 'em'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'hr'
  | 'img'
  | 'li'
  | 'ol'
  | 'p'
  | 'pre'
  | 'strong'
  | 'table'
  | 'tbody'
  | 'td'
  | 'th'
  | 'thead'
  | 'tr'
  | 'ul'

export interface MdxSafeDocumentLinkProps
{
  readonly href: string
  readonly title?: string
}

export interface MdxSafeDocumentImageProps
{
  readonly src: string
  readonly alt: string
  readonly title?: string
}

export interface MdxSafeDocumentCodeProps
{
  readonly language?: string
  readonly meta?: string
}

export interface MdxSafeDocumentOrderedListProps
{
  readonly start?: number
}

export interface MdxSafeDocumentListItemProps
{
  readonly checked?: boolean
}

export interface MdxSafeDocumentTableCellProps
{
  readonly align?: 'left' | 'right' | 'center'
}

type MdxSafeDocumentPropFreeTag = Exclude<
  MdxSafeDocumentElementTag,
  'a' | 'code' | 'img' | 'li' | 'ol' | 'td' | 'th'
>

export type MdxSafeDocumentElementNode =
  | MdxSafeDocumentElementNodeBase<'a', MdxSafeDocumentLinkProps>
  | MdxSafeDocumentElementNodeBase<'code', MdxSafeDocumentCodeProps>
  | MdxSafeDocumentElementNodeBase<'img', MdxSafeDocumentImageProps>
  | MdxSafeDocumentElementNodeBase<'li', MdxSafeDocumentListItemProps>
  | MdxSafeDocumentElementNodeBase<'ol', MdxSafeDocumentOrderedListProps>
  | MdxSafeDocumentElementNodeBase<'td' | 'th', MdxSafeDocumentTableCellProps>
  | MdxSafeDocumentElementNodeBase<MdxSafeDocumentPropFreeTag, Record<string, never>>

export const MdxSafeDocumentCalloutType = Schema.Literals([
  'note',
  'tip',
  'warning',
  'danger',
  'info',
  'caution',
  'important',
  'summary',
  'hint',
  'success',
  'question',
  'failure',
  'bug',
  'example',
  'quote',
  'todo',
  'attention',
])
export type MdxSafeDocumentCalloutType = typeof MdxSafeDocumentCalloutType.Type

export interface MdxSafeDocumentCalloutNode
{
  readonly type: 'component'
  readonly name: 'Callout'
  readonly props: {
    readonly type?: MdxSafeDocumentCalloutType
    readonly title?: string
  }
  readonly children: ReadonlyArray<MdxSafeDocumentNode>
  readonly source?: MdxSafeDocumentRange
}

export interface MdxSafeDocumentFileReferenceNode
{
  readonly type: 'component'
  readonly name: 'FileReference'
  readonly props: {
    readonly path: string
    readonly line?: number
    readonly label?: string
  }
  readonly children: ReadonlyArray<MdxSafeDocumentNode>
  readonly source?: MdxSafeDocumentRange
}

export interface MdxSafeDocumentSymbolReferenceNode
{
  readonly type: 'component'
  readonly name: 'SymbolReference'
  readonly props: {
    readonly id: string
    readonly label?: string
    readonly path?: string
    readonly line?: number
  }
  readonly children: ReadonlyArray<MdxSafeDocumentNode>
  readonly source?: MdxSafeDocumentRange
}

export interface MdxSafeDocumentDiffReferenceNode
{
  readonly type: 'component'
  readonly name: 'DiffReference'
  readonly props: {
    readonly id: string
    readonly label?: string
  }
  readonly children: ReadonlyArray<MdxSafeDocumentNode>
  readonly source?: MdxSafeDocumentRange
}

export interface MdxSafeDocumentArchitectureImpactNode
{
  readonly type: 'component'
  readonly name: 'ArchitectureImpact'
  readonly props: {
    readonly id: string
    readonly title?: string
  }
  readonly children: ReadonlyArray<MdxSafeDocumentNode>
  readonly source?: MdxSafeDocumentRange
}

export type MdxSafeDocumentComponentNode =
  | MdxSafeDocumentCalloutNode
  | MdxSafeDocumentFileReferenceNode
  | MdxSafeDocumentSymbolReferenceNode
  | MdxSafeDocumentDiffReferenceNode
  | MdxSafeDocumentArchitectureImpactNode

export type MdxSafeDocumentNode =
  MdxSafeDocumentTextNode | MdxSafeDocumentElementNode | MdxSafeDocumentComponentNode

const MdxSafeDocumentNodeRef = Schema.suspend(
  (): Schema.Codec<MdxSafeDocumentNode> => MdxSafeDocumentNode,
)
const MdxSafeDocumentChildren = Schema.Array(MdxSafeDocumentNodeRef).check(
  Schema.isMaxLength(MDX_DOCUMENT_MAX_NODES),
)
const MdxSafeDocumentNoChildren = Schema.Array(MdxSafeDocumentNodeRef).check(Schema.isMaxLength(0))
const MdxSafeDocumentSource = Schema.optionalKey(MdxSafeDocumentRange)
const MdxSafeDocumentEmptyProps = Schema.Struct({})
const MdxSafeDocumentLinkProps = Schema.Struct({
  href: MdxNodeText,
  title: Schema.optionalKey(MdxReference),
})
const MdxSafeDocumentImageProps = Schema.Struct({
  src: MdxPath,
  alt: MdxNodeText,
  title: Schema.optionalKey(MdxReference),
})
const MdxSafeDocumentCodeProps = Schema.Struct({
  language: MdxOptionalReference,
  meta: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MDX_JSON_STRING_MAX_LENGTH))),
})
const MdxSafeDocumentOrderedListProps = Schema.Struct({
  start: Schema.optionalKey(Schema.Int),
})
const MdxSafeDocumentListItemProps = Schema.Struct({
  checked: Schema.optionalKey(Schema.Boolean),
})
const MdxSafeDocumentTableCellProps = Schema.Struct({
  align: Schema.optionalKey(Schema.Literals(['left', 'right', 'center'])),
})

const MdxSafeDocumentPropFreeElementNode = Schema.Struct({
  type: Schema.Literal('element'),
  tag: Schema.Literals([
    'blockquote',
    'br',
    'del',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'p',
    'pre',
    'strong',
    'table',
    'tbody',
    'thead',
    'tr',
    'ul',
  ]),
  props: MdxSafeDocumentEmptyProps,
  children: MdxSafeDocumentChildren,
  source: MdxSafeDocumentSource,
})

export const MdxSafeDocumentElementNode: Schema.Codec<MdxSafeDocumentElementNode> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('element'),
    tag: Schema.Literal('a'),
    props: MdxSafeDocumentLinkProps,
    children: MdxSafeDocumentChildren,
    source: MdxSafeDocumentSource,
  }),
  Schema.Struct({
    type: Schema.Literal('element'),
    tag: Schema.Literal('code'),
    props: MdxSafeDocumentCodeProps,
    children: MdxSafeDocumentChildren,
    source: MdxSafeDocumentSource,
  }),
  Schema.Struct({
    type: Schema.Literal('element'),
    tag: Schema.Literal('img'),
    props: MdxSafeDocumentImageProps,
    children: MdxSafeDocumentChildren,
    source: MdxSafeDocumentSource,
  }),
  Schema.Struct({
    type: Schema.Literal('element'),
    tag: Schema.Literal('li'),
    props: MdxSafeDocumentListItemProps,
    children: MdxSafeDocumentChildren,
    source: MdxSafeDocumentSource,
  }),
  Schema.Struct({
    type: Schema.Literal('element'),
    tag: Schema.Literal('ol'),
    props: MdxSafeDocumentOrderedListProps,
    children: MdxSafeDocumentChildren,
    source: MdxSafeDocumentSource,
  }),
  Schema.Struct({
    type: Schema.Literal('element'),
    tag: Schema.Literals(['td', 'th']),
    props: MdxSafeDocumentTableCellProps,
    children: MdxSafeDocumentChildren,
    source: MdxSafeDocumentSource,
  }),
  MdxSafeDocumentPropFreeElementNode,
])

const MdxSafeDocumentComponentBase = {
  type: Schema.Literal('component'),
  children: MdxSafeDocumentChildren,
  source: MdxSafeDocumentSource,
} as const

export const MdxSafeDocumentComponentNode: Schema.Codec<MdxSafeDocumentComponentNode> =
  Schema.Union([
    Schema.Struct({
      ...MdxSafeDocumentComponentBase,
      name: Schema.Literal('Callout'),
      props: Schema.Struct({
        type: Schema.optionalKey(MdxSafeDocumentCalloutType),
        title: MdxOptionalReference,
      }),
    }),
    Schema.Struct({
      type: Schema.Literal('component'),
      name: Schema.Literal('FileReference'),
      props: Schema.Struct({
        path: MdxPath,
        line: Schema.optionalKey(PositiveInt),
        label: MdxOptionalReference,
      }),
      children: MdxSafeDocumentNoChildren,
      source: MdxSafeDocumentSource,
    }),
    Schema.Struct({
      type: Schema.Literal('component'),
      name: Schema.Literal('SymbolReference'),
      props: Schema.Struct({
        id: MdxReference,
        label: MdxOptionalReference,
        path: Schema.optionalKey(MdxPath),
        line: Schema.optionalKey(PositiveInt),
      }),
      children: MdxSafeDocumentNoChildren,
      source: MdxSafeDocumentSource,
    }),
    Schema.Struct({
      type: Schema.Literal('component'),
      name: Schema.Literal('DiffReference'),
      props: Schema.Struct({
        id: MdxReference,
        label: MdxOptionalReference,
      }),
      children: MdxSafeDocumentNoChildren,
      source: MdxSafeDocumentSource,
    }),
    Schema.Struct({
      ...MdxSafeDocumentComponentBase,
      name: Schema.Literal('ArchitectureImpact'),
      props: Schema.Struct({
        id: MdxReference,
        title: MdxOptionalReference,
      }),
    }),
  ])

export const MdxSafeDocumentNode: Schema.Codec<MdxSafeDocumentNode> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('text'),
    value: MdxNodeText,
    source: MdxSafeDocumentSource,
  }),
  MdxSafeDocumentElementNode,
  MdxSafeDocumentComponentNode,
])

export const MdxSafeDocumentRootNode: Schema.Codec<MdxSafeDocumentRootNode> = Schema.Struct({
  type: Schema.Literal('root'),
  children: MdxSafeDocumentChildren,
  source: MdxSafeDocumentSource,
})

export const MdxSafeDocumentDiagnostic = Schema.Struct({
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  ruleId: TrimmedNonEmptyString.check(Schema.isMaxLength(MDX_REFERENCE_MAX_LENGTH)),
  severity: Schema.Literals(['error', 'warning', 'info', 'hint']),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(16 * 1024)),
  source: Schema.Literals(['mdx-forge', '456code']),
  range: Schema.optionalKey(MdxSafeDocumentRange),
  data: Schema.optionalKey(MdxSafeJsonRecord),
})
export type MdxSafeDocumentDiagnostic = typeof MdxSafeDocumentDiagnostic.Type

export const MdxSafeDocument = Schema.Struct({
  version: Schema.Literal(1),
  frontmatter: MdxSafeJsonRecord,
  root: MdxSafeDocumentRootNode,
  diagnostics: Schema.Array(MdxSafeDocumentDiagnostic).check(
    Schema.isMaxLength(MDX_DIAGNOSTIC_MAX_COUNT),
  ),
})
export type MdxSafeDocument = typeof MdxSafeDocument.Type

export const ProjectReadMdxDocumentInput = Schema.Struct({
  threadId: ThreadId,
  relativePath: MdxPath,
})
export type ProjectReadMdxDocumentInput = typeof ProjectReadMdxDocumentInput.Type

export const ProjectReadMdxDocumentResult = Schema.Struct({
  transportVersion: Schema.Literal(1),
  relativePath: MdxPath,
  byteLength: NonNegativeInt,
  source: Schema.String.check(Schema.isMaxLength(MDX_SOURCE_MAX_LENGTH)),
  document: MdxSafeDocument,
})
export type ProjectReadMdxDocumentResult = typeof ProjectReadMdxDocumentResult.Type

export const ProjectReadMdxDocumentFailure = Schema.Literals([
  'workspace_context_not_found',
  'unsupported_extension',
  'file_too_large',
  'compile_failed',
  'invalid_compiler_output',
])
export type ProjectReadMdxDocumentFailure = typeof ProjectReadMdxDocumentFailure.Type

export class ProjectReadMdxDocumentError extends Schema.TaggedErrorClass<ProjectReadMdxDocumentError>()(
  'ProjectReadMdxDocumentError',
  {
    threadId: Schema.optional(ThreadId),
    relativePath: Schema.optional(MdxPath),
    failure: Schema.optional(ProjectReadMdxDocumentFailure),
    message: TrimmedNonEmptyString,
  },
)
{
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly threadId: ThreadId
    readonly relativePath: string
    readonly failure: ProjectReadMdxDocumentFailure
    readonly message?: string
  })
  {
    super({
      ...props,
      message:
        props.message ??
        `Failed to read safe MDX document '${props.relativePath}' for thread '${props.threadId}'.`,
    } as any)
  }
}
