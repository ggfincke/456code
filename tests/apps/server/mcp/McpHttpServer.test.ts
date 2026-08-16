// tests/apps/server/mcp/McpHttpServer.test.ts
// verifies mcp request authentication and response routing
import { expect, it } from '@effect/vitest'
import { NodeHttpServer } from '@effect/platform-node'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from '@t3tools/contracts'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { AiError, McpSchema, McpServer } from 'effect/unstable/ai'
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'

import * as McpHttpServer from '../../../../apps/server/src/mcp/McpHttpServer.ts'
import * as McpInvocationContext from '../../../../apps/server/src/mcp/McpInvocationContext.ts'
import * as PreviewAutomationBroker from '../../../../apps/server/src/mcp/PreviewAutomationBroker.ts'

const environmentId = EnvironmentId.make('environment-mcp-test')
const threadId = ThreadId.make('thread-mcp-test')
const tabId = PreviewTabId.make('tab-mcp-test')
const alternateTabId = PreviewTabId.make('tab-mcp-alternate')
const invocation = {
  environmentId,
  threadId,
  providerSessionId: 'provider-session-mcp-test',
  providerInstanceId: ProviderInstanceId.make('codex'),
  capabilities: new Set(['preview'] as const),
  issuedAt: 1,
}
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mcp-test', version: '1.0.0' },
  },
  getClient: Effect.die('unused'),
})
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
)

it('normalizes empty successful notification responses to accepted', () =>
{
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text('', { status: 200, contentType: 'application/json' }),
  )
  expect(notificationResponse.status).toBe(202)

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: '2.0', id: 1, result: {} }),
  )
  expect(resultResponse.status).toBe(200)
})

it.effect('bounds MCP HTTP request bodies before JSON decoding', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const bodyLimit = 128
      yield* HttpRouter.add(
        'POST',
        '/bounded-mcp',
        Effect.gen(function* ()
        {
          const request = yield* HttpServerRequest.HttpServerRequest
          const accepted = yield* request.text.pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          return accepted
            ? HttpServerResponse.empty({ status: 204 })
            : HttpServerResponse.empty({ status: 413 })
        }),
      ).pipe(
        HttpRouter.serve,
        Layer.provide(McpHttpServer.mcpRequestBodyLimitLayer(bodyLimit)),
        Layer.build,
      )
      const httpClient = yield* HttpClient.HttpClient

      const accepted = yield* httpClient.post('/bounded-mcp', {
        body: HttpBody.text('x'.repeat(bodyLimit), 'text/plain'),
      })
      expect(accepted.status).toBe(204)

      const rejected = yield* httpClient.post('/bounded-mcp', {
        body: HttpBody.text('x'.repeat(bodyLimit + 1), 'text/plain'),
      })
      expect(rejected.status).toBe(413)
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('returns bounded structural preview snapshot failures', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const server = yield* McpServer.McpServer
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker
      const events = yield* broker.connect({
        clientId: 'mcp-failure-client',
        environmentId,
      })
      yield* Stream.runForEach(events, (event) =>
        event.type === 'connected'
          ? Effect.void
          : broker.respond({
              clientId: 'mcp-failure-client',
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: 'PreviewAutomationExecutionError',
                message: 'sensitive renderer failure',
                detail: { consoleOutput: 'sensitive browser output' },
              },
            }),
      ).pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      const snapshot = yield* server
        .callTool({ name: 'preview_snapshot', arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        )

      expect(snapshot.isError).toBe(true)
      expect(snapshot.content).toEqual([{ type: 'text', text: 'Preview snapshot failed.' }])
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: 'PreviewAutomationExecutionError',
          operation: 'snapshot',
          failureCount: 1,
        },
      })
    }),
  ).pipe(Effect.provide(TestLayer)),
)

it.effect('terminates HTTP MCP sessions with DELETE', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const serverLayer = McpServer.layerHttp({
        name: 'MCP termination test',
        version: '1.0.0',
        path: '/mcp',
      })
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build)
      const httpClient = yield* HttpClient.HttpClient

      const initializeResponse = yield* httpClient.post('/mcp', {
        headers: { accept: 'application/json, text/event-stream' },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          'application/json',
        ),
      })
      const sessionId = initializeResponse.headers['mcp-session-id']
      expect(initializeResponse.status).toBe(200)
      expect(sessionId).not.toBeNull()

      const missingSessionResponse = yield* httpClient.del('/mcp')
      expect(missingSessionResponse.status).toBe(400)

      const unknownSessionResponse = yield* httpClient.del('/mcp', {
        headers: { 'mcp-session-id': 'unknown-session' },
      })
      expect(unknownSessionResponse.status).toBe(404)

      const terminateResponse = yield* httpClient.del('/mcp', {
        headers: { 'mcp-session-id': sessionId! },
      })
      expect(terminateResponse.status).toBe(204)

      const reusedSessionResponse = yield* httpClient.post('/mcp', {
        headers: {
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          'application/json',
        ),
      })
      expect(reusedSessionResponse.status).toBe(404)
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
)

