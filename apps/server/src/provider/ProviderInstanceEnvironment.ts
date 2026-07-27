// apps/server/src/provider/ProviderInstanceEnvironment.ts
// merges provider environments with platform-correct key semantics
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export const HOST_PATH_PLATFORM: NodeJS.Platform =
  NodePath.delimiter === NodePath.win32.delimiter ? "win32" : "linux";

export function normalizeProviderProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = HOST_PATH_PLATFORM,
): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return environment;
  }

  const normalized: NodeJS.ProcessEnv = {};
  const seenNames = new Set<string>();
  for (const name of Object.keys(environment).toSorted()) {
    const foldedName = name.toUpperCase();
    if (seenNames.has(foldedName)) {
      continue;
    }
    seenNames.add(foldedName);
    normalized[foldedName] = environment[name];
  }
  return normalized;
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = HOST_PATH_PLATFORM,
): NodeJS.ProcessEnv {
  const merged =
    platform === "win32"
      ? normalizeProviderProcessEnvironment(baseEnv, platform)
      : !environment || environment.length === 0
        ? baseEnv
        : ({ ...baseEnv } satisfies NodeJS.ProcessEnv);
  for (const variable of environment ?? []) {
    merged[platform === "win32" ? variable.name.toUpperCase() : variable.name] = variable.value;
  }
  return normalizeProviderProcessEnvironment(merged, platform);
}
