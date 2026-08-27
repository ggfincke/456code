// apps/server/src/entrypoint.ts
// detect whether an ESM module owns the current process entrypoint

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from 'node:fs'
import * as NodeURL from 'node:url'

export const isEntrypoint = (input: {
  readonly moduleUrl: string
  readonly entryPath: string | undefined
  readonly runtimeMain: boolean | undefined
}): boolean =>
{
  if (input.runtimeMain !== undefined)
  {
    return input.runtimeMain
  }
  if (!input.entryPath)
  {
    return false
  }
  if (input.moduleUrl === NodeURL.pathToFileURL(input.entryPath).href)
  {
    return true
  }

  // npm and npx retain the link in argv while ESM resolves the module to its real path
  try
  {
    const modulePath = NodeURL.fileURLToPath(input.moduleUrl)
    return NodeFS.realpathSync(modulePath) === NodeFS.realpathSync(input.entryPath)
  }
  catch
  {
    return false
  }
}
