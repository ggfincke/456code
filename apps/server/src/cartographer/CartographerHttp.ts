// apps/server/src/cartographer/CartographerHttp.ts
// exchanges embed tickets and proxies authenticated cartographer responses
// @effect-diagnostics globalFetchInEffect:off - fetch preserves the upstream status and bounded binary body without a transport adapter

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { CartographerEmbedBroker, routePrefix } from "./CartographerEmbedBroker.ts";

const MAX_PROXY_RESPONSE_BYTES = 64 * 1024 * 1024;
const PROXY_RESPONSE_TIMEOUT_MS = 30_000;

export async function readResponseBodyWithinLimit(
  response: Response,
  maxBytes = MAX_PROXY_RESPONSE_BYTES,
): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function proxyErrorStatus(failure: string): number {
  switch (failure) {
    case "ticket_invalid":
      return 401;
    case "session_not_found":
      return 404;
    default:
      return 502;
  }
}

function splitEmbedPath(pathname: string): {
  readonly sessionId: string;
  readonly relativePath: string;
} | null {
  const prefix = `${routePrefix}/`;
  if (!pathname.startsWith(prefix)) return null;
  const suffix = pathname.slice(prefix.length);
  const separator = suffix.indexOf("/");
  const sessionId = separator < 0 ? suffix : suffix.slice(0, separator);
  const relativePath = separator < 0 ? "" : suffix.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(sessionId)) {
    return null;
  }
  return { sessionId, relativePath };
}

export function forwardedHeaders(upstream: Response, parentOrigin: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": `frame-ancestors 'self' ${parentOrigin}`,
    "X-Content-Type-Options": "nosniff",
  };

  // node fetch can decode the body while retaining the upstream wire metadata
  for (const name of ["content-type", "content-language", "etag", "last-modified"] as const) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}

const handleCartographerRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const requestUrl = HttpServerRequest.toURL(request);
  if (Option.isNone(requestUrl)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const target = splitEmbedPath(requestUrl.value.pathname);
  if (!target) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }

  const broker = yield* CartographerEmbedBroker;
  if (target.relativePath === "exchange") {
    if (request.method !== "GET") {
      return HttpServerResponse.text("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }
    const ticket = requestUrl.value.searchParams.get("ticket") ?? "";
    return yield* broker.exchangeTicket(target.sessionId, ticket).pipe(
      Effect.map(({ cookie, redirectPath }) =>
        HttpServerResponse.redirect(redirectPath, {
          status: 302,
          headers: {
            "Cache-Control": "no-store",
            "Set-Cookie": cookie,
            "Referrer-Policy": "no-referrer",
          },
        }),
      ),
      Effect.catchTag("CartographerEmbedError", (error) =>
        Effect.succeed(
          HttpServerResponse.text(error.message, {
            status: proxyErrorStatus(error.failure),
            headers: { "Cache-Control": "no-store" },
          }),
        ),
      ),
    );
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return HttpServerResponse.text("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  return yield* broker
    .resolveProxyTarget(
      target.sessionId,
      request.headers.cookie,
      target.relativePath,
      requestUrl.value.search,
    )
    .pipe(
      Effect.flatMap((proxy) =>
        Effect.tryPromise({
          try: async () => {
            const upstream = await fetch(proxy.targetUrl, {
              method: request.method,
              redirect: "manual",
              signal: AbortSignal.timeout(PROXY_RESPONSE_TIMEOUT_MS),
              headers: {
                "x-cartographer-capability": proxy.session.capability,
              },
            });
            const headers = forwardedHeaders(upstream, proxy.session.parentOrigin);
            if (request.method === "HEAD" || upstream.body === null) {
              return HttpServerResponse.empty({ status: upstream.status, headers });
            }
            const contentLength = Number(upstream.headers.get("content-length"));
            if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_RESPONSE_BYTES) {
              return HttpServerResponse.text("Cartographer response is too large.", {
                status: 502,
                headers: { "Cache-Control": "no-store" },
              });
            }
            const body = await readResponseBodyWithinLimit(upstream);
            if (body === null) {
              return HttpServerResponse.text("Cartographer response is too large.", {
                status: 502,
                headers: { "Cache-Control": "no-store" },
              });
            }
            return HttpServerResponse.uint8Array(body, {
              status: upstream.status,
              headers,
            });
          },
          catch: () =>
            HttpServerResponse.text("Cartographer proxy failed.", {
              status: 502,
              headers: { "Cache-Control": "no-store" },
            }),
        }),
      ),
      Effect.catchTag("CartographerEmbedError", (error) =>
        Effect.succeed(
          HttpServerResponse.text(error.message, {
            status: proxyErrorStatus(error.failure),
            headers: { "Cache-Control": "no-store" },
          }),
        ),
      ),
    );
});

export const cartographerEmbedRouteLayer = Layer.mergeAll(
  HttpRouter.add("*", `${routePrefix}/*`, handleCartographerRequest),
);
