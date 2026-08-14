// packages/cartographer-core/src/cli/commands/watch.ts
// rebuild graph on scope file changes

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { diffGraphs, formatDiffSummary } from '../../analyze/index.js'
import { runBuildPipeline } from '../../store/pipeline.js'
import { graphBuildOptions, type CliValues } from '../lib/args.js'
import { logSummary, warnUnignoredArtifacts, writeArtifacts } from '../lib/artifacts.js'

const WATCH_DEBOUNCE_MS = 300
const WATCH_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/

export const runWatch = async (root: string, values: CliValues): Promise<void> =>
{
  let timer: NodeJS.Timeout | undefined
  let watcher: NodeFS.FSWatcher | undefined
  let stopping = false
  let cleaned = false
  let watchInputsClosed = false
  let initialRunning = true
  let dirty = false
  let runningTask: Promise<void> | undefined
  let stopSettled = false
  let resolveStopped: () => void
  const stopped = new Promise<void>((resolvePromise) =>
  {
    resolveStopped = resolvePromise
  })

  const closeWatchInputs = (): void =>
  {
    if (watchInputsClosed)
    {
      return
    }
    watchInputsClosed = true
    dirty = false
    if (timer)
    {
      clearTimeout(timer)
      timer = undefined
    }
    watcher?.close()
    watcher = undefined
  }
  const cleanup = (): void =>
  {
    if (cleaned)
    {
      return
    }
    cleaned = true
    stopping = true
    closeWatchInputs()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
  const settleStop = (): void =>
  {
    if (stopSettled)
    {
      return
    }
    stopSettled = true
    cleanup()
    resolveStopped()
  }
  const stop = (): void =>
  {
    if (stopping)
    {
      return
    }
    stopping = true
    closeWatchInputs()
    if (!initialRunning && !runningTask)
    {
      settleStop()
    }
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  try
  {
    // no snapshot on watch builds -> debounced rebuilds would spam graph.db history
    const initial = await runBuildPipeline({
      ...graphBuildOptions(root, values),
      ...(values.out === undefined ? {} : { outDir: values.out }),
    })
    initialRunning = false
    if (stopping)
    {
      settleStop()
      return
    }
    let previous = initial.graph
    await writeArtifacts(previous, root, values)
    logSummary(previous)
    warnUnignoredArtifacts(root, values.out)
    console.log(`watching ${NodePath.resolve(root, previous.scope)} ...`)

    const rebuild = async (): Promise<void> =>
    {
      try
      {
        const { graph: next } = await runBuildPipeline({
          ...graphBuildOptions(root, values),
          ...(values.out === undefined ? {} : { outDir: values.out }),
        })
        const diff = diffGraphs(previous, next)
        previous = next
        // publish the optional report before the next run may start (F10)
        writeArtifacts(next, root, values)
        const stamp = new Date().toLocaleTimeString()
        console.log(`[${stamp}] ${formatDiffSummary(diff)}`)
      }
      catch (err)
      {
        console.error(`rebuild failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    // single-flight: one rebuild -> diff -> publish at a time; events during a
    // run set a dirty flag & completion launches exactly one latest rerun
    const runScheduledBuilds = async (): Promise<void> =>
    {
      do
      {
        dirty = false
        if (stopping)
        {
          return
        }
        await rebuild()
      } while (dirty && !stopping)
    }
    const scheduleRebuild = (): void =>
    {
      if (stopping)
      {
        return
      }
      if (runningTask)
      {
        dirty = true
        return
      }
      const task = Promise.resolve().then(runScheduledBuilds)
      runningTask = task
      const complete = (): void =>
      {
        if (runningTask === task)
        {
          runningTask = undefined
        }
        if (stopping)
        {
          settleStop()
        }
      }
      void task.then(complete, complete)
    }

    watcher = NodeFS.watch(
      NodePath.resolve(root, previous.scope),
      { recursive: true },
      (_event, filename) =>
      {
        if (stopping || !filename || !WATCH_EXTENSIONS.test(filename))
        {
          return
        }
        if (timer)
        {
          clearTimeout(timer)
        }
        timer = setTimeout(() =>
        {
          timer = undefined
          if (!stopping)
          {
            scheduleRebuild()
          }
        }, WATCH_DEBOUNCE_MS)
      },
    )

    await stopped
  }
  finally
  {
    cleanup()
  }
}
