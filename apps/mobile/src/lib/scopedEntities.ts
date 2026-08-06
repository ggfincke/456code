// apps/mobile/src/lib/scopedEntities.ts
// expose scoped project key

import {
  scopedProjectKey as runtimeScopedProjectKey,
  scopedThreadKey as runtimeScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from '@t3tools/client-runtime/environment'
import { ApprovalRequestId, EnvironmentId, ProjectId, ThreadId } from '@t3tools/contracts'

export function scopedProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string
{
  return runtimeScopedProjectKey(scopeProjectRef(environmentId, projectId))
}

export function scopedThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string
{
  return runtimeScopedThreadKey(scopeThreadRef(environmentId, threadId))
}

export function scopedRequestKey(
  environmentId: EnvironmentId,
  requestId: ApprovalRequestId,
): string
{
  return `${environmentId}:${requestId}`
}
