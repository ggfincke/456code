// packages/cartographer-core/src/snapshots/worker.ts
// child-process entry: analyzes one captured tree, or lays out one deferred map scope
import * as NodeFSP from "node:fs/promises";
import { buildGraph } from "../analyze/graph.js";
import { buildMap, layoutDeferredScope, type MapFile } from "../map/build.js";

// writes atomically so a request racing another for the same scope reads a whole file
async function runLayout(map: string, scopeId: string, output: string): Promise<void> {
  const file = JSON.parse(await NodeFSP.readFile(map, "utf8")) as MapFile;
  const layout = await layoutDeferredScope(file, scopeId);
  const temporary = `${output}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(layout), { flag: "wx" });
  await NodeFSP.rename(temporary, output);
}

export async function runAnalysisWorker(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--layout") {
    const [map, scopeId, output] = rest;
    if (!map || !scopeId || !output) throw new Error("Missing map layout input.");
    return runLayout(map, scopeId, output);
  }
  const [root, output, identity, map] = [first, ...rest];
  if (!root || !output || !identity) throw new Error("Missing immutable analysis input.");
  const graph = await buildGraph({ root, scope: ".", staticTree: { gitRef: identity } });
  await NodeFSP.writeFile(output, JSON.stringify(graph), { flag: "wx" });
  if (map) await NodeFSP.writeFile(map, JSON.stringify(await buildMap(graph)), { flag: "wx" });
}
