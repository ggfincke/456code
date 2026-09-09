// apps/web/src/lib/composerProviderState.ts
// derive composer provider selection state

import {
  type ModelCapabilities,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from '@t3tools/contracts'
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from '@t3tools/shared/model'

import { getProviderModelCapabilities } from '../providerModels'

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind
  model: string
  models: ReadonlyArray<ServerProviderModel>
  promptInjectionState?: ComposerPromptInjectionState
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined
}

export type ComposerPromptInjectionState = 'none' | 'ultrathink'

export type ComposerProviderState = {
  provider: ProviderDriverKind
  promptEffort: string | null
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined
  composerFrameClassName?: string
  composerSurfaceClassName?: string
  modelPickerIconClassName?: string
}

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState
{
  return isClaudeUltrathinkPrompt(prompt) ? 'ultrathink' : 'none'
}

// fast mode is sticky only after an explicit user choice
export function withImplicitFastModeDefault(
  caps: ModelCapabilities,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined
{
  if (modelOptions?.some((selection) => selection.id === 'fastMode'))
  {
    return modelOptions
  }
  const hasFastModeDescriptor = caps.optionDescriptors?.some(
    (descriptor) => descriptor.type === 'boolean' && descriptor.id === 'fastMode',
  )
  if (!hasFastModeDescriptor) return modelOptions ?? undefined
  return [...(modelOptions ?? []), { id: 'fastMode', value: false }]
}

export function resolveComposerOptionSelections(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  provider: ProviderDriverKind,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): {
  caps: ModelCapabilities
  selections: ReadonlyArray<ProviderOptionSelection> | undefined
}
{
  const caps = getProviderModelCapabilities(models, model, provider)
  return { caps, selections: withImplicitFastModeDefault(caps, modelOptions) }
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState
{
  const { provider, model, models, modelOptions, promptInjectionState = 'none' } = input
  if (
    provider === 'opencode' &&
    !models.some((candidate) => candidate.slug === normalizeModelSlug(model, provider))
  )
  {
    return {
      provider,
      promptEffort: null,
      modelOptionsForDispatch: modelOptions?.length ? modelOptions : undefined,
    }
  }
  const { caps, selections } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
  )
  const descriptors = getProviderOptionDescriptors({ caps, selections })
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: 'select' }> =>
      descriptor.type === 'select',
  )
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null)
  const promptEffort = typeof primaryValue === 'string' ? primaryValue : null
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === 'ultrathink'

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: 'ultrathink-frame',
          composerSurfaceClassName: 'shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]',
          modelPickerIconClassName: 'ultrathink-chroma',
        }
      : {}),
  }
}
