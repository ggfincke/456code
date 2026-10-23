// tests/apps/web/fincke/sidebarView.test.ts
// protects the sidebar view shortcut default & the setting its toggle flips

import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";

import { toggleSidebarView } from "../../../../apps/web/src/fincke/sidebarView";
import {
  __setClientSettingsForTests,
  getClientSettings,
} from "../../../../apps/web/src/hooks/useSettings";
import { resolveShortcutCommand } from "../../../../apps/web/src/keybindings";

it("binds mod+alt+u to the sidebar view toggle by default", () => {
  const platforms = [
    { platform: "MacIntel", modifier: { metaKey: true } },
    { platform: "Linux x86_64", modifier: { ctrlKey: true } },
  ];
  for (const { platform, modifier } of platforms) {
    const event = {
      key: "u",
      code: "KeyU",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      ...modifier,
    };
    expect(resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, { platform })).toBe(
      "sidebar.toggleView",
    );
  }
});

it("flips from the default projects view to activity and back", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const persist = vi.fn<(settings: ClientSettings) => Promise<void>>(async () => {});

  await toggleSidebarView(persist);
  expect(getClientSettings().legacySidebarEnabled).toBe(false);
  await toggleSidebarView(persist);
  expect(getClientSettings().legacySidebarEnabled).toBe(true);
  expect(persist).toHaveBeenCalledTimes(2);
});
