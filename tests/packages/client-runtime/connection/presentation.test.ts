import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
} from "../../../../packages/client-runtime/src/connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "../../../../packages/client-runtime/src/connection/model.ts";
import {
  connectionCatalogDisplayUrl,
  connectionPhaseMessage,
  connectionStatusText,
  connectionStatusTitle,
  presentEnvironmentConnection,
  presentConnectionState,
} from "../../../../packages/client-runtime/src/connection/presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("preserves profile display information without exposing credentials", () => {
    expect(connectionCatalogDisplayUrl(ENTRY)).toBe("https://environment.example.test");
  });

  it.each([
    {
      label: "initial connection",
      presentWith: "connection" as const,
      state: supervisorState({ phase: "connecting", attempt: 1 }),
      expected: { phase: "connecting", error: null, traceId: null },
    },
    {
      label: "reconnect after transport failure",
      presentWith: "connection" as const,
      state: supervisorState({
        phase: "connecting",
        attempt: 2,
        lastFailure: new ConnectionTransientError({
          reason: "transport",
          detail: "Socket closed.",
          traceId: "trace-previous",
        }),
      }),
      expected: { phase: "reconnecting", error: "Socket closed.", traceId: "trace-previous" },
    },
    {
      label: "backoff retry",
      presentWith: "connection" as const,
      state: supervisorState({
        phase: "backoff",
        attempt: 2,
        retryAt: 1,
        lastFailure: new ConnectionTransientError({
          reason: "transport",
          detail: "Disconnected.",
          traceId: "trace-1",
        }),
      }),
      expected: { phase: "reconnecting", error: "Disconnected.", traceId: "trace-1" },
    },
    {
      label: "retry while next attempt is active",
      presentWith: "environment" as const,
      state: supervisorState({
        phase: "connecting",
        stage: "opening",
        attempt: 2,
        lastFailure: new ConnectionTransientError({
          reason: "transport",
          detail: "Relay connection timed out.",
          traceId: "trace-retry",
        }),
      }),
      expected: {
        phase: "reconnecting",
        error: "Relay connection timed out.",
        traceId: "trace-retry",
      },
    },
    {
      label: "supervisor offline",
      presentWith: "environment" as const,
      state: supervisorState({
        network: "offline",
        phase: "offline",
        stage: null,
      }),
      expected: { phase: "offline", error: null, traceId: null },
    },
    {
      label: "supervisor connected",
      presentWith: "environment" as const,
      state: supervisorState({
        phase: "connected",
        stage: null,
        generation: 1,
      }),
      expected: { phase: "connected", error: null, traceId: null },
    },
    {
      label: "available while offline",
      presentWith: "environment" as const,
      state: supervisorState({
        desired: false,
        network: "offline",
        phase: "available",
        stage: null,
        attempt: 0,
      }),
      expected: { phase: "available", error: null, traceId: null },
    },
  ])("presents $label", ({ presentWith, state, expected }) => {
    const present =
      presentWith === "connection"
        ? presentConnectionState(state)
        : presentEnvironmentConnection(state);
    expect(present).toEqual(expected);
  });

  it("gives offline status precedence in global messaging", () => {
    expect(connectionPhaseMessage("connected", TARGET.label, "offline")).toBe("You are offline");
  });

  it("combines reconnect progress with the latest failure", () => {
    const connection = {
      phase: "reconnecting",
      error: "Relay request timed out.",
      traceId: "trace-retry",
    } as const;
    expect(connectionStatusText(connection)).toBe(
      "Failed to connect. Reconnecting... Reason: Relay request timed out.",
    );
    expect(connectionStatusTitle(connection)).toBe("Failed to connect. Reconnecting...");
  });
});
