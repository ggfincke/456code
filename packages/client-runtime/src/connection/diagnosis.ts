import * as DateTime from "effect/DateTime";

import type {
  ConnectionAttemptError,
  ConnectionFailureCause,
  ConnectionHop,
  SupervisorConnectionState,
} from "./model.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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
  readonly cause: ConnectionFailureCause | "offline" | "outdated" | "session_pending" | null;
  /** The failure named no hop, so the hops before this one were never probed. */
  readonly guessed?: true;
}

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.reason === "session-pending") {
    return { hop: "device", cause: "session_pending" };
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
    return {
      hop: unreachable && via === "relay" ? "tunnel" : "server",
      cause: null,
      guessed: true,
    };
  }
  return null;
}

function headline(
  host: string,
  located: Located,
  failure: ConnectionAttemptError | null,
  resolve: MFunctionType,
): string {
  switch (located.cause) {
    case "offline":
      return resolve(msg("This device is offline"));
    case "session_pending":
      return resolve(msg("This device is still loading its sign-in"));
    case "outdated":
      return resolve(msg("{host} runs an older version", { host }));
    case "clock_skew":
      return resolve(msg("This device's clock is off"));
    case "not_linked":
      return resolve(msg("{host} is not linked to your relay account", { host }));
    case "relay_error":
      return resolve(msg("The relay returned an error"));
    case "tunnel_pending":
      return resolve(msg("{host}'s tunnel is still being set up", { host }));
    case "tunnel_not_enabled":
      return resolve(msg("The relay tunnel is not turned on for {host}", { host }));
    case "tunnel_down":
      return resolve(msg("{host}'s tunnel is offline", { host }));
    case "origin_unreachable":
      return resolve(msg("Tunnel works, but the server on {host} did not answer", { host }));
    case "invalid_response":
      return resolve(msg("The server on {host} sent an unexpected answer", { host }));
    case "dns":
      return resolve(msg("{host}'s tunnel address did not resolve", { host }));
    case "tls":
      return resolve(msg("Secure connection to {host}'s tunnel failed", { host }));
    case "refused":
      return resolve(msg("{host}'s tunnel refused the connection", { host }));
    case "timeout":
      return resolve(msg("{host} did not answer in time", { host }));
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return resolve(msg("This device could not prepare the connection"));
    case "relay":
      return failure?.reason === "authentication"
        ? resolve(msg("The relay did not accept this device's sign-in"))
        : resolve(msg("This device can't reach the relay"));
    case "tunnel":
      // The relay already reached the host when this device fails on its own.
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? resolve(msg("This device can't reach {host}'s tunnel", { host }))
        : resolve(msg("The relay could not reach {host}'s tunnel", { host }));
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? resolve(msg("The server on {host} did not accept this device", { host }))
        : resolve(msg("The server on {host} did not answer", { host }));
  }
}

function steps(
  host: string,
  located: Located,
  failure: ConnectionAttemptError | null,
  resolve: MFunctionType,
): string[] {
  const checkHost = resolve(msg("On {host}, check that the server is running.", { host }));
  switch (located.cause) {
    case "offline":
      return [resolve(msg("Connect this device to the internet. 456code reconnects on its own."))];
    case "session_pending":
      return [
        resolve(msg("Wait a moment. 456code retries on its own.")),
        resolve(msg("If it keeps waiting, reload or restart 456code on this device.")),
      ];
    case "outdated":
      return [resolve(msg("Update the server on {host}.", { host }))];
    case "clock_skew":
      return [
        resolve(
          msg("Turn on automatic date and time on this device and on {host}, then retry.", {
            host,
          }),
        ),
      ];
    case "not_linked":
      return [
        resolve(msg("Check that this device is signed in to the same relay account as the host.")),
      ];
    case "tunnel_pending":
      return [resolve(msg("Wait a minute. The app retries on its own.")), checkHost];
    case "relay_error":
      return [
        resolve(msg("Wait a few minutes. The app retries on its own.")),
        resolve(msg("If it keeps failing, copy the diagnostics and report it.")),
      ];
    case "tunnel_not_enabled":
      return [checkHost];
    case "tunnel_down":
      return [
        resolve(msg("Make sure {host} is awake and the server is running on it.", { host })),
        checkHost,
        resolve(
          msg(
            "A VPN or Tailscale exit node on {host} can block the tunnel (port 7844). Turn it off or allow the tunnel.",
            { host },
          ),
        ),
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [resolve(msg("Start or restart the server on {host}.", { host })), checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [resolve(msg("Make sure {host} is awake and online.", { host })), checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        resolve(msg("Restart the app on this device.")),
        resolve(
          msg("If it keeps failing, remove {host} from this device and add it again.", { host }),
        ),
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? [resolve(msg("Sign out of the relay and sign in again."))]
        : [
            resolve(msg("Check this device's internet connection.")),
            resolve(msg("A VPN, firewall, or ad blocker on this device can block the relay.")),
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            resolve(msg("A VPN, firewall, or DNS filter on this device can block the tunnel.")),
            resolve(msg("Try another network, or add a direct route such as a Tailscale address.")),
          ]
        : [resolve(msg("Make sure {host} is awake and online.", { host })), checkHost];
    case "server":
      return failure?.reason === "authentication"
        ? [
            resolve(
              msg(
                "This device's sign-in to {host} expired or was revoked. Pair it again with a new pairing link from {host}.",
                { host },
              ),
            ),
          ]
        : [
            resolve(msg("Make sure the server is running on {host}.", { host })),
            resolve(msg("Retry. If it keeps failing, copy the diagnostics.")),
          ];
  }
}

const HOP_ORDER = {
  relay: ["device", "relay", "tunnel", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(hop: ConnectionHop, host: string, resolve: MFunctionType): string {
  switch (hop) {
    case "device":
      return resolve(msg("This device"));
    case "relay":
      return resolve(msg("Relay"));
    case "tunnel":
      return resolve(msg("{host} tunnel", { host }));
    case "server":
      return resolve(msg("Server on {host}", { host }));
  }
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
  resolve: MFunctionType = mFallback,
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
    label: hopLabel(hop, host, resolve),
    result:
      index === failedIndex
        ? "failed"
        : index < failedIndex && located.guessed !== true
          ? "ok"
          : "unchecked",
  }));

  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add(
    resolve(msg("Cause", { $context: "diagnostics field label" })),
    located.cause ?? failure?.reason,
  );
  add(resolve(msg("HTTP status")), failure?.httpStatus);
  add(
    resolve(msg("Attempts", { $context: "diagnostics field label" })),
    input.state.attempt > 0 ? input.state.attempt : null,
  );
  add(
    resolve(msg("Next retry")),
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add(
    resolve(msg("Route", { $context: "diagnostics field label" })),
    relayPath ? resolve(msg("Relay")) : resolve(msg("Direct", { $context: "connection route" })),
  );
  add(resolve(msg("App version")), input.clientVersion);
  add(resolve(msg("Host version")), input.serverVersion);
  add(resolve(msg("Error", { $context: "diagnostics field label" })), failure?.detail);
  add(resolve(msg("Trace ID")), failure?.traceId);

  return {
    headline: headline(host, located, failure, resolve),
    hops,
    steps: steps(host, located, failure, resolve),
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
