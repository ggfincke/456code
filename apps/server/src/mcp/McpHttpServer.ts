// apps/server/src/mcp/McpHttpServer.ts
// serves authenticated model context protocol requests
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import type * as Types from 'effect/Types'
import { McpProtocol, McpSchema, McpServer, Tool, type Toolkit } from 'effect/unstable/ai'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { ArchitecturePlanImpactUpsertInput, ArchitectureToolError } from '@t3tools/contracts'

import packageJson from '../../package.json' with { type: 'json' }
import * as ArchitectureQueryService from '../cartographer/ArchitectureQueryService.ts'
import * as PlannedImpactService from '../architecture/PlannedImpactService.ts'
import * as McpInvocationContext from './McpInvocationContext.ts'
import * as McpSessionRegistry from './McpSessionRegistry.ts'
import * as PreviewAutomationBroker from './PreviewAutomationBroker.ts'
import * as ProjectionSnapshotQuery from '../orchestration/Services/ProjectionSnapshotQuery.ts'
import { ArchitectureToolkitHandlersLive } from './toolkits/architecture/handlers.ts'
import { ArchitectureToolkit } from './toolkits/architecture/tools.ts'
import { OrchestrateToolkitHandlersLive } from './toolkits/orchestrate/handlers.ts'
import { OrchestrateToolkit } from './toolkits/orchestrate/tools.ts'
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from './toolkits/preview/handlers.ts'
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from './toolkits/preview/tools.ts'
import { ProposalToolkitHandlersLive } from './toolkits/proposal/handlers.ts'
import { ProposalToolkit } from './toolkits/proposal/tools.ts'

export const MCP_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024

export function mcpRequestBodyLimitLayer(
  maxBytes: number = MCP_MAX_REQUEST_BODY_BYTES,
): Layer.Layer<never>
{
  return HttpRouter.middleware()((httpEffect) =>
    httpEffect.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(maxBytes)),
    ),
  ).layer
}

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: 'invalid_mcp_credential',
    message: 'A valid provider-scoped MCP bearer credential is required.',
  },
  {
    status: 401,
    headers: {
      'cache-control': 'no-store',
      'www-authenticate': 'Bearer',
    },
  },
)

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse =>
{
  const bodyIsEmpty =
    response.body._tag === 'Empty' ||
    (response.body._tag === 'Uint8Array' && response.body.contentLength === 0) ||
    (response.body._tag === 'Raw' && response.body.contentLength === 0)
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response
}

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map((registry): McpAuthMiddleware =>
    Effect.fn('McpHttpServer.authenticateRequest')(function* (httpEffect)
    {
      const request = yield* HttpServerRequest.HttpServerRequest
      const authorization = request.headers.authorization
      const token =
        authorization?.startsWith('Bearer ') === true
          ? authorization.slice('Bearer '.length).trim()
          : ''
      const invocation = yield* registry.resolve(token)
      if (!invocation)
      {
        // log failures because otherwise agents silently lose the 456code toolkit
        yield* Effect.logWarning('rejected MCP request with an unusable credential', {
          reason: token.length === 0 ? 'missing_bearer_token' : 'unknown_or_expired_token',
        })
        return unauthorized
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.map(normalizeMcpHttpResponse),
      )
    }),
  ),
  Effect.withSpan('McpHttpServer.makeAuthMiddleware'),
)

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext
}>()(makeMcpAuthMiddleware).layer

// keep snapshot text below agent output ceilings while preserving structured data.
export const MAX_SNAPSHOT_TEXT_BYTES = 60_000
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200
const MAX_SNAPSHOT_LOG_ENTRIES = 40
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const utf8Length = (text: string) => Buffer.byteLength(text, 'utf8')
const cutText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

function cutEntryStrings<A>(entry: A): A
{
  return typeof entry === 'object' && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === 'string' ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry
}

function hasLongString(entry: unknown, max: number): boolean
{
  return (
    typeof entry === 'object' &&
    entry !== null &&
    Object.values(entry).some((value) => typeof value === 'string' && value.length > max)
  )
}

