#!/usr/bin/env node
// apps/server/scripts/acp-mock-agent.ts
// provides deterministic ACP behavior and fault injection for server tests

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeTimers from 'node:timers'

import * as Effect from 'effect/Effect'

import * as NodeServices from '@effect/platform-node/NodeServices'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'

import * as EffectAcpAgent from 'effect-acp/agent'
import * as AcpError from 'effect-acp/errors'
import * as AcpProviderExtensions from 'effect-acp/provider-extensions'
import type * as AcpSchema from 'effect-acp/schema'

const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH
const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === '1'
const emitGrowingToolOutput = process.env.T3_ACP_EMIT_GROWING_TOOL_OUTPUT === '1'
const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === '1'
const emitGenericToolPlaceholders = process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === '1'
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === '1'
const emitXAiAskUserQuestion = process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION === '1'
const emitXAiPromptCompleteThenHang = process.env.T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === '1'
const emitForeignSessionUpdates = process.env.T3_ACP_EMIT_FOREIGN_SESSION_UPDATES === '1'
const hangPromptForever = process.env.T3_ACP_HANG_PROMPT_FOREVER === '1'
const hangFirstPromptForever = process.env.T3_ACP_HANG_FIRST_PROMPT_FOREVER === '1'
const emitLateUpdateAfterCancel = process.env.T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === '1'
const emitLateTerminalToolAfterCancel =
  process.env.T3_ACP_EMIT_LATE_TERMINAL_TOOL_AFTER_CANCEL === '1'
const omitXAiPromptCompleteStopReason =
  process.env.T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON === '1'
const failLoadSession = process.env.T3_ACP_FAIL_LOAD_SESSION === '1'
const emitLoadReplay = process.env.T3_ACP_EMIT_LOAD_REPLAY === '1'
const earlyLoadResponseBeforeReplay = process.env.T3_ACP_EARLY_LOAD_RESPONSE_BEFORE_REPLAY === '1'
const advertiseResume = process.env.T3_ACP_ADVERTISE_RESUME === '1'
const advertisedAuthMethodIds = (process.env.T3_ACP_AUTH_METHOD_IDS ?? '')
  .split(',')
  .map((methodId) => methodId.trim())
  .filter((methodId) => methodId.length > 0)
const coralModes = process.env.T3_ACP_CORAL_MODES === '1'
const geminiModes = process.env.T3_ACP_GEMINI_MODES === '1'
const hangLoadSessionAfterReplay = process.env.T3_ACP_HANG_LOAD_SESSION_AFTER_REPLAY === '1'
const delayLoadSessionAfterReplay = process.env.T3_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY === '1'
const emitLateLoadReplayAfterIdle = process.env.T3_ACP_EMIT_LATE_LOAD_REPLAY_AFTER_IDLE === '1'
const loadSessionDelayMs = Number(process.env.T3_ACP_LOAD_SESSION_DELAY_MS ?? '5000')
const emitStaleXAiPromptCompleteBeforeSecondHang =
  process.env.T3_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG === '1'
const emitOverlappingXAiPromptCompleteOutOfOrder =
  process.env.T3_ACP_EMIT_OVERLAPPING_XAI_PROMPT_COMPLETE_OUT_OF_ORDER === '1'
const failPrompt = process.env.T3_ACP_FAIL_PROMPT === '1'
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === '1'
const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === '1'
const exitDuringPromptCode = Number(process.env.T3_ACP_EXIT_DURING_PROMPT_CODE)
const exitDuringPromptDelayMs = Number(process.env.T3_ACP_EXIT_DURING_PROMPT_DELAY_MS ?? '0')
const malformedStdoutDuringPrompt = process.env.T3_ACP_MALFORMED_STDOUT_DURING_PROMPT === '1'
const closeStdoutDuringPrompt = process.env.T3_ACP_CLOSE_STDOUT_DURING_PROMPT === '1'
const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT
const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? '0')
const permissionOptionIds = {
  allowOnce: process.env.T3_ACP_ALLOW_ONCE_OPTION_ID ?? 'allow-once',
  allowAlways: process.env.T3_ACP_ALLOW_ALWAYS_OPTION_ID ?? 'allow-always',
  rejectOnce: process.env.T3_ACP_REJECT_ONCE_OPTION_ID ?? 'reject-once',
}
const sessionId = 'mock-session-1'

