// apps/mobile/vite.config.ts
// runs this package's suite from the repo-root tests tree

import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      dedupe: [
        "@clerk/expo",
        "@expo/ui",
        "@legendapp/list",
        "@pierre/diffs",
        "@react-navigation/native",
        "@t3tools/mobile-markdown-text",
        "expo",
        "expo-clipboard",
        "expo-constants",
        "expo-file-system",
        "expo-notifications",
        "expo-sharing",
        "expo-sqlite",
        "expo-widgets",
        "react",
        "react-dom",
        "react-native",
        "react-native-nitro-markdown",
      ],
    },
    test: {
      dir: "../../tests/apps/mobile",
    },
  }),
);
