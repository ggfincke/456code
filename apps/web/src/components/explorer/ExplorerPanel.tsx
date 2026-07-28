// apps/web/src/components/explorer/ExplorerPanel.tsx
// presents proposal narrative, exact code changes, and isolated architecture analysis
import type {
  ImplementationAttemptOutcome,
  MdxSafeDocument,
  ProposalGenerationAuthority,
  ProposalGenerationFreshness,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { BookOpenText, FileDiff, Network } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/* oxlint-disable react/iframe-missing-sandbox -- authenticated cartographer needs scripts plus same-origin proxy access */

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";

import { SafeDocumentRenderer } from "../files/SafeDocumentRenderer";
import {
  ProposalDiffPanel,
  type ProposalDiffAvailability,
  type ProposalDiffPresentation,
} from "../proposals/ProposalDiffPanel";
import {
  CARTOGRAPHER_BRIDGE_PROTOCOL,
  CARTOGRAPHER_BRIDGE_VERSION,
  postCartographerHostMessage,
  readCartographerFrameMessage,
  type CartographerHostMessage,
  type CartographerLifecycleState,
} from "./explorerBridge";

export type ExplorerTab = "narrative" | "code-changes" | "architecture";

export type ExplorerNarrativePresentation =
  | { readonly kind: "loading" }
  | { readonly kind: "empty"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly document: MdxSafeDocument;
      readonly source: string;
      readonly documentPath: string;
    };

export type ExplorerArchitecturePresentation =
  | { readonly kind: "loading"; readonly message?: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string; readonly retry?: () => void }
  | {
      readonly kind: "ready";
      readonly url: string;
      readonly expectedOrigin: string;
      readonly generationId: string | null;
      readonly authority: ProposalGenerationAuthority;
      readonly freshness: ProposalGenerationFreshness;
      readonly freshnessScope: "verified-generation" | "capture-only";
    };

export interface ExplorerImplementationAttemptPresentation {
  readonly outcome: ImplementationAttemptOutcome;
  readonly matchedOperationCount: number;
  readonly intendedOperationCount: number;
}

export interface ExplorerPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly narrative: ExplorerNarrativePresentation;
  readonly proposal: ProposalDiffPresentation | null;
  readonly proposalAvailability?: ProposalDiffAvailability;
  readonly architecture: ExplorerArchitecturePresentation;
  readonly attempt?: ExplorerImplementationAttemptPresentation | null;
  readonly defaultTab?: ExplorerTab;
  readonly onOpenFile: (path: string, line?: number) => void;
  readonly onSelectFile?: (path: string | null) => void;
}

type ArchitectureFileAction = "selection" | "open";

export function explorerArchitectureFileDestination(input: {
  readonly proposalSelected: boolean;
  readonly action: ArchitectureFileAction;
}): "proposal-diff" | "current-selection" | "current-file" {
  if (input.proposalSelected) return "proposal-diff";
  return input.action === "selection" ? "current-selection" : "current-file";
}

interface FrameLifecycle {
  readonly state: CartographerLifecycleState;
  readonly message: string | null;
}

const EXPLORER_TABS = [
  { id: "narrative", label: "Narrative", icon: BookOpenText },
  { id: "code-changes", label: "Code Changes", icon: FileDiff },
  { id: "architecture", label: "Architecture", icon: Network },
] as const satisfies ReadonlyArray<{
  readonly id: ExplorerTab;
  readonly label: string;
  readonly icon: typeof BookOpenText;
}>;

