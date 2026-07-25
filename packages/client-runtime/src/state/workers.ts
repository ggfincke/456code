// packages/client-runtime/src/state/workers.ts
// environment atoms for the read-only worker-broker jobs surface

import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createWorkersEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // broker state is polled from disk; atoms are idle-TTL'd so polling stops
    // once the panel unmounts
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workers:list",
      tag: WS_METHODS.workersList,
      staleTimeMs: 2_000,
      refreshIntervalMs: 3_000,
    }),
    getJob: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workers:getJob",
      tag: WS_METHODS.workersGetJob,
      staleTimeMs: 4_000,
      refreshIntervalMs: 5_000,
    }),
  };
}
