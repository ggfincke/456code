// apps/server/src/provider/acp/GeminiAcpSupport.ts
// build and operate gemini-cli's ACP connection

import type {
  GeminiSettings,
  ProviderInteractionMode,
  ProviderRuntimeCapabilities,
  RuntimeMode,
} from '@t3tools/contracts'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import * as EffectAcpErrors from 'effect-acp/errors'

import * as AcpSessionRuntime from './AcpSessionRuntime.ts'

// gemini-cli advertises this auth method id on ACP `initialize`. The api-key
// id pairs with GEMINI_API_KEY; other login types stay owned by CLI config.
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY'
export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY'
export const GEMINI_CLI_HOME_ENV = 'GEMINI_CLI_HOME'
export const GEMINI_AUTH_METHOD_API_KEY = 'gemini-api-key'

export type GeminiRuntimeMode = Extract<
  RuntimeMode,
  'approval-required' | 'auto-accept-edits' | 'full-access'
>

export function isGeminiRuntimeMode(value: RuntimeMode): value is GeminiRuntimeMode
{
  return value === 'approval-required' || value === 'auto-accept-edits' || value === 'full-access'
}

const GEMINI_ACP_MODE_IDS = {
  approvalRequired: 'default',
  autoAcceptEdits: 'autoEdit',
  fullAccess: 'yolo',
  plan: 'plan',
} as const

interface GeminiSessionModes
{
  readonly modes?: {
    readonly currentModeId?: string | null
    readonly availableModes?: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly description?: string | null
    }>
  } | null
}

export interface GeminiAcpModeSupport
{
  readonly availableModeIds: ReadonlySet<string>
  readonly supportedRuntimeModes: ReadonlyArray<GeminiRuntimeMode>
  readonly supportedInteractionModes: readonly [
    'default',
    ...Array<Extract<ProviderInteractionMode, 'default' | 'plan'>>,
  ]
}

export function geminiModeSupportFromSessionSetup(
  sessionSetupResult: GeminiSessionModes,
): GeminiAcpModeSupport
{
  const availableModeIds = new Set(
    (sessionSetupResult.modes?.availableModes ?? []).map((mode) => mode.id.trim()).filter(Boolean),
  )
  const supportedRuntimeModes: Array<GeminiRuntimeMode> = []
  if (availableModeIds.has(GEMINI_ACP_MODE_IDS.approvalRequired))
  {
    supportedRuntimeModes.push('approval-required')
  }
  if (availableModeIds.has(GEMINI_ACP_MODE_IDS.autoAcceptEdits))
  {
    supportedRuntimeModes.push('auto-accept-edits')
  }
  if (availableModeIds.has(GEMINI_ACP_MODE_IDS.fullAccess))
  {
    supportedRuntimeModes.push('full-access')
  }
  return {
    availableModeIds,
    supportedRuntimeModes,
    supportedInteractionModes: availableModeIds.has(GEMINI_ACP_MODE_IDS.plan)
      ? ['default', 'plan']
      : ['default'],
  }
}

export function geminiAcpModeIdForRuntimeMode(
  runtimeMode: GeminiRuntimeMode,
  availableModeIds: ReadonlySet<string>,
): string | undefined
{
  const modeId =
    runtimeMode === 'approval-required'
      ? GEMINI_ACP_MODE_IDS.approvalRequired
      : runtimeMode === 'auto-accept-edits'
        ? GEMINI_ACP_MODE_IDS.autoAcceptEdits
        : GEMINI_ACP_MODE_IDS.fullAccess
  return availableModeIds.has(modeId) ? modeId : undefined
}

export function geminiAcpModeIdForTurn(input: {
  readonly runtimeMode: GeminiRuntimeMode
  readonly interactionMode: ProviderInteractionMode
  readonly availableModeIds: ReadonlySet<string>
}): string | undefined
{
  return input.interactionMode === 'plan'
    ? input.availableModeIds.has(GEMINI_ACP_MODE_IDS.plan)
      ? GEMINI_ACP_MODE_IDS.plan
      : undefined
    : geminiAcpModeIdForRuntimeMode(input.runtimeMode, input.availableModeIds)
}

export function geminiCapabilitiesFromSessionSetup(
  current: ProviderRuntimeCapabilities,
  sessionSetupResult: GeminiSessionModes,
): ProviderRuntimeCapabilities
{
  const support = geminiModeSupportFromSessionSetup(sessionSetupResult)
  const supportedRuntimeModes: ProviderRuntimeCapabilities['supportedRuntimeModes'] =
    support.supportedRuntimeModes.length > 0
      ? [support.supportedRuntimeModes[0]!, ...support.supportedRuntimeModes.slice(1)]
      : current.supportedRuntimeModes
  const defaultRuntimeMode =
    current.defaultRuntimeMode !== undefined &&
    (supportedRuntimeModes as ReadonlyArray<RuntimeMode>).includes(current.defaultRuntimeMode)
      ? current.defaultRuntimeMode
      : supportedRuntimeModes[0]

  return {
    ...current,
    ...(defaultRuntimeMode === undefined ? {} : { defaultRuntimeMode }),
    supportedRuntimeModes,
    supportedInteractionModes: support.supportedInteractionModes,
    orchestrateBaseModes: support.supportedInteractionModes,
  }
}

