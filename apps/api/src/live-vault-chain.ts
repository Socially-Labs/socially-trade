import { createHash, randomBytes } from 'node:crypto';
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ApiFault } from './errors.js';
import { associatedAccount, ATA, TOKEN, decodeWire, verifySignedSwap } from './swap-chain.js';
import { SWAP_NETWORK as N, type PreparedSwap, type SwapChain, type SwapToken } from './swap-types.js';

export const LIVE_PROGRAM = new PublicKey('8GaCjFv4QCtCzMQaBxGzpEbQZxfML2gMzNXZEigaPcUb');
export const TOKEN2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const SEED_MINIMUM = 100_000_000n;
const discriminator = (name:string) => createHash('sha256').update(name).digest().subarray(0,8);
const pda=(...seeds:Buffer[])=>PublicKey.findProgramAddressSync(seeds,LIVE_PROGRAM)[0];
const u64=(n:bigint)=>{ if(n<0n||n>18446744073709551615n)throw new ApiFault(400,'invalid_amount','Amount is out of range'); const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b; };
export const shareAccount=(owner:PublicKey,mint:PublicKey)=>PublicKey.findProgramAddressSync([owner.toBuffer(),TOKEN2022.toBuffer(),mint.toBuffer()],ATA)[0];
const meta=(pubkey:PublicKey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
export function fundAddresses(wallet:string,number:bigint) {
 const owner=new PublicKey(wallet),fund=pda(Buffer.from('fund'),owner.toBuffer(),u64(number));
 return {fund,config:pda(Buffer.from('config')),policy:pda(Buffer.from('policy'),fund.toBuffer()),member:pda(Buffer.from('member'),fund.toBuffer(),owner.toBuffer()),
  shares:pda(Buffer.from('shares'),fund.toBuffer()),vault:associatedAccount(fund.toBase58(),N.usdcMint)};
}
export function createFundInstruction(wallet:string,number:bigint,deposit:bigint,source=associatedAccount(wallet,N.usdcMint)) {
 if(deposit<SEED_MINIMUM)throw new ApiFault(422,'seed_too_small','The vault seed must be at least 100 USDC after conversion');
 const a=fundAddresses(wallet,number),owner=new PublicKey(wallet);
 return new TransactionInstruction({programId:LIVE_PROGRAM,data:Buffer.concat([discriminator('global:create_fund'),u64(number),u64(deposit),Buffer.from([0])]),
  keys:[meta(owner,true,true),meta(a.config),meta(a.fund,true),meta(a.policy,true),meta(a.member,true),meta(a.shares,true),meta(new PublicKey(N.usdcMint)),
   meta(source,true),meta(a.vault,true),meta(shareAccount(owner,a.shares),true),meta(TOKEN),meta(TOKEN2022),meta(ATA),meta(SystemProgram.programId)]});
}
export function readFund(data:Buffer) {
 if(data.length<353||!data.subarray(0,8).equals(discriminator('account:Fund')))throw new ApiFault(503,'invalid_fund','The vault account is incompatible');
 const count=data[336]!;
 if(count<1||count>8)throw new ApiFault(503,'invalid_fund','The vault holdings are incompatible');
 return {captain:new PublicKey(data.subarray(8,40)),number:data.readBigUInt64LE(40),shares:new PublicKey(data.subarray(48,80)),
  holdings:Array.from({length:count},(_,i)=>new PublicKey(data.subarray(80+i*32,112+i*32))),supply:data.readBigUInt64LE(337)};
}
export interface LivePreparation extends PreparedSwap { number:string; fund:string; shares:string; seedRaw:string }
export interface LiveChain {
 readiness():Promise<{enabled:boolean;reason:string|null}>;
 prepare(wallet:string,asset:SwapToken,amountRaw:string):Promise<LivePreparation>;
 prepareExit(wallet:string,fund:string):Promise<PreparedSwap & {sharesRaw:string}>;
 verifySigned:typeof verifySignedSwap;
 broadcast(wire:string):Promise<void>;
 observe(row:{signature:string|null;unsigned_transaction:string;last_valid_block_height:string}):Promise<'pending'|'confirmed'|'failed'|'expired'>;
 holdings(wallet:string,fund:string):Promise<{sharesRaw:string;holdings:{mint:string;amountRaw:string}[]}>;
}
/** No server signing key or treasury: only the user's signature can create/fund/exit. */
export class SolanaLiveVaultChain implements LiveChain {
 readonly connection:Connection;
 private readinessCache:{until:number;value:{enabled:boolean;reason:string|null}}|undefined;
 constructor(rpc:string,private swaps:SwapChain|null,private requested:boolean) {
  this.connection=new Connection(rpc,{commitment:'confirmed',fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10000)})});
 }
 async readiness() {
  if(this.readinessCache&&this.readinessCache.until>Date.now())return this.readinessCache.value;
  let reason:string|null=null;
  if(!this.requested)reason='live_vaults_disabled';
  else {
   if(await this.connection.getGenesisHash()!==N.genesisHash)throw new ApiFault(503,'wrong_cluster','Live vault funding currently requires the configured devnet');
   const config=fundAddresses(N.solMint,0n).config;
   const [program,c]=await this.connection.getMultipleAccountsInfo([LIVE_PROGRAM,config]);
   if(!program?.executable)reason='vault_program_not_deployed';
   else if(!c||!c.owner.equals(LIVE_PROGRAM)||c.data.length<74||!c.data.subarray(0,8).equals(discriminator('account:Config')))reason='vault_config_missing';
   else if(!new PublicKey(c.data.subarray(40,72)).equals(new PublicKey(N.usdcMint)))reason='vault_mint_mismatch';
   else if(c.data[72]!==0)reason='vault_program_paused';
  }
  const value={enabled:reason===null,reason};this.readinessCache={until:Date.now()+10000,value};return value;
 }
 private async requireReady(){const r=await this.readiness();if(!r.enabled)throw new ApiFault(503,r.reason!,'Wallet-funded vaults are unavailable: '+r.reason);}
 async prepare(wallet:string,asset:SwapToken,amountRaw:string):Promise<LivePreparation> {
  await this.requireReady();const amount=BigInt(amountRaw),number=randomBytes(8).readBigUInt64LE(),addresses=fundAddresses(wallet,number);
  let instructions:TransactionInstruction[]=[],tables=[] as Awaited<ReturnType<Connection['getAddressLookupTable']>>['value'][];
  let seed=amount,priority='0',source=associatedAccount(wallet,N.usdcMint);
  if(asset==='SOL') {
   if(!this.swaps)throw new ApiFault(503,'conversion_unavailable','SOL conversion is unavailable');
   const quote=await this.swaps.quote('SOL',amountRaw);seed=BigInt(quote.minimumOutput);
   if(seed<SEED_MINIMUM)throw new ApiFault(422,'seed_too_small','This SOL amount yields less than the 100 USDC minimum after slippage');
   const swap=await this.swaps.prepare(quote,wallet),tx=decodeWire(swap.transaction);priority=swap.fees.priorityFeeLamports;
   tables=await Promise.all(tx.message.addressTableLookups.map(l=>this.connection.getAddressLookupTable(l.accountKey).then(r=>r.value)));
   if(tables.some(t=>!t))throw new ApiFault(503,'lookup_missing','Swap address table is unavailable');
   instructions=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables.filter(t=>t!==null)}).instructions;
  } else {
   if(seed<SEED_MINIMUM)throw new ApiFault(422,'seed_too_small','The minimum seed is 100 USDC');
   const accounts=(await this.connection.getTokenAccountsByOwner(new PublicKey(wallet),{mint:new PublicKey(N.usdcMint)})).value.filter(a=>a.account.owner.equals(TOKEN)&&a.account.data.length>=165&&new PublicKey(a.account.data.subarray(32,64)).toBase58()===wallet&&new PublicKey(a.account.data.subarray(0,32)).toBase58()===N.usdcMint);
   const single=accounts.find(a=>a.account.data.readBigUInt64LE(64)>=seed);
   if(single)source=single.pubkey;
   else {
    if(accounts.reduce((sum,a)=>sum+a.account.data.readBigUInt64LE(64),0n)<seed)throw new ApiFault(422,'insufficient_usdc','Not enough wallet USDC to fund this vault');
    instructions.push(new TransactionInstruction({programId:ATA,data:Buffer.from([1]),keys:[meta(new PublicKey(wallet),true,true),meta(source,true),meta(new PublicKey(wallet)),meta(new PublicKey(N.usdcMint)),meta(SystemProgram.programId),meta(TOKEN)]}));
    let needed=seed-(accounts.find(a=>a.pubkey.equals(source))?.account.data.readBigUInt64LE(64)??0n);
    for(const a of accounts){if(a.pubkey.equals(source)||needed<=0n)continue;const balance=a.account.data.readBigUInt64LE(64),part=balance<needed?balance:needed;if(!part)continue;
     instructions.push(new TransactionInstruction({programId:TOKEN,data:Buffer.concat([Buffer.from([12]),u64(part),Buffer.from([6])]),keys:[meta(a.pubkey,true),meta(new PublicKey(N.usdcMint)),meta(source,true),meta(new PublicKey(wallet),false,true)]}));needed-=part;
    }
   }
  }
  instructions=instructions.filter(i=>!i.programId.equals(ComputeBudgetProgram.programId));
  const unitPrice=asset==='SOL'?10000:0;
  instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:unitPrice}));
  priority=String(Math.ceil(600000*unitPrice/1000000));
  instructions.push(createFundInstruction(wallet,number,seed,source));
  const prepared=await this.build(wallet,instructions,tables.filter(t=>t!==null),[addresses.fund,addresses.shares,addresses.vault,shareAccount(new PublicKey(wallet),addresses.shares)],asset==='SOL'?amount:0n,priority);
  return {...prepared,number:number.toString(),fund:addresses.fund.toBase58(),shares:addresses.shares.toBase58(),seedRaw:seed.toString()};
 }
 private async build(wallet:string,instructions:TransactionInstruction[],tables:NonNullable<Awaited<ReturnType<Connection['getAddressLookupTable']>>['value']>[],created:PublicKey[],solSpend=0n,priority='0'):Promise<PreparedSwap> {
  const deadline=await this.connection.getLatestBlockhash('confirmed');
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(wallet),recentBlockhash:deadline.blockhash,instructions}).compileToV0Message(tables));
  let bytes:Uint8Array;try{bytes=tx.serialize();}catch{throw new ApiFault(422,'route_too_large','This route cannot fund a vault in a single transaction');}
  if(bytes.length>1232)throw new ApiFault(422,'route_too_large','This route cannot fund a vault in a single transaction');
  const resolved=tx.message.getAccountKeys({addressLookupTableAccounts:tables});
  const writable=Array.from({length:resolved.length},(_,i)=>i).filter(i=>tx.message.isAccountWritable(i)).map(i=>resolved.get(i)!);
  const keys=[new PublicKey(wallet),...new Map([...created,...writable].filter(k=>k.toBase58()!==wallet).map(k=>[k.toBase58(),k])).values()];
  const [before,simulation,fee]=await Promise.all([this.connection.getMultipleAccountsInfo(keys),this.connection.simulateTransaction(tx,{sigVerify:false,accounts:{encoding:'base64',addresses:keys.map(k=>k.toBase58())}}),this.connection.getFeeForMessage(tx.message)]);
  if(simulation.value.err||!simulation.value.accounts||fee.value===null)throw new ApiFault(422,'vault_simulation_failed','Vault transaction simulation failed. Check your balance and network fees.');
  const rent=simulation.value.accounts.slice(1).reduce((sum,a,i)=>sum+(!before[i+1]&&a?BigInt(a.lamports):0n),0n);
  if(fee.value>1000000||rent>50000000n)throw new ApiFault(422,'fee_limit','Vault fees exceed server limits');
  if(BigInt(before[0]?.lamports??0)<solSpend+rent+BigInt(fee.value)+10000000n)throw new ApiFault(422,'insufficient_sol','Keep 0.01 SOL after funding, fees and account rent');
  return {transaction:Buffer.from(bytes).toString('base64'),blockhash:deadline.blockhash,lastValidBlockHeight:deadline.lastValidBlockHeight,fees:{networkFeeLamports:String(fee.value),priorityFeeLamports:priority,accountRentLamports:rent.toString()}};
 }
 async holdings(wallet:string,address:string) {
  const account=await this.connection.getAccountInfo(new PublicKey(address));if(!account||!account.owner.equals(LIVE_PROGRAM))throw new ApiFault(404,'vault_missing','Onchain vault not found');
  const fund=readFund(account.data),shares=shareAccount(new PublicKey(wallet),fund.shares);
  const accounts=await this.connection.getMultipleAccountsInfo([shares,...fund.holdings.map(m=>associatedAccount(address,m.toBase58()))]);
  const raw=(a:typeof accounts[number])=>a&&a.data.length>=165?a.data.readBigUInt64LE(64).toString():'0';
  return {sharesRaw:raw(accounts[0]!),holdings:fund.holdings.map((m,i)=>({mint:m.toBase58(),amountRaw:raw(accounts[i+1]!)}))};
 }
 async prepareExit(wallet:string,address:string) {
  // Exits remain available when creation is paused/disabled.
  if(await this.connection.getGenesisHash()!==N.genesisHash)throw new ApiFault(503,'wrong_cluster','Wrong vault network');
  const key=new PublicKey(address),account=await this.connection.getAccountInfo(key);
  if(!account||!account.owner.equals(LIVE_PROGRAM))throw new ApiFault(404,'vault_missing','Vault not found');
  const fund=readFund(account.data),owner=new PublicKey(wallet),a=fundAddresses(fund.captain.toBase58(),fund.number);
  if(!a.fund.equals(key))throw new ApiFault(503,'invalid_fund','Invalid vault address');
  const share=await this.connection.getAccountInfo(shareAccount(owner,fund.shares));
  const shares=share?.data.length&&share.data.length>=165?share.data.readBigUInt64LE(64):0n;
  if(!shares)throw new ApiFault(422,'no_shares','No shares available to withdraw');
  const mints=await this.connection.getMultipleAccountsInfo(fund.holdings);
  const setup:TransactionInstruction[]=[],remaining:ReturnType<typeof meta>[]=[],destinations:PublicKey[]=[];
  fund.holdings.forEach((mint,i)=>{
   const token=mints[i]?.owner;if(!token||!token.equals(TOKEN))throw new ApiFault(422,'unsupported_holding','This holding requires an updated withdrawal adapter');
   const dest=associatedAccount(wallet,mint.toBase58());destinations.push(dest);
   setup.push(new TransactionInstruction({programId:ATA,data:Buffer.from([1]),keys:[meta(owner,true,true),meta(dest,true),meta(owner),meta(mint),meta(SystemProgram.programId),meta(token)]}));
   remaining.push(meta(associatedAccount(address,mint.toBase58()),true),meta(dest,true),meta(mint));
  });
  const ix=new TransactionInstruction({programId:LIVE_PROGRAM,data:Buffer.concat([discriminator('global:exit'),u64(shares)]),keys:[meta(owner,false,true),meta(a.config),meta(key,true),meta(a.policy),meta(pda(Buffer.from('member'),key.toBuffer(),owner.toBuffer()),true),meta(fund.shares,true),meta(shareAccount(owner,fund.shares),true),meta(shareAccount(fund.captain,fund.shares),true),meta(TOKEN),meta(TOKEN2022),...remaining]});
  return {...await this.build(wallet,[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),...setup,ix],[],destinations),sharesRaw:shares.toString()};
 }
 verifySigned=verifySignedSwap;
 async broadcast(wire:string){await this.connection.sendRawTransaction(Buffer.from(wire,'base64'),{skipPreflight:false,maxRetries:3});}
 async observe(row:Parameters<LiveChain['observe']>[0]):ReturnType<LiveChain['observe']> {
  if(row.signature) {
   const s=(await this.connection.getSignatureStatuses([row.signature],{searchTransactionHistory:true})).value[0];
   if(s?.confirmationStatus==='finalized') {
    if(s.err)return 'failed';
    const tx=await this.connection.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    if(!tx?.meta)return 'pending';
    return !tx.meta.err&&Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(decodeWire(row.unsigned_transaction).message.serialize()))?'confirmed':'failed';
   }
   if(s)return 'pending';
  }
  return await this.connection.getBlockHeight('finalized')>Number(row.last_valid_block_height)?'expired':'pending';
 }
}
