// apps/web/src/onboarding/firstRun.logic.ts
// decides whether authoritative first-run state opens onboarding

export type FirstRunDecision = 'pending' | 'app' | 'wizard'

export function resolveFirstRunDecision(input: {
  readonly enabled: boolean
  readonly hydrated: boolean
  readonly completed: boolean
  readonly bootstrapped: boolean
  readonly authoritative: boolean
  readonly workspaceFresh: boolean
  readonly projectCount: number
  readonly threadCount: number
}): { readonly decision: FirstRunDecision; readonly persistCompletion: boolean }
{
  if (!input.enabled || (input.hydrated && input.completed))
  {
    return { decision: 'app', persistCompletion: false }
  }
  if (!input.hydrated || !input.bootstrapped || !input.authoritative)
  {
    return { decision: 'pending', persistCompletion: false }
  }
  if (input.projectCount > 1 || input.threadCount > 1 || !input.workspaceFresh)
  {
    return { decision: 'app', persistCompletion: true }
  }
  return { decision: 'wizard', persistCompletion: false }
}
