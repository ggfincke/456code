// tests/packages/client-runtime/state/preview.test.ts
// verifies preview command concurrency boundaries

import { describe, expect, it } from "vite-plus/test";

import { previewAutomationHostFocusConcurrencyKey } from "../../../../packages/client-runtime/src/state/preview.ts";

describe("preview state commands", () => {
  it("keeps focus updates from replacement host connections independent", () => {
    const first = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-1" },
    });
    const replacement = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-2" },
    });

    expect(first).not.toBe(replacement);
  });
});