export interface SnapshotMetadata
{
  readonly url: string
  readonly title: string
  readonly visibleText: string
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string
    readonly [key: string]: unknown
  }>
  readonly consoleEntries: ReadonlyArray<unknown>
  readonly networkEntries: ReadonlyArray<unknown>
  readonly actionTimeline: ReadonlyArray<unknown>
  readonly [key: string]: unknown
}

export function boundSnapshotMetadata(metadata: SnapshotMetadata): {
  readonly text: string
  readonly omitted: ReadonlyArray<string>
}
{
  const omitted: string[] = []
  const { accessibilityTree, ...withoutTree } = metadata
  if (accessibilityTree !== undefined)
  {
    omitted.push('accessibilityTree (use interactiveElements locators or preview_evaluate)')
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string): ReadonlyArray<A> =>
  {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES)
    {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`)
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES)
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS)))
    {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`)
    }
    return kept.map(cutEntryStrings)
  }
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  )
  {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`)
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  )
  {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`)
  }
  if (metadata.visibleText.length > MAX_SNAPSHOT_VISIBLE_TEXT_CHARS)
  {
    omitted.push(
      `visibleText after ${MAX_SNAPSHOT_VISIBLE_TEXT_CHARS} characters (use preview_evaluate for more)`,
    )
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    visibleText: cutText(metadata.visibleText, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, 'console entries'),
    networkEntries: tail(metadata.networkEntries, 'network entries'),
    actionTimeline: tail(metadata.actionTimeline, 'action timeline entries'),
  }
  const shedOrder = [
    'actionTimeline',
    'networkEntries',
    'consoleEntries',
    'interactiveElements',
  ] as const
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  }
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  }
  let text = encodeJsonText({ ...bounded, ...lists })
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES)
  {
    const key =
      shedOrder.find(
        (candidate) => candidate !== 'interactiveElements' && lists[candidate].length > 0,
      ) ?? (lists.interactiveElements.length > 0 ? 'interactiveElements' : undefined)
    if (key === undefined) break
    const keep = Math.floor(lists[key].length / 2)
    dropped[key] += lists[key].length - keep
    lists[key] =
      keep === 0
        ? []
        : key === 'interactiveElements'
          ? lists[key].slice(0, keep)
          : lists[key].slice(-keep)
    text = encodeJsonText({ ...bounded, ...lists })
  }
  for (const key of shedOrder)
  {
    if (dropped[key] > 0)
    {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`)
    }
  }
  return { text, omitted }
}

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) =>
{
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason))
  {
    return Effect.failCause(cause).pipe(Effect.orDie)
  }
  const failures = cause.reasons.filter(Cause.isFailReason)
  const firstFailure = failures[0]?.error
  const errorTag =
    typeof firstFailure === 'object' &&
    firstFailure !== null &&
    '_tag' in firstFailure &&
    typeof firstFailure._tag === 'string'
      ? firstFailure._tag
      : 'PreviewSnapshotError'
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: 'snapshot',
        failureCount: failures.length,
      },
    },
    content: [{ type: 'text', text: 'Preview snapshot failed.' }],
  })
  return Effect.logWarning('preview snapshot failed', {
    operation: 'snapshot',
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result))
}

const registerPreviewSnapshot = Effect.fn('McpHttpServer.registerPreviewSnapshot')(function* ()
{
  const server = yield* McpServer.McpServer
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker
  const built = yield* PreviewSnapshotToolkit
  const tool = PreviewSnapshotTool
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) =>
      {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        )
        return built.handle('preview_snapshot', payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) =>
            {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly screenshot: {
                  readonly mimeType: 'image/png'
                  readonly data: string
                  readonly width: number
                  readonly height: number
                }
                readonly [key: string]: unknown
              }
              const { screenshot, ...page } = snapshot
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              }
              const bounded = boundSnapshotMetadata(metadata)
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: 'text', text: bounded.text },
                    ...(bounded.omitted.length === 0
                      ? []
                      : [
                          {
                            type: 'text' as const,
                            text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join('; ')}.`,
                          },
                        ]),
                    ...(payload?.includeImage === false
                      ? []
                      : [
                          {
                            type: 'image' as const,
                            data: new Uint8Array(Buffer.from(screenshot.data, 'base64')),
                            mimeType: screenshot.mimeType,
                          },
                        ]),
                  ],
                }),
              )
            },
          }),
        )
      }),
  })
})

