// apps/desktop/src/electron/ElectronNotifications.ts
// owns raw Electron notification & app badge calls

import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import * as Electron from 'electron'

const ElectronNotificationOperation = Schema.Literals([
  'show',
  'set-badge-count',
  'set-overlay-badge',
])

export class ElectronNotificationOperationError extends Schema.TaggedErrorClass<ElectronNotificationOperationError>()(
  'ElectronNotificationOperationError',
  {
    operation: ElectronNotificationOperation,
    platform: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Electron notification operation ${JSON.stringify(this.operation)} failed on ${this.platform}.`
  }
}

export interface ElectronNotificationInput
{
  readonly title: string
  readonly body: string
  readonly subtitle?: string | undefined
  readonly onClick: () => void
}

export interface ElectronOverlayBadgeInput
{
  readonly window: Electron.BrowserWindow
  // null clears the overlay; anything else is a path to an image on disk
  readonly iconPath: string | null
  readonly description: string
}

export class ElectronNotifications extends Context.Service<
  ElectronNotifications,
  {
    readonly isSupported: Effect.Effect<boolean>
    readonly show: (
      input: ElectronNotificationInput,
    ) => Effect.Effect<void, ElectronNotificationOperationError>
    // resolves to whether Electron accepted the badge, which is false on the
    // platforms & desktops that do not implement it
    readonly setBadgeCount: (
      count: number,
    ) => Effect.Effect<boolean, ElectronNotificationOperationError>
    readonly setOverlayBadge: (
      input: ElectronOverlayBadgeInput,
    ) => Effect.Effect<void, ElectronNotificationOperationError>
  }
>()('@t3tools/desktop/electron/ElectronNotifications')
{}

export const make = Effect.gen(function* ()
{
  const platform = yield* HostProcessPlatform

  return ElectronNotifications.of({
    isSupported: Effect.sync(() => Electron.Notification.isSupported()),
    show: (input) =>
      Effect.try({
        try: () =>
        {
          const notification = new Electron.Notification({
            title: input.title,
            body: input.body,
            ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
          })
          // the click handler has to be attached before show(): a banner the
          // user clicks immediately would otherwise do nothing, which is the
          // whole point of raising it.
          notification.on('click', input.onClick)
          notification.show()
        },
        catch: (cause) =>
          new ElectronNotificationOperationError({ operation: 'show', platform, cause }),
      }),
    // documented on linux & darwin only; elsewhere Electron ignores it. A
    // count of 0 is what clears the badge, so callers must keep calling this
    // as attention drops rather than only when it rises. The boolean it
    // returns is surfaced so a refusal stops being invisible.
    setBadgeCount: (count) =>
      Effect.try({
        try: () => Electron.app.setBadgeCount(count),
        catch: (cause) =>
          new ElectronNotificationOperationError({
            operation: 'set-badge-count',
            platform,
            cause,
          }),
      }),
    // windows has no app-level badge; the taskbar button carries a small
    // overlay image instead, which is why this takes a rasterized icon rather
    // than a number. A null path clears it, and an image that failed to decode
    // clears rather than sets, mirroring the empty-icon check in ElectronTray.
    setOverlayBadge: (input) =>
      Effect.try({
        try: () =>
        {
          if (input.window.isDestroyed())
          {
            return
          }
          const icon =
            input.iconPath === null ? null : Electron.nativeImage.createFromPath(input.iconPath)
          if (icon === null || icon.isEmpty())
          {
            input.window.setOverlayIcon(null, '')
            return
          }
          input.window.setOverlayIcon(icon, input.description)
        },
        catch: (cause) =>
          new ElectronNotificationOperationError({
            operation: 'set-overlay-badge',
            platform,
            cause,
          }),
      }),
  })
})

export const layer = Layer.effect(ElectronNotifications, make)