let currentModeId = coralModes || geminiModes ? 'default' : 'ask'
let currentModelId = 'default'
let currentCoralRuntimeMode = 'approval-required'
let parameterizedModelPicker = false
let currentReasoning = 'medium'
let currentContext = '272k'
let currentFast = false
let promptCount = 0
let overlappingFirstPromptId: string | undefined
const cancelledSessions = new Set<string>()

function promptIdFromRequestMeta(
  request: Pick<AcpSchema.PromptRequest, '_meta'>,
): string | undefined
{
  const meta = request._meta
  if (meta === null || typeof meta !== 'object')
  {
    return undefined
  }
  const promptId = meta.promptId ?? meta.requestId
  return typeof promptId === 'string' && promptId.length > 0 ? promptId : undefined
}

function logExit(reason: string): void
{
  if (!exitLogPath)
  {
    return
  }
  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, 'utf8')
}

function writeJsonRpcNotification(method: string, params: unknown): void
{
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

function scheduleLoadReplayUserMessage(requestedSessionId: string): void
{
  // @effect-diagnostics-next-line globalTimers:off - The mock deliberately schedules a notification after its RPC response.
  NodeTimers.setTimeout(() =>
  {
    writeJsonRpcNotification('session/update', {
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'older replayed user message' },
      },
    })
    writeJsonRpcNotification('session/update', {
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'older replayed assistant message' },
      },
    })
    writeJsonRpcNotification('session/update', {
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'replay' },
      },
    })
  }, 50)
}

process.once('SIGTERM', () =>
{
  logExit('SIGTERM')
  process.exit(0)
})

process.once('SIGINT', () =>
{
  logExit('SIGINT')
  process.exit(0)
})

process.once('exit', (code) =>
{
  logExit(`exit:${code}`)
})

function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption>
{
  if (parameterizedModelPicker)
  {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: currentModelId,
        options: [
          { value: 'default', name: 'Auto' },
          { value: 'composer-2', name: 'Composer 2' },
          { value: 'gpt-5.4', name: 'GPT-5.4' },
          { value: 'claude-opus-4-6', name: 'Opus 4.6' },
        ],
      },
    ]

    switch (currentModelId)
    {
      case 'gpt-5.4':
        return [
          ...baseOptions,
          {
            id: 'reasoning',
            name: 'Reasoning',
            category: 'thought_level',
            type: 'select',
            currentValue: currentReasoning,
            options: [
              { value: 'none', name: 'None' },
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
              { value: 'extra-high', name: 'Extra High' },
            ],
          },
          {
            id: 'context',
            name: 'Context',
            category: 'model_config',
            type: 'select',
            currentValue: currentContext,
            options: [
              { value: '272k', name: '272K' },
              { value: '1m', name: '1M' },
            ],
          },
          {
            id: 'fast',
            name: 'Fast',
            category: 'model_config',
            type: 'select',
            currentValue: String(currentFast),
            options: [
              { value: 'false', name: 'Off' },
              { value: 'true', name: 'Fast' },
            ],
          },
        ]
      case 'composer-2':
        return [
          ...baseOptions,
          {
            id: 'fast',
            name: 'Fast',
            category: 'model_config',
            type: 'select',
            currentValue: String(currentFast),
            options: [
              { value: 'false', name: 'Off' },
              { value: 'true', name: 'Fast' },
            ],
          },
        ]
      case 'claude-opus-4-6':
        return [
          ...baseOptions,
          {
            id: 'reasoning',
            name: 'Reasoning',
            category: 'thought_level',
            type: 'select',
            currentValue: currentReasoning,
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
          {
            id: 'thinking',
            name: 'Thinking',
            category: 'model_config',
            type: 'boolean',
            currentValue: true,
          },
        ]
      default:
        return baseOptions
    }
  }

  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: currentModelId,
      options: [
        { value: 'default', name: 'Auto' },
        { value: 'composer-2', name: 'Composer 2' },
        { value: 'composer-2[fast=true]', name: 'Composer 2 Fast' },
        { value: 'gpt-5.3-codex[reasoning=medium,fast=false]', name: 'Codex 5.3' },
      ],
    },
    ...(coralModes
      ? [
          {
            id: 'coral.runtime-mode',
            name: 'Coral runtime mode',
            category: 'mode',
            type: 'select' as const,
            currentValue: currentCoralRuntimeMode,
            options: [{ value: 'approval-required', name: 'Approval required' }],
          },
        ]
      : []),
  ]
}

