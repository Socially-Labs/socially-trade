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

interface PrivyLinkedAccount { type?: string; chain_type?: string; address?: string; wallet_client_type?: string }

/**
 * Solana wallets linked to a Privy user, embedded wallet first.
 * Null when PRIVY_APP_SECRET is not set, so the caller cannot check ownership.
 */
export async function privySolanaWallets(subject: string): Promise<string[] | null> {
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) return null;
  let body: { linked_accounts?: PrivyLinkedAccount[] };
  try {
    const response = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(subject)}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString("base64")}`,
        "privy-app-id": appId,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Privy user lookup returned ${response.status}`);
    body = await response.json() as typeof body;
  } catch {
    throw new ApiFault(503, "auth_unavailable", "Privy user lookup is unavailable");
  }
  return (body.linked_accounts ?? [])
    .filter((a) => a.type === "wallet" && a.chain_type === "solana" && typeof a.address === "string")
    .sort((a, b) => Number(b.wallet_client_type === "privy") - Number(a.wallet_client_type === "privy"))
    .map((a) => a.address!);
}
