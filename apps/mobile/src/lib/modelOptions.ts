// apps/mobile/src/lib/modelOptions.ts
// build model options

import type { ModelCapabilities, ModelSelection, ServerConfig } from '@t3tools/contracts'
import type { MenuAction } from '@react-native-menu/menu'
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from '@t3tools/shared/model'

export type ModelOption = {
  readonly key: string
  readonly label: string
  readonly subtitle: string
  readonly providerKey: string
  readonly providerLabel: string
  readonly providerDriver: string
  readonly isDefault: boolean
  readonly isLegacy?: boolean
  readonly capabilities: ModelCapabilities | null
  readonly selection: ModelSelection
}

export type ProviderGroup = {
  readonly providerKey: string
  readonly providerLabel: string
  readonly models: ReadonlyArray<ModelOption>
}

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined
  readonly driver: string
  readonly instanceId: string
}): string
{
  let label = provider.displayName
  if (!label)
  {
    if (provider.driver === 'codex') label = 'Codex'
    else if (provider.driver === 'claudeAgent') label = 'Claude'
    else if (provider.driver === 'coral') label = 'Coral'
    else if (provider.driver === 'gemini') label = 'Gemini'
    else if (provider.driver === 'antigravity') label = 'Antigravity'
    else label = provider.instanceId
  }
  return provider.driver === 'antigravity' ? `${label} · Experimental` : label
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection
{
  if (!capabilities)
  {
    return selection
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  )
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      }
}

export function buildModelOptions(
  config: ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption>
{
  const options = new Map<string, ModelOption>()

  for (const provider of config?.providers ?? [])
  {
    if (!provider.enabled || !provider.installed || provider.auth.status === 'unauthenticated')
    {
      continue
    }

    const providerLabel = providerDisplayLabel(provider)
    for (const model of provider.models)
    {
      const key = `${provider.instanceId}:${model.slug}`
      options.set(key, {
        key,
        label: model.name,
        subtitle: provider.driver === 'opencode' ? (model.subProvider ?? '') : providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isDefault: model.isDefault === true,
        ...(model.isLegacy === true && !model.isCustom ? { isLegacy: true } : {}),
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      })
    }
  }

  if (fallbackModelSelection)
  {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`
    const existing = options.get(key)
    if (existing)
    {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      })
    }
    else
    {
      const providerLabel = fallbackModelSelection.instanceId
      const provider = config?.providers.find(
        (entry) => entry.instanceId === fallbackModelSelection.instanceId,
      )
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: (provider?.driver ?? providerLabel) === 'opencode' ? '' : providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: fallbackModelSelection.instanceId,
        isDefault: false,
        capabilities: null,
        selection: fallbackModelSelection,
      })
    }
  }

  return [...options.values()]
}

export function filterModelOptions(
  options: ReadonlyArray<ModelOption>,
  query: string,
): ReadonlyArray<ModelOption>
{
  const normalizedQuery = query.toLowerCase()
  return options.filter((option) =>
    `${option.label} ${option.providerLabel} ${option.subtitle}`
      .toLowerCase()
      .includes(normalizedQuery),
  )
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup>
{
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>()
  for (const option of options)
  {
    const existing = groups.get(option.providerKey)
    if (existing)
    {
      existing.models.push(option)
    }
    else
    {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      })
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }))
}

export function buildModelMenuActions(
  groups: ReadonlyArray<ProviderGroup>,
  selectedModel: ModelSelection | null,
): MenuAction[]
{
  const isSelected = (option: ModelOption) =>
    option.selection.instanceId === selectedModel?.instanceId &&
    option.selection.model === selectedModel?.model
  const modelAction = (option: ModelOption): MenuAction => ({
    id: `model:${option.key}`,
    title: option.label,
    ...(option.providerDriver === 'opencode' && option.subtitle
      ? { subtitle: option.subtitle }
      : {}),
    state: isSelected(option) ? 'on' : undefined,
  })

  // keep legacy groups beside current models so both remain directly discoverable
  return groups.flatMap((group) =>
  {
    const currentModels = group.models.filter((model) => model.isLegacy !== true)
    const legacyModels = group.models.filter((model) => model.isLegacy === true)
    return [
      ...(currentModels.length > 0
        ? [
            {
              id: `provider:${group.providerKey}`,
              title: group.providerLabel,
              subtitle: currentModels.find(isSelected)?.label,
              subactions: currentModels.map(modelAction),
            },
          ]
        : []),
      ...(legacyModels.length > 0
        ? [
            {
              id: `legacy:${group.providerKey}`,
              title: `${group.providerLabel} · Legacy models`,
              subtitle: legacyModels.find(isSelected)?.label,
              subactions: legacyModels.map(modelAction),
            },
          ]
        : []),
    ]
  })
}
