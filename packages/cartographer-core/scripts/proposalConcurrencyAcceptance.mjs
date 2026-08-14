// packages/cartographer-core/scripts/proposalConcurrencyAcceptance.mjs
// proves process-concurrent proposal creation preserves every complete plan

import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'

const workers = 24
const scriptPath = NodeURL.fileURLToPath(import.meta.url)

async function runWorker(root, index)
{
  const { savePatch } = await import('../dist/store/patches.js')
  process.send({ kind: 'ready' })
  process.on('message', (message) =>
  {
    if (message !== 'save')
    {
      return
    }
    try
    {
      const saved = savePatch(root, {
        version: 1,
        meta: {
          name: 'Concurrent proposal',
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        },
        ops: [{ op: 'add_file', path: `src/process-${index}.ts` }],
      })
      process.send({ kind: 'saved', index, saved }, () => process.exit(0))
    }
    catch (error)
    {
      process.send(
        {
          kind: 'error',
          message: error instanceof Error ? error.stack : String(error),
        },
        () => process.exit(1),
      )
    }
  })
}

function spawnWorker(root, index)
{
  return new Promise((resolvePromise, reject) =>
  {
    const child = NodeChildProcess.fork(scriptPath, ['--worker', root, String(index)], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    let ready = false
    let settled = false
    child.on('message', (message) =>
    {
      if (message?.kind === 'ready')
      {
        ready = true
        resolvePromise({ child, result: resultPromise })
        return
      }
      if (message?.kind === 'saved')
      {
        settled = true
        resolveResult(message)
      }
      if (message?.kind === 'error')
      {
        settled = true
        rejectResult(new Error(message.message))
      }
    })
    child.on('error', reject)
    child.on('exit', (code) =>
    {
      if (!ready)
      {
        reject(new Error(`proposal worker ${index} exited before ready`))
      }
      if (!settled && code !== null)
      {
        rejectResult(new Error(`proposal worker ${index} exited ${code}`))
      }
    })

    let resolveResult
    let rejectResult
    const resultPromise = new Promise((resolve, rejectResultPromise) =>
    {
      resolveResult = resolve
      rejectResult = rejectResultPromise
    })
  })
}

async function runAcceptance()
{
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'cartographer-proposals-'))
  try
  {
    const ready = await Promise.all(
      Array.from({ length: workers }, (_, index) => spawnWorker(root, index)),
    )
    for (const { child } of ready)
    {
      child.send('save')
    }
    const results = await Promise.all(ready.map(({ result }) => result))
    const ids = new Set(results.map(({ saved }) => saved.id))
    if (ids.size !== workers)
    {
      throw new Error(`expected ${workers} distinct ids, received ${ids.size}`)
    }

    const { loadPatch } = await import('../dist/store/patches.js')
    for (const { index, saved } of results)
    {
      const loaded = loadPatch(root, saved.id)
      const expectedPath = `src/process-${index}.ts`
      if (loaded.ops[0]?.op !== 'add_file' || loaded.ops[0].path !== expectedPath)
      {
        throw new Error(`${saved.id} did not preserve ${expectedPath}`)
      }
    }
    const leftovers = NodeFS.readdirSync(NodePath.join(root, '.cartographer', 'patches')).filter(
      (name) => name.endsWith('.tmp'),
    )
    if (leftovers.length > 0)
    {
      throw new Error(`exclusive publication left temp files: ${leftovers}`)
    }
    console.log(`proposal concurrency acceptance passed (${workers} processes)`)
  }
  finally
  {
    NodeFS.rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--worker')
{
  await runWorker(process.argv[3], Number(process.argv[4]))
}
else
{
  await runAcceptance()
}
