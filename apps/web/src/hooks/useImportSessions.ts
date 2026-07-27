// apps/web/src/hooks/useImportSessions.ts
// manages environment-scoped session import scans and guarded mutations
import {
  IMPORT_SESSIONS_MAX_ITEMS,
  type EnvironmentId,
  type ImportScanResult,
  type ImportSessionsRequest,
  type ImportSessionsResult,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

function importErrorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const squashed = squashAtomCommandFailure(result);
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : "The environment request failed.";
}

type ScanState =
  | { readonly status: "idle"; readonly environmentId: EnvironmentId | null }
  | {
      readonly status: "loading";
      readonly environmentId: EnvironmentId;
      readonly generation: number;
    }
  | {
      readonly status: "success";
      readonly environmentId: EnvironmentId;
      readonly result: ImportScanResult;
    }
  | {
      readonly status: "error";
      readonly environmentId: EnvironmentId | null;
      readonly message: string;
    };

type ImportState =
  | { readonly status: "idle"; readonly environmentId: EnvironmentId | null }
  | {
      readonly status: "loading";
      readonly environmentId: EnvironmentId;
      readonly generation: number;
    }
  | {
      readonly status: "success";
      readonly environmentId: EnvironmentId;
      readonly result: ImportSessionsResult;
    }
  | {
      readonly status: "error";
      readonly environmentId: EnvironmentId;
      readonly message: string;
    };

export function useImportSessions() {
  const environmentId = usePrimaryEnvironmentId();
  const runScan = useAtomCommand(orchestrationEnvironment.importScan, {
    reportFailure: false,
  });
  const runImport = useAtomCommand(orchestrationEnvironment.importSessions, {
    reportFailure: false,
  });
  const [scanState, setScanState] = useState<ScanState>(() => ({
    status: "idle",
    environmentId,
  }));
  const [importState, setImportState] = useState<ImportState>(() => ({
    status: "idle",
    environmentId,
  }));
  const scanGenerationRef = useRef(0);
  const importGenerationRef = useRef(0);
  const activeEnvironmentIdRef = useRef(environmentId);

  const scan = useCallback(
    async (options?: { readonly preserveImportState?: boolean }) => {
      if (environmentId === null) {
        scanGenerationRef.current += 1;
        setScanState({
          status: "error",
          environmentId: null,
          message: "Connect a primary environment before scanning for sessions.",
        });
        return null;
      }

      const generation = ++scanGenerationRef.current;
      const requestedEnvironmentId = environmentId;
      if (options?.preserveImportState !== true) {
        setImportState({ status: "idle", environmentId: requestedEnvironmentId });
      }
      setScanState({
        status: "loading",
        environmentId: requestedEnvironmentId,
        generation,
      });
      const result = await runScan({ environmentId, input: {} });
      if (
        generation !== scanGenerationRef.current ||
        activeEnvironmentIdRef.current !== requestedEnvironmentId
      ) {
        return null;
      }
      if (result._tag === "Failure") {
        setScanState({
          status: "error",
          environmentId: requestedEnvironmentId,
          message: importErrorMessage(result),
        });
        return null;
      }
      setScanState({
        status: "success",
        environmentId: requestedEnvironmentId,
        result: result.value,
      });
      return result.value;
    },
    [environmentId, runScan],
  );

  useEffect(() => {
    const environmentChanged = activeEnvironmentIdRef.current !== environmentId;
    if (environmentChanged) {
      activeEnvironmentIdRef.current = environmentId;
      scanGenerationRef.current += 1;
      importGenerationRef.current += 1;
      setScanState({ status: "idle", environmentId });
      setImportState({ status: "idle", environmentId });
    }

    if (environmentId === null) {
      setScanState({
        status: "error",
        environmentId: null,
        message: "Connect a primary environment before scanning for sessions.",
      });
    }
  }, [environmentId]);

  const importSelected = useCallback(
    async (request: ImportSessionsRequest) => {
      if (environmentId === null || request.items.length === 0) {
        return null;
      }
      const generation = ++importGenerationRef.current;
      const requestedEnvironmentId = environmentId;
      setImportState({
        status: "loading",
        environmentId: requestedEnvironmentId,
        generation,
      });
      const imported: ImportSessionsResult["imported"][number][] = [];
      const skipped: ImportSessionsResult["skipped"][number][] = [];
      const failed: ImportSessionsResult["failed"][number][] = [];
      let completedBatchCount = 0;

      for (let index = 0; index < request.items.length; index += IMPORT_SESSIONS_MAX_ITEMS) {
        const result = await runImport({
          environmentId,
          input: {
            items: request.items.slice(index, index + IMPORT_SESSIONS_MAX_ITEMS),
          },
        });
        if (
          generation !== importGenerationRef.current ||
          activeEnvironmentIdRef.current !== requestedEnvironmentId
        ) {
          return null;
        }
        if (result._tag === "Failure") {
          setImportState({
            status: "error",
            environmentId: requestedEnvironmentId,
            message: importErrorMessage(result),
          });
          if (completedBatchCount > 0) {
            await scan({ preserveImportState: true });
          }
          return null;
        }

        imported.push(...result.value.imported);
        skipped.push(...result.value.skipped);
        failed.push(...result.value.failed);
        completedBatchCount += 1;
      }

      const aggregateResult: ImportSessionsResult = {
        imported,
        skipped,
        failed,
      };
      setImportState({
        status: "success",
        environmentId: requestedEnvironmentId,
        result: aggregateResult,
      });
      await scan({ preserveImportState: true });
      if (
        generation !== importGenerationRef.current ||
        activeEnvironmentIdRef.current !== requestedEnvironmentId
      ) {
        return null;
      }
      return aggregateResult;
    },
    [environmentId, runImport, scan],
  );

  const scanIsCurrent = scanState.environmentId === environmentId;
  const importIsCurrent = importState.environmentId === environmentId;
  const scanResult = scanIsCurrent && scanState.status === "success" ? scanState.result : null;
  const scanError = scanIsCurrent && scanState.status === "error" ? scanState.message : null;
  const importResult =
    importIsCurrent && importState.status === "success" ? importState.result : null;
  const importError =
    importIsCurrent && importState.status === "error" ? importState.message : null;

  return {
    environmentId,
    scanResult,
    scanError,
    isScanning: scanIsCurrent && scanState.status === "loading",
    scan,
    importResult,
    importError,
    isImporting: importIsCurrent && importState.status === "loading",
    importSelected,
  };
}
