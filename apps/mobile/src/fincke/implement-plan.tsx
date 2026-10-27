// apps/mobile/src/fincke/implement-plan.tsx
// implement button for the thread's latest proposed plan, sent through the outbox in default mode
import {
  buildPlanImplementationPrompt,
  findLatestProposedPlan,
  hasActionableProposedPlan,
} from "@t3tools/client-runtime/proposed-plan";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  MessageId,
  type PlanId,
  type ProviderInteractionMode,
  type ScopedThreadRef,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  createContext,
  use,
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { Button } from "../components/ui/Button";
import * as Dialog from "../components/ui/Dialog";
import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
} from "../lib/modelOptions";
import { scopedThreadKey } from "../lib/scopedEntities";
import { readEnvironmentScope } from "../state/session";
import { clearThreadComposerError, setThreadComposerError } from "../state/thread-composer-error";
import { enqueueThreadOutboxMessage } from "../state/thread-outbox";
import { useQuietThreadStructure } from "../state/use-thread-detail";

// what the thread screen knows about sending; the plan card derives the plan itself so only
// plan cards subscribe to the thread structure, not the whole screen during a run
interface ImplementPlanInput {
  // the shell w/ the composer's draft model, runtime & interaction mode applied
  readonly thread: EnvironmentThreadShell;
  readonly detailRef: ScopedThreadRef | null;
  readonly serverConfig: ServerConfig | null;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly busy: boolean;
  readonly awaitingUserInput: boolean;
  readonly onUpdateInteractionMode: ((mode: ProviderInteractionMode) => void) | undefined;
  // the feed follows the new turn once it's queued
  readonly feedRef: RefObject<{ resetEndFollow(): void } | null>;
  readonly onSent: () => void;
}

const ImplementPlanContext = createContext<ImplementPlanInput | null>(null);

// folds the feed's follow reset into onSent here, so the screen never reads its ref in render
export function useImplementPlanInput(input: ImplementPlanInput): ImplementPlanInput {
  const { feedRef, onSent } = input;
  const handleSent = useCallback(() => {
    onSent();
    feedRef.current?.resetEndFollow();
  }, [feedRef, onSent]);
  return { ...input, onSent: handleSent };
}

// wraps a screen's returned tree as a call so the hook doesn't re-indent upstream's JSX
export function withImplementPlan(input: ImplementPlanInput, children: ReactNode) {
  return <ImplementPlanContext value={input}>{children}</ImplementPlanContext>;
}

// mirrors web's plan follow-up rule (shouldShowPlanFollowUpPrompt): the thread's latest
// active proposed plan, the composer in plan mode & no question waiting for an answer
export function ImplementPlanButton(props: { readonly planId: PlanId }) {
  const input = use(ImplementPlanContext);
  const structure = useQuietThreadStructure(input?.detailRef ?? null);
  const inFlight = useRef(false);
  const [implementing, setImplementing] = useState(false);
  if (input === null) return null;
  const plan = findLatestProposedPlan(
    structure?.projection ?? null,
    input.thread.latestRun?.runId ?? null,
  );
  if (
    plan === null ||
    plan.id !== props.planId ||
    !hasActionableProposedPlan(plan) ||
    !input.canOperate ||
    input.awaitingUserInput ||
    input.thread.interactionMode !== "plan"
  ) {
    return null;
  }
  const implement = async () => {
    const { thread, serverConfig } = input;
    if (
      inFlight.current ||
      !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    if (
      input.connected &&
      isModelSelectionUnavailable(serverConfig, thread.modelSelection, thread.projectId)
    ) {
      const { title, detail } = describeUnavailableModelSelection(
        serverConfig,
        thread.modelSelection,
        thread.projectId,
      );
      Dialog.alert(title, detail);
      return;
    }
    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
    const metadata = makeQueuedMessageMetadata();
    inFlight.current = true;
    setImplementing(true);
    clearThreadComposerError(threadKey);
    try {
      await enqueueThreadOutboxMessage({
        environmentId: thread.environmentId,
        threadId: thread.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: buildPlanImplementationPrompt(plan.planMarkdown),
        attachments: [],
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: "default",
        sourceProposedPlan: { threadId: thread.id, planId: plan.id },
        createdAt: metadata.createdAt,
      });
      // leaving plan mode clears the composer's Plan chip, as web does after Implement
      input.onUpdateInteractionMode?.("default");
      input.onSent();
    } catch (error) {
      setThreadComposerError(
        threadKey,
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    } finally {
      inFlight.current = false;
      setImplementing(false);
    }
  };

  return (
    <Button
      label={implementing ? "Implementing..." : "Implement"}
      tone="primary"
      disabled={input.busy || implementing}
      onPress={() => void implement()}
    />
  );
}
