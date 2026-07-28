// tests/apps/web/components/explorer/ExplorerPanel.test.tsx
// verifies proposal identity, comparison outcome, and isolated architecture presentation
import type { ScopedThreadRef } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" as const }),
}));

vi.mock("~/lib/utils", () => ({
  cn: (...values: ReadonlyArray<string | false | null | undefined>) =>
    values.filter(Boolean).join(" "),
}));

vi.mock("../../../../../apps/web/src/components/files/SafeDocumentRenderer", () => ({
  SafeDocumentRenderer: () => <div data-safe-document-renderer />,
}));

vi.mock("../../../../../apps/web/src/components/proposals/ProposalDiffPanel", () => ({
  ProposalDiffPanel: (props: {
    readonly proposal: { readonly revisionNumber: number; readonly exactDiff: string };
  }) => (
    <div
      data-proposal-diff-renderer
      data-revision={props.proposal.revisionNumber}
      data-diff={props.proposal.exactDiff}
    />
  ),
}));

import {
  ExplorerPanel,
  explorerArchitectureFileDestination,
} from "../../../../../apps/web/src/components/explorer/ExplorerPanel";

const threadRef = {
  environmentId: "environment-explorer-test",
  threadId: "thread-explorer-test",
} as ScopedThreadRef;

const proposal = {
  proposalId: "proposal-explorer-test",
  revisionNumber: 3,
  snapshotTreeOid: "0123456789abcdef0123456789abcdef01234567",
  exactDiff: "diff --git a/src/a.ts b/src/a.ts",
};

describe("ExplorerPanel", () => {
  it("routes proposal architecture events only to the retained diff", () => {
    expect(
      explorerArchitectureFileDestination({
        proposalSelected: true,
        action: "selection",
      }),
    ).toBe("proposal-diff");
    expect(
      explorerArchitectureFileDestination({
        proposalSelected: true,
        action: "open",
      }),
    ).toBe("proposal-diff");
    expect(
      explorerArchitectureFileDestination({
        proposalSelected: false,
        action: "selection",
      }),
    ).toBe("current-selection");
    expect(
      explorerArchitectureFileDestination({
        proposalSelected: false,
        action: "open",
      }),
    ).toBe("current-file");
  });

  it("keeps the authenticated architecture frame mounted while its tab is inactive", () => {
    const markup = renderToStaticMarkup(
      <ExplorerPanel
        threadRef={threadRef}
        narrative={{ kind: "empty", message: "No narrative supplied." }}
        proposal={proposal}
        architecture={{
          kind: "ready",
          url: "/api/cartographer/embed/session-1/?ticket=one-use",
          expectedOrigin: "https://environment.456code.test",
          generationId: "generation-1",
          authority: "authoritative",
          freshness: "fresh",
          freshnessScope: "verified-generation",
        }}
        defaultTab="narrative"
        onOpenFile={() => undefined}
      />,
    );
    const architecturePanel = markup.match(/<div id="explorer-panel-architecture"[^>]*>/u)?.[0];

    expect(architecturePanel).toContain('hidden=""');
    expect(architecturePanel).toContain('class="min-h-0 flex-1 flex-col hidden"');
    expect(markup).toContain('title="Cartographer architecture explorer"');
    expect(markup).toContain(
      'src="https://environment.456code.test/api/cartographer/embed/session-1/?ticket=one-use"',
    );
  });

  it("uses the shared proposal view and presents stale architecture without overstating it", () => {
    const codeMarkup = renderToStaticMarkup(
      <ExplorerPanel
        threadRef={threadRef}
        narrative={{ kind: "empty", message: "No narrative supplied." }}
        proposal={proposal}
        architecture={{ kind: "unavailable", reason: "Analysis has not started." }}
        attempt={{ outcome: "partial", matchedOperationCount: 1, intendedOperationCount: 2 }}
        defaultTab="code-changes"
        onOpenFile={() => undefined}
      />,
    );

    expect(codeMarkup).toContain(
      "Preview of proposal revision 3 against workspace snapshot 0123456789abcdef0123456789abcdef01234567",
    );
    expect(codeMarkup).toContain("data-proposal-diff-renderer");
    expect(codeMarkup).toContain('data-revision="3"');
    expect(codeMarkup).toContain('data-implementation-outcome="partial"');
    expect(codeMarkup).toContain("1 of 2 intended operations");

    const architectureMarkup = renderToStaticMarkup(
      <ExplorerPanel
        threadRef={threadRef}
        narrative={{ kind: "empty", message: "No narrative supplied." }}
        proposal={proposal}
        architecture={{
          kind: "ready",
          url: "/cartographer/session/session-1/",
          expectedOrigin: "https://456code.test",
          generationId: "generation-1",
          authority: "authoritative",
          freshness: "worktree-changed",
          freshnessScope: "verified-generation",
        }}
        defaultTab="architecture"
        onOpenFile={() => undefined}
      />,
    );

    expect(architectureMarkup).toContain('title="Cartographer architecture explorer"');
    expect(architectureMarkup).toContain('sandbox="allow-same-origin allow-scripts"');
    expect(architectureMarkup).toContain(
      'src="https://456code.test/cartographer/session/session-1/"',
    );
    expect(architectureMarkup).toContain(
      "Namespace, star, and dynamic imports without symbol evidence are conservatively treated as affecting unknown/all symbols.",
    );
    expect(architectureMarkup).toContain("Analysis freshness: worktree changed.");

    const currentSnapshotMarkup = renderToStaticMarkup(
      <ExplorerPanel
        threadRef={threadRef}
        narrative={{ kind: "empty", message: "No narrative supplied." }}
        proposal={null}
        architecture={{
          kind: "ready",
          url: "/cartographer/session/current/",
          expectedOrigin: "https://456code.test",
          generationId: null,
          authority: "authoritative",
          freshness: "fresh",
          freshnessScope: "capture-only",
        }}
        defaultTab="architecture"
        onOpenFile={() => undefined}
      />,
    );
    expect(currentSnapshotMarkup).toContain("Current worktree snapshot");
    expect(currentSnapshotMarkup).toContain(
      "This is an on-demand snapshot captured when Explorer opened. Worktree edits are not watched; close and reopen Explorer to refresh it.",
    );

    const retryMarkup = renderToStaticMarkup(
      <ExplorerPanel
        threadRef={threadRef}
        narrative={{ kind: "empty", message: "No narrative supplied." }}
        proposal={proposal}
        architecture={{
          kind: "error",
          message: "Exact architecture analysis failed.",
          retry: () => undefined,
        }}
        defaultTab="architecture"
        onOpenFile={() => undefined}
      />,
    );
    expect(retryMarkup).toContain("Retry analysis");
  });
});
