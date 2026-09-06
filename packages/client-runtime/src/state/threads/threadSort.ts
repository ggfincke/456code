// packages/client-runtime/src/state/threads/threadSort.ts
// manage thread sort input state

import type { ProjectId } from '@t3tools/contracts'
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from '@t3tools/contracts/settings'
import * as Arr from 'effect/Array'
import * as Order from 'effect/Order'

export interface ThreadSortInput
{
  readonly createdAt: string
  readonly updatedAt: string
  readonly unsettledAt?: string | null | undefined
  readonly latestUserMessageAt?: string | null
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string
    readonly role: string
  }>
}

export function toSortableTimestamp(iso: string | undefined): number | null
{
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null
{
  for (const value of values)
  {
    const timestamp = toSortableTimestamp(value ?? undefined)
    if (timestamp !== null)
    {
      return timestamp
    }
  }

  return null
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number
{
  if (thread.latestUserMessageAt)
  {
    const latestUserMessageTimestamp = toSortableTimestamp(thread.latestUserMessageAt)
    if (latestUserMessageTimestamp !== null)
    {
      return latestUserMessageTimestamp
    }
  }

  let latestUserMessageTimestamp: number | null = null

  for (const message of thread.messages ?? [])
  {
    if (message.role !== 'user') continue
    const messageTimestamp = toSortableTimestamp(message.createdAt)
    if (messageTimestamp === null) continue
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp)
  }

  if (latestUserMessageTimestamp !== null)
  {
    return latestUserMessageTimestamp
  }

  return getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, 'manual'>,
): number
{
  if (sortOrder === 'created_at')
  {
    return getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY
  }
  const latestUserMessageTimestamp = getLatestUserMessageTimestamp(thread)
  // re-entry is fresh activity even when the last user message predates it
  return toSortableTimestamp(thread.unsettledAt ?? undefined) === null
    ? latestUserMessageTimestamp
    : Math.max(latestUserMessageTimestamp, activeThreadAnchorTimestampMs(thread))
}

// creation anchors a new row; a later re-entry stamp moves a previously
// settled row back to the top without changing its displayed timestamps
export function activeThreadAnchorTimestampMs(thread: {
  readonly createdAt: string
  readonly unsettledAt?: string | null | undefined
}): number
{
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? Number.NEGATIVE_INFINITY,
  )
}

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[]
{
  return Arr.sort(
    threads,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        id: Order.flip(Order.String),
      }),
      (thread: T) => ({
        timestamp: getThreadSortTimestamp(thread, sortOrder),
        id: thread.id,
      }),
    ),
  )
}

export function getLatestThreadForProject<
  T extends {
    readonly id: string
    readonly projectId: ProjectId
    readonly archivedAt: string | null
  } & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null
{
  return (
    sortThreads(
      threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === null),
      sortOrder,
    )[0] ?? null
  )
}

const ACTIVE_ORDER_DIGITS = 'abcdefghijklmnopqrstuvwxyz'

function isValidActiveOrderKey(key: string): boolean
{
  return (
    key.length > 0 &&
    [...key].every((character) => ACTIVE_ORDER_DIGITS.includes(character)) &&
    key.at(-1) !== ACTIVE_ORDER_DIGITS[0]
  )
}

function activeOrderMidpoint(before: string, after: string): string
{
  if (after !== '' && before >= after)
  {
    throw new Error('activeOrderMidpoint: bounds out of order')
  }
  if (after !== '')
  {
    let commonPrefixLength = 0
    while (
      (before.charAt(commonPrefixLength) || ACTIVE_ORDER_DIGITS[0]) ===
      after.charAt(commonPrefixLength)
    )
    {
      commonPrefixLength += 1
    }
    if (commonPrefixLength > 0)
    {
      return (
        after.slice(0, commonPrefixLength) +
        activeOrderMidpoint(before.slice(commonPrefixLength), after.slice(commonPrefixLength))
      )
    }
  }

  const beforeDigit = before === '' ? 0 : ACTIVE_ORDER_DIGITS.indexOf(before.charAt(0))
  const afterDigit =
    after === '' ? ACTIVE_ORDER_DIGITS.length : ACTIVE_ORDER_DIGITS.indexOf(after.charAt(0))
  if (afterDigit - beforeDigit > 1)
  {
    return ACTIVE_ORDER_DIGITS.charAt(Math.round((beforeDigit + afterDigit) / 2))
  }
  if (after.length > 1)
  {
    return after.charAt(0)
  }
  return ACTIVE_ORDER_DIGITS.charAt(beforeDigit) + activeOrderMidpoint(before.slice(1), '')
}

