// apps/web/src/fincke/EffortSegments.tsx
// effort levels as a row of named segments, the alternative to the snapping slider
import type { RefObject } from "react";

import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { EffortLevel } from "./EffortSlider";
import "./effortSlider.css";

// the popover is narrow, so long level names get a short form; the full name stays the label
const SHORT_LABELS: Record<string, string> = {
  minimal: "Min",
  medium: "Med",
  xhigh: "XHigh",
  ultracode: "Ultra",
  ultrathink: "Ultra",
};

export function EffortSegments(props: {
  levels: ReadonlyArray<EffortLevel>;
  index: number;
  label: string;
  disabled?: boolean;
  // the popover focuses the current level on open, so the caller owns this ref
  currentRef: RefObject<HTMLButtonElement | null>;
  onCommit: (index: number) => void;
}) {
  const current = props.levels[props.index];

  return (
    <ToggleGroup
      data-effort-segments=""
      aria-label={props.label}
      disabled={props.disabled === true}
      value={current ? [current.id] : []}
      onValueChange={(values) => {
        // pressing the current level again reports no value, which keeps it selected
        const next = props.levels.findIndex((level) => level.id === values[0]);
        if (next >= 0) props.onCommit(next);
      }}
    >
      {props.levels.map((level, levelIndex) => (
        <Tooltip key={level.id}>
          <TooltipTrigger
            render={
              <Toggle
                ref={levelIndex === props.index ? props.currentRef : null}
                value={level.id}
                aria-label={level.label}
                data-effort-segment=""
                data-ultra={level.ultra ? "" : undefined}
              />
            }
          >
            <span className="min-w-0 truncate">{SHORT_LABELS[level.id] ?? level.label}</span>
            {level.isDefault ? <span aria-hidden="true" data-slot="effort-default-dot" /> : null}
          </TooltipTrigger>
          {level.description ? <TooltipPopup side="top">{level.description}</TooltipPopup> : null}
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
