// tests/apps/desktop/backend/DesktopBackendPool.test.ts
// verify desktop backend pool behavior

import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import { HttpClient } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process'

import * as DesktopObservability from '../../../../apps/desktop/src/app/DesktopObservability.ts'
import * as DesktopAppSettings from '../../../../apps/desktop/src/settings/DesktopAppSettings.ts'
import * as ElectronDialog from '../../../../apps/desktop/src/electron/ElectronDialog.ts'
import * as DesktopWindow from '../../../../apps/desktop/src/window/DesktopWindow.ts'
import * as DesktopBackendConfiguration from '../../../../apps/desktop/src/backend/DesktopBackendConfiguration.ts'
import * as DesktopBackendPool from '../../../../apps/desktop/src/backend/DesktopBackendPool.ts'

function makePoolLayer(
  labelRef: Ref.Ref<string>,
): Layer.Layer<DesktopBackendPool.DesktopBackendPool>
{
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({}),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die('unexpected child process spawn')),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die('unexpected HTTP request')),
        ),
        Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
          forInstance: () =>
            Effect.succeed({
              writeSessionBoundary: () => Effect.void,
              writeOutputChunk: () => Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLogShape),
        } satisfies DesktopObservability.DesktopBackendOutputLogFactory['Service']),
        Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
          resolvePrimary: Effect.die('unexpected primary config resolve'),
          resolvePrimaryLabel: Ref.get(labelRef),
          resolveWsl: () => Effect.die('unexpected WSL config resolve'),
        } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration['Service']),
        DesktopAppSettings.layerTest(),
        ElectronDialog.layer,
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die('unexpected window create'),
          ensureMain: Effect.die('unexpected window ensure'),
          revealOrCreateMain: Effect.die('unexpected window reveal'),
          activate: Effect.die('unexpected window activate'),
          createMainIfBackendReady: Effect.die('unexpected window create'),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          dispatchMenuAction: () => Effect.die('unexpected menu action'),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow['Service']),
      ),
    ),
  )
}

describe('DesktopBackendPool', () =>
{
  it.effect('resolves the primary label lazily after pool layer construction', () =>
    Effect.scoped(
      Effect.gen(function* ()
      {
        const labelRef = yield* Ref.make('Windows')
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(makePoolLayer(labelRef)),
        )
        const primary = yield* pool.primary

        yield* Ref.set(labelRef, 'WSL (Ubuntu)')

        assert.equal(yield* primary.label, 'WSL (Ubuntu)')
      }),
    ),
  )
})
