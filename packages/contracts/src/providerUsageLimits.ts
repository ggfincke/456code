// packages/contracts/src/providerUsageLimits.ts
// extends provider account usage with sparse subscription limit updates
import * as Schema from 'effect/Schema'

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from './baseSchemas.ts'

export const ServerProviderAccountUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  scopeLabel: Schema.optional(TrimmedNonEmptyString),
  kind: Schema.optional(Schema.Literals(['session', 'weekly', 'monthly', 'other'])),
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.NullOr(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
})
export type ServerProviderAccountUsageWindow = typeof ServerProviderAccountUsageWindow.Type

// reset credits are report-only in 456code; no redemption RPC is exposed
export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
})
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type

// runtime updates are sparse and merge by stable provider-native window id
export const ProviderUsageLimitsUpdate = Schema.Struct({
  accountIdentity: TrimmedNonEmptyString,
  windows: Schema.Array(ServerProviderAccountUsageWindow),
  observedAt: IsoDateTime,
})
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type
