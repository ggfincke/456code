// tests/apps/web/components/chat/ProposedPlanCard.test.tsx
// verifies exact proposal identity and explorer availability on plan cards
import type {
  EnvironmentId,
  OrchestrationProposedPlanId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  findProposalByPlan: vi.fn(),
  latestProposalGeneration: vi.fn(),
  getProposalGeneration: vi.fn(),
  query: vi.fn(),
}));

vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "environment-plan-card",
        {
          environment: {
            capabilities: {
              proposalPreview: true,
              cartographerEmbed: true,
            },
          },
        },
      ],
    ]),
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    findProposalByPlan: (input: unknown) => {
      mocks.findProposalByPlan(input);
      return { kind: "find-proposal-by-plan", input };
    },
    latestProposalGeneration: (input: unknown) => {
      mocks.latestProposalGeneration(input);
      return { kind: "latest-proposal-generation", input };
    },
    getProposalGeneration: (input: unknown) => {
      mocks.getProposalGeneration(input);
      return { kind: "get-proposal-generation", input };
    },
    startProposalGeneration: {},
    writeFile: {},
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: unknown) => mocks.query(query),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openExplorer: vi.fn() }),
  },
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: vi.fn(),
    isCopied: false,
  }),
}));

vi.mock("../../../../../apps/web/src/components/ChatMarkdown", () => ({
  default: ({ text }: { readonly text: string }) => <div data-chat-markdown>{text}</div>,
}));

import { ProposedPlanCard } from "../../../../../apps/web/src/components/chat/ProposedPlanCard";

const environmentId = "environment-plan-card" as EnvironmentId;
const planId = "plan-exact" as OrchestrationProposedPlanId;
const threadRef = {
  environmentId,
  threadId: "thread-plan-card",
} as ScopedThreadRef;

const planLookup = {
  proposal: {
    proposalId: "proposal-exact",
    sourceThreadId: threadRef.threadId,
  },
  revision: {
    revision: 4,
    planId,
    baseSnapshot: {
      workingTreeOid: "0123456789abcdef0123456789abcdef01234567",
    },
  },
};

describe("ProposedPlanCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation((query: { readonly kind?: string } | null) => ({
      data: query?.kind === "find-proposal-by-plan" ? planLookup : null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    }));
  });

  it("queries its exact plan linkage and labels the immutable revision and snapshot", () => {
    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan\n\nImplement the linked revision."
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    );

    expect(mocks.findProposalByPlan).toHaveBeenCalledWith({
      environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        planId,
      },
    });
    expect(markup).toContain(
      "Preview of proposal revision 4 against workspace snapshot 0123456789abcdef0123456789abcdef01234567.",
    );
    expect(markup).toContain("Open Explorer");
  });

  it("shows the exact analyzing identity while that revision generation is active", () => {
    const generation = {
      generationId: "generation-exact",
      state: "analyzing",
    };
    mocks.query.mockImplementation((query: { readonly kind?: string } | null) => ({
      data:
        query?.kind === "find-proposal-by-plan"
          ? planLookup
          : query?.kind === "latest-proposal-generation" ||
              query?.kind === "get-proposal-generation"
            ? generation
            : null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    }));

    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planId={planId}
        planMarkdown="# Exact plan"
        environmentId={environmentId}
        threadRef={threadRef}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    );

    expect(mocks.latestProposalGeneration).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        proposalId: "proposal-exact",
        revision: 4,
      },
    });
    expect(markup).toContain(
      "Analyzing revision 4 against workspace snapshot 0123456789abcdef0123456789abcdef01234567.",
    );
  });
});
