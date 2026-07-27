import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "../../../packages/shared/src/toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it.each([
    {
      label: "structured file path",
      data: {
        kind: "read",
        locations: [{ path: "/tmp/app.ts" }],
      },
      expected: {
        summary: "Read file",
        detail: "/tmp/app.ts",
      },
    },
    {
      label: "no path",
      data: {
        kind: "read",
        rawInput: {},
      },
      expected: {
        summary: "Read file",
      },
    },
  ])("normalizes read-file tools when $label is available", ({ data, expected }) => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data,
        fallbackSummary: "Read File",
      }),
    ).toEqual(expected);
  });
});
