import * as DateTime from "effect/DateTime";

import type {
  ConnectionAttemptError,
  ConnectionFailureCause,
  ConnectionHop,
  SupervisorConnectionState,
} from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini's tunnel is offline". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
}

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  /** The environment's usual route, used when the failure does not name one. */
  readonly via: "relay" | "direct";
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause: ConnectionFailureCause | "offline" | "outdated" | null;
}

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: failure.failureCause ?? null };
  }
  if (failure !== null) {
    const unreachable =
      failure.reason === "network" ||
      failure.reason === "timeout" ||
      failure.reason === "transport";
    const via = failure.via ?? input.via;
    return { hop: unreachable && via === "relay" ? "tunnel" : "server", cause: null };
  }
  return null;
}

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline":
      return "This device is offline";
    case "outdated":
      return `${host} runs an older version`;
    case "clock_skew":
      return "This device's clock is off";
    case "not_linked":
      return `${host} is not linked to your relay account`;
    case "relay_error":
      return "The relay returned an error";
    case "tunnel_pending":
      return `${host}'s tunnel is still being set up`;
    case "tunnel_not_enabled":
      return `The relay tunnel is not turned on for ${host}`;
    case "tunnel_down":
      return `${host}'s tunnel is offline`;
    case "origin_unreachable":
      return `Tunnel works, but the server on ${host} did not answer`;
    case "invalid_response":
      return `The server on ${host} sent an unexpected answer`;
    case "dns":
      return `${host}'s tunnel address did not resolve`;
    case "tls":
      return `Secure connection to ${host}'s tunnel failed`;
    case "refused":
      return `${host}'s tunnel refused the connection`;
    case "timeout":
      return `${host} did not answer in time`;
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return "This device could not prepare the connection";
    case "relay":
      return failure?.reason === "authentication"
        ? "The relay did not accept this device's sign-in"
        : "This device can't reach the relay";
    case "tunnel":
      // The relay already reached the host when this device fails on its own.
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? `This device can't reach ${host}'s tunnel`
        : `The relay could not reach ${host}'s tunnel`;
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? `The server on ${host} did not accept this device`
        : `The server on ${host} did not answer`;
  }
}

function steps(host: string, located: Located, failure: ConnectionAttemptError | null): string[] {
  const checkHost = `On ${host}, check that the server is running.`;
  switch (located.cause) {
    case "offline":
      return ["Connect this device to the internet. The app reconnects on its own."];
    case "outdated":
      return [`Update the server on ${host}.`];
    case "clock_skew":
      return [`Turn on automatic date and time on this device and on ${host}, then retry.`];
    case "not_linked":
      return ["Check that this device is signed in to the same relay account as the host."];
    case "tunnel_pending":
      return ["Wait a minute. The app retries on its own.", checkHost];
    case "relay_error":
      return [
        "Wait a few minutes. The app retries on its own.",
        "If it keeps failing, copy the diagnostics and report it.",
      ];
    case "tunnel_not_enabled":
      return [checkHost];
    case "tunnel_down":
      return [
        `Make sure ${host} is awake and the server is running on it.`,
        checkHost,
        `A VPN or Tailscale exit node on ${host} can block the tunnel (port 7844). Turn it off or allow the tunnel.`,
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [`Start or restart the server on ${host}.`, checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [`Make sure ${host} is awake and online.`, checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        "Restart the app on this device.",
        `If it keeps failing, remove ${host} from this device and add it again.`,
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? ["Sign out of the relay and sign in again."]
        : [
            "Check this device's internet connection.",
            "A VPN, firewall, or ad blocker on this device can block the relay.",
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            "A VPN, firewall, or DNS filter on this device can block the tunnel.",
            "Try another network, or add a direct route such as a Tailscale address.",
          ]
        : [`Make sure ${host} is awake and online.`, checkHost];
    case "server":
      return [
        `Make sure the server is running on ${host}.`,
        "Retry. If it keeps failing, copy the diagnostics.",
      ];
  }
}

const HOP_ORDER = {
  relay: ["device", "relay", "tunnel", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return "This device";
    case "relay":
      return "Relay";
    case "tunnel":
      return `${host} tunnel`;
    case "server":
      return `Server on ${host}`;
  }
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  const relayPath =
    located.hop === "relay" || located.hop === "tunnel" || (failure?.via ?? input.via) === "relay";
  const order: ReadonlyArray<ConnectionHop> = HOP_ORDER[relayPath ? "relay" : "direct"];
  const failedIndex = order.indexOf(located.hop);
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result: index < failedIndex ? "ok" : index === failedIndex ? "failed" : "unchecked",
  }));

  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", located.cause ?? failure?.reason);
  add("HTTP status", failure?.httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "Next retry",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("Route", relayPath ? "Relay" : "Direct");
  add("App version", input.clientVersion);
  add("Host version", input.serverVersion);
  add("Error", failure?.detail);
  add("Trace ID", failure?.traceId);

  return {
    headline: headline(host, located, failure),
    hops,
    steps: steps(host, located, failure),
    facts,
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `Connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
}
