// apps/web/src/fincke/FinckeApprovalCard.tsx
// lays the composer's pending approval out as a card: tinted header, command block, decision row
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { CircleAlertIcon, EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { memo, type ReactElement } from "react";

import { DEFAULT_APPROVAL_OPTIONS } from "../components/chat/ComposerPendingApprovalActions";
import { composerFloatingLayerProps } from "../components/chat/composerEventScope";
import { Button, InlineButton } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import type { PendingApproval } from "../session-logic";

// wording matches ComposerPendingApprovalPanel so screen readers hear the same labels
function approvalLabels(requestKind: PendingApproval["requestKind"]) {
  switch (requestKind) {
    case "mcp-elicitation":
      return { label: "App access approval", detail: "App access request" };
    case "command":
      return { label: "Command approval", detail: "Command" };
    case "file-read":
      return { label: "File read approval", detail: "File to read" };
    case "permission":
      return { label: "App permission approval", detail: "Permission request" };
    default:
      return { label: "File change approval", detail: "File change" };
  }
}

// approve leads, session-wide approval sits beside it & deny stays quiet; anything else
// the provider offers (cancel, custom choices) keeps living in the overflow menu
const BUTTON_ORDER: ReadonlyArray<ProviderApprovalDecision> = [
  "accept",
  "acceptForSession",
  "decline",
];

const BUTTON_VARIANT = {
  accept: "default",
  acceptForSession: "outline",
  decline: "ghost-muted",
} as const;

export const FinckeApprovalCard = memo(function FinckeApprovalCard(props: {
  approval: PendingApproval;
  pendingCount: number;
  disabled: boolean;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}) {
  const { approval, disabled, isResponding } = props;
  const { label, detail } = approvalLabels(approval.requestKind);
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const canRespond = approval.responseCapability === "live";
  const options: ReadonlyArray<ProviderApprovalOption> =
    approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const buttonOptions = BUTTON_ORDER.flatMap((decision) =>
    options.filter((option) => option.decision === decision),
  );
  const menuOptions = options.filter((option) => !BUTTON_ORDER.includes(option.decision));
  const respond = (decision: ProviderApprovalDecision) => {
    if (!disabled && !isResponding) void props.onRespondToApproval(approval.requestId, decision);
  };
  const withWarning = (option: ProviderApprovalOption, element: ReactElement) =>
    option.warning ? (
      <Tooltip key={option.decision}>
        <TooltipTrigger render={element} />
        <TooltipPopup side="top">{option.warning}</TooltipPopup>
      </Tooltip>
    ) : (
      element
    );

  return (
    <div
      data-slot="fincke-approval-card"
      data-chat-composer-collapsed-controls="true"
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-col"
    >
      <div className="flex min-w-0 items-center gap-2 rounded-t-md border-b border-(--fincke-yellow)/19 bg-(--fincke-yellow)/6 px-3 py-2 text-xs">
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-(--fincke-yellow)" />
        <span className="shrink-0 font-medium text-(--fincke-yellow)">Needs approval</span>
        <span className="min-w-0 truncate text-muted-foreground">
          · {detail.toLowerCase()}
          {approval.appName ? ` · ${approval.appName}` : null}
        </span>
        {approval.fullAccessOverride ? (
          <Popover>
            <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
              {FULL_ACCESS_OVERRIDE_QUESTION}
            </PopoverTrigger>
            <PopoverPopup
              {...composerFloatingLayerProps}
              aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
              tooltipStyle
              side="top"
              className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
            >
              {fullAccessOverrideExplanation(approval.fullAccessOverride)}
            </PopoverPopup>
          </Popover>
        ) : null}
        {props.pendingCount > 1 ? (
          <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
            1/{props.pendingCount}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
        <Detail
          aria-label={detail}
          className={cn(
            "block w-full min-w-0 overflow-auto rounded-md bg-background px-2.5 py-2 text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
            approval.requestKind === "mcp-elicitation"
              ? "max-h-20 whitespace-pre-wrap font-sans wrap-break-word"
              : "max-h-40 whitespace-pre-wrap font-mono wrap-anywhere",
          )}
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.responseCapability === "not_resumable"
            ? "Provider process is gone. Interrupt or restart the run to respond."
            : approval.detail || label}
        </Detail>
        {approval.reason ? (
          <span className="w-full min-w-0 text-2xs text-muted-foreground wrap-break-word">
            {approval.reason}
          </span>
        ) : null}
        {/* approve reads as the theme's teal action instead of the dark message-action surface */}
        <div
          data-slot="fincke-approval-actions"
          className="flex flex-wrap items-center gap-1.5 [--primary-foreground:var(--background)] [--primary:var(--fincke-teal)]"
        >
          {buttonOptions.map((option) =>
            withWarning(
              option,
              <Button
                key={option.decision}
                size="xs"
                variant={BUTTON_VARIANT[option.decision as keyof typeof BUTTON_VARIANT]}
                disabled={disabled || isResponding || !canRespond}
                aria-description={option.warning}
                onClick={() => respond(option.decision)}
              >
                {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
                <span className="max-w-40 truncate">{option.label}</span>
              </Button>,
            ),
          )}
          {menuOptions.length > 0 ? (
            <Menu>
              <MenuTrigger
                disabled={disabled || isResponding}
                render={
                  <Button size="icon-xs" variant="ghost-muted" aria-label="More approval options" />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup {...composerFloatingLayerProps} side="top" align="start" width="content">
                {menuOptions.map((option) =>
                  withWarning(
                    option,
                    <MenuItem
                      key={option.decision}
                      disabled={disabled || isResponding}
                      aria-description={option.warning}
                      onClick={() => respond(option.decision)}
                    >
                      {option.warning ? (
                        <TriangleAlertIcon className="size-3 text-warning" />
                      ) : null}
                      <span className="min-w-0 whitespace-normal wrap-break-word">
                        {option.label}
                      </span>
                    </MenuItem>,
                  ),
                )}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>
    </div>
  );
});
