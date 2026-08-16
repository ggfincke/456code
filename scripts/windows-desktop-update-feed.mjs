// scripts/windows-desktop-update-feed.mjs
// serve a range-capable local Electron update feed with request evidence

import { createReadStream } from 'node:fs'
import { appendFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'

function readArgument(name)
{
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const root = await realpath(readArgument('--root') ?? '')
const logPath = resolve(readArgument('--log') ?? '')
const port = Number(readArgument('--port') ?? '')
if (!Number.isInteger(port) || port < 1 || port > 65_535)
{
  throw new Error('A valid --port is required')
}

async function logRequest(entry)
{
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

function resolveRequestPath(requestUrl)
{
  const pathname = decodeURIComponent(new URL(requestUrl, `http://127.0.0.1:${port}`).pathname)
  const filePath = resolve(root, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`)
  const relativePath = relative(root, filePath)
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith('/')
  )
  {
    return undefined
  }
  return filePath
}

function parseRange(value, size)
{
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[2] && match[1] ? Math.min(size - 1, Number(match[2])) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end)
  {
    return null
  }
  return { start, end }
}

const server = createServer(async (request, response) =>
{
  const requestPath = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname
  const rangeHeader = typeof request.headers.range === 'string' ? request.headers.range : undefined
  try
  {
    const filePath = resolveRequestPath(request.url ?? '/')
    const info = filePath ? await stat(filePath).catch(() => undefined) : undefined
    if (!filePath || !info?.isFile())
    {
      response.writeHead(404, { 'Cache-Control': 'no-store' })
      response.end('Not Found')
      await logRequest({
        method: request.method,
        path: requestPath,
        range: rangeHeader,
        status: 404,
      })
      return
    }

    const range = parseRange(rangeHeader, info.size)
    if (range === null)
    {
      response.writeHead(416, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${String(info.size)}`,
        'Cache-Control': 'no-store',
      })
      response.end()
      await logRequest({
        method: request.method,
        path: requestPath,
        range: rangeHeader,
        status: 416,
      })
      return
    }

    const status = range ? 206 : 200
    const start = range?.start ?? 0
    const end = range?.end ?? info.size - 1
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(Math.max(0, end - start + 1)),
      'Content-Type': ['.yml', '.yaml'].includes(extname(filePath))
        ? 'text/yaml; charset=utf-8'
        : 'application/octet-stream',
      ...(range
        ? { 'Content-Range': `bytes ${String(start)}-${String(end)}/${String(info.size)}` }
        : {}),
    }
    response.writeHead(status, headers)
    if (request.method === 'HEAD' || info.size === 0)
    {
      response.end()
    }
    else
    {
      createReadStream(filePath, { start, end }).pipe(response)
    }
    await logRequest({
      method: request.method,
      path: requestPath,
      range: rangeHeader,
      status,
      bytes: Math.max(0, end - start + 1),
    })
  }
  catch (error)
  {
    response.writeHead(500, { 'Cache-Control': 'no-store' })
    response.end('Internal Server Error')
    await logRequest({
      method: request.method,
      path: requestPath,
      range: rangeHeader,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

await new Promise((resolveListen, rejectListen) =>
{
  server.once('error', rejectListen)
  server.listen(port, 'localhost', resolveListen)
})
console.log(`READY http://localhost:${String(port)}`)

const close = () => server.close(() => process.exit(0))
process.once('SIGINT', close)
process.once('SIGTERM', close)
