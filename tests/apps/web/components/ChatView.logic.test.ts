// tests/apps/web/components/ChatView.logic.test.ts
// protects per-target composer preflight and shared coral send eligibility

import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  canSendToProvider,
  prepareComposerTargets,
} from "../../../../apps/web/src/fincke/coralSendPolicy";

const targets = Object.freeze([
  Object.freeze({
    provider: ProviderDriverKind.make("codex"),
    interactionMode: "plan" as const,
    model: "codex-model",
  }),
  Object.freeze({
    provider: ProviderDriverKind.make("coral"),
    interactionMode: "plan" as const,
    model: "coral-model",
  }),
]);

it("normalizes only Coral without modifying the requested batch", () => {
  const result = prepareComposerTargets(targets, "full-access", 0);
  expect(result.error).toBeNull();
  expect(result.targets).toEqual([
    { ...targets[0], runtimeMode: "full-access" },
    { ...targets[1], runtimeMode: "approval-required", interactionMode: "default" },
  ]);
  expect(targets[1]!.interactionMode).toBe("plan");
});

it("rejects the entire attachment batch before returning dispatch targets", () => {
  const result = prepareComposerTargets(targets, "full-access", 1);
  expect(result.error).toContain("Remove attachments or deselect Coral");
  expect(result.targets).toBeNull();
  expect(prepareComposerTargets([targets[0]!], "full-access", 1).targets).toEqual([
    { ...targets[0], runtimeMode: "full-access" },
  ]);
});

it("uses the same ready-only boundary for manual sends and queue steering", () => {
  for (const phase of ["running", "connecting", "disconnected"] as const) {
    expect(canSendToProvider(ProviderDriverKind.make("coral"), phase)).toBe(false);
  }
  expect(canSendToProvider(ProviderDriverKind.make("coral"), "ready")).toBe(true);
  expect(canSendToProvider(ProviderDriverKind.make("codex"), "running")).toBe(true);
});
