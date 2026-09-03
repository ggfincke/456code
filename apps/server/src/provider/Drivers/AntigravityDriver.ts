// apps/server/src/provider/Drivers/AntigravityDriver.ts
// creates isolated official Antigravity provider instances

import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderSetupError,
  type ServerProvider,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type { AcpError } from 'effect-acp/errors'

import { ServerConfig } from '../../config.ts'
import { makeAntigravityTextGeneration } from '../../textGeneration/AntigravityTextGeneration.ts'
import { makeAntigravityAuth, type AntigravityAuth } from '../AntigravityAuth.ts'
import { AntigravityInstallation } from '../AntigravityInstallation.ts'
import {
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  prepareAntigravityProfile,
  resolveAntigravityProfileDirectory,
} from '../antigravityAuthSupport.ts'
import {
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
} from '../acp/AntigravityAcpSupport.ts'
import type { AcpSessionRuntime, AcpSessionRuntimeStartResult } from '../acp/AcpSessionRuntime.ts'
import { removeAntigravitySessionFiles } from '../acp/AntigravitySessionFiles.ts'
import { canonicalFileContinuationIdentity } from '../continuationIdentity.ts'
import { ProviderDriverError } from '../Errors.ts'
import { makeAntigravityAdapter } from '../Layers/AntigravityAdapter.ts'
import { makeAntigravityProvider } from '../Layers/AntigravityProvider.ts'
import { ProviderEventLoggers } from '../Layers/ProviderEventLoggers.ts'
import type { ServerProviderDraft } from '../providerSnapshot.ts'
import type { ProviderDriver, ProviderInstance } from '../catalog/ProviderDriver.ts'
import { mergeProviderInstanceEnvironment } from '../catalog/ProviderInstanceEnvironment.ts'
import {
  discoverAntigravitySkills,
} from './AntigravitySkills.ts'

const DRIVER = ProviderDriverKind.make('antigravity')
const decodeSettings = Schema.decodeSync(AntigravitySettings)

export type AntigravityDriverEnv =
  | AntigravityInstallation
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance['instanceId']
    readonly displayName: string | undefined
    readonly accentColor: string | undefined
    readonly continuationGroupKey: string
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  })

