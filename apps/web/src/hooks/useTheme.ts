// apps/web/src/hooks/useTheme.ts
// owns stored theme preference and browser/desktop synchronization
import { EnvironmentThemeId, type DesktopBridge, type DesktopTheme } from '@t3tools/contracts'
import { safeErrorLogAttributes } from '@t3tools/client-runtime/errors'
import type { ThemeDefinition } from '@t3tools/shared/themePalettes'
import * as Equal from 'effect/Equal'
import * as Schema from 'effect/Schema'
import { useCallback, useEffect, useSyncExternalStore } from 'react'

import { applyThemeColors } from '../themePalette'

const ThemePreference = Schema.Union([
  Schema.Literals(['light', 'dark', 'ocean', 'system']),
  EnvironmentThemeId,
])
const isThemePreference = Schema.is(ThemePreference)
type Theme = typeof ThemePreference.Type
type ThemeSnapshot = {
  theme: Theme
  systemDark: boolean
  environmentThemes: ReadonlyArray<ThemeDefinition>
  userSelectionRevision: number
}

type DesktopThemeBridge = Pick<DesktopBridge, 'setTheme'>

const STORAGE_KEY = '456code:theme'
const MEDIA_QUERY = '(prefers-color-scheme: dark)'
const EMPTY_ENVIRONMENT_THEMES: ReadonlyArray<ThemeDefinition> = []
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: 'system',
  systemDark: false,
  environmentThemes: EMPTY_ENVIRONMENT_THEMES,
  userSelectionRevision: 0,
}
const THEME_COLOR_META_NAME = 'theme-color'
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`

export class ThemeStorageError extends Schema.TaggedErrorClass<ThemeStorageError>()(
  'ThemeStorageError',
  {
    operation: Schema.Literals(['read', 'write']),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError)

export class DesktopThemeSyncError extends Schema.TaggedErrorClass<DesktopThemeSyncError>()(
  'DesktopThemeSyncError',
  {
    theme: ThemePreference,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`
  }
}

export const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError)

let listeners: Array<() => void> = []
let lastSnapshot: ThemeSnapshot | null = null
let lastDesktopTheme: DesktopTheme | null = null
let lastAppliedTheme: ThemeSnapshot | null = null
let themeStorageReadFailure: ThemeStorageError | null = null
let environmentThemes = EMPTY_ENVIRONMENT_THEMES
let userSelectionRevision = 0

export function isThemeAvailable(theme: string): boolean
{
  return (
    theme === 'system' ||
    theme === 'light' ||
    theme === 'dark' ||
    theme === 'ocean' ||
    environmentThemes.some((definition) => definition.id === theme)
  )
}

export function setEnvironmentThemes(themes: ReadonlyArray<ThemeDefinition>): void
{
  if (Equal.equals(environmentThemes, themes)) return
  environmentThemes = themes
  applyTheme(getStored(), true)
  emitChange()
}

function resolvedAppearance(theme: Theme, systemDark = getSystemDark()): 'light' | 'dark'
{
  if (theme === 'light') return 'light'
  if (theme === 'dark' || theme === 'ocean') return 'dark'
  return (
    environmentThemes.find((definition) => definition.id === theme)?.appearance ??
    (systemDark ? 'dark' : 'light')
  )
}

function desktopThemePreference(theme: Theme): DesktopTheme
{
  if (theme === 'light' || theme === 'dark' || theme === 'system') return theme
  if (theme === 'ocean') return 'dark'
  return environmentThemes.find((definition) => definition.id === theme)?.appearance ?? 'system'
}

function emitChange()
{
  for (const listener of listeners) listener()
}

function getSystemDark()
{
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(MEDIA_QUERY).matches
  )
}

export function readThemePreference(): Theme
{
  if (typeof window === 'undefined') return DEFAULT_THEME_SNAPSHOT.theme
  let raw: string | null
  try
  {
    raw = window.localStorage.getItem(STORAGE_KEY)
  }
  catch (cause)
  {
    throw new ThemeStorageError({
      operation: 'read',
      storageKey: STORAGE_KEY,
      cause,
    })
  }
  if (raw !== null && isThemePreference(raw)) return raw
  return DEFAULT_THEME_SNAPSHOT.theme
}

export function writeThemePreference(theme: Theme): void
{
  if (typeof window === 'undefined') return
  try
  {
    window.localStorage.setItem(STORAGE_KEY, theme)
    themeStorageReadFailure = null
  }
  catch (cause)
  {
    throw new ThemeStorageError({
      operation: 'write',
      storageKey: STORAGE_KEY,
      theme,
      cause,
    })
  }
}

function getStored(): Theme
{
  if (themeStorageReadFailure !== null)
  {
    return DEFAULT_THEME_SNAPSHOT.theme
  }
  try
  {
    return readThemePreference()
  }
  catch (cause)
  {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: 'read',
          storageKey: STORAGE_KEY,
          cause,
        })
    themeStorageReadFailure = error
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    })
    return DEFAULT_THEME_SNAPSHOT.theme
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement
{
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR)
  if (element)
  {
    return element
  }

  element = document.createElement('meta')
  element.name = THEME_COLOR_META_NAME
  element.setAttribute('data-dynamic-theme-color', 'true')
  document.head.append(element)
  return element
}

function normalizeThemeColor(value: string | null | undefined): string | null
{
  const normalizedValue = value?.trim().toLowerCase()
  if (
    !normalizedValue ||
    normalizedValue === 'transparent' ||
    normalizedValue === 'rgba(0, 0, 0, 0)' ||
    normalizedValue === 'rgba(0 0 0 / 0)'
  )
  {
    return null
  }

  return value?.trim() ?? null
}

