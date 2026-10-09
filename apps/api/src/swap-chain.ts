import { createHash, createPublicKey, verify } from 'node:crypto';
import { Connection, PublicKey, SystemInstruction, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { ApiFault } from './errors.js';
import type { SwapConfig } from './swap-config.js';
import { SWAP_NETWORK as N, mintOf, type VenueQuote, type SwapChain, type SwapToken, type PreparedSwap, type SwapObservation } from './swap-types.js';

export const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const ROUTER = 'DRaybByLpbUL57LJARs3j8BitTxVfzBg351EaMr5UTCd';
const CPMM = 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb';
const CLMM = 'DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH';
const AMM = 'DRaya7Kj3aMWQSy19kSjvmuwq9docCHofyP9kanQGaav';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const pools = new Set([CPMM,CLMM,AMM]);
const rawAmount = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const address = (v: unknown): v is string => { try { return typeof v === 'string' && new PublicKey(v).toBase58() === v; } catch { return false; } };
function invalid(message = 'The swap service returned an unsafe transaction'): never { throw new ApiFault(422,'invalid_swap',message); }
export function associatedAccount(wallet: string, mint: string) {
  return PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(), TOKEN.toBuffer(), new PublicKey(mint).toBuffer()],ATA)[0];
}
export function parseVenueQuote(response: unknown, input: SwapToken, amount: string, config: Pick<SwapConfig,'slippageBps'|'maxPriceImpact'>): VenueQuote {
  if (!record(response) || response.success !== true || !record(response.data)) invalid('No swap route is available. Try a smaller amount.');
  const d = response.data, output = input === 'SOL' ? 'USDC' : 'SOL';
  if (!rawAmount(amount) || BigInt(amount) <= 0n || d.swapType !== 'BaseIn' || d.inputMint !== mintOf(input) || d.outputMint !== mintOf(output) || d.inputAmount !== amount ||
      d.slippageBps !== config.slippageBps || !rawAmount(d.outputAmount) || BigInt(d.outputAmount) <= 0n || !rawAmount(d.otherAmountThreshold) || BigInt(d.otherAmountThreshold) <= 0n ||
      BigInt(d.otherAmountThreshold) > BigInt(d.outputAmount) || BigInt(d.otherAmountThreshold) < BigInt(d.outputAmount)*BigInt(10000-config.slippageBps)/10000n ||
      typeof d.priceImpactPct !== 'number' || !Number.isFinite(d.priceImpactPct) || d.priceImpactPct < 0 || !Array.isArray(d.routePlan) || !d.routePlan.length || d.routePlan.length > 4) invalid('Invalid swap quote');
  if (d.priceImpactPct > config.maxPriceImpact) throw new ApiFault(422,'price_impact','Price impact exceeds the server limit. Try a smaller amount.');
  let previous: string = mintOf(input);
  const fees: { mint: string; amountRaw: string }[] = [];
  let feesKnown = true;
  for (const hop of d.routePlan) {
    if (!record(hop) || !address(hop.poolId) || hop.inputMint !== previous || !address(hop.outputMint) || hop.outputMint === previous) invalid('Invalid swap route');
    previous = hop.outputMint;
    if (address(hop.feeMint) && rawAmount(hop.feeAmount)) fees.push({mint:hop.feeMint,amountRaw:hop.feeAmount});
    else feesKnown = false;
  }
  if (previous !== mintOf(output)) invalid('Invalid swap route destination');
  return {input,output,amount,outputAmount:d.outputAmount,minimumOutput:d.otherAmountThreshold,priceImpact:d.priceImpactPct,
    slippageBps:config.slippageBps,hops:d.routePlan.length,venueFees:feesKnown?fees:null,response};
}
export function decodeWire(wire: string) {
  if (wire.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(wire)) invalid('Invalid transaction encoding');
  try {
    const bytes = Buffer.from(wire,'base64');
    if (bytes.length > 1232 || bytes.toString('base64') !== wire) invalid('Invalid transaction size');
    return VersionedTransaction.deserialize(bytes);
  } catch { invalid('Invalid transaction encoding'); }
}
export function verifySignedSwap(unsigned: string, signed: string, wallet: string) {
  const expected = decodeWire(unsigned), actual = decodeWire(signed);
  const message = Buffer.from(actual.message.serialize());
  if (actual.message.header.numRequiredSignatures !== 1 || actual.message.staticAccountKeys[0]?.toBase58() !== wallet ||
      !message.equals(Buffer.from(expected.message.serialize()))) invalid('Signed transaction differs from the prepared swap');
  const key = createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(wallet).toBuffer()]),format:'der',type:'spki'});
  if (!actual.signatures[0] || !verify(null,message,key,actual.signatures[0])) invalid('Invalid wallet signature');
  return {signature:getBase58Decoder().decode(actual.signatures[0]),wire:Buffer.from(actual.serialize()).toString('base64')};
}
const keyAt = (i: TransactionInstruction,n: number) => i.keys[n]?.pubkey.toBase58();
const u64 = (data: Buffer, offset: number) => { if (data.length < offset+8) invalid(); return data.readBigUInt64LE(offset); };

