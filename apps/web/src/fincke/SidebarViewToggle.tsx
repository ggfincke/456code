// apps/web/src/fincke/SidebarViewToggle.tsx
// header buttons that switch the sidebar between the projects & activity views
import "./sidebarTokens.css";
import { useAtomValue } from "@effect/atom-react";
import { BellIcon, ListTreeIcon, type LucideIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { updateClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { shortcutLabelForCommand } from "../keybindings";
import { cn } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";

function SidebarViewButton({
  icon: Icon,
  label,
  active,
  shortcutLabel,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  shortcutLabel: string | null;
  onSelect: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={onSelect}
            className={cn(
              "inline-flex size-6 cursor-pointer items-center justify-center rounded-md outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? "bg-(--fincke-sidebar-accent-wash) text-(--fincke-sidebar-accent)"
                : "text-(--fincke-sidebar-icon) hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
          />
        }
      >
        <Icon aria-hidden className="size-3.75" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

export function SidebarViewToggle() {
  const projectsView = useLegacySidebarEnabled();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // the shortcut flips views, so it belongs on whichever button it would switch to
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggleView") ?? null;

  return (
    <div className="relative z-10 flex shrink-0 items-center gap-0.5">
      <SidebarViewButton
        icon={ListTreeIcon}
        label="Projects view"
        active={projectsView}
        shortcutLabel={projectsView ? null : shortcutLabel}
        onSelect={() => void updateClientSettings({ legacySidebarEnabled: true })}
      />
      <SidebarViewButton
        icon={BellIcon}
        label="Activity view"
        active={!projectsView}
        shortcutLabel={projectsView ? shortcutLabel : null}
        onSelect={() => void updateClientSettings({ legacySidebarEnabled: false })}
      />
    </div>
  );
}
