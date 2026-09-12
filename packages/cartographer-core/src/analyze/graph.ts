import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { cruise } from "dependency-cruiser";
import * as ts from "typescript";
import { GRAPH_SCHEMA_VERSION } from "../contracts/types.js";
import type {
  CartographerGraph,
  AnalysisCoverage,
  CommentMarker,
  GraphEdge,
  GraphGroup,
  GraphJourney,
  GraphJourneyStop,
  GraphMetrics,
  GraphNode,
  GraphRule,
  GraphRuntime,
  GraphSystem,
} from "../contracts/types.js";
import { ANALYSIS_COVERAGE_EXAMPLE_LIMIT } from "../contracts/analysisCoverage.js";
import { compileRuleEvaluator } from "./ruleEval.js";
import { loadAnnotations } from "./annotations.js";
import { verifyCitations } from "./citations.js";
import { fileDegrees } from "./degrees.js";
import { computeCoChanges } from "./cochange.js";
import {
  loadConfig,
  matchesRule,
  otherSystemId,
  resolveGroup,
  resolveSystem,
  type CartographerConfig,
} from "./config.js";
import { findHop, JOURNEY_HOP_MAX_DEPTH } from "./journeyHops.js";
import { buildDescriptionTable } from "./describe.js";
import { buildSymbolTable, exportList, type ImportInfo } from "./symbols.js";

// exclude whole path segments, never substrings -> src/distribution.ts,
// src/coverageReport.ts must survive while node_modules/dist/coverage dirs drop
const EXCLUDED_SEGMENTS = ["node_modules", "dist", "coverage"];

// config patterns are durable architecture claims; surface drift as additive
// warnings instead of letting a typo silently erase a group, system, or rule
function configStalenessMarkers(
  config: CartographerConfig,
  fileIds: readonly string[],
): CommentMarker[] {
  const markers: CommentMarker[] = [];
  const warn = (
    kind: "group" | "system" | "rule",
    identity: string,
    field: string,
    pattern: string,
  ): void => {
    if (!fileIds.some((fileId) => matchesRule(fileId, pattern))) {
      markers.push({
        kind: "warning",
        text: `${kind} "${identity}" ${field} pattern "${pattern}" matches no files`,
      });
    }
  };
  for (const group of config.groups) {
    warn("group", group.name, "match", group.match);
  }
  for (const system of config.systems) {
    warn("system", system.name, "match", system.match);
  }
  for (const rule of config.rules ?? []) {
    warn("rule", rule.id, "from", rule.from);
    warn("rule", rule.id, "to", rule.to);
    for (const pattern of rule.allowVia ?? []) {
      warn("rule", rule.id, "allowVia", pattern);
    }
  }
  return markers;
}

function systemSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function generateRankRules(config: CartographerConfig): GraphRule[] {
  const ranked = config.systems.filter(
    (system): system is typeof system & { rank: number } => system.rank !== undefined,
  );
  const severity = config.layering === "advisory" ? "info" : "error";
  const rules: GraphRule[] = [];
  // distinct names can slug identically -> suffix repeats to keep ids unique
  const usedIds = new Map<string, number>();
  const uniqueId = (id: string): string => {
    const seen = usedIds.get(id) ?? 0;
    usedIds.set(id, seen + 1);
    return seen === 0 ? id : `${id}-${seen + 1}`;
  };
  for (const deep of ranked) {
    for (const up of ranked) {
      if (deep.rank <= up.rank) {
        continue;
      }
      rules.push({
        id: uniqueId(`rank:${systemSlug(deep.name)}->${systemSlug(up.name)}`),
        from: deep.match,
        to: up.match,
        verdict: "forbid",
        severity,
        generated: true,
        fromSystem: deep.name,
        toSystem: up.name,
        why:
          `${up.name} (rank ${up.rank}) sits above ${deep.name} ` +
          `(rank ${deep.rank}) in the authored layering; dependencies must flow downward`,
      });
    }
  }
  return rules;
}

interface CruisedDependency {
  module: string;
  resolved: string;
  coreModule: boolean;
  couldNotResolve: boolean;
  dynamic: boolean;
  moduleSystem: "cjs" | "amd" | "es6" | "tsd";
}

