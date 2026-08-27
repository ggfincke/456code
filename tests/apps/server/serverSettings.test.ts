// tests/apps/server/serverSettings.test.ts
// verifies server settings persistence and patches
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from '@t3tools/contracts'
import { createModelSelection } from '@t3tools/shared/model'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Duration from 'effect/Duration'
import * as FileSystem from 'effect/FileSystem'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as ServerSecretStore from '../../../apps/server/src/auth/ServerSecretStore.ts'
import * as ServerConfig from '../../../apps/server/src/config.ts'
import { SqlitePersistenceMemory } from '../../../apps/server/src/persistence/Layers/Sqlite.ts'
import * as ServerSettingsModule from '../../../apps/server/src/serverSettings.ts'

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch)
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings)

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: 't3code-server-settings-test-',
        }),
      ),
    ),
  )

const makeFailingSecretStoreLayer = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      listNames: () => Effect.succeed([]),
      remove: () => Effect.void,
    }),
  )

const recordProjectedProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* ()
  {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`projected-${provider}-${instanceId ?? 'legacy'}`},
        ${'ready'},
        ${provider},
        ${instanceId},
        ${'2026-08-25T00:00:00.000Z'}
      )
    `
  })

const recordRuntimeProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* ()
  {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO provider_session_runtime (
        thread_id,
        provider_name,
        provider_instance_id,
        adapter_key,
        status,
        last_seen_at
      )
      VALUES (
        ${`runtime-${provider}-${instanceId ?? 'legacy'}`},
        ${provider},
        ${instanceId},
        ${provider},
        ${'ready'},
        ${'2026-08-25T00:00:00.000Z'}
      )
    `
  })

