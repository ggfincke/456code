// apps/desktop/src/electron/ElectronTray.ts
// owns scoped Electron tray resources

import { HostProcessPlatform } from '@t3tools/shared/hostProcess'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'

import * as Electron from 'electron'

const ElectronTrayOperation = Schema.Literals(['create', 'set-context-menu'])

export class ElectronTrayOperationError extends Schema.TaggedErrorClass<ElectronTrayOperationError>()(
  'ElectronTrayOperationError',
  {
    operation: ElectronTrayOperation,
    platform: Schema.String,
    iconPath: Schema.String,
    itemCount: Schema.Finite,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Electron tray operation ${JSON.stringify(this.operation)} failed on ${this.platform}.`
  }
}

export interface ElectronTrayHandle
{
  readonly setContextMenu: (
    template: readonly Electron.MenuItemConstructorOptions[],
  ) => Effect.Effect<void, ElectronTrayOperationError>
}

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    readonly create: (input: {
      readonly iconPath: string
      readonly toolTip: string
    }) => Effect.Effect<ElectronTrayHandle, ElectronTrayOperationError, Scope.Scope>
  }
>()('@t3tools/desktop/electron/ElectronTray')
{}

export const make = Effect.gen(function* ()
{
  const platform = yield* HostProcessPlatform

  return ElectronTray.of({
    create: Effect.fn('desktop.electron.tray.create')(function* (input)
    {
      const tray = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
          {
            const icon = Electron.nativeImage.createFromPath(input.iconPath)
            if (icon.isEmpty())
            {
              throw new Error('The tray icon is empty.')
            }
            icon.setTemplateImage(true)
            const createdTray = new Electron.Tray(icon)
            createdTray.setToolTip(input.toolTip)
            return createdTray
          },
          catch: (cause) =>
            new ElectronTrayOperationError({
              operation: 'create',
              platform,
              iconPath: input.iconPath,
              itemCount: 0,
              cause,
            }),
        }),
        (createdTray) =>
          Effect.sync(() =>
          {
            try
            {
              createdTray.destroy()
            }
            catch
            {
              // electron is already tearing down the native status item
            }
          }),
      )

      return {
        setContextMenu: (template) =>
          Effect.try({
            try: () =>
            {
              tray.setContextMenu(Electron.Menu.buildFromTemplate([...template]))
            },
            catch: (cause) =>
              new ElectronTrayOperationError({
                operation: 'set-context-menu',
                platform,
                iconPath: input.iconPath,
                itemCount: template.length,
                cause,
              }),
          }),
      }
    }),
  })
})

export const layer = Layer.effect(ElectronTray, make)
