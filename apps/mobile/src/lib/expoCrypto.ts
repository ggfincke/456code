// apps/mobile/src/lib/expoCrypto.ts
// provides effect crypto services through expo-crypto

import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as ExpoCrypto from "expo-crypto";

const EXPO_DIGEST_ALGORITHMS: Partial<
  Record<Digest.Algorithm["name"], ExpoCrypto.CryptoDigestAlgorithm>
> = {
  "SHA-1": ExpoCrypto.CryptoDigestAlgorithm.SHA1,
  "SHA-256": ExpoCrypto.CryptoDigestAlgorithm.SHA256,
  "SHA-384": ExpoCrypto.CryptoDigestAlgorithm.SHA384,
  "SHA-512": ExpoCrypto.CryptoDigestAlgorithm.SHA512,
};

const digest = Effect.fn("expoCrypto.digest")(function* (
  algorithm: Digest.Algorithm,
  data: Uint8Array,
) {
  if (algorithm.implementation !== undefined) return algorithm.implementation(data);
  const nativeAlgorithm = EXPO_DIGEST_ALGORITHMS[algorithm.name];
  if (nativeAlgorithm === undefined) {
    return yield* Effect.die(new Error(`Unsupported digest algorithm: ${algorithm.name}`));
  }
  return yield* Effect.promise(async () => {
    const input = new Uint8Array(data.length);
    input.set(data);
    return new Uint8Array(await ExpoCrypto.digest(nativeAlgorithm, input));
  });
});

export const layer = Layer.mergeAll(
  Layer.succeed(SecureRandom.SecureRandom, SecureRandom.make(ExpoCrypto.getRandomBytes)),
  Layer.succeed(Digest.Digest, {
    digest,
    digestHex: Effect.fn("Digest.Digest.digestHex")((algorithm, data) =>
      digest(algorithm, data).pipe(Effect.map(Hex.encode)),
    ),
  }),
);