function StateMessage(props: {
  readonly title: string;
  readonly message: string;
  readonly tone?: "neutral" | "error" | "warning";
  readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center",
        props.tone === "error" && "text-destructive",
        props.tone === "warning" && "text-amber-700 dark:text-amber-200",
      )}
      role={props.tone === "error" ? "alert" : "status"}
    >
      <div className="max-w-md">
        <p className="text-sm font-medium">{props.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.message}</p>
        {props.action ? (
          <button
            type="button"
            className="mt-3 inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted"
            onClick={props.action.onClick}
          >
            {props.action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NarrativeView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly narrative: ExplorerNarrativePresentation;
  readonly onOpenFile: (path: string, line?: number) => void;
}) {
  switch (props.narrative.kind) {
    case "loading":
      return (
        <StateMessage title="Loading narrative" message="Preparing the safe proposal document." />
      );
    case "empty":
      return <StateMessage title="No narrative" message={props.narrative.message} />;
    case "error":
      return (
        <StateMessage
          title="Narrative unavailable"
          message={props.narrative.message}
          tone="error"
        />
      );
    case "ready":
      return (
        <SafeDocumentRenderer
          document={props.narrative.document}
          source={props.narrative.source}
          documentPath={props.narrative.documentPath}
          environmentId={props.threadRef.environmentId}
          threadId={props.threadRef.threadId}
          onOpenFile={props.onOpenFile}
        />
      );
  }
}

function messageOrigin(url: URL): string {
  return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
}

function resolveEmbedUrl(url: string, expectedOrigin: string): string | null {
  try {
    const base =
      typeof window === "undefined"
        ? `${expectedOrigin.replace(/\/+$/u, "")}/`
        : window.location.href;
    const resolved = new URL(url, base);
    if (
      resolved.protocol !== "http:" &&
      resolved.protocol !== "https:" &&
      resolved.protocol !== "code456:" &&
      resolved.protocol !== "code456-dev:"
    ) {
      return null;
    }
    return messageOrigin(resolved) === expectedOrigin ? resolved.href : null;
  } catch {
    return null;
  }
}

function lifecycleBanner(
  lifecycle: FrameLifecycle,
  freshness: ProposalGenerationFreshness,
  authority: ProposalGenerationAuthority,
): { readonly tone: "neutral" | "warning" | "error"; readonly message: string } | null {
  if (lifecycle.state === "error") {
    return { tone: "error", message: lifecycle.message ?? "Cartographer reported an error." };
  }
  if (lifecycle.state === "shutdown") {
    return { tone: "error", message: lifecycle.message ?? "Cartographer stopped." };
  }
  if (freshness !== "fresh" || lifecycle.state === "stale") {
    const reason =
      freshness === "fresh"
        ? lifecycle.message
        : `Analysis freshness: ${freshness.replaceAll("-", " ")}.`;
    return {
      tone: "warning",
      message: reason ?? "This architecture analysis is stale.",
    };
  }
  if (lifecycle.state === "indexing") {
    return { tone: "neutral", message: lifecycle.message ?? "Indexing architecture…" };
  }
  return authority === "estimated"
    ? {
        tone: "warning",
        message: "This architecture impact is an estimate, not an authoritative exact analysis.",
      }
    : null;
}

function ArchitectureFrame(props: {
  readonly url: string;
  readonly expectedOrigin: string;
  readonly generationId: string | null;
  readonly authority: ProposalGenerationAuthority;
  readonly freshness: ProposalGenerationFreshness;
  readonly freshnessScope: "verified-generation" | "capture-only";
  readonly onOpenFile: (path: string, line?: number) => void;
  readonly onSelectFile?: (path: string | null) => void;
}) {
  const { resolvedTheme } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [lifecycle, setLifecycle] = useState<FrameLifecycle>({
    state: "indexing",
    message: null,
  });
  const resolvedUrl = resolveEmbedUrl(props.url, props.expectedOrigin);

  const post = (message: CartographerHostMessage): void => {
    postCartographerHostMessage(
      frameRef.current?.contentWindow ?? null,
      props.expectedOrigin,
      message,
    );
  };

  const postCurrentContext = (): void => {
    post({
      protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
      version: CARTOGRAPHER_BRIDGE_VERSION,
      type: "theme-changed",
      theme: resolvedTheme,
    });
    if (props.generationId !== null && props.generationId.length > 0) {
      post({
        protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
        version: CARTOGRAPHER_BRIDGE_VERSION,
        type: "proposal-generation-changed",
        generationId: props.generationId,
      });
    }
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const message = readCartographerFrameMessage(event, {
        frameWindow: frameRef.current?.contentWindow ?? null,
        expectedOrigin: props.expectedOrigin,
      });
      if (!message) return;
      switch (message.type) {
        case "lifecycle":
          setLifecycle({ state: message.state, message: message.message ?? null });
          break;
        case "selection-changed":
          props.onSelectFile?.(message.file);
          break;
        case "open-source":
          props.onOpenFile(message.file, message.line);
          break;
        case "fatal-error":
          setLifecycle({ state: "error", message: message.message });
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [props.expectedOrigin, props.onOpenFile, props.onSelectFile]);

  useEffect(() => {
    postCartographerHostMessage(frameRef.current?.contentWindow ?? null, props.expectedOrigin, {
      protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
      version: CARTOGRAPHER_BRIDGE_VERSION,
      type: "theme-changed",
      theme: resolvedTheme,
    });
  }, [props.expectedOrigin, resolvedTheme]);

  useEffect(() => {
    if (props.generationId === null || props.generationId.length === 0) return;
    postCartographerHostMessage(frameRef.current?.contentWindow ?? null, props.expectedOrigin, {
      protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
      version: CARTOGRAPHER_BRIDGE_VERSION,
      type: "proposal-generation-changed",
      generationId: props.generationId,
    });
  }, [props.expectedOrigin, props.generationId]);

  useEffect(
    () => () => {
      postCartographerHostMessage(frameRef.current?.contentWindow ?? null, props.expectedOrigin, {
        protocol: CARTOGRAPHER_BRIDGE_PROTOCOL,
        version: CARTOGRAPHER_BRIDGE_VERSION,
        type: "shutdown",
      });
    },
    [props.expectedOrigin],
  );

  if (resolvedUrl === null) {
    return (
      <StateMessage
        title="Architecture unavailable"
        message="The authenticated Cartographer URL did not match its expected origin."
        tone="error"
      />
    );
  }

  const banner = lifecycleBanner(lifecycle, props.freshness, props.authority);
  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden"
      data-explorer-lifecycle={lifecycle.state}
    >
      <iframe
        ref={frameRef}
        src={resolvedUrl}
        title="Cartographer architecture explorer"
        className="min-h-0 flex-1 border-0 bg-background"
        sandbox="allow-same-origin allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={postCurrentContext}
      />
      {banner ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-3 top-3 z-10 rounded-md border px-3 py-2 text-xs shadow-sm",
            banner.tone === "neutral" && "border-border bg-background/95 text-muted-foreground",
            banner.tone === "warning" &&
              "border-amber-500/30 bg-amber-50/95 text-amber-900 dark:bg-amber-950/95 dark:text-amber-100",
            banner.tone === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
          )}
          role={banner.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {banner.message}
        </div>
      ) : null}
    </div>
  );
}

