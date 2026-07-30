// tests/apps/server/import/claudeSessionParser.test.ts
// verifies pure claude code transcript parsing
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

import { parseClaudeSession } from "../../../../apps/server/src/import/claudeSessionParser.ts";

function fixture(name: string): string {
  return NodeFS.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function jsonl(records: ReadonlyArray<Record<string, unknown>>): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

describe("parseClaudeSession", () => {
  it("extracts ordered messages and inert activities while pairing tool results", () => {
    const session = parseClaudeSession({
      content: fixture("claude-session-basic.jsonl"),
      sourcePath: "/home/test/.claude/projects/repo/session.jsonl",
      contentHash: "claude-hash",
    });

    expect(
      session.records.map((record) =>
        record.kind === "message"
          ? `${record.role}:${record.text}`
          : `${record.activityKind}:${record.summary}`,
      ),
    ).toEqual([
      "user:Build the importer",
      "task.progress:Checking the source",
      "tool.completed:Bash: vp test run",
      "assistant:The importer is ready.",
      "task.completed:Omitted 4 attachments from imported transcript",
    ]);
    expect(session.records.map((record) => record.sourceIndex)).toEqual([0, 1, 1, 1, 7]);

    const tool = session.records.find(
      (record) => record.kind === "activity" && record.summary.startsWith("Bash"),
    );
    expect(tool).toMatchObject({
      kind: "activity",
      payload: {
        itemType: "command_execution",
        title: "Bash",
        status: "completed",
        detail: "tests passed",
        data: {
          toolCallId: "tool-1",
          kind: "execute",
          command: "vp test run",
          rawInput: { command: "vp test run" },
          rawOutput: { content: "tests passed" },
          item: {
            command: "vp test run",
            input: { command: "vp test run" },
            result: { content: "tests passed" },
          },
        },
      },
    });
    expect(session.records[1]).toMatchObject({
      kind: "activity",
      payload: {
        summary: "Checking the source",
        detail: "Checking the source\nand its records.",
      },
    });

    const sameLineRecords = session.records.filter((record) => record.sourceIndex === 1);
    expect(
      sameLineRecords.map((record) =>
        record.kind === "message" ? record.text : record.activityKind,
      ),
    ).toEqual(["task.progress", "tool.completed", "The importer is ready."]);
    expect(sameLineRecords.map((record) => record.createdAt)).toEqual([
      "2026-02-03T04:05:07.000Z",
      "2026-02-03T04:05:07.001Z",
      "2026-02-03T04:05:07.002Z",
    ]);

    expect(session.meta).toEqual({
      source: "claude-code",
      sourcePath: "/home/test/.claude/projects/repo/session.jsonl",
      contentHash: "claude-hash",
      nativeSessionId: "123e4567-e89b-12d3-a456-426614174000",
      cwd: "/workspace/latest",
      gitBranch: "feature/claude-import",
      model: "claude-sonnet-4-5",
      title: "Importer work",
      firstActivityAt: "2026-02-03T04:05:06.000Z",
      lastActivityAt: "2026-02-03T04:05:09.000Z",
    });
  });

  it("keeps text blocks on both sides of reasoning in semantic order", () => {
    const session = parseClaudeSession({
      content: JSON.stringify({
        type: "assistant",
        sessionId: "ordered-session",
        cwd: "/workspace/ordered",
        timestamp: "2026-02-03T04:05:07Z",
        message: {
          model: "claude-sonnet-4-5",
          content: [
            { type: "text", text: "Before reasoning." },
            { type: "thinking", thinking: "Checking one thing." },
            { type: "text", text: "After reasoning." },
          ],
        },
      }),
      sourcePath: "/ordered.jsonl",
      contentHash: "ordered-hash",
    });

    expect(
      session.records.map((record) =>
        record.kind === "message" ? record.text : record.activityKind,
      ),
    ).toEqual(["Before reasoning.", "task.progress", "After reasoning."]);
    expect(session.records.map((record) => record.createdAt)).toEqual([
      "2026-02-03T04:05:07.000Z",
      "2026-02-03T04:05:07.001Z",
      "2026-02-03T04:05:07.002Z",
    ]);
  });

  it("reports omitted attachments without retaining their paths or payloads", () => {
    const session = parseClaudeSession({
      content: fixture("claude-session-basic.jsonl"),
      sourcePath: "/session.jsonl",
      contentHash: "claude-hash",
    });
    const serialized = JSON.stringify(session.records);

    expect(serialized).not.toContain("ignored attachment");
    expect(serialized).not.toContain("private-claude-image");
    expect(serialized).not.toContain("/private/claude-notes.txt");
    expect(serialized).not.toContain("private claude notes");
    expect(serialized).not.toContain("private-tool-result-image");
    expect(serialized).not.toContain("ignored queue item");
    expect(serialized).not.toContain("ignored sidechain");
    expect(session.records.filter((record) => record.kind === "message")).toHaveLength(2);
    expect(
      session.records.filter(
        (record) =>
          record.kind === "activity" && typeof record.payload.omittedAttachmentCount === "number",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "activity",
        tone: "info",
        activityKind: "task.completed",
        summary: "Omitted 4 attachments from imported transcript",
        payload: {
          omittedAttachmentCount: 4,
          summary: "Omitted 4 attachments from imported transcript",
          detail: "Attachment payloads are not included in imported transcripts.",
        },
      }),
    ]);
  });

  it("lets custom titles win over generated titles", () => {
    const session = parseClaudeSession({
      content: fixture("claude-session-custom-title.jsonl"),
      sourcePath: "/title.jsonl",
      contentHash: "title-hash",
    });

    expect(session.meta.title).toBe("Chosen title");
    expect(
      session.records.some(
        (record) =>
          record.kind === "activity" && typeof record.payload.omittedAttachmentCount === "number",
      ),
    ).toBe(false);
  });

  it("uses the first non-meta Claude prompt for the title while preserving meta messages", () => {
    const sessionId = "meta-title-session";
    const session = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          uuid: "meta-caveat",
          parentUuid: null,
          sessionId,
          isMeta: true,
          timestamp: "2026-07-29T10:00:00Z",
          message: {
            content: "<local-command-caveat>Do not use this as the title.</local-command-caveat>",
          },
        },
        {
          type: "user",
          uuid: "clear-command",
          parentUuid: "meta-caveat",
          sessionId,
          timestamp: "2026-07-29T10:00:01Z",
          message: {
            content:
              "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
          },
        },
        {
          type: "user",
          uuid: "request",
          parentUuid: "clear-command",
          sessionId,
          timestamp: "2026-07-29T10:00:02Z",
          message: { content: "Import the complete provider history" },
        },
        {
          type: "assistant",
          uuid: "response",
          parentUuid: "request",
          sessionId,
          timestamp: "2026-07-29T10:00:03Z",
          message: { content: "Import ready." },
        },
        {
          type: "custom-title",
          sessionId,
          customTitle:
            "<local-command-caveat>Do not use this generated branch title.</local-command-caveat>",
        },
      ]),
      sourcePath: "/meta-title.jsonl",
      contentHash: "meta-title-hash",
    });

    expect(session.meta.title).toBe("Import the complete provider history");
    expect(
      session.records
        .filter((record) => record.kind === "message")
        .map((record) => `${record.role}:${record.text}`),
    ).toEqual([
      "user:<local-command-caveat>Do not use this as the title.</local-command-caveat>",
      "user:<command-name>/clear</command-name>\n<command-message>clear</command-message>",
      "user:Import the complete provider history",
      "assistant:Import ready.",
    ]);
  });

  it("reconstructs the active graph through post-anchor descendants and canonical duplicates", () => {
    const sessionId = "graph-session";
    const session = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId,
          cwd: "/workspace/root",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Root prompt" },
        },
        {
          type: "assistant",
          uuid: "inactive",
          parentUuid: "root",
          sessionId,
          timestamp: "2026-01-01T00:00:01Z",
          message: { content: "Inactive branch" },
        },
        {
          type: "assistant",
          uuid: "active",
          parentUuid: "inactive",
          sessionId,
          timestamp: "2026-01-01T00:00:02Z",
          message: { content: "Stale duplicate" },
        },
        {
          type: "assistant",
          uuid: "active",
          parentUuid: "root",
          sessionId,
          timestamp: "2026-01-01T00:00:03Z",
          message: { model: "claude-selected", content: "Active branch" },
        },
        {
          type: "last-prompt",
          sessionId,
          leafUuid: "active",
        },
        {
          type: "user",
          uuid: "follow-up",
          parentUuid: "active",
          sessionId,
          timestamp: "2026-01-01T00:00:05Z",
          message: { content: "Continue active branch" },
        },
        {
          type: "assistant",
          uuid: "older-endpoint",
          parentUuid: "follow-up",
          sessionId,
          timestamp: "2026-01-01T00:00:06Z",
          message: { content: "Older descendant endpoint" },
        },
        {
          type: "assistant",
          uuid: "tool-call",
          parentUuid: "follow-up",
          sessionId,
          timestamp: "2026-01-01T00:00:07Z",
          message: {
            content: [
              {
                type: "tool_use",
                id: "selected-tool",
                name: "Bash",
                input: { command: "vp test run selected" },
              },
              { type: "text", text: "Selected tool branch" },
            ],
          },
        },
        {
          type: "user",
          uuid: "tool-result",
          parentUuid: "tool-call",
          sessionId,
          timestamp: "2026-01-01T00:00:08Z",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "selected-tool",
                content: "selected tests passed",
              },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "latest-endpoint",
          parentUuid: "tool-result",
          sessionId,
          timestamp: "2026-01-01T00:00:09Z",
          message: { content: "Latest descendant endpoint" },
        },
        {
          type: "custom-title",
          sessionId,
          customTitle: "Session-wide graph title",
        },
        {
          type: "user",
          sessionId,
          timestamp: "2026-01-01T00:00:11Z",
          message: { content: "UUID-less record must not leak" },
        },
      ]),
      sourcePath: "/graph.jsonl",
      contentHash: "graph-hash",
    });

    expect(
      session.records.map((record) =>
        record.kind === "message" ? `${record.role}:${record.text}` : record.summary,
      ),
    ).toEqual([
      "user:Root prompt",
      "assistant:Active branch",
      "user:Continue active branch",
      "Bash: vp test run selected",
      "assistant:Selected tool branch",
      "assistant:Latest descendant endpoint",
      "Imported with 3 parsing warnings",
    ]);
    expect(JSON.stringify(session.records)).not.toMatch(
      /Inactive branch|Stale duplicate|Older descendant endpoint|UUID-less record must not leak/,
    );
    expect(session.meta).toMatchObject({
      nativeSessionId: sessionId,
      model: "claude-selected",
      title: "Session-wide graph title",
    });
    expect(
      session.records.find(
        (record) => record.kind === "activity" && record.summary.startsWith("Bash"),
      ),
    ).toMatchObject({
      kind: "activity",
      payload: {
        detail: "selected tests passed",
        data: { toolCallId: "selected-tool" },
      },
    });
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("canonicalized 1 duplicate Claude UUID record"),
        expect.stringContaining("2 reachable descendant endpoints"),
        expect.stringContaining("skipped 1 UUID-less visible Claude record"),
      ]),
    );
  });

  it("falls back to the latest leaf, imports missing-parent suffixes, and rejects cycles", () => {
    const fallback = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          uuid: "complete-root",
          parentUuid: null,
          sessionId: "fallback",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Inactive complete root" },
        },
        {
          type: "user",
          uuid: "orphan",
          parentUuid: "missing-parent",
          sessionId: "fallback",
          timestamp: "2026-01-01T00:00:01Z",
          message: { content: "Reachable suffix prompt" },
        },
        {
          type: "assistant",
          uuid: "latest-leaf",
          parentUuid: "orphan",
          sessionId: "fallback",
          timestamp: "2026-01-01T00:00:02Z",
          message: { content: "Reachable suffix answer" },
        },
      ]),
      sourcePath: "/fallback.jsonl",
      contentHash: "fallback-hash",
    });

    expect(
      fallback.records.filter((record) => record.kind === "message").map((record) => record.text),
    ).toEqual(["Reachable suffix prompt", "Reachable suffix answer"]);
    expect(fallback.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("2 leaves and no valid last-prompt anchor"),
        expect.stringContaining("history is incomplete before UUID"),
      ]),
    );

    const cycle = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          uuid: "cycle-a",
          parentUuid: "cycle-b",
          sessionId: "cycle",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Must be rejected" },
        },
        {
          type: "assistant",
          uuid: "cycle-b",
          parentUuid: "cycle-a",
          sessionId: "cycle",
          timestamp: "2026-01-01T00:00:01Z",
          message: { content: "Must also be rejected" },
        },
      ]),
      sourcePath: "/cycle.jsonl",
      contentHash: "cycle-hash",
    });

    expect(cycle.records).toEqual([]);
    expect(cycle.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("graph contains a cycle"),
        expect.stringContaining("no messages found"),
      ]),
    );
  });

  it("retains an earlier duplicate when a later occurrence points back to its descendant", () => {
    const session = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId: "duplicate-backedge",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Root prompt" },
        },
        {
          type: "assistant",
          uuid: "answer",
          parentUuid: "root",
          sessionId: "duplicate-backedge",
          timestamp: "2026-01-01T00:00:01Z",
          message: { content: "Earlier answer" },
        },
        {
          type: "user",
          uuid: "follow-up",
          parentUuid: "answer",
          sessionId: "duplicate-backedge",
          timestamp: "2026-01-01T00:00:02Z",
          message: { content: "Follow-up prompt" },
        },
        {
          type: "assistant",
          uuid: "answer",
          parentUuid: "follow-up",
          sessionId: "duplicate-backedge",
          timestamp: "2026-01-01T00:00:03Z",
          message: { content: "Corrupt later duplicate" },
        },
      ]),
      sourcePath: "/duplicate-backedge.jsonl",
      contentHash: "duplicate-backedge-hash",
    });

    expect(
      session.records.filter((record) => record.kind === "message").map((record) => record.text),
    ).toEqual(["Root prompt", "Earlier answer", "Follow-up prompt"]);
    expect(JSON.stringify(session.records)).not.toContain("Corrupt later duplicate");
    expect(session.warnings).toContain(
      'line 4: ignored later duplicate Claude UUID "answer" because it creates a parent-chain cycle; retained the earlier occurrence',
    );
  });

  it("ignores a disconnected corrupt cycle outside the selected canonical ancestry", () => {
    const session = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          uuid: "valid-root",
          parentUuid: null,
          sessionId: "mixed-cycle",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Valid prompt" },
        },
        {
          type: "assistant",
          uuid: "valid-leaf",
          parentUuid: "valid-root",
          sessionId: "mixed-cycle",
          timestamp: "2026-01-01T00:00:01Z",
          message: { content: "Valid answer" },
        },
        {
          type: "user",
          uuid: "disconnected-cycle-a",
          parentUuid: "disconnected-cycle-b",
          sessionId: "mixed-cycle",
          timestamp: "2026-01-01T00:00:02Z",
          message: { content: "PRIVATE_DISCONNECTED_CYCLE_A" },
        },
        {
          type: "assistant",
          uuid: "disconnected-cycle-b",
          parentUuid: "disconnected-cycle-a",
          sessionId: "mixed-cycle",
          timestamp: "2026-01-01T00:00:03Z",
          message: { content: "PRIVATE_DISCONNECTED_CYCLE_B" },
        },
      ]),
      sourcePath: "/mixed-cycle.jsonl",
      contentHash: "mixed-cycle-hash",
    });

    expect(
      session.records.filter((record) => record.kind === "message").map((record) => record.text),
    ).toEqual(["Valid prompt", "Valid answer"]);
    expect(session.warnings).toEqual([]);
    expect(JSON.stringify(session)).not.toContain("PRIVATE_DISCONNECTED_CYCLE");
  });

  it("uses a trusted UUID filename instead of a foreign graph majority", () => {
    const trustedSessionId = "123e4567-e89b-12d3-a456-426614174099";
    const records: Array<Record<string, unknown>> = [
      {
        type: "user",
        uuid: "trusted-root",
        parentUuid: null,
        sessionId: trustedSessionId,
        timestamp: "2026-01-01T00:00:00Z",
        message: { content: "Trusted prompt" },
      },
      {
        type: "assistant",
        uuid: "trusted-leaf",
        parentUuid: "trusted-root",
        sessionId: trustedSessionId,
        timestamp: "2026-01-01T00:00:01Z",
        message: { content: "Trusted answer" },
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        type: index % 2 === 0 ? "user" : "assistant",
        uuid: `foreign-${index}`,
        parentUuid: index === 0 ? null : `foreign-${index - 1}`,
        sessionId: "foreign-session",
        timestamp: `2026-01-01T00:00:0${index + 2}Z`,
        message: { content: `Foreign message ${index}` },
      })),
    ];
    const session = parseClaudeSession({
      content: jsonl(records),
      sourcePath: `/projects/repo/${trustedSessionId}.jsonl`,
      contentHash: "trusted-hash",
    });

    expect(
      session.records.filter((record) => record.kind === "message").map((record) => record.text),
    ).toEqual(["Trusted prompt", "Trusted answer"]);
    expect(session.meta.nativeSessionId).toBe(trustedSessionId);
    expect(session.warnings).toContain(
      "ignored 4 Claude records whose session id did not match the transcript filename",
    );
    expect(JSON.stringify(session.records)).not.toContain("Foreign message");
  });

  it("classifies selected attachments and preserves only safe queued-command semantics", () => {
    const sessionId = "attachment-graph";
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "PRIVATE_IMAGE_BYTES" },
    };
    const session = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          uuid: "root",
          parentUuid: null,
          sessionId,
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Start" },
        },
        {
          type: "attachment",
          uuid: "admin",
          parentUuid: "root",
          sessionId,
          attachment: { type: "task_reminder", private: "PRIVATE_ADMIN_CONTEXT" },
        },
        {
          type: "attachment",
          uuid: "file",
          parentUuid: "admin",
          sessionId,
          timestamp: "2026-01-01T00:00:02Z",
          attachment: {
            type: "file",
            path: "/private/file.txt",
            content: "PRIVATE_FILE_CONTENT",
          },
        },
        {
          type: "attachment",
          uuid: "unknown-one",
          parentUuid: "file",
          sessionId,
          attachment: { type: "future-context", private: "PRIVATE_FUTURE_ONE" },
        },
        {
          type: "attachment",
          uuid: "unknown-two",
          parentUuid: "unknown-one",
          sessionId,
          attachment: { type: "future-context", private: "PRIVATE_FUTURE_TWO" },
        },
        {
          type: "attachment",
          uuid: "queued-duplicate",
          parentUuid: "unknown-two",
          sessionId,
          timestamp: "2026-01-01T00:00:05Z",
          attachment: {
            type: "queued_command",
            prompt: [{ type: "text", text: "Queued duplicate\r\nprompt" }, image],
          },
        },
        {
          type: "user",
          uuid: "ordinary-duplicate",
          parentUuid: "queued-duplicate",
          sessionId,
          timestamp: "2026-01-01T00:00:06Z",
          message: {
            content: [{ type: "text", text: "Queued duplicate\nprompt" }, image],
          },
        },
        {
          type: "attachment",
          uuid: "queued-unique",
          parentUuid: "ordinary-duplicate",
          sessionId,
          timestamp: "2026-01-01T00:00:07Z",
          attachment: { type: "queued_command", prompt: "Unique queued prompt" },
        },
        {
          type: "attachment",
          uuid: "task",
          parentUuid: "queued-unique",
          sessionId,
          timestamp: "2026-01-01T00:00:08Z",
          attachment: {
            type: "queued_command",
            prompt:
              "<task-notification><task-id>private-task-id</task-id><tool-use-id>private-tool-use</tool-use-id><summary>Background task finished</summary><status>completed</status><event><diagnostics><message>PRIVATE_TASK_RESULT</message></diagnostics></event><usage><tokens><input>42</input><output>7</output></tokens></usage><note>PRIVATE_TASK_NOTE</note>PRIVATE NARRATIVE PAYLOAD</task-notification>",
          },
        },
        {
          type: "attachment",
          uuid: "malformed-queued",
          parentUuid: "task",
          sessionId,
          attachment: {
            type: "queued_command",
            prompt: { unsupported: "PRIVATE_QUEUED_SHAPE" },
          },
        },
        {
          type: "assistant",
          uuid: "answer",
          parentUuid: "malformed-queued",
          sessionId,
          timestamp: "2026-01-01T00:00:09Z",
          message: { content: "Done" },
        },
      ]),
      sourcePath: "/attachments.jsonl",
      contentHash: "attachment-hash",
    });
    const serialized = JSON.stringify(session.records);

    expect(
      session.records.map((record) =>
        record.kind === "message" ? `${record.role}:${record.text}` : record.summary,
      ),
    ).toEqual([
      "user:Start",
      "user:Queued duplicate\nprompt",
      "user:Unique queued prompt",
      "Background task finished",
      "assistant:Done",
      "Omitted 2 attachments from imported transcript",
      "Imported with 2 parsing warnings",
    ]);
    expect(
      session.records.find(
        (record) => record.kind === "activity" && record.summary === "Background task finished",
      ),
    ).toMatchObject({
      kind: "activity",
      tone: "info",
      activityKind: "task.completed",
      payload: {
        summary: "Background task finished",
        status: "completed",
      },
    });
    expect(session.warnings).toContain(
      'unknown Claude attachment subtype "future-context" appeared in 2 selected records and was omitted',
    );
    expect(session.warnings).toContain("line 10: unknown queued command shape was omitted");
    expect(serialized).not.toMatch(
      /PRIVATE(?: NARRATIVE PAYLOAD|_(?:ADMIN_CONTEXT|FILE_CONTENT|FUTURE_ONE|FUTURE_TWO|IMAGE_BYTES|TASK_RESULT|TASK_NOTE|QUEUED_SHAPE))|private-(?:task-id|tool-use)|\/private\/file/,
    );
  });

  it("bounds metadata and tool identity while pairing on the raw Claude call id", () => {
    const sessionId = "s".repeat(700);
    const oversizedMetadata = "m".repeat(700);
    const oversizedCwd = `/${"c".repeat(4_096)}`;
    const rawCallId = "tool-".padEnd(700, "x");
    const rawToolName = "tool-".padEnd(400, "é");
    const session = parseClaudeSession({
      content: jsonl([
        {
          type: "custom-title",
          sessionId,
          customTitle: oversizedMetadata,
        },
        {
          type: "user",
          sessionId,
          cwd: oversizedCwd,
          gitBranch: oversizedMetadata,
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Run bounded tool" },
        },
        {
          type: "assistant",
          sessionId,
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            model: oversizedMetadata,
            content: [
              {
                type: "tool_use",
                id: rawCallId,
                name: rawToolName,
                input: { value: 1 },
              },
              { type: "text", text: "Tool started" },
            ],
          },
        },
        {
          type: "user",
          sessionId,
          timestamp: "2026-01-01T00:00:02Z",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: rawCallId,
                content: "bounded result",
              },
            ],
          },
        },
      ]),
      sourcePath: "/bounded.jsonl",
      contentHash: "bounded-hash",
    });
    const tool = session.records.find(
      (record) => record.kind === "activity" && record.payload.itemType === "dynamic_tool_call",
    );

    expect(session.meta).toMatchObject({
      nativeSessionId: null,
      cwd: null,
    });
    expect(session.meta.gitBranch).toHaveLength(512);
    expect(session.meta.model).toHaveLength(512);
    expect(session.meta.title).toHaveLength(512);
    expect(tool).toMatchObject({
      kind: "activity",
      payload: {
        status: "completed",
        detail: "bounded result",
        data: {
          toolCallId: expect.stringMatching(/^[0-9a-f-]+$/),
        },
      },
    });
    if (tool?.kind !== "activity") return;
    expect(new TextEncoder().encode(String(tool.payload.title)).byteLength).toBeLessThanOrEqual(
      256,
    );
    expect((tool.payload.data as { toolCallId: string }).toolCallId).not.toBe(rawCallId);
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("native session id was invalid or oversized"),
        expect.stringContaining("session title exceeded 512 characters"),
        expect.stringContaining("cwd exceeded 4096 characters"),
        expect.stringContaining("git branch exceeded 512 characters"),
        expect.stringContaining("model exceeded 512 characters"),
        expect.stringContaining("tool name exceeded 256 bytes"),
        expect.stringContaining("tool call id exceeded 512 bytes"),
      ]),
    );
  });

  it("warns once per unknown type and returns empty records when no messages remain", () => {
    const session = parseClaudeSession({
      content: [
        '{"type":"custom-title","sessionId":"empty","title":"Empty"}',
        '{"type":"future-record","sessionId":"empty"}',
        '{"type":"future-record","sessionId":"empty"}',
        '{"type":"assistant","sessionId":"empty","timestamp":"bad","message":{"content":[{"type":"text","text":"not emitted"}]}}',
        "not json",
      ].join("\n"),
      sourcePath: "/empty.jsonl",
      contentHash: "empty-hash",
    });

    expect(session.records).toEqual([]);
    expect(session.warnings.filter((warning) => warning.includes("future-record"))).toHaveLength(1);
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("invalid timestamp"),
        expect.stringContaining("malformed JSON"),
        expect.stringContaining("no messages"),
      ]),
    );
  });

  it("preserves supported nested text and surfaces unsupported content blocks", () => {
    const session = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          sessionId: "nested-content",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:00Z",
          message: {
            content: [
              { type: "text", text: "Keep nested text" },
              {
                type: "document",
                source: { data: "PRIVATE_CLAUDE_DOCUMENT", media_type: "application/pdf" },
              },
              { type: "future_content", privatePayload: "PRIVATE_CLAUDE_BLOCK" },
              "malformed-private-content",
            ],
          },
        },
        {
          type: "assistant",
          sessionId: "nested-content",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:01Z",
          message: { content: [{ type: "text", text: "Keep assistant text" }] },
        },
      ]),
      sourcePath: "/nested-content.jsonl",
      contentHash: "nested-content-hash",
    });

    expect(
      session.records
        .filter((record) => record.kind === "message")
        .map((record) => `${record.role}:${record.text}`),
    ).toEqual(["user:Keep nested text", "assistant:Keep assistant text"]);
    expect(session.warnings).toEqual(["line 1: 2 unsupported user content blocks omitted"]);
    expect(
      session.records.find(
        (record) =>
          record.kind === "activity" && typeof record.payload.omittedAttachmentCount === "number",
      ),
    ).toMatchObject({
      kind: "activity",
      tone: "info",
      payload: {
        omittedAttachmentCount: 1,
        summary: "Omitted 1 attachment from imported transcript",
      },
    });
    expect(session.records.at(-1)).toMatchObject({
      kind: "activity",
      tone: "error",
      payload: {
        importWarningCount: 1,
        detail: "line 1: 2 unsupported user content blocks omitted",
      },
    });
    expect(JSON.stringify(session)).not.toContain("PRIVATE_CLAUDE_DOCUMENT");
    expect(JSON.stringify(session)).not.toContain("PRIVATE_CLAUDE_BLOCK");
    expect(JSON.stringify(session)).not.toContain("malformed-private-content");
  });

  it("clamps duplicate maximum Date timestamps without throwing", () => {
    const maximumDate = "+275760-09-13T00:00:00.000Z";
    const session = parseClaudeSession({
      content: jsonl([
        {
          type: "user",
          sessionId: "maximum-date",
          cwd: "/repo",
          timestamp: maximumDate,
          message: { content: "At the limit" },
        },
        {
          type: "assistant",
          sessionId: "maximum-date",
          cwd: "/repo",
          timestamp: maximumDate,
          message: { content: "Still at the limit" },
        },
      ]),
      sourcePath: "/maximum-date.jsonl",
      contentHash: "maximum-date-hash",
    });

    expect(session.records.map((record) => record.createdAt)).toEqual([maximumDate, maximumDate]);
    expect(session.meta.firstActivityAt).toBe(maximumDate);
    expect(session.meta.lastActivityAt).toBe(maximumDate);
    expect(session.warnings).toEqual([]);
  });

  it("omits unpaired tool calls and surfaces a normalized warning", () => {
    const session = parseClaudeSession({
      content: [
        JSON.stringify({
          type: "user",
          sessionId: "unpaired",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Run it" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "unpaired",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            content: [
              { type: "tool_use", id: "pending", name: "Bash", input: { command: "vp test" } },
              { type: "text", text: "Interrupted." },
            ],
          },
        }),
      ].join("\n"),
      sourcePath: "/unpaired.jsonl",
      contentHash: "unpaired-hash",
    });

    expect(
      session.records.some(
        (record) => record.kind === "activity" && record.activityKind === "tool.completed",
      ),
    ).toBe(false);
    expect(session.records.at(-1)).toMatchObject({
      kind: "activity",
      tone: "error",
      payload: {
        importWarningCount: 1,
        detail: "omitted 1 unpaired tool call from imported transcript",
      },
    });
  });

  it("surfaces a malformed tail inside the normalized transcript", () => {
    const session = parseClaudeSession({
      content: [
        JSON.stringify({
          type: "user",
          sessionId: "tail",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Keep this" },
        }),
        '{"type":"assistant","sessionId":"tail"',
      ].join("\n"),
      sourcePath: "/tail.jsonl",
      contentHash: "tail-hash",
    });

    expect(session.records.at(-1)).toMatchObject({
      kind: "activity",
      tone: "error",
      payload: {
        importWarningCount: 1,
        detail: "line 2: malformed JSON skipped",
      },
    });
  });

  it("rejects JSONL beyond the hard physical-line cap", () => {
    expect(() =>
      parseClaudeSession({
        content: `${"{}\n".repeat(100_000)}{}`,
        sourcePath: "/too-many-lines.jsonl",
        contentHash: "too-many-lines-hash",
      }),
    ).toThrow(/physical-line limit exceeded/);
  });

  it("bounds nested attachment inspection by depth and branch count without recursive overflow", () => {
    let nestedContent: unknown[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "private-nested-image",
        },
      },
    ];
    for (let depth = 0; depth < 100; depth += 1) {
      nestedContent = [
        {
          type: "tool_result",
          tool_use_id: `nested-${depth}`,
          content: nestedContent,
        },
      ];
    }
    const depthSession = parseClaudeSession({
      content: JSON.stringify({
        type: "user",
        uuid: "nested-user",
        parentUuid: null,
        sessionId: "nested-attachments",
        cwd: "/repo",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          content: [{ type: "text", text: "Keep this" }, ...nestedContent],
        },
      }),
      sourcePath: "/nested-attachments.jsonl",
      contentHash: "nested-attachments-hash",
    });

    expect(depthSession.records[0]).toMatchObject({
      kind: "message",
      role: "user",
      text: "Keep this",
    });
    expect(depthSession.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "nested attachment inspection was capped at 25000 values and depth 8",
        ),
      ]),
    );
    expect(JSON.stringify(depthSession)).not.toContain("private-nested-image");

    const branches = Array.from({ length: 200 }, (_, branchIndex) => ({
      type: "tool_result",
      tool_use_id: `branch-${branchIndex}`,
      content: Array.from({ length: 200 }, () => ({
        type: "text",
        text: "bounded branch value",
      })),
    }));
    const branchSession = parseClaudeSession({
      content: JSON.stringify({
        type: "user",
        uuid: "branching-user",
        parentUuid: null,
        sessionId: "branching-attachments",
        cwd: "/repo",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          content: [
            { type: "text", text: "Keep this" },
            {
              type: "tool_result",
              tool_use_id: "outer-result",
              content: branches,
            },
          ],
        },
      }),
      sourcePath: "/branching-attachments.jsonl",
      contentHash: "branching-attachments-hash",
    });

    expect(branchSession.records[0]).toMatchObject({
      kind: "message",
      role: "user",
      text: "Keep this",
    });
    expect(branchSession.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "nested attachment inspection was capped at 25000 values and depth 8",
        ),
      ]),
    );
  });

  it("rejects one content array that amplifies beyond the normalized record cap", () => {
    const reasoningBlocks = Array.from({ length: 25_001 }, (_, index) => ({
      type: "thinking",
      thinking: `step ${index}`,
    }));

    expect(() =>
      parseClaudeSession({
        content: [
          JSON.stringify({
            type: "user",
            uuid: "record-limit-user",
            parentUuid: null,
            sessionId: "record-limit",
            cwd: "/repo",
            timestamp: "2026-01-01T00:00:00Z",
            message: { content: "Start" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "record-limit-assistant",
            parentUuid: "record-limit-user",
            sessionId: "record-limit",
            cwd: "/repo",
            timestamp: "2026-01-01T00:00:01Z",
            message: {
              content: reasoningBlocks,
            },
          }),
        ].join("\n"),
        sourcePath: "/too-many-normalized-records.jsonl",
        contentHash: "too-many-normalized-records-hash",
      }),
    ).toThrow(/normalized record limit exceeded: maximum is 25000/);
  });

  it("truncates oversized reasoning at one MiB and surfaces the loss", () => {
    const oversizedReasoning = "é".repeat(524_300);
    const session = parseClaudeSession({
      content: [
        JSON.stringify({
          type: "user",
          sessionId: "large",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:00Z",
          message: { content: "Think" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "large",
          cwd: "/repo",
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            content: [
              { type: "thinking", thinking: oversizedReasoning },
              { type: "text", text: "Done." },
            ],
          },
        }),
      ].join("\n"),
      sourcePath: "/large.jsonl",
      contentHash: "large-hash",
    });
    const reasoning = session.records.find(
      (record) => record.kind === "activity" && record.activityKind === "task.progress",
    );

    expect(reasoning?.kind).toBe("activity");
    if (reasoning?.kind !== "activity") return;
    const detail = reasoning.payload.detail;
    expect(typeof detail).toBe("string");
    if (typeof detail !== "string") return;
    expect(new TextEncoder().encode(detail).byteLength).toBeLessThanOrEqual(1_048_576);
    expect(detail.endsWith("…")).toBe(true);
    expect(session.records.at(-1)).toMatchObject({
      kind: "activity",
      payload: {
        importWarningCount: 1,
        detail: expect.stringContaining("reasoning exceeded 1 MiB and was truncated"),
      },
    });
  });
});
