// apps/mobile/src/features/threads/sidebar/threadDragGap.ts
// clamp a native handle drag to the active list bounds

export function resolveThreadDragDestination(
  from: number,
  distance: number,
  rowHeight: number,
  count: number,
): number
{
  if (!Number.isFinite(distance) || rowHeight <= 0 || count <= 0) return from
  return Math.min(count - 1, Math.max(0, from + Math.round(distance / rowHeight)))
}
