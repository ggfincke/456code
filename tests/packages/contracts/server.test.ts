// tests/packages/contracts/server.test.ts
// verifies provider snapshot defaults and account usage wire invariants
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProvider } from "../../../packages/contracts/src/server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

const baseProvider = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes every provider account usage state", () => {
    const accountUsageStates = [
      {
        status: "available",
        observedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          {
            id: "account:primary",
            label: "5h",
            usedPercent: 62,
            resetsAt: "2026-04-10T05:00:00.000Z",
          },
        ],
      },
      { status: "external", dashboardUrl: "https://cursor.com/dashboard" },
      {
        status: "notApplicable",
        observedAt: "2026-04-10T00:00:00.000Z",
        message: "Plan limits do not apply.",
      },
      {
        status: "unavailable",
        observedAt: "2026-04-10T00:00:00.000Z",
        message: "Usage is unavailable.",
      },
    ] as const;

    expect(
      accountUsageStates.map(
        (accountUsage) =>
          decodeServerProvider({ ...baseProvider, accountUsage }).accountUsage?.status,
      ),
    ).toEqual(["available", "external", "notApplicable", "unavailable"]);
  });

  it("rejects empty available usage windows and out-of-range percentages", () => {
    expect(() =>
      decodeServerProvider({
        ...baseProvider,
        accountUsage: {
          status: "available",
          observedAt: "2026-04-10T00:00:00.000Z",
          windows: [],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeServerProvider({
        ...baseProvider,
        accountUsage: {
          status: "available",
          observedAt: "2026-04-10T00:00:00.000Z",
          windows: [
            {
              id: "account:primary",
              label: "5h",
              usedPercent: 101,
              resetsAt: null,
            },
          ],
        },
      }),
    ).toThrow();
  });
});
