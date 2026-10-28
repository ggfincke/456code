// packages/client-runtime/src/relay/managedRelay.ts
// manages relay requests and proof-bound device authorization
import type { EnvironmentId } from "@t3tools/contracts";
import {
  RelayAccessTokenType,
  RelayApi,
  RelayConnectEnvironmentEndpoint,
  RelayDpopAccessTokenScope,
  RelayDpopTokenExchangeGrantType,
  type RelayEnvironmentConnectRequest,
  type RelayEnvironmentConnectResponse,
  RelayExchangeDpopAccessTokenEndpoint,
  RelayJwtSubjectTokenType,
  type RelayPublicClientId,
  RelayProtectedError,
  type RelayProtectedError as RelayProtectedErrorType,
} from "@t3tools/contracts/relay";
import { encodeOAuthScope, oauthScopeSetEquals } from "@t3tools/shared/oauthScope";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";

export interface ManagedRelayDpopProofInput {
  readonly method: HttpMethod.HttpMethod;
  readonly url: string;
  readonly accessToken?: string;
}

export class ManagedRelayDpopKeyLoadError extends Schema.TaggedError<ManagedRelayDpopKeyLoadError>()(
  "ManagedRelayDpopKeyLoadError",
  {
    keyStore: Schema.Literals(["expo-secure-store", "indexed-db"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not load relay DPoP proof key.";
  }
}

export class ManagedRelayDpopProofCreationError extends Schema.TaggedError<ManagedRelayDpopProofCreationError>()(
  "ManagedRelayDpopProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not create the relay DPoP proof for ${this.method} ${this.url}.`;
  }
}

export const ManagedRelayDpopSignerError = Schema.Union([
  ManagedRelayDpopKeyLoadError,
  ManagedRelayDpopProofCreationError,
]);
export type ManagedRelayDpopSignerError = typeof ManagedRelayDpopSignerError.Type;

export const ManagedRelayRequestAction = Schema.Literals([
  "exchange relay DPoP access token",
  "connect relay environment",
]);
export type ManagedRelayRequestAction = typeof ManagedRelayRequestAction.Type;

export const ManagedRelayRequestActivity = Schema.Literals([
  "Relay DPoP access token exchange",
  "Relay environment connection",
]);
export type ManagedRelayRequestActivity = typeof ManagedRelayRequestActivity.Type;

export class ManagedRelayRequestTimeoutError extends Schema.TaggedError<ManagedRelayRequestTimeoutError>()(
  "ManagedRelayRequestTimeoutError",
  {
    activity: ManagedRelayRequestActivity,
    timeoutMs: Schema.Number,
    traceId: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `${this.activity} timed out. ${NETWORK_BLOCKING_HINT}`;
  }
}

export class ManagedRelayUrlInvalidError extends Schema.TaggedError<ManagedRelayUrlInvalidError>()(
  "ManagedRelayUrlInvalidError",
  {
    relayUrl: Schema.String,
  },
) {
  override get message(): string {
    return "Relay URL must be a secure absolute HTTPS origin.";
  }
}

export class ManagedRelayRequestFailedError extends Schema.TaggedError<ManagedRelayRequestFailedError>()(
  "ManagedRelayRequestFailedError",
  {
    action: ManagedRelayRequestAction,
    transportFailed: Schema.optionalKey(Schema.Boolean),
    cause: Schema.Defect(),
    relayError: Schema.optional(RelayProtectedError),
    status: Schema.optional(Schema.Number),
    traceId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const message = `Could not ${this.action}.`;
    return this.transportFailed ? `${message} ${NETWORK_BLOCKING_HINT}` : message;
  }
}

export class ManagedRelayAccessTokenScopesUnexpectedError extends Schema.TaggedError<ManagedRelayAccessTokenScopesUnexpectedError>()(
  "ManagedRelayAccessTokenScopesUnexpectedError",
  {
    requestedScopes: Schema.Array(RelayDpopAccessTokenScope),
    grantedScope: Schema.String,
  },
) {
  override get message(): string {
    return "Relay granted unexpected DPoP access token scopes.";
  }
}

export class ManagedRelayTokenProofCreationError extends Schema.TaggedError<ManagedRelayTokenProofCreationError>()(
  "ManagedRelayTokenProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not create relay token DPoP proof.";
  }
}

