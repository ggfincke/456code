// apps/mobile/src/widgets/denseWidgetSnapshot.ts
// builds bounded activity and quota snapshots for the dense ios widget

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

import type { WidgetTheme } from "./widgetTheme";

export interface DenseWidgetRow {
  key: string;
  title: string;
  project: string;
  provider: string;
  status: string;
  at: number;
  url: string;
  request?: "approval" | "question";
  detail?: string;
}

export interface DenseWidgetData {
  host: string;
  live: boolean;
  url: string;
  usageUrl: string;
  attention: DenseWidgetRow[];
  attentionCount: number;
  running: DenseWidgetRow[];
  runningCount: number;
  finished: DenseWidgetRow[];
  quotas: Array<{
    provider: string;
    name: string;
    totalWindows: number;
    windows: Array<{ label: string; remaining: number; resetsAt: number | null }>;
    expiresAt: number;
  }>;
}

export interface DenseWidgetSnapshot extends DenseWidgetData {
  checkedAt: number;
  expiresAt: number;
  theme?: WidgetTheme;
}

export function denseAttentionThreads(threads: readonly EnvironmentThreadShell[]) {
  return threads
    .filter(
      (thread) =>
        !thread.deletedAt &&
        !thread.archivedAt &&
        (thread.hasPendingApprovals || thread.hasPendingUserInput),
    )
    .sort(
      (a, b) =>
        (a.source.pendingRuntimeRequest?.createdAt.epochMilliseconds ?? 0) -
        (b.source.pendingRuntimeRequest?.createdAt.epochMilliseconds ?? 0),
    );
}

export function buildDenseWidgetData(input: {
  threads: readonly EnvironmentThreadShell[];
  hosts: ReadonlyArray<{ id: EnvironmentId; label: string; live: boolean }>;
  projectTitle: (thread: EnvironmentThreadShell) => string;
  threadUrl: (thread: EnvironmentThreadShell) => string;
  requests: ReadonlyMap<string, PendingThreadRequests | null>;
  presentations: LimitPresentations;
  url: string;
  usageUrl: string;
}): DenseWidgetData {
  const threads = input.threads.filter((thread) => !thread.deletedAt && !thread.archivedAt);
  const pending = denseAttentionThreads(threads);
  const row = (thread: EnvironmentThreadShell): DenseWidgetRow => ({
    key: `${thread.environmentId}:${thread.id}`,
    title: thread.title,
    project: input.projectTitle(thread),
    provider:
      input.presentations
        .get(thread.environmentId)
        ?.serverConfig?.providers.find(
          (provider) => provider.instanceId === thread.providerInstanceId,
        )?.driver ?? "",
    status: thread.blockedOnThreadWait
      ? "Waiting on agent"
      : thread.runtime?.status === "running"
        ? "Working"
        : thread.runtime?.status === "queued"
          ? "Queued"
          : thread.runtime?.status === "waiting"
            ? "Finishing"
            : "Starting",
    at: Date.parse(
      thread.runtime?.activityStartedAt ?? thread.latestRun?.startedAt ?? thread.createdAt,
    ),
    url: input.threadUrl(thread),
  });
  const running = threads
    .filter(
      (thread) =>
        threadRuntimeIsActive(thread.runtime) &&
        ((!thread.hasPendingApprovals && !thread.hasPendingUserInput) ||
          thread.source.pendingRuntimeRequest?.blocking === false),
    )
    .map(row)
    .sort((a, b) => b.at - a.at);
  const accounts = collectLimitAccounts(input.presentations);
  const quotas = collectLimitPools(accounts, 0)
    .filter((pool) => pool.driver === "codex" || pool.driver === "claudeAgent")
    .map((pool) => ({
      provider: pool.driver,
      name: pool.driver === "codex" ? "Codex" : "Claude",
      totalWindows: pool.windows.length,
      expiresAt:
        Math.min(...pool.accounts.map((account) => Date.parse(account.limits.checkedAt))) +
        15 * 60_000,
      windows: [...pool.windows]
        .sort((a, b) => a.remainingPercent - b.remainingPercent)
        .slice(0, 4)
        .map((window) => ({
          label: window.label,
          remaining: Math.round(window.remainingPercent),
          resetsAt: window.resets[0]?.at ?? null,
        })),
    }));
  return {
    host:
      input.hosts.length === 0
        ? "Connect"
        : input.hosts.length === 1
          ? input.hosts[0]!.label
          : `${input.hosts.length} environments`,
    live: input.hosts.length > 0 && input.hosts.every((host) => host.live),
    url: input.url,
    usageUrl: input.usageUrl,
    attentionCount: pending.length,
    attention: pending.slice(0, 2).map((thread) => {
      const base = row(thread);
      const requests = input.requests.get(base.key);
      const summary = thread.source.pendingRuntimeRequest;
      const approval = requests?.approvals.find((request) => request.requestId === summary?.id);
      const question = requests?.userInputs.find((request) => request.requestId === summary?.id);
      return {
        ...base,
        at: summary?.createdAt.epochMilliseconds ?? base.at,
        request: thread.hasPendingApprovals ? "approval" : "question",
        status: thread.hasPendingApprovals ? "Approval needed" : "Question for you",
        detail: (approval?.detail ?? question?.questions[0]?.question ?? thread.title).slice(
          0,
          180,
        ),
      };
    }),
    runningCount: running.length,
    running: running.slice(0, 6),
    finished: threads
      .filter(
        (thread) =>
          thread.latestRun?.status === "completed" &&
          !threadRuntimeIsActive(thread.runtime) &&
          !thread.hasPendingApprovals &&
          !thread.hasPendingUserInput,
      )
      .map((thread) => ({
        ...row(thread),
        status: "Finished",
        at: Date.parse(thread.latestRun!.completedAt ?? thread.updatedAt),
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 3),
    quotas,
  };
}

export function denseWidgetTimeline(snapshot: DenseWidgetSnapshot, now: number) {
  const deadlines = [
    snapshot.expiresAt,
    ...snapshot.quotas.flatMap((quota) => [
      quota.expiresAt,
      ...quota.windows.flatMap((window) => (window.resetsAt === null ? [] : [window.resetsAt])),
    ]),
  ];
  return [now, ...new Set(deadlines.filter((date) => Number.isFinite(date) && date > now))]
    .sort((a, b) => a - b)
    .map((date) => ({ date: new Date(date), props: snapshot }));
}
