// packages/effect-acp/src/provider-extensions.ts
// isolates provider-specific wire extensions from generated ACP v1 contracts

import * as Schema from 'effect/Schema'

const Meta = Schema.optionalKey(
  Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
)

export const GROK_SET_SESSION_MODEL_METHOD = 'session/set_model'

export type ModelInfo = typeof ModelInfo.Type
export const ModelInfo = Schema.Struct({
  _meta: Meta,
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  modelId: Schema.String,
  name: Schema.String,
})

export type SessionModelState = typeof SessionModelState.Type
export const SessionModelState = Schema.Struct({
  _meta: Meta,
  availableModels: Schema.Array(ModelInfo),
  currentModelId: Schema.String,
})

export type SessionModelsExtension = typeof SessionModelsExtension.Type
export const SessionModelsExtension = Schema.Struct({
  models: Schema.optionalKey(Schema.Union([SessionModelState, Schema.Null])),
})

export type SetSessionModelRequest = typeof SetSessionModelRequest.Type
export const SetSessionModelRequest = Schema.Struct({
  _meta: Meta,
  modelId: Schema.String,
  sessionId: Schema.String,
})

export type SetSessionModelResponse = typeof SetSessionModelResponse.Type
export const SetSessionModelResponse = Schema.Struct({
  _meta: Meta,
})