function ArchitectureView(props: {
  readonly architecture: ExplorerArchitecturePresentation;
  readonly onOpenFile: (path: string, line?: number) => void;
  readonly onSelectFile?: (path: string | null) => void;
}) {
  switch (props.architecture.kind) {
    case "loading":
      return (
        <StateMessage
          title="Loading architecture"
          message={props.architecture.message ?? "Preparing authenticated analysis artifacts."}
        />
      );
    case "unavailable":
      return <StateMessage title="Architecture unavailable" message={props.architecture.reason} />;
    case "error":
      return (
        <StateMessage
          title="Architecture unavailable"
          message={props.architecture.message}
          tone="error"
          {...(props.architecture.retry
            ? {
                action: {
                  label: "Retry analysis",
                  onClick: props.architecture.retry,
                },
              }
            : {})}
        />
      );
    case "ready":
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {props.architecture.freshnessScope === "capture-only" ? (
            <p
              className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-4 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200"
              data-current-architecture-snapshot-disclosure
            >
              This is an on-demand snapshot captured when Explorer opened. Worktree edits are not
              watched; close and reopen Explorer to refresh it.
            </p>
          ) : null}
          <p
            className="shrink-0 border-b border-border/70 bg-muted/20 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground"
            data-architecture-unknown-symbol-disclosure
          >
            Namespace, star, and dynamic imports without symbol evidence are conservatively treated
            as affecting unknown/all symbols.
          </p>
          <ArchitectureFrame
            key={`${props.architecture.expectedOrigin}:${props.architecture.url}:${props.architecture.generationId ?? "current"}`}
            {...props.architecture}
            onOpenFile={props.onOpenFile}
            {...(props.onSelectFile ? { onSelectFile: props.onSelectFile } : {})}
          />
        </div>
      );
  }
}

function attemptMessage(attempt: ExplorerImplementationAttemptPresentation): {
  readonly tone: "neutral" | "success" | "warning" | "error";
  readonly text: string;
} {
  switch (attempt.outcome) {
    case "pending":
      return { tone: "neutral", text: "Implementation comparison is pending." };
    case "matched":
      return { tone: "success", text: "The implementation matches this proposal revision." };
    case "partial":
      return {
        tone: "warning",
        text: `The implementation partially matches this proposal revision (${attempt.matchedOperationCount} of ${attempt.intendedOperationCount} intended operations).`,
      };
    case "divergent":
      return { tone: "error", text: "The implementation diverges from this proposal revision." };
  }
}

function AttemptOutcome(props: {
  readonly attempt: ExplorerImplementationAttemptPresentation | null | undefined;
}) {
  if (!props.attempt) return null;
  const message = attemptMessage(props.attempt);
  return (
    <div
      className={cn(
        "border-b px-4 py-2 text-xs",
        message.tone === "neutral" && "border-border bg-muted/30 text-muted-foreground",
        message.tone === "success" && "border-success/20 bg-success/8 text-success",
        message.tone === "warning" &&
          "border-amber-500/20 bg-amber-500/8 text-amber-800 dark:text-amber-200",
        message.tone === "error" && "border-destructive/20 bg-destructive/8 text-destructive",
      )}
      role="status"
      data-implementation-outcome={props.attempt.outcome}
    >
      {message.text}
    </div>
  );
}

