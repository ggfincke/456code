// apps/mobile/src/lib/useNowMinute.ts
// manage now minute through a React hook

import { useSyncExternalStore } from 'react'

// minute-quantized clock ("YYYY-MM-DDTHH:MM"), the mobile twin of
// apps/web/src/hooks/useNowMinute.ts. one module-level timer feeds every
// consumer through useSyncExternalStore, so the thread list, the row pills and
// anything else resolving a clock-dependent state share one value by
// construction instead of each running its own interval.

function currentMinute(): string
{
  return new Date().toISOString().slice(0, 16)
}

let nowMinute = currentMinute()
let timerId: ReturnType<typeof setTimeout> | null = null
let timerIsInterval = false
const listeners = new Set<() => void>()

function tick(): void
{
  const next = currentMinute()
  if (next !== nowMinute)
  {
    nowMinute = next
    for (const listener of listeners) listener()
  }
}

function startTimer(): void
{
  // align to the next UTC minute boundary, then tick every 60s. ticks re-read
  // the clock, so a throttled or late timer self-corrects when it fires --
  // which matters more here than on web, since iOS suspends timers in the
  // background and the first tick after a foreground can be far off schedule.
  timerIsInterval = false
  timerId = setTimeout(
    () =>
    {
      tick()
      timerIsInterval = true
      timerId = setInterval(tick, 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )
}

function subscribe(listener: () => void): () => void
{
  if (listeners.size === 0)
  {
    startTimer()
  }
  listeners.add(listener)
  return () =>
  {
    listeners.delete(listener)
    if (listeners.size === 0 && timerId !== null)
    {
      if (timerIsInterval) clearInterval(timerId)
      else clearTimeout(timerId)
      timerId = null
    }
  }
}

function getSnapshot(): string
{
  // with no timer running (no subscribers yet, or the first render after a full
  // unmount) the stored minute may be stale; re-read it so a fresh mount
  // renders the current minute instead of waiting for the first tick. while the
  // timer runs the cached value is returned untouched, as useSyncExternalStore
  // requires between change notifications.
  if (timerId === null)
  {
    nowMinute = currentMinute()
  }
  return nowMinute
}

export function useNowMinute(): string
{
  return useSyncExternalStore(subscribe, getSnapshot)
}