function modelConfigOptionsFor(modelId: string): ReadonlyArray<AcpSchema.SessionConfigOption>
{
  const previousModelId = currentModelId
  try
  {
    currentModelId = modelId
    return configOptions().filter(
      (option) => option.category !== 'mode' && option.category !== 'model',
    )
  }
  finally
  {
    currentModelId = previousModelId
  }
}

function availableModels(): ReadonlyArray<{
  readonly value: string
  readonly name: string
  readonly configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>
}>
{
  return [
    { value: 'default', name: 'Auto' },
    { value: 'composer-2', name: 'Composer 2' },
    { value: 'gpt-5.4', name: 'GPT-5.4' },
    { value: 'claude-opus-4-6', name: 'Opus 4.6' },
  ].map((model) => ({
    value: model.value,
    name: model.name,
    configOptions: modelConfigOptionsFor(model.value),
  }))
}

const availableModes: ReadonlyArray<AcpSchema.SessionMode> = coralModes
  ? [{ id: 'default', name: 'Default' }]
  : geminiModes
    ? [
        { id: 'default', name: 'Default', description: 'Prompts for approval' },
        { id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
        { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
        { id: 'plan', name: 'Plan', description: 'Read-only mode' },
      ]
    : [
        {
          id: 'ask',
          name: 'Ask',
          description: 'Request permission before making any changes',
        },
        {
          id: 'architect',
          name: 'Architect',
          description: 'Design and plan software systems without implementation',
        },
        {
          id: 'code',
          name: 'Code',
          description: 'Write and modify code with full tool access',
        },
      ]

function modeState(): AcpSchema.SessionModeState
{
  return {
    currentModeId,
    availableModes,
  }
}

const grokAcpModels: ReadonlyArray<AcpProviderExtensions.ModelInfo> = [
  { modelId: 'grok-build', name: 'Grok Build' },
  { modelId: 'grok-mock-alt', name: 'Grok Mock Alt' },
]

function modelState(): AcpProviderExtensions.SessionModelState
{
  const modelId = grokAcpModels.some((model) => model.modelId === currentModelId)
    ? currentModelId
    : 'grok-build'
  return {
    currentModelId: modelId,
    availableModels: grokAcpModels,
  }
}

const program = Effect.gen(function* ()
{
  const agent = yield* EffectAcpAgent.AcpAgent

  yield* agent.handleInitialize((request) =>
    Effect.sync(() =>
    {
      parameterizedModelPicker =
        request.clientCapabilities?._meta?.parameterizedModelPicker === true
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          ...(advertiseResume ? { sessionCapabilities: { resume: {} } } : {}),
        },
        ...(advertisedAuthMethodIds.length > 0
          ? {
              authMethods: advertisedAuthMethodIds.map((id) => ({
                id,
                name: `Mock ${id}`,
              })),
            }
          : {}),
      }
    }),
  )

  yield* agent.handleAuthenticate(() => Effect.succeed({}))

  yield* agent.handleCreateSession(() =>
    Effect.succeed({
      sessionId,
      modes: modeState(),
      models: modelState(),
      configOptions: configOptions(),
    }),
  )

  const emitLoadReplayNotifications = (requestedSessionId: string) =>
  {
    writeJsonRpcNotification('session/update', {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'older replayed user message' },
      },
    })
    writeJsonRpcNotification('session/update', {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'replay-tool-1',
        title: 'Replay tool',
        kind: 'search',
        status: 'completed',
      },
    })
    writeJsonRpcNotification('session/update', {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'replayed assistant text' },
      },
    })
  }

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* ()
    {
      const requestedSessionId = String(request.sessionId ?? sessionId)
      if (failLoadSession)
      {
        return yield* AcpError.AcpRequestError.internalError('Mock load session failure')
      }
      if (earlyLoadResponseBeforeReplay)
      {
        scheduleLoadReplayUserMessage(requestedSessionId)
        return {
          modes: modeState(),
          models: modelState(),
          configOptions: configOptions(),
        }
      }
      if (hangLoadSessionAfterReplay || delayLoadSessionAfterReplay)
      {
        emitLoadReplayNotifications(requestedSessionId)
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'replay-tail' },
          },
        })
        yield* Effect.sleep(loadSessionDelayMs)
        if (emitLateLoadReplayAfterIdle)
        {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'late unmarked replay content' },
            },
          })
        }
        return {
          modes: modeState(),
          models: modelState(),
          configOptions: configOptions(),
        }
      }
      if (emitLoadReplay)
      {
        emitLoadReplayNotifications(requestedSessionId)
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'replay' },
        },
      })
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      }
    }),
  )

  yield* agent.handleResumeSession(() =>
    Effect.succeed({
      modes: modeState(),
      models: modelState(),
      configOptions: configOptions(),
    }),
  )

  yield* agent.handleExtRequest(
    AcpProviderExtensions.GROK_SET_SESSION_MODEL_METHOD,
    AcpProviderExtensions.SetSessionModelRequest,
    (request) =>
      Effect.gen(function* ()
      {
        if (!grokAcpModels.some((model) => model.modelId === request.modelId))
        {
          return yield* AcpError.AcpRequestError.invalidParams(
            `Unknown mock model id: ${request.modelId}`,
            {
              method: AcpProviderExtensions.GROK_SET_SESSION_MODEL_METHOD,
              params: request,
            },
          )
        }
        currentModelId = request.modelId
        return {}
      }),
  )

  // the adapter now switches modes via the typed session/set_mode rpc
  // instead of session/set_config_option (megacore U-076)
  yield* agent.handleSetSessionMode((request) =>
    Effect.gen(function* ()
    {
      if (!availableModes.some((mode) => mode.id === request.modeId))
      {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock mode id: ${request.modeId}`,
          {
            method: 'session/set_mode',
            params: request,
          },
        )
      }
      currentModeId = request.modeId
      return {}
    }),
  )

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* ()
    {
      if (exitOnSetConfigOption)
      {
        return yield* Effect.sync(() =>
        {
          process.exit(7)
        })
      }
      if (failSetConfigOption)
      {
        return yield* AcpError.AcpRequestError.invalidParams(
          'Mock invalid params for session/set_config_option',
          {
            method: 'session/set_config_option',
            params: request,
          },
        )
      }
      if (request.configId === 'mode' && typeof request.value === 'string')
      {
        currentModeId = request.value
      }
      if (request.configId === 'model' && typeof request.value === 'string')
      {
        currentModelId = request.value
      }
      if (request.configId === 'coral.runtime-mode' && typeof request.value === 'string')
      {
        currentCoralRuntimeMode = request.value
      }
      if (request.configId === 'reasoning' && typeof request.value === 'string')
      {
        currentReasoning = request.value
      }
      if (request.configId === 'context' && typeof request.value === 'string')
      {
        currentContext = request.value
      }
      if (request.configId === 'fast')
      {
        currentFast = request.value === true || request.value === 'true'
      }
      return {
        configOptions: configOptions(),
      }
    }),
  )

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* ()
    {
      const cancelledSessionId = String(sessionId ?? 'mock-session-1')
      cancelledSessions.add(cancelledSessionId)
      if (emitLateUpdateAfterCancel)
      {
        yield* Effect.sleep('50 millis')
        yield* Effect.sync(() =>
        {
          writeJsonRpcNotification('session/update', {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'late after cancel' },
            },
          })
        })
      }
      if (emitLateTerminalToolAfterCancel)
      {
        yield* Effect.sleep('50 millis')
        yield* Effect.sync(() =>
        {
          writeJsonRpcNotification('session/update', {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'late-terminal-tool',
              title: 'Late terminal tool',
              kind: 'execute',
              status: 'completed',
              rawOutput: { exitCode: 0 },
            },
          })
        })
      }
    }),
  )

  yield* agent.handlePrompt((request) =>
    Effect.gen(function* ()
    {
      const requestedSessionId = String(request.sessionId ?? sessionId)
      promptCount += 1

      if (process.env.T3_ACP_EXIT_DURING_PROMPT_CODE !== undefined)
      {
        const exitCode = Number.isInteger(exitDuringPromptCode) ? exitDuringPromptCode : 1
        if (Number.isFinite(exitDuringPromptDelayMs) && exitDuringPromptDelayMs > 0)
        {
          yield* Effect.sleep(`${exitDuringPromptDelayMs} millis`).pipe(
            Effect.andThen(Effect.sync(() => process.exit(exitCode))),
            Effect.forkChild,
          )
        }
        else
        {
          return yield* Effect.sync(() => process.exit(exitCode)).pipe(Effect.andThen(Effect.never))
        }
      }

      if (malformedStdoutDuringPrompt)
      {
        yield* Effect.sync(() => process.stdout.write('{malformed-json\n'))
        return yield* Effect.never
      }

      if (closeStdoutDuringPrompt)
      {
        yield* Effect.sync(() =>
          process.stdout.end(() =>
          {
            process.exit(0)
          }),
        )
        return yield* Effect.never
      }

      if (Number.isFinite(promptDelayMs) && promptDelayMs > 0)
      {
        yield* Effect.sleep(`${promptDelayMs} millis`)
      }

      if (failPrompt)
      {
        return yield* AcpError.AcpRequestError.internalError('Mock prompt failure')
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 1)
      {
        return {
          stopReason: 'end_turn',
          _meta: {
            promptId: 'mock-stale-xai-prompt-1',
            requestId: 'mock-stale-xai-prompt-1',
          },
        }
      }

      if (emitStaleXAiPromptCompleteBeforeSecondHang && promptCount === 2)
      {
        const currentPromptId = promptIdFromRequestMeta(request) ?? 'mock-current-xai-prompt-2'
        writeJsonRpcNotification('_x.ai/session/prompt_complete', {
          sessionId: requestedSessionId,
          promptId: 'mock-stale-xai-prompt-1',
          stopReason: 'end_turn',
          agentResult: null,
        })

        writeJsonRpcNotification('_x.ai/session/prompt_complete', {
          sessionId: requestedSessionId,
          promptId: currentPromptId,
          stopReason: 'end_turn',
          agentResult: null,
        })

        return yield* Effect.never
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 1)
      {
        overlappingFirstPromptId = promptIdFromRequestMeta(request)
        return yield* Effect.never
      }

      if (emitOverlappingXAiPromptCompleteOutOfOrder && promptCount === 2)
      {
        const secondPromptId = promptIdFromRequestMeta(request)
        if (overlappingFirstPromptId !== undefined && secondPromptId !== undefined)
        {
          writeJsonRpcNotification('_x.ai/session/prompt_complete', {
            sessionId: requestedSessionId,
            promptId: secondPromptId,
            stopReason: 'end_turn',
            agentResult: null,
          })
          writeJsonRpcNotification('_x.ai/session/prompt_complete', {
            sessionId: requestedSessionId,
            promptId: overlappingFirstPromptId,
            stopReason: 'end_turn',
            agentResult: null,
          })
        }
        return yield* Effect.never
      }

      if (hangPromptForever || (hangFirstPromptForever && promptCount === 1))
      {
        return yield* Effect.never
      }

      if (emitXAiPromptCompleteThenHang)
      {
        writeJsonRpcNotification('session/update', {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello from ' },
          },
        })

        if (emitForeignSessionUpdates)
        {
          writeJsonRpcNotification('session/update', {
            sessionId: 'mock-child-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'child before completion' },
            },
          })
        }

        writeJsonRpcNotification('_x.ai/session/prompt_complete', {
          sessionId: requestedSessionId,
          promptId: promptIdFromRequestMeta(request) ?? 'mock-xai-prompt-1',
          ...(omitXAiPromptCompleteStopReason ? {} : { stopReason: 'end_turn' }),
          agentResult: null,
        })

        if (emitForeignSessionUpdates)
        {
          writeJsonRpcNotification('session/update', {
            sessionId: 'mock-child-session-1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'child-tool-call-1',
              title: 'Child-only tool',
              kind: 'other',
              status: 'pending',
              rawInput: {},
            },
          })
          writeJsonRpcNotification('session/update', {
            sessionId: 'mock-child-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'child after completion' },
            },
          })
        }

        writeJsonRpcNotification('session/update', {
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'mock' },
          },
        })

        return yield* Effect.never
      }

      if (emitInterleavedAssistantToolCalls)
      {
        const toolCallId = 'tool-call-1'

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'before tool' },
          },
        })

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'Terminal',
            kind: 'execute',
            status: 'pending',
            rawInput: {
              command: ['echo', 'hello'],
            },
          },
        })

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            rawOutput: {
              exitCode: 0,
              stdout: 'hello',
              stderr: '',
            },
          },
        })

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'after tool' },
          },
        })

        return { stopReason: 'end_turn' }
      }

      if (emitGrowingToolOutput)
      {
        const toolCallId = 'tool-call-progress'
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'Terminal',
            kind: 'execute',
            status: 'pending',
            rawInput: { command: ['echo', 'progress'] },
          },
        })
        for (const length of [0, 300, 301, 301, 600, 601])
        {
          yield* agent.client.sessionUpdate({
            sessionId: requestedSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'in_progress',
              rawOutput: { stdout: 'x'.repeat(length) },
            },
          })
        }
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            rawOutput: { stdout: 'x'.repeat(601), exitCode: 0 },
          },
        })
        return { stopReason: 'end_turn' }
      }

      if (emitToolCalls)
      {
        const toolCallId = 'tool-call-1'

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'Terminal',
            kind: 'execute',
            status: 'pending',
            rawInput: {
              command: ['cat', 'server/package.json'],
            },
          },
        })

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
          },
        })

        const permission = yield* agent.client.requestPermission({
          sessionId: requestedSessionId,
          toolCall: {
            toolCallId,
            title: '`cat server/package.json`',
            kind: 'execute',
            status: 'pending',
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: 'Not in allowlist: cat server/package.json',
                },
              },
            ],
          },
          options: [
            { optionId: permissionOptionIds.allowOnce, name: 'Allow once', kind: 'allow_once' },
            {
              optionId: permissionOptionIds.allowAlways,
              name: 'Allow always',
              kind: 'allow_always',
            },
            { optionId: permissionOptionIds.rejectOnce, name: 'Reject', kind: 'reject_once' },
          ],
        })

        const cancelled =
          cancelledSessions.delete(requestedSessionId) || permission.outcome.outcome === 'cancelled'

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            title: 'Terminal',
            kind: 'execute',
            status: 'completed',
            rawOutput: {
              exitCode: 0,
              stdout: '{ "name": "t3" }',
              stderr: '',
            },
          },
        })

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello from mock' },
          },
        })

        return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
      }

      if (emitGenericToolPlaceholders)
      {
        const toolCallId = 'tool-call-generic-1'

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'Read File',
            kind: 'read',
            status: 'pending',
            rawInput: {},
          },
        })

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
          },
        })

        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            rawOutput: {
              content: 'package.json\n',
            },
          },
        })

        return { stopReason: 'end_turn' }
      }

      if (emitAskQuestion)
      {
        yield* agent.client.extRequest('cursor/ask_question', {
          toolCallId: 'ask-question-tool-call-1',
          title: 'Question',
          questions: [
            {
              id: 'scope',
              prompt: 'Which scope?',
              options: [
                { id: 'workspace', label: 'Workspace' },
                { id: 'session', label: 'Session' },
              ],
            },
          ],
        })

        return { stopReason: 'end_turn' }
      }

      if (emitXAiAskUserQuestion)
      {
        const result = yield* agent.client.extRequest('_x.ai/ask_user_question', {
          method: 'x.ai/ask_user_question',
          params: {
            sessionId: requestedSessionId,
            toolCallId: 'ask-user-question-tool-call-1',
            questions: [
              {
                question: 'Which scope should Grok use?',
                multiSelect: null,
                options: [
                  { label: 'Workspace', description: 'Use the current workspace' },
                  { label: 'Session', description: 'Only use this session' },
                ],
              },
            ],
            mode: 'default',
          },
        })
        if (typeof result !== 'object' || result === null || !('outcome' in result))
        {
          throw new Error('Expected _x.ai/ask_user_question response outcome.')
        }
        if (result.outcome === 'cancelled')
        {
          return { stopReason: 'end_turn' }
        }
        if (
          result.outcome !== 'accepted' ||
          !('answers' in result) ||
          typeof result.answers !== 'object' ||
          result.answers === null
        )
        {
          throw new Error('Expected accepted _x.ai/ask_user_question response answers.')
        }

        return { stopReason: 'end_turn' }
      }

      if (emitForeignSessionUpdates)
      {
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'root before child' },
          },
        })
        yield* agent.client.sessionUpdate({
          sessionId: 'mock-child-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'child content' },
          },
        })
        yield* agent.client.sessionUpdate({
          sessionId: 'mock-child-session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'child-tool-call-1',
            title: 'Child-only tool',
            kind: 'other',
            status: 'pending',
            rawInput: {},
          },
        })
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' root after child' },
          },
        })
        return { stopReason: 'end_turn' }
      }

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [
            {
              content: 'Inspect mock ACP state',
              priority: 'high',
              status: 'completed',
            },
            {
              content: 'Implement the requested change',
              priority: 'high',
              status: 'in_progress',
            },
          ],
        },
      })

      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: promptResponseText ?? 'hello from mock' },
        },
      })

      return { stopReason: 'end_turn' }
    }),
  )

  yield* agent.handleUnknownExtRequest((method, params) =>
  {
    if (method === 'cursor/list_available_models')
    {
      return Effect.succeed({
        models: availableModels(),
      })
    }

    if (method !== 'session/mode/set')
    {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method))
    }

    const nextModeId =
      typeof params === 'object' &&
      params !== null &&
      'modeId' in params &&
      typeof params.modeId === 'string'
        ? params.modeId
        : typeof params === 'object' &&
            params !== null &&
            'mode' in params &&
            typeof params.mode === 'string'
          ? params.mode
          : undefined
    const requestedSessionId =
      typeof params === 'object' &&
      params !== null &&
      'sessionId' in params &&
      typeof params.sessionId === 'string'
        ? params.sessionId
        : sessionId

    if (typeof nextModeId === 'string' && nextModeId.trim())
    {
      currentModeId = nextModeId.trim()
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId,
          },
        })
        .pipe(Effect.as({}))
    }

    return Effect.succeed({})
  })

  return yield* Effect.never
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) =>
              {
              if (event.direction !== 'incoming' || event.stage !== 'raw')
                {
                return Effect.void
              }
              if (typeof event.payload !== 'string')
                {
                return Effect.void
              }
              const payload = event.payload
              return Effect.sync(() =>
                {
                NodeFS.appendFileSync(
                  requestLogPath,
                  payload.endsWith('\n') ? payload : `${payload}\n`,
                  'utf8',
                )
              })
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
)

NodeRuntime.runMain(program)
