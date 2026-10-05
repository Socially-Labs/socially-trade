import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isAddress,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

export const TOKEN_DECIMALS = 6;
export const TOKEN_LABEL = "USDG (devnet)";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";

/** A signed transaction that the backend has not sent yet. */
export interface SignedTransfer {
  signature: string;
  lastValidBlockHeight: bigint;
  wire: string;
}

/** Token balance change of one account, as the confirmed transaction meta reports it. */
export interface BalanceChange {
  account: string;
  mint: string;
  owner: string | null;
  pre: bigint;
  post: bigint;
}

export interface ObservedTransaction {
  failed: boolean;
  balances: BalanceChange[];
}

export type SignatureState = "confirmed" | "failed" | "processing" | "missing";

/** The only seam to Solana. Tests use an in-memory fake with the same contract. */
export interface TokenChain {
  readonly mint: string;
  readonly treasuryAta: string;
  /** A confirmed or finalized transaction, or null when the cluster does not have it yet. */
  observe(signature: string): Promise<ObservedTransaction | null>;
  status(signature: string): Promise<SignatureState>;
  /** Block height at finalized commitment. A missing transaction past its last valid height cannot land. */
  blockHeight(): Promise<bigint>;
  signMint(owner: string, amountRaw: bigint): Promise<SignedTransfer>;
  signPayout(owner: string, amountRaw: bigint): Promise<SignedTransfer>;
  send(wire: string): Promise<void>;
  /** Treasury pays the fee and signs; the user wallet signs as the source owner. */
  prepareDeposit(owner: string, amountRaw: bigint): Promise<{ transaction: string; lastValidBlockHeight: bigint }>;
  balance(owner: string): Promise<bigint>;
}

export interface TokenConfig {
  rpcUrl: string;
  mint: Address;
  mintAuthority: KeyPairSigner;
  treasury: KeyPairSigner;
  signupGrantRaw: bigint;
}

export function isWalletAddress(value: unknown): value is string {
  return typeof value === "string" && isAddress(value);
}

/** Decimal string with at most 6 places to base units. */
export function toRaw(amount: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) throw new Error("Amount must be a decimal string with at most 6 places");
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole!) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(fraction.padEnd(TOKEN_DECIMALS, "0"));
}

export function fromRaw(raw: bigint | string): string {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(TOKEN_DECIMALS);
  return `${value / scale}.${(value % scale).toString().padStart(TOKEN_DECIMALS, "0")}`;
}

export function assertNotMainnetUrl(rpcUrl: string): void {
  let host: string;
  try { host = new URL(rpcUrl).hostname; }
  catch { throw new Error("DEVNET_RPC_URL is not a valid URL"); }
  if (/mainnet/i.test(host) || /mainnet/i.test(rpcUrl)) {
    throw new Error("Refusing to run the token layer against a mainnet RPC");
  }
}

export function assertDevnetGenesis(genesisHash: string): void {
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`Refusing to run the token layer: RPC genesis ${genesisHash} is not Solana devnet`);
  }
}

/** The configured mint must be ours: 6 decimals and our mint authority. */
export function assertOwnedMint(
  mint: { decimals: number; mintAuthority: string | null } | null,
  expectedAuthority: string,
): void {
  if (!mint) throw new Error("Refusing to run the token layer: USDG_MINT does not exist on this cluster");
  if (mint.decimals !== TOKEN_DECIMALS) throw new Error("Refusing to run the token layer: USDG_MINT must have 6 decimals");
  if (mint.mintAuthority !== expectedAuthority) {
    throw new Error("Refusing to run the token layer: MINT_AUTHORITY does not control USDG_MINT");
  }
}

/** Accepts a 64-byte secret key as a JSON array or base58. The error never contains the value. */
export async function parseKeypair(name: string, value: string | undefined): Promise<KeyPairSigner> {
  if (!value) throw new Error(`${name} is required when USDG_MINT is set`);
  let bytes: Uint8Array;
  try {
    bytes = value.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(value) as number[])
      : Uint8Array.from(getBase58Encoder().encode(value.trim()));
  } catch { throw new Error(`${name} must be a JSON byte array or base58 secret key`); }
  if (bytes.length !== 64) throw new Error(`${name} must hold 64 bytes`);
  try { return await createKeyPairSignerFromBytes(bytes); }
  catch { throw new Error(`${name} is not a valid ed25519 key pair`); }
}

/** Null when the token layer is off (USDG_MINT unset). */
export async function loadTokenConfig(env: NodeJS.ProcessEnv = process.env): Promise<TokenConfig | null> {
  if (!env.USDG_MINT) return null;
  const rpcUrl = env.DEVNET_RPC_URL ?? DEFAULT_RPC_URL;
  assertNotMainnetUrl(rpcUrl);
  if (!isAddress(env.USDG_MINT)) throw new Error("USDG_MINT is not a valid address");
  let signupGrantRaw: bigint;
  try { signupGrantRaw = toRaw(env.SIGNUP_GRANT ?? "10000"); }
  catch { throw new Error("SIGNUP_GRANT must be a decimal string with at most 6 places"); }
  if (signupGrantRaw <= 0n) throw new Error("SIGNUP_GRANT must be positive");
  return {
    rpcUrl,
    mint: address(env.USDG_MINT),
    mintAuthority: await parseKeypair("MINT_AUTHORITY", env.MINT_AUTHORITY),
    treasury: await parseKeypair("TREASURY", env.TREASURY),
    signupGrantRaw,
  };
}

