// apps/web/src/fincke/escapeStop.ts
// lets esc stop a running turn only after open menus, dialogs & text fields had their say

interface EscapeEventState {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
}

// menus, popovers, dialogs & the composer's slash menu close on esc & mark it handled.
// other text fields (rename, search) own esc as cancel even when they don't mark it
export function escapeShouldStopTurn(
  event: EscapeEventState,
  focus: { readonly editableOutsideComposer: boolean },
): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.isComposing &&
    !event.repeat &&
    !focus.editableOutsideComposer
  );
}

// the chat shortcut listener runs in the window capture phase, before any open layer sees
// the key, so a plain esc waits until the event bubbles back to the window
export function deferEscapeStop(
  event: KeyboardEvent,
  focus: { readonly editableOutsideComposer: boolean },
  stop: () => void,
): void {
  const onBubble = (bubbled: KeyboardEvent) => {
    if (bubbled !== event) return;
    window.removeEventListener("keydown", onBubble);
    if (!escapeShouldStopTurn(event, focus)) return;
    event.preventDefault();
    stop();
  };
  window.addEventListener("keydown", onBubble);
  // a layer that stops propagation means the bubble listener never runs
  setTimeout(() => window.removeEventListener("keydown", onBubble), 0);
}
