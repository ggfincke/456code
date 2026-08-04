// packages/effect-acp/src/terminal.ts
// define acp terminal

import * as Effect from 'effect/Effect'

import type * as AcpSchema from './_generated/schema.gen.ts'
import type * as AcpError from './errors.ts'

export interface AcpTerminal
{
  readonly sessionId: string
  readonly terminalId: string
  // reads buffered output from the terminal.
  // spec: https://agentclientprotocol.com/protocol/schema#terminal/output
  readonly output: Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>
  // waits for terminal exit and returns the exit result.
  // spec: https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
  readonly waitForExit: Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>
  // terminates the terminal process.
  // spec: https://agentclientprotocol.com/protocol/schema#terminal/kill
  readonly kill: Effect.Effect<AcpSchema.KillTerminalResponse, AcpError.AcpError>
  // releases the terminal handle from the ACP session.
  // spec: https://agentclientprotocol.com/protocol/schema#terminal/release
  readonly release: Effect.Effect<AcpSchema.ReleaseTerminalResponse, AcpError.AcpError>
}
