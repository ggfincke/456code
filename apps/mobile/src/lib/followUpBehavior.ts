// apps/mobile/src/lib/followUpBehavior.ts
// what sending during a running turn does by default on mobile
import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";

export type FollowUpBehavior = Extract<ActiveTurnComposerAction, "queue" | "steer">;

// fincke: steer by default; an explicit Settings -> Follow-ups choice still wins, and
// agents that can't steer still queue
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "steer";
