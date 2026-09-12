import * as NodeFSP from "node:fs/promises";
import { buildGraph } from "../analyze/graph.js";

export async function runAnalysisWorker(): Promise<void> {
  const [root, output, identity] = process.argv.slice(2);
  if (!root || !output || !identity) throw new Error("Missing immutable analysis input.");
  const graph = await buildGraph({ root, scope: ".", staticTree: { gitRef: identity } });
  await NodeFSP.writeFile(output, JSON.stringify(graph), { flag: "wx" });
}
