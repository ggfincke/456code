# Cartographer engine for the thin fork

This private package owns static JavaScript/TypeScript graph analysis and immutable, extension-owned captures. The application uses only `./snapshots` and `./analysis-worker`. Build it before running the server; T3 task prerequisites do this automatically.

The resolver, package export, nearest-config, coverage, and navigation accuracy work was selectively taken from the local Cartographer review. The former proposal engine and standalone agent tool/CLI entry points are removed. Existing analyzer support modules and major resolver tests remain private implementation details.

Analysis reads a captured tree, never the live repository after capture. Working-tree identities include actual source bytes; Git comparisons resolve both commit identities before analysis. Results and source are bound to their task, root and immutable capture ID. The app's read-only MCP tools never start analysis.

Limits: 8,000 source/config files, 2 MiB per file, 64 MiB per capture, two simultaneous analyses, a 90-second worker deadline, 250 visible graph nodes, 600 edges, and bounded dependency/source responses. Refresh failures retain the last completed resource. Cache generations remain available for immutable source navigation; the entire extension cache is rebuildable and can be removed while the app is stopped. It contains captured source and must be treated as project data.

Focused checks:

```sh
vp run --filter @t3tools/cartographer-core build
cd packages/cartographer-core
vp test run src/analyze/analyzerTruth.test.ts src/analyze/configRules.test.ts src/snapshots/store.test.ts
```
