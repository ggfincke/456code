// apps/web/src/lib/runtime.test.ts
// keeps relay requests and local traces free of vendor exports
import { expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

it.each(["web", "desktop"])("ignores legacy vendor tracing config on %s", async (surface) => {
  vi.resetModules();
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "relay-test");
  vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
  const fetchFn = vi.fn<typeof fetch>(async (input) =>
    String(input).includes("/v1/traces")
      ? new Response(null, { status: 202 })
      : Response.json({ environments: [] }),
  );
  vi.stubGlobal("window", { desktopBridge: surface === "desktop" ? {} : undefined });
  vi.stubGlobal("fetch", fetchFn);
  const { runtime } = await import("./runtime");
  const { ManagedRelay } = await import("@t3tools/client-runtime/relay");
  const { setDelegate } = await import("../observability/clientTracer");
  const spans: Array<string> = [];

  try {
    setDelegate(
      Tracer.make({
        span(options) {
          spans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      }),
    );
    const list = Effect.flatMap(ManagedRelay.ManagedRelayClient, (client) =>
      client.listEnvironments({ clerkToken: "fixture-token" }),
    );
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
    setDelegate(null);
    await runtime.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(spans).toContain("clientRuntime.managedRelay.listEnvironments");
  for (const [url] of fetchFn.mock.calls) {
    expect(new URL(String(url)).origin).toBe("https://relay.example.test");
  }
});
