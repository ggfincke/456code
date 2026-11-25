// apps/web/src/fincke/ThreadWorktreeIndicator.tsx
// worktree icon w/ path tooltip for fork sidebar rows
import { FolderGit2Icon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3.5 shrink-0 text-icon-muted" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
