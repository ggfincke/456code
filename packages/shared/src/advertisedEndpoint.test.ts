import { describe, expect, it } from "vite-plus/test";

import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
  normalizeHttpBaseUrl,
} from "./advertisedEndpoint.ts";

describe("normalizeHttpBaseUrl", () => {
  it("rejects non-http(s) schemes", () => {
    expect(() => normalizeHttpBaseUrl("ftp://example.com")).toThrow(/HTTP or HTTPS/);
  });
});

describe("createAdvertisedEndpoint", () => {
  const input = {
    id: "e1",
    label: "Local",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    reachability: "loopback",
    source: "desktop-core",
  } satisfies Omit<CreateAdvertisedEndpointInput, "httpBaseUrl">;

  it("derives the websocket url from a plain-http endpoint", () => {
    const endpoint = createAdvertisedEndpoint({
      ...input,
      httpBaseUrl: "http://192.168.1.10:8317",
    });
    expect(endpoint.compatibility.desktopApp).toBe("compatible");
    expect(endpoint.wsBaseUrl).toBe("ws://192.168.1.10:8317/");
  });
});
