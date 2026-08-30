// apps/web/src/hooks/useDefaultTheme.ts
// adopt each live environment default once without overriding later human choices

import { useAtomValue } from '@effect/atom-react'
import { useEffect, useRef } from 'react'

import { primaryEnvironmentIdAtom } from '../state/primaryEnvironment'
import { primaryServerConfigSourceAtom, primaryServerSettingsAtom } from '../state/server'
import { adoptEnvironmentTheme, isThemeAvailable, useTheme } from './useTheme'

const STORAGE_PREFIX = '456code:default-theme-consumed:v1:'
const consumedGenerations = new Map<string, string>()

export function defaultThemeGeneration(theme: string, setAt: string): string
{
  return setAt.length > 0 ? `${theme}@${setAt}` : theme
}

function readConsumedGeneration(environmentId: string): string | null
{
  const consumed = consumedGenerations.get(environmentId)
  if (consumed !== undefined) return consumed
  try
  {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${environmentId}`)
  }
  catch
  {
    return null
  }
}

function consumeGeneration(environmentId: string, generation: string): void
{
  consumedGenerations.set(environmentId, generation)
  try
  {
    window.localStorage.setItem(`${STORAGE_PREFIX}${environmentId}`, generation)
  }
  catch
  {
    // the in-memory guard still prevents replay when storage is unavailable
  }
}

export function useDefaultThemeAdoption(): void
{
  const environmentId = useAtomValue(primaryEnvironmentIdAtom)
  const source = useAtomValue(primaryServerConfigSourceAtom)
  const { defaultTheme, defaultThemeSetAt } = useAtomValue(primaryServerSettingsAtom)
  const { environmentThemes, userSelectionRevision } = useTheme()
  const pending = useRef<{
    environmentId: string
    generation: string
    userSelectionRevision: number
  } | null>(null)

  useEffect(() =>
  {
    if (environmentId === null || source !== 'live' || defaultTheme.length === 0)
    {
      pending.current = null
      return
    }
    const generation = defaultThemeGeneration(defaultTheme, defaultThemeSetAt)
    if (readConsumedGeneration(environmentId) === generation)
    {
      pending.current = null
      return
    }
    if (
      pending.current?.environmentId === environmentId &&
      pending.current.generation === generation &&
      pending.current.userSelectionRevision !== userSelectionRevision
    )
    {
      consumeGeneration(environmentId, generation)
      pending.current = null
      return
    }
    pending.current = { environmentId, generation, userSelectionRevision }
    if (isThemeAvailable(defaultTheme) && adoptEnvironmentTheme(defaultTheme))
    {
      consumeGeneration(environmentId, generation)
      pending.current = null
    }
  }, [
    environmentId,
    source,
    defaultTheme,
    defaultThemeSetAt,
    environmentThemes,
    userSelectionRevision,
  ])
}
