#!/usr/bin/env node
// tests/apps/server/provider/testFixtures/codexApprovalMockPeer.mjs
// scripts codex approval requests and records wire responses

import * as NodeFS from 'node:fs'
import * as NodeReadline from 'node:readline'

const THREAD_ID = 'provider-thread-approval'
const TURN_ID = 'turn-approval'
const REQUEST_ID = 7001
const requestMethod = process.env.T3_CODEX_APPROVAL_METHOD ?? 'mcpServer/elicitation/request'
const recordPath = process.env.T3_CODEX_APPROVAL_RECORD_PATH
const controlPath = process.env.T3_CODEX_APPROVAL_CONTROL_PATH
const preResolve = process.env.T3_CODEX_APPROVAL_PRE_RESOLVE === '1'
let correlationRequestId
let preResolutionSent = false

function write(message)
{
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function threadStartResponse()
{
  return {
    thread: {
      id: THREAD_ID,
      extra: null,
      sessionId: THREAD_ID,
      forkedFromId: null,
      parentThreadId: null,
      preview: '',
      ephemeral: false,
      historyMode: 'legacy',
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: { type: 'idle' },
      path: '/tmp/codex-approval.jsonl',
      cwd: '/tmp',
      cliVersion: 'test',
      source: 'vscode',
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: 'gpt-5.3-codex',
    modelProvider: 'openai',
    serviceTier: 'default',
    cwd: '/tmp',
    runtimeWorkspaceRoots: ['/tmp'],
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    activePermissionProfile: null,
    reasoningEffort: 'medium',
    multiAgentMode: 'explicitRequestOnly',
  }
}

function approvalParams()
{
  if (requestMethod === 'item/commandExecution/requestApproval')
  {
    correlationRequestId = 'approval-command'
    return {
      approvalId: correlationRequestId,
      command: 'vp test run',
      itemId: 'command-item',
      startedAtMs: 1,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    }
  }
  if (requestMethod === 'item/fileChange/requestApproval')
  {
    correlationRequestId = 'file-item'
    return {
      itemId: correlationRequestId,
      startedAtMs: 1,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    }
  }
  correlationRequestId = REQUEST_ID
  return {
    mode: 'form',
    message: 'Allow ChatGPT to use Safari?',
    serverName: 'computer-use',
    threadId: THREAD_ID,
    turnId: TURN_ID,
    _meta: { app_name: 'Safari', persist: ['session', 'always'] },
    requestedSchema: {
      type: 'object',
      properties: {
        approval: {
          type: 'string',
          enum: ['once', 'session', 'always'],
        },
      },
      required: ['approval'],
    },
  }
}

function emitResolution(requestId)
{
  write({
    jsonrpc: '2.0',
    method: 'serverRequest/resolved',
    params: { requestId, threadId: THREAD_ID },
  })
}

const correlationPoll = setInterval(() =>
{
  if (!controlPath || preResolutionSent || !NodeFS.existsSync(controlPath))
  {
    return
  }
  const signal = NodeFS.readFileSync(controlPath, 'utf8').trim()
  if (!signal)
  {
    return
  }
  preResolutionSent = true
  if (preResolve)
  {
    emitResolution(correlationRequestId)
  }
}, 10)
correlationPoll.unref()

const reader = NodeReadline.createInterface({ input: process.stdin })
reader.on('line', (line) =>
{
  let request
  try
  {
    request = JSON.parse(line)
  }
  catch
  {
    return
  }

  if (request.method === undefined && request.id === REQUEST_ID)
  {
    if (recordPath)
    {
      NodeFS.writeFileSync(
        recordPath,
        JSON.stringify({ id: request.id, result: request.result, error: request.error }),
        'utf8',
      )
    }
    if (correlationRequestId)
    {
      emitResolution(correlationRequestId)
    }
    return
  }
  if (request.method === 'initialize')
  {
    write({
      id: request.id,
      result: {
        userAgent: 'codex-approval-test/1.0.0',
        codexHome: '/tmp',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    })
    return
  }
  if (request.method === 'thread/start' || request.method === 'thread/resume')
  {
    write({ id: request.id, result: threadStartResponse() })
    write({
      jsonrpc: '2.0',
      id: REQUEST_ID,
      method: requestMethod,
      params: approvalParams(),
    })
    return
  }
  if (request.id !== undefined)
  {
    write({ id: request.id, result: {} })
  }
})
