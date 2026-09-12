import { runAnalysisWorker } from "@t3tools/cartographer-core/analysis-worker";

// Each analysis owns a process because the scanner changes its working directory.
await runAnalysisWorker();
