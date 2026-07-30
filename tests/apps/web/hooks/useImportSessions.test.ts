// tests/apps/web/hooks/useImportSessions.test.ts
// verifies bounded import batches and environment-scoped async operation guards
import type { Dispatch, SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ImportSessionsRequest,
  type ImportSessionsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

const operationAtoms = vi.hoisted(() => ({
  importScan: Symbol("importScan"),
  importSessions: Symbol("importSessions"),
}));

const testState = vi.hoisted(() => ({
  environmentId: "environment-a" as string | null,
  runImport: vi.fn(),
  runScan: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  let pendingEffects: Array<() => void | (() => void)> = [];

  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
      pendingEffects = [];
    },
    flushEffects() {
      for (const effect of pendingEffects) {
        effect();
      }
      pendingEffects = [];
    },
    reset() {
      cursor = 0;
      slots = [];
      pendingEffects = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useEffect(effect: () => void | (() => void)) {
      nextIndex();
      pendingEffects.push(effect);
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: operationAtoms,
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () =>
    testState.environmentId === null ? null : EnvironmentId.make(testState.environmentId),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === operationAtoms.importScan ? testState.runScan : testState.runImport,
}));

import {
  IMPORT_SESSIONS_CLIENT_BATCH_SIZE,
  useImportSessions,
} from "../../../../apps/web/src/hooks/useImportSessions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function successfulImport(items: ReadonlyArray<ImportSessionsRequest["items"][number]>): {
  readonly _tag: "Success";
  readonly value: ImportSessionsResult;
} {
  return {
    _tag: "Success",
    value: {
      imported: items.map((item, index) => ({
        sourcePath: item.sourcePath,
        threadId: ThreadId.make(`thread-${item.sourcePath}-${index}`),
        projectId: ProjectId.make("project-import"),
        messageCount: 1,
        activityCount: 0,
        continuation: {
          state: "verified",
          providerInstanceId: item.providerInstanceId,
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("codex"),
            continuationKey: "codex:test-source",
          },
          reason: null,
        },
      })),
      skipped: [],
      failed: [],
    },
  };
}

function renderHook() {
  hooks.beginRender();
  const value = useImportSessions();
  hooks.flushEffects();
  return value;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  hooks.reset();
  testState.environmentId = "environment-a";
  testState.runImport.mockReset();
  testState.runScan.mockReset();
});

