// packages/client-runtime/src/authorization/dpopProof.ts
// signs RFC 9449 DPoP proofs w/ a key each client platform keeps on its device
import { normalizeDpopHtu, type DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class DpopProofError extends Schema.TaggedError<DpopProofError>()("DpopProofError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A P-256 proof key. `sign` returns the raw `r||s` ES256 signature over the JWS signing input. */
export interface DpopProofKey {
  readonly publicJwk: DpopPublicJwk;
  readonly sign: (signingInput: Uint8Array) => Effect.Effect<Uint8Array, DpopProofError>;
}

export interface DpopProofRequest {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string | undefined;
}

/** Signs proofs with this device's key, so a client without one can fall back to bearer. */
export class DpopSigner extends Context.Service<
  DpopSigner,
  {
    readonly createProof: (input: DpopProofRequest) => Effect.Effect<string, DpopProofError>;
  }
>()("@t3tools/client-runtime/authorization/dpopProof/DpopSigner") {}

const utf8 = (value: string) => new TextEncoder().encode(value);
const encodeSegment = (value: unknown) => Base64Url.encode(utf8(JSON.stringify(value)));

const sha256Base64Url = (data: Uint8Array) =>
  Effect.flatMap(Digest.Digest, (digest) => digest.digest(Digest.sha256, data)).pipe(
    Effect.map(Base64Url.encode),
  );

const createProof = Effect.fn("DpopProof.createProof")(function* (
  input: DpopProofRequest & { readonly key: DpopProofKey },
) {
  const htu = normalizeDpopHtu(input.url);
  if (htu === null) return yield* new DpopProofError({ message: "DPoP URL is invalid." });
  const random = yield* SecureRandom.SecureRandom;
  const header = encodeSegment({ typ: "dpop+jwt", alg: "ES256", jwk: input.key.publicJwk });
  const payload = encodeSegment({
    htm: input.method.toUpperCase(),
    htu,
    jti: yield* random.uuidV4(),
    iat: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
    ...(input.accessToken ? { ath: yield* sha256Base64Url(utf8(input.accessToken)) } : {}),
  });
  const signature = yield* input.key.sign(utf8(`${header}.${payload}`));
  return `${header}.${payload}.${Base64Url.encode(signature)}`;
});

// loads the key once & keeps it, while a failed load (like a locked keychain) retries
export const layerSigner = <E, R>(loadOrCreateKey: Effect.Effect<DpopProofKey, E, R>) =>
  Layer.effect(
    DpopSigner,
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const digest = yield* Digest.Digest;
      const context = yield* Effect.context<R>();
      const keyCache = yield* Cache.makeWith(
        () => loadOrCreateKey.pipe(Effect.provideContext(context)),
        {
          capacity: 1,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
        },
      );
      const loadKey = Cache.get(keyCache, undefined);
      return DpopSigner.of({
        createProof: Effect.fn("DpopSigner.createProof")(function* (input) {
          const key = yield* loadKey.pipe(
            Effect.mapError(
              (cause) => new DpopProofError({ message: "Could not load the device key.", cause }),
            ),
          );
          return yield* createProof({ ...input, key }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, random),
            Effect.provideService(Digest.Digest, digest),
          );
        }),
      });
    }),
  );
