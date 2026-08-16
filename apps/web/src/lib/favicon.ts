// apps/web/src/lib/favicon.ts
// provide web favicon

// conventional fallback stays on the preview origin so arbitrary hostnames
// and ports are never disclosed to a third-party favicon service.
export function faviconUrlForOrigin(rawUrl: string | null | undefined): string | null
{
  if (!rawUrl) return null
  try
  {
    const url = new URL(rawUrl)
    if (!url.host) return null
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return new URL('/favicon.ico', url.origin).toString()
  }
  catch
  {
    return null
  }
}
