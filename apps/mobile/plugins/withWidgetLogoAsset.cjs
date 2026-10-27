// apps/mobile/plugins/withWidgetLogoAsset.cjs
// installs the shared ocean artwork in the ios widget asset catalog

"use strict";

// Precede expo-widgets so its reverse-ordered mods create and wipe the target before assets are added.

const path = require("path");
const fs = require("fs");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");
const { addWidgetAssetCatalog } = require("./lib/addWidgetAssetCatalog.cjs");

const TARGET_NAME = "ExpoWidgetsTarget";
const CATALOG_NAME = "Assets.xcassets";
const IMAGE_SET = "T3Mark.imageset";
const IMAGE_NAME = "OceanMark.png";

const CATALOG_CONTENTS = JSON.stringify({ info: { author: "expo", version: 1 } }, null, 2) + "\n";
const IMAGE_SET_CONTENTS =
  JSON.stringify(
    {
      images: [{ idiom: "universal", filename: IMAGE_NAME }],
      info: { author: "expo", version: 1 },
    },
    null,
    2,
  ) + "\n";

function withAssetFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const source = path.join(
        cfg.modRequest.projectRoot,
        "..",
        "..",
        "assets",
        "fincke",
        "ocean-universal-1024.png",
      );
      const catalogDir = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME, CATALOG_NAME);
      const imageSetDir = path.join(catalogDir, IMAGE_SET);
      fs.mkdirSync(imageSetDir, { recursive: true });
      fs.writeFileSync(path.join(catalogDir, "Contents.json"), CATALOG_CONTENTS);
      fs.writeFileSync(path.join(imageSetDir, "Contents.json"), IMAGE_SET_CONTENTS);
      fs.copyFileSync(source, path.join(imageSetDir, IMAGE_NAME));
      return cfg;
    },
  ]);
}

function withAssetWiring(config) {
  return withXcodeProject(config, (cfg) => {
    addWidgetAssetCatalog(cfg.modResults, { targetName: TARGET_NAME });
    return cfg;
  });
}

module.exports = function withWidgetLogoAsset(config) {
  return withAssetWiring(withAssetFiles(config));
};