it.effect('registers annotated tools and preserves authenticated request context', () =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const server = yield* McpServer.McpServer
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker
      const routedRequests: Array<{
        readonly operation: string
        readonly tabId?: string | undefined
      }> = []
      const events = yield* broker.connect({
        clientId: 'mcp-test-client',
        environmentId,
      })
      yield* Stream.runForEach(events, (event) =>
      {
        if (event.type === 'connected') return Effect.void
        routedRequests.push(event.request)
        return broker.respond({
          clientId: 'mcp-test-client',
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === 'snapshot'
              ? {
                  url: 'http://example.test/',
                  title: 'Example',
                  loading: false,
                  visibleText: 'Example',
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: 'image/png',
                    data: Buffer.from('png').toString('base64'),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === 'press'
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: 'http://example.test/',
                    title: 'Example',
                    loading: false,
                  },
        })
      }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      const statusTool = server.tools.find(({ tool }) => tool.name === 'preview_status')
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true)
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true)
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false)

      const snapshotTool = server.tools.find(({ tool }) => tool.name === 'preview_snapshot')
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true)
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true)
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true)

      const clickTool = server.tools.find(({ tool }) => tool.name === 'preview_click')
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false)
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true)
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true)

      const navigateTool = server.tools.find(({ tool }) => tool.name === 'preview_navigate')
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false)
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true)

      const status = yield* server
        .callTool({ name: 'preview_status', arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        )
      expect(status.isError).toBe(false)
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      })

      const malformed = yield* server
        .callTool({ name: 'preview_click', arguments: { selector: '' } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        )
      expect(malformed.isError).toBe(true)

      const snapshot = yield* server
        .callTool({ name: 'preview_snapshot', arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        )
      expect(snapshot.isError).toBe(false)
      expect(snapshot.content.some((content) => content.type === 'image')).toBe(true)
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: 'image/png', width: 10, height: 5 },
      })
      expect(routedRequests.find(({ operation }) => operation === 'snapshot')?.tabId).toBe(
        alternateTabId,
      )

      const actionRequests = [
        { name: 'preview_click', arguments: { x: 10, y: 10 } },
        { name: 'preview_type', arguments: { text: 'Hello' } },
        { name: 'preview_press', arguments: { key: 'Enter' } },
        { name: 'preview_scroll', arguments: { deltaY: 100 } },
        { name: 'preview_wait_for', arguments: { text: 'Example' } },
      ]
      for (const request of actionRequests)
      {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          )
        expect(result.isError).toBe(false)
        expect(result.structuredContent).toEqual({})
        expect(result.content).toEqual([{ type: 'text', text: '{}' }])
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
)

it.effect('maps architecture parameter validation to structured invalid-patch', () =>
  Effect.gen(function* ()
  {
    const cause = Cause.fail(
      AiError.make({
        module: 'Toolkit',
        method: 'architecture_propose_patch.handle',
        reason: new AiError.ToolParameterValidationError({
          toolName: 'architecture_propose_patch',
          toolParams: { path: 'src/a.ts' },
          description: 'Expected { from, to }',
        }),
      }),
    )
    const result = yield* McpHttpServer.architectureToolCallFailure('architecture_propose_patch')(
      cause,
    )

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: {
        _tag: 'ArchitectureToolError',
        operation: 'architecture_propose_patch',
        code: 'invalid-patch',
        detail: 'Expected { from, to }',
      },
    })
  }),
)

it.effect('masks unexpected architecture tool failures and preserves interruption', () =>
  Effect.gen(function* ()
  {
    const defect = yield* McpHttpServer.architectureToolCallFailure('architecture_context')(
      Cause.die(new Error('/Users/secret/workspace/db.sqlite is locked')),
    )

    expect(defect.isError).toBe(true)
    expect(defect.content).toEqual([
      { type: 'text', text: McpHttpServer.ARCHITECTURE_TOOL_UNEXPECTED_FAILURE_TEXT },
    ])
    expect(defect.structuredContent).toBeUndefined()

    const interrupted = yield* Effect.exit(
      McpHttpServer.architectureToolCallFailure('architecture_context')(Cause.interrupt(1)),
    )
    expect(Exit.isFailure(interrupted)).toBe(true)
  }),
)