// validation failures remain tool results so clients can correct arguments and retry
const registerToolkit = Effect.fn('McpHttpServer.registerToolkit')(function* <
  Tools extends Record<string, Tool.Any>,
>(toolkit: Toolkit.Toolkit<Tools>)
{
  const server = yield* McpServer.McpServer
  const registrationBoundary = McpServer.McpServer.of({
    ...server,
    addTool: (registration) =>
      server.addTool({
        ...registration,
        handle: (payload) =>
          registration.handle(payload).pipe(
            Effect.catchTag('InvalidParams', (error) =>
              Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: true,
                  content: [{ type: 'text', text: error.message }],
                }),
              ),
            ),
          ),
      }),
  })
  yield* McpServer.registerToolkit(toolkit).pipe(
    Effect.provideService(McpServer.McpServer, registrationBoundary),
  )
})

const PreviewStandardToolkitRegistrationLive = Layer.effectDiscard(
  registerToolkit(PreviewStandardToolkit),
).pipe(Layer.provide(PreviewStandardToolkitHandlersLive), Layer.provide(McpServer.McpServer.layer))

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
)

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
)

export const ProposalToolkitRegistrationLive = Layer.effectDiscard(
  registerToolkit(ProposalToolkit),
).pipe(Layer.provide(ProposalToolkitHandlersLive), Layer.provide(McpServer.McpServer.layer))

export const OrchestrateToolkitRegistrationLive = Layer.effectDiscard(
  registerToolkit(OrchestrateToolkit),
).pipe(Layer.provide(OrchestrateToolkitHandlersLive), Layer.provide(McpServer.McpServer.layer))

export const ARCHITECTURE_TOOL_UNEXPECTED_FAILURE_TEXT =
  'Architecture tool failed unexpectedly. Retry, or ask the operator to check the server log.'

const encodeArchitectureToolError = Schema.encodeUnknownSync(ArchitectureToolError)
const isArchitectureToolError = Schema.is(ArchitectureToolError)
const decodeArchitecturePlanImpactInput = Schema.decodeUnknownEffect(
  ArchitecturePlanImpactUpsertInput,
  { onExcessProperty: 'error' },
)

function toolParameterValidationDescription(error: unknown): string | null
{
  if (typeof error !== 'object' || error === null || !('_tag' in error)) return null
  if (error._tag === 'AiError' && 'reason' in error)
  {
    return toolParameterValidationDescription(error.reason)
  }
  if (
    error._tag === 'ToolParameterValidationError' &&
    'description' in error &&
    typeof error.description === 'string'
  )
  {
    return error.description
  }
  return null
}

function architectureInvalidInputResult(
  toolName: string,
  cause: Cause.Cause<unknown>,
): McpSchema.CallToolResult | null
{
  for (const reason of cause.reasons)
  {
    if (!Cause.isFailReason(reason)) continue
    if (isArchitectureToolError(reason.error))
    {
      return architectureToolCallResult({
        isFailure: true,
        encodedResult: encodeArchitectureToolError(reason.error),
      })
    }
    const description = toolParameterValidationDescription(reason.error)
    if (description === null) continue
    return architectureToolCallResult({
      isFailure: true,
      encodedResult: encodeArchitectureToolError(
        new ArchitectureToolError({
          operation: toolName,
          code:
            toolName === 'architecture_plan_impact_upsert'
              ? 'invalid-publication'
              : 'invalid-patch',
          detail: description,
        }),
      ),
    })
  }
  return null
}

