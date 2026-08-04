// apps/mobile/src/features/agent-awareness/capabilities.ts
// determine whether agent awareness push

import Constants from 'expo-constants'

export function supportsAgentAwarenessPush()
{
  return Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true
}
