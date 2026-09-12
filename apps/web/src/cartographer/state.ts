import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const cartographer = {
  analyze: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cartographer:analyze",
    tag: "cartographer.analyze",
  }),
  get: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cartographer:get",
    tag: "cartographer.get",
  }),
  source: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cartographer:source",
    tag: "cartographer.source",
  }),
  dependencies: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "cartographer:dependencies",
    tag: "cartographer.dependencies",
  }),
};
