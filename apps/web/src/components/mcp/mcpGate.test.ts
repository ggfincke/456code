import { describe, expect, it } from "vite-plus/test";

import { resolveMcpGate } from "./mcpGate";

const open = {
  connected: true,
  approvalCodes: true,
  httpBaseUrl: "https://furnace.example.ts.net/",
} satisfies Parameters<typeof resolveMcpGate>[0];

describe("resolveMcpGate", () => {
  it("opens at the environment's own https origin", () => {
    expect(resolveMcpGate(open)).toEqual({
      kind: "open",
      mcpUrl: "https://furnace.example.ts.net/mcp",
    });
  });

  it.each([
    ["a disconnected environment", { ...open, connected: false }, "disconnected"],
    ["config still loading", { ...open, approvalCodes: undefined }, "checking"],
    ["a server without approval codes", { ...open, approvalCodes: false }, "update"],
    ["a plain http address", { ...open, httpBaseUrl: "http://127.0.0.1:3773" }, "no-https"],
    ["no known address", { ...open, httpBaseUrl: null }, "no-https"],
  ] as const)("stays closed with %s", (_, input, kind) => {
    expect(resolveMcpGate(input).kind).toBe(kind);
  });
});
