// apps/server/src/orchestration/activityPolicy.ts
// centralizes command-state activity classification

export const COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS = [
  'approval.requested',
  'approval.resolved',
  'user-input.requested',
  'user-input.resolved',
  'provider.approval.respond.failed',
  'provider.user-input.respond.failed',
] as const

export const COMMAND_RELEVANT_THREAD_ACTIVITY_KIND_SET: ReadonlySet<string> = new Set(
  COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS,
)

export const IMPORT_CONTINUATION_ACTIVITY_TYPE = 'import.continuation'

export function isBlockingRequestActivityKind(kind: string): boolean
{
  return (
    kind === COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS[0] ||
    kind === COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS[2]
  )
}

export function isBlockingRequestResolutionActivityKind(kind: string): boolean
{
  return (
    kind === COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS[1] ||
    kind === COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS[3]
  )
}

export function isBlockingRequestFailureActivityKind(kind: string): boolean
{
  return (
    kind === COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS[4] ||
    kind === COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS[5]
  )
}

export function isImportContinuationActivityPayload(payload: unknown): boolean
{
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    payload.type === IMPORT_CONTINUATION_ACTIVITY_TYPE
  )
}
