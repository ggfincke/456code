// tests/apps/server/cartographer/CartographerHttp.test.ts
// proves cartographer proxy response bounds and safe forwarded metadata

import { describe, expect, it } from "vite-plus/test";

import {
  forwardedHeaders,
  readResponseBodyWithinLimit,
} from "../../../../apps/server/src/cartographer/CartographerHttp.ts";

function streamedResponse(chunks: ReadonlyArray<ReadonlyArray<number>>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(Uint8Array.from(chunk));
        }
        controller.close();
      },
    }),
  );
}

describe("readResponseBodyWithinLimit", () => {
  it("collects a chunked response at the exact byte limit", async () => {
    const body = await readResponseBodyWithinLimit(
      streamedResponse([
        [1, 2, 3],
        [4, 5, 6],
      ]),
      6,
    );

    expect(body).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6]));
  });

  it("rejects a chunked response as soon as it crosses the byte limit", async () => {
    const body = await readResponseBodyWithinLimit(
      streamedResponse([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ]),
      6,
    );

    expect(body).toBeNull();
  });
});

describe("forwardedHeaders", () => {
  it("omits stale wire metadata when fetch may have decoded the upstream body", () => {
    const upstream = new Response(Uint8Array.from([1, 2, 3]), {
      headers: {
        "content-encoding": "gzip",
        "content-length": "24",
        "content-type": "text/html; charset=utf-8",
      },
    });

    const headers = forwardedHeaders(upstream, "https://parent.example");

    expect(headers).toMatchObject({
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "frame-ancestors 'self' https://parent.example",
      "content-type": "text/html; charset=utf-8",
    });
    expect(headers).not.toHaveProperty("content-encoding");
    expect(headers).not.toHaveProperty("content-length");
  });
});
