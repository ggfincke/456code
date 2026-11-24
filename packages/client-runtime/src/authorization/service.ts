// packages/client-runtime/src/authorization/service.ts
// authorizes remote environments with bearer tokens
import {
  AuthAccessTokenType,
  type ClientConnectionMethod,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as DpopProof from "./dpopProof.ts";
import {
  exchangeRemoteDpopAccessToken,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import { DpopConnectionCredential } from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
} from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type ConnectionAttemptError,
  type DirectDpopConnection,
  type DpopHttpAuthorization,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { isNearbyAddress } from "../connection/routes.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    /** A saved address paired with this device's DPoP key, which renews with the host itself. */
    readonly authorizeDirectDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly connectionId: string;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    /**
     * Lets the next direct authorization of this address skip its own descriptor
     * read. Kept only where the address reaches the same machine on every network.
     */
    readonly rememberCheckedDescriptor: (
      httpBaseUrl: string,
      descriptor: Option.Option<ExecutionEnvironmentDescriptor>,
      keepsItsHost: boolean,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const CHECKED_DESCRIPTOR_TTL_NANOS = 5_000_000_000n;
// A loopback or LAN host answers well inside this, so a dead one frees its attempt sooner.
const NEARBY_DESCRIPTOR_TIMEOUT_MS = 3_000;

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
  connectionMethod: ClientConnectionMethod,
  timeoutMs?: number,
) {
  return yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error, connectionMethod)));
});

