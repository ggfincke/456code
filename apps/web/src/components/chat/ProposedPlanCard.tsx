// apps/web/src/components/chat/ProposedPlanCard.tsx
// renders proposed plans, exact preview identity, and export actions
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationProposedPlanId,
  ProposalGeneration,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { memo, useEffect, useId, useRef, useState } from "react";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRightPanelStore } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planId,
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
}: {
  planId: OrchestrationProposedPlanId;
  planMarkdown: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const proposalPreviewAvailable = serverConfig?.environment.capabilities.proposalPreview === true;
  const cartographerAvailable = serverConfig?.environment.capabilities.cartographerEmbed === true;
  const planProposalQuery = useEnvironmentQuery(
    proposalPreviewAvailable && threadRef
      ? projectEnvironment.findProposalByPlan({
          environmentId,
          input: {
            sourceThreadId: threadRef.threadId,
            planId,
          },
        })
      : null,
  );
  const exactPlanProposal =
    threadRef &&
    planProposalQuery.data?.proposal.sourceThreadId === threadRef.threadId &&
    planProposalQuery.data.revision.planId === planId
      ? planProposalQuery.data
      : null;
  const canOpenExplorer =
    threadRef !== undefined && (proposalPreviewAvailable || cartographerAvailable);
  const revisionKey =
    exactPlanProposal === null
      ? null
      : `${exactPlanProposal.proposal.proposalId}:${exactPlanProposal.revision.revision}`;
  const latestGenerationQuery = useEnvironmentQuery(
    exactPlanProposal !== null && threadRef && cartographerAvailable
      ? projectEnvironment.latestProposalGeneration({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            proposalId: exactPlanProposal.proposal.proposalId,
            revision: exactPlanProposal.revision.revision,
          },
        })
      : null,
  );
  const startProposalGeneration = useAtomCommand(projectEnvironment.startProposalGeneration, {
    reportFailure: false,
  });
  const generationStartRef = useRef<string | null>(null);
  const [startedGeneration, setStartedGeneration] = useState<{
    readonly key: string;
    readonly generation: ProposalGeneration;
  } | null>(null);

  useEffect(() => {
    if (
      exactPlanProposal === null ||
      !threadRef ||
      !cartographerAvailable ||
      revisionKey === null ||
      latestGenerationQuery.isPending ||
      latestGenerationQuery.error !== null ||
      latestGenerationQuery.data !== null ||
      generationStartRef.current === revisionKey
    ) {
      return;
    }
    generationStartRef.current = revisionKey;
    void startProposalGeneration({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        proposalId: exactPlanProposal.proposal.proposalId,
        revision: exactPlanProposal.revision.revision,
      },
    }).then((result) => {
      if (result._tag !== "Success") return;
      setStartedGeneration({ key: revisionKey, generation: result.value });
      latestGenerationQuery.refresh();
    });
  }, [
    cartographerAvailable,
    environmentId,
    exactPlanProposal,
    latestGenerationQuery.data,
    latestGenerationQuery.error,
    latestGenerationQuery.isPending,
    latestGenerationQuery.refresh,
    revisionKey,
    startProposalGeneration,
    threadRef,
  ]);

  const generationSeed =
    latestGenerationQuery.data ??
    (startedGeneration?.key === revisionKey ? startedGeneration.generation : null);
  const generationQuery = useEnvironmentQuery(
    generationSeed !== null && threadRef
      ? projectEnvironment.getProposalGeneration({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            generationId: generationSeed.generationId,
          },
        })
      : null,
  );
  const generation = generationQuery.data ?? generationSeed;
  useEffect(() => {
    if (
      generation === null ||
      (generation.state !== "queued" &&
        generation.state !== "preparing" &&
        generation.state !== "analyzing")
    ) {
      return;
    }
    const intervalId = window.setInterval(generationQuery.refresh, 1_500);
    return () => window.clearInterval(intervalId);
  }, [generation, generationQuery.refresh]);

  const generationIsActive =
    generation?.state === "queued" ||
    generation?.state === "preparing" ||
    generation?.state === "analyzing";
  const previewIdentity =
    exactPlanProposal !== null
      ? generationIsActive
        ? `Analyzing revision ${exactPlanProposal.revision.revision} against workspace snapshot ${exactPlanProposal.revision.baseSnapshot.workingTreeOid}.`
        : `Preview of proposal revision ${exactPlanProposal.revision.revision} against workspace snapshot ${exactPlanProposal.revision.baseSnapshot.workingTreeOid}.`
      : planProposalQuery.error !== null
        ? "Exact proposal preview is unavailable."
        : planProposalQuery.isPending
          ? "Loading the exact proposal preview."
          : proposalPreviewAvailable && threadRef
            ? "No immutable proposal revision is linked to this exact plan."
            : null;
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "plan",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy plan",
          description: error instanceof Error ? error.message : "An error occurred while copying.",
        }),
      );
    },
  });
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const handleOpenExplorer = () => {
    if (!threadRef || !canOpenExplorer) return;
    useRightPanelStore.getState().openExplorer(threadRef, planId);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Workspace path is unavailable",
          description: "This thread does not have a workspace path to save into.",
        }),
      );
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const relativePath = savePath.trim();
    if (!workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred while saving.",
          }),
        );
      }
    })();
  };

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        {previewIdentity !== null || canOpenExplorer ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5">
            {previewIdentity !== null ? (
              <p
                className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground"
                data-proposal-preview-identity
              >
                {previewIdentity}
              </p>
            ) : (
              <span />
            )}
            {canOpenExplorer ? (
              <Button
                size="sm"
                variant="outline"
                data-scroll-anchor-ignore
                onClick={handleOpenExplorer}
              >
                Open Explorer
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