interface CruisedModule {
  source: string;
  dependencies: CruisedDependency[];
}

interface CruisedResult {
  modules: CruisedModule[];
}

export interface BuildGraphOptions {
  root: string;
  scope?: string;
  tsconfig?: string;
  staticTree?: {
    gitRef: string;
  };
}

export const DEFAULT_SCOPE = "src";
const STATIC_TREE_GENERATED_AT = "1970-01-01T00:00:00.000Z";

// cruise() needs cwd pinned to the repo root; serialize the chdir window so
// concurrent buildGraph calls (MCP tools) can't race process-global cwd
let cwdLock: Promise<unknown> = Promise.resolve();

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = cwdLock.then(async () => {
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      return await fn();
    } finally {
      process.chdir(previousCwd);
    }
  });
  cwdLock = run.catch(() => undefined);
  return run;
}

interface SelectedTsConfig {
  path: string;
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
}

// discovery stays bounded and never traverses generated or hidden project trees
const DISCOVERY_SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const DISCOVERY_MAX_DEPTH = 6;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;

export const TSCONFIG_DISCOVERY_DESC =
  "tsconfig for path-alias resolution, relative to root. Default: discover " +
  "tsconfig*.json under root and use the nearest config for each importing file; " +
  "prefer paths-bearing configs, then tsconfig.app.json and tsconfig.json within one directory.";

function discoverProjects(root: string): { configs: string[]; packages: Map<string, string> } {
  const configs: string[] = [];
  const packages = new Map<string, string>();
  const walk = (dir: string, depth: number): void => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          depth < DISCOVERY_MAX_DEPTH &&
          !entry.name.startsWith(".") &&
          !DISCOVERY_SKIP_DIRS.has(entry.name)
        )
          walk(path, depth + 1);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("tsconfig") &&
        entry.name.endsWith(".json")
      ) {
        configs.push(path);
      } else if (entry.isFile() && entry.name === "package.json") {
        try {
          const manifest = JSON.parse(NodeFS.readFileSync(path, "utf8")) as { name?: unknown };
          if (typeof manifest.name === "string") packages.set(manifest.name, dir);
        } catch {
          // an unreadable manifest cannot establish local package identity
        }
      }
    }
  };
  walk(root, 0);
  return { configs, packages };
}

