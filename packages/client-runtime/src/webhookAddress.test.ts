import { describe, expect, it } from "vite-plus/test";

import { webhookAddress } from "./webhookAddress.ts";

const endpoint = {
  path: "/hooks/abc",
  hasSecret: true,
};

describe("webhookAddress", () => {
  it("is not copyable without a base URL", () => {
    const result = webhookAddress(endpoint, null);
    expect(result.address).toBe("/hooks/abc");
    expect(result.copyable).toBe(false);
    expect(result.note).toBeNull();
  });

  it("warns that loopback addresses only work on this computer", () => {
    const result = webhookAddress(endpoint, "http://127.0.0.1:8787");
    expect(result.address).toBe("http://127.0.0.1:8787/hooks/abc");
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Only this computer");
  });

  it("explains reachability for non-loopback hosts", () => {
    const result = webhookAddress(endpoint, "https://home.example.net");
    expect(result.address).toBe("https://home.example.net/hooks/abc");
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Tailscale");
  });
});
