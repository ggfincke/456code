// packages/client-runtime/src/environment/endpoint.ts
// expose environment endpoint url

export * from '@t3tools/shared/advertisedEndpoint'

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string =>
{
  const url = new URL(httpBaseUrl)
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return url.toString()
}
