// apps/server/src/cli/server.ts
// run server command

import * as Effect from 'effect/Effect'
import { Command, GlobalFlag } from 'effect/unstable/cli'

import { ServerConfig, type StartupPresentation } from '../config.ts'
import { runServer } from '../server.ts'
import * as ServerStorageLease from '../serverStorageLease.ts'
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from './config.ts'

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation
    readonly forceAutoBootstrapProjectFromCwd?: boolean
  },
) =>
  Effect.scoped(
    Effect.gen(function* ()
    {
      const logLevel = yield* GlobalFlag.LogLevel
      const { config, storageLease } = yield* resolveServerConfig(flags, logLevel, options)
      return yield* runServer.pipe(
        Effect.provideService(ServerConfig, config),
        Effect.provideService(ServerStorageLease.ServerStorageLease, storageLease),
      )
    }),
  )

export const startCommand = Command.make('start', { ...sharedServerCommandFlags }).pipe(
  Command.withDescription('Run the 456code server.'),
  Command.withHandler((flags) => runServerCommand(flags)),
)

export const serveCommand = Command.make('serve', { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    'Run the 456code server without opening a browser and print headless pairing details.',
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: 'headless',
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
)
