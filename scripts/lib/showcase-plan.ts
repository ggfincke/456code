// scripts/lib/showcase-plan.ts
// parses mobile showcase CLI args and plans capture sets

import type {
  ShowcaseAppearance,
  ShowcaseConfig,
  ShowcaseDevice,
  ShowcaseScene,
} from '../mobile-showcase.config.ts'
import { SHOWCASE_SCENES } from '../mobile-showcase.config.ts'
import { SHOWCASE_TERMINAL_ID, SHOWCASE_THREAD_ID } from '../mobile-showcase-environment.ts'

export const APP_SCHEME = 'code456-dev'

interface NetworkAddress
{
  readonly address: string
  readonly family: string
  readonly internal: boolean
}

export function selectLanIpv4Address(addresses: ReadonlyArray<NetworkAddress>): string | null
{
  return (
    addresses.find(
      ({ address, family, internal }) =>
        family === 'IPv4' && !internal && !address.startsWith('169.254.'),
    )?.address ?? null
  )
}

export interface CliOptions
{
  readonly platforms: ReadonlySet<ShowcaseDevice['platform']>
  readonly deviceIds: ReadonlySet<string>
  readonly scenes: ReadonlySet<ShowcaseScene>
  readonly appearances: ReadonlySet<ShowcaseAppearance>
  readonly skipBuild: boolean
  readonly skipMetro: boolean
  readonly keepRunning: boolean
  readonly validateOnly: boolean
  readonly list: boolean
}

export interface ShowcaseCapture
{
  readonly device: ShowcaseDevice
  readonly scenes: ReadonlyArray<ShowcaseScene>
  readonly appearance: ShowcaseAppearance
}

function argumentValue(args: ReadonlyArray<string>, index: number, flag: string): string
{
  const value = args[index + 1]
  if (!value || value.startsWith('--'))
  {
    throw new Error(`${flag} requires a value.`)
  }
  return value
}

export function parseShowcaseCliArgs(args: ReadonlyArray<string>): CliOptions
{
  const platforms = new Set<ShowcaseDevice['platform']>()
  const deviceIds = new Set<string>()
  const scenes = new Set<ShowcaseScene>()
  const appearances = new Set<ShowcaseAppearance>()
  let skipBuild = false
  let skipMetro = false
  let keepRunning = false
  let validateOnly = false
  let list = false

  for (let index = 0; index < args.length; index += 1)
  {
    const argument = args[index]
    if (argument === '--platform')
    {
      const value = argumentValue(args, index, argument)
      if (value !== 'ios')
      {
        throw new Error(`Unsupported platform '${value}'. Use ios.`)
      }
      platforms.add(value)
      index += 1
    }
    else if (argument === '--device')
    {
      deviceIds.add(argumentValue(args, index, argument))
      index += 1
    }
    else if (argument === '--scene')
    {
      const value = argumentValue(args, index, argument)
      if (!SHOWCASE_SCENES.includes(value as ShowcaseScene))
      {
        throw new Error(`Unsupported scene '${value}'. Use ${SHOWCASE_SCENES.join(', ')}.`)
      }
      scenes.add(value as ShowcaseScene)
      index += 1
    }
    else if (argument === '--appearance')
    {
      const value = argumentValue(args, index, argument)
      if (value !== 'light' && value !== 'dark' && value !== 'both')
      {
        throw new Error(`Unsupported appearance '${value}'. Use light, dark, or both.`)
      }
      if (value === 'both')
      {
        appearances.add('light')
        appearances.add('dark')
      }
      else
      {
        appearances.add(value)
      }
      index += 1
    }
    else if (argument === '--skip-build')
    {
      skipBuild = true
    }
    else if (argument === '--skip-metro')
    {
      skipMetro = true
    }
    else if (argument === '--keep-running')
    {
      keepRunning = true
    }
    else if (argument === '--validate-only')
    {
      validateOnly = true
    }
    else if (argument === '--list')
    {
      list = true
    }
    else if (argument === '--help' || argument === '-h')
    {
      list = true
    }
    else
    {
      throw new Error(`Unknown option '${argument}'.`)
    }
  }

  return {
    platforms,
    deviceIds,
    scenes,
    appearances,
    skipBuild,
    skipMetro,
    keepRunning,
    validateOnly,
    list,
  }
}

export function planShowcaseCaptures(
  config: ShowcaseConfig,
  options: Pick<CliOptions, 'platforms' | 'deviceIds' | 'scenes' | 'appearances'>,
): ReadonlyArray<ShowcaseCapture>
{
  const captures = config.devices
    .filter((device) => options.platforms.size === 0 || options.platforms.has(device.platform))
    .filter((device) => options.deviceIds.size === 0 || options.deviceIds.has(device.id))
    .flatMap((device) =>
    {
      const appearances = options.appearances.size === 0 ? [device.appearance] : options.appearances
      return [...appearances].map((appearance) => ({
        device,
        appearance,
        scenes:
          options.scenes.size === 0
            ? device.scenes
            : device.scenes.filter((scene) => options.scenes.has(scene)),
      }))
    })
    .filter((capture) => capture.scenes.length > 0)

  const knownDeviceIds = new Set(config.devices.map((device) => device.id))
  for (const id of options.deviceIds)
  {
    if (!knownDeviceIds.has(id))
    {
      throw new Error(`Unknown device '${id}'. Run with --list to see configured devices.`)
    }
  }
  if (captures.length === 0)
  {
    throw new Error('No captures match the selected platform, device, and scene filters.')
  }
  return captures
}

export function parsePairingCredentialOutput(output: string): string
{
  const jsonStart = output.indexOf('{')
  const jsonEnd = output.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd < jsonStart)
  {
    throw new Error('Pairing credential command did not return JSON.')
  }
  const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as {
    readonly credential?: unknown
  }
  if (typeof parsed.credential !== 'string' || parsed.credential.length === 0)
  {
    throw new Error('Pairing credential command returned no credential.')
  }
  return parsed.credential
}

export function showcaseSceneUrl(scene: ShowcaseScene, environmentId: string): string
{
  if (scene === 'threads') return `${APP_SCHEME}://`
  if (scene === 'environments') return `${APP_SCHEME}://settings/environments`
  const threadPath = `threads/${encodeURIComponent(environmentId)}/${SHOWCASE_THREAD_ID}`
  if (scene === 'thread') return `${APP_SCHEME}://${threadPath}`
  if (scene === 'terminal')
  {
    return `${APP_SCHEME}://${threadPath}/terminal?terminalId=${SHOWCASE_TERMINAL_ID}`
  }
  return `${APP_SCHEME}://${threadPath}/review`
}