function resolveBrowserChromeSurface(): HTMLElement
{
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  )
}

export function syncBrowserChromeTheme()
{
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  )
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor)
  const backgroundColor = surfaceColor ?? fallbackColor
  if (!backgroundColor) return

  document.documentElement.style.backgroundColor = backgroundColor
  document.body.style.backgroundColor = backgroundColor
  ensureThemeColorMetaTag().setAttribute('content', backgroundColor)
}

function applyTheme(theme: Theme, suppressTransitions = false)
{
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const systemDark = getSystemDark()
  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.systemDark === systemDark &&
    lastAppliedTheme.environmentThemes === environmentThemes
  )
  {
    syncDesktopTheme(theme)
    return
  }

  if (suppressTransitions)
  {
    document.documentElement.classList.add('no-transitions')
  }
  const isOcean = theme === 'ocean'
  const isDark = resolvedAppearance(theme, systemDark) === 'dark'
  document.documentElement.classList.toggle('ocean', isOcean)
  document.documentElement.classList.toggle('dark', isDark)
  applyThemeColors(environmentThemes.find((definition) => definition.id === theme)?.colors ?? null)
  lastAppliedTheme = { theme, systemDark, environmentThemes, userSelectionRevision }
  syncBrowserChromeTheme()
  syncDesktopTheme(theme)
  if (suppressTransitions)
  {
    // force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight
    requestAnimationFrame(() =>
    {
      document.documentElement.classList.remove('no-transitions')
    })
  }
}

export async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
): Promise<void>
{
  try
  {
    await bridge.setTheme(desktopThemePreference(theme))
  }
  catch (cause)
  {
    throw new DesktopThemeSyncError({ theme, cause })
  }
}

export function syncDesktopTheme(theme: Theme)
{
  if (typeof window === 'undefined') return
  const bridge = window.desktopBridge
  const desktopTheme = desktopThemePreference(theme)
  if (!bridge || typeof bridge.setTheme !== 'function' || lastDesktopTheme === desktopTheme)
  {
    return
  }

  lastDesktopTheme = desktopTheme
  void syncDesktopThemePreference(bridge, theme).catch((cause: unknown) =>
  {
    const error = isDesktopThemeSyncError(cause)
      ? cause
      : new DesktopThemeSyncError({ theme, cause })
    console.error(error.message, {
      theme: error.theme,
      ...safeErrorLogAttributes(error),
    })
    if (lastDesktopTheme === desktopTheme)
    {
      lastDesktopTheme = null
    }
  })
}

// apply immediately on module load to prevent flash
if (typeof document !== 'undefined' && typeof window !== 'undefined')
{
  applyTheme(getStored())
}

function getSnapshot(): ThemeSnapshot
{
  if (typeof window === 'undefined') return DEFAULT_THEME_SNAPSHOT
  const theme = getStored()
  const systemDark = getSystemDark()

  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.environmentThemes === environmentThemes &&
    lastSnapshot.userSelectionRevision === userSelectionRevision
  )
  {
    return lastSnapshot
  }

  lastSnapshot = { theme, systemDark, environmentThemes, userSelectionRevision }
  return lastSnapshot
}

function getServerSnapshot()
{
  return DEFAULT_THEME_SNAPSHOT
}

function subscribe(listener: () => void): () => void
{
  if (typeof window === 'undefined') return () =>
  {}
  listeners.push(listener)

  // listen for system preference changes
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(MEDIA_QUERY) : null
  const handleChange = () =>
  {
    applyTheme(getStored(), true)
    emitChange()
  }
  mq?.addEventListener('change', handleChange)

  // listen for storage changes from other tabs
  const handleStorage = (e: StorageEvent) =>
  {
    if (e.key === STORAGE_KEY)
    {
      themeStorageReadFailure = null
      userSelectionRevision += 1
      applyTheme(getStored(), true)
      emitChange()
    }
  }
  window.addEventListener('storage', handleStorage)

  return () =>
  {
    listeners = listeners.filter((l) => l !== listener)
    mq?.removeEventListener('change', handleChange)
    window.removeEventListener('storage', handleStorage)
  }
}

function commitThemePreference(next: Theme, human: boolean): boolean
{
  if (
    typeof window === 'undefined' ||
    !isThemePreference(next) ||
    (!isThemeAvailable(next) && (!human || next !== getStored()))
  )
    return false
  try
  {
    writeThemePreference(next)
  }
  catch (cause)
  {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({ operation: 'write', storageKey: STORAGE_KEY, theme: next, cause })
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      theme: next,
      ...safeErrorLogAttributes(error),
    })
    return false
  }
  if (human) userSelectionRevision += 1
  applyTheme(next, true)
  emitChange()
  return true
}

export function adoptEnvironmentTheme(next: string): boolean
{
  return isThemePreference(next) && commitThemePreference(next, false)
}

export function useTheme()
{
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const theme = snapshot.theme
  const resolvedTheme = resolvedAppearance(theme, snapshot.systemDark)
  const setTheme = useCallback((next: Theme) => commitThemePreference(next, true), [])

  // keep DOM in sync on mount/change
  useEffect(() =>
  {
    applyTheme(theme)
  }, [theme, snapshot.environmentThemes])

  return {
    theme,
    setTheme,
    resolvedTheme,
    environmentThemes: snapshot.environmentThemes,
    userSelectionRevision: snapshot.userSelectionRevision,
  } as const
}
