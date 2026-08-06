// apps/server/src/vcs/GitVcsStatusUpstream.ts
// status upstream refresh cooldown helpers

import * as Duration from 'effect/Duration'

export const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30)
export const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15)

export function statusUpstreamRefreshFailureCooldown(
  consecutiveFailures: number,
): Duration.Duration
{
  const exponent = Math.max(0, consecutiveFailures - 1)
  const cooldownMs =
    Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent)
  return Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN)
}
