// packages/client-runtime/src/state/shellReducer.ts
// manage apply shell stream event state

import * as Arr from 'effect/Array'
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from '@t3tools/contracts'

const entityPositions = new WeakMap<
  ReadonlyArray<{ readonly id: string }>,
  ReadonlyMap<string, number>
>()

function entityPositionsFor<A extends { readonly id: string }>(
  entities: ReadonlyArray<A>,
): ReadonlyMap<string, number>
{
  const cached = entityPositions.get(entities)
  if (cached !== undefined)
  {
    return cached
  }
  const positions = new Map(entities.map((entity, index) => [entity.id, index] as const))
  entityPositions.set(entities, positions)
  return positions
}

function upsertEntity<A extends { readonly id: string }>(
  entities: ReadonlyArray<A>,
  incoming: A,
): ReadonlyArray<A>
{
  const positions = entityPositionsFor(entities)
  const index = positions.get(incoming.id)
  if (index !== undefined)
  {
    const next = entities.with(index, incoming)
    entityPositions.set(next, positions)
    return next
  }

  const next = Arr.append(entities, incoming)
  const nextPositions = new Map(positions)
  nextPositions.set(incoming.id, entities.length)
  entityPositions.set(next, nextPositions)
  return next
}

// reduce a single shell stream event into an existing snapshot, returning a new
// snapshot with the event's changes applied. This is a pure reducer that both
// web and mobile can use to keep their local shell snapshot in sync.
//
// returns the original snapshot reference unchanged if the event is not
// recognized (forward-compatible).
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot
{
  if (event.sequence <= snapshot.snapshotSequence) return snapshot

  switch (event.kind)
  {
    case 'project-upserted':
    {
      const projects = upsertEntity(snapshot.projects, event.project)
      return { ...snapshot, projects, snapshotSequence: event.sequence }
    }
    case 'project-removed':
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      }
    case 'thread-upserted':
    {
      const threads = upsertEntity(snapshot.threads, event.thread)
      return { ...snapshot, threads, snapshotSequence: event.sequence }
    }
    case 'thread-removed':
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      }
    default:
      return snapshot
  }
}
