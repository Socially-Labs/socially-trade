// Read-only deployment plan: no transaction is signed or sent.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { Connection,Keypair,PublicKey } from '@solana/web3.js';
import { LIVE_PROGRAM,fundAddresses } from '../dist/live-vault-chain.js';
import { SWAP_NETWORK as N } from '../dist/swap-types.js';
const root=new URL('../../../',import.meta.url);
const binary=await readFile(new URL('target/deploy/v1_core.so',root));
const program=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(new URL('target/deploy/v1_core-keypair.json',root),'utf8'))));
if(!program.publicKey.equals(LIVE_PROGRAM))throw Error('Program keypair does not match the reviewed source. Do not deploy.');
const deployer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(process.env.LIVE_VAULT_DEPLOYER_KEYPAIR??`${homedir()}/.config/solana/id.json`,'utf8'))));
const connection=new Connection(process.env.SOLANA_RPC_URL??process.env.DEVNET_RPC_URL??'https://api.devnet.solana.com',{commitment:'confirmed',fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10000)})});
if(await connection.getGenesisHash()!==N.genesisHash)throw Error('Deployment preflight requires devnet');
const [accounts,balance,rent]=await Promise.all([connection.getMultipleAccountsInfo([LIVE_PROGRAM,fundAddresses(deployer.publicKey.toBase58(),0n).config,new PublicKey(N.usdcMint)]),connection.getBalance(deployer.publicKey),connection.getMinimumBalanceForRentExemption(binary.length+45)]);
console.log(JSON.stringify({cluster:N.cluster,program:LIVE_PROGRAM.toBase58(),programKeypairMatches:true,binaryBytes:binary.length,binarySha256:createHash('sha256').update(binary).digest('hex'),deployer:deployer.publicKey.toBase58(),deployerLamports:String(balance),programExists:!!accounts[0],programExecutable:!!accounts[0]?.executable,configExists:!!accounts[1],circleMintExists:!!accounts[2],estimatedProgramRentLamports:String(rent),note:'New deployment also needs a temporary upload buffer, transaction fees and config rent; no funds were sent.'},null,2));
