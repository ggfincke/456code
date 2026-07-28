// apps/server/src/orchestration/proposedPlanIdentity.ts
// derives stable proposal plan identities from authoritative turn context

import { type OrchestrationProposedPlanId, type ThreadId, type TurnId } from "@t3tools/contracts";

export function proposedPlanIdForTurn(
  threadId: ThreadId,
  turnId: TurnId,
): OrchestrationProposedPlanId {
  return `plan:${threadId}:turn:${turnId}`;
}
