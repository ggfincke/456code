// apps/web/src/environments/primary/desktopAuth.ts
// handle web authentication

let desktopBearerTokenPromise: Promise<string> | null = null
let desktopAuthGeneration = 0

export function readDesktopPrimaryBearerToken(): Promise<string | null>
{
  if (typeof window === 'undefined')
  {
    return Promise.resolve(null)
  }
  const bridge = window.desktopBridge
  if (!bridge)
  {
    return Promise.resolve(null)
  }

  if (desktopBearerTokenPromise !== null)
  {
    return desktopBearerTokenPromise
  }

  const generation = desktopAuthGeneration
  const promise = bridge.getLocalEnvironmentBearerToken()
  desktopBearerTokenPromise = promise
  const clearSettledPromise = () =>
  {
    if (desktopAuthGeneration === generation && desktopBearerTokenPromise === promise)
    {
      desktopBearerTokenPromise = null
    }
  }
  void promise.then(clearSettledPromise, clearSettledPromise)
  return promise
}

export function invalidateDesktopPrimaryAuth(): void
{
  desktopAuthGeneration += 1
  desktopBearerTokenPromise = null
}

export function __resetDesktopPrimaryAuthForTests(): void
{
  invalidateDesktopPrimaryAuth()
}