// typed validation failures stay structured so the model can correct and retry
export const architectureToolCallFailure =
  (toolName: string) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<McpSchema.CallToolResult> =>
  {
    if (Cause.hasInterruptsOnly(cause))
    {
      return Effect.failCause(cause as Cause.Cause<never>)
    }
    const invalidInput = architectureInvalidInputResult(toolName, cause)
    if (invalidInput !== null)
    {
      return Effect.succeed(invalidInput)
    }
    return Effect.logError('architecture tool call failed', {
      tool: toolName,
      cause: Cause.pretty(cause),
    }).pipe(
      Effect.as(
        new McpSchema.CallToolResult({
          isError: true,
          content: [{ type: 'text', text: ARCHITECTURE_TOOL_UNEXPECTED_FAILURE_TEXT }],
        }),
      ),
    )
  }

const architectureToolCallResult = (result: {
  readonly encodedResult: unknown
  readonly isFailure: boolean
}): McpSchema.CallToolResult =>
{
  if (result.isFailure)
  {
    return new McpSchema.CallToolResult({
      isError: true,
      structuredContent: { error: result.encodedResult },
      content: [
        {
          type: 'text',
          text: 'Architecture tool failed. See structuredContent.error for details.',
        },
      ],
    })
  }
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: typeof result.encodedResult === 'object' ? result.encodedResult : undefined,
    content: [{ type: 'text', text: JSON.stringify(result.encodedResult) }],
  })
}

const registerArchitectureToolkit = Effect.fn('McpHttpServer.registerArchitectureToolkit')(
  function* ()
  {
    const server = yield* McpServer.McpServer
    const queryService = yield* ArchitectureQueryService.ArchitectureQueryService
    const plannedImpactService = yield* PlannedImpactService.PlannedImpactService
    const projectionSnapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery
    const built = yield* ArchitectureToolkit
    for (const tool of Object.values(built.tools))
    {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: Tool.getJsonSchema(tool),
          annotations: {
            ...Context.getOption(tool.annotations, Tool.Title).pipe(
              Option.map((title) => ({ title })),
              Option.getOrUndefined,
            ),
            readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
            destructiveHint: Context.get(tool.annotations, Tool.Destructive),
            idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
            openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
          },
          _meta: Context.getOrUndefined(tool.annotations, Tool.Meta),
        }),
        annotations: tool.annotations,
        handle: (payload) =>
          Effect.withFiber((fiber) =>
          {
            const invocation = Context.getUnsafe(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            )
            const decodedPayload =
              tool.name === 'architecture_plan_impact_upsert'
                ? decodeArchitecturePlanImpactInput(payload).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ArchitectureToolError({
                          operation: tool.name,
                          code: 'invalid-publication',
                          detail: cause.message,
                        }),
                    ),
                  )
                : Effect.succeed(payload)
            return decodedPayload.pipe(
              Effect.flatMap((input) => built.handle(tool.name, input)),
              Stream.unwrap,
              Stream.run(Sink.last()),
              Effect.flatMap(Effect.fromOption),
              Effect.provideService(
                ArchitectureQueryService.ArchitectureQueryService,
                queryService,
              ),
              Effect.provideService(
                PlannedImpactService.PlannedImpactService,
                plannedImpactService,
              ),
              Effect.provideService(
                ProjectionSnapshotQuery.ProjectionSnapshotQuery,
                projectionSnapshots,
              ),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.matchCauseEffect({
                onFailure: architectureToolCallFailure(tool.name),
                onSuccess: (result) => Effect.succeed(architectureToolCallResult(result)),
              }),
            )
          }),
      })
    }
  },
)

export const ArchitectureToolkitRegistrationLive = Layer.effectDiscard(
  registerArchitectureToolkit(),
).pipe(Layer.provide(ArchitectureToolkitHandlersLive))

const McpTransportLive = McpServer.layerHttp({
  name: '456code',
  version: packageJson.version,
  path: '/mcp',
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide([McpAuthMiddlewareLive, mcpRequestBodyLimitLayer()]))

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  ProposalToolkitRegistrationLive,
  OrchestrateToolkitRegistrationLive,
  ArchitectureToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive))
