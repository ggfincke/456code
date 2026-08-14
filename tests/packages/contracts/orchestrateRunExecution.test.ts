// tests/packages/contracts/orchestrateRunExecution.test.ts
// verifies versioned exact-run capability and RPC compatibility boundaries

import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetRunDiffInput,
  OrchestrationGetRunExecutionDiffV1Input,
  ThreadId,
} from '@t3tools/contracts'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vite-plus/test'

const decodeEnvironment = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)
const decodeLegacyRunDiff = Schema.decodeUnknownSync(OrchestrationGetRunDiffInput)
const decodeExactRunDiff = Schema.decodeUnknownSync(OrchestrationGetRunExecutionDiffV1Input)

describe('orchestrate run execution compatibility', () =>
{
  it('distinguishes an old server from one advertising the versioned exact API', () =>
  {
    const descriptor = {
      environmentId: EnvironmentId.make('environment-run-execution'),
      label: 'Environment',
      platform: { os: 'linux', arch: 'x64' },
      serverVersion: '1.0.0',
    }
    const oldServer = decodeEnvironment({ ...descriptor, capabilities: {} })
    const newServer = decodeEnvironment({
      ...descriptor,
      capabilities: { orchestrateRunExecutionV1: true },
    })

    expect(oldServer.capabilities.orchestrateRunExecutionV1).toBeUndefined()
    expect(newServer.capabilities.orchestrateRunExecutionV1).toBe(true)
    expect(ORCHESTRATION_WS_METHODS.getRunDiff).toBe('orchestration.getRunDiff')
    expect(ORCHESTRATION_WS_METHODS.getRunExecutionDiffV1).toBe(
      'orchestration.getRunExecutionDiff.v1',
    )
  })

  it('keeps the legacy input stable and requires the full exact execution identity', () =>
  {
    const threadId = ThreadId.make('thread-run-execution')
    expect(decodeLegacyRunDiff({ threadId })).toEqual({ threadId })
    expect(() => decodeExactRunDiff({ threadId })).toThrow()
    expect(
      decodeExactRunDiff({
        threadId,
        runId: 'run-1',
        planRevision: 3,
      }),
    ).toEqual({ threadId, runId: 'run-1', planRevision: 3 })
  })
})
