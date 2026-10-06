import assert from 'node:assert/strict';
import test from 'node:test';
import { LogCollector } from '@socially/logging';
import { createApp } from '../dist/app.js';

test('pre-login diagnostics capture safe unverified failures and reject extra data',async()=>{
  const logs=new LogCollector('api',{redisUrl:null});
  const app=createApp(null,{logs});
  const payload={operation:'send',platform:'android',code:'invalid_app_client',status:403};
  try {
    const response=await app.inject({method:'POST',url:'/v0/auth/client-events',payload});
    assert.equal(response.statusCode,204);
    const entries=await logs.read({search:'Privy client authentication failed'});
    assert.equal(entries.entries.length,1);
    assert.deepEqual(entries.entries[0].details.authFailure,payload);
    assert.equal(entries.entries[0].details.source,'unverified-mobile-client');
    for(const extra of [{email:'person@example.com'},{otp:'123456'},{token:'secret'},{code:'Bearer secret.token'},{status:200}]){
      assert.equal((await app.inject({method:'POST',url:'/v0/auth/client-events',payload:{...payload,...extra}})).statusCode,400);
    }
    for(let i=0;i<9;i++)assert.equal((await app.inject({method:'POST',url:'/v0/auth/client-events',payload})).statusCode,204);
    assert.equal((await app.inject({method:'POST',url:'/v0/auth/client-events',payload})).statusCode,429);
  }finally{await app.close();}
});
