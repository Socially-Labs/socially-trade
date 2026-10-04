import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ApiFault } from "./errors.js";

let cachedJwks: { appId: string; resolve: JWTVerifyGetKey } | undefined;

/** Verify access tokens, not identity tokens or client-supplied user IDs. */
export async function privyIdentity(token: string): Promise<{ subject: string; displayName: string; expiresAt: number }> {
  const appId = process.env.PRIVY_APP_ID;
  if (!appId) {
    throw new ApiFault(503, "auth_unconfigured", "PRIVY_APP_ID is required");
  }
  if (!cachedJwks || cachedJwks.appId !== appId) {
    const resolve = createRemoteJWKSet(
      new URL(`https://api.privy.io/v1/apps/${encodeURIComponent(appId)}/jwks.json`),
      { cacheMaxAge: 60 * 60 * 1000, cooldownDuration: 30_000, timeoutDuration: 5_000 },
    );
    cachedJwks = { appId, resolve: async (header, token) => {
      try { return await resolve(header, token); }
      catch (error) {
        if (error instanceof errors.JWKSNoMatchingKey) throw error;
        throw new ApiFault(503, "auth_unavailable", "Privy verification keys are unavailable");
      }
    } };
  }
  const key = cachedJwks.resolve;

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["ES256"], issuer: "privy.io", audience: appId,
      requiredClaims: ["sub", "iss", "aud", "iat", "exp"],
    });
    if (typeof payload.sub !== "string" || !/^did:privy:[a-zA-Z0-9_-]+$/.test(payload.sub) ||
        typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1000) + 5) {
      throw new Error("Invalid Privy access token claims");
    }
    return { subject: payload.sub, displayName: "Trader", expiresAt: payload.exp! };
  } catch (error) {
    if (error instanceof ApiFault) throw error;
    throw new ApiFault(401, "unauthorized", "Invalid or expired Privy access token");
  }
}
