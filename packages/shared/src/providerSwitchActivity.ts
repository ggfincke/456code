// packages/shared/src/providerSwitchActivity.ts
// identify equivalent adjacent provider-switch activities across projections

export interface ProviderSwitchActivityLike
{
  readonly kind: string
  readonly payload: unknown
  readonly sequence?: number | undefined
}

export function providerSwitchActivitiesMatch(
  activity: ProviderSwitchActivityLike,
  candidate: ProviderSwitchActivityLike,
): boolean
{
  if (activity.kind !== candidate.kind)
  {
    return false
  }
  const payload =
    typeof activity.payload === 'object' && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : null
  const candidatePayload =
    typeof candidate.payload === 'object' && candidate.payload !== null
      ? (candidate.payload as Record<string, unknown>)
      : null
  if (payload === null || candidatePayload === null)
  {
    return false
  }
  if (activity.kind === 'provider.switch.failed')
  {
    return typeof payload.detail === 'string' && payload.detail === candidatePayload.detail
  }
  if (activity.kind !== 'provider.switch.completed' || typeof payload.toInstanceId !== 'string')
  {
    return false
  }
  return (
    payload.fromInstanceId === candidatePayload.fromInstanceId &&
    (payload.fromModel ?? null) === (candidatePayload.fromModel ?? null) &&
    payload.toInstanceId === candidatePayload.toInstanceId &&
    (payload.toModel ?? null) === (candidatePayload.toModel ?? null)
  )
}

export function isAdjacentProviderSwitchActivity(
  activity: ProviderSwitchActivityLike,
  candidate: ProviderSwitchActivityLike,
): boolean
{
  return (
    activity.sequence !== undefined &&
    candidate.sequence !== undefined &&
    Math.abs(activity.sequence - candidate.sequence) <= 1 &&
    providerSwitchActivitiesMatch(activity, candidate)
  )
}
