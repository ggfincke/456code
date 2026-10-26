// apps/web/src/fincke/PlanModeChip.tsx
// codex-style plan mode chip: shown only while plan mode is on, its x returns to build mode
import { ListIcon, XIcon } from "lucide-react";

import { ComposerControl, ComposerControlIcon } from "../components/chat/ComposerControl";

export function PlanModeChip(props: { onExitPlanMode: () => void }) {
  return (
    <ComposerControl
      data-slot="fincke-plan-chip"
      aria-label="Plan mode on. Turn off plan mode"
      title="Plan mode. Click to return to build mode, or type /plan"
      onClick={props.onExitPlanMode}
    >
      <ComposerControlIcon icon={ListIcon} />
      <span data-composer-control-label>Plan</span>
      <ComposerControlIcon icon={XIcon} className="size-3.5" />
    </ComposerControl>
  );
}
