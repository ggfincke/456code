import type { ClientConnectionMethod, EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-i18n";
import type { RemoteEnvironmentAuthError } from "../authorization/remote.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import { detailFromError, errorI18nMessage, translatableDetail } from "../errors/translatable.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

export function profileMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg("Connection profile {connectionId} is unavailable.", { connectionId }),
    ),
    hop: "device",
  });
}

export function credentialMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "authentication",
    ...translatableDetail(
      msg("Connection credential {connectionId} is unavailable.", { connectionId }),
    ),
    hop: "device",
  });
}

/** The host itself answered and refused this device's credential, which pairing again fixes. */
export function isHostCredentialRefusal(error: ConnectionAttemptError): boolean {
  return (
    error._tag === "ConnectionBlockedError" &&
    error.hop === "server" &&
    (error.reason === "authentication" || error.reason === "permission") &&
    error.failureCause !== "clock_skew"
  );
}

export function environmentMismatchError(input: {
  readonly expected: EnvironmentId;
  readonly actual: EnvironmentId;
}): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg(
        "This address now runs a different 456code install ({actual}, not {expected}). Remove this connection and add it again.",
        { actual: input.actual, expected: input.expected },
      ),
    ),
  });
}

export function mapRemoteEnvironmentError(
  error: RemoteEnvironmentAuthError,
  connectionMethod: ClientConnectionMethod = "direct",
): ConnectionAttemptError {
  const withNetworkHint = (cause: { readonly message: string }) => {
    if (connectionMethod !== "relay") return detailFromError(cause);
    const text = errorI18nMessage(cause);
    return text === undefined
      ? { detail: `${cause.message} ${NETWORK_BLOCKING_HINT}` }
      : translatableDetail(...text, NETWORK_BLOCKING_HINT);
  };
  // Over the relay the tunnel already reached the host, so a request that never
  // arrives was blocked between this device and the tunnel.
  const unreachableHop = connectionMethod === "relay" ? "tunnel" : "server";
  const via = connectionMethod === "relay" ? "relay" : "direct";
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        ...translatableDetail(msg("The environment credential is invalid.")),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return new ConnectionBlockedError({
        reason: "permission",
        ...translatableDetail(
          msg("The environment credential does not grant the required access."),
        ),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "EnvironmentRequestInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        ...translatableDetail(msg("The environment rejected the authentication request.")),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "EnvironmentResourceNotFoundError":
      return new ConnectionBlockedError({
        reason: "configuration",
        ...translatableDetail(msg("The environment endpoint could not be found.")),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "RemoteEnvironmentAuthTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        ...withNetworkHint(error),
        hop: unreachableHop,
        via,
      });
    case "RemoteEnvironmentAuthFetchError":
      return new ConnectionTransientError({
        reason: "network",
        ...withNetworkHint(error),
        hop: unreachableHop,
        via,
      });
    case "EnvironmentInternalError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        ...translatableDetail(msg("The environment could not authorize the connection.")),
        traceId: error.traceId,
        hop: "server",
        via,
      });
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        ...detailFromError(error),
        hop: "server",
        via,
      });
  }
}
