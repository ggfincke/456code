// packages/client-runtime/src/operations/importSessions.ts
// sends session import scan and mutation requests through the environment rpc client
import { ORCHESTRATION_WS_METHODS, type ImportSessionsRequest } from '@t3tools/contracts'

import { request } from '../rpc/client.ts'

export function importScan()
{
  return request(ORCHESTRATION_WS_METHODS.importScan, {})
}

export function importSessions(input: ImportSessionsRequest)
{
  return request(ORCHESTRATION_WS_METHODS.importSessions, input)
}
