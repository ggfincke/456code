import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CoralSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { checkCoralProviderStatus } from "./CoralProvider.ts";

const decodeSettings = Schema.decodeUnknownEffect(CoralSettings);
const encodeLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const fixture = Effect.fn("coral.probe.fixture")(function* (mode = "ready") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "coral-probe-" });
  const entry = path.join(dir, "agent.cjs");
  const log = path.join(dir, "requests");
  const pid = path.join(dir, "pid");
  yield* fs.writeFileString(log, "");
  yield* fs.writeFileString(
    entry,
    `
const fs = require('node:fs');
fs.writeFileSync(${encodeLiteral(pid)}, String(process.pid));
const mode = ${encodeLiteral(mode)};
if (mode === 'old') { console.log('Usage: coral [options]'); process.exit(0); }
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${encodeLiteral(log)}, request.method + '\\n');
  if (mode === 'hang') return;
  console.log(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{protocolVersion: mode === 'protocol' ? 99 : 1,
    agentInfo: {name: 'coral', version: 'fixture'},
    agentCapabilities: {sessionCapabilities: mode === 'no-resume' ? {} : {resume:{}}},
    authMethods: mode === 'auth' ? [{id:'required', name:'Required'}] : []}}));
}).on('close', () => process.exit(0));
`,
  );
  const binary = path.join(dir, "coral");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  yield* fs.writeFileString(
    binary,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`,
  );
  yield* fs.chmod(binary, 0o755);
  const requests: string[] = [];
  let response = Response.json({
    models: [{ name: "local:model" }, { name: "model with spaces" }],
  });
  const client = HttpClient.make((request) => {
    requests.push(`${request.method} ${request.url}`);
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const settings = yield* decodeSettings({
    enabled: true,
    binaryPath: binary,
    ollamaHost: "http://ollama.test/proxy",
  });
  return {
    settings,
    requests,
    setResponse: (value: Response) => {
      response = value;
    },
    check: (previous?: Parameters<typeof checkCoralProviderStatus>[2]) =>
      checkCoralProviderStatus(settings, process.env, previous).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
    log: fs.readFileString(log),
    pid: fs.readFileString(pid),
  };
});

it.effect(
  "discovers exact models through metadata only and retains them after a failed refresh",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const ready = yield* f.check();
      expect(ready.status).toBe("ready");
      expect(ready.models.map((model) => model.slug)).toEqual(["local:model", "model with spaces"]);
      expect(yield* f.log).toBe("initialize\n");
      expect(f.requests).toEqual(["GET http://ollama.test/proxy/api/tags"]);
      const pid = Number(yield* f.pid);
      expect(() => process.kill(pid, 0)).toThrow();
      f.setResponse(new Response("unavailable", { status: 503 }));
      const failed = yield* f.check(ready.models);
      expect(failed.status).toBe("error");
      expect(failed.models).toEqual(ready.models);
      f.setResponse(Response.json({ models: [] }));
      const empty = yield* f.check(ready.models);
      expect(empty.status).toBe("error");
      expect(empty.models).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect(
  "rejects non-ACP, incompatible resume/protocol, and required-auth agents without creating sessions",
  () =>
    Effect.gen(function* () {
      for (const mode of ["old", "no-resume", "protocol", "auth"]) {
        const f = yield* fixture(mode);
        expect((yield* f.check()).status).toBe("error");
        expect(yield* f.log).not.toContain("session/");
        expect(yield* f.log).not.toContain("authenticate");
        expect(f.requests).toEqual([]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
);

it.effect(
  "times out an unresponsive probe and releases its process",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("hang");
      const result = yield* f.check();
      expect(result.status).toBe("error");
      expect(result.message).toContain("timed out");
      expect(f.requests).toEqual([]);
      const pid = Number(yield* f.pid);
      expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive),
  15_000,
);
