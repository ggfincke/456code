// apps/mobile/src/state/vcs.ts
// binds mobile version control atoms and commands to the connection runtime

import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = {
  ...createVcsEnvironmentAtoms(connectionAtomRuntime),
  refreshRefs: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:vcs:refresh-refs",
    tag: WS_METHODS.vcsListRefs,
  }),
};
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
