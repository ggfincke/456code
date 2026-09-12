import { runBuildPipeline } from "../../store/pipeline.js";
import { graphBuildOptions, type CliValues } from "../lib/args.js";
import { logSummary, warnUnignoredArtifacts, writeReport } from "../lib/artifacts.js";

export const runBuild = async (root: string, values: CliValues): Promise<void> => {
  const staticTreeRef = values["static-tree-ref"];
  if (staticTreeRef !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(staticTreeRef))
    throw new Error("invalid --static-tree-ref -> expected a captured Git object ID");
  const { graph, graphPath, snapshotId } = await runBuildPipeline({
    ...graphBuildOptions(root, values),
    ...(staticTreeRef === undefined ? {} : { staticTree: { gitRef: staticTreeRef } }),
    ...(values.out === undefined ? {} : { outDir: values.out }),
    snapshot: values["no-history"] !== true,
  });
  console.log(
    `graph -> ${graphPath}${snapshotId === undefined ? "" : ` (snapshot #${snapshotId})`}`,
  );
  logSummary(graph);
  if (staticTreeRef === undefined) warnUnignoredArtifacts(root, values.out);
  if (values.report) {
    console.log(`report -> ${writeReport(graph, root, values.out)}`);
  }
};
