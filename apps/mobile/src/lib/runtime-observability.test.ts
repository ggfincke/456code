// apps/mobile/src/lib/runtime-observability.test.ts
// keeps legacy vendor config from exporting mobile relay traces
import { expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        relay: { url: "https://relay.example.test" },
        observability: {
          tracesUrl: "https://telemetry.example.test/v1/traces",
          tracesDataset: "mobile-test",
          tracesToken: "legacy-token",
        },
      },
    },
  },
}));
vi.mock("./protectedData", () => ({ whenProtectedDataAvailable: async () => {} }));
vi.mock("../persistence/layer", async () => ({ layer: (await import("effect/Layer")).empty }));
vi.mock("../features/cloud/dpop", async () => ({ layer: (await import("effect/Layer")).empty }));
vi.mock("../features/cloud/managedRelayLayer", async () => {
  const { ManagedRelay } = await import("@t3tools/client-runtime/relay");
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  return {
    layer: (relayUrl: string) =>
      ManagedRelay.layer({ relayUrl, clientId: "t3-mobile" }).pipe(
        Layer.provide(
          Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
            thumbprint: Effect.succeed("fixture-thumbprint"),
            createProof: () => Effect.succeed("fixture-proof"),
          }),
        ),
      ),
  };
});

it("keeps relay results, failures and local spans without vendor exports", async () => {
  const fetchFn = vi.fn<typeof fetch>(async (input) =>
    String(input).includes("/v1/traces")
      ? new Response(null, { status: 202 })
      : Response.json({ environments: [] }),
  );
  vi.stubGlobal("fetch", fetchFn);
  const { runtime } = await import("./runtime");
  const { ManagedRelay } = await import("@t3tools/client-runtime/relay");
  const spans: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      spans.push(options.name);
      return new Tracer.NativeSpan(options);
    },
  });
  try {
    const list = Effect.flatMap(ManagedRelay.ManagedRelayClient, (client) =>
      client.listEnvironments({ clerkToken: "fixture-token" }),
    ).pipe(Effect.provideService(Tracer.Tracer, tracer));
    expect(await runtime.runPromise(list)).toEqual([]);
    fetchFn.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    const failed = await runtime.runPromise(Effect.exit(list));
    expect(failed._tag).toBe("Failure");
    if (failed._tag === "Failure") {
      expect(Option.getOrThrow(Cause.findErrorOption(failed.cause))).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        status: 503,
      });
    }
  } finally {
    await runtime.dispose();
    vi.unstubAllGlobals();
  }
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(spans).toContain("clientRuntime.managedRelay.listEnvironments");
  for (const [url] of fetchFn.mock.calls) {
    expect(new URL(String(url)).origin).toBe("https://relay.example.test");
  }
});
