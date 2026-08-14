// apps/desktop/src/window/DesktopMenuBar.ts
// manages the macOS menu bar status item

import { scopeThreadRef, scopedThreadKey } from '@t3tools/client-runtime/environment'
import type { DesktopMenuBarState, DesktopMenuBarThread } from '@t3tools/contracts'
import { truncate } from '@t3tools/shared/String'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'

import type * as Electron from 'electron'

import * as DesktopAssets from '../app/DesktopAssets.ts'
import * as DesktopEnvironment from '../app/DesktopEnvironment.ts'
import { makeComponentLogger } from '../app/DesktopObservability.ts'
import * as ElectronTray from '../electron/ElectronTray.ts'
import * as DesktopWindow from './DesktopWindow.ts'

const MENU_BAR_ICON_FILE_NAME = 'menu-bar-iconTemplate.png'
const OPEN_THREAD_ACTION_PREFIX = 'open-thread:'

export class DesktopMenuBar extends Context.Service<
  DesktopMenuBar,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>
    readonly setState: (state: DesktopMenuBarState) => Effect.Effect<void>
  }
>()('@t3tools/desktop/window/DesktopMenuBar')
{}

type DesktopMenuBarRuntimeServices = DesktopWindow.DesktopWindow

const { logError: logMenuBarError, logWarning: logMenuBarWarning } =
  makeComponentLogger('desktop-menu-bar')

// exported so the notification click produces the byte-identical deep link the
// tray produces; two hand-rolled encoders would drift and one of the surfaces
// would silently stop opening threads.
export function buildOpenThreadAction(
  thread: Pick<DesktopMenuBarThread, 'environmentId' | 'threadId'>,
): string
{
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.threadId))
  return `${OPEN_THREAD_ACTION_PREFIX}${encodeURIComponent(key)}`
}

function formatUsageWindowLabel(label: string): string
{
  const normalized = label.trim().toLowerCase()
  if (normalized === 'week' || normalized === '1w' || normalized === '7d')
  {
    return 'Weekly'
  }
  if (normalized === 'month' || normalized === '30d')
  {
    return 'Monthly'
  }
  return label
}

function formatUsageResetDate(value: string | null): string | null
{
  if (value === null)
  {
    return null
  }
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: (date) => DateTime.formatLocal(date, { month: 'short', day: 'numeric' }),
  })
}

// the project title alone never says what a thread is waiting on, so the
// status the renderer already resolved is folded into the same secondary line
// rather than adding a second row per thread. sublabel is macOS >= 14.4 only,
// which is fine because the tray itself is darwin-only.
function formatThreadSublabel(thread: DesktopMenuBarThread): string
{
  return thread.status === undefined
    ? truncate(thread.projectTitle, 64)
    : `${truncate(thread.projectTitle, 48)} · ${thread.status}`
}

function formatUsageItem(item: DesktopMenuBarState['usageItems'][number]): string
{
  const resetDate = formatUsageResetDate(item.resetsAt)
  const usage = `${formatUsageWindowLabel(item.windowLabel)} ${Math.round(item.usedPercent)}%`
  return `${item.providerLabel} · ${usage}${resetDate === null ? '' : ` · ${resetDate}`}`
}

export const make = Effect.gen(function* ()
{
  const assets = yield* DesktopAssets.DesktopAssets
  const environment = yield* DesktopEnvironment.DesktopEnvironment
  const electronTray = yield* ElectronTray.ElectronTray
  const desktopWindow = yield* DesktopWindow.DesktopWindow
  const stateRef = yield* Ref.make<DesktopMenuBarState>({ recentThreads: [], usageItems: [] })
  const trayRef = yield* Ref.make<Option.Option<ElectronTray.ElectronTrayHandle>>(Option.none())
  const context = yield* Effect.context<DesktopMenuBarRuntimeServices>()
  const runPromise = Effect.runPromiseWith(context)

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopWindow.DesktopWindow>,
  ) =>
  {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan('desktop.menuBar.action'),
        Effect.catchCause((cause) => logMenuBarError('menu bar action failed', { action, cause })),
      ),
    )
  }

  const buildMenuTemplate = (state: DesktopMenuBarState): Electron.MenuItemConstructorOptions[] =>
  {
    const template: Electron.MenuItemConstructorOptions[] = []

    if (state.recentThreads.length > 0)
    {
      template.push({ type: 'header', label: 'Recent' })
      for (const thread of state.recentThreads)
      {
        template.push({
          label: truncate(thread.title, 64),
          sublabel: formatThreadSublabel(thread),
          click: () =>
          {
            runMenuEffect(
              'open-thread',
              desktopWindow.dispatchMenuAction(buildOpenThreadAction(thread)),
            )
          },
        })
      }
      template.push({ type: 'separator' })
    }

    if (state.usageItems.length > 0)
    {
      template.push({ type: 'header', label: 'Usage' })
      for (const item of state.usageItems)
      {
        template.push({
          label: formatUsageItem(item),
          enabled: false,
        })
      }
      template.push({ type: 'separator' })
    }

    template.push(
      {
        label: 'New Thread',
        accelerator: 'CmdOrCtrl+N',
        click: () =>
        {
          runMenuEffect('new-thread', desktopWindow.dispatchMenuAction('new-thread'))
        },
      },
      { type: 'separator' },
      {
        label: `Open ${environment.branding.baseName}`,
        click: () =>
        {
          runMenuEffect('open-app', desktopWindow.activate)
        },
      },
      { type: 'separator' },
      {
        label: `Quit ${environment.branding.baseName}`,
        role: 'quit',
      },
    )

    return template
  }

  const refreshMenu = Effect.gen(function* ()
  {
    const tray = yield* Ref.get(trayRef)
    if (Option.isNone(tray))
    {
      return
    }

    const state = yield* Ref.get(stateRef)
    yield* tray.value
      .setContextMenu(buildMenuTemplate(state))
      .pipe(Effect.catch((error) => logMenuBarError(error.message, { error })))
  }).pipe(Effect.withSpan('desktop.menuBar.refresh'))

  const configure = Effect.gen(function* ()
  {
    if (environment.platform !== 'darwin')
    {
      return
    }

    const iconPath = yield* assets
      .resolveResourcePath(MENU_BAR_ICON_FILE_NAME)
      .pipe(
        Effect.catch((error) =>
          logMenuBarWarning('could not resolve the menu bar icon', { error }).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      )
    if (Option.isNone(iconPath))
    {
      yield* logMenuBarWarning('menu bar icon is unavailable', {
        fileName: MENU_BAR_ICON_FILE_NAME,
      })
      return
    }

    const tray = yield* electronTray
      .create({
        iconPath: iconPath.value,
        toolTip: environment.displayName,
      })
      .pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          logMenuBarError(error.message, { error }).pipe(
            Effect.as(Option.none<ElectronTray.ElectronTrayHandle>()),
          ),
        ),
      )
    if (Option.isNone(tray))
    {
      return
    }

    yield* Ref.set(trayRef, tray)
    yield* refreshMenu
  }).pipe(Effect.withSpan('desktop.menuBar.configure'))

  return DesktopMenuBar.of({
    configure,
    setState: (state) => Ref.set(stateRef, state).pipe(Effect.andThen(refreshMenu)),
  })
})

export const layer = Layer.effect(DesktopMenuBar, make)
