// apps/server/src/startupAccess.ts
// issue headless serve access info

import { QrCode } from '@t3tools/shared/qrCode'
import * as Effect from 'effect/Effect'
import { HttpServer } from 'effect/unstable/http'

import { ServerConfig } from './config.ts'
import * as EnvironmentAuth from './auth/EnvironmentAuth.ts'
import {
  buildPairingUrl,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from './environment/accessHost.ts'

export {
  buildPairingUrl,
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  resolveHeadlessConnectionHost,
  resolveHeadlessConnectionString,
  resolveListeningPort,
} from './environment/accessHost.ts'

export interface HeadlessServeAccessInfo
{
  readonly connectionString: string
  readonly token: string
  readonly pairingUrl: string
}

export const renderTerminalQrCode = (value: string, margin = 2): string =>
{
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM)
  const rows: Array<string> = []
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && x < qrCode.size && y >= 0 && y < qrCode.size && qrCode.getModule(x, y)

  for (let y = -margin; y < qrCode.size + margin; y += 2)
  {
    let row = ''

    for (let x = -margin; x < qrCode.size + margin; x += 1)
    {
      const topDark = isDark(x, y)
      const bottomDark = isDark(x, y + 1)

      row += topDark ? (bottomDark ? '█' : '▀') : bottomDark ? '▄' : ' '
    }

    rows.push(row)
  }

  return rows.join('\n')
}

export const formatHeadlessServeOutput = (accessInfo: HeadlessServeAccessInfo): string =>
  [
    '456code server is ready.',
    `Connection string: ${accessInfo.connectionString}`,
    `Token: ${accessInfo.token}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    '',
    renderTerminalQrCode(accessInfo.pairingUrl),
    '',
  ].join('\n')

export const issueHeadlessServeAccessInfo = Effect.fn('issueHeadlessServeAccessInfo')(function* ()
{
  const serverConfig = yield* ServerConfig
  const httpServer = yield* HttpServer.HttpServer
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth
  const connectionString = resolveHeadlessConnectionString(
    serverConfig.host,
    resolveListeningPort(httpServer.address, serverConfig.port),
  )
  const issued = yield* serverAuth.issueStartupPairingCredential()

  return {
    connectionString,
    token: issued.credential,
    pairingUrl: buildPairingUrl(connectionString, issued.credential),
  } satisfies HeadlessServeAccessInfo
})
