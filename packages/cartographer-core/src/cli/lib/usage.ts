// packages/cartographer-core/src/cli/lib/usage.ts
// cli help text

import { DEFAULT_MAX_DEPTH, DEFAULT_SCOPE, TSCONFIG_DISCOVERY_DESC } from '../../analyze/index.js'
import { DEFAULT_OUT_DIR } from '../../store/index.js'

export const USAGE = `cartographer — local-first repo graph & architecture reports

Usage:
  cartographer build [root] [--scope <dir>] [--tsconfig <file>] [--out <dir>] [--report] [--no-history]
  cartographer report [root] [--out <dir>]
  cartographer diff [root] [--scope <dir>] [--tsconfig <file>] [--out <dir>] [--base <snapshot-id>] [--save]
  cartographer check-pr [root] [--scope <dir>] [--tsconfig <file>] [--out <dir>] [--base <snapshot-id>]
  cartographer snapshots [root] [--out <dir>]
  cartographer patches [root] [--out <dir>]
  cartographer blast-radius [root] --target <file[#export]> [--direction both|upstream|downstream] [--max-depth <n>]
  cartographer annotate [root] [--scope <dir>] [--from-json <path|->]
  cartographer seed-rules [root] --from-eslint   (prints candidate rules[] for review; writes nothing)
  cartographer watch [root] [--scope <dir>] [--tsconfig <file>] [--out <dir>] [--report]
  cartographer analyze-trees <base-root> <proposed-root> --out <external-dir> --base-ref <oid> --proposed-ref <oid> --analyzer-version <sha256:fingerprint> --implementation-changed-file-count <count>

Defaults: root ".", --scope "${DEFAULT_SCOPE}", --out "${DEFAULT_OUT_DIR}", --direction both, --max-depth ${DEFAULT_MAX_DEPTH}
--tsconfig ${TSCONFIG_DISCOVERY_DESC}
--no-history writes graph and index artifacts without recording a graph.db snapshot
`
