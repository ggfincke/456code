#!/usr/bin/env node
// tests/apps/server/provider/testFixtures/codexQueuedFollowupMockPeer.mjs
// simulates queued codex turns and records interrupt targets

import * as NodeFS from 'node:fs'
import * as NodeReadline from 'node:readline'

const THREAD_ID = 'provider-thread-queued-followup'
const TURN_IDS = ['turn-active', 'turn-queued']
let turnStartCount = 0

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
      path: '/tmp/codex-queued-followup.jsonl',
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

function turnStartResponse(turnId)
{
  return {
    turn: {
      id: turnId,
      items: [],
      itemsView: 'notLoaded',
      status: 'inProgress',
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  }
}

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

  if (request.method === 'initialize')
  {
    write({
      id: request.id,
      result: {
        userAgent: 'codex-queued-followup-test/1.0.0',
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
    return
  }
  if (request.method === 'turn/start')
  {
    const turnId = TURN_IDS[turnStartCount] ?? `turn-${turnStartCount + 1}`
    turnStartCount += 1
    write({ id: request.id, result: turnStartResponse(turnId) })
    return
  }
  if (request.method === 'turn/interrupt')
  {
    const recordPath = process.env.CODEX_QUEUED_FOLLOWUP_RECORD_PATH
    if (recordPath)
    {
      NodeFS.writeFileSync(recordPath, JSON.stringify(request.params), 'utf8')
    }
    write({ id: request.id, result: {} })
    return
  }
  if (request.id !== undefined)
  {
    write({ id: request.id, result: {} })
  }
})
