// tests/apps/server/httpResponseErrorGuard.test.ts
// verifies late Node HTTP write failures stay scoped to their client

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from 'node:http'
import * as NodeNet from 'node:net'

import { afterEach, describe, expect, it } from 'vite-plus/test'

import { guardHttpResponseWriteErrors } from '../../../apps/server/src/httpResponseErrorGuard.ts'

const servers: Array<NodeHttp.Server> = []

function listen(server: NodeHttp.Server): Promise<number>
{
  servers.push(server)
  return new Promise((resolve) =>
  {
    server.listen(0, '127.0.0.1', () =>
    {
      resolve((server.address() as NodeNet.AddressInfo).port)
    })
  })
}

function fetchStatus(port: number): Promise<number>
{
  return new Promise((resolve, reject) =>
  {
    const request = NodeHttp.get({ host: '127.0.0.1', port }, (response) =>
    {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.setTimeout(5_000, () => reject(new Error('request timed out')))
  })
}

afterEach(async () =>
{
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
        {
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

describe('guardHttpResponseWriteErrors', () =>
{
  it('contains an upgrade socket write failure and keeps serving', async () =>
  {
    const writeErrors: Array<unknown> = []
    const failureObserved = Promise.withResolvers<void>()
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) =>
    {
      writeErrors.push(error)
      failureObserved.resolve()
    })

    server.on('upgrade', (_request, socket) =>
    {
      socket.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    })
    const port = await listen(server)

    const client = NodeNet.connect(port, '127.0.0.1', () =>
    {
      client.write(
        [
          'GET /rpc HTTP/1.1',
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })
    client.on('error', () =>
    {})

    await failureObserved.promise
    client.destroy()
    expect(writeErrors).toHaveLength(1)
    expect((writeErrors[0] as NodeJS.ErrnoException).code).toBe('EPIPE')

    server.on('request', (_request, response) =>
    {
      response.writeHead(200)
      response.end('ok')
    })
    await expect(fetchStatus(port)).resolves.toBe(200)
  })

  it('observes response errors without disturbing normal traffic', async () =>
  {
    const writeErrors: Array<unknown> = []
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) =>
    {
      writeErrors.push(error)
    })
    server.on('request', (_request, response) =>
    {
      response.emit('error', Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' }))
      response.writeHead(204)
      response.end()
    })
    const port = await listen(server)

    await expect(fetchStatus(port)).resolves.toBe(204)
    expect(writeErrors).toHaveLength(1)
    expect((writeErrors[0] as NodeJS.ErrnoException).code).toBe('ECONNRESET')
  })
})