export class ManagedRelayRequestProofCreationError extends Schema.TaggedError<ManagedRelayRequestProofCreationError>()(
  "ManagedRelayRequestProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not create relay request DPoP proof.";
  }
}

export const ManagedRelayClientError = Schema.Union([
  ManagedRelayUrlInvalidError,
  ManagedRelayRequestFailedError,
  ManagedRelayRequestTimeoutError,
  ManagedRelayAccessTokenScopesUnexpectedError,
  ManagedRelayDpopKeyLoadError,
  ManagedRelayTokenProofCreationError,
  ManagedRelayRequestProofCreationError,
]);
export type ManagedRelayClientError = typeof ManagedRelayClientError.Type;

type RelayHttpRequestError =
  | RelayProtectedErrorType
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export class ManagedRelayDpopSigner extends Context.Service<
  ManagedRelayDpopSigner,
  {
    readonly thumbprint: Effect.Effect<string, ManagedRelayDpopKeyLoadError>;
    readonly createProof: (
      input: ManagedRelayDpopProofInput,
    ) => Effect.Effect<string, ManagedRelayDpopProofCreationError>;
  }
>()("@t3tools/client-runtime/relay/managedRelay/ManagedRelayDpopSigner") {}

export const MANAGED_RELAY_REQUEST_TIMEOUT_MS = 10_000;

export interface ManagedRelayAccessTokenCacheEntry {
  readonly accountId: string;
  readonly clientId: RelayPublicClientId;
  readonly relayUrl: string;
  readonly thumbprint: string;
  readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
  readonly accessToken: string;
  readonly expiresAtMillis: number;
}

