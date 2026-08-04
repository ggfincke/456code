// apps/web/src/hooks/useImportSessions.ts
// manages environment-scoped session import scans and guarded mutations
import {
  IMPORT_SESSIONS_MAX_ITEMS,
  type EnvironmentId,
  type ImportScanResult,
  type ImportSessionsRequest,
  type ImportSessionsResult,
} from '@t3tools/contracts'
import { squashAtomCommandFailure } from '@t3tools/client-runtime/state/runtime'
import { useCallback, useEffect, useRef, useState } from 'react'

import { orchestrationEnvironment } from '../state/orchestration'
import { usePrimaryEnvironmentId } from '../state/environments'
import { useAtomCommand } from '../state/use-atom-command'

// amortize catalog and reconciliation setup while staying within the server's
// bounded multi-session request contract
export const IMPORT_SESSIONS_CLIENT_BATCH_SIZE = IMPORT_SESSIONS_MAX_ITEMS

export interface ImportSessionProgress
{
  readonly phase: 'running' | 'stopping' | 'cancelled'
  readonly total: number
  readonly completed: number
  readonly imported: number
  readonly skipped: number
  readonly failed: number
}

function importErrorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string
{
  const squashed = squashAtomCommandFailure(result)
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : 'The environment request failed.'
}

type ScanState =
  | { readonly status: 'idle'; readonly environmentId: EnvironmentId | null }
  | {
      readonly status: 'loading'
      readonly environmentId: EnvironmentId
      readonly generation: number
    }
  | {
      readonly status: 'success'
      readonly environmentId: EnvironmentId
      readonly result: ImportScanResult
    }
  | {
      readonly status: 'error'
      readonly environmentId: EnvironmentId | null
      readonly message: string
    }

type ImportState =
  | { readonly status: 'idle'; readonly environmentId: EnvironmentId | null }
  | {
      readonly status: 'loading'
      readonly environmentId: EnvironmentId
      readonly generation: number
      readonly progress: ImportSessionProgress
    }
  | {
      readonly status: 'success'
      readonly environmentId: EnvironmentId
      readonly result: ImportSessionsResult
    }
  | {
      readonly status: 'cancelled'
      readonly environmentId: EnvironmentId
      readonly result: ImportSessionsResult
      readonly progress: ImportSessionProgress
    }
  | {
      readonly status: 'error'
      readonly environmentId: EnvironmentId
      readonly message: string
    }

