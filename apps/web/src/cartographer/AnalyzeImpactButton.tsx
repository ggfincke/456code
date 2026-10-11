// apps/web/src/cartographer/AnalyzeImpactButton.tsx
// starts permitted impact analysis and opens its review surface
import { useAtomValue } from "@effect/atom-react";
import type { CartographerComparison, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { useRightPanelStore } from "../rightPanelStore";
import { useAtomCommand } from "../state/use-atom-command";
import { formatEnvironmentQueryError } from "../state/query";
import { cartographer } from "./state";

export function AnalyzeImpactButton({
  threadRef,
  comparison,
}: {
  threadRef: ScopedThreadRef;
  comparison: CartographerComparison;
}) {
  const analyze = useAtomCommand(cartographer.analyze);
  const canAnalyze = useAtomValue(cartographer.analyze.permissionAtom(threadRef.environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !canAnalyze}
        onClick={async () => {
          if (!canAnalyze) return;
          setBusy(true);
          setError(null);
          const result = await analyze({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, comparison },
          });
          setBusy(false);
          if (result._tag === "Success")
            useRightPanelStore.getState().open(threadRef, "cartographer-impact");
          else setError(formatEnvironmentQueryError(result.cause));
        }}
      >
        {busy ? "Analyzing impact…" : "Analyze Impact"}
      </Button>
      {error && (
        <span role="alert" className="max-w-72 text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
