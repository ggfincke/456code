// tests/apps/server/provider/Layers/CodexSessionRuntime.test.ts
// verifies codex session runtime recovery and lifecycle behavior

import * as NodeAssert from 'node:assert/strict'

import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe } from 'vite-plus/test'
import { DEFAULT_MODEL, ThreadId } from '@t3tools/contracts'
import * as CodexErrors from 'effect-codex-app-server/errors'
import * as CodexRpc from 'effect-codex-app-server/rpc'
import * as EffectCodexSchema from 'effect-codex-app-server/schema'

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_ORCHESTRATE_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from '../../../../../apps/server/src/provider/CodexDeveloperInstructions.ts'
import { codexSessionAppServerArgs } from '../../../../../apps/server/src/provider/Layers/codexLaunchArgs.ts'
import {
  buildTurnStartParams,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  openCodexThread,
} from '../../../../../apps/server/src/provider/Layers/CodexSessionRuntime.ts'
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError)

describe('CodexSessionRuntimeIdentifierGenerationError', () =>
{
  it('retains identifier purpose and the random source failure', () =>
  {
    const cause = new Error('random source unavailable')
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: 'provider-event',
      cause,
    })

    NodeAssert.equal(error.purpose, 'provider-event')
    NodeAssert.strictEqual(error.cause, cause)
    NodeAssert.equal(
      error.message,
      'Failed to generate Codex App Server identifier for provider-event.',
    )
  })
})

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod['thread/start']
{
  return {
    cwd: '/tmp/project',
    model: 'gpt-5.3-codex',
    modelProvider: 'openai',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'danger-full-access' },
    thread: {
      id: threadId,
      createdAt: '2026-04-18T00:00:00.000Z',
      source: { session: 'cli' },
      turns: [],
      status: {
        state: 'idle',
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod['thread/start']
}

describe('buildTurnStartParams', () =>
{
  it('keeps invalid turn values only in the schema cause', () =>
  {
    const secret = 'codex-turn-input-secret-sentinel'
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: 'provider-thread-1',
        runtimeMode: 'full-access',
        attachments: [
          {
            type: 'image',
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    )
    const { cause, ...directDiagnostics } = error

    NodeAssert.equal(error.operation, 'decode-request-payload')
    NodeAssert.equal(error.method, 'turn/start')
    NodeAssert.ok((error.issueCount ?? 0) > 0)
    NodeAssert.ok(error.issueKinds?.includes('Pointer'))
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0)
    NodeAssert.ok(Schema.isSchemaError(cause))
    NodeAssert.doesNotMatch(error.message, new RegExp(secret))
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret))
  })

  it('includes plan collaboration mode when requested', () =>
  {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: 'provider-thread-1',
        runtimeMode: 'full-access',
        prompt: 'Make a plan',
        model: 'gpt-5.3-codex',
        effort: 'medium',
        interactionMode: 'plan',
      }),
    )

    NodeAssert.deepStrictEqual(params, {
      threadId: 'provider-thread-1',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'dangerFullAccess',
      },
      input: [
        {
          type: 'text',
          text: 'Make a plan',
        },
      ],
      model: 'gpt-5.3-codex',
      effort: 'medium',
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5.3-codex',
          reasoning_effort: 'medium',
          developer_instructions: buildCodexDeveloperInstructions('plan', {
            model: 'gpt-5.3-codex',
            reasoningEffort: 'medium',
          }),
        },
      },
    })
  })

  it('includes default collaboration mode and image attachments', () =>
  {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: 'provider-thread-1',
        runtimeMode: 'auto-accept-edits',
        prompt: 'Implement it',
        model: 'gpt-5.3-codex',
        interactionMode: 'default',
        attachments: [
          {
            type: 'image',
            url: 'data:image/png;base64,abc',
          },
        ],
      }),
    )

    NodeAssert.deepStrictEqual(params, {
      threadId: 'provider-thread-1',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
      },
      input: [
        {
          type: 'text',
          text: 'Implement it',
        },
        {
          type: 'image',
          url: 'data:image/png;base64,abc',
        },
      ],
      model: 'gpt-5.3-codex',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5.3-codex',
          reasoning_effort: 'medium',
          developer_instructions: buildCodexDeveloperInstructions('default', {
            model: 'gpt-5.3-codex',
            reasoningEffort: 'medium',
          }),
        },
      },
    })
  })

  it.effect('runs orchestrate on the default protocol surface with orchestrate instructions', () =>
    Effect.gen(function* ()
    {
      const params = yield* buildTurnStartParams({
        threadId: 'provider-thread-1',
        runtimeMode: 'full-access',
        prompt: 'Coordinate this change',
        model: 'gpt-5.3-codex',
        effort: 'high',
        interactionMode: 'orchestrate',
      })

      NodeAssert.equal(params.collaborationMode?.mode, 'default')
      NodeAssert.equal(params.collaborationMode?.settings.model, 'gpt-5.3-codex')
      NodeAssert.equal(params.collaborationMode?.settings.reasoning_effort, 'high')
      NodeAssert.match(
        params.collaborationMode?.settings.developer_instructions ?? '',
        /# Collaboration Mode: Orchestrate/,
      )
    }),
  )

  it('reports the same fallback model and effort in settings and instructions', () =>
  {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: 'provider-thread-1',
        runtimeMode: 'full-access',
        prompt: 'Go',
        interactionMode: 'default',
      }),
    )

    const settings = params.collaborationMode?.settings
    NodeAssert.equal(settings?.model, DEFAULT_MODEL)
    NodeAssert.equal(settings?.reasoning_effort, 'medium')
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`))
  })

  it.effect('routes approvals to the auto reviewer in auto mode', () =>
    Effect.gen(function* ()
    {
      const params = yield* buildTurnStartParams({
        threadId: 'provider-thread-1',
        runtimeMode: 'auto',
        prompt: 'Ship it',
      })

      NodeAssert.deepStrictEqual(params, {
        threadId: 'provider-thread-1',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxPolicy: {
          type: 'workspaceWrite',
        },
        input: [
          {
            type: 'text',
            text: 'Ship it',
          },
        ],
      })
    }),
  )

  it('omits collaboration mode when interaction mode is absent', () =>
  {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: 'provider-thread-1',
        runtimeMode: 'approval-required',
        prompt: 'Review',
      }),
    )

    NodeAssert.deepStrictEqual(params, {
      threadId: 'provider-thread-1',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'readOnly',
      },
      input: [
        {
          type: 'text',
          text: 'Review',
        },
      ],
    })
  })
})

describe('buildCodexDeveloperInstructions', () =>
{
  it('appends runtime info after the mode instructions', () =>
  {
    const instructions = buildCodexDeveloperInstructions('default', {
      model: 'gpt-5.3-codex',
      reasoningEffort: 'high',
    })

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS))
    NodeAssert.match(instructions, /456code/)
    NodeAssert.match(instructions, /Codex harness/)
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/)
    NodeAssert.match(instructions, /code456/)
    NodeAssert.match(instructions, /preview_status/)
    NodeAssert.match(instructions, /preview_open/)
    NodeAssert.match(instructions, /Do not switch to global browser skills/)
    NodeAssert.doesNotMatch(instructions, /architecture_/)
  })

  it('includes runtime info alongside plan mode instructions', () =>
  {
    const instructions = buildCodexDeveloperInstructions('plan', {
      model: 'gpt-5.3-codex',
      reasoningEffort: 'medium',
    })

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS))
    NodeAssert.match(instructions, /proposal_preview_upsert/)
    NodeAssert.match(instructions, /In Plan mode, call .* before emitting the final/)
    NodeAssert.match(
      instructions,
      /Do not finalize the plan until the required proposal call succeeds/,
    )
    NodeAssert.match(instructions, /does not edit the user's worktree or index/)
    NodeAssert.match(instructions, /code456/)
    NodeAssert.match(instructions, /preview_status/)
    NodeAssert.match(instructions, /preview_open/)
    NodeAssert.match(instructions, /Do not switch to global browser skills/)
    NodeAssert.match(instructions, /architecture_blast_radius/)
    NodeAssert.match(instructions, /architecture_graph_diff/)
    NodeAssert.match(instructions, /architecture_propose_patch/)
    NodeAssert.match(instructions, /never invent or pass authority values/)
    NodeAssert.equal(instructions.match(/## 456code proposal previews/g)?.length, 1)
    NodeAssert.equal(instructions.match(/## 456code architecture tools/g)?.length, 1)
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/)
  })

  it('makes the orchestrate workflow and approval gate mode-level instructions', () =>
  {
    const instructions = buildCodexDeveloperInstructions('orchestrate', {
      model: 'gpt-5.3-codex',
      reasoningEffort: 'high',
    })

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS))
    NodeAssert.match(instructions, /core collaboration mode, not a user-level skill/)
    NodeAssert.match(instructions, /Before any .*start_worker.* call/)
    NodeAssert.match(instructions, /orchestrate-plan/)
    NodeAssert.match(instructions, /capture its committed .*revision/)
    NodeAssert.match(
      instructions,
      /proposal_preview_upsert.*orchestratePlan: \{ runId, revision \}/,
    )
    NodeAssert.match(instructions, /same committed .*runId.* and .*revision/)
    NodeAssert.match(instructions, /non-empty decided edit set/)
    NodeAssert.match(instructions, /standing-project/)
    NodeAssert.match(instructions, /never treat .*path.* or .*specifier/)
    NodeAssert.match(instructions, /code456/)
    NodeAssert.match(instructions, /preview_status/)
    NodeAssert.match(instructions, /preview_open/)
    NodeAssert.match(instructions, /Do not switch to global browser skills/)
    NodeAssert.match(instructions, /architecture_blast_radius/)
    NodeAssert.match(instructions, /architecture_graph_diff/)
    NodeAssert.match(instructions, /architecture_propose_patch/)
    NodeAssert.match(instructions, /never invent or pass authority values/)
    NodeAssert.equal(instructions.match(/## 456code proposal previews/g)?.length, 1)
    NodeAssert.equal(instructions.match(/## 456code architecture tools/g)?.length, 1)
    NodeAssert.match(instructions, /Wait for explicit approval before launching/)
    NodeAssert.match(instructions, /wait_for_workers/)
  })

  it('composes plan and orchestrate instructions without allowing worker mutations', () =>
  {
    const instructions = buildCodexDeveloperInstructions(
      'plan',
      {
        model: 'gpt-5.3-codex',
        reasoningEffort: 'high',
      },
      true,
    )

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS))
    NodeAssert.match(instructions, /# Collaboration Mode: Orchestrate/)
    NodeAssert.match(instructions, /workers must be read-only scouts/)
    NodeAssert.match(instructions, /no-mutation invariant applies to the lead and every worker/)
  })

  it('orders browser, architecture, and proposal guidance consistently', () =>
  {
    for (const instructions of [
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_ORCHESTRATE_MODE_DEVELOPER_INSTRUCTIONS,
    ])
    {
      const browser = instructions.indexOf('## 456code collaborative browser')
      const architecture = instructions.indexOf('## 456code architecture tools')
      const proposal = instructions.indexOf('## 456code proposal previews')
      NodeAssert.ok(browser >= 0 && browser < architecture)
      NodeAssert.ok(architecture < proposal)
      NodeAssert.ok(
        instructions.indexOf('architecture_blast_radius') <
          instructions.indexOf('architecture_graph_diff'),
      )
      NodeAssert.ok(
        instructions.indexOf('architecture_graph_diff') <
          instructions.indexOf('architecture_propose_patch'),
      )
    }
  })

  it('flattens multiline metadata into single-line runtime info', () =>
  {
    const instructions = buildCodexDeveloperInstructions('default', {
      model: 'gpt\n5.3\ncodex',
      reasoningEffort: ' high\neffort ',
    })

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/)
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/)
  })
})

describe('hasConfiguredMcpServer', () =>
{
  it('detects inline Codex MCP configuration arguments', () =>
  {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false)
    NodeAssert.equal(hasConfiguredMcpServer(['--model', 'gpt-5.4']), false)
    NodeAssert.equal(
      hasConfiguredMcpServer(['-c', 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    )
  })
})

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification['thread']['source'],
  threadSource?: string,
)
{
  return {
    method: 'thread/started' as const,
    params: {
      thread: {
        cliVersion: '0.0.0',
        createdAt: 0,
        cwd: '/tmp/project',
        ephemeral: true,
        id: threadId,
        modelProvider: 'openai',
        preview: '',
        sessionId: threadId,
        source,
        status: { type: 'idle' as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  }
}

describe('makeMemoryConsolidationNotificationFilter', () =>
{
  it('suppresses memory threads without hiding settlement or other subagents', () =>
  {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter()

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification('memory-thread', 'unknown', 'memory_consolidation'),
      ),
      true,
    )
    NodeAssert.equal(
      shouldSuppress({
        method: 'item/agentMessage/delta',
        params: {
          delta: 'internal memory update',
          itemId: 'memory-message',
          threadId: 'memory-thread',
          turnId: 'memory-turn',
        },
      }),
      true,
    )
    NodeAssert.equal(
      shouldSuppress({
        method: 'serverRequest/resolved',
        params: { requestId: 'memory-approval', threadId: 'memory-thread' },
      }),
      false,
    )
    NodeAssert.equal(
      shouldSuppress({
        method: 'warning',
        params: { message: 'internal warning', threadId: 'memory-thread' },
      }),
      true,
    )
    NodeAssert.equal(
      shouldSuppress({
        method: 'item/agentMessage/delta',
        params: {
          delta: 'normal reply',
          itemId: 'root-message',
          threadId: 'root-thread',
          turnId: 'root-turn',
        },
      }),
      false,
    )
    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification('legacy-memory-thread', {
          subAgent: 'memory_consolidation',
        }),
      ),
      true,
    )
    NodeAssert.equal(
      shouldSuppress(makeThreadStartedNotification('visible-subagent', { subAgent: 'review' })),
      false,
    )
    NodeAssert.equal(
      shouldSuppress({ method: 'thread/closed', params: { threadId: 'memory-thread' } }),
      true,
    )
    NodeAssert.equal(
      shouldSuppress({
        method: 'item/agentMessage/delta',
        params: {
          delta: 'later message',
          itemId: 'later-message',
          threadId: 'memory-thread',
          turnId: 'later-turn',
        },
      }),
      false,
    )
  })
})

describe('codexSessionAppServerArgs', () =>
{
  it('keeps the app-server subcommand when explicit args are provided', () =>
  {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(['-c', 'model=gpt-5'], undefined), [
      'app-server',
      '-c',
      'model=gpt-5',
    ])
  })

  it('keeps launch args when explicit app-server args are provided', () =>
  {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ['-c', 'mcp_servers.t3-code.url=http://127.0.0.1/mcp'],
        '--strict-config --enable foo',
      ),
      [
        'app-server',
        '--strict-config',
        '--enable',
        'foo',
        '-c',
        'mcp_servers.t3-code.url=http://127.0.0.1/mcp',
      ],
    )
  })
})

describe('isRecoverableThreadResumeError', () =>
{
  it('matches missing thread errors', () =>
  {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: 'Thread does not exist',
        }),
      ),
      true,
    )
  })

  it('ignores non-recoverable resume errors', () =>
  {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: 'Permission denied',
        }),
      ),
      false,
    )
  })

  it('ignores unrelated missing-resource errors that do not mention threads', () =>
  {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: 'Config file not found',
        }),
      ),
      false,
    )
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: 'Model does not exist',
        }),
      ),
      false,
    )
  })
})

describe('openCodexThread', () =>
{
  it.effect('falls back to thread/start when resume fails recoverably', () =>
    Effect.gen(function* ()
    {
      const calls: Array<{ method: 'thread/start' | 'thread/resume'; payload: unknown }> = []
      let fallbackObserved = false
      const started = makeThreadOpenResponse('fresh-thread')
      const client = {
        request: <M extends 'thread/start' | 'thread/resume'>(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) =>
        {
          calls.push({ method, payload })
          if (method === 'thread/resume')
          {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: 'thread not found',
              }),
            )
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M])
        },
      }

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make('thread-1'),
        runtimeMode: 'full-access',
        cwd: '/tmp/project',
        requestedModel: 'gpt-5.3-codex',
        serviceTier: undefined,
        resumeThreadId: 'stale-thread',
        onResumeFallback: () =>
          Effect.sync(() =>
          {
            fallbackObserved = true
          }),
      })

      NodeAssert.equal(opened.thread.id, 'fresh-thread')
      NodeAssert.equal(fallbackObserved, true)
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ['thread/resume', 'thread/start'],
      )
    }),
  )

  it.effect('does not fall back when a strict imported thread cannot be resumed', () =>
    Effect.gen(function* ()
    {
      const calls: Array<'thread/start' | 'thread/resume'> = []
      let fallbackObserved = false
      const resumeError = new CodexErrors.CodexAppServerRequestError({
        code: -32603,
        errorMessage: 'thread not found',
      })
      const client = {
        request: <M extends 'thread/start' | 'thread/resume'>(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) =>
        {
          calls.push(method)
          return method === 'thread/resume'
            ? Effect.fail(resumeError)
            : Effect.succeed(
                makeThreadOpenResponse(
                  'fresh-thread',
                ) as CodexRpc.ClientRequestResponsesByMethod[M],
              )
        },
      }

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make('thread-1'),
        runtimeMode: 'full-access',
        cwd: '/tmp/project',
        requestedModel: 'gpt-5.3-codex',
        serviceTier: undefined,
        resumeThreadId: 'imported-thread',
        requireExisting: true,
        onResumeFallback: () =>
          Effect.sync(() =>
          {
            fallbackObserved = true
          }),
      }).pipe(Effect.flip)

      NodeAssert.strictEqual(error, resumeError)
      NodeAssert.deepStrictEqual(calls, ['thread/resume'])
      NodeAssert.equal(fallbackObserved, false)
    }),
  )

  it.effect('propagates non-recoverable resume failures', () =>
    Effect.gen(function* ()
    {
      const client = {
        request: <M extends 'thread/start' | 'thread/resume'>(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) =>
        {
          if (method === 'thread/resume')
          {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: 'timed out waiting for server',
              }),
            )
          }
          return Effect.succeed(
            makeThreadOpenResponse('fresh-thread') as CodexRpc.ClientRequestResponsesByMethod[M],
          )
        },
      }

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make('thread-1'),
        runtimeMode: 'full-access',
        cwd: '/tmp/project',
        requestedModel: 'gpt-5.3-codex',
        serviceTier: undefined,
        resumeThreadId: 'stale-thread',
      }).pipe(Effect.flip)

      NodeAssert.ok(isCodexAppServerRequestError(error))
      NodeAssert.equal(error.errorMessage, 'timed out waiting for server')
    }),
  )
})