it.layer(NodeServices.layer)('server settings', (it) =>
{
  it.effect('preserves context when reading a provider environment secret fails', () =>
  {
    const platformCause = PlatformError.systemError({
      _tag: 'PermissionDenied',
      module: 'FileSystem',
      method: 'readFile',
      pathOrDescriptor: 'provider environment secret',
      description: 'Secret backend unavailable.',
    })
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: 'provider environment secret',
      cause: platformCause,
    })
    const configLayer = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: 't3code-server-settings-secret-failure-test-',
      }),
    )
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(makeFailingSecretStoreLayer(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(configLayer),
    )

    return Effect.gen(function* ()
    {
      const serverConfig = yield* ServerConfig.ServerConfig
      const fileSystem = yield* FileSystem.FileSystem
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}}}}',
      )

      const error = yield* Effect.flip(serverSettings.getSettings)

      assert.deepInclude(error, {
        _tag: 'ServerSettingsError',
        operation: 'read-secret',
        providerInstanceId: 'codex_personal',
        environmentVariable: 'OPENROUTER_API_KEY',
      })
      assert.strictEqual(error.cause, cause)
      assert.notInclude(error.message, cause.message)
    }).pipe(Effect.provide(settingsLayer))
  })

  it.effect('identifies provider history query failures', () =>
    Effect.gen(function* ()
    {
      const serverConfig = yield* ServerConfig.ServerConfig
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      const sql = yield* SqlClient.SqlClient
      yield* sql`DROP TABLE projection_thread_sessions`

      const error = yield* Effect.flip(serverSettings.getSettings)

      assert.deepInclude(error, {
        _tag: 'ServerSettingsError',
        operation: 'read-provider-history',
        settingsPath: serverConfig.settingsPath,
      })
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('decodes nested settings patches', () =>
    Effect.gen(function* ()
    {
      assert.deepEqual(
        yield* decodeSettingsPatch({ providers: { codex: { binaryPath: '/tmp/codex' } } }),
        {
          providers: { codex: { binaryPath: '/tmp/codex' } },
        },
      )

      assert.deepEqual(
        yield* decodeSettingsPatch({
          textGenerationModelSelection: {
            options: [{ id: 'fastMode', value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: 'fastMode', value: false }],
          },
        },
      )
    }),
  )

  it.effect(
    'decodes legacy object-shaped textGenerationModelSelection.options from settings.json',
    () =>
      Effect.gen(function* ()
      {
        const decoded = yield* decodeServerSettings({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make('codex'),
            model: 'gpt-5.4-mini',
            options: { reasoningEffort: 'low' },
          },
        })

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5.4-mini',
          options: [{ id: 'reasoningEffort', value: 'low' }],
        })
      }),
  )

  it.effect('deep merges nested settings updates without dropping siblings', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: '/usr/local/bin/codex',
            homePath: '/Users/julius/.codex',
          },
          claudeAgent: {
            binaryPath: '/usr/local/bin/claude',
            customModels: ['claude-custom'],
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make('codex'),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: 'reasoningEffort', value: 'high' },
              { id: 'fastMode', value: true },
            ],
          ).options!,
        },
      })

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: '/opt/homebrew/bin/codex',
          },
        },
        textGenerationModelSelection: {
          options: [{ id: 'fastMode', value: false }],
        },
      })

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/codex',
        homePath: '/Users/julius/.codex',
        shadowHomePath: '',
        launchArgs: '',
        customModels: [],
      })
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: '/usr/local/bin/claude',
        homePath: '',
        customModels: ['claude-custom'],
        launchArgs: '',
      })
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make('codex'),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: 'reasoningEffort', value: 'high' },
            { id: 'fastMode', value: false },
          ],
        ),
      )
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('preserves model when switching providers via textGenerationModelSelection', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService

      // start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make('claudeAgent'),
          model: 'claude-sonnet-4-6',
          options: createModelSelection(
            ProviderInstanceId.make('claudeAgent'),
            'claude-sonnet-4-6',
            [{ id: 'effort', value: 'high' }],
          ).options!,
        },
      })

      // switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: 'gpt-5.4',
          options: createModelSelection(ProviderInstanceId.make('codex'), 'gpt-5.4', [
            { id: 'reasoningEffort', value: 'high' },
          ]).options!,
        },
      })

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make('codex'), 'gpt-5.4', [
          { id: 'reasoningEffort', value: 'high' },
        ]),
      )
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('preserves custom provider instance text generation selections', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make('claude_openrouter')]: {
            driver: ProviderDriverKind.make('claudeAgent'),
            enabled: true,
            config: { customModels: ['openai/gpt-5.5'] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make('claude_openrouter'),
          model: 'openai/gpt-5.5',
        },
      })

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make('claude_openrouter'),
        model: 'openai/gpt-5.5',
      })
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect(
    'uses explicit provider instance enabled state over legacy provider enabled state',
    () =>
      Effect.gen(function* ()
      {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService
        const instanceId = ProviderInstanceId.make('claude_openrouter')

        const next = yield* serverSettings.updateSettings({
          providers: {
            claudeAgent: {
              enabled: false,
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make('claudeAgent'),
              enabled: true,
              config: { customModels: ['openai/gpt-5.5'] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: 'openai/gpt-5.5',
          },
        })

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: 'openai/gpt-5.5',
        })
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('preserves enabled text generation selections for non-built-in drivers', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      const instanceId = ProviderInstanceId.make('openrouter_text')

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make('openrouter'),
            enabled: true,
            config: { customModels: ['openai/gpt-5.5'] },
          },
        },
        textGenerationModelSelection: {
          instanceId,
          model: 'openai/gpt-5.5',
        },
      })

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId,
        model: 'openai/gpt-5.5',
      })
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect(
    'preserves the source control writer selection when its provider instance is disabled',
    () =>
      Effect.gen(function* ()
      {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService
        const serverConfig = yield* ServerConfig.ServerConfig
        const fileSystem = yield* FileSystem.FileSystem
        const instanceId = ProviderInstanceId.make('codex_writer')
        const sourceControlWriterModelSelection = {
          instanceId,
          model: 'gpt-5.4-mini',
        }

        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make('codex'),
              enabled: true,
              config: {},
            },
          },
          sourceControlWriterModelSelection,
        })

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make('codex'),
              enabled: false,
              config: {},
            },
          },
        })

        assert.deepEqual(next.sourceControlWriterModelSelection, sourceControlWriterModelSelection)
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next),
          next.textGenerationModelSelection,
        )
        assert.deepEqual(
          (yield* serverSettings.getSettings).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        )

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath)
        assert.deepEqual(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.parse(raw).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        )

        const restored = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make('codex'),
              enabled: true,
              config: {},
            },
          },
        })
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored),
          sourceControlWriterModelSelection,
        )
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('drops stale text generation options when resetting model selection', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make('codex'),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make('codex'),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: 'reasoningEffort', value: 'high' },
              { id: 'fastMode', value: true },
            ],
          ).options!,
        },
      })

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      })

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      })
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('replaces provider instance maps when clearing optional fields', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      const codexId = ProviderInstanceId.make('codex')

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make('codex'),
            displayName: 'Codex Work',
            accentColor: '#7c3aed',
            enabled: true,
            config: { homePath: '~/.codex' },
          },
        },
      })

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make('codex'),
            displayName: 'Codex Work',
            enabled: true,
            config: { homePath: '~/.codex' },
          },
        },
      })

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make('codex'),
        displayName: 'Codex Work',
        enabled: true,
        config: { homePath: '~/.codex' },
      })
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('restores every historically used false-default provider', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      yield* recordProjectedProviderUsage('grok')
      yield* recordProjectedProviderUsage('coral')
      yield* recordProjectedProviderUsage('gemini')
      yield* recordRuntimeProviderUsage('antigravity')
      yield* recordRuntimeProviderUsage('opencode')

      const settings = yield* serverSettings.getSettings

      assert.isTrue(settings.providers.grok.enabled)
      assert.isTrue(settings.providers.coral.enabled)
      assert.isTrue(settings.providers.gemini.enabled)
      assert.isTrue(settings.providers.antigravity.enabled)
      assert.isTrue(settings.providers.opencode.enabled)
      assert.isTrue(settings.providers.codex.enabled)
      assert.isTrue(settings.providers.claudeAgent.enabled)
      assert.isTrue(settings.providers.cursor.enabled)
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('restores only matching custom instances and preserves explicit disables', () =>
    Effect.gen(function* ()
    {
      const serverConfig = yield* ServerConfig.ServerConfig
      const fileSystem = yield* FileSystem.FileSystem
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"grok":{"enabled":false}},"providerInstances":{"grok_work":{"driver":"grok","config":{}},"coral_disabled":{"driver":"coral","enabled":false,"config":{}},"gemini_disabled":{"driver":"gemini","config":{"enabled":false}},"opencode_unused":{"driver":"opencode","config":{}}}}',
      )
      yield* recordProjectedProviderUsage('grok', 'grok_work')
      yield* recordRuntimeProviderUsage('coral', 'coral_disabled')
      yield* recordRuntimeProviderUsage('gemini', 'gemini_disabled')

      const settings = yield* serverSettings.getSettings

      assert.isFalse(settings.providers.grok.enabled)
      assert.isFalse(settings.providers.antigravity.enabled)
      assert.isFalse(settings.providers.opencode.enabled)
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make('grok_work')]?.enabled)
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make('coral_disabled')]?.enabled)
      assert.isFalse(
        settings.providerInstances[ProviderInstanceId.make('gemini_disabled')]?.enabled,
      )
      const unused = settings.providerInstances[ProviderInstanceId.make('opencode_unused')]
      assert.isDefined(unused)
      assert.isFalse(resolveProviderInstanceEnabled(unused))
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('preserves explicit provider flags when another persisted field is invalid', () =>
    Effect.gen(function* ()
    {
      const serverConfig = yield* ServerConfig.ServerConfig
      const fileSystem = yield* FileSystem.FileSystem
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"addProjectBaseDirectory":42,"providers":{"grok":{"enabled":false},"coral":{"enabled":true}}}',
      )
      yield* recordProjectedProviderUsage('grok')
      yield* recordProjectedProviderUsage('gemini')

      const settings = yield* serverSettings.getSettings

      assert.isFalse(settings.providers.grok.enabled)
      assert.isTrue(settings.providers.coral.enabled)
      assert.isTrue(settings.providers.gemini.enabled)
      assert.equal(settings.addProjectBaseDirectory, '')
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('keeps inferred restoration sparse while persisting explicit provider choices', () =>
    Effect.gen(function* ()
    {
      const serverConfig = yield* ServerConfig.ServerConfig
      const fileSystem = yield* FileSystem.FileSystem
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"opencode_work":{"driver":"opencode","config":{}}}}',
      )
      yield* recordProjectedProviderUsage('grok')
      yield* recordRuntimeProviderUsage('opencode', 'opencode_work')

      const inferred = yield* serverSettings.getSettings
      assert.isTrue(inferred.providers.grok.enabled)
      assert.isTrue(inferred.providerInstances[ProviderInstanceId.make('opencode_work')]?.enabled)

      const updated = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: '~/Development',
        providers: {
          grok: { enabled: false },
          coral: { enabled: true },
        },
      })
      assert.isFalse(updated.providers.grok.enabled)
      assert.isTrue(updated.providers.coral.enabled)
      assert.isTrue(updated.providerInstances[ProviderInstanceId.make('opencode_work')]?.enabled)

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath)
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw)
      assert.deepEqual(persisted.providers, {
        grok: { enabled: false },
        coral: { enabled: true },
      })
      assert.isUndefined(persisted.providerInstances.opencode_work.enabled)
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('folds legacy in-config enabled flags with explicit false winning', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      const grokId = ProviderInstanceId.make('grok')
      const codexId = ProviderInstanceId.make('codex_work')

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make('grok'),
            enabled: true,
            config: { enabled: false, binaryPath: '/opt/grok' },
          },
          [codexId]: {
            driver: ProviderDriverKind.make('codex'),
            config: { enabled: true, homePath: '~/.codex' },
          },
        },
      })

      assert.deepEqual(next.providerInstances[grokId], {
        driver: ProviderDriverKind.make('grok'),
        enabled: false,
        config: { binaryPath: '/opt/grok' },
      })
      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make('codex'),
        enabled: true,
        config: { homePath: '~/.codex' },
      })
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('trims provider path and observability settings when updates are applied', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: '  ~/Development  ',
        providers: {
          codex: {
            binaryPath: '  /opt/homebrew/bin/codex  ',
            homePath: '   ',
          },
          claudeAgent: {
            binaryPath: '  /opt/homebrew/bin/claude  ',
          },
          opencode: {
            binaryPath: '  /opt/homebrew/bin/opencode  ',
            serverUrl: '  http://127.0.0.1:4096  ',
            serverPassword: '  secret-password  ',
          },
        },
        observability: {
          otlpTracesUrl: '  http://localhost:4318/v1/traces  ',
          otlpMetricsUrl: '  http://localhost:4318/v1/metrics  ',
        },
      })

      assert.equal(next.addProjectBaseDirectory, '~/Development')
      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/codex',
        homePath: '',
        shadowHomePath: '',
        launchArgs: '',
        customModels: [],
      })
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/claude',
        homePath: '',
        customModels: [],
        launchArgs: '',
      })
      assert.deepEqual(next.providers.opencode, {
        enabled: false,
        binaryPath: '/opt/homebrew/bin/opencode',
        serverUrl: 'http://127.0.0.1:4096',
        serverPassword: 'secret-password',
        customModels: [],
      })
      assert.deepEqual(next.observability, {
        otlpTracesUrl: 'http://localhost:4318/v1/traces',
        otlpMetricsUrl: 'http://localhost:4318/v1/metrics',
      })
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('publishes architecture auto-analysis updates', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      const updateFiber = yield* Stream.runHead(serverSettings.streamChanges).pipe(Effect.forkChild)

      const next = yield* serverSettings.updateSettings({ architectureAutoAnalysis: 'auto' })
      const published = Option.getOrThrow(yield* Fiber.join(updateFiber))

      assert.equal(next.architectureAutoAnalysis, 'auto')
      assert.equal(published.architectureAutoAnalysis, 'auto')
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('defaults blank binary paths to provider executables', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: '   ',
          },
          claudeAgent: {
            binaryPath: '',
          },
        },
      })

      assert.equal(next.providers.codex.binaryPath, 'codex')
      assert.equal(next.providers.claudeAgent.binaryPath, 'claude')
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('writes only non-default server settings to disk', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      const serverConfig = yield* ServerConfig.ServerConfig
      const fileSystem = yield* FileSystem.FileSystem
      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: '~/Development',
        observability: {
          otlpTracesUrl: 'http://localhost:4318/v1/traces',
          otlpMetricsUrl: 'http://localhost:4318/v1/metrics',
        },
        providers: {
          codex: {
            binaryPath: '/opt/homebrew/bin/codex',
          },
          opencode: {
            serverUrl: 'http://127.0.0.1:4096',
            serverPassword: 'secret-password',
          },
        },
        automaticGitFetchInterval: Duration.seconds(10),
        architectureAutoAnalysis: 'auto',
      })

      assert.equal(next.providers.codex.binaryPath, '/opt/homebrew/bin/codex')
      assert.equal(next.architectureAutoAnalysis, 'auto')

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath)
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: '~/Development',
        observability: {
          otlpTracesUrl: 'http://localhost:4318/v1/traces',
          otlpMetricsUrl: 'http://localhost:4318/v1/metrics',
        },
        providers: {
          codex: {
            binaryPath: '/opt/homebrew/bin/codex',
          },
          opencode: {
            serverUrl: 'http://127.0.0.1:4096',
            serverPassword: 'secret-password',
          },
        },
        automaticGitFetchInterval: 10_000,
        architectureAutoAnalysis: 'auto',
      })

      yield* serverSettings.updateSettings({ architectureAutoAnalysis: 'on-demand' })
      const restoredRaw = yield* fileSystem.readFileString(serverConfig.settingsPath)
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.notProperty(JSON.parse(restoredRaw), 'architectureAutoAnalysis')
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )

  it.effect('stores sensitive provider instance environment values outside settings.json', () =>
    Effect.gen(function* ()
    {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService
      const serverConfig = yield* ServerConfig.ServerConfig
      const fileSystem = yield* FileSystem.FileSystem
      const instanceId = ProviderInstanceId.make('codex_personal')

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make('codex'),
            environment: [
              { name: 'OPENROUTER_API_KEY', value: 'sk-or-secret', sensitive: true },
              { name: 'ANTHROPIC_BASE_URL', value: 'https://openrouter.ai/api', sensitive: false },
            ],
            config: {},
          },
        },
      })

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: 'OPENROUTER_API_KEY',
          value: 'sk-or-secret',
          sensitive: true,
          valueRedacted: true,
        },
        { name: 'ANTHROPIC_BASE_URL', value: 'https://openrouter.ai/api', sensitive: false },
      ])

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath)
      assert.notInclude(raw, 'sk-or-secret')
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: 'OPENROUTER_API_KEY',
          value: '',
          sensitive: true,
          valueRedacted: true,
        },
        { name: 'ANTHROPIC_BASE_URL', value: 'https://openrouter.ai/api', sensitive: false },
      ])

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make('codex'),
            displayName: 'Codex Personal',
            environment: [
              { name: 'OPENROUTER_API_KEY', value: '', sensitive: true, valueRedacted: true },
              { name: 'ANTHROPIC_BASE_URL', value: 'https://openrouter.ai/api', sensitive: false },
            ],
            config: {},
          },
        },
      })

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        'sk-or-secret',
      )
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  )
})