// each instance owns its Google profile. Executable releases are shared by the environment.
export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: 'Antigravity', supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* ()
    {
      const crypto = yield* Crypto.Crypto
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const serverConfig = yield* ServerConfig
      const installation = yield* AntigravityInstallation
      const loggers = yield* ProviderEventLoggers
      const settings = { ...config, enabled } satisfies AntigravitySettings
      const processEnvironment = mergeProviderInstanceEnvironment(environment)
      const profileDirectory = resolveAntigravityProfileDirectory(serverConfig.stateDir, instanceId)
      const resolveContinuationIdentity = canonicalFileContinuationIdentity(
        DRIVER,
        path.join(profileDirectory, 'antigravity-acp', 'conversations'),
      ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
      const continuationIdentity = yield* resolveContinuationIdentity
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      })

      const makeRuntime = Effect.fn('AntigravityDriver.makeRuntime')(function* (
        input: Omit<AntigravityAcpRuntimeInput, 'spawn' | 'childProcessSpawner'>,
      ): Effect.fn.Return<
        AcpSessionRuntime['Service'],
        AcpError | ProviderSetupError,
        Scope.Scope
      >
      {
        const executable = yield* installation.acquire(settings.officialRuntime).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId,
                operation: 'resolve',
                detail: cause.detail,
              }),
          ),
        )
        const profile = yield* prepareAntigravityProfile({
          profileDirectory,
          baseEnv: processEnvironment,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        )
        const runtime = yield* makeAntigravityAcpRuntime({
          ...input,
          childProcessSpawner: spawner,
          spawn: buildAntigravityAcpSpawnInput({
            installation: executable,
            profile,
            cwd: input.cwd,
            baseEnv: processEnvironment,
          }),
        }).pipe(Effect.provideService(Crypto.Crypto, crypto))
        return {
          ...runtime,
          start: () =>
            runtime
              .start()
              .pipe(
                Effect.tapError((cause): Effect.Effect<void> =>
                  input.onAuthorizationUrl === undefined && isAntigravitySignInRequiredError(cause)
                    ? provider.onAuthRequired
                    : Effect.void,
                ),
              ),
        }
      })

      const makeDisposableRuntime = Effect.fn('AntigravityDriver.makeDisposableRuntime')(function* (
        input: Pick<AntigravityAcpRuntimeInput, 'onAuthorizationUrl'>,
      )
      {
        const cwd = yield* fileSystem
          .makeTempDirectoryScoped({
            prefix: 't3-antigravity-setup-',
          })
          .pipe(
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId,
                  operation: 'start',
                  detail: 'Could not create an Antigravity setup workspace.',
                }),
            ),
          )
        let sessionId: string | undefined
        yield* Effect.addFinalizer(() =>
          removeAntigravitySessionFiles({ profileDirectory, sessionId, cwd }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        )
        const runtime = yield* makeRuntime({
          cwd,
          clientInfo: { name: 't3-code-provider-setup', version: '0.0.0' },
          mcpServers: [],
          ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
        })
        return {
          ...runtime,
          start: () =>
            runtime.start().pipe(
              Effect.tap((started) =>
                Effect.sync(() =>
                {
                  sessionId = started.sessionId
                }),
              ),
            ),
        }
      })

      const publishCatalog = (
        started: AcpSessionRuntimeStartResult,
        runtime: Pick<AcpSessionRuntime['Service'], 'getEvents' | 'drainEvents'>,
      ): Effect.Effect<void> =>
        Effect.gen(function* ()
        {
          yield* provider.onSessionStarted(started)
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
          {
            if (event._tag === 'EventStreamBarrier')
            {
              return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
            }
            return event._tag === 'AvailableCommandsUpdated'
              ? provider.onAvailableCommands(event.availableCommands)
              : Effect.void
          }).pipe(Effect.forkScoped)
          yield* runtime.drainEvents
        }).pipe(Effect.scoped)

      const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
        instanceId,
        makeRuntime: makeDisposableRuntime,
        onAuthenticated: publishCatalog,
        onSignedOut: Effect.suspend(() => provider.onSignedOut),
      })

      const probe = Effect.gen(function* ()
      {
        const processScope = yield* Scope.make()
        yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit))
        return yield* authFlow
          .withProcess(
            Scope.close(processScope, Exit.void),
            Effect.gen(function* ()
            {
              const runtime = yield* makeRuntime({
                cwd: serverConfig.stateDir,
                clientInfo: { name: 't3-code-provider-probe', version: '0.0.0' },
                mcpServers: [],
              })
              return yield* runtime.initialize()
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, processScope))
      }).pipe(Effect.scoped)

      const provider = yield* makeAntigravityProvider(settings, {
        stampIdentity: (draft) => Effect.succeed(stampIdentity(draft)),
        probe,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: 'Could not prepare the Antigravity provider status.',
              cause,
            }),
        ),
      )

      const adapter = yield* makeAntigravityAdapter(settings, {
        instanceId,
        makeRuntime,
        withProcess: authFlow.withProcess,
        onSessionStarted: provider.onSessionStarted,
        onAvailableCommands: provider.onAvailableCommands,
        onAuthRequired: provider.onAuthRequired,
        ...(loggers.native ? { nativeEventLogger: loggers.native } : {}),
      })
      const textGeneration = yield* makeAntigravityTextGeneration({
        profileDirectory,
        withProcess: authFlow.withProcess,
        makeRuntime: (cwd) =>
          makeRuntime({
            cwd,
            clientInfo: { name: 't3-code-text', version: '0.0.0' },
            mcpServers: [],
          }),
      })

      const refreshModels = Effect.fn('AntigravityDriver.refreshModels')(
        function* ()
        {
          const processScope = yield* Scope.make()
          yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit))
          yield* authFlow
            .withProcess(
              Scope.close(processScope, Exit.void),
              Effect.gen(function* ()
              {
                const runtime = yield* makeDisposableRuntime({})
                const started = yield* runtime.start()
                yield* publishCatalog(started, runtime)
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, processScope))
        },
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: '60 seconds',
          orElse: () =>
            Effect.fail(
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: 'Antigravity model refresh timed out. Try again or check Google sign-in.',
              }),
            ),
        }),
        Effect.tapError((cause) =>
          isAntigravitySignInRequiredError(cause) ? provider.onAuthRequired : Effect.void,
        ),
        Effect.mapError((cause) =>
          cause._tag === 'ProviderDriverError'
            ? cause
            : new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: isAntigravitySignInRequiredError(cause)
                  ? 'Sign in to Antigravity in provider settings before refreshing models.'
                  : 'Could not refresh Antigravity models. The previous model list is unchanged.',
                cause,
              }),
        ),
      )

      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        resolveContinuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: provider.snapshot,
        snapshotForCwd: (cwd) =>
          !enabled
            ? provider.snapshot.getSnapshot
            : discoverAntigravitySkills({ cwd, profileDirectory }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER,
                      instanceId,
                      detail: 'Could not read Antigravity workspace skills.',
                      cause,
                    }),
                ),
              ),
        adapter,
        textGeneration,
        auth: authFlow.controller,
        refreshModels: refreshModels(),
      } satisfies ProviderInstance
    }),
}
