// tests/apps/web/components/explorer/ConnectedExplorerPanel.test.ts
// verifies exact cartographer embed ownership across target transitions
import { describe, expect, it } from "vite-plus/test";

import {
  isCurrentEmbedRequest,
  isProposalDiscoverySettled,
  resolveEmbedTargetTransition,
} from "../../../../../apps/web/src/components/explorer/ConnectedExplorerPanel";

describe("ConnectedExplorerPanel embed lifecycle", () => {
  it("keeps a negative proposal lookup settled across polling refreshes", () => {
    expect(
      isProposalDiscoverySettled({
        settledKey: "environment:thread:plan-1",
        key: "environment:thread:plan-1",
        settledNow: false,
      }),
    ).toBe(true);
    expect(
      isProposalDiscoverySettled({
        settledKey: "environment:thread:plan-1",
        key: "environment:thread:plan-2",
        settledNow: false,
      }),
    ).toBe(false);
    expect(
      isProposalDiscoverySettled({
        settledKey: null,
        key: "environment:thread:plan-1",
        settledNow: true,
      }),
    ).toBe(true);
  });

  it("invalidates one-time requests and releases only the previous exact target", () => {
    expect(
      resolveEmbedTargetTransition({
        previousTargetKey: "proposal:generation-1",
        nextTargetKey: null,
        issuedSessionKey: "proposal:generation-1",
      }),
    ).toEqual({
      invalidateRequest: true,
      releaseIssuedSession: true,
    });

    expect(
      resolveEmbedTargetTransition({
        previousTargetKey: null,
        nextTargetKey: "proposal:generation-1",
        issuedSessionKey: null,
      }),
    ).toEqual({
      invalidateRequest: true,
      releaseIssuedSession: false,
    });

    expect(
      resolveEmbedTargetTransition({
        previousTargetKey: "proposal:generation-1",
        nextTargetKey: "proposal:generation-1",
        issuedSessionKey: "proposal:generation-1",
      }),
    ).toEqual({
      invalidateRequest: false,
      releaseIssuedSession: false,
    });

    expect(
      resolveEmbedTargetTransition({
        previousTargetKey: "proposal:generation-1",
        nextTargetKey: "proposal:generation-2",
        issuedSessionKey: "proposal:generation-1",
      }),
    ).toEqual({
      invalidateRequest: true,
      releaseIssuedSession: true,
    });
  });

  it("does not accept an obsolete one-time result after the same target returns", () => {
    const obsolete = {
      key: "proposal:generation-1",
      requestId: 1,
    };
    const replacement = {
      key: "proposal:generation-1",
      requestId: 2,
    };

    expect(isCurrentEmbedRequest(replacement, obsolete)).toBe(false);
    expect(isCurrentEmbedRequest(replacement, replacement)).toBe(true);
    expect(isCurrentEmbedRequest(null, replacement)).toBe(false);
  });
});
