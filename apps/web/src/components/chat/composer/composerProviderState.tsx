// apps/web/src/components/chat/composer/composerProviderState.tsx
// render composer provider traits controls

import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from '@t3tools/contracts'
import type { ReactNode } from 'react'

import type { DraftId } from '../../../composerDraftStore'
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  type ComposerPromptInjectionState,
  type ComposerProviderState,
  type ComposerProviderStateInput,
} from '../../../lib/composerProviderState'
import { shouldRenderTraitsControls, TraitsMenuContent, TraitsPicker } from './TraitsPicker'

export {
  getComposerPromptInjectionState,
  getComposerProviderState,
  type ComposerPromptInjectionState,
  type ComposerProviderState,
  type ComposerProviderStateInput,
}

type TraitsRenderInput = {
  provider: ProviderDriverKind
  instanceId?: ProviderInstanceId
  threadRef?: ScopedThreadRef
  draftId?: DraftId
  model: string
  models: ReadonlyArray<ServerProviderModel>
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined
  prompt: string
  onPromptChange: (prompt: string) => void
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode
{
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    prompt,
    onPromptChange,
  } = input
  const hasTarget = threadRef !== undefined || draftId !== undefined
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({ provider, models, model, modelOptions, prompt })
  )
  {
    return null
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
      prompt={prompt}
      onPromptChange={onPromptChange}
    />
  )
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode
{
  return renderTraitsControl(TraitsMenuContent, input)
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode
{
  return renderTraitsControl(TraitsPicker, input)
}
