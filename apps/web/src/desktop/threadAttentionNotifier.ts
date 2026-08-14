// apps/web/src/desktop/threadAttentionNotifier.ts
// fires a desktop notification when a thread crosses into wanting attention

import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from '@t3tools/client-runtime/environment'
import type { EnvironmentThreadShell } from '@t3tools/client-runtime/state/shell'
import {
  resolveThreadAttention,
  type ThreadAttentionKind,
} from '@t3tools/client-runtime/state/thread-settled'
import type { DesktopThreadAttentionKind } from '@t3tools/contracts'
import { useParams } from '@tanstack/react-router'
import { useEffect, useEffectEvent } from 'react'

import { isElectron } from '../env'
import { useClientSettings } from '../hooks/useSettings'
import { appAtomRegistry } from '../rpc/atomRegistry'
import { readProject } from '../state/entities'
import { environmentThreadShells } from '../state/threads'
import { resolveThreadRouteRef } from '../threadRoutes'

// staleness is time-derived, so no shell event announces it: a thread crosses
// the threshold precisely because the event stream went quiet. The sweep is
// therefore re-run on a coarse timer as well as on every emission, and this is
// the interval. Aligned with the minute clock the sidebar surfaces tick on.
const ATTENTION_SWEEP_INTERVAL_MS = 60_000

// identity of the attention edge a thread is currently sitting on, or the
// empty string when it wants nothing. A changed key is a new edge; an
// unchanged key is the same event re-delivered by an unrelated shell update.
// turnId is part of it because two consecutive turns both completing would
// otherwise collapse into one edge and the second would never notify.
//
// a stale thread's key is stable by construction: the kind only holds while
// updatedAt stops moving, so the timer-driven sweep re-derives the same key
// and notifies once, not once a minute.
function attentionEdgeKey(shell: EnvironmentThreadShell, nowMs: number): string
{
  const kind = resolveThreadAttention(shell, { nowMs })
  if (kind === null)
  {
    return ''
  }
  const at = shell.latestTurn?.completedAt ?? shell.session?.updatedAt ?? ''
  return `${kind}|${shell.latestTurn?.turnId ?? ''}|${at}`
}

// the IPC contract's attention kind is a closed union that predates 'stale',
// so the two dead-run kinds share a channel on the way to the main process.
// the wording already fits: the desktop title for 'failed' is "<thread>
// stopped", which is exactly what a stale thread did.
function desktopAttentionKind(kind: ThreadAttentionKind): DesktopThreadAttentionKind
{
  return kind === 'stale' ? 'failed' : kind
}

function threadKeyOf(shell: EnvironmentThreadShell): string
{
  return scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))
}

// subscribes to the thread shell projection and raises one desktop
// notification per attention edge.
//
// this is a store subscription and not a render memo on purpose: a memo runs
// once per mounted renderer and again on every HMR remount, so the same turn
// completion would notify twice in development and once per window in
// production.
export function startThreadAttentionNotifier(readViewedThreadKey: () => string | null): () => void
{
  const notify = window.desktopBridge?.notifyThreadAttention
  if (!isElectron || typeof notify !== 'function')
  {
    return () =>
    {}
  }

  const shellsAtom = environmentThreadShells.threadShellsAtom
  // prime before subscribing, from the same registry read the subscription
  // will diff against. Everything already on screen at start-up is old news,
  // and this is what keeps a remount (HMR, auth flap, second window) silent
  // instead of replaying every finished thread as a fresh banner.
  const lastEdgeByThread = new Map<string, string>()
  for (const shell of appAtomRegistry.get(shellsAtom))
  {
    lastEdgeByThread.set(threadKeyOf(shell), attentionEdgeKey(shell, Date.now()))
  }

  const sweep = (shells: ReadonlyArray<EnvironmentThreadShell>) =>
  {
    const viewedThreadKey = readViewedThreadKey()
    const nowMs = Date.now()
    for (const shell of shells)
    {
      const key = threadKeyOf(shell)
      const edge = attentionEdgeKey(shell, nowMs)
      const previous = lastEdgeByThread.get(key)
      lastEdgeByThread.set(key, edge)
      // a thread seen for the first time only records its edge: a thread that
      // arrives already finished (initial sync, a newly connected
      // environment) is history, not an event.
      if (previous === undefined || previous === edge || edge === '')
      {
        continue
      }
      if (shell.archivedAt !== null)
      {
        continue
      }
      const kind = resolveThreadAttention(shell, { nowMs })
      if (kind === null)
      {
        continue
      }
      const project = readProject(scopeProjectRef(shell.environmentId, shell.projectId))
      // the contract requires a non-empty project title, and a thread whose
      // project has not synced yet would fail to encode. Skipping matches how
      // the menu bar drops such threads.
      if (project === null)
      {
        continue
      }

      void notify({
        environmentId: shell.environmentId,
        threadId: shell.id,
        title: shell.title,
        projectTitle: project.title,
        kind: desktopAttentionKind(kind),
        isViewedThread: viewedThreadKey === key,
      }).catch((error) =>
      {
        console.error('Could not raise the desktop thread notification.', error)
      })
    }
  }

  const unsubscribe = appAtomRegistry.subscribe(shellsAtom, sweep)
  // the timer reads the registry rather than waiting to be handed shells: a
  // thread going stale produces no emission at all, which is the whole point.
  const sweepTimer = window.setInterval(() =>
  {
    sweep(appAtomRegistry.get(shellsAtom))
  }, ATTENTION_SWEEP_INTERVAL_MS)

  return () =>
  {
    window.clearInterval(sweepTimer)
    unsubscribe()
  }
}

export function ThreadAttentionNotifier()
{
  const notificationsEnabled = useClientSettings((settings) => settings.desktopNotificationsEnabled)
  // selected down to a string so a route change does not hand the effect a
  // fresh object identity on every render.
  const viewedThreadKey = useParams({
    strict: false,
    select: (params) =>
    {
      const ref = resolveThreadRouteRef(params)
      return ref === null ? null : scopedThreadKey(ref)
    },
  })
  const readViewedThreadKey = useEffectEvent(() => viewedThreadKey)

  // the setting is the only dependency, because re-running this effect on
  // navigation would re-prime the edge map and swallow whatever completed
  // during the gap. a restart on a setting flip is the point: everything that
  // finished while notifications were off is history, and re-priming is what
  // keeps re-enabling them from replaying it as a burst of stale banners.
  useEffect(() =>
  {
    if (!notificationsEnabled)
    {
      return
    }
    return startThreadAttentionNotifier(() => readViewedThreadKey())
  }, [notificationsEnabled])

  return null
}
