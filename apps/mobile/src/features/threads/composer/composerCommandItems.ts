// apps/mobile/src/features/threads/composer/composerCommandItems.ts
// search and group mobile commands and resolve their insertion text

import {
  CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES,
  type CollaborationMode,
  type ProjectSearchEntriesResult,
  type ServerProvider,
  type ServerProviderSkill,
} from '@t3tools/contracts'
import {
  serializeComposerFileLink,
  type ComposerTrigger,
  type ComposerTriggerKind,
} from '@t3tools/shared/composerTrigger'
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from '@t3tools/shared/searchRanking'
import type { ComposerCommandItem } from './ComposerCommandPopover'
import { filterModelOptions, type ModelOption } from '../../../lib/modelOptions'

type ComposerCommandGroup = {
  readonly id: string
  readonly label: string | null
  readonly items: ReadonlyArray<ComposerCommandItem>
}

export function buildMobileComposerCommandItems(input: {
  readonly trigger: ComposerTrigger | null
  readonly selectedProviderStatus: ServerProvider | null
  readonly modelOptions: ReadonlyArray<ModelOption>
  readonly interactionMode: CollaborationMode
  readonly hasThread: boolean
  readonly pathEntries: ProjectSearchEntriesResult['entries']
}): ComposerCommandItem[]
{
  const { trigger, selectedProviderStatus } = input
  if (!trigger) return []
  const providerSkills = (selectedProviderStatus?.skills ?? []).filter(
    (skill) => skill.name.toLowerCase() !== 'orchestrate',
  )

  if (trigger.kind === 'slash-command')
  {
    const query = trigger.query.toLowerCase()
    const capabilities =
      selectedProviderStatus?.capabilities ?? CONSERVATIVE_PROVIDER_RUNTIME_CAPABILITIES
    const supportsPlan = capabilities.supportedInteractionModes.includes('plan')
    const supportsOrchestrate =
      capabilities.orchestrateInstructionDelivery !== 'unsupported' &&
      capabilities.orchestrateBaseModes.includes(input.interactionMode.baseMode)
    const builtIn = [
      { command: 'model', description: 'Switch model' },
      { command: 'plan', description: 'Switch to plan mode' },
      { command: 'orchestrate', description: 'Enable orchestration' },
      { command: 'default', description: 'Switch to default mode' },
    ]
      .filter(
        (item) =>
          item.command.includes(query) &&
          (item.command !== 'plan' || supportsPlan) &&
          (item.command !== 'orchestrate' || supportsOrchestrate),
      )
      .map((item) => ({
        ...item,
        id: `cmd:${item.command}`,
        type: 'slash-command' as const,
        label: `/${item.command}`,
      }))
    const collidingSkillNames = new Set(
      providerSkills.filter((skill) => skill.enabled).map((skill) => skill.name.toLowerCase()),
    )
    const providerCommands: ComposerCommandItem[] = []
    for (const command of selectedProviderStatus?.slashCommands ?? [])
    {
      if (collidingSkillNames.has(command.name.toLowerCase())) continue
      if (!command.name.toLowerCase().includes(query)) continue
      // feedback for Codex needs the session and logs of an existing thread
      if (
        !input.hasThread &&
        selectedProviderStatus?.driver === 'codex' &&
        command.name === 'feedback'
      )
      {
        continue
      }
      providerCommands.push({
        id: `pcmd:${command.name}`,
        type: 'provider-slash-command',
        command,
        label: `/${command.name}`,
        description: command.description ?? '',
      })
    }
    return [
      ...builtIn,
      ...providerCommands,
      ...searchMobileComposerSkills(providerSkills, trigger.query),
    ]
  }

  if (trigger.kind === 'slash-model')
  {
    return filterModelOptions(input.modelOptions, trigger.query).map((option) => ({
      id: `model:${option.key}`,
      type: 'model',
      selection: option.selection,
      label: option.label,
      description: option.subtitle,
    }))
  }
  if (trigger.kind === 'skill')
  {
    return searchMobileComposerSkills(providerSkills, trigger.query)
  }
  if (trigger.kind === 'path')
  {
    return input.pathEntries.map((entry) =>
    {
      const parts = entry.path.split('/')
      return {
        id: `path:${entry.path}`,
        type: 'path',
        path: entry.path,
        kind: entry.kind,
        label: parts[parts.length - 1] ?? entry.path,
        description: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
      }
    })
  }
  return []
}

