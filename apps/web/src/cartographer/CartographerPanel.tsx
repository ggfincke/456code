import type {
  CartographerView,
  CartographerDependencies,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { formatEnvironmentQueryError } from "../state/query";
import { useRightPanelStore } from "../rightPanelStore";
import {
  ArchitectureGraphCanvas,
  type ArchitectureGraphCanvasView,
} from "./ArchitectureGraphCanvas";
import { cartographer } from "./state";
import "./panel.css";

export default function CartographerPanel({
  threadRef,
  mode,
}: {
  threadRef: ScopedThreadRef;
  mode: "map" | "impact";
}) {
  const get = useAtomCommand(cartographer.get);
  const analyze = useAtomCommand(cartographer.analyze);
  const dependencies = useAtomCommand(cartographer.dependencies);
  const source = useAtomCommand(cartographer.source);
  const [view, setView] = useState<CartographerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<CartographerDependencies | null>(null);
  const [sourceView, setSourceView] = useState<{
    file: string;
    side: "base" | "target";
    content: string;
  } | null>(null);
  const [initialCamera, setInitialCamera] = useState<ArchitectureGraphCanvasView | undefined>(
    undefined,
  );
  const camera = useRef<ArchitectureGraphCanvasView | undefined>(undefined);
  const request = useRef(0);
  const detailRequest = useRef(0);
  const displayedId = useRef<string | undefined>(undefined);
  const { environmentId, threadId } = threadRef;
  const load = useCallback(
    async (refresh = false, search = "", prepare = false) => {
      const token = ++request.current;
      setBusy(true);
      setError(null);
      let result =
        refresh && mode === "map"
          ? await analyze({ environmentId, input: { threadId } })
          : await get({ environmentId, input: { threadId, mode, query: search } });
      if (token !== request.current) return;
      if (result._tag === "Success" && !result.value && mode === "map" && prepare) {
        result = await analyze({ environmentId, input: { threadId } });
      }
      if (token !== request.current) return;
      if (result._tag === "Success") {
        if (displayedId.current !== result.value?.id) {
          displayedId.current = result.value?.id;
          detailRequest.current++;
          setSelected(null);
          setEvidence(null);
          setSourceView(null);
        }
        setView(result.value);
      } else setError(formatEnvironmentQueryError(result.cause));
      setBusy(false);
    },
    [analyze, get, environmentId, threadId, mode],
  );

  useEffect(() => {
    void load(false, "", true);
    const checkFreshness = () => {
      void load();
    };
    window.addEventListener("focus", checkFreshness);
    return () => {
      request.current++;
      detailRequest.current++;
      window.removeEventListener("focus", checkFreshness);
    };
  }, [load]);

  const selectFile = async (file: string) => {
    if (!view) return;
    const token = ++detailRequest.current;
    setSelected(file);
    setSourceView(null);
    setEvidence(null);
    setError(null);
    if (view.nodes.find((node) => node.id === file)?.change === "removed") return;
    const result = await dependencies({
      environmentId,
      input: { threadId, id: view.id, file, depth: 3 },
    });
    if (token !== detailRequest.current) return;
    if (result._tag === "Success") setEvidence(result.value);
    else setError(formatEnvironmentQueryError(result.cause));
  };
  const openSource = async (side: "base" | "target") => {
    if (!view || !selected) return;
    const token = ++detailRequest.current;
    setInitialCamera(camera.current);
    const result = await source({
      environmentId,
      input: { threadId, id: view.id, file: selected, side },
    });
    if (token !== detailRequest.current) return;
    if (result._tag === "Success") setSourceView({ file: selected, side, content: result.value });
    else setError(formatEnvironmentQueryError(result.cause));
  };
  const nodes = useMemo(
    () =>
      (view?.nodes ?? []).map((node, i) => ({
        id: node.id,
        label: node.label,
        description: node.id,
        badgeLabel: node.change === "unchanged" ? node.group : node.change,
        footerLabels: [],
        position: { x: (i % 4) * 255, y: Math.floor(i / 4) * 112 },
        tintKey: node.group,
        tone:
          node.change === "changed"
            ? ("affected" as const)
            : node.change === "unchanged"
              ? ("identity" as const)
              : node.change,
        stroke: "solid" as const,
        ariaLabel: `Inspect ${node.id}`,
      })),
    [view],
  );
  const edges = useMemo(
    () =>
      (view?.edges ?? []).map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        weight: 1,
        label: edge.symbols.join(", ") || "imports",
        tone: edge.change === "unchanged" ? ("context" as const) : edge.change,
        stroke: edge.typeOnly ? ("dashed" as const) : ("solid" as const),
        showBadge: false,
        ariaLabel: `${edge.from} imports ${edge.symbols.join(", ") || "from"} ${edge.to}`,
      })),
    [view],
  );
  const back = () => {
    detailRequest.current++;
    setSourceView(null);
  };
  return (
    <section
      className="cartographer-panel flex h-full min-h-0 flex-col bg-background text-foreground"
      aria-label={mode === "map" ? "Repository Map" : "Diff Impact"}
    >
      <header className="flex flex-wrap items-center gap-2 border-b p-3 text-xs">
        <strong>{mode === "map" ? "Repository Map" : "Diff Impact"}</strong>
        <span role="status" className="text-muted-foreground">
          {busy
            ? "Analyzing…"
            : view
              ? view.stale
                ? "Stale · refresh available"
                : "Captured analysis"
              : "No completed analysis"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() => {
            if (mode === "impact") useRightPanelStore.getState().open(threadRef, "diff");
            else {
              setQuery("");
              void load(true);
            }
          }}
        >
          <RefreshCw className="size-3" />
          {mode === "map" ? "Refresh" : "Open diff to refresh"}
        </Button>
        {view && (
          <>
            <p className="w-full break-all text-muted-foreground">{view.root}</p>
            <p className="w-full font-mono text-[10px]">
              {view.base ? `${view.base.slice(0, 12)} → ` : ""}
              {view.identity.slice(0, 12)} · {new Date(view.createdAt).toLocaleTimeString()}
            </p>
          </>
        )}
      </header>
      {error && (
        <p role="alert" className="border-b p-3 text-xs text-destructive">
          {error}
          {view ? " Last completed analysis remains available." : ""}
        </p>
      )}
      {view ? (
        <>
          <p className="border-b px-3 py-2 text-xs">
            {view.summary}
            <span className="block text-muted-foreground">{view.coverage}</span>
          </p>
          {sourceView ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-2 border-b p-2">
                <Button size="sm" variant="ghost" onClick={back}>
                  <ArrowLeft className="size-3" />
                  Back to dependencies
                </Button>
                <span className="truncate text-xs">
                  {sourceView.file} · captured {sourceView.side}
                </span>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto p-3 text-xs">
                <code>{sourceView.content}</code>
              </pre>
            </div>
          ) : (
            <>
              <form
                className="flex gap-2 border-b p-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void load(false, query);
                }}
              >
                <input
                  aria-label="Search repository files"
                  placeholder="Search files…"
                  className="min-w-0 flex-1 rounded border bg-background px-2 text-xs"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={200}
                />
                <Button size="sm" variant="outline" type="submit" disabled={busy}>
                  Search
                </Button>
              </form>
              <div className="min-h-56 flex-1">
                <ArchitectureGraphCanvas
                  nodes={nodes}
                  edges={edges}
                  selectedNodeId={selected}
                  selectedEdgeId={null}
                  initialReadableView
                  initialView={initialCamera}
                  onViewChange={(value) => {
                    camera.current = value;
                  }}
                  edgeVisibility="selection"
                  highlightedNodeIds={evidence?.affected}
                  ariaLabel="Repository dependency graph"
                  emptyLabel="No matching JavaScript or TypeScript files."
                  onSelectNode={(node) => {
                    void selectFile(node.id);
                  }}
                  onSelectEdge={(edge) => {
                    void selectFile(edge.from);
                  }}
                />
              </div>
              {(view.omittedNodes > 0 || view.omittedEdges > 0) && (
                <p className="px-3 py-1 text-[10px] text-muted-foreground">
                  Showing {view.nodes.length} of {view.nodeCount} files and {view.edges.length} of{" "}
                  {view.edgeCount} imports. Search narrows the view; dependency queries use the full
                  analysis.
                </p>
              )}
              <div className="max-h-64 overflow-auto border-t p-3 text-xs">
                {selected ? (
                  <>
                    <strong className="break-all">{selected}</strong>
                    <div className="my-2 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void openSource("target");
                        }}
                      >
                        Captured source
                      </Button>
                      {view.base && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void openSource("base");
                          }}
                        >
                          Base source
                        </Button>
                      )}
                    </div>
                    {evidence ? (
                      <>
                        <p>
                          {evidence.incoming.length} direct dependents · {evidence.outgoing.length}{" "}
                          imports · {evidence.affected.length} potentially affected within 3 hops
                        </p>
                        {[...evidence.incoming, ...evidence.outgoing].map((edge) => (
                          <button
                            key={edge.id}
                            className="mt-2 block w-full rounded p-1 text-left hover:bg-accent"
                            onClick={() => {
                              void selectFile(edge.from === selected ? edge.to : edge.from);
                            }}
                          >
                            {edge.from} → {edge.to}
                            <span className="block text-muted-foreground">
                              {edge.typeOnly ? "Type import" : "Import"}:{" "}
                              {edge.symbols.join(", ") || "module dependency"}
                            </span>
                          </button>
                        ))}
                        {evidence.omitted > 0 && (
                          <p>{evidence.omitted} additional results omitted.</p>
                        )}
                      </>
                    ) : (
                      <p className="text-muted-foreground">
                        Select a captured target file to inspect dependency evidence.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="mb-2 text-muted-foreground">
                      Select a graph node or a file to inspect its dependencies.
                    </p>
                    {view.nodes.slice(0, 30).map((node) => (
                      <button
                        key={node.id}
                        className="block rounded p-1 text-left hover:bg-accent"
                        onClick={() => {
                          void selectFile(node.id);
                        }}
                      >
                        {node.id}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {busy
            ? "Capturing this task's worktree and building its import graph."
            : mode === "impact"
              ? "Open Diff and choose Analyze Impact for the comparison you want to inspect."
              : "Choose Refresh to retry analysis."}
        </p>
      )}
    </section>
  );
}
