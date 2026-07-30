// apps/web/src/components/settings/ImportSessionsPanel.tsx
// presents local session discovery, selection, import outcomes, and warnings
import {
  type EnvironmentId,
  type ImportScanCandidate,
  type ImportSessionsRequest,
  type ImportSessionsResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  DownloadIcon,
  FolderIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { useImportSessions } from "../../hooks/useImportSessions";
import type { ImportSessionProgress } from "../../hooks/useImportSessions";
import { importSourceDisplayName, importSourceDriverKind } from "../../importSourcePresentation";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { cn } from "~/lib/utils";

interface CandidateProviderSelection {
  readonly options: ReadonlyArray<{
    readonly entry: ProviderInstanceEntry | null;
    readonly instanceId: ProviderInstanceId;
    readonly selectable: boolean;
  }>;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly blockedReason: string | null;
}

interface ImportCandidateGroup {
  readonly key: string;
  readonly title: string;
  readonly candidates: ReadonlyArray<ImportScanCandidate>;
}

type BulkSelectionMode = "all" | "resumable" | "transcript-only";

export const IMPORT_CANDIDATE_PAGE_SIZE = 50;

export function boundImportCandidateGroups(
  groups: ReadonlyArray<ImportCandidateGroup>,
  requestedVisibleCount: number,
): {
  readonly groups: ReadonlyArray<ImportCandidateGroup>;
  readonly hiddenCandidateCount: number;
  readonly visibleCandidateCount: number;
} {
  const candidateCount = groups.reduce((total, group) => total + group.candidates.length, 0);
  const normalizedVisibleCount = Number.isFinite(requestedVisibleCount)
    ? Math.max(0, Math.floor(requestedVisibleCount))
    : 0;
  const visibleCandidateCount = Math.min(candidateCount, normalizedVisibleCount);
  let remaining = visibleCandidateCount;
  const visibleGroups = groups.flatMap((group) => {
    if (remaining === 0) {
      return [];
    }
    const candidates = group.candidates.slice(0, remaining);
    remaining -= candidates.length;
    return candidates.length === 0 ? [] : [{ ...group, candidates }];
  });

  return {
    groups: visibleGroups,
    hiddenCandidateCount: candidateCount - visibleCandidateCount,
    visibleCandidateCount,
  };
}

export function nextImportCandidateVisibleCount(
  visibleCandidateCount: number,
  candidateCount: number,
): number {
  return Math.min(candidateCount, visibleCandidateCount + IMPORT_CANDIDATE_PAGE_SIZE);
}

function candidateKey(candidate: ImportScanCandidate): string {
  return `${candidate.source}\u0000${candidate.sourcePath}`;
}

function candidateDomKey(candidate: ImportScanCandidate): string {
  return encodeURIComponent(candidateKey(candidate));
}

function candidateSourceLabel(candidate: ImportScanCandidate): string {
  return importSourceDisplayName(candidate.source);
}

function candidateDriverKind(candidate: ImportScanCandidate) {
  return importSourceDriverKind(candidate.source);
}

function candidateGroupPresentation(title: string): {
  readonly detail: string | null;
  readonly label: string;
} {
  const normalized = title.replaceAll("\\", "/").replace(/\/+$/, "");
  const isPath =
    normalized.startsWith("/") || normalized.startsWith("~/") || /^[a-z]:\//i.test(normalized);
  if (!isPath) {
    return { detail: null, label: title };
  }
  return {
    detail: title,
    label: normalized.split("/").at(-1) || title,
  };
}

function isImportTargetSelectable(entry: ProviderInstanceEntry | null): boolean {
  return Boolean(
    entry && entry.enabled && entry.installed && entry.isAvailable && entry.status !== "disabled",
  );
}

export function importRequestItemForCandidate(
  candidate: ImportScanCandidate,
  providerInstanceId: ProviderInstanceId | null,
): ImportSessionsRequest["items"][number] | null {
  if (
    providerInstanceId === null ||
    candidate.alreadyImportedArchived ||
    candidate.messageCount === 0
  ) {
    return null;
  }
  if (
    candidate.alreadyImportedThreadId !== null &&
    candidate.alreadyImportedProviderInstanceId !== null &&
    candidate.alreadyImportedProviderInstanceId !== providerInstanceId
  ) {
    return null;
  }
  return {
    source: candidate.source,
    sourcePath: candidate.sourcePath,
    providerInstanceId,
  };
}

export function resolveCandidateProviderSelection(
  candidate: ImportScanCandidate,
  providerEntries: ReadonlyArray<ProviderInstanceEntry>,
  explicitlySelectedInstanceId: ProviderInstanceId | null,
): CandidateProviderSelection {
  const expectedDriverKind = candidateDriverKind(candidate);
  const entryByInstanceId = new Map(
    providerEntries
      .filter((entry) => entry.driverKind === expectedDriverKind)
      .map((entry) => [entry.instanceId, entry]),
  );
  const importedOwnerInstanceId =
    candidate.alreadyImportedThreadId === null ? null : candidate.alreadyImportedProviderInstanceId;
  const compatibleInstanceIds =
    importedOwnerInstanceId === null
      ? [...new Set(candidate.providerInstanceIds)]
      : [importedOwnerInstanceId];
  const options = compatibleInstanceIds.map((instanceId) => {
    const entry = entryByInstanceId.get(instanceId) ?? null;
    return {
      entry,
      instanceId,
      selectable: isImportTargetSelectable(entry),
    };
  });
  const automaticInstanceId =
    compatibleInstanceIds.length === 1 && options[0]?.selectable ? compatibleInstanceIds[0]! : null;
  const explicitOption =
    explicitlySelectedInstanceId === null
      ? null
      : (options.find(
          (option) => option.instanceId === explicitlySelectedInstanceId && option.selectable,
        ) ?? null);
  const providerInstanceId = explicitOption?.instanceId ?? automaticInstanceId;

  if (compatibleInstanceIds.length === 0) {
    return {
      options,
      providerInstanceId: null,
      blockedReason: "No configured provider instance matches this session source.",
    };
  }
  if (!options.some((option) => option.selectable)) {
    return {
      options,
      providerInstanceId: null,
      blockedReason: "Compatible provider instances are missing, disabled, or unavailable.",
    };
  }
  return {
    options,
    providerInstanceId,
    blockedReason: null,
  };
}

function providerOptionLabel(option: CandidateProviderSelection["options"][number]): string {
  if (option.entry === null) {
    return `${option.instanceId} — Missing`;
  }
  if (!option.selectable) {
    return `${option.entry.displayName} — Unavailable`;
  }
  if (option.entry.status === "ready") {
    return option.entry.displayName;
  }
  return `${option.entry.displayName} — ${option.entry.status}`;
}

export function importSessionsAnnouncement(input: {
  readonly candidateCount: number;
  readonly hasScanned: boolean;
  readonly importError: string | null;
  readonly importResult: ImportSessionsResult | null;
  readonly importProgress?: ImportSessionProgress | null;
  readonly isImporting: boolean;
  readonly isScanning: boolean;
  readonly scanError: string | null;
  readonly scanTruncated: boolean;
}): string {
  if (input.importProgress?.phase === "stopping") {
    return `Stopping after the current batch. ${input.importProgress.completed} of ${input.importProgress.total} sessions processed.`;
  }
  if (input.importProgress?.phase === "cancelled") {
    return `Import stopped after ${input.importProgress.completed} of ${input.importProgress.total} sessions. ${input.importProgress.imported} imported, ${input.importProgress.skipped} skipped, ${input.importProgress.failed} failed.`;
  }
  if (input.isImporting) {
    return input.importProgress
      ? `Importing selected sessions. ${input.importProgress.completed} of ${input.importProgress.total} processed.`
      : "Importing selected sessions.";
  }
  if (input.importError) {
    return `Import failed: ${input.importError}`;
  }
  if (input.isScanning) {
    return "Scanning for local sessions.";
  }
  if (input.scanError) {
    const importPrefix = input.importResult
      ? `Import complete. ${input.importResult.imported.length} imported, ${input.importResult.skipped.length} skipped, ${input.importResult.failed.length} failed. `
      : "";
    return `${importPrefix}Scan failed: ${input.scanError}`;
  }
  if (input.importResult) {
    const imported = input.importResult.imported.length;
    const skipped = input.importResult.skipped.length;
    const failed = input.importResult.failed.length;
    return `Import complete. ${imported} imported, ${skipped} skipped, ${failed} failed.`;
  }
  if (!input.hasScanned) {
    return "Ready to scan for local sessions.";
  }
  const found = `${input.candidateCount} ${
    input.candidateCount === 1 ? "session" : "sessions"
  } found.`;
  return input.scanTruncated ? `${found} Results may be incomplete.` : found;
}

export function candidateMessageCountLabel(messageCount: number | null): string | null {
  return messageCount === null
    ? null
    : `${messageCount} ${messageCount === 1 ? "message" : "messages"}`;
}

function ImportOutcomeRows({
  environmentId,
  result,
}: {
  environmentId: EnvironmentId;
  result: ImportSessionsResult;
}) {
  return (
    <div className="space-y-1 rounded-xl border border-border/70 bg-muted/20 p-3">
      <div className="text-sm font-medium text-foreground">Import results</div>
      <div className="space-y-1.5 text-xs">
        {result.imported.map((item) => (
          <div key={`imported:${item.sourcePath}`} className="flex items-start gap-2 text-success">
            <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 wrap-break-word">
              Imported {item.messageCount} {item.messageCount === 1 ? "message" : "messages"} from{" "}
              {item.sourcePath}.{" "}
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: item.threadId }}
                className="font-medium underline underline-offset-2"
              >
                Open thread
              </Link>
              {item.continuation.state === "history-only" ? (
                <span className="mt-1 block text-warning">{item.continuation.reason}</span>
              ) : null}
            </span>
            <Badge
              variant={item.continuation.state === "verified" ? "success" : "warning"}
              size="sm"
              className="mt-px"
            >
              {item.continuation.state === "verified" ? "Resume verified" : "History only"}
            </Badge>
          </div>
        ))}
        {result.skipped.map((item) => (
          <div key={`skipped:${item.sourcePath}`} className="flex items-start gap-2 text-warning">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 wrap-break-word">
              Skipped {item.sourcePath}: {item.reason}
              {item.threadId ? (
                <>
                  {" "}
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: item.threadId }}
                    className="font-medium underline underline-offset-2"
                  >
                    Open thread
                  </Link>
                </>
              ) : null}
            </span>
          </div>
        ))}
        {result.failed.map((item) => (
          <div
            key={`failed:${item.sourcePath}`}
            className="flex items-start gap-2 text-destructive"
          >
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 wrap-break-word">
              Failed {item.sourcePath}: {item.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ImportSessionsPanel() {
  useRelativeTimeTick(60_000);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providerEntries = useMemo(
    () => deriveProviderInstanceEntries(serverProviders),
    [serverProviders],
  );
  const {
    environmentId,
    scanResult,
    scanError,
    isScanning,
    scan,
    importResult,
    importError,
    importProgress,
    isImporting,
    importSelected,
    cancelImport,
  } = useImportSessions();
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedProviderInstanceIds, setSelectedProviderInstanceIds] = useState<
    ReadonlyMap<string, ProviderInstanceId>
  >(() => new Map());
  const [repairingKey, setRepairingKey] = useState<string | null>(null);
  const [candidateWindow, setCandidateWindow] = useState<{
    readonly scanId: string | null;
    readonly visibleCount: number;
  }>(() => ({
    scanId: null,
    visibleCount: IMPORT_CANDIDATE_PAGE_SIZE,
  }));
  const checkboxIdPrefix = useId();

  useEffect(() => {
    setSelectedKeys(new Set());
    setSelectedProviderInstanceIds(new Map());
    setRepairingKey(null);
  }, [environmentId, scanError, scanResult]);

  const groupedCandidates = useMemo(() => {
    const groups = new Map<string, { title: string; candidates: ImportScanCandidate[] }>();

    for (const candidate of scanResult?.candidates ?? []) {
      const title = candidate.cwd ?? "No recorded directory";
      const key = candidate.cwd ? `cwd:${candidate.cwd}` : "cwd:none";
      const group = groups.get(key) ?? { title, candidates: [] };
      group.candidates.push(candidate);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
  }, [scanResult?.candidates]);
  const candidateCount = scanResult?.candidates.length ?? 0;
  const scanId = scanResult?.scannedAt ?? null;
  const requestedVisibleCandidateCount =
    candidateWindow.scanId === scanId ? candidateWindow.visibleCount : IMPORT_CANDIDATE_PAGE_SIZE;
  const visibleCandidateWindow = useMemo(
    () => boundImportCandidateGroups(groupedCandidates, requestedVisibleCandidateCount),
    [groupedCandidates, requestedVisibleCandidateCount],
  );

  const providerSelectionByCandidateKey = useMemo(() => {
    const selections = new Map<string, CandidateProviderSelection>();
    for (const candidate of scanResult?.candidates ?? []) {
      const key = candidateKey(candidate);
      selections.set(
        key,
        resolveCandidateProviderSelection(
          candidate,
          providerEntries,
          selectedProviderInstanceIds.get(key) ?? null,
        ),
      );
    }
    return selections;
  }, [providerEntries, scanResult?.candidates, selectedProviderInstanceIds]);

  useEffect(() => {
    setSelectedProviderInstanceIds((current) => {
      let next: Map<string, ProviderInstanceId> | null = null;
      for (const [key, providerInstanceId] of current) {
        if (providerSelectionByCandidateKey.get(key)?.providerInstanceId === providerInstanceId) {
          continue;
        }
        next ??= new Map(current);
        next.delete(key);
      }
      return next ?? current;
    });
    setSelectedKeys((current) => {
      let next: Set<string> | null = null;
      for (const key of current) {
        if ((providerSelectionByCandidateKey.get(key)?.providerInstanceId ?? null) !== null) {
          continue;
        }
        next ??= new Set(current);
        next.delete(key);
      }
      return next ?? current;
    });
  }, [providerSelectionByCandidateKey]);

  const importableCandidates = useMemo(() => {
    const candidates = scanResult?.candidates ?? [];
    return candidates.flatMap((candidate) => {
      const key = candidateKey(candidate);
      const providerInstanceId =
        providerSelectionByCandidateKey.get(key)?.providerInstanceId ?? null;
      return candidate.alreadyImportedThreadId === null &&
        candidate.messageCount !== 0 &&
        providerInstanceId !== null
        ? [{ candidate, providerInstanceId }]
        : [];
    });
  }, [providerSelectionByCandidateKey, scanResult?.candidates]);
  const selectedCandidates = useMemo(
    () => importableCandidates.filter(({ candidate }) => selectedKeys.has(candidateKey(candidate))),
    [importableCandidates, selectedKeys],
  );
  const resumableCandidateCount = useMemo(
    () => importableCandidates.filter(({ candidate }) => candidate.resumable).length,
    [importableCandidates],
  );
  const transcriptOnlyCandidateCount = importableCandidates.length - resumableCandidateCount;

  const toggleCandidate = useCallback((candidate: ImportScanCandidate, selected: boolean) => {
    const key = candidateKey(candidate);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const selectBulkCandidates = useCallback(
    (mode: BulkSelectionMode) => {
      setSelectedKeys(
        new Set(
          importableCandidates.flatMap(({ candidate }) => {
            const matches =
              mode === "all" ||
              (mode === "resumable" && candidate.resumable) ||
              (mode === "transcript-only" && !candidate.resumable);
            return matches ? [candidateKey(candidate)] : [];
          }),
        ),
      );
    },
    [importableCandidates],
  );

  const clearSelectedCandidates = useCallback(() => {
    setSelectedKeys(new Set());
  }, []);

  const selectProviderInstance = useCallback(
    (candidate: ImportScanCandidate, providerInstanceId: ProviderInstanceId) => {
      const key = candidateKey(candidate);
      setSelectedProviderInstanceIds((current) => {
        const next = new Map(current);
        next.set(key, providerInstanceId);
        return next;
      });
    },
    [],
  );

  const showMoreCandidates = useCallback(() => {
    setCandidateWindow((current) => {
      const visibleCount =
        current.scanId === scanId
          ? current.visibleCount
          : Math.min(candidateCount, IMPORT_CANDIDATE_PAGE_SIZE);
      return {
        scanId,
        visibleCount: nextImportCandidateVisibleCount(visibleCount, candidateCount),
      };
    });
  }, [candidateCount, scanId]);

  const handleImport = useCallback(async () => {
    setRepairingKey(null);
    const imported = await importSelected({
      items: selectedCandidates.flatMap(({ candidate, providerInstanceId }) => {
        const item = importRequestItemForCandidate(candidate, providerInstanceId);
        return item === null ? [] : [item];
      }),
    });
    if (imported !== null) {
      setSelectedKeys(new Set());
    }
  }, [importSelected, selectedCandidates]);

  const handleRepair = useCallback(
    async (candidate: ImportScanCandidate, providerInstanceId: ProviderInstanceId | null) => {
      const item = importRequestItemForCandidate(candidate, providerInstanceId);
      if (item === null) {
        return;
      }
      const key = candidateKey(candidate);
      setRepairingKey(key);
      try {
        const repaired = await importSelected({ items: [item] });
        if (repaired !== null && typeof document !== "undefined") {
          window.requestAnimationFrame(() => {
            const repairAction = document.querySelector<HTMLElement>(
              `[data-import-repair-key="${candidateDomKey(candidate)}"]`,
            );
            const scanAction = document.querySelector<HTMLElement>(
              '[data-import-scan-action="true"]',
            );
            (repairAction ?? scanAction)?.focus();
          });
        }
      } finally {
        setRepairingKey((current) => (current === key ? null : current));
      }
    },
    [importSelected],
  );

  const liveAnnouncement = importSessionsAnnouncement({
    candidateCount,
    hasScanned: scanResult !== null,
    importError,
    importProgress,
    importResult,
    isImporting,
    isScanning,
    scanError,
    scanTruncated: scanResult?.truncated ?? false,
  });
  const selectionAnnouncement =
    scanResult === null
      ? ""
      : `${selectedCandidates.length} of ${importableCandidates.length} importable ${
          importableCandidates.length === 1 ? "session" : "sessions"
        } selected.`;
  const showMoreCandidateCount = Math.min(
    IMPORT_CANDIDATE_PAGE_SIZE,
    visibleCandidateWindow.hiddenCandidateCount,
  );

  return (
    <SettingsPageContainer>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {selectionAnnouncement}
      </div>
      <SettingsSection
        title="Import sessions"
        icon={<DownloadIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={isScanning || isImporting || environmentId === null}
            data-import-scan-action="true"
            onClick={() => void scan()}
          >
            {isScanning ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            {isScanning ? "Scanning..." : scanResult === null ? "Scan" : "Rescan"}
          </Button>
        }
      >
        <SettingsRow
          title={
            isScanning && scanResult === null
              ? "Scanning for sessions"
              : scanError
                ? "Could not scan for sessions"
                : scanResult === null
                  ? "Scan local sessions"
                  : candidateCount === 0
                    ? "No sessions found"
                    : `${candidateCount} ${candidateCount === 1 ? "session" : "sessions"} found`
          }
          description={
            scanError ??
            (scanResult === null
              ? "Scanning reads local transcript stores and may briefly start configured Cursor or Grok provider processes."
              : candidateCount === 0
                ? scanResult.truncated
                  ? "No sessions were cataloged before one or more source limits were reached. Review the scan warnings and rescan."
                  : "Sessions from supported local agent providers will appear here."
                : scanResult.truncated
                  ? "Some sources stopped at a catalog, traversal, or time limit. You can import the sessions shown or review the scan warnings below."
                  : "Choose each transcript and the exact provider instance that should continue it.")
          }
          status={
            importProgress?.phase === "stopping" ? (
              `Stopping after the current batch · ${importProgress.completed} of ${importProgress.total} processed.`
            ) : importProgress?.phase === "cancelled" ? (
              `Stopped after ${importProgress.completed} of ${importProgress.total} sessions.`
            ) : isImporting && importProgress ? (
              `Importing · ${importProgress.completed} of ${importProgress.total} processed.`
            ) : isImporting ? (
              `Importing ${selectedCandidates.length} sessions.`
            ) : importError ? (
              importError
            ) : scanResult?.truncated ? (
              <span className="inline-flex items-center gap-1.5 text-warning" role="status">
                <CircleAlertIcon className="size-3.5" aria-hidden />
                Results may be incomplete
              </span>
            ) : null
          }
        />
        {scanResult !== null && candidateCount > 0 ? (
          <SettingsRow
            title="Bulk selection"
            description={`${selectedCandidates.length} of ${importableCandidates.length} importable ${
              importableCandidates.length === 1 ? "session" : "sessions"
            } selected. Bulk choices apply to every scan result, including rows not shown yet.`}
            control={
              <div
                className="flex flex-wrap items-center justify-start gap-2 sm:justify-end"
                role="group"
                aria-label="Bulk session selection"
              >
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={importableCandidates.length === 0 || isImporting || isScanning}
                  onClick={() => selectBulkCandidates("all")}
                >
                  Select all ({importableCandidates.length})
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={resumableCandidateCount === 0 || isImporting || isScanning}
                  onClick={() => selectBulkCandidates("resumable")}
                >
                  Resumable ({resumableCandidateCount})
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={transcriptOnlyCandidateCount === 0 || isImporting || isScanning}
                  onClick={() => selectBulkCandidates("transcript-only")}
                >
                  Transcript only ({transcriptOnlyCandidateCount})
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={selectedCandidates.length === 0 || isImporting || isScanning}
                  onClick={clearSelectedCandidates}
                >
                  Clear
                </Button>
              </div>
            }
          />
        ) : null}
      </SettingsSection>

      {visibleCandidateWindow.groups.map((group, groupIndex) => {
        const groupPresentation = candidateGroupPresentation(group.title);
        return (
          <SettingsSection
            key={group.key}
            title={groupPresentation.label}
            icon={<FolderIcon className="size-4 text-muted-foreground" />}
            className="space-y-2"
          >
            {groupPresentation.detail ? (
              <p
                className="truncate px-3 text-xs text-muted-foreground/70 sm:px-4"
                title={groupPresentation.detail}
              >
                {groupPresentation.detail}
              </p>
            ) : null}
            <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/10">
              <div className="hidden grid-cols-[minmax(0,1fr)_14rem] gap-4 border-b border-border/60 bg-muted/25 px-4 py-2 text-[11px] font-medium tracking-wide text-muted-foreground sm:grid">
                <span>Session</span>
                <span>Continue with</span>
              </div>
              <div className="divide-y divide-border/60" role="list">
                {group.candidates.map((candidate, candidateIndex) => {
                  const key = candidateKey(candidate);
                  const isImported = candidate.alreadyImportedThreadId !== null;
                  const sourceLabel = candidateSourceLabel(candidate);
                  const modifiedLabel = candidate.modifiedAt
                    ? formatRelativeTimeLabel(candidate.modifiedAt)
                    : "Modified time unavailable";
                  const providerSelection = providerSelectionByCandidateKey.get(key);
                  const providerInstanceId = providerSelection?.providerInstanceId ?? null;
                  const hasImportableMessages = candidate.messageCount !== 0;
                  const selectedProviderOption =
                    providerSelection?.options.find(
                      (option) => option.instanceId === providerInstanceId,
                    ) ?? null;
                  const canSelect =
                    !isImported && hasImportableMessages && providerInstanceId !== null;
                  const checkboxId = `${checkboxIdPrefix}-${groupIndex}-${candidateIndex}`;
                  const title = candidate.title ?? "Untitled session";
                  const messageCountLabel = candidateMessageCountLabel(candidate.messageCount);
                  const providerExplanation = !hasImportableMessages
                    ? "No messages to import."
                    : (providerSelection?.blockedReason ??
                      (providerSelection !== undefined &&
                      providerSelection.options.length > 1 &&
                      providerInstanceId === null
                        ? "Choose a provider instance before selecting this session."
                        : null));
                  const providerControl = !hasImportableMessages ? (
                    <span className="inline-flex min-h-11 items-center text-xs font-medium text-muted-foreground">
                      No messages
                    </span>
                  ) : providerSelection ? (
                    providerSelection.options.length > 1 &&
                    providerSelection.options.some((option) => option.selectable) ? (
                      <Select
                        value={providerInstanceId}
                        onValueChange={(value) => {
                          const option = providerSelection.options.find(
                            (candidateOption) =>
                              candidateOption.instanceId === value && candidateOption.selectable,
                          );
                          if (option) {
                            selectProviderInstance(candidate, option.instanceId);
                          }
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="min-h-11 w-full min-w-48 sm:w-full"
                          aria-label={`Provider instance for ${title}`}
                        >
                          <SelectValue placeholder="Choose provider instance">
                            {selectedProviderOption
                              ? providerOptionLabel(selectedProviderOption)
                              : undefined}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="end">
                          {providerSelection.options.map((option) => (
                            <SelectItem
                              key={option.instanceId}
                              value={option.instanceId}
                              disabled={!option.selectable}
                            >
                              {providerOptionLabel(option)}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : selectedProviderOption !== null ? (
                      <span className="inline-flex min-h-11 items-center text-xs font-medium text-muted-foreground">
                        <span className="mr-1 sm:hidden">Continue with</span>
                        {providerOptionLabel(selectedProviderOption)}
                      </span>
                    ) : (
                      <Button
                        render={<Link to="/settings/providers" />}
                        size="xs"
                        variant="outline"
                      >
                        Configure providers
                      </Button>
                    )
                  ) : null;

                  if (isImported) {
                    const isArchivedImport = candidate.alreadyImportedArchived;
                    return (
                      <SettingsRow
                        key={key}
                        role="listitem"
                        className="scroll-mb-20 rounded-none py-3 [&>div]:sm:grid-cols-[minmax(0,1fr)_14rem] [&>div]:sm:gap-4 [&>div>div:first-child]:pl-7"
                        title={
                          <span className="inline-flex min-w-0 items-start gap-2">
                            <ProviderInstanceIcon
                              driverKind={candidateDriverKind(candidate)}
                              displayName={sourceLabel}
                              iconClassName="mt-0.5 size-4"
                            />
                            <span className="min-w-0 wrap-break-word">{title}</span>
                          </span>
                        }
                        description={
                          <>
                            {sourceLabel} · {modifiedLabel}
                            {messageCountLabel === null ? null : ` · ${messageCountLabel}`} ·{" "}
                            {candidate.resumable ? "Resumable" : "Transcript only"}
                          </>
                        }
                        status={
                          environmentId !== null ? (
                            <span className="flex flex-col gap-1">
                              <span
                                className="block max-w-xl truncate font-mono text-[11px] text-muted-foreground/70"
                                title={candidate.sourcePath}
                              >
                                {candidate.sourcePath}
                              </span>
                              {isArchivedImport ? (
                                <Link
                                  to="/settings/archived"
                                  className="font-medium text-foreground underline underline-offset-2"
                                >
                                  Imported · View archived threads
                                </Link>
                              ) : (
                                <Link
                                  to="/$environmentId/$threadId"
                                  params={{
                                    environmentId,
                                    threadId: candidate.alreadyImportedThreadId!,
                                  }}
                                  className="font-medium text-foreground underline underline-offset-2"
                                >
                                  Imported · Open thread
                                </Link>
                              )}
                              {!isArchivedImport && providerExplanation ? (
                                <span className="text-warning">{providerExplanation}</span>
                              ) : null}
                            </span>
                          ) : (
                            <span
                              className="block max-w-xl truncate font-mono text-[11px] text-muted-foreground/70"
                              title={candidate.sourcePath}
                            >
                              {candidate.sourcePath}
                            </span>
                          )
                        }
                        control={
                          isArchivedImport ? (
                            <Button
                              render={<Link to="/settings/archived" />}
                              size="xs"
                              variant="outline"
                            >
                              View archived threads
                            </Button>
                          ) : (
                            <div className="flex w-full flex-col items-stretch gap-2 sm:items-start">
                              {providerControl}
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                disabled={
                                  providerInstanceId === null ||
                                  isImporting ||
                                  isScanning ||
                                  environmentId === null
                                }
                                aria-label={`Retry or reverify ${title}`}
                                data-import-repair-key={candidateDomKey(candidate)}
                                onClick={() => void handleRepair(candidate, providerInstanceId)}
                              >
                                {isImporting && repairingKey === key ? (
                                  <>
                                    <LoaderIcon className="size-3.5 animate-spin" />
                                    Repairing...
                                  </>
                                ) : (
                                  "Retry / reverify"
                                )}
                              </Button>
                            </div>
                          )
                        }
                      />
                    );
                  }

                  return (
                    <div
                      key={key}
                      role="listitem"
                      className="scroll-mb-20 px-3 py-2.5 transition-colors hover:bg-muted/20 sm:grid sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center sm:gap-4 sm:px-4"
                    >
                      <label
                        htmlFor={checkboxId}
                        className={cn(
                          "flex min-h-11 min-w-0 items-start gap-3 py-1.5 pr-2",
                          canSelect ? "cursor-pointer" : "cursor-not-allowed opacity-70",
                        )}
                      >
                        <Checkbox
                          id={checkboxId}
                          className="mt-0.5"
                          aria-labelledby={`${checkboxId}-title`}
                          aria-describedby={`${checkboxId}-description ${checkboxId}-path${
                            providerExplanation ? ` ${checkboxId}-provider` : ""
                          }`}
                          checked={canSelect && selectedKeys.has(key)}
                          disabled={!canSelect || isImporting}
                          onCheckedChange={(checked) =>
                            toggleCandidate(candidate, checked === true)
                          }
                        />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex min-w-0 items-start gap-2 text-sm font-medium tracking-[-0.005em] text-foreground">
                            <ProviderInstanceIcon
                              driverKind={candidateDriverKind(candidate)}
                              displayName={sourceLabel}
                              iconClassName="mt-px size-4"
                            />
                            <span id={`${checkboxId}-title`} className="min-w-0 wrap-break-word">
                              {title}
                            </span>
                          </span>
                          <span
                            id={`${checkboxId}-description`}
                            className="block text-[13px] leading-[1.45] text-muted-foreground/80"
                          >
                            {sourceLabel} · {modifiedLabel}
                            {messageCountLabel === null ? null : ` · ${messageCountLabel}`} ·{" "}
                            {candidate.resumable ? "Resumable" : "Transcript only"}
                          </span>
                          <span
                            id={`${checkboxId}-path`}
                            className="block truncate pt-0.5 font-mono text-[11px] text-muted-foreground/70"
                            title={candidate.sourcePath}
                          >
                            {candidate.sourcePath}
                          </span>
                          {providerExplanation ? (
                            <span
                              id={`${checkboxId}-provider`}
                              className={cn(
                                "block text-xs",
                                providerSelection?.blockedReason
                                  ? "text-warning"
                                  : "text-muted-foreground",
                              )}
                            >
                              {providerExplanation}
                            </span>
                          ) : null}
                        </span>
                      </label>
                      <div className="flex min-h-11 min-w-0 items-center sm:justify-start">
                        {providerControl}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </SettingsSection>
        );
      })}

      {scanResult && scanResult.errors.length > 0 ? (
        <details className="group rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Scan warnings ({scanResult.errors.length})
          </summary>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            {scanResult.errors.map((error) => (
              <div
                key={`${error.sourcePath ?? "unknown"}\u0000${error.message}`}
                className="wrap-break-word"
              >
                {error.sourcePath ? `${error.sourcePath}: ` : ""}
                {error.message}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {importResult && environmentId !== null ? (
        <ImportOutcomeRows environmentId={environmentId} result={importResult} />
      ) : null}

      {scanResult !== null && candidateCount > 0 ? (
        <div className="sticky bottom-0 z-20 -mx-1 flex flex-col gap-3 rounded-t-xl border border-b-0 border-border/70 bg-background/95 px-3 py-3 shadow-[0_-12px_30px_-20px_rgba(0,0,0,0.55)] backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
              Showing {visibleCandidateWindow.visibleCandidateCount} of {candidateCount}
            </span>
            {visibleCandidateWindow.hiddenCandidateCount > 0 ? (
              <Button type="button" size="xs" variant="outline" onClick={showMoreCandidates}>
                Show {showMoreCandidateCount} more
              </Button>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <span className="text-xs tabular-nums text-muted-foreground">
              {isImporting && importProgress
                ? `${importProgress.completed} of ${importProgress.total} processed`
                : `${selectedCandidates.length} selected`}
            </span>
            {isImporting ? (
              <Button
                type="button"
                variant="outline"
                disabled={importProgress?.phase === "stopping"}
                onClick={cancelImport}
              >
                {importProgress?.phase === "stopping" ? (
                  <>
                    <LoaderIcon className="size-3.5 animate-spin" />
                    Stopping...
                  </>
                ) : (
                  "Stop after batch"
                )}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={selectedCandidates.length === 0 || isScanning}
                onClick={() => void handleImport()}
              >
                {`Import selected (${selectedCandidates.length})`}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </SettingsPageContainer>
  );
}