function isWithin(root: string, path: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

function prepareTsConfigs(
  root: string,
  paths: readonly string[],
  explicit?: string,
): SelectedTsConfig[] {
  const selected = explicit ? [NodePath.resolve(root, explicit)] : paths;
  const configs = selected.map((path): SelectedTsConfig => {
    const read = ts.readConfigFile(path, ts.sys.readFile);
    if (read.error && explicit)
      throw new Error(`tsconfig "${explicit}" could not be read under ${root}`);
    const parsed = ts.parseJsonConfigFileContent(
      read.config ?? {},
      ts.sys,
      NodePath.dirname(path),
      undefined,
      path,
    );
    const options = {
      allowJs: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      ...parsed.options,
    };
    return { path, options, cache: ts.createModuleResolutionCache(root, (name) => name, options) };
  });
  const priority = (config: SelectedTsConfig): number =>
    (Object.keys(config.options.paths ?? {}).length > 0 ? 4 : 0) +
    (NodePath.basename(config.path) === "tsconfig.app.json"
      ? 2
      : NodePath.basename(config.path) === "tsconfig.json"
        ? 1
        : 0);
  return configs.sort(
    (left, right) =>
      NodePath.dirname(right.path).length - NodePath.dirname(left.path).length ||
      priority(right) - priority(left) ||
      left.path.localeCompare(right.path),
  );
}

function aliasMatches(specifier: string, options: ts.CompilerOptions): boolean {
  return Object.entries(options.paths ?? {}).some(([pattern, targets]) => {
    if (targets.every((target) => /(^|\/)node_modules(\/|$)/.test(target))) return false;
    const star = pattern.indexOf("*");
    return star < 0
      ? pattern === specifier
      : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
  });
}

// cruiser supplies the import syntax; typescript resolves each importing package's
// own aliases and exports without borrowing another package's compiler config
async function cruiseRepository(
  root: string,
  scope: string,
  excludePattern: string,
  configs: readonly SelectedTsConfig[],
  packages: ReadonlyMap<string, string>,
  explicitConfig: boolean,
): Promise<CruisedModule[]> {
  const fallbackOptions: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const fallbackCache = ts.createModuleResolutionCache(root, (name) => name, fallbackOptions);
  const canonicalRoot = NodeFS.realpathSync(root);
  const modules = new Map<string, CruisedModule>();
  let inputs = [scope];
  const excluded = new RegExp(excludePattern);
  while (inputs.length > 0) {
    const result = await cruise(inputs, {
      validate: false,
      doNotFollow: { path: "node_modules" },
      exclude: { path: excludePattern },
      tsPreCompilationDeps: true,
      outputType: "json",
      enhancedResolveOptions: {
        exportsFields: ["exports"],
        conditionNames: ["import", "require", "node", "default", "types"],
      },
    });
    const raw = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    const cruised = JSON.parse(raw) as CruisedResult;
    const additions = new Set<string>();
    for (const module of cruised.modules) {
      const source = NodePath.resolve(root, module.source);
      if (
        modules.has(module.source) ||
        !isWithin(root, source) ||
        excluded.test(module.source) ||
        !NodeFS.existsSync(source) ||
        !NodeFS.statSync(source).isFile()
      )
        continue;
      const config = configs.find(
        (candidate) => explicitConfig || isWithin(NodePath.dirname(candidate.path), source),
      );
      for (const dependency of module.dependencies) {
        if (dependency.coreModule) continue;
        let resolved = ts.resolveModuleName(
          dependency.module,
          source,
          config?.options ?? fallbackOptions,
          ts.sys,
          config?.cache ?? fallbackCache,
          undefined,
          dependency.moduleSystem === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
        ).resolvedModule;
        if (!resolved) {
          const packageName = dependency.module.startsWith("@")
            ? dependency.module.split("/").slice(0, 2).join("/")
            : dependency.module.split("/")[0]!;
          const packageRoot = packages.get(packageName);
          if (packageRoot) {
            // package self-reference honors exports even in archives without installed workspace links
            resolved = ts.resolveModuleName(
              dependency.module,
              NodePath.join(packageRoot, "__cartographer__.ts"),
              config?.options ?? fallbackOptions,
              ts.sys,
              config?.cache ?? fallbackCache,
              undefined,
              dependency.moduleSystem === "cjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
            ).resolvedModule;
          }
        }
        const resolvedRoot =
          resolved && isWithin(root, resolved.resolvedFileName) ? root : canonicalRoot;
        if (resolved && isWithin(resolvedRoot, resolved.resolvedFileName)) {
          const relative = NodePath.relative(resolvedRoot, resolved.resolvedFileName)
            .split(NodePath.sep)
            .join("/");
          if (!excluded.test(relative)) {
            dependency.resolved = relative;
            dependency.couldNotResolve = false;
            if (!modules.has(relative) && SOURCE_EXTENSION.test(relative)) additions.add(relative);
          }
        }
      }
      modules.set(module.source, module);
    }
    inputs = [...additions].filter((source) => !modules.has(source)).sort();
  }
  return [...modules.values()];
}

function analysisCoverage(
  root: string,
  modules: readonly CruisedModule[],
  configs: readonly SelectedTsConfig[],
  packages: ReadonlyMap<string, string>,
  explicitConfig: boolean,
): AnalysisCoverage {
  const missing = new Map<string, { fileId: string; specifier: string }>();
  for (const module of modules) {
    const source = NodePath.resolve(root, module.source);
    const config = configs.find(
      (candidate) => explicitConfig || isWithin(NodePath.dirname(candidate.path), source),
    );
    for (const dependency of module.dependencies) {
      const specifier = dependency.module;
      const local =
        specifier.startsWith(".") ||
        specifier.startsWith("#") ||
        (config && aliasMatches(specifier, config.options)) ||
        [...packages.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`));
      if (dependency.couldNotResolve && !dependency.coreModule && local) {
        missing.set(`${module.source}\u0000${specifier}`, {
          fileId: module.source,
          specifier: specifier.slice(0, 1024),
        });
      }
    }
  }
  const sorted = [...missing.values()].sort(
    (a, b) => a.fileId.localeCompare(b.fileId) || a.specifier.localeCompare(b.specifier),
  );
  return {
    supportedLanguages: ["javascript", "typescript"],
    analyzedFiles: modules.filter((module) => SOURCE_EXTENSION.test(module.source)).length,
    unresolvedLocalImports: {
      total: sorted.length,
      examples: sorted.slice(0, ANALYSIS_COVERAGE_EXAMPLE_LIMIT),
      omitted: Math.max(0, sorted.length - ANALYSIS_COVERAGE_EXAMPLE_LIMIT),
    },
  };
}

export async function buildGraph(opts: BuildGraphOptions): Promise<CartographerGraph> {
  const root = NodePath.resolve(opts.root);
  const scope = opts.scope ?? DEFAULT_SCOPE;
  if (!NodeFS.existsSync(NodePath.resolve(root, scope))) {
    throw new Error(`scope "${scope}" not found under ${root} -> pass a different --scope`);
  }
  const projects = discoverProjects(root);
  const tsConfigs = prepareTsConfigs(root, projects.configs, opts.tsconfig);
  const config = loadConfig(root);
  const excludedSegments = [...EXCLUDED_SEGMENTS, ...(config.exclude ?? [])];
  const escapedSegments = excludedSegments.map((segment) =>
    segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const excludePattern = `(^|/)(?:${escapedSegments.join("|")})(?:/|$)`;
  const authoredRules = config.rules ?? [];
  // citations are verified before the generated rules merge & the sort so id
  // sets & ordering stay identical to the unverified build
  const authoredGraphRules: GraphRule[] = verifyCitations(
    root,
    authoredRules.map((rule) => ({
      ...rule,
      severity: "error",
    })),
  );
  const generatedRules = generateRankRules(config);
  const graphRules = [...authoredGraphRules, ...generatedRules].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const repoModules = await withCwd(root, () =>
    cruiseRepository(root, scope, excludePattern, tsConfigs, projects.packages, !!opts.tsconfig),
  );
  const moduleIds = repoModules.map((module) => module.source);
  const nodeIds = new Set(moduleIds);
  const markers = configStalenessMarkers(config, moduleIds);
  const coverage = analysisCoverage(
    root,
    repoModules,
    tsConfigs,
    projects.packages,
    !!opts.tsconfig,
  );

  const fallbackSystemId = otherSystemId(config);
  const symbolTable = buildSymbolTable(root, repoModules);
  const descriptions = buildDescriptionTable(root, moduleIds, loadAnnotations(root));
  const packageRoots = [...projects.packages.values()].sort((a, b) => b.length - a.length);
  const nodes: GraphNode[] = repoModules.map((m) => {
    const symbols = symbolTable.get(m.source);
    const described = descriptions.get(m.source);
    const system = resolveSystem(m.source, config);
    const packageRoot = packageRoots.find(
      (path) => path !== root && isWithin(path, NodePath.resolve(root, m.source)),
    );
    return {
      id: m.source,
      kind: "file" as const,
      label: m.source.split("/").pop() ?? m.source,
      group: resolveGroup(m.source, config).id,
      ...(packageRoot
        ? { packageRoot: NodePath.relative(root, packageRoot).split(NodePath.sep).join("/") }
        : {}),
      ...(system ? { system: system.id } : fallbackSystemId ? { system: fallbackSystemId } : {}),
      ...(symbols ? { exports: exportList(symbols) } : {}),
      ...(symbols?.fileMarkers.length ? { markers: symbols.fileMarkers } : {}),
      ...(described ? { description: described.description } : {}),
      ...(described ? { descriptionSource: described.source } : {}),
      ...(described?.stale ? { descriptionStale: true as const } : {}),
      ...(described?.headerPathStale ? { headerPathStale: true as const } : {}),
    };
  });

  const violationsOf = compileRuleEvaluator(
    graphRules,
    undefined,
    new Map(nodes.map((node) => [node.id, node.system])),
  );
  const edges: GraphEdge[] = [];
  for (const m of repoModules) {
    const moduleSymbols = symbolTable.get(m.source);
    const namespacesBySpecifier = new Map<string, NonNullable<GraphEdge["namespaceImports"]>>();
    for (const [name, binding] of moduleSymbols?.importedBindings ?? []) {
      if (binding.importedName !== undefined) continue;
      const namespaces = namespacesBySpecifier.get(binding.specifier) ?? [];
      namespaces.push({ name, typeOnly: binding.typeOnly });
      namespacesBySpecifier.set(binding.specifier, namespaces);
    }
    // cruise splits runtime & type-only declarations of one specifier into
    // separate deps -> fold all pulls into ONE edge per (from,to)
    const pullByTarget = new Map<string, EdgePull>();
    const targetOrder: string[] = [];
    for (const dep of m.dependencies) {
      if (dep.coreModule || dep.couldNotResolve) {
        continue;
      }
      if (!nodeIds.has(dep.resolved)) {
        continue;
      }
      // dynamic imports & namespace/star pulls stay symbol-less (unknown)
      const pulled = dep.dynamic
        ? undefined
        : (moduleSymbols?.importsBySpecifier.get(dep.module) ?? undefined);
      const namespaceImports = dep.dynamic ? [] : (namespacesBySpecifier.get(dep.module) ?? []);
      const violations = new Set(violationsOf(m.source, dep.resolved) ?? []);
      const acc = pullByTarget.get(dep.resolved);
      if (acc) {
        mergeEdgePull(acc, dep.dynamic, pulled, violations, namespaceImports);
      } else {
        pullByTarget.set(
          dep.resolved,
          initEdgePull(dep.dynamic, pulled, violations, namespaceImports),
        );
        targetOrder.push(dep.resolved);
      }
    }
    for (const target of targetOrder) {
      const pull = pullByTarget.get(target)!;
      // named import names are known when `names` is a concrete set
      const symbols = pull.names !== null ? [...pull.names].sort() : undefined;
      const namespaceImports = [...pull.namespaceImports]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, typeOnly]) => ({ name, typeOnly }));
      const typeSymbols = pull.typeOnly.size > 0 ? [...pull.typeOnly].sort() : undefined;
      const violations = pull.violations.size > 0 ? [...pull.violations].sort() : undefined;
      edges.push({
        id: `e${edges.length}`,
        from: m.source,
        to: target,
        kind: "imports",
        ...(pull.dynamic ? { dynamic: true } : {}),
        ...(symbols ? { symbols } : {}),
        ...(namespaceImports.length > 0 ? { namespaceImports } : {}),
        ...(pull.wholeTypeOnly ? { typeOnly: true } : {}),
        ...(typeSymbols ? { typeSymbols } : {}),
        ...(violations ? { violations } : {}),
      });
    }
  }

  const coChanges = opts.staticTree ? [] : computeCoChanges(root, moduleIds, scope);
  const systems = collectSystems(nodes, config, fallbackSystemId);
  const journeys = resolveJourneys(config, nodes, edges);
  const runtimes = resolveRuntimes(config, nodes);
  const metrics = computeMetrics(nodes, edges);
  // a high orphan share usually means path aliases didn't resolve
  // -> the graph silently under-reports edges
  if (nodes.length >= 40 && metrics.orphans / nodes.length > 0.25) {
    console.error(
      `note: ${metrics.orphans}/${nodes.length} files have no resolved imports -> ` +
        `check analysis coverage for unresolved local imports before drawing conclusions`,
    );
  }
  const graph: CartographerGraph = {
    version: GRAPH_SCHEMA_VERSION,
    repoRoot: opts.staticTree ? "." : root,
    mode: "imports",
    generatedAt: opts.staticTree ? STATIC_TREE_GENERATED_AT : new Date().toISOString(),
    ...(opts.staticTree ? { gitRef: opts.staticTree.gitRef } : gitRef(root)),
    scope,
    nodes,
    edges,
    groups: collectGroups(nodes, config),
    ...(markers.length > 0 ? { markers } : {}),
    ...(systems.length > 0 ? { systems } : {}),
    ...(graphRules.length > 0 ? { rules: graphRules } : {}),
    ...(journeys.length > 0 ? { journeys } : {}),
    ...(runtimes.length > 0 ? { runtimes } : {}),
    ...(coChanges.length > 0 ? { coChanges } : {}),
    metrics,
    coverage,
  };
  return opts.staticTree ? orderStaticTreeGraph(graph) : graph;
}

// static artifacts must not depend on cruise traversal, temp paths, or time
function orderStaticTreeGraph(graph: CartographerGraph): CartographerGraph {
  const nodes = [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id));
  const edges = [...graph.edges]
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
    .map((edge, index) => ({ ...edge, id: `e${index}` }));
  return { ...graph, nodes, edges };
}

// merged pull evidence for one (from,to) pair across all its declarations
interface EdgePull {
  dynamic: boolean;
  // union of pulled names; null -> unknown (namespace/dynamic/no symbol data)
  names: Set<string> | null;
  namespaceImports: Map<string, boolean>;
  typeOnly: Set<string>;
  wholeTypeOnly: boolean;
  violations: Set<string>;
}

function initEdgePull(
  dynamic: boolean,
  pulled: ImportInfo | undefined,
  violations: ReadonlySet<string>,
  namespaceImports: NonNullable<GraphEdge["namespaceImports"]>,
): EdgePull {
  const names = !pulled || pulled.names === null ? null : new Set(pulled.names);
  return {
    dynamic,
    names,
    namespaceImports: new Map(namespaceImports.map(({ name, typeOnly }) => [name, typeOnly])),
    typeOnly: names === null ? new Set() : new Set(pulled?.typeOnly ?? []),
    wholeTypeOnly: pulled?.wholeTypeOnly ?? false,
    violations: new Set(violations),
  };
}

// fold one dep's pull into the pair accumulator; runtime evidence wins
function mergeEdgePull(
  acc: EdgePull,
  dynamic: boolean,
  pulled: ImportInfo | undefined,
  violations: ReadonlySet<string>,
  namespaceImports: NonNullable<GraphEdge["namespaceImports"]>,
): void {
  acc.dynamic = acc.dynamic && dynamic;
  for (const { name, typeOnly } of namespaceImports) {
    acc.namespaceImports.set(name, (acc.namespaceImports.get(name) ?? true) && typeOnly);
  }
  for (const violation of violations) {
    acc.violations.add(violation);
  }
  if (!pulled) {
    // unknown pull (dynamic/no symbol data) -> names unknowable, not type-only
    acc.names = null;
    acc.typeOnly.clear();
    acc.wholeTypeOnly = false;
    return;
  }
  // names already pulled at runtime keep runtime status
  const runtimeBefore = new Set<string>();
  for (const name of acc.names ?? []) {
    if (!acc.typeOnly.has(name)) {
      runtimeBefore.add(name);
    }
  }
  if (pulled.names === null) {
    acc.names = null;
  } else if (acc.names !== null) {
    for (const name of pulled.names) {
      acc.names.add(name);
    }
  }
  for (const name of pulled.typeOnly) {
    if (!runtimeBefore.has(name)) {
      acc.typeOnly.add(name);
    }
  }
  if (pulled.names !== null) {
    // a runtime pull of a name clears its type-only mark
    for (const name of pulled.names) {
      if (!pulled.typeOnly.has(name)) {
        acc.typeOnly.delete(name);
      }
    }
  }
  if (acc.names === null) {
    acc.typeOnly.clear();
  }
  acc.wholeTypeOnly = acc.wholeTypeOnly && pulled.wholeTypeOnly;
}

// a broad stop glob can name half the repo -> keep the recorded witness set
// bounded & deterministic (sorted file ids, first N); serialization only, the
// hop search & staleness still see every match
const MAX_JOURNEY_RESOLVED = 100;

// authored lifecycle narratives re-verified against this build: every stop's
// `at` resolves through the one hardened matcher, & every hop between
// consecutive resolved stops is a real static-import path or nothing
function resolveJourneys(
  config: CartographerConfig,
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphJourney[] {
  const authored = config.journeys ?? [];
  if (authored.length === 0) {
    return [];
  }
  const fileIds = nodes.map((node) => node.id).sort();
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const outgoing = adjacency.get(edge.from);
    if (outgoing) {
      outgoing.push(edge.to);
    } else {
      adjacency.set(edge.from, [edge.to]);
    }
  }

  return authored.map((journey) => {
    const stops: GraphJourneyStop[] = [];
    // every file the previous stop matched; undefined -> stale, so no hop
    let previous: string[] | undefined;
    for (const stop of journey.stops) {
      // an absent hopDistance is published as "no static path" -> search the
      // full match set, never the display-capped slice, or the witness cap
      // would manufacture that claim
      const matched = fileIds.filter((id) => matchesRule(id, stop.at));
      const hopSearch =
        previous && matched.length > 0
          ? findHop(adjacency, previous, new Set(matched), JOURNEY_HOP_MAX_DEPTH)
          : undefined;
      const hop = hopSearch?.hop;
      stops.push({
        at: stop.at,
        title: stop.title,
        timing: stop.timing,
        ...(stop.why ? { why: stop.why } : {}),
        ...(matched.length > 0
          ? {
              resolved: matched.slice(0, MAX_JOURNEY_RESOLVED),
              resolvedTotal: matched.length,
            }
          : { stale: true as const }),
        ...(hop ? { hopDistance: hop.distance, hopVia: hop.via } : {}),
        ...(hopSearch?.depthExceeded ? { hopDepthExceeded: true as const } : {}),
      });
      previous = matched.length > 0 ? matched : undefined;
    }
    return {
      id: journey.id,
      title: journey.title,
      ...(journey.why ? { why: journey.why } : {}),
      stops,
    };
  });
}

// a root glob can name a whole directory -> keep the witness set bounded &
// deterministic, exactly like the journey stop resolution above
const MAX_RUNTIME_RESOLVED = 100;

// authored process entry points re-verified against this build: every root
// resolves through the one hardened matcher, & a runtime whose roots match
// nothing announces its own rot rather than silently reaching zero files
function resolveRuntimes(config: CartographerConfig, nodes: GraphNode[]): GraphRuntime[] {
  const authored = config.runtimes ?? [];
  if (authored.length === 0) {
    return [];
  }
  const fileIds = nodes.map((node) => node.id).sort();
  return authored.map((runtime) => {
    const matched = fileIds.filter((id) => runtime.roots.some((root) => matchesRule(id, root)));
    const resolved = matched.slice(0, MAX_RUNTIME_RESOLVED);
    return {
      key: runtime.key,
      label: runtime.label,
      roots: runtime.roots,
      ...(resolved.length > 0
        ? { resolved, resolvedTotal: matched.length }
        : { stale: true as const }),
    };
  });
}

// authored systems in rule order; duplicate names collapse to one summary
function collectSystems(
  nodes: GraphNode[],
  config: CartographerConfig,
  fallbackSystemId: string | undefined,
): GraphSystem[] {
  const fileCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.system !== undefined) {
      fileCounts.set(node.system, (fileCounts.get(node.system) ?? 0) + 1);
    }
  }

  const systems: GraphSystem[] = [];
  const seen = new Set<string>();
  for (const rule of config.systems) {
    const fileCount = fileCounts.get(rule.name);
    if (!fileCount || seen.has(rule.name)) {
      continue;
    }
    seen.add(rule.name);
    systems.push({
      id: rule.name,
      label: rule.name,
      ...(rule.description ? { description: rule.description } : {}),
      fileCount,
      source: "authored",
      ...(rule.rank !== undefined ? { rank: rule.rank } : {}),
    });
  }
  const fallbackCount = fallbackSystemId ? (fileCounts.get(fallbackSystemId) ?? 0) : 0;
  if (fallbackSystemId && fallbackCount > 0) {
    systems.push({
      id: fallbackSystemId,
      label: otherSystemLabel(config),
      description: "Files outside the authored system rules.",
      fileCount: fallbackCount,
      source: "fallback",
    });
  }
  return systems;
}

function otherSystemLabel(config: CartographerConfig): string {
  const used = new Set(config.systems.map((rule) => rule.name));
  if (!used.has("Other")) {
    return "Other";
  }
  let label = "Unmatched";
  let suffix = 2;
  while (used.has(label)) {
    label = `Unmatched ${suffix}`;
    suffix += 1;
  }
  return label;
}

// config-defined groups in rule order, heuristic groups alphabetical after
function collectGroups(nodes: GraphNode[], config: CartographerConfig): GraphGroup[] {
  const fileCounts = new Map<string, number>();
  for (const node of nodes) {
    fileCounts.set(node.group, (fileCounts.get(node.group) ?? 0) + 1);
  }

  const groups: GraphGroup[] = [];
  const seen = new Set<string>();
  for (const rule of config.groups) {
    const fileCount = fileCounts.get(rule.name);
    if (!fileCount || seen.has(rule.name)) {
      continue;
    }
    seen.add(rule.name);
    groups.push({
      id: rule.name,
      label: rule.name,
      ...(rule.description ? { description: rule.description } : {}),
      fileCount,
    });
  }
  const heuristic = [...fileCounts.keys()]
    .filter((id) => !seen.has(id))
    .sort((a, b) => a.localeCompare(b));
  for (const id of heuristic) {
    groups.push({ id, label: id, fileCount: fileCounts.get(id) ?? 0 });
  }
  return groups;
}

function gitRef(root: string): { gitRef?: string } {
  try {
    const ref = NodeChildProcess.execSync("git rev-parse --short HEAD", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return ref ? { gitRef: ref } : {};
  } catch {
    return {};
  }
}

function computeMetrics(nodes: GraphNode[], edges: GraphEdge[]): GraphMetrics {
  const { fanIn, fanOut } = fileDegrees(
    edges,
    nodes.map((node) => node.id),
  );
  let maxFanIn = 0;
  let maxFanOut = 0;
  for (const count of fanIn.values()) {
    maxFanIn = Math.max(maxFanIn, count);
  }
  for (const count of fanOut.values()) {
    maxFanOut = Math.max(maxFanOut, count);
  }

  let orphans = 0;
  for (const node of nodes) {
    if ((fanIn.get(node.id) ?? 0) === 0 && (fanOut.get(node.id) ?? 0) === 0) {
      orphans += 1;
    }
  }

  return {
    cycles: countCycles(nodes, edges),
    orphans,
    maxFanIn,
    maxFanOut,
  };
}

// kosaraju SCC count -> components w/ more than one node, plus self-loops
function countCycles(nodes: GraphNode[], edges: GraphEdge[]): number {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const node of nodes) {
    forward.set(node.id, []);
    reverse.set(node.id, []);
  }
  let selfLoops = 0;
  for (const edge of edges) {
    if (edge.from === edge.to) {
      selfLoops += 1;
      continue;
    }
    forward.get(edge.from)?.push(edge.to);
    reverse.get(edge.to)?.push(edge.from);
  }

  const visited = new Set<string>();
  const order: string[] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }
    // iterative post-order DFS
    const stack: Array<{ id: string; index: number }> = [{ id: node.id, index: 0 }];
    visited.add(node.id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbors = forward.get(frame.id) ?? [];
      if (frame.index < neighbors.length) {
        const next = neighbors[frame.index]!;
        frame.index += 1;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ id: next, index: 0 });
        }
      } else {
        order.push(frame.id);
        stack.pop();
      }
    }
  }

  const assigned = new Set<string>();
  let cyclicComponents = 0;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const rootId = order[i]!;
    if (assigned.has(rootId)) {
      continue;
    }
    let size = 0;
    const stack = [rootId];
    assigned.add(rootId);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      size += 1;
      for (const prev of reverse.get(id) ?? []) {
        if (!assigned.has(prev)) {
          assigned.add(prev);
          stack.push(prev);
        }
      }
    }
    if (size > 1) {
      cyclicComponents += 1;
    }
  }

  return cyclicComponents + selfLoops;
}
