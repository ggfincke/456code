// packages/client-runtime/src/state/environmentHttpAuth.ts
// authenticates environment requests without sharing upstream traces
import { msg } from "gt-i18n";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { FetchHttpClient, type HttpMethod } from "effect/http";

import type { PreparedConnection, PreparedHttpAuthorization } from "../connection/model.ts";
import { translatableMessage } from "../errors/translatable.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
  readonly dpop?: string;
}

export function withOrchestrationProtocolHeader(
  headers: EnvironmentHttpAuthHeaders,
): EnvironmentHttpAuthHeaders & {
  readonly [ORCHESTRATION_PROTOCOL_HEADER]: typeof ORCHESTRATION_PROTOCOL_VERSION_TEXT;
} {
  return {
    ...headers,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  };
}

/**
 * Cookie-authenticated environments need credentialed mode for cross-origin fetches; bearer uses headers.
 * `FetchHttpClient` reads `RequestInit` from the fiber context per request.
 */
const withEnvironmentRequestInit = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  requestInit: RequestInit | undefined,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  if (authorization !== null && requestInit === undefined) return request;
  return request.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      ...requestInit,
      ...(authorization === null ? { credentials: "include" as const } : {}),
    }),
  );
};

const environmentAuthHeaders = Effect.fnUntraced(function* (
  authorization: PreparedHttpAuthorization | null,
  method: HttpMethod.HttpMethod,
  url: string,
) {
  if (authorization === null) return {} satisfies EnvironmentHttpAuthHeaders;
  if (authorization._tag === "Bearer") {
    return { authorization: `Bearer ${authorization.token}` } satisfies EnvironmentHttpAuthHeaders;
  }
  const dpop = yield* authorization.createProof({
    method,
    url,
    accessToken: authorization.accessToken,
  });
  return {
    authorization: `DPoP ${authorization.accessToken}`,
    dpop,
  } satisfies EnvironmentHttpAuthHeaders;
});

export const executeAuthenticatedEnvironmentHttpRequest = Effect.fn(
  "clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest",
)(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(input: {
  readonly prepared: PreparedConnection;
  readonly method: HttpMethod.HttpMethod;
  /** The request URL, from the group's contract URL builder. */
  readonly url: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>[Group]) => string;
  readonly timeoutMs: number;
  /** Extra fetch options, such as refusing redirects for credentialed audio uploads. */
  readonly requestInit?: RequestInit;
  readonly group: Group;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
  /** Some endpoints report rejected credentials in a successful response. */
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
}): Effect.fn.Return<
  A,
  RemoteEnvironmentRequestError,
  Effect.Services<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>> | R
> {
  const httpBaseUrl = input.prepared.httpBaseUrl;
  const requestUrl = input.url(makeEnvironmentHttpApiUrlBuilder(httpBaseUrl)[input.group]);
  const client = yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, input.group);
  const authFetchError = (cause: unknown) =>
    new RemoteEnvironmentAuthFetchError({
      ...translatableMessage(msg("Could not authorize the environment request.")),
      cause,
    });
  const send = Effect.fnUntraced(function* (authorization: PreparedHttpAuthorization | null) {
    const headers = yield* environmentAuthHeaders(authorization, input.method, requestUrl).pipe(
      Effect.mapError(authFetchError),
    );
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs,
      withEnvironmentRequestInit(
        authorization,
        input.requestInit,
        input.request({ client, headers }),
      ),
    );
  });
  return yield* Effect.gen(function* () {
    const prepared = input.prepared.httpAuthorization;
    if (prepared?._tag !== "Dpop") return yield* send(prepared);
    const current = yield* prepared.current().pipe(Effect.mapError(authFetchError));
    const first = yield* send(current).pipe(Effect.result);
    if (Result.isSuccess(first)) {
      if (input.isUnauthorizedResponse?.(first.success) !== true) return first.success;
    } else if (
      first.failure._tag !== "EnvironmentAuthInvalidError" ||
      first.failure.reason !== "invalid_credential"
    ) {
      return yield* first.failure;
    }
    // a token refused before its expiry, like after a clock jump, renews once
    const renewed = yield* prepared
      .current(current.accessToken)
      .pipe(Effect.mapError(authFetchError));
    const second = yield* send(renewed);
    if (input.isUnauthorizedResponse?.(second) === true) {
      return yield* new RemoteEnvironmentAuthFetchError({
        ...translatableMessage(msg("The environment rejected the renewed session authorization.")),
        cause: second,
      });
    }
    return second;
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(
          new RemoteEnvironmentAuthTimeoutError({ requestUrl, timeoutMs: input.timeoutMs }),
        ),
    }),
  );
});

/** Sends the request with this client's own credentials on the supervised environment. */
export const executeConnectedEnvironmentHttpRequest = Effect.fn(
  "clientRuntime.state.executeConnectedEnvironmentHttpRequest",
)(function* <Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1], A, E, R>(
  input: Omit<
    Parameters<typeof executeAuthenticatedEnvironmentHttpRequest<Group, A, E, R>>[0],
    "prepared"
  >,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new RemoteEnvironmentAuthFetchError({
      ...translatableMessage(msg("The environment is not connected.")),
      cause: supervisor.target._tag,
    });
  }
  return yield* executeAuthenticatedEnvironmentHttpRequest({ ...input, prepared: prepared.value });
});
