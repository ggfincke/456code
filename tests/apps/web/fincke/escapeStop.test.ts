// tests/apps/web/fincke/escapeStop.test.ts
// protects esc stopping a running turn without stealing esc from open menus

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it } from "vite-plus/test";
import { escapeShouldStopTurn } from "../../../../apps/web/src/fincke/escapeStop";
import { resolveChatShortcutCommand } from "../../../../apps/web/src/keybindings";

const escape = {
  key: "Escape",
  code: "Escape",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  isComposing: false,
  repeat: false,
};

function resolveEscape(context: { turnRunning: boolean; terminalFocus: boolean }) {
  return resolveChatShortcutCommand(escape, DEFAULT_RESOLVED_KEYBINDINGS, [], {
    platform: "Linux x86_64",
    context: { ...context, terminalOpen: false, previewFocus: false, previewOpen: false },
  });
}

it("resolves esc to thread.stop only while a turn runs outside the terminal", () => {
  expect(resolveEscape({ turnRunning: true, terminalFocus: false })).toBe("thread.stop");
  expect(resolveEscape({ turnRunning: false, terminalFocus: false })).toBeNull();
  expect(resolveEscape({ turnRunning: true, terminalFocus: true })).toBeNull();
});

it("stops the turn only when no open layer or text field consumed esc", () => {
  const composer = { editableOutsideComposer: false };
  expect(escapeShouldStopTurn(escape, composer)).toBe(true);
  // a menu, popover, dialog or the slash menu closed on this esc
  expect(escapeShouldStopTurn({ ...escape, defaultPrevented: true }, composer)).toBe(false);
  expect(escapeShouldStopTurn(escape, { editableOutsideComposer: true })).toBe(false);
  expect(escapeShouldStopTurn({ ...escape, isComposing: true }, composer)).toBe(false);
});
