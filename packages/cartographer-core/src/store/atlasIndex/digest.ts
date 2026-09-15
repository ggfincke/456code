import * as NodeCrypto from "node:crypto";

import type { SourceGraphDigest } from "../../contracts/types.js";

export function graphContentDigest(bytes: string | Uint8Array): SourceGraphDigest {
  return `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
}
