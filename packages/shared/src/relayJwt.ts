import { decodeJwt, type JWTPayload } from "jose";

export function decodeRelayJwt(token: string): JWTPayload {
  return decodeJwt(token);
}
