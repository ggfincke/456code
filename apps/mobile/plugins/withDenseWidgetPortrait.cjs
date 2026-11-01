// apps/mobile/plugins/withDenseWidgetPortrait.cjs
// enables the ios 27 portrait family until expo exposes it
"use strict";

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

module.exports = function withDenseWidgetPortrait(config) {
  // expo's reverse-ordered mods must generate the source first
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const sourcePath = path.join(
        cfg.modRequest.platformProjectRoot,
        "ExpoWidgetsTarget",
        "DenseWidget.swift",
      );
      const source = fs.readFileSync(sourcePath, "utf8");
      if (source.includes(".systemExtraLargePortrait")) return cfg;
      const updated = source.replace(
        /\.supportedFamilies\((\[[^\]]+\])\)/,
        (_, families) =>
          `.supportedFamilies({ () -> [WidgetFamily] in
      if #available(iOS 27.0, *) {
        return ${families.slice(0, -1)}, .systemExtraLargePortrait]
      }
      return ${families}
    }())`,
      );
      if (updated === source) throw new Error("DenseWidget supportedFamilies declaration missing");
      fs.writeFileSync(sourcePath, updated);
      return cfg;
    },
  ]);
};
