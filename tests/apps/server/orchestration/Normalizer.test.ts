// tests/apps/server/orchestration/Normalizer.test.ts
// verifies client orchestration command canonicalization and provenance stripping
import * as NodeServices from '@effect/platform-node/NodeServices'
import { it } from '@effect/vitest'
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadOrigin,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect } from 'vite-plus/test'

import { ServerConfig } from '../../../../apps/server/src/config.ts'
import {
  canonicalizeClientCommandTimestamps,
  normalizeDispatchCommand,
} from '../../../../apps/server/src/orchestration/Normalizer.ts'
import * as WorkspacePaths from '../../../../apps/server/src/workspace/WorkspacePaths.ts'

const clientCreatedAt = '2031-01-01T00:00:00.000Z'
const serverReceivedAt = '2026-07-18T00:00:00.000Z'
const forgedOrigin: ThreadOrigin = {
  kind: 'imported',
  source: 'codex-cli',
  sourcePath: '/tmp/forged-session.jsonl',
  contentHash: 'forged-content-hash',
  nativeSessionId: 'forged-native-session',
  providerInstanceId: ProviderInstanceId.make('codex'),
  importedAt: clientCreatedAt,
}

const normalizerTestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: 't3-normalizer-test-',
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
)

const makeThreadCreateCommand = (origin?: ThreadOrigin): ClientOrchestrationCommand =>
{
  const command = {
    type: 'thread.create',
    commandId: CommandId.make('command-thread-create'),
    threadId: ThreadId.make('thread-1'),
    projectId: ProjectId.make('project-1'),
    title: 'Client-created thread',
    modelSelection: {
      instanceId: ProviderInstanceId.make('codex'),
      model: 'gpt-5.4',
    },
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
    ...(origin === undefined ? {} : { origin }),
    createdAt: clientCreatedAt,
  } as const
  return command as ClientOrchestrationCommand
}

describe('canonicalizeClientCommandTimestamps', () =>
{
  it('replaces a client command timestamp with the server receipt timestamp', () =>
  {
    const command: ClientOrchestrationCommand = {
      type: 'project.create',
      commandId: CommandId.make('command-1'),
      projectId: ProjectId.make('project-1'),
      title: 'Clock-safe project',
      workspaceRoot: '/tmp/clock-safe-project',
      createdAt: clientCreatedAt,
    }

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    })
  })

  it('replaces both timestamps when the first turn bootstraps a thread', () =>
  {
    const command: ClientOrchestrationCommand = {
      type: 'thread.turn.start',
      commandId: CommandId.make('command-2'),
      threadId: ThreadId.make('thread-1'),
      message: {
        messageId: MessageId.make('message-1'),
        role: 'user',
        text: 'Start a thread',
        attachments: [],
      },
      runtimeMode: 'full-access',
      interactionMode: 'default',
      bootstrap: {
        createThread: {
          projectId: ProjectId.make('project-1'),
          title: 'Clock-safe thread',
          modelSelection: {
            instanceId: ProviderInstanceId.make('codex'),
            model: 'gpt-5.4',
          },
          runtimeMode: 'full-access',
          interactionMode: 'default',
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    }

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt)

    expect(result.type).toBe('thread.turn.start')
    if (result.type !== 'thread.turn.start')
    {
      throw new Error('Expected a thread.turn.start command')
    }
    expect(result.createdAt).toBe(serverReceivedAt)
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt)
  })
})

it.layer(normalizerTestLayer)('normalizeDispatchCommand', (it) =>
{
  it.effect('nulls forged provenance and replaces client timestamps on thread.create', () =>
    Effect.gen(function* ()
    {
      const forged = yield* normalizeDispatchCommand(makeThreadCreateCommand(forgedOrigin))
      expect(forged.type).toBe('thread.create')
      if (forged.type !== 'thread.create')
      {
        throw new Error('Expected a thread.create command')
      }
      expect(forged.origin).toBeNull()

      const command = makeThreadCreateCommand()
      const result = yield* normalizeDispatchCommand(command)
      expect(result).toEqual({
        ...command,
        origin: null,
        createdAt: expect.any(String),
      })
      if (result.type !== 'thread.create')
      {
        throw new Error('Expected a thread.create command')
      }
      expect(result.createdAt).not.toBe(clientCreatedAt)
    }),
  )
})
