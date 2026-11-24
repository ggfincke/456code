// apps/web/src/connection/dpop.ts
// keeps this client's non-extractable DPoP key in IndexedDB
import { DpopProof } from "@t3tools/client-runtime/authorization";
import { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

interface StoredDpopKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: DpopPublicJwk;
}

const DPOP_DATABASE_NAME = "456code:connection-auth";
const DPOP_DATABASE_VERSION = 1;
const DPOP_KEY_STORE_NAME = "keys";
const DPOP_KEY_ID = "direct-dpop-proof-key";
const decodePublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);

export const layerCrypto = Layer.mergeAll(Digest.layerWebCrypto, Signature.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

const dpopError = (message: string, cause?: unknown) =>
  new DpopProof.DpopProofError({ message, ...(cause === undefined ? {} : { cause }) });

const openDatabase = Effect.callback<IDBDatabase, DpopProof.DpopProofError>((resume) => {
  const request = indexedDB.open(DPOP_DATABASE_NAME, DPOP_DATABASE_VERSION);
  request.addEventListener("error", () =>
    resume(Effect.fail(dpopError("Could not open device key storage.", request.error))),
  );
  request.addEventListener("upgradeneeded", () => {
    if (!request.result.objectStoreNames.contains(DPOP_KEY_STORE_NAME)) {
      request.result.createObjectStore(DPOP_KEY_STORE_NAME);
    }
  });
  request.addEventListener("success", () => resume(Effect.succeed(request.result)));
});

const withDatabase = <A>(
  use: (database: IDBDatabase) => Effect.Effect<A, DpopProof.DpopProofError>,
) => Effect.acquireUseRelease(openDatabase, use, (database) => Effect.sync(() => database.close()));

const readStoredKey = withDatabase((database) =>
  Effect.callback<StoredDpopKey | null, DpopProof.DpopProofError>((resume) => {
    const request = database
      .transaction(DPOP_KEY_STORE_NAME, "readonly")
      .objectStore(DPOP_KEY_STORE_NAME)
      .get(DPOP_KEY_ID);
    request.addEventListener("error", () =>
      resume(Effect.fail(dpopError("Could not read the device key.", request.error))),
    );
    request.addEventListener("success", () =>
      resume(Effect.succeed((request.result as StoredDpopKey | undefined) ?? null)),
    );
  }),
);

const writeStoredKey = (key: StoredDpopKey) =>
  withDatabase((database) =>
    Effect.callback<void, DpopProof.DpopProofError>((resume) => {
      const transaction = database.transaction(DPOP_KEY_STORE_NAME, "readwrite");
      transaction.addEventListener("error", () =>
        resume(Effect.fail(dpopError("Could not write the device key.", transaction.error))),
      );
      transaction.addEventListener("complete", () => resume(Effect.void));
      transaction.objectStore(DPOP_KEY_STORE_NAME).put(key, DPOP_KEY_ID);
    }),
  );

const generateKey = Effect.gen(function* () {
  const generated = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
    catch: (cause) => dpopError("Could not generate the device key.", cause),
  });
  const privateJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.privateKey),
    catch: (cause) => dpopError("Could not export the device key.", cause),
  });
  const publicJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.publicKey),
    catch: (cause) => dpopError("Could not export the device key.", cause),
  }).pipe(
    Effect.flatMap((jwk) =>
      decodePublicJwk({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }).pipe(
        Effect.mapError((cause) => dpopError("Generated device key is invalid.", cause)),
      ),
    ),
  );
  // re-imported so the key that gets stored can't be exported
  const privateKey = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
      ]),
    catch: (cause) => dpopError("Could not import the device key.", cause),
  });
  return { privateKey, publicJwk } satisfies StoredDpopKey;
});

export const loadOrCreateProofKey = Effect.fn("web.dpop.loadOrCreateProofKey")(function* () {
  if (typeof indexedDB === "undefined" || globalThis.crypto?.subtle === undefined) {
    return yield* dpopError("This client cannot store a device key.");
  }
  const signature = yield* Signature.Signature;
  const stored = yield* readStoredKey;
  const key = stored ?? (yield* generateKey);
  if (stored === null) yield* writeStoredKey(key);
  const privateKey = yield* Signature.privateKeyFromCryptoKey(
    Signature.ecdsaP256,
    key.privateKey,
  ).pipe(Effect.mapError((cause) => dpopError("Could not load the device key.", cause)));
  return {
    publicJwk: key.publicJwk,
    sign: (signingInput) =>
      signature
        .sign(privateKey, signingInput)
        .pipe(Effect.mapError((cause) => dpopError("Could not sign the DPoP proof.", cause))),
  } satisfies DpopProof.DpopProofKey;
});
