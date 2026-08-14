// tests/packages/contracts/environmentHttp.test.ts
// verify versioned environment project-command compatibility

import { assert, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'

import {
  EnvironmentOrchestrationCommandUnsupportedError,
  EnvironmentProjectCommandV1,
} from '../../../packages/contracts/src/environmentHttp.ts'
import { ClientOrchestrationCommand } from '../../../packages/contracts/src/orchestration.ts'

const decodeProjectCommand = Schema.decodeUnknownSync(EnvironmentProjectCommandV1)
const decodeLegacyCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand)
const encodeUnsupportedCommand = Schema.encodeSync(EnvironmentOrchestrationCommandUnsupportedError)

it('decodes exactly the three supported environment project commands', () =>
{
  const commands = [
    {
      type: 'project.create',
      commandId: 'command-create',
      projectId: 'project-one',
      title: 'Project One',
      workspaceRoot: '/workspace/project-one',
      createdAt: '2026-08-09T00:00:00.000Z',
    },
    {
      type: 'project.meta.update',
      commandId: 'command-update',
      projectId: 'project-one',
      title: 'Renamed Project',
    },
    {
      type: 'project.delete',
      commandId: 'command-delete',
      projectId: 'project-one',
      force: true,
    },
  ] as const

  assert.deepStrictEqual(
    commands.map((input) => decodeProjectCommand(input).type),
    ['project.create', 'project.meta.update', 'project.delete'],
  )
})

it('rejects non-project commands from the narrow schema while preserving legacy decoding', () =>
{
  const threadDelete = {
    type: 'thread.delete',
    commandId: 'command-thread-delete',
    threadId: 'thread-one',
  }

  assert.throws(() => decodeProjectCommand(threadDelete))
  assert.strictEqual(decodeLegacyCommand(threadDelete).type, 'thread.delete')
})

it('preserves the typed unsupported-command response across encoding', () =>
{
  const error = new EnvironmentOrchestrationCommandUnsupportedError({
    code: 'unsupported_command',
    commandType: 'thread.archive',
    traceId: 'trace-one',
  })
  const encoded = encodeUnsupportedCommand(error)

  assert.deepStrictEqual(encoded, {
    _tag: 'EnvironmentOrchestrationCommandUnsupportedError',
    code: 'unsupported_command',
    commandType: 'thread.archive',
    traceId: 'trace-one',
  })
})
