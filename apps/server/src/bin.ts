// apps/server/src/bin.ts
// run the 456code server CLI

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Command } from 'effect/unstable/cli'

import * as NetService from '@t3tools/shared/Net'
import packageJson from '../package.json' with { type: 'json' }
import { authCommand } from './cli/auth.ts'
import { sharedServerCommandFlags } from './cli/config.ts'
import { projectCommand } from './cli/project.ts'
import { runServerCommand, serveCommand, startCommand } from './cli/server.ts'
import { serviceCommand } from './cli/service.ts'

export { createCartographerAnalyzerIdentifier } from './cartographer/CartographerAnalyzer.ts'

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer)

export const makeCli = () =>
  Command.make('456code', { ...sharedServerCommandFlags }).pipe(
    Command.withDescription('Run the 456code server.'),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      authCommand,
      projectCommand,
      serviceCommand,
    ]),
  )

export const cli = makeCli()

if (import.meta.main)
{
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  )
}
