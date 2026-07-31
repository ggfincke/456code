// apps/web/src/components/chat/orchestratePlanStore.ts
// module-level draft, lifecycle, and supersession state for orchestrate plan cards
import type { ProviderInstanceId } from "@t3tools/contracts";

// a stage binding as edited in the card; provider tracks the picked model's
// driver kind when the broker can launch it, else stays with the plan's
export interface OrchestrateStageSelection {
  provider: string;
  model: string;
  instanceId: ProviderInstanceId | null;
}

// idle -> sending -> sent is the approval path; editing means the reply went to
// the composer instead, which leaves the card interactive
export type OrchestratePlanCardStatus = "idle" | "sending" | "sent" | "editing";

export interface OrchestratePlanCardState {
  readonly selections: Readonly<Record<string, OrchestrateStageSelection>>;
  readonly efforts: Readonly<Record<string, string>>;
  // null -> the plan's own maxWorkers is still in effect
  readonly maxWorkers: number | null;
  readonly status: OrchestratePlanCardStatus;
  readonly error: string | null;
}

export const EMPTY_ORCHESTRATE_PLAN_CARD_STATE: OrchestratePlanCardState = {
  selections: {},
  efforts: {},
  maxWorkers: null,
  status: "idle",
  error: null,
};

// cards remount whenever the timeline virtualizes, so unsent picker edits and
// the sent/approved marker live outside React
const cardStates = new Map<string, OrchestratePlanCardState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeOrchestratePlanStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readOrchestratePlanCardState(key: string): OrchestratePlanCardState {
  return cardStates.get(key) ?? EMPTY_ORCHESTRATE_PLAN_CARD_STATE;
}

function updateCardState(
  key: string,
  updater: (current: OrchestratePlanCardState) => OrchestratePlanCardState,
): void {
  const current = readOrchestratePlanCardState(key);
  const next = updater(current);
  if (next === current) return;
  cardStates.set(key, next);
  emit();
}

export function setOrchestrateStageSelection(
  key: string,
  rowKey: string,
  selection: OrchestrateStageSelection,
): void {
  updateCardState(key, (current) => ({
    ...current,
    selections: { ...current.selections, [rowKey]: selection },
  }));
}

export function setOrchestrateStageEffort(key: string, rowKey: string, effort: string): void {
  updateCardState(key, (current) => ({
    ...current,
    efforts: { ...current.efforts, [rowKey]: effort },
  }));
}

export function setOrchestratePlanMaxWorkers(key: string, maxWorkers: number): void {
  updateCardState(key, (current) => ({ ...current, maxWorkers }));
}

export function setOrchestratePlanCardStatus(
  key: string,
  status: OrchestratePlanCardStatus,
  error: string | null = null,
): void {
  updateCardState(key, (current) =>
    current.status === status && current.error === error ? current : { ...current, status, error },
  );
}

// plan cards for one run are registered in first-seen order; a remount of an
// older card re-registers the same content key and keeps its original epoch,
// so virtualization cannot promote a stale card over the newest one
const runEpochs = new Map<string, Map<string, number>>();
let epochCounter = 0;

export function registerOrchestratePlanCard(runId: string, contentKey: string): void {
  const epochs = runEpochs.get(runId) ?? new Map<string, number>();
  if (epochs.has(contentKey)) return;
  epochCounter += 1;
  epochs.set(contentKey, epochCounter);
  runEpochs.set(runId, epochs);
  emit();
}

export function isOrchestratePlanCardSuperseded(runId: string, contentKey: string): boolean {
  const epochs = runEpochs.get(runId);
  const own = epochs?.get(contentKey);
  if (epochs === undefined || own === undefined) return false;
  for (const epoch of epochs.values()) {
    if (epoch > own) return true;
  }
  return false;
}

// djb2 over the plan's canonical text -> a short stable id for one rendered plan
export function hashOrchestratePlanText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
