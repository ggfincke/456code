// apps/mobile/src/connection/dpop.ts
// keeps this install's DPoP key in the keychain & signs w/ native P-256
import { DpopProof } from "@t3tools/client-runtime/authorization";
import { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

const DPOP_KEY_STORAGE_KEY = "456code.connection.dpop-proof-key";
const DEVICE_ONLY = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const DpopPrivateJwkJson = Schema.fromJsonString(
  Schema.Struct({ ...DpopPublicJwk.fields, d: Schema.String }),
);
const decodePrivateJwk = Schema.decodeUnknownEffect(DpopPrivateJwkJson);
const encodePrivateJwk = Schema.encodeEffect(DpopPrivateJwkJson);

interface NativeDpopKeys {
  /** A 32-byte private scalar followed by its 65-byte uncompressed public point. */
  generateDpopKey(): Promise<Uint8Array>;
  dpopKeyMatches(privateKey: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
  /** ES256 over the signing input, as the raw 64-byte `r||s` pair. */
  signDpop(privateKey: Uint8Array, signingInput: Uint8Array): Promise<Uint8Array>;
}

// imported lazily since loading `expo` at module scope breaks node tests
const nativeDpopKeys = async () =>
  (await import("expo")).requireNativeModule<NativeDpopKeys>("T3NativeControls");

const dpopError = (message: string) => (cause: unknown) =>
  new DpopProof.DpopProofError({ message, cause });

const base64UrlToBytes = (value: string) => Result.getOrThrow(Base64Url.decode(value));

function uncompressedPublicKey(jwk: DpopPublicJwk): Uint8Array {
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("DPoP key coordinate is not 32 bytes.");
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  return publicKey;
}

const generateKey = Effect.fn("mobile.dpop.generateKey")(function* () {
  const generated = yield* Effect.tryPromise({
    try: async () => (await nativeDpopKeys()).generateDpopKey(),
    catch: dpopError("Could not generate the device key."),
  });
  const publicKey = generated.slice(32);
  if (generated.length !== 97 || publicKey[0] !== 0x04) {
    return yield* new DpopProof.DpopProofError({ message: "Generated device key is invalid." });
  }
  const jwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: Base64Url.encode(publicKey.slice(1, 33)),
    y: Base64Url.encode(publicKey.slice(33, 65)),
    d: Base64Url.encode(generated.slice(0, 32)),
  };
  const encoded = yield* encodePrivateJwk(jwk).pipe(
    Effect.mapError(dpopError("Could not encode the device key.")),
  );
  yield* Effect.tryPromise({
    try: () => SecureStore.setItemAsync(DPOP_KEY_STORAGE_KEY, encoded, DEVICE_ONLY),
    catch: dpopError("Could not store the device key."),
  });
  return jwk;
});

const loadStoredKey = Effect.fn("mobile.dpop.loadStoredKey")(function* (stored: string) {
  const jwk = yield* decodePrivateJwk(stored).pipe(
    Effect.mapError(dpopError("Stored device key is invalid.")),
  );
  const matches = yield* Effect.tryPromise({
    try: async () =>
      (await nativeDpopKeys()).dpopKeyMatches(base64UrlToBytes(jwk.d), uncompressedPublicKey(jwk)),
    catch: dpopError("Stored device key is invalid."),
  });
  if (!matches) {
    return yield* new DpopProof.DpopProofError({ message: "Stored device key is invalid." });
  }
  return jwk;
});

export const loadOrCreateProofKey = Effect.fn("mobile.dpop.loadOrCreateProofKey")(function* () {
  const stored = yield* Effect.tryPromise({
    try: () => SecureStore.getItemAsync(DPOP_KEY_STORAGE_KEY, DEVICE_ONLY),
    catch: dpopError("Could not read the device key."),
  });
  const { d, ...publicJwk } = stored ? yield* loadStoredKey(stored) : yield* generateKey();
  const privateKey = yield* Effect.try({
    try: () => base64UrlToBytes(d),
    catch: dpopError("Could not read the device key."),
  });
  return {
    publicJwk,
    sign: (signingInput) =>
      Effect.tryPromise({
        try: async () => (await nativeDpopKeys()).signDpop(privateKey, signingInput),
        catch: dpopError("Could not sign the DPoP proof."),
      }),
  } satisfies DpopProof.DpopProofKey;
});