type GeminiAcpRuntimeGeminiSettings = Pick<GeminiSettings, 'binaryPath'>

export interface GeminiAcpEnvironmentOptions
{
  readonly apiKeyConfigured?: boolean
  readonly cliHome?: string
  readonly explicitlyConfiguredApiKeyNames?: ReadonlySet<
    typeof GEMINI_API_KEY_ENV | typeof GOOGLE_API_KEY_ENV
  >
}

export interface GeminiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | 'authMethodId'
  | 'clientCapabilities'
  | 'continuationFallback'
  | 'reuseAgentAuthentication'
  | 'spawn'
>
{
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner['Service']
  readonly geminiSettings: GeminiAcpRuntimeGeminiSettings | null | undefined
  readonly environment?: NodeJS.ProcessEnv
  readonly apiKeyConfigured?: boolean
}

export function buildGeminiAcpEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: GeminiAcpEnvironmentOptions = {},
): NodeJS.ProcessEnv
{
  const sanitized = { ...environment }
  if (options.apiKeyConfigured !== true)
  {
    if (!options.explicitlyConfiguredApiKeyNames?.has(GEMINI_API_KEY_ENV))
    {
      delete sanitized[GEMINI_API_KEY_ENV]
    }
    if (!options.explicitlyConfiguredApiKeyNames?.has(GOOGLE_API_KEY_ENV))
    {
      delete sanitized[GOOGLE_API_KEY_ENV]
    }
  }
  else
  {
    // gemini-cli gives GOOGLE_API_KEY precedence; never let a host key shadow
    // the instance's configured GEMINI_API_KEY.
    delete sanitized[GOOGLE_API_KEY_ENV]
  }
  const cliHome = options.cliHome?.trim()
  if (cliHome) sanitized[GEMINI_CLI_HOME_ENV] = cliHome
  return sanitized
}

export function buildGeminiAcpSpawnInput(
  geminiSettings: Pick<GeminiSettings, 'binaryPath'> | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput
{
  return {
    command: geminiSettings?.binaryPath || 'gemini',
    args: ['--acp'],
    cwd,
    ...(environment ? { env: environment, extendEnv: false } : {}),
  }
}

export function resolveGeminiAuthMethodId(input: {
  readonly apiKeyConfigured?: boolean
  readonly environment?: NodeJS.ProcessEnv
}): string | undefined
{
  return input.apiKeyConfigured === true && input.environment?.[GEMINI_API_KEY_ENV]?.trim()
    ? GEMINI_AUTH_METHOD_API_KEY
    : undefined
}

// gemini-cli documents `loadSession` rather than native resume, so
// continuation rides the shared replay-gated session/load fallback.
export const makeGeminiAcpRuntime = (
  input: GeminiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime['Service'],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* ()
  {
    const authMethodId = resolveGeminiAuthMethodId({
      ...(input.apiKeyConfigured === undefined ? {} : { apiKeyConfigured: input.apiKeyConfigured }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    })
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        continuationFallback: 'load',
        reuseAgentAuthentication: true,
        spawn: buildGeminiAcpSpawnInput(input.geminiSettings, input.cwd, input.environment),
        ...(authMethodId === undefined ? {} : { authMethodId }),
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

export function currentGeminiModelIdFromSessionSetup(sessionSetupResult: {
  readonly models?: { readonly currentModelId?: string | null } | null
}): string | undefined
{
  return sessionSetupResult.models?.currentModelId?.trim() || undefined
}

export interface GeminiAcpModel
{
  readonly slug: string
  readonly name: string
  readonly description?: string | null
  readonly isCurrent: boolean
}

export function geminiModelsFromSessionSetup(sessionSetupResult: {
  readonly models?: {
    readonly currentModelId?: string | null
    readonly availableModels?: ReadonlyArray<{
      readonly modelId: string
      readonly name: string
      readonly description?: string | null
    }>
  } | null
}): ReadonlyArray<GeminiAcpModel>
{
  const current = sessionSetupResult.models?.currentModelId?.trim()
  const seen = new Set<string>()
  return (sessionSetupResult.models?.availableModels ?? []).flatMap((model) =>
  {
    const slug = model.modelId.trim()
    if (!slug || seen.has(slug)) return []
    seen.add(slug)
    return [
      {
        slug,
        name: model.name.trim() || slug,
        ...(model.description === undefined ? {} : { description: model.description }),
        isCurrent: slug === current,
      },
    ]
  })
}

export function applyGeminiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime['Service'], 'setSessionModel'>
  readonly currentModelId: string | undefined
  readonly requestedModelId: string | undefined
  readonly availableModelIds?: ReadonlySet<string>
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E
}): Effect.Effect<string | undefined, E>
{
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId
  if (!shouldSwitchModel)
  {
    return Effect.succeed(input.currentModelId)
  }
  if (
    input.availableModelIds !== undefined &&
    !input.availableModelIds.has(input.requestedModelId)
  )
  {
    return Effect.succeed(input.currentModelId)
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId))
}
