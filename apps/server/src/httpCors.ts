// apps/server/src/httpCors.ts
// defines browser API CORS policy constants

export const browserApiCorsAllowedMethods = ['GET', 'POST', 'OPTIONS'] as const
export const browserApiDesktopRendererOrigins = ['code456://app', 'code456-dev://app'] as const
export const browserApiCorsAllowedHeaders = [
  'authorization',
  'b3',
  'traceparent',
  'content-type',
  'dpop',
] as const