// null bounds represent the open top and bottom of the arranged run
export function activeOrderKeyBetween(before: string | null, after: string | null): string | null
{
  const lower = before ?? ''
  const upper = after ?? ''
  if (lower !== '' && !isValidActiveOrderKey(lower)) return null
  if (upper !== '' && !isValidActiveOrderKey(upper)) return null
  if (upper !== '' && lower >= upper) return null
  return activeOrderMidpoint(lower, upper)
}

export function generateSpreadActiveOrderKeys(count: number): string[]
{
  let width = 2
  let space = ACTIVE_ORDER_DIGITS.length ** width
  while (space <= (count + 1) * 2)
  {
    width += 1
    space *= ACTIVE_ORDER_DIGITS.length
  }
  const step = space / (count + 1)
  const keys: string[] = []
  for (let index = 0; index < count; index += 1)
  {
    let value = Math.round(step * (index + 1))
    if (value % ACTIVE_ORDER_DIGITS.length === 0) value += 1
    let key = ''
    for (let digit = 0; digit < width; digit += 1)
    {
      key = ACTIVE_ORDER_DIGITS.charAt(value % ACTIVE_ORDER_DIGITS.length) + key
      value = Math.floor(value / ACTIVE_ORDER_DIGITS.length)
    }
    keys.push(key)
  }
  return keys
}

export function planActiveThreadReorder(input: {
  readonly orderedIds: readonly string[]
  readonly keysById: ReadonlyMap<string, string | null | undefined>
  readonly movedId: string
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }>
{
  const { orderedIds, keysById, movedId } = input
  const visibleIds = new Set(orderedIds)
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) => (!visibleIds.has(id) && key != null ? [key] : [])),
  )
  const movedIndex = orderedIds.indexOf(movedId)
  if (movedIndex === -1) return []
  const beforeId = movedIndex > 0 ? (orderedIds[movedIndex - 1] ?? null) : null
  const afterId = movedIndex < orderedIds.length - 1 ? (orderedIds[movedIndex + 1] ?? null) : null
  const beforeKey = beforeId === null ? null : (keysById.get(beforeId) ?? null)
  const afterKey = afterId === null ? null : (keysById.get(afterId) ?? null)
  if ((beforeId === null || beforeKey !== null) && (afterId === null || afterKey !== null))
  {
    let key = activeOrderKeyBetween(beforeKey, afterKey)
    while (key !== null && reservedKeys.has(key))
    {
      key = activeOrderKeyBetween(key, afterKey)
    }
    if (key !== null)
    {
      return [{ id: movedId, orderKey: key }]
    }
  }

  const keys = generateSpreadActiveOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length)
  return orderedIds.flatMap((id, index) =>
  {
    const key = keys[index]!
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }]
  })
}

export function planActiveThreadMove(input: {
  readonly orderedIds: readonly string[]
  readonly keysById: ReadonlyMap<string, string | null | undefined>
  readonly movedId: string
  readonly direction: 'up' | 'down'
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> | null
{
  const from = input.orderedIds.indexOf(input.movedId)
  if (from === -1) return null
  const to = input.direction === 'up' ? from - 1 : from + 1
  if (to < 0 || to >= input.orderedIds.length) return null
  const orderedIds = [...input.orderedIds]
  orderedIds.splice(from, 1)
  orderedIds.splice(to, 0, input.movedId)
  return planActiveThreadReorder({ ...input, orderedIds })
}

// fresh and reopened rows lead; arranged rows retain their persisted order
export function sortActiveThreadsByOrderKey<
  T extends {
    readonly id: string
    readonly createdAt: string
    readonly unsettledAt?: string | null | undefined
    readonly activeOrderKey?: string | null | undefined
    readonly environmentId?: string | undefined
  },
>(threads: readonly T[]): T[]
{
  return [...threads].sort((left, right) =>
  {
    const leftKey = left.activeOrderKey
    const rightKey = right.activeOrderKey
    if (leftKey == null && rightKey != null) return -1
    if (leftKey != null && rightKey == null) return 1
    const order =
      leftKey != null && rightKey != null
        ? leftKey < rightKey
          ? -1
          : leftKey > rightKey
            ? 1
            : 0
        : activeThreadAnchorTimestampMs(right) - activeThreadAnchorTimestampMs(left)
    return (
      order ||
      left.id.localeCompare(right.id) ||
      (left.environmentId ?? '').localeCompare(right.environmentId ?? '')
    )
  })
}
