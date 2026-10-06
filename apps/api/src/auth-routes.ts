import type { FastifyInstance } from "fastify";
import type { DbPool } from "@socially/db";
import { requireActor } from "./auth.js";
import { accountView } from "./user-profiles.js";
import { ApiFault } from "./errors.js";
import { isWalletAddress } from "./token-chain.js";
import { bindWallet, settleSignupGrant, tokenInfo, type TokenLayer } from "./token-flows.js";

export function registerAuthRoutes(
  app: FastifyInstance, db: () => DbPool, token: TokenLayer | null,
): void {
  app.post<{ Body: { walletAddress?: string } }>("/v0/auth/privy", {
    schema: { body: { type: "object", additionalProperties: false,
      properties: token ? { walletAddress: { type: "string", maxLength: 44 } } : {} } },
    // The body is optional. A request without a body validates as {}.
    preValidation: async (request) => { request.body ??= {}; },
  }, async (request, reply) => {
    const actor = await requireActor(request, db());
    reply.header("cache-control", "no-store");
    const response = {
      mode: "PAPER", provider: "privy", privyUserId: actor.subject,
      user: accountView(actor),
    };
    if (!token) return response;
    const requested = request.body.walletAddress;
    if (requested !== undefined && !isWalletAddress(requested)) {
      throw new ApiFault(400, "invalid_wallet_address", "walletAddress must be a base58 Solana address");
    }
    const wallet = await bindWallet(db(), token, actor, requested);
    const signupGrant = wallet ? await settleSignupGrant(db(), token.chain, actor.id) : null;
    return { ...response, token: tokenInfo(token.chain), wallet, signupGrant };
  });
}
