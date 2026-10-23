// apps/web/src/fincke/sidebarView.ts
// flips the sidebar between the projects tree & the activity list
import type { ClientSettings } from "@t3tools/contracts/settings";

import { persistClientSettingsUpdate } from "../hooks/useSettings";

// the projects view reuses upstream's legacySidebarEnabled flag so the
// existing settings row, hydration hold & chat.new behavior keep working.
// an updater (not a patch) keeps two quick toggles from both reading the old value
export async function toggleSidebarView(
  persist?: (settings: ClientSettings) => Promise<void>,
): Promise<void> {
  try {
    await persistClientSettingsUpdate(
      (current) => ({ ...current, legacySidebarEnabled: !current.legacySidebarEnabled }),
      persist,
    );
  } catch (error) {
    console.error("Could not switch the sidebar view.", error);
  }
}
