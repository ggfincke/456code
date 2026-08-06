// apps/mobile/src/features/agent-awareness/remoteRegistrationStatus.ts
// agent-awareness registration status store for settings toggles

export type AgentAwarenessRegistrationStatus = 'unknown' | 'pending' | 'registered' | 'failed'
let registrationStatus: AgentAwarenessRegistrationStatus = 'unknown'
const registrationStatusListeners = new Set<() => void>()

export function setRegistrationStatus(next: AgentAwarenessRegistrationStatus): void
{
  if (registrationStatus === next)
  {
    return
  }
  registrationStatus = next
  for (const listener of registrationStatusListeners)
  {
    listener()
  }
}

export function getAgentAwarenessRegistrationStatus(): AgentAwarenessRegistrationStatus
{
  return registrationStatus
}

export function subscribeAgentAwarenessRegistrationStatus(listener: () => void): () => void
{
  registrationStatusListeners.add(listener)
  return () =>
  {
    registrationStatusListeners.delete(listener)
  }
}

export function resetRegistrationStatus(): void
{
  registrationStatus = 'unknown'
  registrationStatusListeners.clear()
}

export function readRegistrationStatus(): AgentAwarenessRegistrationStatus
{
  return registrationStatus
}
