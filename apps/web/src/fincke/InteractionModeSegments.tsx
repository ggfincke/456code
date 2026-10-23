// apps/web/src/fincke/InteractionModeSegments.tsx
// shows build & plan side by side so the composer always names both modes
import type { ProviderInteractionMode } from "@t3tools/contracts";

import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

export function InteractionModeSegments(props: {
  interactionMode: ProviderInteractionMode;
  tooltip: string;
  onToggleInteractionMode: () => void;
}) {
  const active = props.interactionMode === "plan" ? "plan" : "build";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ToggleGroup
            aria-label="Interaction mode"
            data-slot="fincke-mode-segments"
            className="shrink-0"
            value={[active]}
            onValueChange={(values) => {
              // pressing the active segment would empty the group; only a switch toggles
              const next = values[0];
              if (next !== undefined && next !== active) props.onToggleInteractionMode();
            }}
          />
        }
      >
        <Toggle value="build" aria-label="Build mode">
          Build
        </Toggle>
        <Toggle value="plan" aria-label="Plan mode">
          Plan
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
