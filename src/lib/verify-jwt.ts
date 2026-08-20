import "server-only";
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from "jose";

/**
 * Local verification of a Supabase access token.
 *
 * Replaces a network round trip. `supabase.auth.getUser()` calls the auth
 * server on every invocation, and both the proxy and the route handler were
 * doing it for the same token on the same request — measured at ~470ms for the
 * route's call alone, roughly a quarter of the request, and invisible until the
 * timing instrumentation moved to cover it.
 *
 * The safety property is unchanged. `getSession()` on its own is NOT safe: it
 * only base64-decodes a cookie the client controls, so a forged payload would
 * be believed. Decoding it and then verifying the SIGNATURE against Supabase's
 * published key is exactly as trustworthy as asking the auth server, because
 * only the auth server holds the private half.
 *
 * The project publishes one ES256 / P-256 key at the JWKS endpoint. `jose`
 * fetches it once and caches it, refetching only when a token arrives with an
 * unknown `kid` (i.e. after a key rotation), so steady state is zero network.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL)!;

const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
  {
    // Bound how often a flood of unknown-kid tokens can trigger refetches.
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  }
);

export type VerifiedUser = {
  id: string;
  email: string | null;
  /** Unix seconds. Callers use this to decide whether a refresh is due. */
  expiresAt: number;
};

/**
 * Returns the user if the token is genuine, or null.
 *
 * Null means "could not prove this token is valid" for ANY reason — bad
 * signature, expired, wrong issuer, an algorithm we don't accept, or the JWKS
 * being unreachable. Callers treat null as unauthenticated and may fall back to
 * the network path; they must never treat it as a soft pass.
 */
export async function verifyAccessToken(
  token: string | undefined | null
): Promise<VerifiedUser | null> {
  if (!token) return null;

  try {
    // Reject anything not signed with the asymmetric key up front. A project
    // still on legacy HS256 would need the shared secret, which this deliberately
    // does not hold — better to fail closed and let the caller fall back than to
    // silently accept a weaker algorithm.
    const header = decodeProtectedHeader(token);
    if (header.alg !== "ES256") return null;

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
      // jose enforces exp and nbf itself.
    });

    const id = typeof payload.sub === "string" ? payload.sub : null;
    if (!id) return null;

    return {
      id,
      email: typeof payload.email === "string" ? payload.email : null,
      expiresAt: typeof payload.exp === "number" ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}
