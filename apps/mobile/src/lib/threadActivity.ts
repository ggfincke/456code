// apps/mobile/src/lib/threadActivity.ts
// exposes stable mobile thread activity transformations

export {
  buildPendingUserInputAnswers,
  derivePendingApprovals,
  derivePendingUserInputs,
  setPendingUserInputCustomAnswer,
  type PendingApproval,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from './thread-activity/pending'
export {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  sortThreadActivities,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from './thread-activity/feed'
export type { ThreadFeedActivity } from './thread-activity/worklog'
