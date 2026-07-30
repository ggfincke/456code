// tests/apps/web/components/chat/ThreadSyncStatusPill.test.tsx
// covers thread synchronization status rendering

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusPill } from "../../../../../apps/web/src/components/chat/ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it.each([
    ["loading", "Loading messages..."],
    ["syncing", "Syncing messages..."],
  ] as const)("renders the %s message sync phase", (phase, label) => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase={phase} />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain(label);
    expect(markup).not.toContain("animate-");
  });
});