const make = Effect.gen(function* () {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(DpopProof.DpopSigner);
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const directTokenLocks = yield* KeyedLock.make<string>();

  // A route or host check hands its descriptor to the connect it leads to, once,
  // so the connect skips a round trip. Only over HTTPS or loopback: any other
  // plain http address can belong to another machine after a network change.
  const checkedDescriptors = new Map<
    string,
    { readonly descriptor: ExecutionEnvironmentDescriptor; readonly at: bigint }
  >();

  /**
   * A saved LAN address can belong to another machine on a different network.
   */
  const verifyDirectEndpoint = Effect.fn("clientRuntime.connection.remote.verifyDirectEndpoint")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const checked = checkedDescriptors.get(input.httpBaseUrl);
      checkedDescriptors.delete(input.httpBaseUrl);
      // A remembered mismatch still reads again, so a host that answers for the
      // right environment a moment later is not blocked.
      const descriptor =
        checked !== undefined &&
        checked.descriptor.environmentId === input.expectedEnvironmentId &&
        (yield* Clock.monotonicTimeNanos) - checked.at <= CHECKED_DESCRIPTOR_TTL_NANOS
          ? checked.descriptor
          : yield* fetchDescriptor(
              input.httpBaseUrl,
              input.connectionMethod,
              input.connectionMethod === "direct" && isNearbyAddress(input.httpBaseUrl)
                ? NEARBY_DESCRIPTOR_TIMEOUT_MS
                : undefined,
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      return descriptor;
    },
  );

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["expectedEnvironmentId"];
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const descriptor = yield* verifyDirectEndpoint(input);
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        descriptor,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  const createProof = (proof: DpopProof.DpopProofRequest) =>
    Option.isNone(signer)
      ? Effect.fail(
          new ConnectionBlockedError({
            reason: "configuration",
            detail: "This client cannot sign with a device key.",
          }),
        )
      : signer.value.createProof(proof).pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the environment authorization proof.",
              }),
          ),
        );

  // requests for one credential share a renewal w/o waiting on other hosts
  const directDpopToken = Effect.fn("clientRuntime.connection.remote.directDpopToken")(function* (
    connection: DirectDpopConnection,
    rejectedAccessToken?: string,
  ) {
    return yield* directTokenLocks.withLock(
      connection.connectionId,
      Effect.gen(function* () {
        const stored = yield* credentials.get(connection.connectionId);
        if (Option.isNone(stored) || stored.value._tag !== "DpopConnectionCredential") {
          return yield* credentialMissingError(connection.connectionId);
        }
        const current = stored.value;
        const now = yield* Clock.currentTimeMillis;
        if (
          current.accessToken !== rejectedAccessToken &&
          current.expiresAtEpochMs - DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS > now
        ) {
          return current;
        }
        const dpopProof = yield* createProof({
          method: "POST",
          url: environmentEndpointUrl(connection.httpBaseUrl, "/oauth/token"),
        });
        const access = yield* exchangeRemoteDpopAccessToken({
          httpBaseUrl: connection.httpBaseUrl,
          credential: current.accessToken,
          credentialType: AuthAccessTokenType,
          dpopProof,
        }).pipe(
          Effect.mapError((error) => mapRemoteEnvironmentError(error, "direct")),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.withSpan("environment.authorization.directRenewal"),
        );
        const renewed = new DpopConnectionCredential({
          accessToken: access.access_token,
          expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1_000,
        });
        yield* credentials.put(connection.connectionId, renewed);
        return renewed;
      }),
    );
  });

  // untraced since a span here would stay open for the socket's lifetime
  const renewDirectDpopBeforeExpiry = Effect.fnUntraced(function* (
    connection: DirectDpopConnection,
    initialExpiresAtEpochMs: number,
  ) {
    let expiresAtEpochMs = initialExpiresAtEpochMs;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      // the floor spaces out retries & keeps a wall-clock jump from spinning
      const floor = now < expiresAtEpochMs ? 5_000 : DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS;
      yield* Effect.sleep(
        Math.max(floor, expiresAtEpochMs - DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS - now),
      );
      const renewed = yield* directDpopToken(connection).pipe(
        Effect.map((credential) => credential.expiresAtEpochMs),
        Effect.withSpan("environment.authorization.renewSocket"),
        Effect.catchTags({ ConnectionTransientError: () => Effect.succeed(expiresAtEpochMs) }),
      );
      expiresAtEpochMs = Math.max(expiresAtEpochMs, renewed);
    }
  });

  const directHttpAuthorization = (
    connection: DirectDpopConnection,
    credential: DpopConnectionCredential,
  ): DpopHttpAuthorization => ({
    _tag: "Dpop",
    accessToken: credential.accessToken,
    expiresAtEpochMs: credential.expiresAtEpochMs,
    directConnection: connection,
    current: (rejectedAccessToken) =>
      directDpopToken(connection, rejectedAccessToken).pipe(
        Effect.map((renewed) => directHttpAuthorization(connection, renewed)),
      ),
    createProof,
    renewBeforeExpiry: renewDirectDpopBeforeExpiry(connection, credential.expiresAtEpochMs),
  });

  const authorizeDirectDpop = Effect.fn("clientRuntime.connection.remote.authorizeDirectDpop")(
    function* (
      input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDirectDpop"]>[0],
    ) {
      const descriptor = yield* verifyDirectEndpoint({
        expectedEnvironmentId: input.expectedEnvironmentId,
        httpBaseUrl: input.httpBaseUrl,
        connectionMethod: "direct",
      });
      const connection = { connectionId: input.connectionId, httpBaseUrl: input.httpBaseUrl };
      const openSocket = (credential: DpopConnectionCredential) =>
        resolveRemoteDpopWebSocketConnectionUrl({
          wsBaseUrl: input.wsBaseUrl,
          httpBaseUrl: input.httpBaseUrl,
          accessToken: credential.accessToken,
          createProof,
          clientMetadata: presentation.metadata,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.result);
      let credential = yield* directDpopToken(connection);
      let socket = yield* openSocket(credential);
      // a token the host refuses before its expiry, like after a clock jump, renews once
      if (Result.isFailure(socket) && socket.failure._tag === "EnvironmentAuthInvalidError") {
        credential = yield* directDpopToken(connection, credential.accessToken);
        socket = yield* openSocket(credential);
      }
      if (Result.isFailure(socket)) {
        const failure = socket.failure;
        return yield* failure._tag === "ConnectionBlockedError"
          ? failure
          : mapRemoteEnvironmentError(failure, "direct");
      }
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl: socket.success,
        descriptor,
        httpAuthorization: directHttpAuthorization(connection, credential),
      };
    },
  );

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    authorizeDirectDpop,
    // Untraced: it runs on every route and host check.
    rememberCheckedDescriptor: Effect.fnUntraced(function* (httpBaseUrl, descriptor, keepsItsHost) {
      if (Option.isNone(descriptor) || !keepsItsHost) {
        checkedDescriptors.delete(httpBaseUrl);
        return;
      }
      checkedDescriptors.set(httpBaseUrl, {
        descriptor: descriptor.value,
        at: yield* Clock.monotonicTimeNanos,
      });
    }),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
