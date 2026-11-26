// packages/client-runtime/src/authorization/layer.test.ts
// verifies remote bearer authorization keeps destination boundaries
import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as DpopProof from "./dpopProof.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCredential,
  DpopConnectionCredential,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as ConnectionResolver from "../connection/resolver.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: {
    os: "linux",
    arch: "x64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

type RecordedResponse = Response | ((init: RequestInit) => Response | Promise<Response>);

function recordedFetch(responses: ReadonlyArray<RecordedResponse>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(typeof response === "function" ? response(init ?? {}) : response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

const websocketTicket = (ticket: string) =>
  Response.json({
    ticket,
    expiresAt: "2026-06-06T01:00:00.000Z",
  });

const accessToken = (token: string) =>
  Response.json({
    access_token: token,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "DPoP",
    expires_in: 3_600,
    scope: AuthStandardClientScopes.join(" "),
  });

const makeHarness = Effect.fn("TestRemoteAuthorization.makeHarness")(function* (input: {
  readonly responses: ReadonlyArray<RecordedResponse>;
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
}) {
  const fetch = recordedFetch(input.responses);
  const proofInputs = yield* Ref.make<ReadonlyArray<DpopProof.DpopProofRequest>>([]);
  const layer = RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ConnectionCredentialStore.layerMemory(input.credentials),
        Layer.succeed(
          DpopProof.DpopSigner,
          DpopProof.DpopSigner.of({
            createProof: (proof) =>
              Ref.update(proofInputs, (inputs) => [...inputs, proof]).pipe(Effect.as("proof")),
          }),
        ),
        RpcHttp.layerRemoteHttpClient(fetch.fetchFn),
        Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: {
              label: "T3 Code Test",
              deviceType: "mobile",
              os: "test",
            },
          }),
        ),
      ),
    ),
  );
  return { layer, fetch, proofInputs };
});