// inactive panels stay mounted because authenticated iframe tickets are one-use
function TabPanel(props: {
  readonly id: ExplorerTab;
  readonly activeTab: ExplorerTab;
  readonly children: ReactNode;
}) {
  const active = props.id === props.activeTab;
  return (
    <div
      id={`explorer-panel-${props.id}`}
      role="tabpanel"
      aria-labelledby={`explorer-tab-${props.id}`}
      hidden={!active}
      className={cn("min-h-0 flex-1 flex-col", active ? "flex" : "hidden")}
    >
      {props.children}
    </div>
  );
}

function UnavailableCodeChanges(props: {
  readonly availability: ProposalDiffAvailability | undefined;
}) {
  if (props.availability?.kind === "loading") {
    return (
      <StateMessage
        title="Loading code changes"
        message="Loading the immutable proposal revision and its exact diff."
      />
    );
  }
  if (props.availability?.kind === "error") {
    return (
      <StateMessage
        title="Code changes unavailable"
        message={props.availability.message}
        tone="error"
      />
    );
  }
  return (
    <StateMessage
      title="Code changes unavailable"
      message={
        props.availability?.kind === "unsupported"
          ? props.availability.reason
          : "No immutable proposal revision is selected."
      }
    />
  );
}

export function ExplorerPanel(props: ExplorerPanelProps) {
  const [activeTab, setActiveTab] = useState<ExplorerTab>(props.defaultTab ?? "narrative");
  const proposalScopeKey = props.proposal
    ? `${props.proposal.proposalId ?? props.proposal.snapshotTreeOid}:${props.proposal.revisionNumber}`
    : null;
  const [proposalDiffSelection, setProposalDiffSelection] = useState<{
    readonly scopeKey: string;
    readonly filePath: string | null;
    readonly revealRequestId: number;
  } | null>(null);
  const activeProposalDiffSelection =
    proposalDiffSelection?.scopeKey === proposalScopeKey ? proposalDiffSelection : null;
  const revealProposalFile = (filePath: string | null): void => {
    if (proposalScopeKey === null) return;
    setProposalDiffSelection((current) => ({
      scopeKey: proposalScopeKey,
      filePath,
      revealRequestId: current?.scopeKey === proposalScopeKey ? current.revealRequestId + 1 : 1,
    }));
  };
  const handleArchitectureSelection = (filePath: string | null): void => {
    const destination = explorerArchitectureFileDestination({
      proposalSelected: proposalScopeKey !== null,
      action: "selection",
    });
    if (destination === "proposal-diff") {
      revealProposalFile(filePath);
      return;
    }
    props.onSelectFile?.(filePath);
  };
  const handleArchitectureOpen = (filePath: string, line?: number): void => {
    const destination = explorerArchitectureFileDestination({
      proposalSelected: proposalScopeKey !== null,
      action: "open",
    });
    if (destination === "proposal-diff") {
      revealProposalFile(filePath);
      setActiveTab("code-changes");
      return;
    }
    props.onOpenFile(filePath, line);
  };
  const proposalLabel = props.proposal
    ? `Preview of proposal revision ${props.proposal.revisionNumber} against workspace snapshot ${props.proposal.snapshotTreeOid}`
    : "Current worktree snapshot";

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background" aria-label="Explorer">
      <header className="shrink-0 border-b border-border bg-card/40">
        <p className="truncate px-4 pt-3 text-xs font-medium text-foreground" title={proposalLabel}>
          {proposalLabel}
        </p>
        <div className="flex gap-1 px-2 pt-2" role="tablist" aria-label="Explorer views">
          {EXPLORER_TABS.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`explorer-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`explorer-panel-${tab.id}`}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs transition-colors",
                  selected
                    ? "border-border bg-background text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon className="size-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>
      <AttemptOutcome attempt={props.attempt} />
      <TabPanel id="narrative" activeTab={activeTab}>
        <NarrativeView
          threadRef={props.threadRef}
          narrative={props.narrative}
          onOpenFile={props.onOpenFile}
        />
      </TabPanel>
      <TabPanel id="code-changes" activeTab={activeTab}>
        {props.proposal ? (
          <ProposalDiffPanel
            proposal={props.proposal}
            composerDraftTarget={props.threadRef}
            {...(props.proposalAvailability ? { availability: props.proposalAvailability } : {})}
            onOpenFile={props.onOpenFile}
            selectedFilePath={activeProposalDiffSelection?.filePath ?? null}
            selectedFileRevealRequestId={activeProposalDiffSelection?.revealRequestId ?? 0}
          />
        ) : (
          <UnavailableCodeChanges availability={props.proposalAvailability} />
        )}
      </TabPanel>
      <TabPanel id="architecture" activeTab={activeTab}>
        <ArchitectureView
          architecture={props.architecture}
          onOpenFile={handleArchitectureOpen}
          onSelectFile={handleArchitectureSelection}
        />
      </TabPanel>
    </section>
  );
}
