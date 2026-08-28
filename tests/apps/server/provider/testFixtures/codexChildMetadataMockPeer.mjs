#!/usr/bin/env node
// tests/apps/server/provider/testFixtures/codexChildMetadataMockPeer.mjs
// simulates codex child metadata lookup and live update races

import * as NodeFS from 'node:fs'
import * as NodeReadline from 'node:readline'

const ROOT_THREAD_ID = 'provider-thread-child-metadata'
const CHILD_THREAD_ID = 'provider-thread-child'
const ROOT_TURN_ID = 'turn-child-metadata'
const ITEM_ID = 'collab-child-metadata'
const scenario = process.env.CODEX_CHILD_METADATA_SCENARIO ?? 'live-wins'
const recordPath = process.env.CODEX_CHILD_METADATA_RECORD_PATH
let resumeRequestCount = 0

function write(message)
{
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function threadOpenResponse(threadId, model, reasoningEffort)
{
  return {
    thread: {
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      parentThreadId: threadId === ROOT_THREAD_ID ? null : ROOT_THREAD_ID,
      preview: '',
      ephemeral: false,
      historyMode: 'legacy',
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: { type: 'idle' },
      path: `/tmp/${threadId}.jsonl`,
      cwd: '/tmp',
      cliVersion: 'test',
      source: 'vscode',
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: threadId === ROOT_THREAD_ID ? null : 'child',
      agentRole: threadId === ROOT_THREAD_ID ? null : 'worker',
      gitInfo: null,
      name: null,
      turns: [],
    },
    model,
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
    reasoningEffort,
    multiAgentMode: 'explicitRequestOnly',
  }
}

function turn(status)
{
  return {
    id: ROOT_TURN_ID,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  }
}

function collabItem(status)
{
  const metadata =
    scenario === 'seeded'
      ? { model: 'requested-model', reasoningEffort: 'medium' }
      : scenario === 'live-wins'
        ? { reasoningEffort: 'medium' }
        : {}
  return {
    type: 'collabAgentToolCall',
    id: ITEM_ID,
    tool: 'spawnAgent',
    status,
    senderThreadId: ROOT_THREAD_ID,
    receiverThreadIds: [CHILD_THREAD_ID],
    agentsStates: {},
    prompt: 'inspect the metadata path',
    ...metadata,
  }
}

function subAgentActivityItem(id, kind)
{
  return {
    type: 'subAgentActivity',
    id,
    agentPath: '/root/package_metadata',
    agentThreadId: CHILD_THREAD_ID,
    kind,
  }
}

function emptyWaitItem()
{
  return {
    type: 'collabAgentToolCall',
    id: 'call-wait-empty',
    tool: 'wait',
    status: 'completed',
    senderThreadId: ROOT_THREAD_ID,
    receiverThreadIds: [],
    agentsStates: {},
    model: null,
    reasoningEffort: null,
  }
}

function emitNotification(method, params)
{
  write({ jsonrpc: '2.0', method, params })
}

function emitChildSettings(model, effort, schemaInvalid = false)
{
  emitNotification('thread/settings/updated', {
    threadId: CHILD_THREAD_ID,
    threadSettings: {
      ...(schemaInvalid ? { activePermissionProfile: { type: 'disabled' } } : {}),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      collaborationMode: { mode: 'default', settings: { model } },
      cwd: '/tmp',
      effort,
      model,
      modelProvider: 'openai',
      sandboxPolicy: { type: 'dangerFullAccess' },
    },
  })
}

function finishRootTurn()
{
  emitNotification('item/completed', {
    completedAtMs: Date.now(),
    threadId: ROOT_THREAD_ID,
    turnId: ROOT_TURN_ID,
    item: collabItem('completed'),
  })
  emitNotification('turn/completed', {
    threadId: ROOT_THREAD_ID,
    turn: turn('completed'),
  })
}

function completeRootTurnWithoutItem()
{
  emitNotification('turn/completed', {
    threadId: ROOT_THREAD_ID,
    turn: turn('completed'),
  })
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
        userAgent: 'codex-child-metadata-test/1.0.0',
        codexHome: '/tmp',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    })
    return
  }
  if (request.method === 'thread/start')
  {
    write({ id: request.id, result: threadOpenResponse(ROOT_THREAD_ID, 'root-model', 'medium') })
    return
  }
  if (request.method === 'turn/start')
  {
    write({ id: request.id, result: { turn: turn('inProgress') } })
    emitNotification('turn/started', {
      threadId: ROOT_THREAD_ID,
      turn: turn('inProgress'),
    })
    if (scenario === 'subagent-activity')
    {
      emitChildSettings('gpt-5.6-sol', 'low', true)
      emitNotification('item/started', {
        startedAtMs: Date.now(),
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: subAgentActivityItem('call-spawn-child', 'started'),
      })
      emitNotification('item/completed', {
        completedAtMs: Date.now(),
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: subAgentActivityItem('call-spawn-child', 'started'),
      })
      emitNotification('item/started', {
        startedAtMs: Date.now(),
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: subAgentActivityItem('subagent-completed-child-turn', 'completed'),
      })
      emitNotification('item/completed', {
        completedAtMs: Date.now(),
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: subAgentActivityItem('subagent-completed-child-turn', 'completed'),
      })
      emitNotification('item/completed', {
        completedAtMs: Date.now(),
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: emptyWaitItem(),
      })
      completeRootTurnWithoutItem()
      return
    }
    if (scenario === 'resume-after-terminal')
    {
      emitNotification('item/started', {
        startedAtMs: Date.now(),
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: subAgentActivityItem('call-spawn-child', 'started'),
      })
      emitNotification('item/completed', {
        completedAtMs: Date.now(),
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: subAgentActivityItem('call-spawn-child', 'started'),
      })
      return
    }
    for (let index = 0; index < 2; index += 1)
    {
      emitNotification('item/started', {
        startedAtMs: Date.now(),
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: collabItem('inProgress'),
      })
    }
    if (scenario === 'seeded')
    {
      finishRootTurn()
    }
    return
  }
  if (request.method === 'thread/resume')
  {
    resumeRequestCount += 1
    if (recordPath)
    {
      NodeFS.appendFileSync(recordPath, `${JSON.stringify(request.params)}\n`, 'utf8')
    }
    if (scenario === 'live-wins')
    {
      emitChildSettings('live-model', null)
      emitNotification('model/rerouted', {
        threadId: CHILD_THREAD_ID,
        turnId: 'turn-child',
        fromModel: 'live-model',
        toModel: 'rerouted-model',
        reason: 'highRiskCyberActivity',
      })
      write({
        id: request.id,
        result: threadOpenResponse(CHILD_THREAD_ID, 'stale-snapshot', 'low'),
      })
      finishRootTurn()
      return
    }
    if (scenario === 'resume-after-terminal')
    {
      if (resumeRequestCount === 1)
      {
        setTimeout(() =>
        {
          emitNotification('item/started', {
            startedAtMs: Date.now(),
            threadId: ROOT_THREAD_ID,
            turnId: ROOT_TURN_ID,
            item: subAgentActivityItem('subagent-completed-child-turn', 'completed'),
          })
          emitNotification('item/completed', {
            completedAtMs: Date.now(),
            threadId: ROOT_THREAD_ID,
            turnId: ROOT_TURN_ID,
            item: subAgentActivityItem('subagent-completed-child-turn', 'completed'),
          })
        }, 5100)
        return
      }
      write({
        id: request.id,
        result: threadOpenResponse(CHILD_THREAD_ID, 'gpt-5.6-sol', 'low'),
      })
      setTimeout(completeRootTurnWithoutItem, 25)
      return
    }
    emitNotification('thread/closed', { threadId: CHILD_THREAD_ID })
    write({
      id: request.id,
      result: threadOpenResponse(CHILD_THREAD_ID, 'closed-snapshot', 'low'),
    })
    setTimeout(() =>
    {
      emitNotification('turn/started', {
        threadId: CHILD_THREAD_ID,
        turn: { ...turn('inProgress'), id: 'turn-child-reopened' },
      })
      emitChildSettings('reopened-model', 'xhigh')
      finishRootTurn()
    }, 25)
    return
  }
  if (request.id !== undefined)
  {
    write({ id: request.id, result: {} })
  }
})
