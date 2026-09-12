import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const applyFinckeWebAssets = Effect.fn("applyFinckeWebAssets")(function* (
  targetDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
  for (const [source, target] of [
    ["ocean-web-favicon.ico", "favicon.ico"],
    ["ocean-web-favicon-16x16.png", "favicon-16x16.png"],
    ["ocean-web-favicon-32x32.png", "favicon-32x32.png"],
    ["ocean-web-apple-touch-180.png", "apple-touch-icon.png"],
  ] as const) {
    yield* fs.copyFile(
      path.join(root, "assets/fincke", source),
      path.join(root, targetDirectory, target),
    );
  }
});
