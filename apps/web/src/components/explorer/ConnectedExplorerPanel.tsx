// apps/web/src/components/explorer/ConnectedExplorerPanel.tsx
// connects the lazy explorer surface to proposal and cartographer environment state
import type {
  CartographerIssueEmbedResult,
  OrchestrationProposedPlanId,
  ProjectId,
  ProposalGeneration,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  ExplorerPanel,
  type ExplorerArchitecturePresentation,
  type ExplorerNarrativePresentation,
} from "./ExplorerPanel";
import {
  resolveCartographerEmbedLocation,
  resolveCartographerParentOrigin,
  selectLatestScopedProposal,
} from "./explorerIntegration";
import type {
  ProposalDiffAvailability,
  ProposalDiffPresentation,
} from "../proposals/ProposalDiffPanel";

const PROPOSAL_LIST_REFRESH_MS = 5_000;
const LATEST_GENERATION_REFRESH_MS = 3_000;
const ACTIVE_GENERATION_REFRESH_MS = 1_500;
const READY_GENERATION_REFRESH_MS = 10_000;
const IMPLEMENTATION_ATTEMPT_REFRESH_MS = 5_000;

interface ConnectedExplorerPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly proposalPlanId: OrchestrationProposedPlanId | null;
  readonly proposalPreviewAvailable: boolean;
  readonly cartographerAvailable: boolean;
  readonly onOpenFile: (path: string, line?: number) => void;
  readonly onSelectFile: (path: string | null) => void;
}

interface GenerationStartState {
  readonly key: string;
  readonly pending: boolean;
  readonly generation: ProposalGeneration | null;
  readonly error: string | null;
}

type EmbedTarget =
  | { readonly kind: "current" }
  | { readonly kind: "proposal"; readonly generation: ProposalGeneration };

type EmbedRequestState =
  | { readonly key: string; readonly kind: "loading" }
  | { readonly key: string; readonly kind: "error"; readonly message: string }
  | {
      readonly key: string;
      readonly kind: "ready";
      readonly result: CartographerIssueEmbedResult;
    };

interface IssuedEmbedSession {
  readonly key: string;
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly threadId: ScopedThreadRef["threadId"];
  readonly sessionId: CartographerIssueEmbedResult["sessionId"];
}

export function isProposalDiscoverySettled(input: {
  readonly settledKey: string | null;
  readonly key: string;
  readonly settledNow: boolean;
}): boolean {
  return input.settledNow || input.settledKey === input.key;
}

export function resolveEmbedTargetTransition(input: {
  readonly previousTargetKey: string | null;
  readonly nextTargetKey: string | null;
  readonly issuedSessionKey: string | null;
}): {
  readonly invalidateRequest: boolean;
  readonly releaseIssuedSession: boolean;
} {
  const invalidateRequest = input.previousTargetKey !== input.nextTargetKey;
  return {
    invalidateRequest,
    releaseIssuedSession:
      invalidateRequest &&
      input.issuedSessionKey !== null &&
      input.issuedSessionKey !== input.nextTargetKey,
  };
}

interface EmbedRequestIdentity {
  readonly key: string;
  readonly requestId: number;
}

export function isCurrentEmbedRequest(
  current: EmbedRequestIdentity | null,
  expected: EmbedRequestIdentity,
): boolean {
  return current?.key === expected.key && current.requestId === expected.requestId;
}