const prepareDirectBearer = Effect.fn("TestRemoteAuthorization.prepareDirectBearer")(function* (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  times: number,
) {
  const target = new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: DESCRIPTOR.label,
    connectionId: "direct-1",
  });
  const entry = {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: target.connectionId,
        environmentId: ENVIRONMENT_ID,
        label: target.label,
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      }),
    ),
    enabled: true,
  };
  const unused = () => Effect.die("unused");
  const layer = ConnectionResolver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
          get: unused,
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
          get: () => Effect.succeedSome(new BearerConnectionCredential({ token: "bearer-token" })),
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
          bearerToken: Effect.succeedNone,
        }),
      ),
    ),
  );
  const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layer));
  return yield* Effect.forEach(Array.from({ length: times }), () =>
    resolver.prepare(entry).pipe(Effect.result),
  );
});

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("prepares a cold direct bearer connection with one descriptor request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json({
            ...DESCRIPTOR,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
          websocketTicket("cold-ticket"),
        ],
      });

      const [prepared] = yield* prepareDirectBearer(harness, 1);

      expect(prepared).toMatchObject({
        _tag: "Success",
        success: { socketUrl: expect.stringContaining("wsTicket=cold-ticket") },
      });
      expect(harness.fetch.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/.well-known/t3/environment",
        "/api/auth/websocket-ticket/rpc",
      ]);
    }),
  );

  it.effect("reuses a matching descriptor a check just read, once, while fresh", () =>
    Effect.gen(function* () {
      const descriptor = {
        ...DESCRIPTOR,
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      } as ExecutionEnvironmentDescriptor;
      const harness = yield* makeHarness({
        responses: [
          websocketTicket("reused"),
          ...Array.from({ length: 4 }, () => [
            Response.json(descriptor),
            websocketTicket("fresh"),
          ]).flat(),
          websocketTicket("reused over plain HTTP"),
          Response.json(descriptor),
          websocketTicket("fresh"),
        ],
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorizeAt = (httpBaseUrl: string) =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
            bearerToken: "bearer-token",
            connectionMethod: "direct",
          });
        const authorize = authorizeAt(ENDPOINT.httpBaseUrl);
        const remember = (value: Option.Option<ExecutionEnvironmentDescriptor>) =>
          remote.rememberCheckedDescriptor(ENDPOINT.httpBaseUrl, value, true);

        yield* remember(Option.some(descriptor));
        yield* authorize;
        // Used once.
        yield* authorize;
        // Stale.
        yield* remember(Option.some(descriptor));
        yield* TestClock.adjust("6 seconds");
        yield* authorize;
        // A mismatch reads again, so a host back on the right environment is not blocked.
        yield* remember(Option.some({ ...descriptor, environmentId: "other" as never }));
        yield* authorize;
        // A failed check drops an older match.
        yield* remember(Option.some(descriptor));
        yield* remember(Option.none());
        yield* authorize;
        // Plain HTTP is no reason to read again where the address keeps its host.
        yield* remote.rememberCheckedDescriptor(
          "http://127.0.0.1:3773",
          Option.some(descriptor),
          true,
        );
        yield* authorizeAt("http://127.0.0.1:3773");
        // After a network change, a plain LAN address can belong to another machine.
        yield* remote.rememberCheckedDescriptor(
          "http://192.168.1.2:3773",
          Option.some(descriptor),
          false,
        );
        yield* authorizeAt("http://192.168.1.2:3773");
      }).pipe(Effect.provide(harness.layer));

      expect(harness.fetch.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/api/auth/websocket-ticket/rpc",
        ...Array.from({ length: 4 }, () => [
          "/.well-known/t3/environment",
          "/api/auth/websocket-ticket/rpc",
        ]).flat(),
        "/api/auth/websocket-ticket/rpc",
        "/.well-known/t3/environment",
        "/api/auth/websocket-ticket/rpc",
      ]);
    }),
  );

  it.effect("blocks a warm direct bearer prepare when the environment changes identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json({
            ...DESCRIPTOR,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
          websocketTicket("first-ticket"),
          Response.json({
            ...DESCRIPTOR,
            environmentId: "another-environment",
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
        ],
      });

      const [first, second] = yield* prepareDirectBearer(harness, 2);

      expect(first?._tag).toBe("Success");
      expect(second).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
      });
      expect(
        harness.fetch.calls.filter(([url]) =>
          String(url).endsWith("/api/auth/websocket-ticket/rpc"),
        ),
      ).toHaveLength(1);
    }),
  );
  it.effect("validates a fresh bearer descriptor while issuing fresh websocket tickets", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          Response.json(DESCRIPTOR),
          websocketTicket("second-ticket"),
        ],
      });

      const [first, second] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "bearer-token",
            connectionMethod: "direct",
          });
        return [yield* authorize(), yield* authorize()] as const;
      }).pipe(Effect.provide(harness.layer));

      expect(first.socketUrl).toContain("wsTicket=first-ticket");
      expect(second.socketUrl).toContain("wsTicket=second-ticket");
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(2);
      expect(
        harness.fetch.calls.filter(([url]) =>
          String(url).endsWith("/api/auth/websocket-ticket/rpc"),
        ),
      ).toHaveLength(2);
    }),
  );

  it.effect("gives up on a silent loopback or LAN address sooner than on a remote one", () =>
    Effect.gen(function* () {
      const silent = () => new Promise<Response>(() => {});
      const harness = yield* makeHarness({ responses: [silent, silent, silent] });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorizeAt = (httpBaseUrl: string, connectionMethod: "direct" | "ssh" = "direct") =>
          remote
            .authorizeBearer({
              expectedEnvironmentId: ENVIRONMENT_ID,
              httpBaseUrl,
              wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
              bearerToken: "bearer-token",
              connectionMethod,
            })
            .pipe(Effect.flip, Effect.forkChild);
        const lan = yield* authorizeAt("http://192.168.1.2:3773");
        const tailnet = yield* authorizeAt("http://100.101.102.103:3773");
        // An SSH forward listens on loopback but reaches a remote host.
        const forwarded = yield* authorizeAt("http://127.0.0.1:4010", "ssh");

        yield* TestClock.adjust("3 seconds");
        expect(lan.pollUnsafe()).toBeDefined();
        expect(tailnet.pollUnsafe()).toBeUndefined();
        expect(forwarded.pollUnsafe()).toBeUndefined();
        expect(yield* Fiber.join(lan)).toMatchObject({
          _tag: "ConnectionTransientError",
          reason: "timeout",
        });

        yield* TestClock.adjust("7 seconds");
        expect(tailnet.pollUnsafe()).toBeDefined();
        expect(forwarded.pollUnsafe()).toBeDefined();
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("renews an expired direct DPoP token with the host and keeps the renewal", () =>
    Effect.gen(function* () {
      const renewal = (init: RequestInit) => {
        const fields = new URLSearchParams(
          init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body),
        );
        expect(fields.get("subject_token")).toBe("expired-direct-token");
        expect(fields.get("subject_token_type")).toBe(
          "urn:ietf:params:oauth:token-type:access_token",
        );
        return accessToken("renewed-direct-token");
      };
      const harness = yield* makeHarness({
        responses: [Response.json(DESCRIPTOR), renewal, websocketTicket("direct-ticket")],
        credentials: [
          [
            "direct-1",
            new DpopConnectionCredential({
              accessToken: "expired-direct-token",
              expiresAtEpochMs: 0,
            }),
          ],
        ],
      });

      const [authorized, stored] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
        const authorized = yield* remote.authorizeDirectDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          connectionId: "direct-1",
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          wsBaseUrl: ENDPOINT.wsBaseUrl,
        });
        return [authorized, yield* credentials.get("direct-1")] as const;
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=direct-ticket");
      expect(authorized.httpAuthorization).toMatchObject({
        _tag: "Dpop",
        accessToken: "renewed-direct-token",
        directConnection: { connectionId: "direct-1", httpBaseUrl: ENDPOINT.httpBaseUrl },
      });
      expect(Option.getOrThrow(stored)).toMatchObject({
        _tag: "DpopConnectionCredential",
        accessToken: "renewed-direct-token",
      });
      expect((yield* Ref.get(harness.proofInputs)).map((proof) => proof.url)).toEqual([
        `${ENDPOINT.httpBaseUrl}/oauth/token`,
        `${ENDPOINT.httpBaseUrl}/api/auth/websocket-ticket/rpc`,
        `${ENDPOINT.httpBaseUrl}/ws`,
      ]);
    }),
  );

  it.effect("renews another direct host while the first host is unresponsive", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<Response>();
      const other = "https://other.example.test";
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          Response.json(DESCRIPTOR),
          websocketTicket("second-ticket"),
          () => {
            started.resolve();
            return release.promise;
          },
          () => accessToken("renewed-second-token"),
        ],
        credentials: ["direct-1", "direct-2"].map((connectionId) => [
          connectionId,
          new DpopConnectionCredential({ accessToken: connectionId, expiresAtEpochMs: 3_600_000 }),
        ]),
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = (connectionId: string, httpBaseUrl: string) =>
          remote
            .authorizeDirectDpop({
              expectedEnvironmentId: ENVIRONMENT_ID,
              connectionId,
              httpBaseUrl,
              wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
            })
            .pipe(
              Effect.flatMap(({ httpAuthorization }) =>
                httpAuthorization?._tag === "Dpop"
                  ? Effect.succeed(httpAuthorization)
                  : Effect.die("expected a DPoP authorization"),
              ),
            );
        const first = yield* authorize("direct-1", ENDPOINT.httpBaseUrl);
        const second = yield* authorize("direct-2", other);
        const pending = yield* first.current("direct-1").pipe(Effect.forkScoped);
        yield* Effect.promise(() => started.promise);
        const healthy = yield* second
          .current("direct-2")
          .pipe(Effect.timeoutOption("1 second"), Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(healthy)).toMatchObject({
          _tag: "Some",
          value: { accessToken: "renewed-second-token" },
        });
        release.resolve(accessToken("renewed-first-token"));
        expect((yield* Fiber.join(pending)).accessToken).toBe("renewed-first-token");
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
    }),
  );

  it.effect("keeps renewing a direct socket after a failed renewal", () =>
    Effect.gen(function* () {
      let markLoopRenewal = () => {};
      const loopRenewed = new Promise<void>((resolve) => (markLoopRenewal = resolve));
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("direct-ticket"),
          () => Promise.reject(new TypeError("network down")),
          () => {
            markLoopRenewal();
            return accessToken("renewed-direct-token");
          },
        ],
        credentials: [
          [
            "direct-1",
            new DpopConnectionCredential({
              accessToken: "direct-token",
              expiresAtEpochMs: 120_000,
            }),
          ],
        ],
      });

      const renewed = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const { httpAuthorization } = yield* remote.authorizeDirectDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          connectionId: "direct-1",
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          wsBaseUrl: ENDPOINT.wsBaseUrl,
        });
        if (httpAuthorization?._tag !== "Dpop") return yield* Effect.die("expected DPoP");
        yield* httpAuthorization.renewBeforeExpiry.pipe(Effect.forkScoped);
        // The first try, a minute before expiry, fails on the network.
        yield* TestClock.adjust(60_000);
        // A transient failure keeps the loop alive, so it tries again.
        yield* TestClock.adjust(5_000);
        yield* Effect.promise(() => loopRenewed);
        // Waits behind the loop's renewal and reads what it stored, with no request of its own.
        return yield* httpAuthorization.current();
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(renewed.accessToken).toBe("renewed-direct-token");
    }),
  );
});
