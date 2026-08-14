// apps/mobile/src/features/agent-awareness/liveActivityPublisher.ts
// publishes the local live activity aggregate from thread shells

import { AppState, Platform } from 'react-native'
import { projectThreadAwareness, type AgentAwarenessState } from '@t3tools/shared/agentAwareness'
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from '@t3tools/client-runtime/state/shell'

import { loadPreferences } from '../../persistence/imperative'
import { appAtomRegistry } from '../../state/atom-registry'
import { environmentProjects } from '../../state/projects'
import { environmentThreadShells } from '../../state/threads'
import AgentActivity, { type AgentActivityRowProps } from '../../widgets/AgentActivity'
import { subscribeAgentAwarenessAppState } from './remoteRegistration'

// ! the relay can also drive this activity: once the deferred push publisher
// ! lands, remote APNs updates and these local update() calls target the SAME
// ! activity and will race. One of the two has to become authoritative before
// ! that ships -- today the relay never publishes, so local updates own it.

// the widget shows three rows; anything past that is only reflected in the
// count, so there is no reason to serialize it across the bridge.
const LIVE_ACTIVITY_VISIBLE_ROWS = 3

// staleness is time-derived, so it materializes with no shell event behind it.
// a purely event-driven publisher could therefore never emit 'stale' -- the
// silence IS the signal -- which is why this exists alongside the subscription.
const LIVE_ACTIVITY_REFRESH_INTERVAL_MS = 60_000

// urgency order for the visible rows, mirroring the attention classifier:
// blocked-on-user outranks a dead run, which outranks healthy work.
const PHASE_RANK: Record<AgentAwarenessState['phase'], number> = {
  waiting_for_approval: 6,
  waiting_for_input: 5,
  failed: 4,
  stale: 3,
  running: 2,
  starting: 1,
  completed: 0,
}

function projectKeyOf(environmentId: string, projectId: string): string
{
  return `${environmentId}\u0000${projectId}`
}

function toActivityRow(state: AgentAwarenessState): AgentActivityRowProps
{
  // AgentActivityRowProps is the awareness state with `headline` renamed to
  // `status` and `detail` dropped -- the widget has no room for the second line.
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: state.headline,
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  }
}

// an activity row is worth a lock-screen slot only while the agent still owes
// the user something. A finished thread is history the moment it is projected,
// and keeping it would make the card grow without ever shrinking.
function isPublishablePhase(phase: AgentAwarenessState['phase']): boolean
{
  return phase !== 'completed'
}

export function buildAgentAwarenessAggregate(input: {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>
  readonly projects: ReadonlyArray<EnvironmentProject>
  readonly nowMs: number
}): {
  readonly activeCount: number
  readonly rows: ReadonlyArray<AgentActivityRowProps>
  readonly updatedAt: string
} | null
{
  const projectTitleByKey = new Map(
    input.projects.map((project) => [
      projectKeyOf(project.environmentId, project.id),
      project.title,
    ]),
  )

  const states: AgentAwarenessState[] = []
  for (const shell of input.shells)
  {
    if (shell.archivedAt !== null) continue
    const projectTitle = projectTitleByKey.get(projectKeyOf(shell.environmentId, shell.projectId))
    // a thread whose project has not synced yet is dropped rather than shown
    // under a placeholder title, matching how the desktop menu bar treats it.
    if (projectTitle === undefined) continue
    const state = projectThreadAwareness({
      environmentId: shell.environmentId,
      now: input.nowMs,
      project: { title: projectTitle },
      thread: shell,
    })
    if (state === null || !isPublishablePhase(state.phase)) continue
    states.push(state)
  }

  if (states.length === 0)
  {
    return null
  }

  states.sort(
    (left, right) =>
      PHASE_RANK[right.phase] - PHASE_RANK[left.phase] ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.threadId.localeCompare(right.threadId),
  )

  const rows = states.slice(0, LIVE_ACTIVITY_VISIBLE_ROWS).map(toActivityRow)
  return {
    activeCount: states.length,
    rows,
    // the aggregate's own stamp is the clock, not the newest thread: it says
    // when this card last reflected reality, which is exactly the fact a stale
    // row needs the reader to trust.
    updatedAt: new Date(input.nowMs).toISOString(),
  }
}

export function buildAgentAwarenessSubtitle(input: {
  readonly activeCount: number
  readonly topRow: AgentActivityRowProps | undefined
}): string
{
  if (input.activeCount > 1)
  {
    return `${input.activeCount} threads active`
  }
  return input.topRow?.status ?? 'Agent work in progress'
}