/** Decode the BaseIn router ABI from Raydium SDK tradeV2/instrument.ts.
 * Unknown instruction versions fail closed; a program allowlist alone is insufficient. */
export async function validatePreparedSwap(tx: VersionedTransaction, wallet: string, quote: VenueQuote, connection: Connection, config: SwapConfig) {
  if (tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0]?.toBase58() !== wallet || tx.signatures.some(s=>s.some(b=>b!==0))) invalid('Swap signer does not match the wallet');
  const tables = await Promise.all(tx.message.addressTableLookups.map(async l=>{
    const table = (await connection.getAddressLookupTable(l.accountKey)).value;
    if (!table) invalid('Swap lookup table is unavailable');
    return table;
  }));
  const message = TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables});
  const swaps = message.instructions.filter(i=>i.programId.toBase58()===ROUTER && i.data[0]===0 || pools.has(i.programId.toBase58()));
  if (swaps.length !== 1) invalid('Swap requires exactly one supported BaseIn instruction');
  const swap = swaps[0]!, program = swap.programId.toBase58();
  let source: string | undefined, destination: string | undefined;
  const route = (quote.response.data as {routePlan: {poolId:string;inputMint:string;outputMint:string;remainingAccounts?:string[]}[]}).routePlan;
  if (program === ROUTER) {
    if (swap.data[0] !== 0 || u64(swap.data,1)!==BigInt(quote.amount) || u64(swap.data,9)!==BigInt(quote.minimumOutput) ||
        keyAt(swap,0)!==TOKEN.toBase58() || keyAt(swap,1)!==TOKEN2022 || keyAt(swap,2)!==ATA.toBase58() || keyAt(swap,3)!==SystemProgram.programId.toBase58() || keyAt(swap,4)!==wallet) invalid();
    source=keyAt(swap,5); destination=keyAt(swap,6);
    let offset=7, clmmCount=0;
    for (let h=0;h<route.length;h++) {
      const hop=route[h]!, p=keyAt(swap,offset);
      if (!p || !pools.has(p) || keyAt(swap,offset+1)!==(h===route.length-1?destination:associatedAccount(wallet,hop.outputMint).toBase58()) ||
          keyAt(swap,offset+2)!==hop.inputMint || keyAt(swap,offset+3)!==hop.outputMint) invalid('Swap route accounts differ from the quote');
      const poolOffset=p===CPMM?6:p===CLMM?5:4;
      if (keyAt(swap,offset+poolOffset)!==hop.poolId) invalid('Swap pool differs from the quote');
      if (p===CLMM) clmmCount++;
      offset+=p===CPMM?10:p===AMM?17:11+(hop.remainingAccounts?.length??0);
    }
    if (offset!==swap.keys.length || ![17,17+16*clmmCount].includes(swap.data.length)) invalid('Unsupported swap route layout');
  } else {
    if (route.length!==1) invalid();
    if (program===CPMM) {
      if (!swap.data.subarray(0,8).equals(Buffer.from([143,190,90,218,196,30,51,222])) || swap.data.length!==24 || keyAt(swap,0)!==wallet || keyAt(swap,3)!==route[0]!.poolId ||
          keyAt(swap,8)!==TOKEN.toBase58() || keyAt(swap,9)!==TOKEN.toBase58() || keyAt(swap,10)!==mintOf(quote.input) || keyAt(swap,11)!==mintOf(quote.output) ||
          u64(swap.data,8)!==BigInt(quote.amount) || u64(swap.data,16)!==BigInt(quote.minimumOutput)) invalid();
      source=keyAt(swap,4); destination=keyAt(swap,5);
    } else if (program===AMM) {
      // AMM v4 swap-base-in (9), with legacy or compact account layout.
      if (swap.data.length!==17 || swap.data[0]!==9 || u64(swap.data,1)!==BigInt(quote.amount) || u64(swap.data,9)!==BigInt(quote.minimumOutput) ||
          keyAt(swap,0)!==TOKEN.toBase58() || keyAt(swap,1)!==route[0]!.poolId || keyAt(swap,swap.keys.length-1)!==wallet) invalid();
      source=keyAt(swap,swap.keys.length-3); destination=keyAt(swap,swap.keys.length-2);
    } else {
      const discriminator=createHash('sha256').update('global:swap_v2').digest().subarray(0,8);
      if(swap.data.length!==41||!swap.data.subarray(0,8).equals(discriminator)||swap.data[40]!==1||keyAt(swap,0)!==wallet||keyAt(swap,2)!==route[0]!.poolId||
         keyAt(swap,8)!==TOKEN.toBase58()||keyAt(swap,9)!==TOKEN2022||keyAt(swap,11)!==mintOf(quote.input)||keyAt(swap,12)!==mintOf(quote.output)||
         u64(swap.data,8)!==BigInt(quote.amount)||u64(swap.data,16)!==BigInt(quote.minimumOutput))invalid();
      source=keyAt(swap,3);destination=keyAt(swap,4);
    }
  }
  if (!source || !destination || source===destination) invalid();
  const usdc = quote.input==='USDC'?source:destination, native=quote.input==='SOL'?source:destination;
  if (quote.output==='USDC' && usdc!==associatedAccount(wallet,N.usdcMint).toBase58()) invalid('USDC recipient is not your associated account');
  const knownMints=new Set([N.solMint,N.usdcMint,...route.flatMap(h=>[h.inputMint,h.outputMint])]);
  let systemSpend=0n, limit=200000, price=0n;
  const creates=new Set<string>([...knownMints].map(mint=>associatedAccount(wallet,mint).toBase58()));
  let nativeClosed=false;
  for (const i of message.instructions) {
    const p=i.programId.toBase58();
    if (i===swap) continue;
    if (p===ROUTER) {
      // Current Trade API wraps/unwraps SOL through router helpers (5/6).
      // Both helpers must use this wallet's canonical WSOL ATA and standard programs.
      if(i.keys.length!==6||keyAt(i,0)!==wallet||keyAt(i,1)!==native||native!==associatedAccount(wallet,N.solMint).toBase58()||
         keyAt(i,3)!==TOKEN.toBase58()||keyAt(i,4)!==ATA.toBase58()||keyAt(i,5)!==SystemProgram.programId.toBase58())invalid('Unexpected router setup accounts');
      if(i.data[0]===5) {
        if(i.data.length!==9||keyAt(i,2)!==N.solMint||u64(i.data,1)!==(quote.input==='SOL'?BigInt(quote.amount):0n))invalid('Unexpected wrapped SOL amount');
        systemSpend+=u64(i.data,1);creates.add(native);
      } else if(i.data[0]===6) {
        if(i.data.length!==1||keyAt(i,2)!==wallet||nativeClosed)invalid('Unexpected unwrap recipient');
        nativeClosed=true;
      } else invalid('Unsupported router instruction');
    } else if (p===COMPUTE) {
      if (i.data[0]===2 && i.data.length===5) {limit=i.data.readUInt32LE(1);if(limit<1||limit>1400000)invalid();}
      else if(i.data[0]===3 && i.data.length===9){price=u64(i.data,1);if(price>BigInt(config.priorityMicroLamports))invalid('Priority fee exceeds policy');}
      else invalid('Unsupported compute budget instruction');
    } else if(p===SystemProgram.programId.toBase58()) {
      const kind=SystemInstruction.decodeInstructionType(i);
      if(kind==='CreateWithSeed') {
        const c=SystemInstruction.decodeCreateWithSeed(i);
        if(c.fromPubkey.toBase58()!==wallet||c.basePubkey.toBase58()!==wallet||c.newAccountPubkey.toBase58()!==native||c.programId.toBase58()!==TOKEN.toBase58()||c.space!==165)invalid();
        systemSpend+=BigInt(c.lamports);creates.add(native);
      } else if(kind==='Transfer') {
        const c=SystemInstruction.decodeTransfer(i);
        if(c.fromPubkey.toBase58()!==wallet||c.toPubkey.toBase58()!==native||quote.input!=='SOL')invalid('Unexpected SOL recipient');
        systemSpend+=c.lamports;
      } else invalid('Unsupported system instruction');
    } else if(p===ATA.toBase58()) {
      const mint=keyAt(i,3);
      if(i.data.length>1 || (i.data.length===1 && ![0,1].includes(i.data[0]!)) || keyAt(i,0)!==wallet||keyAt(i,2)!==wallet||!mint||!knownMints.has(mint)||keyAt(i,1)!==associatedAccount(wallet,mint).toBase58()||keyAt(i,4)!==SystemProgram.programId.toBase58()||keyAt(i,5)!==TOKEN.toBase58())invalid('Unexpected token account recipient');
      creates.add(keyAt(i,1)!);
    } else if(p===TOKEN.toBase58()) {
      const op=i.data[0];
      if(keyAt(i,0)!==native)invalid('Unexpected token instruction account');
      if(op===9) {if(i.data.length!==1||keyAt(i,1)!==wallet||keyAt(i,2)!==wallet||nativeClosed)invalid('Unexpected close recipient');nativeClosed=true;}
      else if(op===17) {if(i.data.length!==1)invalid();}
      else if(op===1) {if(i.data.length!==1||keyAt(i,1)!==N.solMint||keyAt(i,2)!==wallet)invalid();}
      else if(op===16||op===18) {if(i.data.length!==33||keyAt(i,1)!==N.solMint||new PublicKey(i.data.subarray(1)).toBase58()!==wallet)invalid();}
      else invalid('Unexpected token instruction in swap');
    } else invalid('Swap contains an unsupported program');
  }
  if(!nativeClosed)invalid('Swap must unwrap SOL back to this wallet');
  if(systemSpend>(quote.input==='SOL'?BigInt(quote.amount):0n)+BigInt(config.feeReserveLamports))invalid('SOL debit exceeds policy');
  const writable=new Set<string>([wallet,usdc,native]);
  for(const i of message.instructions)for(const k of i.keys)if(k.isWritable)writable.add(k.pubkey.toBase58());
  if(writable.size>64)invalid('Swap has too many accounts');
  return {addresses:[...writable],usdc,native,creates,priorityFee:(BigInt(limit)*price+999999n)/1000000n};
}
function tokenUnits(data: Buffer, mint: string, wallet: string) {
  if(data.length<165||new PublicKey(data.subarray(0,32)).toBase58()!==mint||new PublicKey(data.subarray(32,64)).toBase58()!==wallet)invalid('Token account owner or mint mismatch');
  return data.readBigUInt64LE(64);
}
export class RaydiumSwapChain implements SwapChain {
  readonly connection: Connection;
  constructor(readonly config: SwapConfig) {
    this.connection=new Connection(config.rpcUrl,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:async(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})});
  }
  async assertDevnet() {if(await this.connection.getGenesisHash()!==N.genesisHash)throw new ApiFault(503,'wrong_cluster','Swap RPC must be Solana Devnet');}
  async venue(path:string,body?:unknown) {
    try {
      const r=await fetch(`${this.config.venueUrl}${path}`,{signal:AbortSignal.timeout(15000),...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
      if(!r.ok)throw new Error('Venue unavailable');
      return await r.json();
    } catch {throw new ApiFault(503,'swap_venue_unavailable','Swap service is unavailable. Please retry.');}
  }
  async quote(input:SwapToken,amount:string) {
    const output=input==='SOL'?'USDC':'SOL';
    const query=new URLSearchParams({inputMint:mintOf(input),outputMint:mintOf(output),amount,slippageBps:String(this.config.slippageBps),txVersion:'V0'});
    return parseVenueQuote(await this.venue(`/compute/swap-base-in?${query}`),input,amount,this.config);
  }
  async prepare(quote:VenueQuote,wallet:string):Promise<PreparedSwap> {
    await this.assertDevnet();
    let inputAccount:string|undefined;
    if(quote.input==='USDC') {
      const accounts=await this.connection.getTokenAccountsByOwner(new PublicKey(wallet),{mint:new PublicKey(N.usdcMint)});
      inputAccount=accounts.value.find(a=>a.account.owner.equals(TOKEN)&&tokenUnits(a.account.data,N.usdcMint,wallet)>=BigInt(quote.amount))?.pubkey.toBase58();
      if(!inputAccount)throw new ApiFault(422,'insufficient_balance','Not enough Circle USDC in a single token account');
    }
    const built=await this.venue('/transaction/swap-base-in',{computeUnitPriceMicroLamports:String(this.config.priorityMicroLamports),swapResponse:quote.response,txVersion:'V0',wallet,
      wrapSol:quote.input==='SOL',unwrapSol:quote.output==='SOL',inputAccount,outputAccount:quote.output==='USDC'?associatedAccount(wallet,N.usdcMint).toBase58():undefined});
    if(!record(built)||built.success!==true||!Array.isArray(built.data)||built.data.length!==1||!record(built.data[0])||typeof built.data[0].transaction!=='string')invalid('This swap route requires unsupported setup transactions');
    const tx=decodeWire(built.data[0].transaction);
    const checked=await validatePreparedSwap(tx,wallet,quote,this.connection,this.config);
    const deadline=await this.connection.getLatestBlockhash('confirmed');
    tx.message.recentBlockhash=deadline.blockhash;
    const before=await this.connection.getMultipleAccountsInfo(checked.addresses.map(a=>new PublicKey(a)));
    const index=(a:string)=>checked.addresses.indexOf(a);
    const ownerBefore=before[index(wallet)];
    if(!ownerBefore||BigInt(ownerBefore.lamports)<(quote.input==='SOL'?BigInt(quote.amount):0n)+BigInt(this.config.feeReserveLamports))throw new ApiFault(422,'insufficient_sol','Keep 0.01 SOL for fees and account rent');
    const nativeBefore=before[index(checked.native)];
    if(nativeBefore && (!nativeBefore.owner.equals(TOKEN)||tokenUnits(nativeBefore.data,N.solMint,wallet)!==0n))invalid('Wrapped SOL account must be empty');
    const usdcBefore=before[index(checked.usdc)];
    const unitsBefore=usdcBefore?(usdcBefore.owner.equals(TOKEN)?tokenUnits(usdcBefore.data,N.usdcMint,wallet):invalid()):0n;
    const [simulation,fee]=await Promise.all([
      this.connection.simulateTransaction(tx,{sigVerify:false,accounts:{encoding:'base64',addresses:checked.addresses}}),
      this.connection.getFeeForMessage(tx.message,'confirmed'),
    ]);
    if(simulation.value.err||!simulation.value.accounts||fee.value===null)invalid('Swap simulation failed; refresh the quote');
    if(fee.value>this.config.maxNetworkFeeLamports)invalid('Network fee exceeds server policy');
    const after=simulation.value.accounts;
    const usdcAfter=after[index(checked.usdc)];
    if(!usdcAfter||usdcAfter.owner!==TOKEN.toBase58())invalid();
    const unitsAfter=tokenUnits(Buffer.from(usdcAfter.data[0] ?? '', 'base64'),N.usdcMint,wallet);
    let solDelta=0n,rent=0n;
    for(let n=0;n<checked.addresses.length;n++) {
      const b=before[n],a=after[n],addr=checked.addresses[n]!;
      if(addr===wallet||addr===checked.native)solDelta+=BigInt(a?.lamports??0)-BigInt(b?.lamports??0);
      if(checked.creates.has(addr)&&!b&&a)rent+=BigInt(a.lamports);
      // The swap may create intermediary accounts, but may never debit another owned asset.
      if(b?.owner.equals(TOKEN)&&b.data.length>=165&&new PublicKey(b.data.subarray(32,64)).toBase58()===wallet&&addr!==checked.usdc&&addr!==checked.native) {
        if(!a||a.owner!==TOKEN.toBase58()||tokenUnits(Buffer.from(a.data[0] ?? '', 'base64'),new PublicKey(b.data.subarray(0,32)).toBase58(),wallet)<b.data.readBigUInt64LE(64))invalid('Swap debits an unrelated wallet asset');
      }
    }
    if(rent>BigInt(this.config.feeReserveLamports))invalid('Account rent exceeds server policy');
    if(quote.input==='SOL') {
      if(unitsAfter-unitsBefore<BigInt(quote.minimumOutput)||-solDelta>BigInt(quote.amount)+BigInt(fee.value)+rent)invalid('Simulation differs from the quote');
    } else if(unitsBefore-unitsAfter!==BigInt(quote.amount)||solDelta+BigInt(fee.value)+rent<BigInt(quote.minimumOutput))invalid('Simulation differs from the quote');
    return {transaction:Buffer.from(tx.serialize()).toString('base64'),blockhash:deadline.blockhash,lastValidBlockHeight:deadline.lastValidBlockHeight,
      fees:{networkFeeLamports:String(fee.value),priorityFeeLamports:checked.priorityFee.toString(),accountRentLamports:rent.toString()}};
  }
  verifySigned=verifySignedSwap;
  async broadcast(wire:string) {await this.assertDevnet();await this.connection.sendRawTransaction(Buffer.from(wire,'base64'),{skipPreflight:false,maxRetries:3,preflightCommitment:'confirmed'});}
  async observe(input:Parameters<SwapChain['observe']>[0]):Promise<SwapObservation> {
    await this.assertDevnet();
    if(input.signature) {
      const status=(await this.connection.getSignatureStatuses([input.signature],{searchTransactionHistory:true})).value[0];
      if(status?.confirmationStatus==='finalized') {
        if(status.err)return {status:'failed',failure:'transaction_failed'};
        const tx=await this.connection.getTransaction(input.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
        if(!tx?.meta)return {status:'pending'};
        if(!Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(decodeWire(input.unsigned).message.serialize())))return {status:'failed',failure:'transaction_mismatch'};
        if(tx.meta.err)return {status:'failed',failure:'transaction_failed'};
        const balances=(which:'preTokenBalances'|'postTokenBalances')=>(tx.meta![which]??[]).filter(b=>b.owner===input.wallet&&b.mint===N.usdcMint).reduce((sum,b)=>sum+BigInt(b.uiTokenAmount.amount),0n);
        const usdcDelta=balances('postTokenBalances')-balances('preTokenBalances');
        const walletIndex=tx.transaction.message.staticAccountKeys.findIndex(k=>k.toBase58()===input.wallet);
        let nativeDelta=BigInt(tx.meta.postBalances[walletIndex]!)-BigInt(tx.meta.preBalances[walletIndex]!)+BigInt(tx.meta.fee);
        // Account rent is separate from SOL output. Include wallet-owned token-account lamports.
        const owned=new Set([...(tx.meta.preTokenBalances??[]),...(tx.meta.postTokenBalances??[])].filter(b=>b.owner===input.wallet).map(b=>b.accountIndex));
        for(const n of owned)nativeDelta+=BigInt(tx.meta.postBalances[n]!)-BigInt(tx.meta.preBalances[n]!);
        const output=input.quote.input==='SOL'?usdcDelta:nativeDelta;
        const valid=input.quote.input==='SOL'?(-nativeDelta===BigInt(input.quote.amount)):usdcDelta===-BigInt(input.quote.amount);
        if(!valid||output<BigInt(input.quote.minimumOutput))return {status:'failed',failure:'chain_outcome_mismatch'};
        return {status:'confirmed',filledOutputRaw:output.toString(),networkFeeLamports:String(tx.meta.fee)};
      }
      if(status)return {status:'pending'}; // A landed transaction may finalize after blockhash expiry.
    }
    if(await this.connection.getBlockHeight('finalized')>input.lastValidBlockHeight)return {status:'expired'};
    return {status:'pending'};
  }
}
