import {
  address,
  appendTransactionMessageInstructions,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createSolanaRpcFromTransport,
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
  type Rpc,
  type RpcTransport,
  type GetTransactionApi,
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
export const TOKEN_LABEL = "Test USDC (devnet)";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export { TOKEN_PROGRAM_ADDRESS };
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
/** Every RPC call is aborted after this time, so no request waits on a slow node without end. */
export const RPC_TIMEOUT_MS = 10_000;
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

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

/** A top-level SPL Token `transfer` or `transferChecked` instruction. */
export interface TokenTransfer {
  source: string;
  destination: string;
  mint: string | null;
  authority: string | null;
  amount: bigint;
  references?: string[];
}

export interface ObservedTransaction {
  failed: boolean;
  /** Top-level instructions as `programId:type` ("unparsed" when the RPC cannot parse one). */
  instructions: string[];
  transfers: TokenTransfer[];
  /** Instructions that ran through a cross-program invocation. */
  innerInstructions: number;
  balances: BalanceChange[];
}

export type SignatureState = "confirmed" | "failed" | "processing" | "missing";

/** The only seam to Solana. Tests use an in-memory fake with the same contract. */
export interface TokenChain {
  readonly mint: string;
  readonly treasuryOwner?: string;
  signaturesForReference?(reference: string, before?: string, until?: string): Promise<{ signature: string; failed: boolean }[]>;
  observePayment?(signature: string): Promise<ObservedTransaction | null>;
  readonly treasuryAta: string;
  /** A finalized transaction, or null when the cluster has not finalized it yet. */
  observe(signature: string): Promise<ObservedTransaction | null>;
  status(signature: string): Promise<SignatureState>;
  /**
   * Block height, finalized by default. A missing transaction past its last valid height (at
   * finalized) cannot land. "processed" gives the newest tip the node knows.
   */
  blockHeight(commitment?: "finalized" | "processed"): Promise<bigint>;
  /** With createAta the treasury pays the rent for the owner's token account. */
  signMint(owner: string, amountRaw: bigint, createAta: boolean): Promise<SignedTransfer>;
  signPayout(owner: string, amountRaw: bigint, createAta: boolean): Promise<SignedTransfer>;
  send(wire: string): Promise<void>;
  /** Treasury pays the fee and signs; the user wallet signs as the source owner. */
  prepareDeposit(owner: string, amountRaw: bigint): Promise<{ transaction: string; lastValidBlockHeight: bigint }>;
  balance(owner: string): Promise<bigint>;
  tokenAccountExists(owner: string): Promise<boolean>;
}

export interface TokenConfig {
  rpcUrl: string;
  mint: Address;
  mintAuthority: KeyPairSigner;
  treasury: KeyPairSigner;
  signupGrantRaw: bigint;
  /** DEV_ALLOW_UNVERIFIED_WALLET=1: bind a client-supplied wallet without Privy. Localhost or devnet RPC only. */
  allowUnverifiedWallet: boolean;
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

function isLocalOrDevnetRpc(rpcUrl: string): boolean {
  const host = new URL(rpcUrl).hostname;
  return ["localhost", "127.0.0.1", "[::1]"].includes(host) || /devnet/i.test(host);
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
  const allowUnverifiedWallet = env.DEV_ALLOW_UNVERIFIED_WALLET === "1";
  if (allowUnverifiedWallet) {
    if (!isLocalOrDevnetRpc(rpcUrl)) {
      throw new Error("DEV_ALLOW_UNVERIFIED_WALLET=1 is refused: DEVNET_RPC_URL must be localhost or devnet");
    }
    console.warn("WARNING: DEV_ALLOW_UNVERIFIED_WALLET=1. Wallet ownership is NOT verified. "
      + "Any signed-in user can bind any address. Never use this outside local devnet testing.");
  }
  return {
    rpcUrl,
    mint: address(env.USDG_MINT),
    mintAuthority: await parseKeypair("MINT_AUTHORITY", env.MINT_AUTHORITY),
    treasury: await parseKeypair("TREASURY", env.TREASURY),
    signupGrantRaw,
    allowUnverifiedWallet,
  };
}

function optionAddress(value: { __option: "Some"; value: Address } | { __option: "None" }): string | null {
  return value.__option === "Some" ? value.value : null;
}

/** Adds a hard timeout to every request of a transport. */
export function withTimeout(transport: RpcTransport, ms = RPC_TIMEOUT_MS): RpcTransport {
  return <T>(request: Parameters<RpcTransport>[0]) => {
    const timeout = AbortSignal.timeout(ms);
    return transport<T>({ ...request, signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout });
  };
}

type ParsedInstruction = { programId: string; parsed?: { type?: string; info?: Record<string, unknown> } | string };

/** Reads a finalized transaction as instructions, token transfers and token balance changes. */
export async function observeTransaction(rpc: Rpc<GetTransactionApi>, sig: string): Promise<ObservedTransaction | null> {
  const tx = await rpc.getTransaction(toSignature(sig), {
    commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
  }).send();
  if (!tx?.meta) return null;
  const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey as string);
  const changes = new Map<number, BalanceChange>();
  const entry = (b: { accountIndex: number; mint: string; owner?: string }) => {
    const index = Number(b.accountIndex);
    const found = changes.get(index);
    if (found) return found;
    const created = { account: keys[index] ?? "", mint: b.mint, owner: b.owner ?? null, pre: 0n, post: 0n };
    changes.set(index, created);
    return created;
  };
  for (const b of tx.meta.preTokenBalances ?? []) entry(b).pre = BigInt(b.uiTokenAmount.amount);
  for (const b of tx.meta.postTokenBalances ?? []) entry(b).post = BigInt(b.uiTokenAmount.amount);
  const instructions: string[] = [];
  const transfers: TokenTransfer[] = [];
  for (const ix of tx.transaction.message.instructions as readonly ParsedInstruction[]) {
    const parsed = typeof ix.parsed === "object" ? ix.parsed : undefined;
    const type = parsed?.type ?? "unparsed";
    instructions.push(`${ix.programId}:${type}`);
    if (ix.programId !== TOKEN_PROGRAM_ADDRESS || (type !== "transfer" && type !== "transferChecked")) continue;
    const info = parsed?.info ?? {};
    const text = (key: string) => (typeof info[key] === "string" ? info[key] as string : null);
    const tokenAmount = info.tokenAmount as { amount?: string } | undefined;
    transfers.push({
      source: text("source") ?? "", destination: text("destination") ?? "", mint: text("mint"),
      authority: text("authority") ?? text("multisigAuthority"),
      amount: BigInt(tokenAmount?.amount ?? text("amount") ?? "0"),
    });
  }
  const innerInstructions = (tx.meta.innerInstructions ?? []).reduce((sum, inner) => sum + inner.instructions.length, 0);
  return { failed: tx.meta.err !== null, instructions, transfers, innerInstructions, balances: [...changes.values()] };
}

/** Finalized parsed transfers plus read-only references on the compiled transfer instruction. */
export async function observePaymentTransaction(rpc: Rpc<GetTransactionApi>, sig: string): Promise<ObservedTransaction | null> {
  const observed = await observeTransaction(rpc, sig);
  if (!observed) return null;
  // jsonParsed omits extra SPL instruction accounts. Read the compiled message too so
  // reference ownership is proven on the transfer instruction, not merely in accountKeys.
  const raw = await rpc.getTransaction(toSignature(sig), {
    commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0,
  }).send();
  if (!raw?.meta) return null;
  const keys = [...raw.transaction.message.accountKeys,
    ...(raw.meta.loadedAddresses?.writable ?? []), ...(raw.meta.loadedAddresses?.readonly ?? [])];
  const h = raw.transaction.message.header;
  const staticCount = raw.transaction.message.accountKeys.length;
  const readonly = (index: number) => index >= Number(h.numRequiredSignatures) &&
    (index < staticCount ? index >= staticCount - Number(h.numReadonlyUnsignedAccounts)
      : index >= staticCount + (raw.meta?.loadedAddresses?.writable.length ?? 0));
  let transferIndex = 0;
  for (let i = 0; i < observed.instructions.length; i++) {
    const kind = observed.instructions[i];
    if (kind !== `${TOKEN_PROGRAM_ADDRESS}:transferChecked` && kind !== `${TOKEN_PROGRAM_ADDRESS}:transfer`) continue;
    const ix = raw.transaction.message.instructions[i];
    const transfer = observed.transfers[transferIndex++];
    if (!ix || !transfer || keys[Number(ix.programIdIndex)] !== TOKEN_PROGRAM_ADDRESS) return null;
    const extra = ix.accounts.slice(kind.endsWith(":transferChecked") ? 4 : 3).map(Number);
    transfer.references = extra.filter(readonly).map(index => keys[index] as string);
  }
  return observed;
}

/** Real devnet adapter. It verifies the cluster and the mint before it returns. */
export async function createDevnetChain(config: TokenConfig): Promise<TokenChain> {
  const rpc = createSolanaRpcFromTransport(withTimeout(createDefaultRpcTransport({ url: config.rpcUrl })));
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
    treasuryOwner: config.treasury.address,
    treasuryAta,
    async signaturesForReference(reference, before, until) {
      const rows = await rpc.getSignaturesForAddress(address(reference), {
        commitment: "confirmed", limit: 100, ...(before ? { before: toSignature(before) } : {}),
        ...(until ? { until: toSignature(until) } : {}),
      }).send();
      return rows.map(row => ({ signature: row.signature, failed: row.err !== null }));
    },
    observePayment: (sig) => observePaymentTransaction(rpc, sig),
    observe: (sig) => observeTransaction(rpc, sig),
    async status(sig) {
      const { value } = await rpc.getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true }).send();
      const state = value[0];
      if (!state) return "missing";
      if (state.err) return "failed";
      return state.confirmationStatus === "confirmed" || state.confirmationStatus === "finalized" ? "confirmed" : "processing";
    },
    async blockHeight(commitment = "finalized") {
      return rpc.getBlockHeight({ commitment }).send();
    },
    async signMint(owner, amountRaw, withAta) {
      const wallet = address(owner);
      const account = await ata(wallet);
      return sign([
        ...(withAta ? [createAta(wallet, account)] : []),
        getMintToCheckedInstruction({
          mint: config.mint, token: account, mintAuthority: config.mintAuthority,
          amount: amountRaw, decimals: TOKEN_DECIMALS,
        }),
      ]);
    },
    async signPayout(owner, amountRaw, withAta) {
      const wallet = address(owner);
      const account = await ata(wallet);
      return sign([
        ...(withAta ? [createAta(wallet, account)] : []),
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
    async tokenAccountExists(owner) {
      return (await fetchMaybeToken(rpc, await ata(address(owner)))).exists;
    },
  };
}
