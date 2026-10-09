// Defaults to simulation. --send is an explicit deployment operation.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { Connection,Keypair,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction } from '@solana/web3.js';
import { LIVE_PROGRAM,fundAddresses } from '../dist/live-vault-chain.js';
import { SWAP_NETWORK as N } from '../dist/swap-types.js';
const signer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(process.env.LIVE_VAULT_DEPLOYER_KEYPAIR??`${homedir()}/.config/solana/id.json`,'utf8'))));
const connection=new Connection(process.env.SOLANA_RPC_URL??process.env.DEVNET_RPC_URL??'https://api.devnet.solana.com',{commitment:'confirmed',fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(10000)})});
if(await connection.getGenesisHash()!==N.genesisHash)throw Error('Config initialization requires devnet');
const config=fundAddresses(signer.publicKey.toBase58(),0n).config;
const [program,existing]=await connection.getMultipleAccountsInfo([LIVE_PROGRAM,config]);
if(existing){if(!existing.owner.equals(LIVE_PROGRAM)||existing.data.length<74||new PublicKey(existing.data.subarray(40,72)).toBase58()!==N.usdcMint)throw Error('Existing config is incompatible; no changes made');console.log('Config already initialized with Circle devnet USDC');process.exit(0);}
if(!program?.executable||program.data.length<36||program.data.readUInt32LE(0)!==2)throw Error('Deploy the reviewed upgradeable program before initializing config');
const programData=new PublicKey(program.data.subarray(4,36));
const state=await connection.getAccountInfo(programData);
if(!state||state.data.length<45||state.data[12]!==1||!new PublicKey(state.data.subarray(13,45)).equals(signer.publicKey))throw Error('The deployment wallet is not the program upgrade authority');
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
const instruction=new TransactionInstruction({programId:LIVE_PROGRAM,data:createHash('sha256').update('global:initialize_config').digest().subarray(0,8),keys:[meta(signer.publicKey,true,true),meta(config,true),meta(new PublicKey(N.usdcMint)),meta(LIVE_PROGRAM),meta(programData),meta(SystemProgram.programId)]});
const deadline=await connection.getLatestBlockhash();
const tx=new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:deadline.blockhash,instructions:[instruction]}).compileToV0Message());
tx.sign([signer]);const simulation=await connection.simulateTransaction(tx,{sigVerify:true});
if(simulation.value.err)throw Error('Config initialization simulation failed; nothing sent');
if(!process.argv.includes('--send')){console.log('Config initialization simulation passed; nothing sent. Use --send only after deployment approval.');process.exit(0);}
const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
console.log(JSON.stringify({signature,config:config.toBase58()}));
const result=await connection.confirmTransaction({...deadline,signature},'finalized');if(result.value.err)throw Error('Initialization failed onchain');
console.log('Config finalized with Circle devnet USDC');
