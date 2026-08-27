// apps/server/src/provider/acp/CoralAcpSupport.ts
// build and operate Coral's baseline ACP connection

import type { CoralSettings, ProviderInteractionMode, RuntimeMode } from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type * as EffectAcpErrors from 'effect-acp/errors'
import type * as EffectAcpSchema from 'effect-acp/schema'

import { expandHomePath } from '../../pathExpansion.ts'
import * as AcpSessionRuntime from './AcpSessionRuntime.ts'

export const DEFAULT_CORAL_OLLAMA_HOST = 'http://localhost:11434'
export const DEFAULT_CORAL_MODEL = 'qwen3.8:27b-mlx'
export const CORAL_RUNTIME_MODE_CONFIG_ID = 'coral.runtime-mode'

export type CoralRuntimeMode = Extract<RuntimeMode, 'approval-required'>
export type CoralInteractionMode = Extract<ProviderInteractionMode, 'default'>

export function isCoralRuntimeMode(value: RuntimeMode): value is CoralRuntimeMode
{
  return value === 'approval-required'
}

type CoralAcpRuntimeSettings = Pick<CoralSettings, 'binaryPath' | 'homePath' | 'ollamaHost'>

export interface CoralAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  'authMethodId' | 'clientCapabilities' | 'continuationFallback' | 'spawn'
>
{
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner['Service']
  readonly coralSettings: CoralAcpRuntimeSettings | null | undefined
  readonly environment?: NodeJS.ProcessEnv
  readonly model?: string | null | undefined
}

export interface CoralAcpModel
{
  readonly slug: string
  readonly name: string
  readonly isCurrent: boolean
}

export function normalizeCoralOllamaHost(value: string | null | undefined): string
{
  const candidate = value?.trim() || DEFAULT_CORAL_OLLAMA_HOST
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
  {
    throw new TypeError('Coral Ollama host must use http or https.')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export function buildCoralAcpEnvironment(
  coralSettings: Pick<CoralSettings, 'homePath'> | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv
{
  const homePath = coralSettings?.homePath.trim()
  return {
    ...environment,
    ...(homePath ? { CORAL_HOME: expandHomePath(homePath) } : {}),
  }
}

export function buildCoralAcpSpawnInput(
  coralSettings: Pick<CoralSettings, 'binaryPath' | 'ollamaHost'> | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  model?: string | null,
): AcpSessionRuntime.AcpSpawnInput
{
  const selectedModel = model?.trim()
  return {
    command: coralSettings?.binaryPath || 'coral',
    args: [
      'acp',
      '--host',
      normalizeCoralOllamaHost(coralSettings?.ollamaHost),
      ...(selectedModel ? ['--model', selectedModel] : []),
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  }
}

export function applyCoralAcpRuntimeMode<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime['Service'], 'setConfigOption'>
  readonly runtimeMode: CoralRuntimeMode
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E
}): Effect.Effect<void, E>
{
  return input.runtime
    .setConfigOption(CORAL_RUNTIME_MODE_CONFIG_ID, input.runtimeMode)
    .pipe(Effect.mapError(input.mapError), Effect.asVoid)
}

export function applyCoralAcpInteractionMode<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime['Service'], 'setMode'>
  readonly interactionMode: CoralInteractionMode
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E
}): Effect.Effect<void, E>
{
  return input.runtime
    .setMode(input.interactionMode)
    .pipe(Effect.mapError(input.mapError), Effect.asVoid)
}

export const makeCoralAcpRuntime = (
  input: CoralAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime['Service'],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* ()
  {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        continuationFallback: 'reject',
        spawn: buildCoralAcpSpawnInput(
          input.coralSettings,
          input.cwd,
          input.environment,
          input.model,
        ),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    )
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    )
  })

function flattenSelectOptions(
  option: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<{ readonly value: string; readonly name: string }>
{
  if (option.type !== 'select') return []
  return option.options.flatMap((entry) =>
    'value' in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((nested) => ({
          value: nested.value.trim(),
          name: nested.name.trim(),
        })),
  )
}

export function coralModelsFromSessionSetup(sessionSetupResult: {
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null
}): ReadonlyArray<CoralAcpModel>
{
  const modelOption = sessionSetupResult.configOptions?.find(
    (option) => option.id.trim() === 'model' && option.type === 'select',
  )
  if (!modelOption || modelOption.type !== 'select') return []
  const currentModel = modelOption.currentValue?.trim()
  const seen = new Set<string>()
  return flattenSelectOptions(modelOption).flatMap((model) =>
  {
    if (!model.value || seen.has(model.value)) return []
    seen.add(model.value)
    return [
      {
        slug: model.value,
        name: model.name || model.value,
        isCurrent: model.value === currentModel,
      },
    ]
  })
}

export function currentCoralModelFromSessionSetup(sessionSetupResult: {
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null
}): string | undefined
{
  return coralModelsFromSessionSetup(sessionSetupResult).find((model) => model.isCurrent)?.slug
}

export function applyCoralAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime['Service'], 'setModel'>
  readonly currentModel: string | undefined
  readonly requestedModel: string | null | undefined
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E
}): Effect.Effect<string | undefined, E>
{
  const requestedModel = input.requestedModel?.trim()
  if (!requestedModel || requestedModel === input.currentModel)
  {
    return Effect.succeed(input.currentModel)
  }
  return input.runtime
    .setModel(requestedModel)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModel))
}
