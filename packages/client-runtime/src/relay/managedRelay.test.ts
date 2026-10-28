import { EnvironmentId } from "@t3tools/contracts";
import { RelayEnvironmentConnectScope } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RELAY_GATEWAY_TIMEOUT_MESSAGE, relayRequestFailureDetail } from "./errorPresentation.ts";
import * as ManagedRelay from "./managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";

function layerManagedRelayTest(
  fetchFn: typeof globalThis.fetch,
  relayUrl = "https://relay.example.test",
  accessTokenStore?: ManagedRelay.ManagedRelayAccessTokenStore,
) {
  const layerHttpClient = RpcHttp.layerRemoteHttpClient(fetchFn);
  const layerSigner = Layer.succeed(
    ManagedRelay.ManagedRelayDpopSigner,
    ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("client-thumbprint"),
      createProof: (input: ManagedRelay.ManagedRelayDpopProofInput) =>
        Effect.succeed(`proof:${input.url}`),
    }),
  );
  return ManagedRelay.layer({
    relayUrl,
    clientId: "t3-mobile",
    ...(accessTokenStore ? { accessTokenStore } : {}),
  }).pipe(Layer.provide(layerSigner), Layer.provide(layerHttpClient));
}

function clerkToken(subject: string, nonce: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode({ sub: subject, nonce })}.signature`;
}

describe("ManagedRelayClient", () => {
  it.effect("rejects unsafe relay URLs before sending credentials", () => {
    let requestCount = 0;
    const fetchFn = (() => {
      requestCount += 1;
      return Promise.resolve(Response.json({}));
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .connectEnvironment({
          clerkToken: "clerk-token",
          scopes: [RelayEnvironmentConnectScope],
          environmentId: EnvironmentId.make("env-1"),
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayUrlInvalidError",
        relayUrl: "http://relay.example.test",
        message: "Relay URL must be a secure absolute HTTPS origin.",
      });
      expect(requestCount).toBe(0);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, "http://relay.example.test")));
  });

  it.effect("reuses a persisted token across runtimes and Clerk session token rotation", () => {
    let tokenExchangeCount = 0;
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.sync(() => persistedTokens),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.sync(() => {
        persistedTokens = [];
      }),
    };
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          Response.json({
            access_token: "persisted-relay-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: RelayEnvironmentConnectScope,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          credential: "environment-credential",
          expiresAt: "2026-06-05T20:05:00.000Z",
        }),
      );
    }) satisfies typeof globalThis.fetch;
    const connectInput = (token: string) =>
      ({
        clerkToken: token,
        scopes: [RelayEnvironmentConnectScope],
        environmentId: EnvironmentId.make("env-1"),
      }) as const;

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const relayClient = yield* ManagedRelay.ManagedRelayClient;
        yield* relayClient.connectEnvironment(connectInput(clerkToken("user-1", "session-1")));
      }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));

      expect(tokenExchangeCount).toBe(1);
      expect(persistedTokens).toHaveLength(1);

      yield* Effect.gen(function* () {
        const relayClient = yield* ManagedRelay.ManagedRelayClient;
        yield* relayClient.connectEnvironment(connectInput(clerkToken("user-1", "session-2")));
      }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));

      expect(tokenExchangeCount).toBe(1);
    });
  });

  it.effect("refreshes a persisted DPoP token once when the relay rejects it", () => {
    let tokenExchangeCount = 0;
    const connectTokens: Array<string | null> = [];
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [
      {
        accountId: "user-1",
        clientId: "t3-mobile",
        relayUrl: "https://relay.example.test",
        thumbprint: "client-thumbprint",
        scopes: [RelayEnvironmentConnectScope],
        accessToken: "stale-relay-token",
        expiresAtMillis: Number.MAX_SAFE_INTEGER,
      },
    ];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.sync(() => persistedTokens),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.sync(() => {
        persistedTokens = [];
      }),
    };
    const fetchFn = ((input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          Response.json({
            access_token: "fresh-relay-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: RelayEnvironmentConnectScope,
          }),
        );
      }

      const authorization = new Headers(init?.headers).get("authorization");
      connectTokens.push(authorization);
      if (authorization === "DPoP stale-relay-token") {
        return Promise.resolve(
          Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_bearer",
              traceId: "trace-stale-token",
            },
            { status: 401 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          credential: "environment-credential",
          expiresAt: "2026-06-05T20:05:00.000Z",
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const result = yield* relayClient.connectEnvironment({
        clerkToken: clerkToken("user-1", "session-1"),
        scopes: [RelayEnvironmentConnectScope],
        environmentId: EnvironmentId.make("env-1"),
      });

      expect(result.credential).toBe("environment-credential");
      expect(connectTokens).toEqual(["DPoP stale-relay-token", "DPoP fresh-relay-token"]);
      expect(tokenExchangeCount).toBe(1);
      expect(persistedTokens).toMatchObject([
        {
          accessToken: "fresh-relay-token",
        },
      ]);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));
  });

  it.effect("does not persist tokens when the Clerk subject cannot be decoded", () => {
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.succeed([]),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.void,
    };
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        return Promise.resolve(
          Response.json({
            access_token: "relay-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: RelayEnvironmentConnectScope,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          credential: "environment-credential",
          expiresAt: "2026-06-05T20:05:00.000Z",
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient.connectEnvironment({
        clerkToken: "not-a-jwt",
        scopes: [RelayEnvironmentConnectScope],
        environmentId: EnvironmentId.make("env-1"),
      });

      expect(persistedTokens).toEqual([]);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));
  });

  it.effect("explains a relay deadline 504 and keeps its trace ID", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          { error: "relay_request_deadline_exceeded" },
          {
            status: 504,
            headers: {
              traceparent: "00-4684d7d140f34f0393d42744d240e207-0baf648c44f4bce6-01",
            },
          },
        ),
      )) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .connectEnvironment({
          clerkToken: "clerk-token",
          scopes: [RelayEnvironmentConnectScope],
          environmentId: EnvironmentId.make("env-1"),
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        status: 504,
        traceId: "4684d7d140f34f0393d42744d240e207",
      });
      expect(
        error._tag === "ManagedRelayRequestFailedError" ? relayRequestFailureDetail(error) : null,
      ).toBe(RELAY_GATEWAY_TIMEOUT_MESSAGE);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });

  it.effect("accepts generic DPoP errors from relays without the optional reason", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "RelayAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_dpop",
            traceId: "trace-old-relay",
          },
          { status: 401 },
        ),
      )) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .connectEnvironment({
          clerkToken: "clerk-token",
          scopes: [RelayEnvironmentConnectScope],
          environmentId: EnvironmentId.make("env-1"),
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        traceId: "trace-old-relay",
        relayError: {
          _tag: "RelayAuthInvalidError",
          reason: "invalid_dpop",
        },
      });
      if (
        error._tag === "ManagedRelayRequestFailedError" &&
        error.relayError?._tag === "RelayAuthInvalidError"
      ) {
        expect(error.relayError.dpopFailureReason).toBeUndefined();
      }
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });
});
