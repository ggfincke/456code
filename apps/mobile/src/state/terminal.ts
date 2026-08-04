// apps/mobile/src/state/terminal.ts
// manage terminal environment state

import { createTerminalEnvironmentAtoms } from '@t3tools/client-runtime/state/terminal'

import { connectionAtomRuntime } from '../connection/runtime'

export const terminalEnvironment = createTerminalEnvironmentAtoms(connectionAtomRuntime)
