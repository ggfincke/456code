// apps/desktop/src/window/DesktopNotifications.ts
// raises OS notifications & the app badge for threads wanting attention

import type { DesktopThreadAttention, DesktopThreadAttentionKind } from '@t3tools/contracts'
import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import { truncate } from '@t3tools/shared/String'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'

import * as DesktopAssets from '../app/DesktopAssets.ts'
import { makeComponentLogger } from '../app/DesktopObservability.ts'
import * as ElectronNotifications from '../electron/ElectronNotifications.ts'
import * as ElectronWindow from '../electron/ElectronWindow.ts'
import { buildOpenThreadAction } from './DesktopMenuBar.ts'
import * as DesktopWindow from './DesktopWindow.ts'

const NOTIFICATION_TITLE_MAX_LENGTH = 64
const OVERLAY_BADGE_MAX_COUNT = 9

export class DesktopNotifications extends Context.Service<
  DesktopNotifications,
  {
    readonly notifyThreadAttention: (attention: DesktopThreadAttention) => Effect.Effect<void>
    readonly setAttentionCount: (count: number) => Effect.Effect<void>
  }
>()('@t3tools/desktop/window/DesktopNotifications')
{}

type DesktopNotificationsRuntimeServices = DesktopWindow.DesktopWindow

const {
  logDebug: logNotificationDebug,
  logError: logNotificationError,
  logWarning: logNotificationWarning,
} = makeComponentLogger('desktop-notifications')

// the pre-rendered taskbar overlay image for a count, or null when there is
// nothing to show. Counts above the highest drawn digit collapse onto one
// shared image rather than growing the asset set without end.
function overlayBadgeFileName(count: number): string | null
{
  if (count <= 0)
  {
    return null
  }
  return count > OVERLAY_BADGE_MAX_COUNT ? 'overlay-badge-9-plus.png' : `overlay-badge-${count}.png`
}

function overlayBadgeDescription(count: number): string
{
  return count === 1 ? '1 thread needs attention' : `${count} threads need attention`
}

function notificationTitle(threadTitle: string, kind: DesktopThreadAttentionKind): string
{
  const title = truncate(threadTitle, NOTIFICATION_TITLE_MAX_LENGTH)
  switch (kind)
  {
    case 'needs-approval':
      return `${title} needs approval`
    case 'needs-input':
      return `${title} needs input`
    // the failure case is the one that cost the post-mortem 3.5 hours, so it
    // reads as an ending, not as progress.
    case 'failed':
      return `${title} stopped`
    case 'completed':
      return `${title} finished`
  }
}

export const make = Effect.gen(function* ()
{
  const platform = yield* HostProcessPlatform
  const assets = yield* DesktopAssets.DesktopAssets
  const electronNotifications = yield* ElectronNotifications.ElectronNotifications
  const electronWindow = yield* ElectronWindow.ElectronWindow
  const desktopWindow = yield* DesktopWindow.DesktopWindow
  const badgeRefusalLoggedRef = yield* Ref.make(false)
  const context = yield* Effect.context<DesktopNotificationsRuntimeServices>()
  const runPromise = Effect.runPromiseWith(context)

  // a notification click escapes the Effect runtime, so the services it needs
  // have to be captured here at construction time. Without the captured
  // context the click fails with a missing-service defect that nothing
  // surfaces until a user actually clicks a banner.
  const openThread = (attention: DesktopThreadAttention) =>
  {
    void runPromise(
      desktopWindow.dispatchMenuAction(buildOpenThreadAction(attention)).pipe(
        Effect.annotateLogs({ threadId: attention.threadId }),
        Effect.withSpan('desktop.notifications.openThread'),
        Effect.catchCause((cause) => logNotificationError('notification click failed', { cause })),
      ),
    )
  }

  const notifyThreadAttention = Effect.fn('desktop.notifications.notifyThreadAttention')(function* (
    attention: DesktopThreadAttention,
  )
  {
    if (!(yield* electronNotifications.isSupported))
    {
      return
    }

    // suppress only the thread already in front of the user. Window focus
    // is main-process truth (the renderer's own document.hasFocus lies while
    // a devtools or preview webContents holds focus), and it is combined
    // with the renderer's "this thread is on screen" so a completion in a
    // background thread still notifies while the app is open.
    const window = yield* electronWindow.currentMainOrFirst
    if (
      attention.isViewedThread &&
      Option.isSome(window) &&
      window.value.isVisible() &&
      window.value.isFocused()
    )
    {
      return
    }

    yield* electronNotifications
      .show({
        title: notificationTitle(attention.title, attention.kind),
        body: truncate(attention.projectTitle, NOTIFICATION_TITLE_MAX_LENGTH),
        onClick: () =>
        {
          openThread(attention)
        },
      })
      .pipe(Effect.catch((error) => logNotificationError(error.message, { error })))
  })

  // the overlay is per-BrowserWindow and only the resolved main window gets
  // one, so with two windows open a single taskbar button carries the count.
  // a window opened after the last push stays bare until the next one, which
  // in practice is its own renderer's mount effect.
  const setOverlayBadgeCount = Effect.fn('desktop.notifications.setOverlayBadgeCount')(function* (
    count: number,
  )
  {
    const window = yield* electronWindow.currentMainOrFirst
    if (Option.isNone(window))
    {
      return
    }

    const fileName = overlayBadgeFileName(count)
    let iconPath: string | null = null
    if (fileName !== null)
    {
      const resolved = yield* assets
        .resolveResourcePath(fileName)
        .pipe(
          Effect.catch((error) =>
            logNotificationError(error.message, { error }).pipe(Effect.as(Option.none<string>())),
          ),
        )
      if (Option.isNone(resolved))
      {
        yield* logNotificationWarning('overlay badge image is unavailable', { fileName })
      }
      iconPath = Option.getOrNull(resolved)
    }

    yield* electronNotifications
      .setOverlayBadge({
        window: window.value,
        iconPath,
        description: overlayBadgeDescription(count),
      })
      .pipe(Effect.catch((error) => logNotificationError(error.message, { error })))
  })

  // the count is deliberately NOT gated on desktopNotificationsEnabled: a
  // passive count is not a banner, and this matches what macOS has done here
  // all along. Turning notifications off silences banners, not the badge.
  const setAttentionCount = Effect.fn('desktop.notifications.setAttentionCount')(function* (
    count: number,
  )
  {
    // windows has no app-level badge, and what app.setBadgeCount returns there
    // is not documented, so the overlay path is taken unconditionally rather
    // than after a failed badge attempt.
    if (platform === 'win32')
    {
      yield* setOverlayBadgeCount(count)
      return
    }

    if (platform !== 'darwin' && platform !== 'linux')
    {
      return
    }

    const applied = yield* electronNotifications
      .setBadgeCount(count)
      .pipe(
        Effect.catch((error) =>
          logNotificationError(error.message, { error }).pipe(Effect.as(false)),
        ),
      )
    // linux badges are best-effort: Electron routes them through the Unity
    // launcher DBus API, which most desktops do not implement, so a refusal is
    // a fact about the desktop and not a failure. It is reported once so the
    // log does not fill up with it on every state push.
    if (!applied && platform === 'linux')
    {
      const alreadyLogged = yield* Ref.getAndSet(badgeRefusalLoggedRef, true)
      if (!alreadyLogged)
      {
        yield* logNotificationDebug('the desktop launcher refused the attention badge', { count })
      }
    }
  })

  return DesktopNotifications.of({
    notifyThreadAttention,
    setAttentionCount,
  })
})

export const layer = Layer.effect(DesktopNotifications, make)
