// tests/apps/server/usage/UsageSummaryService.test.ts
// verify transcript-only usage scans and truthful empty or failed history

import * as NodeServices from '@effect/platform-node/NodeServices'
import { expect, it } from '@effect/vitest'
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from '@t3tools/contracts'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import {
  ImportDiscovery,
  ImportDiscoveryDeps,
  make as makeDiscovery,
} from '../../../../apps/server/src/import/discovery/discovery.ts'
import { layerTest as settingsLayerTest } from '../../../../apps/server/src/serverSettings.ts'
import { make as makeSummary } from '../../../../apps/server/src/usage/UsageSummaryService.ts'

it.effect(
  'treats absent transcript roots as empty, never probes unrelated providers, and retains real scan failures',
  () =>
    Effect.gen(function* ()
    {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: '456code-usage-summary-' })
      const codexHome = path.join(root, 'codex')
      const claudeHome = path.join(root, 'claude')
      yield* fs.makeDirectory(codexHome)
      yield* fs.makeDirectory(claudeHome)
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
          claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, enabled: false },
          cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: true },
          grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: true },
          opencode: {
            ...DEFAULT_SERVER_SETTINGS.providers.opencode,
            enabled: true,
            serverUrl: 'https://unrelated.example.invalid',
          },
        },
        providerInstances: {
          [ProviderInstanceId.make('usage-codex')]: {
            driver: ProviderDriverKind.make('codex'),
            enabled: true,
            environment: [{ name: 'CODEX_HOME', value: codexHome, sensitive: false }],
          },
          [ProviderInstanceId.make('usage-claude')]: {
            driver: ProviderDriverKind.make('claudeAgent'),
            enabled: true,
            environment: [{ name: 'CLAUDE_CONFIG_DIR', value: claudeHome, sensitive: false }],
          },
          [ProviderInstanceId.make('unrelated-cursor')]: {
            driver: ProviderDriverKind.make('cursor'),
            enabled: true,
          },
        },
      }
      let acpCalls = 0
      const discovery = yield* makeDiscovery.pipe(
        Effect.provideService(ImportDiscoveryDeps, {
          findImportedThread: () => Effect.succeed(null),
          findProjectByWorkspaceRoot: () => Effect.succeed(null),
          normalizeWorkspaceRoot: (value) => Effect.succeed(value),
          scanAcpSource: () =>
            Effect.sync(() =>
            {
              acpCalls += 1
              return []
            }),
        }),
      )
      const summary = yield* makeSummary.pipe(
        Effect.provideService(ImportDiscovery, discovery),
        Effect.provide(settingsLayerTest(settings)),
      )
      const window = { since: '2026-09-09T00:00:00.000Z', until: '2026-09-10T00:00:00.000Z' }
      const empty = yield* summary.getSummary(window)
      expect(empty.buckets).toEqual([])
      expect(empty.partial).toBe(false)
      expect(empty.sources.length).toBeGreaterThan(0)
      expect(empty.sources.every((source) => source.status === 'ok')).toBe(true)
      expect(acpCalls).toBe(0)

      yield* fs.writeFileString(path.join(claudeHome, 'projects'), 'not a directory')
      const failed = yield* summary.getSummary({ ...window, until: '2026-09-11T00:00:00.000Z' })
      expect(failed.partial).toBe(true)
      expect(failed.sources.some((source) => source.status !== 'ok')).toBe(true)
      expect(acpCalls).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