export function searchMobileComposerSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  query: string,
): ComposerCommandItem[]
{
  const enabledSkills = skills.filter((s) => s.enabled)
  const normalizedQuery = normalizeSearchQuery(query, {
    trimLeadingPattern: /^\$+/,
  })

  if (!normalizedQuery)
  {
    return enabledSkills.slice(0, 20).map((skill) => ({
      id: `skill:${skill.name}`,
      type: 'skill' as const,
      skill,
      label: skill.displayName ?? skill.name,
      description: skill.shortDescription ?? skill.description ?? '',
    }))
  }

  const ranked: Array<{
    item: (typeof enabledSkills)[number]
    score: number
    tieBreaker: string
  }> = []
  for (const skill of enabledSkills)
  {
    const displayLabel = (skill.displayName ?? skill.name).toLowerCase()
    const scores = [
      scoreQueryMatch({
        value: skill.name.toLowerCase(),
        query: normalizedQuery,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: ['-', '_', '/'],
      }),
      scoreQueryMatch({
        value: displayLabel,
        query: normalizedQuery,
        exactBase: 1,
        prefixBase: 3,
        boundaryBase: 5,
        includesBase: 7,
        fuzzyBase: 110,
      }),
      scoreQueryMatch({
        value: skill.shortDescription?.toLowerCase() ?? '',
        query: normalizedQuery,
        exactBase: 20,
        prefixBase: 22,
        boundaryBase: 24,
        includesBase: 26,
      }),
      scoreQueryMatch({
        value: skill.description?.toLowerCase() ?? '',
        query: normalizedQuery,
        exactBase: 30,
        prefixBase: 32,
        boundaryBase: 34,
        includesBase: 36,
      }),
    ].filter((s): s is number => s !== null)

    if (scores.length > 0)
    {
      insertRankedSearchResult(
        ranked,
        {
          item: skill,
          score: Math.min(...scores),
          tieBreaker: `${displayLabel}\u0000${skill.name}`,
        },
        20,
      )
    }
  }

  return ranked.map(({ item: skill }) => ({
    id: `skill:${skill.name}`,
    type: 'skill' as const,
    skill,
    label: skill.displayName ?? skill.name,
    description: skill.shortDescription ?? skill.description ?? '',
  }))
}

export function groupCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
  triggerKind: ComposerTriggerKind | null,
): ComposerCommandGroup[]
{
  if (triggerKind === 'skill')
  {
    return items.length > 0 ? [{ id: 'skills', label: 'Skills', items }] : []
  }
  if (triggerKind === 'path')
  {
    return items.length > 0 ? [{ id: 'files', label: 'Files', items }] : []
  }
  if (triggerKind === 'slash-model')
  {
    return items.length > 0 ? [{ id: 'models', label: 'Models', items }] : []
  }
  if (triggerKind !== 'slash-command')
  {
    return items.length > 0 ? [{ id: 'default', label: null, items }] : []
  }

  const builtInItems = items.filter((item) => item.type === 'slash-command')
  const providerItems = items.filter((item) => item.type === 'provider-slash-command')
  const skillItems = items.filter((item) => item.type === 'skill')

  const groups: ComposerCommandGroup[] = []
  if (builtInItems.length > 0)
  {
    groups.push({ id: 'built-in', label: 'Commands', items: builtInItems })
  }
  if (providerItems.length > 0)
  {
    groups.push({ id: 'provider', label: 'Provider', items: providerItems })
  }
  if (skillItems.length > 0)
  {
    groups.push({ id: 'skills', label: 'Skills', items: skillItems })
  }
  return groups
}

export function composerCommandReplacement(item: ComposerCommandItem): string
{
  let replacement = ''
  if (item.type === 'path')
  {
    replacement = `${serializeComposerFileLink(item.path)} `
  }
  else if (item.type === 'skill')
  {
    replacement = `$${item.skill.name} `
  }
  else if (item.type === 'slash-command')
  {
    replacement = `/${item.command} `
  }
  else if (item.type === 'provider-slash-command')
  {
    replacement = `/${item.command.name} `
  }
  return replacement
}
