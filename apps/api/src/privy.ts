import { importSPKI, jwtVerify } from "jose";
import { ApiFault } from "./errors.js";

let cachedKey: { pem: string; key: Promise<CryptoKey> } | undefined;

/** Verify access tokens, not identity tokens or client-supplied user IDs. */
export async function privyIdentity(token: string): Promise<{ subject: string; displayName: string }> {
  const appId = process.env.PRIVY_APP_ID;
  const pem = process.env.PRIVY_VERIFICATION_KEY?.replace(/\\n/g, "\n");
  if (!appId || !pem) {
    throw new ApiFault(503, "auth_unconfigured", "PRIVY_APP_ID and PRIVY_VERIFICATION_KEY are required");
  }
  if (!cachedKey || cachedKey.pem !== pem) cachedKey = { pem, key: importSPKI(pem, "ES256") };
  let key: CryptoKey;
  try { key = await cachedKey.key; }
  catch { throw new ApiFault(503, "auth_unconfigured", "Privy verification key is invalid"); }

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["ES256"], issuer: "privy.io", audience: appId,
      requiredClaims: ["sub", "iss", "aud", "iat", "exp"],
    });
    if (typeof payload.sub !== "string" || !/^did:privy:[a-zA-Z0-9_-]+$/.test(payload.sub) ||
        typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1000) + 5) {
      throw new Error("Invalid Privy access token claims");
    }
    return { subject: payload.sub, displayName: "Trader" };
  } catch {
    throw new ApiFault(401, "unauthorized", "Invalid or expired Privy access token");
  }
}
