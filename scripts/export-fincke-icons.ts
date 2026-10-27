// scripts/export-fincke-icons.ts
// exports the selected fincke svg for desktop, native mobile, and web
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url));
  const master = yield* fs.readFileString(path.join(root, "assets/fincke/ocean-icon.svg"));
  const contents = master.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/)?.[1];
  if (!contents) throw new Error("The Fincke icon source must contain an SVG document.");

  const fullBleed = master
    .replace('viewBox="0 0 1024 1024"', 'viewBox="28 28 968 968"')
    .replace(' clip-path="url(#tile)"', "")
    .replace(/<path id="icon-edge"[^>]*\/>/, "");

  // the source body spans 28..996; macos needs an 824px body inset by 100px
  const macos = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><svg x="100" y="100" width="824" height="824" viewBox="28 28 968 968">${contents}</svg></svg>`;

  const rasterize = (svg: string, size: number, opaque = false) => {
    const image = sharp(Buffer.from(svg)).resize(size, size);
    return (opaque ? image.removeAlpha() : image).png().toBuffer();
  };

  const variants = [
    ["ocean-universal-1024.png", master, 1024, false],
    ["ocean-macos-1024.png", macos, 1024, false],
    ["ocean-ios-1024.png", fullBleed, 1024, true],
    ["ocean-web-apple-touch-180.png", fullBleed, 180, true],
  ] as const;
  const outputs = new Map<string, Buffer>(
    yield* Effect.promise(() =>
      Promise.all(
        variants.map(
          async ([name, svg, size, opaque]) => [name, await rasterize(svg, size, opaque)] as const,
        ),
      ),
    ),
  );
  const renditions = yield* Effect.promise(() =>
    Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({
        size,
        contents: await rasterize(master, size),
      })),
    ),
  );
  for (const { size, contents: png } of renditions) {
    if (size === 16 || size === 32) outputs.set(`ocean-web-favicon-${size}x${size}.png`, png);
  }
  const ico = encodePngIco(renditions);
  outputs.set("ocean-windows.ico", ico);
  outputs.set("ocean-web-favicon.ico", ico);

  for (const [name, contents] of outputs) {
    yield* fs.writeFile(path.join(root, "assets/fincke", name), contents);
  }
  for (const [source, target] of [
    ["ocean-web-favicon.ico", "favicon.ico"],
    ["ocean-web-favicon-16x16.png", "favicon-16x16.png"],
    ["ocean-web-favicon-32x32.png", "favicon-32x32.png"],
    ["ocean-web-apple-touch-180.png", "apple-touch-icon.png"],
  ] as const) {
    const contents = outputs.get(source);
    if (!contents) throw new Error(`Missing generated icon: ${source}`);
    yield* fs.writeFile(path.join(root, "apps/web/public", target), contents);
  }
  yield* Console.log(`Exported ${outputs.size} Fincke icons and updated web public assets.`);
});

await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)));