function commandFailureMessage(
  result: Exclude<AtomCommandResult<unknown, unknown>, { readonly _tag: "Success" }>,
  fallback: string,
): string {
  if (isAtomCommandInterrupted(result)) {
    return `${fallback} was superseded by a newer request.`;
  }
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function generationFailureMessage(generation: ProposalGeneration): string {
  switch (generation.state) {
    case "failed":
      return generation.errorCode
        ? `Exact architecture analysis failed: ${generation.errorCode.replaceAll("-", " ")}.`
        : "Exact architecture analysis failed.";
    case "cancelled":
      return "Exact architecture analysis was cancelled by a newer generation.";
    case "abandoned":
      return "Exact architecture analysis stopped before it completed.";
    default:
      return "Exact architecture analysis is unavailable.";
  }
}

function generationLoadingMessage(generation: ProposalGeneration): string {
  switch (generation.state) {
    case "queued":
      return "Exact proposal analysis is queued.";
    case "preparing":
      return "Materializing the exact proposed tree.";
    case "analyzing":
      return "Analyzing the exact proposed tree.";
    default:
      return "Preparing exact proposal analysis.";
  }
}

function embedTargetKey(input: {
  readonly threadRef: ScopedThreadRef;
  readonly target: EmbedTarget;
  readonly parentOrigin: string;
  readonly environmentHttpBaseUrl: string;
  readonly embedThreadId: string;
}): string {
  return `${input.threadRef.environmentId}:${input.embedThreadId}:${input.parentOrigin}:${
    input.environmentHttpBaseUrl
  }:${input.target.kind === "current" ? "current" : input.target.generation.generationId}`;
}

function useProposalListRefresh(input: {
  readonly enabled: boolean;
  readonly refresh: () => void;
}): void {
  useEffect(() => {
    if (!input.enabled) return;
    const intervalId = window.setInterval(input.refresh, PROPOSAL_LIST_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [input.enabled, input.refresh]);
}

function useLatestGenerationRefresh(input: {
  readonly enabled: boolean;
  readonly refresh: () => void;
}): void {
  useEffect(() => {
    if (!input.enabled) return;
    const intervalId = window.setInterval(input.refresh, LATEST_GENERATION_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [input.enabled, input.refresh]);
}

function useGenerationRefresh(input: {
  readonly generation: ProposalGeneration | null;
  readonly queryFailed: boolean;
  readonly refresh: () => void;
}): void {
  useEffect(() => {
    if (input.generation === null || input.queryFailed) return;
    const intervalMs =
      input.generation.state === "ready"
        ? READY_GENERATION_REFRESH_MS
        : input.generation.state === "queued" ||
            input.generation.state === "preparing" ||
            input.generation.state === "analyzing"
          ? ACTIVE_GENERATION_REFRESH_MS
          : null;
    if (intervalMs === null) return;
    const intervalId = window.setInterval(input.refresh, intervalMs);
    return () => window.clearInterval(intervalId);
  }, [input.generation, input.queryFailed, input.refresh]);
}

function useImplementationAttemptRefresh(input: {
  readonly enabled: boolean;
  readonly refresh: () => void;
}): void {
  useEffect(() => {
    if (!input.enabled) return;
    const intervalId = window.setInterval(input.refresh, IMPLEMENTATION_ATTEMPT_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [input.enabled, input.refresh]);
}

export function ConnectedExplorerPanel(props: ConnectedExplorerPanelProps) {
  const { resolvedTheme } = useTheme();
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(props.threadRef.environmentId);
  const startProposalGeneration = useAtomCommand(projectEnvironment.startProposalGeneration, {
    reportFailure: false,
  });
  const issueCartographerEmbed = useAtomCommand(projectEnvironment.issueCartographerEmbed, {
    reportFailure: false,
  });
  const closeCartographerEmbed = useAtomCommand(projectEnvironment.closeCartographerEmbed, {
    reportFailure: false,
  });
  const disposedRef = useRef(false);
  const issuedSessionRef = useRef<IssuedEmbedSession | null>(null);
  const closeCartographerEmbedRef = useRef(closeCartographerEmbed);
  closeCartographerEmbedRef.current = closeCartographerEmbed;
  const releaseIssuedSession = useCallback((issued: IssuedEmbedSession): void => {
    void closeCartographerEmbedRef.current({
      environmentId: issued.environmentId,
      input: {
        threadId: issued.threadId,
        sessionId: issued.sessionId,
      },
    });
  }, []);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const issued = issuedSessionRef.current;
      issuedSessionRef.current = null;
      if (issued === null) return;
      releaseIssuedSession(issued);
    };
  }, [props.threadRef.environmentId, props.threadRef.threadId, releaseIssuedSession]);

  const planProposalQuery = useEnvironmentQuery(
    props.proposalPreviewAvailable && props.proposalPlanId !== null
      ? projectEnvironment.findProposalByPlan({
          environmentId: props.threadRef.environmentId,
          input: {
            sourceThreadId: props.threadRef.threadId,
            planId: props.proposalPlanId,
          },
        })
      : null,
  );
  useProposalListRefresh({
    enabled: props.proposalPreviewAvailable && props.proposalPlanId !== null,
    refresh: planProposalQuery.refresh,
  });
  const proposalListQuery = useEnvironmentQuery(
    props.proposalPreviewAvailable && props.proposalPlanId === null
      ? projectEnvironment.listProposals({
          environmentId: props.threadRef.environmentId,
          input: {
            environmentId: props.threadRef.environmentId,
            projectId: props.projectId,
            sourceThreadId: props.threadRef.threadId,
          },
        })
      : null,
  );
  useProposalListRefresh({
    enabled: props.proposalPreviewAvailable && props.proposalPlanId === null,
    refresh: proposalListQuery.refresh,
  });

  const selectedProposal = useMemo(() => {
    if (props.proposalPlanId !== null) {
      const proposal = planProposalQuery.data?.proposal ?? null;
      return proposal !== null &&
        proposal.environmentId === props.threadRef.environmentId &&
        proposal.projectId === props.projectId &&
        proposal.sourceThreadId === props.threadRef.threadId &&
        planProposalQuery.data?.revision.planId === props.proposalPlanId
        ? proposal
        : null;
    }
    return proposalListQuery.data === null
      ? null
      : selectLatestScopedProposal(proposalListQuery.data.proposals, {
          environmentId: props.threadRef.environmentId,
          projectId: props.projectId,
          threadId: props.threadRef.threadId,
        });
  }, [
    planProposalQuery.data,
    proposalListQuery.data,
    props.projectId,
    props.proposalPlanId,
    props.threadRef.environmentId,
    props.threadRef.threadId,
  ]);
  const selectedRevision =
    selectedProposal !== null && props.proposalPlanId !== null
      ? (planProposalQuery.data?.revision.revision ?? null)
      : (selectedProposal?.latestRevision ?? null);
  const proposalSelector =
    selectedProposal === null || selectedRevision === null
      ? null
      : {
          proposalId: selectedProposal.proposalId,
          revision: selectedRevision,
        };
  const proposalSourceThreadId = selectedProposal?.sourceThreadId ?? props.threadRef.threadId;
  const proposalDiscoveryError =
    props.proposalPlanId !== null
      ? planProposalQuery.data === null
        ? planProposalQuery.error
        : null
      : proposalListQuery.data === null
        ? proposalListQuery.error
        : null;
  const proposalDiscoveryPending =
    props.proposalPlanId !== null
      ? planProposalQuery.data === null && planProposalQuery.isPending
      : proposalListQuery.data === null && proposalListQuery.error === null;
  const proposalDiscoverySettledNow =
    props.proposalPlanId !== null
      ? planProposalQuery.data !== null ||
        (!planProposalQuery.isPending && planProposalQuery.error === null)
      : proposalListQuery.data !== null;
  const proposalDiscoveryKey = `${props.threadRef.environmentId}:${
    props.threadRef.threadId
  }:${props.proposalPlanId ?? "latest"}`;
  const [settledProposalDiscoveryKey, setSettledProposalDiscoveryKey] = useState<string | null>(
    null,
  );
  const proposalDiscoverySettled = isProposalDiscoverySettled({
    settledKey: settledProposalDiscoveryKey,
    key: proposalDiscoveryKey,
    settledNow: proposalDiscoverySettledNow,
  });
  useEffect(() => {
    if (!proposalDiscoverySettledNow) return;
    setSettledProposalDiscoveryKey((settledKey) =>
      settledKey === proposalDiscoveryKey ? settledKey : proposalDiscoveryKey,
    );
  }, [proposalDiscoveryKey, proposalDiscoverySettledNow]);
  const proposalQuery = useEnvironmentQuery(
    proposalSelector === null
      ? null
      : projectEnvironment.getProposal({
          environmentId: props.threadRef.environmentId,
          input: proposalSelector,
        }),
  );
  const proposalDiffQuery = useEnvironmentQuery(
    proposalSelector === null
      ? null
      : projectEnvironment.getProposalDiff({
          environmentId: props.threadRef.environmentId,
          input: proposalSelector,
        }),
  );
  const proposalNarrativeQuery = useEnvironmentQuery(
    proposalSelector === null
      ? null
      : projectEnvironment.getProposalNarrative({
          environmentId: props.threadRef.environmentId,
          input: proposalSelector,
        }),
  );
  const implementationAttemptQuery = useEnvironmentQuery(
    proposalSelector === null
      ? null
      : projectEnvironment.latestProposalImplementationAttempt({
          environmentId: props.threadRef.environmentId,
          input: {
            sourceThreadId: proposalSourceThreadId,
            proposalId: proposalSelector.proposalId,
            revision: proposalSelector.revision,
          },
        }),
  );
  useImplementationAttemptRefresh({
    enabled: proposalSelector !== null,
    refresh: implementationAttemptQuery.refresh,
  });
  const latestGenerationQuery = useEnvironmentQuery(
    proposalSelector === null || !props.cartographerAvailable
      ? null
      : projectEnvironment.latestProposalGeneration({
          environmentId: props.threadRef.environmentId,
          input: {
            threadId: proposalSourceThreadId,
            proposalId: proposalSelector.proposalId,
            revision: proposalSelector.revision,
          },
        }),
  );
  useLatestGenerationRefresh({
    enabled: proposalSelector !== null && props.cartographerAvailable,
    refresh: latestGenerationQuery.refresh,
  });

  const revisionKey =
    proposalSelector === null
      ? null
      : `${proposalSelector.proposalId}:${proposalSelector.revision}`;
  const revisionKeyRef = useRef(revisionKey);
  revisionKeyRef.current = revisionKey;
  const generationStartRequestRef = useRef<{ readonly key: string } | null>(null);
  const [generationStartState, setGenerationStartState] = useState<GenerationStartState | null>(
    null,
  );
  const activeGenerationStartState =
    generationStartState?.key === revisionKey ? generationStartState : null;

  const requestProposalGeneration = useCallback(() => {
    if (proposalSelector === null || revisionKey === null) return;
    generationStartRequestRef.current = { key: revisionKey };
    setGenerationStartState({
      key: revisionKey,
      pending: true,
      generation: null,
      error: null,
    });
    void startProposalGeneration({
      environmentId: props.threadRef.environmentId,
      input: {
        threadId: proposalSourceThreadId,
        proposalId: proposalSelector.proposalId,
        revision: proposalSelector.revision,
      },
    }).then((result) => {
      if (revisionKeyRef.current !== revisionKey) return;
      if (result._tag === "Success") {
        setGenerationStartState({
          key: revisionKey,
          pending: false,
          generation: result.value,
          error: null,
        });
        latestGenerationQuery.refresh();
        return;
      }
      setGenerationStartState({
        key: revisionKey,
        pending: false,
        generation: null,
        error: commandFailureMessage(result, "Exact architecture analysis could not start"),
      });
    });
  }, [
    latestGenerationQuery.refresh,
    proposalSourceThreadId,
    proposalSelector,
    props.threadRef.environmentId,
    revisionKey,
    startProposalGeneration,
  ]);

  useEffect(() => {
    if (
      !props.cartographerAvailable ||
      proposalSelector === null ||
      revisionKey === null ||
      proposalQuery.data === null ||
      (latestGenerationQuery.isPending && latestGenerationQuery.data === null) ||
      (latestGenerationQuery.error !== null && latestGenerationQuery.data === null) ||
      latestGenerationQuery.data !== null ||
      activeGenerationStartState !== null ||
      generationStartRequestRef.current?.key === revisionKey
    ) {
      return;
    }
    requestProposalGeneration();
  }, [
    activeGenerationStartState,
    latestGenerationQuery.data,
    latestGenerationQuery.error,
    latestGenerationQuery.isPending,
    proposalQuery.data,
    proposalSelector,
    props.cartographerAvailable,
    requestProposalGeneration,
    revisionKey,
  ]);

  const generationSeed =
    activeGenerationStartState?.generation ?? latestGenerationQuery.data ?? null;
  const generationQuery = useEnvironmentQuery(
    generationSeed === null
      ? null
      : projectEnvironment.getProposalGeneration({
          environmentId: props.threadRef.environmentId,
          input: {
            threadId: proposalSourceThreadId,
            generationId: generationSeed.generationId,
          },
        }),
  );
  const generation = generationQuery.data ?? generationSeed;
  useGenerationRefresh({
    generation,
    queryFailed: generationQuery.error !== null,
    refresh: generationQuery.refresh,
  });

  const proposal: ProposalDiffPresentation | null =
    proposalQuery.data === null
      ? null
      : {
          proposalId: proposalQuery.data.proposal.proposalId,
          revisionNumber: proposalQuery.data.revision.revision,
          snapshotTreeOid: proposalQuery.data.revision.baseSnapshot.workingTreeOid,
          exactDiff: proposalDiffQuery.data?.diff ?? "",
          operationCount: proposalQuery.data.revision.manifest.operationCount,
          byteCount: proposalQuery.data.revision.diffByteLength,
        };
  const proposalAvailability: ProposalDiffAvailability = !props.proposalPreviewAvailable
    ? {
        kind: "unsupported",
        reason: "This server does not support immutable proposal previews.",
      }
    : proposalDiscoveryError !== null
      ? { kind: "error", message: proposalDiscoveryError }
      : proposalDiscoveryPending
        ? { kind: "loading" }
        : proposalDiscoverySettled && selectedProposal === null
          ? {
              kind: "unsupported",
              reason:
                props.proposalPlanId === null
                  ? "No immutable proposal revision exists for this thread."
                  : "No immutable proposal revision is linked to this exact plan.",
            }
          : proposalQuery.error !== null && proposalQuery.data === null
            ? { kind: "error", message: proposalQuery.error }
            : proposalQuery.data === null ||
                (proposalDiffQuery.isPending && proposalDiffQuery.data === null)
              ? { kind: "loading" }
              : proposalDiffQuery.error !== null && proposalDiffQuery.data === null
                ? { kind: "error", message: proposalDiffQuery.error }
                : proposalDiffQuery.data === null || !proposalDiscoverySettled
                  ? { kind: "loading" }
                  : { kind: "ready" };

  const narrative: ExplorerNarrativePresentation = !props.proposalPreviewAvailable
    ? {
        kind: "empty",
        message: "No safe proposal narrative is available for this thread.",
      }
    : proposalDiscoveryError !== null
      ? { kind: "error", message: proposalDiscoveryError }
      : proposalDiscoveryPending
        ? { kind: "loading" }
        : selectedProposal === null
          ? {
              kind: "empty",
              message:
                props.proposalPlanId === null
                  ? "No safe proposal narrative is available for this thread."
                  : "No safe proposal narrative is linked to this exact plan.",
            }
          : proposalNarrativeQuery.error !== null && proposalNarrativeQuery.data === null
            ? { kind: "error", message: proposalNarrativeQuery.error }
            : proposalNarrativeQuery.isPending && proposalNarrativeQuery.data === null
              ? { kind: "loading" }
              : proposalNarrativeQuery.data === null
                ? {
                    kind: "empty",
                    message: "No safe proposal narrative is available for this revision.",
                  }
                : {
                    kind: "ready",
                    document: proposalNarrativeQuery.data.document.document,
                    source: proposalNarrativeQuery.data.document.source,
                    documentPath: proposalNarrativeQuery.data.document.relativePath,
                  };
  const attempt =
    implementationAttemptQuery.data === null
      ? null
      : {
          outcome: implementationAttemptQuery.data.outcome,
          matchedOperationCount: implementationAttemptQuery.data.matchedOperationCount,
          intendedOperationCount: implementationAttemptQuery.data.intendedOperationCount,
        };

  const parentOrigin =
    typeof window === "undefined" ? null : resolveCartographerParentOrigin(window.location);
  const embedTarget: EmbedTarget | null =
    !props.cartographerAvailable ||
    parentOrigin === null ||
    environmentHttpBaseUrl === null ||
    (props.proposalPreviewAvailable &&
      (proposalDiscoveryError !== null || !proposalDiscoverySettled))
      ? null
      : selectedProposal === null
        ? { kind: "current" }
        : generation?.state === "ready"
          ? { kind: "proposal", generation }
          : null;
  const embedThreadId =
    embedTarget?.kind === "proposal" ? proposalSourceThreadId : props.threadRef.threadId;
  const targetKey =
    embedTarget === null || parentOrigin === null || environmentHttpBaseUrl === null
      ? null
      : embedTargetKey({
          threadRef: props.threadRef,
          target: embedTarget,
          parentOrigin,
          environmentHttpBaseUrl,
          embedThreadId,
        });
  const embedRequestRef = useRef<EmbedRequestIdentity | null>(null);
  const embedRequestSequenceRef = useRef(0);
  const embedTargetKeyRef = useRef<string | null>(null);
  const [embedRequestState, setEmbedRequestState] = useState<EmbedRequestState | null>(null);
  const activeEmbedRequestState = embedRequestState?.key === targetKey ? embedRequestState : null;

  useEffect(() => {
    const issued = issuedSessionRef.current;
    const transition = resolveEmbedTargetTransition({
      previousTargetKey: embedTargetKeyRef.current,
      nextTargetKey: targetKey,
      issuedSessionKey: issued?.key ?? null,
    });
    if (!transition.invalidateRequest) return;
    embedTargetKeyRef.current = targetKey;
    embedRequestRef.current = null;
    setEmbedRequestState(null);

    if (issued === null || !transition.releaseIssuedSession) return;
    issuedSessionRef.current = null;
    releaseIssuedSession(issued);
  }, [releaseIssuedSession, targetKey]);

  useEffect(() => {
    if (
      embedTarget === null ||
      targetKey === null ||
      parentOrigin === null ||
      embedRequestRef.current?.key === targetKey
    ) {
      return;
    }
    embedRequestSequenceRef.current += 1;
    const request = {
      key: targetKey,
      requestId: embedRequestSequenceRef.current,
    };
    embedRequestRef.current = request;
    setEmbedRequestState({ key: targetKey, kind: "loading" });
    void issueCartographerEmbed({
      environmentId: props.threadRef.environmentId,
      input: {
        threadId: embedThreadId,
        ...(embedTarget.kind === "proposal"
          ? { generationId: embedTarget.generation.generationId }
          : {}),
        parentOrigin,
        theme: resolvedTheme,
      },
    }).then((result) => {
      if (!isCurrentEmbedRequest(embedRequestRef.current, request)) {
        if (result._tag === "Success") {
          releaseIssuedSession({
            key: targetKey,
            environmentId: props.threadRef.environmentId,
            threadId: embedThreadId,
            sessionId: result.value.sessionId,
          });
        }
        return;
      }
      if (result._tag === "Success") {
        const issued = {
          key: targetKey,
          environmentId: props.threadRef.environmentId,
          threadId: embedThreadId,
          sessionId: result.value.sessionId,
        };
        if (disposedRef.current) {
          releaseIssuedSession(issued);
          return;
        }
        const previous = issuedSessionRef.current;
        issuedSessionRef.current = issued;
        if (
          previous !== null &&
          (previous.environmentId !== issued.environmentId ||
            previous.threadId !== issued.threadId ||
            previous.sessionId !== issued.sessionId)
        ) {
          releaseIssuedSession(previous);
        }
      }
      setEmbedRequestState(
        result._tag === "Success"
          ? { key: targetKey, kind: "ready", result: result.value }
          : {
              key: targetKey,
              kind: "error",
              message: commandFailureMessage(
                result,
                "The authenticated Cartographer session could not start",
              ),
            },
      );
    });
  }, [
    embedTarget,
    issueCartographerEmbed,
    parentOrigin,
    embedThreadId,
    props.threadRef.environmentId,
    releaseIssuedSession,
    resolvedTheme,
    targetKey,
  ]);

  const architecture: ExplorerArchitecturePresentation = (() => {
    if (!props.cartographerAvailable) {
      return {
        kind: "unavailable",
        reason: "Cartographer is not configured for this server environment.",
      };
    }
    if (parentOrigin === null) {
      return {
        kind: "unavailable",
        reason: "This client URL cannot provide an exact Cartographer parent origin.",
      };
    }
    if (environmentHttpBaseUrl === null) {
      return {
        kind: "loading",
        message: "Preparing the authenticated environment connection.",
      };
    }
    if (props.proposalPreviewAvailable && proposalDiscoveryError !== null) {
      return { kind: "error", message: proposalDiscoveryError };
    }
    if (props.proposalPreviewAvailable && !proposalDiscoverySettled) {
      return {
        kind: "loading",
        message:
          props.proposalPlanId === null
            ? "Looking for immutable proposal revisions."
            : "Looking up the immutable revision linked to this exact plan.",
      };
    }
    if (selectedProposal !== null) {
      if (proposalQuery.error !== null && proposalQuery.data === null) {
        return { kind: "error", message: proposalQuery.error };
      }
      if (proposalQuery.data === null) {
        return { kind: "loading", message: "Loading the selected proposal revision." };
      }
      if (latestGenerationQuery.error !== null && latestGenerationQuery.data === null) {
        return { kind: "error", message: latestGenerationQuery.error };
      }
      if (generationQuery.error !== null && generationQuery.data === null) {
        return { kind: "error", message: generationQuery.error };
      }
      if (activeGenerationStartState?.pending) {
        return { kind: "loading", message: "Starting exact proposal analysis." };
      }
      if (generation === null && activeGenerationStartState?.error) {
        return {
          kind: "error",
          message: activeGenerationStartState.error,
          retry: requestProposalGeneration,
        };
      }
      if (generation === null) {
        return {
          kind: "loading",
          message: "Checking for exact proposal analysis.",
        };
      }
      if (
        generation.state === "failed" ||
        generation.state === "cancelled" ||
        generation.state === "abandoned"
      ) {
        return {
          kind: "error",
          message: generationFailureMessage(generation),
          retry: requestProposalGeneration,
        };
      }
      if (
        generation.state === "queued" ||
        generation.state === "preparing" ||
        generation.state === "analyzing"
      ) {
        return { kind: "loading", message: generationLoadingMessage(generation) };
      }
    }
    if (embedTarget === null || targetKey === null || activeEmbedRequestState === null) {
      return {
        kind: "loading",
        message:
          selectedProposal === null
            ? "Starting current-worktree architecture exploration."
            : "Starting exact proposed-tree architecture exploration.",
      };
    }
    if (activeEmbedRequestState.kind === "loading") {
      return {
        kind: "loading",
        message: "Starting the authenticated Cartographer session.",
      };
    }
    if (activeEmbedRequestState.kind === "error") {
      return { kind: "error", message: activeEmbedRequestState.message };
    }
    const embedLocation = resolveCartographerEmbedLocation(
      environmentHttpBaseUrl,
      activeEmbedRequestState.result.url,
    );
    if (embedLocation === null) {
      return {
        kind: "error",
        message: "The issued Cartographer URL did not match the authenticated environment.",
      };
    }
    return {
      kind: "ready",
      url: embedLocation.url,
      expectedOrigin: embedLocation.expectedOrigin,
      generationId: embedTarget.kind === "proposal" ? embedTarget.generation.generationId : null,
      authority:
        embedTarget.kind === "proposal" ? embedTarget.generation.authority : "authoritative",
      freshness: embedTarget.kind === "proposal" ? embedTarget.generation.freshness : "fresh",
      freshnessScope: embedTarget.kind === "proposal" ? "verified-generation" : "capture-only",
    };
  })();

  return (
    <ExplorerPanel
      threadRef={props.threadRef}
      narrative={narrative}
      proposal={proposal}
      proposalAvailability={proposalAvailability}
      architecture={architecture}
      attempt={attempt}
      onOpenFile={props.onOpenFile}
      onSelectFile={props.onSelectFile}
    />
  );
}