export interface ManagedRelayAccessTokenStore {
  readonly load: Effect.Effect<ReadonlyArray<ManagedRelayAccessTokenCacheEntry>>;
  readonly save: (entries: ReadonlyArray<ManagedRelayAccessTokenCacheEntry>) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export interface ManagedRelayAuthorization {
  readonly accessToken: string;
  readonly proof: string;
  readonly thumbprint: string;
}

export interface ManagedRelayClientLayerOptions {
  readonly relayUrl: string;
  readonly clientId: RelayPublicClientId;
  readonly accessTokenStore?: ManagedRelayAccessTokenStore;
}

export class ManagedRelayClient extends Context.Service<
  ManagedRelayClient,
  {
    readonly relayUrl: string;
    readonly connectEnvironment: (input: {
      readonly clerkToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly environmentId: EnvironmentId;
      readonly deviceId?: string;
    }) => Effect.Effect<RelayEnvironmentConnectResponse, ManagedRelayClientError>;
    readonly resetTokenCache: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/relay/managedRelay/ManagedRelayClient") {}

const isRelayProtectedError = Schema.is(RelayProtectedError);

const TRACEPARENT_TRACE_ID = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;

function untypedResponseFields(cause: RelayHttpRequestError) {
  const response = HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
  if (!response) return {};
  const traceId = TRACEPARENT_TRACE_ID.exec(response.headers.traceparent ?? "")?.[1];
  return { status: response.status, ...(traceId ? { traceId } : {}) };
}

function relayRequestError(action: ManagedRelayRequestAction) {
  return (cause: RelayHttpRequestError): ManagedRelayClientError =>
    new ManagedRelayRequestFailedError({
      action,
      transportFailed:
        HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError",
      cause,
      ...(isRelayProtectedError(cause)
        ? { relayError: cause, traceId: cause.traceId }
        : untypedResponseFields(cause)),
    });
}

function proofCreationErrorFields(error: ManagedRelayDpopProofCreationError) {
  return {
    method: error.method,
    url: error.url,
    cause: error,
  };
}

function isRejectedDpopAccessToken(error: ManagedRelayClientError): boolean {
  return (
    error._tag === "ManagedRelayRequestFailedError" &&
    error.relayError?._tag === "RelayAuthInvalidError" &&
    error.relayError.reason === "invalid_bearer"
  );
}

function timeoutRelayRequest(activity: ManagedRelayRequestActivity) {
  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ManagedRelayClientError, R> =>
    effect.pipe(
      Effect.timeoutOption(Duration.millis(MANAGED_RELAY_REQUEST_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.currentParentSpan.pipe(
              Effect.map((span) => span.traceId),
              Effect.orElseSucceed(() => null),
              Effect.flatMap((traceId) =>
                Effect.fail(
                  new ManagedRelayRequestTimeoutError({
                    activity,
                    timeoutMs: MANAGED_RELAY_REQUEST_TIMEOUT_MS,
                    traceId,
                  }),
                ),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
}

function tokenMatches(
  token: ManagedRelayAccessTokenCacheEntry,
  input: {
    readonly accountId: string;
    readonly clientId: RelayPublicClientId;
    readonly relayUrl: string;
    readonly thumbprint: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly nowMillis: number;
  },
): boolean {
  return (
    token.accountId === input.accountId &&
    token.clientId === input.clientId &&
    token.relayUrl === input.relayUrl &&
    token.thumbprint === input.thumbprint &&
    token.expiresAtMillis > input.nowMillis + 5_000 &&
    input.scopes.every((scope) => token.scopes.includes(scope))
  );
}

function relayAccountId(clerkToken: string): Option.Option<string> {
  try {
    return Option.fromNullishOr(decodeRelayJwt(clerkToken).sub).pipe(
      Option.filter((subject) => subject.length > 0),
    );
  } catch {
    return Option.none();
  }
}

function dpopHeaders(authorization: ManagedRelayAuthorization) {
  return {
    authorization: `DPoP ${authorization.accessToken}`,
    dpop: authorization.proof,
  };
}

function disabledManagedRelayClient(relayUrl: string): ManagedRelayClient["Service"] {
  const unavailable = (spanName: string) =>
    Effect.fn(spanName)(function* () {
      return yield* new ManagedRelayUrlInvalidError({ relayUrl });
    });
  return ManagedRelayClient.of({
    relayUrl,
    connectEnvironment: unavailable("clientRuntime.managedRelay.connectEnvironment"),
    resetTokenCache: Effect.void.pipe(
      Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
    ),
  });
}

/** @public */
export const make = Effect.fn("ManagedRelayClient.make")(function* (
  options: ManagedRelayClientLayerOptions,
) {
  const relayUrl = normalizeSecureRelayUrl(options.relayUrl);
  if (relayUrl === null) {
    return disabledManagedRelayClient(options.relayUrl);
  }
  const signer = yield* ManagedRelayDpopSigner;
  const client = yield* HttpApiClient.make(RelayApi, { baseUrl: relayUrl });
  const initialTokens = options.accessTokenStore ? yield* options.accessTokenStore.load : [];
  const cachedTokens = yield* SynchronizedRef.make<
    ReadonlyArray<ManagedRelayAccessTokenCacheEntry>
  >(initialTokens.filter((token) => token.clientId === options.clientId));
  const urlBuilder = HttpApiClient.urlBuilder(RelayApi, { baseUrl: relayUrl });

  type DpopProofTarget = Pick<ManagedRelayDpopProofInput, "method" | "url">;
  const dpopProofTargets = {
    exchangeAccessToken: (): DpopProofTarget => ({
      method: RelayExchangeDpopAccessTokenEndpoint.method,
      url: urlBuilder.token.exchangeDpopAccessToken(),
    }),
    connectEnvironment: (environmentId: EnvironmentId): DpopProofTarget => ({
      method: RelayConnectEnvironmentEndpoint.method,
      url: urlBuilder.dpopClient.connectEnvironment({ params: { environmentId } }),
    }),
  };

  const exchangeAccessToken = Effect.fn("clientRuntime.managedRelay.exchangeAccessToken")(
    function* (input: {
      readonly clerkToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    }) {
      yield* Effect.annotateCurrentSpan({
        "relay.client_id": options.clientId,
        "relay.scopes": input.scopes.join(" "),
      });
      const proof = yield* signer
        .createProof(dpopProofTargets.exchangeAccessToken())
        .pipe(
          Effect.mapError(
            (error) => new ManagedRelayTokenProofCreationError(proofCreationErrorFields(error)),
          ),
        );
      const response = yield* client.token
        .exchangeDpopAccessToken({
          headers: { dpop: proof },
          payload: {
            grant_type: RelayDpopTokenExchangeGrantType,
            subject_token: input.clerkToken,
            subject_token_type: RelayJwtSubjectTokenType,
            requested_token_type: RelayAccessTokenType,
            resource: relayUrl,
            scope: encodeOAuthScope(input.scopes),
            client_id: options.clientId,
          },
        })
        .pipe(
          Effect.mapError(relayRequestError("exchange relay DPoP access token")),
          timeoutRelayRequest("Relay DPoP access token exchange"),
        );
      if (!oauthScopeSetEquals(response.scope, input.scopes)) {
        return yield* new ManagedRelayAccessTokenScopesUnexpectedError({
          requestedScopes: input.scopes,
          grantedScope: response.scope,
        });
      }
      return response;
    },
  );

  const obtainAccessToken = Effect.fn("clientRuntime.managedRelay.obtainAccessToken")(
    function* (input: {
      readonly clerkToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly thumbprint: string;
    }) {
      yield* Effect.annotateCurrentSpan({
        "relay.client_id": options.clientId,
        "relay.scopes": input.scopes.join(" "),
      });
      const nowMillis = yield* Clock.currentTimeMillis;
      const accountId = relayAccountId(input.clerkToken);
      if (Option.isNone(accountId)) {
        yield* Effect.annotateCurrentSpan({
          "relay.token_cache.result": "bypass",
          "relay.token_cache.bypass_reason": "invalid_subject_token",
        });
        const response = yield* exchangeAccessToken(input);
        return {
          accountId: "",
          clientId: options.clientId,
          relayUrl,
          thumbprint: input.thumbprint,
          scopes: input.scopes,
          accessToken: response.access_token,
          expiresAtMillis: nowMillis + response.expires_in * 1_000,
        } satisfies ManagedRelayAccessTokenCacheEntry;
      }
      const match = {
        accountId: accountId.value,
        clientId: options.clientId,
        relayUrl,
        thumbprint: input.thumbprint,
        scopes: input.scopes,
        nowMillis,
      };
      const cached = (yield* SynchronizedRef.get(cachedTokens)).find((token) =>
        tokenMatches(token, match),
      );
      if (cached) {
        yield* Effect.annotateCurrentSpan({
          "relay.token_cache.result": "hit",
        });
        return cached;
      }
      return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) =>
        Effect.gen(function* () {
          const lookupMillis = yield* Clock.currentTimeMillis;
          const activeTokens = tokens.filter(
            (token) => token.expiresAtMillis > lookupMillis + 5_000,
          );
          const cached = activeTokens.find((token) =>
            tokenMatches(token, { ...match, nowMillis: lookupMillis }),
          );
          if (cached) {
            yield* Effect.annotateCurrentSpan({
              "relay.token_cache.result": "hit",
            });
            return [cached, activeTokens] as const;
          }
          yield* Effect.annotateCurrentSpan({
            "relay.token_cache.result": "miss",
          });
          const response = yield* exchangeAccessToken(input);
          const next: ManagedRelayAccessTokenCacheEntry = {
            accountId: accountId.value,
            clientId: options.clientId,
            relayUrl,
            thumbprint: input.thumbprint,
            scopes: input.scopes,
            accessToken: response.access_token,
            expiresAtMillis: lookupMillis + response.expires_in * 1_000,
          };
          const nextTokens = [...activeTokens, next];
          if (options.accessTokenStore) {
            yield* options.accessTokenStore.save(nextTokens);
          }
          return [next, nextTokens] as const;
        }),
      ).pipe(Effect.withSpan("clientRuntime.managedRelay.tokenCacheCriticalSection"));
    },
  );

  const authorize = Effect.fn("clientRuntime.managedRelay.authorize")(function* (input: {
    readonly clerkToken: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly target: DpopProofTarget;
  }) {
    yield* Effect.annotateCurrentSpan({
      "relay.client_id": options.clientId,
      "relay.scopes": input.scopes.join(" "),
      "http.request.method": input.target.method,
      "url.full": input.target.url,
    });
    const thumbprint = yield* signer.thumbprint;
    const token = yield* obtainAccessToken({
      clerkToken: input.clerkToken,
      scopes: input.scopes,
      thumbprint,
    });
    const proof = yield* signer
      .createProof({
        ...input.target,
        accessToken: token.accessToken,
      })
      .pipe(
        Effect.mapError(
          (error) => new ManagedRelayRequestProofCreationError(proofCreationErrorFields(error)),
        ),
      );
    return { accessToken: token.accessToken, proof, thumbprint };
  });

  const invalidateAccessToken = Effect.fn("clientRuntime.managedRelay.invalidateAccessToken")(
    function* (accessToken: string) {
      return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) => {
        const nextTokens = tokens.filter((token) => token.accessToken !== accessToken);
        if (nextTokens.length === tokens.length) {
          return Effect.succeed([false, tokens] as const);
        }
        return (
          options.accessTokenStore ? options.accessTokenStore.save(nextTokens) : Effect.void
        ).pipe(Effect.as([true, nextTokens] as const));
      });
    },
  );

  const runDpopRequest = <A>(
    input: {
      readonly clerkToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly target: DpopProofTarget;
    },
    request: (
      authorization: ManagedRelayAuthorization,
    ) => Effect.Effect<A, ManagedRelayClientError>,
  ): Effect.Effect<A, ManagedRelayClientError> => {
    const attempt = (refreshRejectedToken: boolean): Effect.Effect<A, ManagedRelayClientError> =>
      authorize(input).pipe(
        Effect.flatMap((authorization) =>
          request(authorization).pipe(
            Effect.catchIf(isRejectedDpopAccessToken, (error) =>
              invalidateAccessToken(authorization.accessToken).pipe(
                Effect.tap((invalidated) =>
                  Effect.annotateCurrentSpan({
                    "relay.token_cache.invalidated": invalidated,
                    "relay.token_cache.invalidation_reason": "invalid_bearer",
                    "relay.token_cache.retry_after_invalidation": refreshRejectedToken,
                  }),
                ),
                Effect.tap((invalidated) =>
                  invalidated && refreshRejectedToken
                    ? Effect.logWarning(
                        "Relay rejected a cached DPoP access token; refreshing it once.",
                      )
                    : Effect.void,
                ),
                Effect.andThen(refreshRejectedToken ? attempt(false) : Effect.fail(error)),
              ),
            ),
          ),
        ),
      );
    return attempt(true);
  };

  return ManagedRelayClient.of({
    relayUrl,
    connectEnvironment: Effect.fnUntraced(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "environment.id": input.environmentId,
      });
      return yield* runDpopRequest(
        {
          clerkToken: input.clerkToken,
          scopes: input.scopes,
          target: dpopProofTargets.connectEnvironment(input.environmentId),
        },
        (authorization) => {
          const payload: RelayEnvironmentConnectRequest = {
            ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            clientKeyThumbprint: authorization.thumbprint,
          };
          return client.dpopClient
            .connectEnvironment({
              headers: dpopHeaders(authorization),
              params: { environmentId: input.environmentId },
              payload,
            })
            .pipe(
              Effect.mapError(relayRequestError("connect relay environment")),
              timeoutRelayRequest("Relay environment connection"),
            );
        },
      );
    }, Effect.withSpan("clientRuntime.managedRelay.connectEnvironment")),
    resetTokenCache: SynchronizedRef.set(cachedTokens, []).pipe(
      Effect.andThen(options.accessTokenStore ? options.accessTokenStore.clear : Effect.void),
      Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
    ),
  });
});

export const layer = (options: ManagedRelayClientLayerOptions) =>
  Layer.effect(ManagedRelayClient, make(options));
