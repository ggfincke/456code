import { usePaneRole } from "../../components/ui/Pane";
import { isDuoDevice } from "../../lib/device-type";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "./adaptive-workspace-context";

/** The content pane's sidebar button, or null where there's no sidebar beside it to toggle. */
export function useSidebarToggle() {
  const role = usePaneRole();
  const { layout, panes, sidebarToggleable, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  // fincke: the Duo toggles its sidebar from the column bar's sidebar & search group
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const duoBar = usesNativeWorkspaceColumns && isDuoDevice(deviceType);
  if (role !== "content" || !sidebarToggleable || duoBar) return null;
  const maximizes = panes.primarySidebarVisible && layout.variant !== "medium";
  return {
    visible: panes.primarySidebarVisible,
    accessibilityLabel: panes.primarySidebarVisible
      ? maximizes
        ? "Maximize content"
        : "Hide sidebar"
      : "Show sidebar",
    icon: maximizes ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
    onPress: togglePrimarySidebar,
  } as const;
}