describe("useImportSessions environment guards", () => {
  it("does not scan until the user explicitly requests discovery", () => {
    const hook = renderHook();

    expect(hook.scanResult).toBeNull();
    expect(hook.isScanning).toBe(false);
    expect(testState.runScan).not.toHaveBeenCalled();
  });

  it("reports progress across bounded batches and aggregates in order", async () => {
    const providerInstanceId = ProviderInstanceId.make("codex");
    const items = Array.from(
      { length: IMPORT_SESSIONS_CLIENT_BATCH_SIZE + 1 },
      (_, index): ImportSessionsRequest["items"][number] => ({
        source: "codex-cli",
        sourcePath: `/tmp/session-${index}.jsonl`,
        providerInstanceId,
      }),
    );
    const firstBatch = deferred<ReturnType<typeof successfulImport>>();
    const secondBatch = deferred<ReturnType<typeof successfulImport>>();
    testState.runImport
      .mockReturnValueOnce(firstBatch.promise)
      .mockReturnValueOnce(secondBatch.promise);
    testState.runScan.mockResolvedValue({
      _tag: "Success",
      value: {
        candidates: [],
        errors: [],
        scannedAt: "2026-07-25T12:01:00.000Z",
        truncated: false,
      },
    });

    const hook = renderHook();
    const importPromise = hook.importSelected({ items });
    expect(renderHook()).toMatchObject({
      isImporting: true,
      importProgress: {
        phase: "running",
        total: IMPORT_SESSIONS_CLIENT_BATCH_SIZE + 1,
        completed: 0,
      },
    });
    expect(testState.runImport).toHaveBeenCalledOnce();
    expect(testState.runImport.mock.calls[0]?.[0].input.items).toHaveLength(
      IMPORT_SESSIONS_CLIENT_BATCH_SIZE,
    );

    firstBatch.resolve(successfulImport(items.slice(0, IMPORT_SESSIONS_CLIENT_BATCH_SIZE)));
    await flushPromises();
    expect(testState.runImport).toHaveBeenCalledTimes(2);
    expect(testState.runImport.mock.calls[1]?.[0].input.items).toHaveLength(1);
    expect(renderHook()).toMatchObject({
      isImporting: true,
      importProgress: {
        phase: "running",
        total: IMPORT_SESSIONS_CLIENT_BATCH_SIZE + 1,
        completed: IMPORT_SESSIONS_CLIENT_BATCH_SIZE,
        imported: IMPORT_SESSIONS_CLIENT_BATCH_SIZE,
        skipped: 0,
        failed: 0,
      },
    });

    secondBatch.resolve(successfulImport(items.slice(IMPORT_SESSIONS_CLIENT_BATCH_SIZE)));
    const result = await importPromise;
    await flushPromises();

    expect(result?.imported).toHaveLength(IMPORT_SESSIONS_CLIENT_BATCH_SIZE + 1);
    expect(result?.imported.map((item) => item.sourcePath)).toEqual(
      items.map((item) => item.sourcePath),
    );
    expect(testState.runScan).toHaveBeenCalledOnce();
    const complete = renderHook();
    expect(complete.isImporting).toBe(false);
    expect(complete.importProgress).toBeNull();
    expect(complete.importResult?.imported).toHaveLength(IMPORT_SESSIONS_CLIENT_BATCH_SIZE + 1);
  });

  it("keeps an operation error and rescans after a later batch transport failure", async () => {
    const providerInstanceId = ProviderInstanceId.make("codex");
    const items = Array.from(
      { length: IMPORT_SESSIONS_CLIENT_BATCH_SIZE + 1 },
      (_, index): ImportSessionsRequest["items"][number] => ({
        source: "codex-cli",
        sourcePath: `/tmp/session-${index}.jsonl`,
        providerInstanceId,
      }),
    );
    testState.runImport
      .mockResolvedValueOnce(successfulImport(items.slice(0, IMPORT_SESSIONS_CLIENT_BATCH_SIZE)))
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("second batch unavailable")),
      });
    testState.runScan.mockResolvedValue({
      _tag: "Success",
      value: {
        candidates: [],
        errors: [],
        scannedAt: "2026-07-25T12:01:00.000Z",
        truncated: false,
      },
    });

    const result = await renderHook().importSelected({ items });
    await flushPromises();

    expect(result).toBeNull();
    expect(testState.runImport).toHaveBeenCalledTimes(2);
    expect(testState.runScan).toHaveBeenCalledOnce();
    expect(renderHook().importError).toBe("second batch unavailable");
  });

  it("stops scheduling after the acknowledged batch and preserves partial results", async () => {
    const providerInstanceId = ProviderInstanceId.make("codex");
    const items = Array.from(
      { length: IMPORT_SESSIONS_CLIENT_BATCH_SIZE + 1 },
      (_, index): ImportSessionsRequest["items"][number] => ({
        source: "codex-cli",
        sourcePath: `/tmp/session-${index}.jsonl`,
        providerInstanceId,
      }),
    );
    const firstBatch = deferred<ReturnType<typeof successfulImport>>();
    testState.runImport.mockReturnValueOnce(firstBatch.promise);
    testState.runScan.mockResolvedValue({
      _tag: "Success",
      value: {
        candidates: [],
        errors: [],
        scannedAt: "2026-07-25T12:01:00.000Z",
        truncated: false,
      },
    });

    const importPromise = renderHook().importSelected({ items });
    renderHook().cancelImport();
    expect(renderHook().importProgress?.phase).toBe("stopping");

    firstBatch.resolve(successfulImport(items.slice(0, IMPORT_SESSIONS_CLIENT_BATCH_SIZE)));
    await expect(importPromise).resolves.toBeNull();
    await flushPromises();

    expect(testState.runImport).toHaveBeenCalledOnce();
    expect(testState.runScan).toHaveBeenCalledOnce();
    expect(renderHook()).toMatchObject({
      isImporting: false,
      importProgress: {
        phase: "cancelled",
        total: IMPORT_SESSIONS_CLIENT_BATCH_SIZE + 1,
        completed: IMPORT_SESSIONS_CLIENT_BATCH_SIZE,
        imported: IMPORT_SESSIONS_CLIENT_BATCH_SIZE,
      },
    });
    expect(renderHook().importResult?.imported).toHaveLength(IMPORT_SESSIONS_CLIENT_BATCH_SIZE);
  });

  it("rescans after a first-batch transport failure that may have persisted work", async () => {
    testState.runImport.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("connection closed after dispatch")),
    });
    testState.runScan.mockResolvedValue({
      _tag: "Success",
      value: {
        candidates: [],
        errors: [],
        scannedAt: "2026-07-25T12:01:00.000Z",
        truncated: false,
      },
    });

    await expect(
      renderHook().importSelected({
        items: [
          {
            source: "codex-cli",
            sourcePath: "/tmp/session.jsonl",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        ],
      }),
    ).resolves.toBeNull();
    await flushPromises();

    expect(testState.runScan).toHaveBeenCalledOnce();
    expect(renderHook().importError).toBe("connection closed after dispatch");
  });

  it("clears a successful scan before a rescan and keeps it cleared when that rescan fails", async () => {
    const failedRescan = deferred<{
      readonly _tag: "Failure";
      readonly cause: Cause.Cause<Error>;
    }>();
    testState.runScan
      .mockResolvedValueOnce({
        _tag: "Success",
        value: {
          candidates: [],
          errors: [],
          scannedAt: "2026-07-25T12:00:00.000Z",
          truncated: false,
        },
      })
      .mockReturnValueOnce(failedRescan.promise);

    const initial = renderHook();
    await initial.scan();
    await flushPromises();
    const scanned = renderHook();
    expect(scanned.scanResult?.scannedAt).toBe("2026-07-25T12:00:00.000Z");

    const retry = scanned.scan();
    const retrying = renderHook();
    expect(retrying.isScanning).toBe(true);
    expect(retrying.scanResult).toBeNull();

    failedRescan.resolve({
      _tag: "Failure",
      cause: Cause.fail(new Error("source root unavailable")),
    });
    await expect(retry).resolves.toBeNull();
    await flushPromises();

    const failed = renderHook();
    expect(failed.scanResult).toBeNull();
    expect(failed.scanError).toBe("source root unavailable");
  });

  it("does not expose an old scan result after the primary environment changes", async () => {
    const scanA = deferred<{
      readonly _tag: "Success";
      readonly value: {
        readonly candidates: readonly [];
        readonly errors: readonly [];
        readonly scannedAt: string;
        readonly truncated: boolean;
      };
    }>();
    const scanB = deferred<{
      readonly _tag: "Success";
      readonly value: {
        readonly candidates: readonly [];
        readonly errors: readonly [];
        readonly scannedAt: string;
        readonly truncated: boolean;
      };
    }>();
    testState.runScan.mockImplementation(({ environmentId }: { readonly environmentId: string }) =>
      environmentId === "environment-a" ? scanA.promise : scanB.promise,
    );

    const hookA = renderHook();
    const scanAPromise = hookA.scan();
    testState.environmentId = "environment-b";
    const hookB = renderHook();
    const scanBPromise = hookB.scan();

    scanA.resolve({
      _tag: "Success",
      value: {
        candidates: [],
        errors: [],
        scannedAt: "2026-07-25T12:00:00.000Z",
        truncated: false,
      },
    });
    await scanAPromise;
    await flushPromises();
    expect(renderHook().scanResult).toBeNull();

    scanB.resolve({
      _tag: "Success",
      value: {
        candidates: [],
        errors: [],
        scannedAt: "2026-07-25T12:01:00.000Z",
        truncated: false,
      },
    });
    await scanBPromise;
    await flushPromises();
    expect(renderHook().scanResult?.scannedAt).toBe("2026-07-25T12:01:00.000Z");
  });

  it("preserves a partial failure while rescanning the created thread for repair", async () => {
    const providerInstanceId = ProviderInstanceId.make("codex");
    testState.runImport.mockResolvedValue({
      _tag: "Success",
      value: {
        imported: [],
        skipped: [],
        failed: [
          {
            sourcePath: "/tmp/session.jsonl",
            message: "The second message batch failed.",
          },
        ],
      },
    });
    testState.runScan.mockResolvedValue({
      _tag: "Success",
      value: {
        candidates: [
          {
            source: "codex-cli",
            sourcePath: "/tmp/session.jsonl",
            providerInstanceIds: [providerInstanceId],
            nativeSessionId: "native-session",
            title: "Partially imported session",
            cwd: "/tmp/project",
            gitBranch: "main",
            model: "gpt-5.4",
            messageCount: 201,
            modifiedAt: "2026-07-25T12:00:00.000Z",
            alreadyImportedThreadId: "thread-partial",
            matchedProjectId: "project-import",
            resumable: true,
          },
        ],
        errors: [],
        scannedAt: "2026-07-25T12:01:00.000Z",
        truncated: false,
      },
    });

    const hook = renderHook();
    await expect(
      hook.importSelected({
        items: [
          {
            source: "codex-cli",
            sourcePath: "/tmp/session.jsonl",
            providerInstanceId,
          },
        ],
      }),
    ).resolves.toEqual({
      imported: [],
      skipped: [],
      failed: [
        {
          sourcePath: "/tmp/session.jsonl",
          message: "The second message batch failed.",
        },
      ],
    });
    await flushPromises();

    const repaired = renderHook();
    expect(testState.runScan).toHaveBeenCalledOnce();
    expect(repaired.importResult?.failed).toHaveLength(1);
    expect(repaired.scanResult?.candidates[0]).toMatchObject({
      sourcePath: "/tmp/session.jsonl",
      alreadyImportedThreadId: "thread-partial",
    });
  });

  it("discards an in-flight import result when its environment is no longer primary", async () => {
    const importA = deferred<{
      readonly _tag: "Success";
      readonly value: {
        readonly imported: readonly [];
        readonly skipped: readonly [];
        readonly failed: readonly [];
      };
    }>();
    testState.runScan.mockResolvedValue({
      _tag: "Success",
      value: {
        candidates: [],
        errors: [],
        scannedAt: "2026-07-25T12:00:00.000Z",
        truncated: false,
      },
    });
    testState.runImport.mockReturnValue(importA.promise);

    renderHook();
    await flushPromises();
    const hook = renderHook();
    const importPromise = hook.importSelected({
      items: [
        {
          source: "codex-cli",
          sourcePath: "/tmp/session.jsonl",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ],
    });

    testState.environmentId = "environment-b";
    renderHook();
    importA.resolve({
      _tag: "Success",
      value: {
        imported: [],
        skipped: [],
        failed: [],
      },
    });
    await expect(importPromise).resolves.toBeNull();
    await flushPromises();

    const current = renderHook();
    expect(current.environmentId).toBe(EnvironmentId.make("environment-b"));
    expect(current.importResult).toBeNull();
    expect(current.importError).toBeNull();
  });
});