export function useImportSessions()
{
  const environmentId = usePrimaryEnvironmentId()
  const runScan = useAtomCommand(orchestrationEnvironment.importScan, {
    reportFailure: false,
  })
  const runImport = useAtomCommand(orchestrationEnvironment.importSessions, {
    reportFailure: false,
  })
  const [scanState, setScanState] = useState<ScanState>(() => ({
    status: 'idle',
    environmentId,
  }))
  const [importState, setImportState] = useState<ImportState>(() => ({
    status: 'idle',
    environmentId,
  }))
  const scanGenerationRef = useRef(0)
  const importGenerationRef = useRef(0)
  const activeEnvironmentIdRef = useRef(environmentId)
  const activeImportGenerationRef = useRef<number | null>(null)
  const importCancellationRequestedRef = useRef(false)

  const scan = useCallback(
    async (options?: { readonly preserveImportState?: boolean }) =>
    {
      if (environmentId === null)
      {
        scanGenerationRef.current += 1
        setScanState({
          status: 'error',
          environmentId: null,
          message: 'Connect a primary environment before scanning for sessions.',
        })
        return null
      }

      const generation = ++scanGenerationRef.current
      const requestedEnvironmentId = environmentId
      if (options?.preserveImportState !== true)
      {
        setImportState({ status: 'idle', environmentId: requestedEnvironmentId })
      }
      setScanState({
        status: 'loading',
        environmentId: requestedEnvironmentId,
        generation,
      })
      const result = await runScan({ environmentId, input: {} })
      if (
        generation !== scanGenerationRef.current ||
        activeEnvironmentIdRef.current !== requestedEnvironmentId
      )
      {
        return null
      }
      if (result._tag === 'Failure')
      {
        setScanState({
          status: 'error',
          environmentId: requestedEnvironmentId,
          message: importErrorMessage(result),
        })
        return null
      }
      setScanState({
        status: 'success',
        environmentId: requestedEnvironmentId,
        result: result.value,
      })
      return result.value
    },
    [environmentId, runScan],
  )

  useEffect(() =>
  {
    const environmentChanged = activeEnvironmentIdRef.current !== environmentId
    if (environmentChanged)
    {
      activeEnvironmentIdRef.current = environmentId
      scanGenerationRef.current += 1
      importGenerationRef.current += 1
      activeImportGenerationRef.current = null
      importCancellationRequestedRef.current = true
      setScanState({ status: 'idle', environmentId })
      setImportState({ status: 'idle', environmentId })
    }

    if (environmentId === null)
    {
      setScanState({
        status: 'error',
        environmentId: null,
        message: 'Connect a primary environment before scanning for sessions.',
      })
    }
  }, [environmentId])

  useEffect(
    () => () =>
    {
      importGenerationRef.current += 1
      activeImportGenerationRef.current = null
      importCancellationRequestedRef.current = true
    },
    [],
  )

  const importSelected = useCallback(
    async (request: ImportSessionsRequest) =>
    {
      if (
        environmentId === null ||
        request.items.length === 0 ||
        activeImportGenerationRef.current !== null
      )
      {
        return null
      }
      const generation = ++importGenerationRef.current
      const requestedEnvironmentId = environmentId
      activeImportGenerationRef.current = generation
      importCancellationRequestedRef.current = false
      setImportState({
        status: 'loading',
        environmentId: requestedEnvironmentId,
        generation,
        progress: {
          phase: 'running',
          total: request.items.length,
          completed: 0,
          imported: 0,
          skipped: 0,
          failed: 0,
        },
      })
      const imported: ImportSessionsResult['imported'][number][] = []
      const skipped: ImportSessionsResult['skipped'][number][] = []
      const failed: ImportSessionsResult['failed'][number][] = []

      for (
        let index = 0;
        index < request.items.length;
        index += IMPORT_SESSIONS_CLIENT_BATCH_SIZE
      )
      {
        const batchItems = request.items.slice(index, index + IMPORT_SESSIONS_CLIENT_BATCH_SIZE)
        const result = await runImport({
          environmentId,
          input: {
            items: batchItems,
          },
        })
        if (
          generation !== importGenerationRef.current ||
          activeEnvironmentIdRef.current !== requestedEnvironmentId
        )
        {
          // a newer import may already own the active-generation guard; only
          // release it if it still belongs to this stale request
          if (activeImportGenerationRef.current === generation)
          {
            activeImportGenerationRef.current = null
          }
          return null
        }
        if (result._tag === 'Failure')
        {
          activeImportGenerationRef.current = null
          setImportState({
            status: 'error',
            environmentId: requestedEnvironmentId,
            message: importErrorMessage(result),
          })
          await scan({ preserveImportState: true })
          return null
        }

        imported.push(...result.value.imported)
        skipped.push(...result.value.skipped)
        failed.push(...result.value.failed)
        const completed = Math.min(index + batchItems.length, request.items.length)
        const aggregateResult: ImportSessionsResult = {
          imported,
          skipped,
          failed,
        }
        const progress: ImportSessionProgress = {
          phase: importCancellationRequestedRef.current ? 'stopping' : 'running',
          total: request.items.length,
          completed,
          imported: imported.length,
          skipped: skipped.length,
          failed: failed.length,
        }
        if (completed < request.items.length && importCancellationRequestedRef.current)
        {
          activeImportGenerationRef.current = null
          setImportState({
            status: 'cancelled',
            environmentId: requestedEnvironmentId,
            result: aggregateResult,
            progress: {
              ...progress,
              phase: 'cancelled',
            },
          })
          await scan({ preserveImportState: true })
          return null
        }
        if (completed < request.items.length)
        {
          setImportState({
            status: 'loading',
            environmentId: requestedEnvironmentId,
            generation,
            progress,
          })
        }
      }

      const aggregateResult: ImportSessionsResult = {
        imported,
        skipped,
        failed,
      }
      activeImportGenerationRef.current = null
      setImportState({
        status: 'success',
        environmentId: requestedEnvironmentId,
        result: aggregateResult,
      })
      await scan({ preserveImportState: true })
      if (
        generation !== importGenerationRef.current ||
        activeEnvironmentIdRef.current !== requestedEnvironmentId
      )
      {
        return null
      }
      return aggregateResult
    },
    [environmentId, runImport, scan],
  )

  const cancelImport = useCallback(() =>
  {
    const activeGeneration = activeImportGenerationRef.current
    if (activeGeneration === null)
    {
      return
    }
    importCancellationRequestedRef.current = true
    setImportState((current) =>
      current.status === 'loading' && current.generation === activeGeneration
        ? {
            ...current,
            progress: {
              ...current.progress,
              phase: 'stopping',
            },
          }
        : current,
    )
  }, [])

  const scanIsCurrent = scanState.environmentId === environmentId
  const importIsCurrent = importState.environmentId === environmentId
  const scanResult = scanIsCurrent && scanState.status === 'success' ? scanState.result : null
  const scanError = scanIsCurrent && scanState.status === 'error' ? scanState.message : null
  const importResult =
    importIsCurrent && (importState.status === 'success' || importState.status === 'cancelled')
      ? importState.result
      : null
  const importError = importIsCurrent && importState.status === 'error' ? importState.message : null
  const importProgress =
    importIsCurrent && (importState.status === 'loading' || importState.status === 'cancelled')
      ? importState.progress
      : null

  return {
    environmentId,
    scanResult,
    scanError,
    isScanning: scanIsCurrent && scanState.status === 'loading',
    scan,
    importResult,
    importError,
    importProgress,
    isImporting: importIsCurrent && importState.status === 'loading',
    importSelected,
    cancelImport,
  }
}
