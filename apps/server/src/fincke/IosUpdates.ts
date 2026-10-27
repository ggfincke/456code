// apps/server/src/fincke/IosUpdates.ts
// serves the iPhone app's staged js bundle over the expo updates protocol v1
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Mime from "effect/http/Mime";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";

const ROUTE_PREFIX = "/api/fincke/ios-update";
const ASSET_ROUTE_PREFIX = `${ROUTE_PREFIX}/assets/`;
// the body is a json manifest we stage ourselves, so a fixed boundary cannot collide
const MULTIPART_BOUNDARY = "456code-ios-update-manifest";

// a single path segment: no separators, dot segments, or NULs
const PLAIN_NAME = /^(?!\.{1,2}$)[^/\\\0]+$/;
const isPlainName = (name: string) => PLAIN_NAME.test(name);

// mirrors parseStagedUpdateManifest in scripts/lib/fincke-staged-update.ts, which the server
// can't import; `artifact` names the directory holding this build's expo manifest & assets
const decodeStagedManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
      commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
      builtAt: Schema.String,
      artifact: Schema.String.check(Schema.isPattern(PLAIN_NAME)),
    }),
  ),
);

// only the fields the update check compares; the body itself is served as written
const decodeExpoManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, runtimeVersion: Schema.String })),
);

/**
 * The iPhone app's expo-updates client polls this server for JS bundles the local stager builds
 * from main and writes to `<baseDir>/updates/ios/`. expo-updates cannot carry the app's session
 * credentials, so the routes below are public and read-only; they only expose compiled JS from
 * the public repo, on a tailnet-only server.
 */
export class IosUpdates extends Context.Service<
  IosUpdates,
  {
    /** The staged protocol manifest body when the client should download it, otherwise null. */
    readonly availableManifest: (client: {
      readonly runtimeVersion: string | undefined;
      readonly currentUpdateId: string | undefined;
    }) => Effect.Effect<string | null>;
    /** Absolute path of a staged asset file, or null when it is missing or not a plain path. */
    readonly assetPath: (
      artifact: string,
      segments: ReadonlyArray<string>,
    ) => Effect.Effect<string | null>;
  }
>()("t3/fincke/IosUpdates") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const updatesDir = path.resolve(config.baseDir, "updates", "ios");

  // nothing staged yet is the normal case, so a missing or unreadable file is just "no update"
  const readOptional = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(Effect.option);

  const availableManifest = Effect.fn("IosUpdates.availableManifest")(function* (client: {
    readonly runtimeVersion: string | undefined;
    readonly currentUpdateId: string | undefined;
  }) {
    const stagedRaw = yield* readOptional(path.join(updatesDir, "manifest.json"));
    if (Option.isNone(stagedRaw)) return null;
    const staged = decodeStagedManifest(stagedRaw.value);
    if (Option.isNone(staged)) {
      yield* Effect.logWarning("Ignoring an invalid staged iOS update manifest.", { updatesDir });
      return null;
    }

    const raw = yield* readOptional(
      path.join(updatesDir, staged.value.artifact, "expo-manifest.json"),
    );
    if (Option.isNone(raw)) return null;
    const manifest = decodeExpoManifest(raw.value);
    if (Option.isNone(manifest)) {
      yield* Effect.logWarning("Ignoring an invalid staged iOS expo manifest.", {
        artifact: staged.value.artifact,
      });
      return null;
    }

    // a bundle built for another native runtime would crash on launch
    if (client.runtimeVersion !== manifest.value.runtimeVersion) return null;
    // expo-updates sends lowercase uuids
    if (client.currentUpdateId?.toLowerCase() === manifest.value.id.toLowerCase()) return null;
    return raw.value;
  });

  const assetPath = Effect.fn("IosUpdates.assetPath")(function* (
    artifact: string,
    segments: ReadonlyArray<string>,
  ) {
    if (!isPlainName(artifact) || segments.length === 0 || !segments.every(isPlainName)) {
      return null;
    }
    const artifactDir = path.join(updatesDir, artifact);
    const filePath = path.resolve(artifactDir, ...segments);
    if (!filePath.startsWith(`${artifactDir}${path.sep}`)) return null;
    const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
    return Option.isSome(info) && info.value.type === "File" ? filePath : null;
  });

  return IosUpdates.of({ availableManifest, assetPath });
});

const layer = Layer.effect(IosUpdates, make);

// 204 + expo-protocol-version is how protocol 1 says "no update" (FileDownloader.parseManifestResponse)
const noUpdateResponse = () =>
  HttpServerResponse.empty({
    status: 204,
    headers: { "expo-protocol-version": "1", "cache-control": "private, max-age=0" },
  });

// decodeURIComponent throws on malformed escapes; those paths simply don't exist
const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

const assetContentType = (filePath: string) =>
  /\.(?:hbc|bundle|js)$/i.test(filePath)
    ? "application/javascript"
    : Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");

// raw routes skip auth unless they call it, which these deliberately don't (see IosUpdates)
export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const iosUpdates = yield* IosUpdates;
    yield* router.add(
      "GET",
      `${ROUTE_PREFIX}/manifest`,
      Effect.gen(function* () {
        const { headers } = yield* HttpServerRequest.HttpServerRequest;
        if (headers["expo-protocol-version"] !== "1" || headers["expo-platform"] !== "ios") {
          const message = "Expected expo-protocol-version: 1 and expo-platform: ios.";
          return HttpServerResponse.text(message, { status: 400 });
        }
        const manifest = yield* iosUpdates.availableManifest({
          runtimeVersion: headers["expo-runtime-version"],
          currentUpdateId: headers["expo-current-update-id"],
        });
        if (manifest === null) return noUpdateResponse();
        const body = [
          `--${MULTIPART_BOUNDARY}`,
          'content-disposition: form-data; name="manifest"',
          "content-type: application/json; charset=utf-8",
          "",
          manifest,
          `--${MULTIPART_BOUNDARY}--`,
          "",
        ].join("\r\n");
        return HttpServerResponse.text(body, {
          contentType: `multipart/mixed; boundary=${MULTIPART_BOUNDARY}`,
          headers: {
            "expo-protocol-version": "1",
            "expo-sfv-version": "0",
            "cache-control": "private, max-age=0",
          },
        });
      }),
    );
    yield* router.add(
      "GET",
      `${ASSET_ROUTE_PREFIX}*`,
      Effect.gen(function* () {
        const notFound = HttpServerResponse.text("Not Found", { status: 404 });
        const request = yield* HttpServerRequest.HttpServerRequest;
        // URL parsing collapses literal & %2e dot segments, so a traversal falls outside the prefix
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url) || !url.value.pathname.startsWith(ASSET_ROUTE_PREFIX)) {
          return notFound;
        }
        const segments = url.value.pathname
          .slice(ASSET_ROUTE_PREFIX.length)
          .split("/")
          .map(decodeSegment);
        if (segments.some((segment) => segment === null)) return notFound;
        const [artifact, ...rest] = segments.filter((segment) => segment !== null);
        if (artifact === undefined) return notFound;

        const filePath = yield* iosUpdates.assetPath(artifact, rest);
        if (filePath === null) return notFound;
        return yield* HttpServerResponse.file(filePath, {
          contentType: assetContentType(filePath),
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        }).pipe(Effect.orElseSucceed(() => notFound));
      }),
    );
  }),
).pipe(Layer.provide(layer));
