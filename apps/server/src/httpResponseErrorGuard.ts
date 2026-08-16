// apps/server/src/httpResponseErrorGuard.ts
// contains late Node HTTP response and upgrade write failures

// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from 'node:http'

// node turns an unobserved response or upgraded-socket error into a process crash.
export function guardHttpResponseWriteErrors<TServer extends NodeHttp.Server>(
  server: TServer,
  onError?: (error: unknown) => void,
): TServer
{
  server.on('request', (_request, response) =>
  {
    response.on('error', (error) => onError?.(error))
  })
  server.on('upgrade', (_request, socket) =>
  {
    socket.on('error', (error) => onError?.(error))
  })
  return server
}
