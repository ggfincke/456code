// apps/server/src/httpCors.ts
// expose browser api cors allowed methods

export const browserApiCorsAllowedMethods = ['GET', 'POST', 'OPTIONS'] as const
export const browserApiCorsAllowedHeaders = [
  'authorization',
  'b3',
  'traceparent',
  'content-type',
  'dpop',
] as const