// publishes into an EXISTING activity and never starts one: creation belongs to
// the arm-on-send path and the relay prime, both of which run in the foreground
// where the push token can be observed. A background subscription that started
// cards would put lock-screen chrome in front of a user who never asked for it.
//
// modelled on apps/web/src/desktop/threadAttentionNotifier.ts: a store
// subscription rather than a render memo, so there is one publisher per app
// instead of one per mounted renderer.
export function startAgentAwarenessLiveActivityPublisher(): () => void
{
  if (Platform.OS !== 'ios')
  {
    return () =>
    {}
  }

  const shellsAtom = environmentThreadShells.threadShellsAtom
  const projectsAtom = environmentProjects.projectsAtom
  let liveActivitiesEnabled = true
  let disposed = false
  let publishedActiveCount = 0
  let refreshTimer: ReturnType<typeof setInterval> | null = null

  const publish = () =>
  {
    if (disposed || !liveActivitiesEnabled) return
    let activity
    try
    {
      activity = AgentActivity.getInstances()[0]
    }
    catch (error)
    {
      logPublisherError('live activity lookup failed', error)
      return
    }
    if (!activity) return

    const aggregate = buildAgentAwarenessAggregate({
      shells: appAtomRegistry.get(shellsAtom),
      projects: appAtomRegistry.get(projectsAtom),
      nowMs: Date.now(),
    })

    if (aggregate === null)
    {
      // only end a card this publisher actually populated. The relay aggregate
      // spans every environment on the account, while these shells only cover
      // the ones this device is connected to, so an empty local view is not
      // evidence that the card should go away.
      if (publishedActiveCount === 0) return
      publishedActiveCount = 0
      activity.end('default').catch((error: unknown) =>
      {
        logPublisherError('live activity end failed', error)
      })
      return
    }

    publishedActiveCount = aggregate.activeCount
    activity
      .update({
        title: '456code',
        subtitle: buildAgentAwarenessSubtitle({
          activeCount: aggregate.activeCount,
          topRow: aggregate.rows[0],
        }),
        activeCount: aggregate.activeCount,
        updatedAt: aggregate.updatedAt,
        activities: aggregate.rows,
      })
      .catch((error: unknown) =>
      {
        logPublisherError('live activity update failed', error)
      })
  }

  const stopRefreshTimer = () =>
  {
    if (refreshTimer === null) return
    clearInterval(refreshTimer)
    refreshTimer = null
  }

  const startRefreshTimer = () =>
  {
    if (refreshTimer !== null || disposed) return
    refreshTimer = setInterval(publish, LIVE_ACTIVITY_REFRESH_INTERVAL_MS)
  }

  // the toggle defaults to on: only an explicit false silences the card, so an
  // unreadable preference store must not be treated as "off".
  const refreshPreference = () =>
    loadPreferences()
      .catch(() => null)
      .then((preferences) =>
      {
        liveActivitiesEnabled = preferences?.liveActivitiesEnabled !== false
      })

  void refreshPreference()

  const unsubscribeShells = appAtomRegistry.subscribe(shellsAtom, () =>
  {
    publish()
  })
  // the timer only runs in the foreground: a background phone cannot show a
  // changed card until it wakes anyway, and iOS would rather it stopped asking.
  // this rides the registration lifecycle's single AppState subscription rather
  // than adding a second one.
  const unsubscribeAppState = subscribeAgentAwarenessAppState((state) =>
  {
    if (state === 'active')
    {
      // the preference may have been flipped in settings while backgrounded.
      void refreshPreference().then(publish)
      startRefreshTimer()
      return
    }
    stopRefreshTimer()
  })

  // only arm the timer if the app is actually in front right now: mounting
  // during a background launch (a push wake) must not leave an interval running
  // that nothing will ever pause, since the transition to 'active' is what
  // starts it.
  if (AppState.currentState === 'active')
  {
    startRefreshTimer()
  }
  publish()

  return () =>
  {
    disposed = true
    stopRefreshTimer()
    unsubscribeAppState()
    unsubscribeShells()
  }
}

function logPublisherError(context: string, error: unknown): void
{
  if (!__DEV__)
  {
    return
  }
  console.warn(`[agent-awareness] ${context}`, {
    message: error instanceof Error ? error.message : String(error),
    error,
  })
}
