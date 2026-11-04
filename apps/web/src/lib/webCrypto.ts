// apps/web/src/lib/webCrypto.ts
// provides effect crypto services through the browser web crypto api

import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Layer from "effect/Layer";

export const layer = Layer.mergeAll(Digest.layerWebCrypto, SecureRandom.layerWebCrypto);
