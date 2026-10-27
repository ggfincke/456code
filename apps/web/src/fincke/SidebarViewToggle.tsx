// apps/web/src/fincke/SidebarViewToggle.tsx
// search-row button that flips the sidebar between the projects & activity views
import "./sidebarTokens.css";
import { useAtomValue } from "@effect/atom-react";
import { BellIcon, ListTreeIcon } from "lucide-react";
import { useEffect } from "react";

import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import { useLegacySidebarEnabled } from "../hooks/useSettings";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { toggleSidebarView } from "./sidebarView";

// one button showing the current view, so it sits in the same slot of both views' search
// rows and stays under the pointer after a flip
export function SidebarViewToggle() {
  const projectsView = useLegacySidebarEnabled();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggleView") ?? null;
  const label = projectsView ? "Switch to Activity view" : "Switch to Projects view";
  const Icon = projectsView ? ListTreeIcon : BellIcon;

  // a focused desktop preview page forwards the chord as a menu action
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to the desktop bridge's menu actions for the button's lifetime
  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (action === "sidebar.toggleView") void toggleSidebarView();
      }),
    [],
  );

  return (
    <SidebarHeaderIconButton
      label={label}
      tooltip={shortcutLabel ? `${label} (${shortcutLabel})` : label}
      onClick={() => void toggleSidebarView()}
    >
      {/* teal marks it as the current view rather than another action */}
      <Icon aria-hidden className="text-(--fincke-sidebar-accent)" />
    </SidebarHeaderIconButton>
  );
}
