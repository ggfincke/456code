// apps/web/src/components/proposals/ProposalDiffPanel.tsx
// presents immutable proposal metadata with its exact native code diff
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { type DraftId } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";

import { DiffPanelShell, type DiffPanelMode } from "../DiffPanelShell";
import {
  NativeDiffSurface,
  NativeDiffSurfaceControls,
  type NativeDiffRenderMode,
  useNativeDiffSurfaceController,
} from "../diffs/NativeDiffSurface";

export interface ProposalDiffPresentation {
  readonly proposalId?: string;
  readonly revisionNumber: number;
  readonly snapshotTreeOid: string;
  readonly exactDiff: string;
  readonly operationCount?: number;
  readonly byteCount?: number;
}

export type ProposalDiffAvailability =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

function formatCount(value: number, singular: string, plural: string): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

export function ProposalDiffPanel(props: {
  readonly proposal: ProposalDiffPresentation;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly availability?: ProposalDiffAvailability;
  readonly mode?: DiffPanelMode;
  readonly onOpenFile?: (filePath: string) => void;
  readonly selectedFilePath?: string | null;
  readonly selectedFileRevealRequestId?: number;
}) {
  const {
    proposal,
    composerDraftTarget,
    availability = { kind: "ready" },
    mode = "embedded",
    onOpenFile,
    selectedFilePath = null,
    selectedFileRevealRequestId = 0,
  } = props;
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [renderMode, setRenderMode] = useState<NativeDiffRenderMode>("stacked");
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const revisionScope = `proposal:${proposal.proposalId ?? proposal.snapshotTreeOid}:${proposal.revisionNumber}`;
  const isReady = availability.kind === "ready";
  const diffSurface = useNativeDiffSurfaceController({
    source: {
      patch: isReady ? proposal.exactDiff : undefined,
      cacheScope: `${revisionScope}:${resolvedTheme}`,
    },
    collapseScopeKey: revisionScope,
    selectedFilePath,
    selectedFileRevealRequestId,
  });
  const label = `Preview of proposal revision ${proposal.revisionNumber} against workspace snapshot ${proposal.snapshotTreeOid}`;
  const metadata = [
    proposal.operationCount === undefined
      ? null
      : formatCount(proposal.operationCount, "operation", "operations"),
    proposal.byteCount === undefined ? null : formatCount(proposal.byteCount, "byte", "bytes"),
  ].filter((value): value is string => value !== null);
  const error = availability.kind === "error" ? availability.message : null;
  const emptyMessage =
    availability.kind === "unsupported"
      ? `Exact proposal diff is unsupported: ${availability.reason}`
      : availability.kind === "error"
        ? "The exact proposal diff could not be loaded."
        : diffSurface.hasNoNetChanges
          ? "This proposal revision contains no textual changes."
          : "No exact diff is available for this proposal revision.";

  const header = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 [-webkit-app-region:no-drag]">
        <p className="truncate text-xs font-medium text-foreground" title={label}>
          {label}
        </p>
        {metadata.length > 0 && (
          <p className="truncate text-[11px] tabular-nums text-muted-foreground">
            {metadata.join(" · ")}
          </p>
        )}
      </div>
      <NativeDiffSurfaceControls
        controller={diffSurface}
        renderMode={renderMode}
        onRenderModeChange={setRenderMode}
        wordWrap={wordWrap}
        onWordWrapChange={setWordWrap}
      />
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={header}>
      <NativeDiffSurface
        controller={diffSurface}
        collapseScopeKey={revisionScope}
        sectionId={revisionScope}
        sectionTitle={`Proposal revision ${proposal.revisionNumber}`}
        composerDraftTarget={composerDraftTarget}
        resolvedTheme={resolvedTheme}
        renderMode={renderMode}
        wordWrap={wordWrap}
        loading={availability.kind === "loading"}
        loadingLabel={`Loading exact diff for proposal revision ${proposal.revisionNumber}...`}
        error={error}
        emptyMessage={emptyMessage}
        {...(onOpenFile ? { onOpenFile } : {})}
      />
    </DiffPanelShell>
  );
}
