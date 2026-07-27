import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  frame: (value: unknown) => value,
  layoutPriority: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  padding: (value: unknown) => value,
  resizable: (value: unknown) => value,
  widgetURL: (value: unknown) => ({ widgetURL: value }),
}));

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import {
  AgentActivity,
  type AgentActivityProps,
  type AgentActivityRowProps,
} from "../../../../apps/mobile/src/widgets/AgentActivity";

function makeRow(overrides: Partial<AgentActivityRowProps>): AgentActivityRowProps {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "Project",
    threadTitle: "Thread",
    modelTitle: "gpt-5.4",
    phase: "running",
    status: "Working",
    updatedAt: "2026-05-25T13:07:00.000Z",
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  };
}

const props = {
  title: "456code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T13:07:00.000Z",
  activities: [],
} satisfies AgentActivityProps;

const environment = {
  colorScheme: "dark",
  isLuminanceReduced: false,
} as const;

const lightEnvironment = {
  colorScheme: "light",
  isLuminanceReduced: false,
} as const;

describe("AgentActivity widget layout", () => {
  it.each([
    {
      scheme: "dark",
      environment: environment,
      runningTint: "#7dd3fc",
      approvalTint: "#fcd34d",
      forbiddenTints: [] as string[],
    },
    {
      scheme: "light",
      environment: lightEnvironment,
      runningTint: "#0284c7",
      approvalTint: "#d97706",
      forbiddenTints: ["#7dd3fc", "#fcd34d"],
    },
  ])(
    "tints each row by phase using the web sidebar's $scheme palette",
    ({ environment: env, runningTint, approvalTint, forbiddenTints }) => {
      const layout = AgentActivity(
        {
          ...props,
          activeCount: 2,
          activities: [
            makeRow({}),
            makeRow({ threadId: "thread-2", phase: "waiting_for_approval", status: "Approval" }),
          ],
        },
        env as never,
      );
      const banner = JSON.stringify(layout.banner);
      expect(banner).toContain(runningTint);
      expect(banner).toContain(approvalTint);
      for (const forbidden of forbiddenTints) {
        expect(banner).not.toContain(forbidden);
      }
    },
  );

  it("orders rows attention-first in the banner", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({ threadTitle: "Working thread" }),
          makeRow({
            threadId: "thread-2",
            threadTitle: "Blocked thread",
            phase: "waiting_for_approval",
            status: "Approval",
          }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner.indexOf("Blocked thread")).toBeGreaterThan(-1);
    expect(banner.indexOf("Blocked thread")).toBeLessThan(banner.indexOf("Working thread"));
  });

  it("summarizes the attention count in the banner header", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 3,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("3 active agents");
    expect(banner).toContain("1 needs attention");
  });

  it("uses the attention tint for the compact presentations when a row needs input", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({ threadId: "thread-2", phase: "waiting_for_input", status: "Input" }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.compactLeading)).toContain("#a5b4fc"); // indigo-300
    expect(JSON.stringify(layout.compactTrailing)).toContain("Input");
    expect(JSON.stringify(layout.minimal)).toContain("#a5b4fc");
  });

  it("deep links the banner to the row that needs attention", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 2,
        activities: [
          makeRow({}),
          makeRow({
            threadId: "thread-2",
            phase: "waiting_for_approval",
            status: "Approval",
            deepLink: "/threads/env-1/thread-2",
          }),
        ],
      },
      environment as never,
    );
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"code456://threads/env-1/thread-2"',
    );
  });

  it("deep links the banner to the first row when nothing needs attention", () => {
    const layout = AgentActivity({ ...props, activities: [makeRow({})] }, environment as never);
    expect(JSON.stringify(layout.banner)).toContain(
      '"widgetURL":"code456://threads/env-1/thread-1"',
    );
  });

  it("omits the deep link for unsafe paths and empty aggregates", () => {
    expect(JSON.stringify(AgentActivity(props, environment as never))).not.toContain("widgetURL");
    expect(
      JSON.stringify(
        AgentActivity(
          { ...props, activities: [makeRow({ deepLink: "//evil.example" })] },
          environment as never,
        ),
      ),
    ).not.toContain("widgetURL");
  });

  it("leads with the outcome instead of a zero count when nothing is active", () => {
    const layout = AgentActivity(
      {
        ...props,
        subtitle: "Agent work completed",
        activeCount: 0,
        activities: [makeRow({ phase: "completed", status: "Done" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work completed");
    expect(banner).not.toContain("0 active");
    expect(banner).toContain("#6ee7b7"); // emerald-300 header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Done");
    expect(JSON.stringify(layout.compactTrailing)).not.toContain("0 active");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Done");
    expect(JSON.stringify(layout.minimal)).toContain("checkmark.circle.fill");
    expect(JSON.stringify(layout.bannerSmall)).toContain("Done");
  });

  it("reads Failed when the finished work ended in failure", () => {
    const layout = AgentActivity(
      {
        ...props,
        subtitle: "Agent work failed",
        activeCount: 0,
        activities: [makeRow({ phase: "failed", status: "Failed" })],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work failed");
    expect(banner).toContain("#fca5a5"); // red-300 header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Failed");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Failed");
    expect(JSON.stringify(layout.minimal)).toContain("xmark.octagon.fill");
  });

  it("lets a failure dominate mixed finished outcomes across every presentation", () => {
    const layout = AgentActivity(
      {
        ...props,
        // The server subtitle keys off the newest terminal row (completed
        // here); the layout must still read Failed everywhere so the header
        // text never disagrees with the tint, count slots, or minimal glyph.
        subtitle: "Agent work completed",
        activeCount: 0,
        activities: [
          makeRow({ phase: "completed", status: "Done" }),
          makeRow({ threadId: "thread-2", phase: "failed", status: "Failed" }),
        ],
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    expect(banner).toContain("Agent work failed");
    expect(banner).not.toContain("Agent work completed");
    expect(banner).toContain("#fca5a5"); // red-300 header tint
    expect(JSON.stringify(layout.compactTrailing)).toContain("Failed");
    expect(JSON.stringify(layout.expandedLeading)).toContain("Failed");
    expect(JSON.stringify(layout.minimal)).toContain("xmark.octagon.fill");
  });

  it("renders up to five rows in the banner", () => {
    const layout = AgentActivity(
      {
        ...props,
        activeCount: 6,
        activities: [1, 2, 3, 4, 5, 6].map((n) =>
          makeRow({ threadId: `t${n}`, threadTitle: `Thread ${n}` }),
        ),
      },
      environment as never,
    );
    const banner = JSON.stringify(layout.banner);
    for (const visible of [1, 2, 3, 4, 5]) {
      expect(banner).toContain(`Thread ${visible}`);
    }
    expect(banner).not.toContain("Thread 6");
  });
});
