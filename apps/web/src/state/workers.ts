// apps/web/src/state/workers.ts
// web-side binding for the worker-broker environment atoms

import { createWorkersEnvironmentAtoms } from "@t3tools/client-runtime/state/workers";

import { connectionAtomRuntime } from "../connection/runtime";

export const workersEnvironment = createWorkersEnvironmentAtoms(connectionAtomRuntime);
export const workersActivityEnvironment = workersEnvironment.activity;
