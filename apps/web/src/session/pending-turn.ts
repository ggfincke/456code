// apps/web/src/session/pending-turn.ts
// expose shared pending request derivation to web session callers

export {
  derivePendingApprovals,
  derivePendingUserInputs,
  requestKindFromRequestType,
  type PendingApproval,
  type PendingUserInput,
} from '@t3tools/client-runtime/thread-activity'