function optionAddress(value: { __option: "Some"; value: Address } | { __option: "None" }): string | null {
  return value.__option === "Some" ? value.value : null;
}

/** Real devnet adapter. It verifies the cluster and the mint before it returns. */
export async function createDevnetChain(config: TokenConfig): Promise<TokenChain> {
  const rpc = createSolanaRpc(config.rpcUrl);
  assertDevnetGenesis(await rpc.getGenesisHash().send());
  const mintAccount = await fetchMaybeMint(rpc, config.mint);
  assertOwnedMint(mintAccount.exists
    ? { decimals: mintAccount.data.decimals, mintAuthority: optionAddress(mintAccount.data.mintAuthority) }
    : null, config.mintAuthority.address);
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint: config.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const treasuryAta = await ata(config.treasury.address);
  const treasuryAccount = await fetchMaybeToken(rpc, treasuryAta);
  if (!treasuryAccount.exists) throw new Error("Treasury token account does not exist; run the devnet setup script");

  async function sign(instructions: Instruction[]): Promise<SignedTransfer> {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(config.treasury, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    return {
      signature: getSignatureFromTransaction(signed),
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      wire: getBase64EncodedWireTransaction(signed),
    };
  }
  const createAta = (owner: Address, account: Address) => getCreateAssociatedTokenIdempotentInstruction({
    payer: config.treasury, ata: account, owner, mint: config.mint,
  });

  return {
    mint: config.mint,
    treasuryAta,
    async observe(sig) {
      const tx = await rpc.getTransaction(toSignature(sig), {
        commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
      }).send();
      if (!tx?.meta) return null;
      const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey as string);
      const changes = new Map<number, BalanceChange>();
      const entry = (b: { accountIndex: number; mint: string; owner?: string }) => {
        const found = changes.get(b.accountIndex);
        if (found) return found;
        const created = { account: keys[b.accountIndex] ?? "", mint: b.mint, owner: b.owner ?? null, pre: 0n, post: 0n };
        changes.set(b.accountIndex, created);
        return created;
      };
      for (const b of tx.meta.preTokenBalances ?? []) entry(b).pre = BigInt(b.uiTokenAmount.amount);
      for (const b of tx.meta.postTokenBalances ?? []) entry(b).post = BigInt(b.uiTokenAmount.amount);
      return { failed: tx.meta.err !== null, balances: [...changes.values()] };
    },
    async status(sig) {
      const { value } = await rpc.getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true }).send();
      const state = value[0];
      if (!state) return "missing";
      if (state.err) return "failed";
      return state.confirmationStatus === "confirmed" || state.confirmationStatus === "finalized" ? "confirmed" : "processing";
    },
    async blockHeight() {
      return rpc.getBlockHeight({ commitment: "finalized" }).send();
    },
    async signMint(owner, amountRaw) {
      const wallet = address(owner);
      const account = await ata(wallet);
      return sign([
        createAta(wallet, account),
        getMintToCheckedInstruction({
          mint: config.mint, token: account, mintAuthority: config.mintAuthority,
          amount: amountRaw, decimals: TOKEN_DECIMALS,
        }),
      ]);
    },
    async signPayout(owner, amountRaw) {
      const wallet = address(owner);
      const account = await ata(wallet);
      return sign([
        createAta(wallet, account),
        getTransferCheckedInstruction({
          source: treasuryAta, mint: config.mint, destination: account, authority: config.treasury,
          amount: amountRaw, decimals: TOKEN_DECIMALS,
        }),
      ]);
    },
    async send(wire) {
      await rpc.sendTransaction(wire as Base64EncodedWireTransaction, {
        encoding: "base64", preflightCommitment: "confirmed",
      }).send();
    },
    async prepareDeposit(owner, amountRaw) {
      const wallet = address(owner);
      const source = await ata(wallet);
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(config.treasury, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions([getTransferCheckedInstruction({
          source, mint: config.mint, destination: treasuryAta,
          authority: createNoopSigner(wallet), amount: amountRaw, decimals: TOKEN_DECIMALS,
        })], m),
      );
      const partial = await partiallySignTransactionMessageWithSigners(message);
      return { transaction: getBase64EncodedWireTransaction(partial), lastValidBlockHeight: blockhash.lastValidBlockHeight };
    },
    async balance(owner) {
      const account = await fetchMaybeToken(rpc, await ata(address(owner)));
      return account.exists ? account.data.amount : 0n;
    },
  };
}
