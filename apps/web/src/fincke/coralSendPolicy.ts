// apps/web/src/fincke/coralSendPolicy.ts
// keeps coral sends within its text-only, supervised turn boundary

import type { ProviderDriverKind, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

export function canSendToProvider(
  provider: ProviderDriverKind | undefined,
  phase: "connecting" | "running" | "ready" | "disconnected",
): boolean {
  return provider !== "coral" || phase === "ready";
}

// preflight the whole batch before uploads or thread creation can start
export function prepareComposerTargets<
  T extends {
    provider: ProviderDriverKind;
    interactionMode: ProviderInteractionMode;
  },
>(targets: readonly T[], runtimeMode: RuntimeMode, attachmentCount: number) {
  if (attachmentCount > 0 && targets.some((target) => target.provider === "coral")) {
    return {
      error: "Coral supports text only. Remove attachments or deselect Coral before sending.",
      targets: null,
    } as const;
  }
  return {
    error: null,
    targets: targets.map((target) => ({
      ...target,
      runtimeMode: target.provider === "coral" ? ("approval-required" as const) : runtimeMode,
      interactionMode: target.provider === "coral" ? ("default" as const) : target.interactionMode,
    })),
  } as const;
}
