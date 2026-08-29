// apps/mobile/src/persistence/mobile-storage.ts
// persist mobile storage data

import { EnvironmentId } from '@t3tools/contracts'
import * as Arr from 'effect/Array'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { pipe } from 'effect/Function'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import { type SavedRemoteConnection, toStableSavedRemoteConnection } from '../lib/connection'
import * as MobileSecureStorage from './mobile-secure-storage'

const CONNECTIONS_KEY = 'code456.connections'
const AGENT_AWARENESS_DEVICE_ID_KEY = 'code456.agent-awareness.device-id'
const AGENT_AWARENESS_REGISTRATION_KEY = 'code456.agent-awareness.registration'

export class MobileStorageDecodeError extends Schema.TaggedErrorClass<MobileStorageDecodeError>()(
  'MobileStorageDecodeError',
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to decode mobile storage value for key ${this.key}.`
  }
}

export class MobileStorageEncodeError extends Schema.TaggedErrorClass<MobileStorageEncodeError>()(
  'MobileStorageEncodeError',
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
)
{
  override get message(): string
  {
    return `Failed to encode mobile storage value for key ${this.key}.`
  }
}

export class MobileDeviceIdGenerationError extends Schema.TaggedErrorClass<MobileDeviceIdGenerationError>()(
  'MobileDeviceIdGenerationError',
  { cause: Schema.Defect() },
)
{
  override get message(): string
  {
    return 'Failed to generate the mobile agent-awareness device id.'
  }
}

export interface AgentAwarenessRegistrationRecord
{
  readonly identity: string
  readonly signature: string
  readonly pushToStartToken?: string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>>
{
  return typeof value === 'object' && value !== null
}

function isSavedRemoteConnection(value: unknown): value is SavedRemoteConnection
{
  if (!isRecord(value))
  {
    return false
  }

  const authenticationMethod = value.authenticationMethod
  const bearerToken = value.bearerToken
  const relayManaged = value.relayManaged
  return (
    typeof value.environmentId === 'string' &&
    value.environmentId.length > 0 &&
    typeof value.environmentLabel === 'string' &&
    typeof value.pairingUrl === 'string' &&
    typeof value.displayUrl === 'string' &&
    typeof value.httpBaseUrl === 'string' &&
    typeof value.wsBaseUrl === 'string' &&
    (bearerToken === null || typeof bearerToken === 'string') &&
    (authenticationMethod === undefined ||
      authenticationMethod === 'bearer' ||
      authenticationMethod === 'dpop') &&
    (value.dpopAccessToken === undefined || typeof value.dpopAccessToken === 'string') &&
    (relayManaged === undefined || relayManaged === true) &&
    ((typeof bearerToken === 'string' && bearerToken.trim().length > 0) ||
      relayManaged === true ||
      authenticationMethod === 'dpop')
  )
}

export class MobileStorage extends Context.Service<
  MobileStorage,
  {
    readonly loadSavedConnections: Effect.Effect<
      ReadonlyArray<SavedRemoteConnection>,
      MobileSecureStorage.MobileSecureStorageError
    >
    readonly saveConnection: (
      connection: SavedRemoteConnection,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >
    readonly clearSavedConnection: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >
    readonly loadOrCreateAgentAwarenessDeviceId: Effect.Effect<
      string,
      MobileSecureStorage.MobileSecureStorageError | MobileDeviceIdGenerationError
    >
    readonly loadAgentAwarenessDeviceId: Effect.Effect<
      string | null,
      MobileSecureStorage.MobileSecureStorageError
    >
    readonly loadAgentAwarenessRegistrationRecord: Effect.Effect<
      AgentAwarenessRegistrationRecord | null,
      MobileSecureStorage.MobileSecureStorageError
    >
    readonly saveAgentAwarenessRegistrationRecord: (
      record: AgentAwarenessRegistrationRecord,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >
    readonly clearAgentAwarenessRegistrationRecord: Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError
    >
  }
>()('@t3tools/mobile/persistence/MobileStorage')
{}

export const make = Effect.fn('MobileStorage.make')(function* ()
{
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage
  const deviceIdLock = yield* Semaphore.make(1)

  const parseJson = (key: string, raw: string): unknown | null =>
  {
    if (!raw.trim()) return null
    try
    {
      return JSON.parse(raw) as unknown
    }
    catch (cause)
    {
      console.warn(
        '[mobile-storage] ignored invalid JSON',
        new MobileStorageDecodeError({ key, cause }),
      )
      return null
    }
  }

  const readJson = Effect.fn('MobileStorage.readJson')(function* (key: string)
  {
    const raw = (yield* secureStorage.getItem(key)) ?? ''
    return parseJson(key, raw)
  })

  const writeJson = Effect.fn('MobileStorage.writeJson')(function* (key: string, value: unknown)
  {
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    })
    yield* secureStorage.setItem(key, encoded)
  })

  const loadSavedConnections = readJson(CONNECTIONS_KEY).pipe(
    Effect.map((parsed) =>
      isRecord(parsed) && Array.isArray(parsed.connections)
        ? parsed.connections.filter(isSavedRemoteConnection)
        : [],
    ),
  )

  const saveConnection = Effect.fn('MobileStorage.saveConnection')(function* (
    connection: SavedRemoteConnection,
  )
  {
    const current = yield* loadSavedConnections
    const stableConnection = toStableSavedRemoteConnection(connection)
    const next = current.some((entry) => entry.environmentId === connection.environmentId)
      ? pipe(
          current,
          Arr.map((entry) =>
            entry.environmentId === connection.environmentId ? stableConnection : entry,
          ),
        )
      : pipe(current, Arr.append(stableConnection))
    yield* writeJson(CONNECTIONS_KEY, { connections: next })
  })

  const clearSavedConnection = Effect.fn('MobileStorage.clearSavedConnection')(function* (
    environmentId: EnvironmentId,
  )
  {
    const current = yield* loadSavedConnections
    const next = pipe(
      current,
      Arr.filter((entry) => entry.environmentId !== environmentId),
    )
    yield* writeJson(CONNECTIONS_KEY, { connections: next })
  })

  const loadOrCreateAgentAwarenessDeviceId = deviceIdLock.withPermit(
    Effect.gen(function* ()
    {
      const existing = yield* secureStorage.getItem(AGENT_AWARENESS_DEVICE_ID_KEY)
      if (existing?.trim()) return existing
      const deviceId = yield* Effect.tryPromise({
        try: () => import('../lib/uuid').then(({ uuidv4 }) => uuidv4()),
        catch: (cause) => new MobileDeviceIdGenerationError({ cause }),
      })
      yield* secureStorage.setItem(AGENT_AWARENESS_DEVICE_ID_KEY, deviceId)
      return deviceId
    }),
  )

  const loadAgentAwarenessDeviceId = secureStorage
    .getItem(AGENT_AWARENESS_DEVICE_ID_KEY)
    .pipe(Effect.map((existing) => (existing?.trim() ? existing : null)))

  const loadAgentAwarenessRegistrationRecord = readJson(AGENT_AWARENESS_REGISTRATION_KEY).pipe(
    Effect.map((parsed) =>
    {
      if (
        !isRecord(parsed) ||
        typeof parsed.identity !== 'string' ||
        typeof parsed.signature !== 'string'
      )
      {
        return null
      }
      return {
        identity: parsed.identity,
        signature: parsed.signature,
        ...(typeof parsed.pushToStartToken === 'string' && parsed.pushToStartToken
          ? { pushToStartToken: parsed.pushToStartToken }
          : {}),
      }
    }),
  )

  return MobileStorage.of({
    loadSavedConnections,
    saveConnection,
    clearSavedConnection,
    loadOrCreateAgentAwarenessDeviceId,
    loadAgentAwarenessDeviceId,
    loadAgentAwarenessRegistrationRecord,
    saveAgentAwarenessRegistrationRecord: (record) =>
      writeJson(AGENT_AWARENESS_REGISTRATION_KEY, record),
    clearAgentAwarenessRegistrationRecord: secureStorage.setItem(
      AGENT_AWARENESS_REGISTRATION_KEY,
      '',
    ),
  })
})

export const layer = Layer.effect(MobileStorage, make())
