// Offline cross-publisher Flow mutex regression. All processes and lock files
// are synthetic and local. Never opens a browser, accesses Flow or creates media.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {createFlowMutex} from '../flow-global-mutex.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-flock-test-'));
const file=path.join(root,'flow.lock');
const first=createFlowMutex(file),second=createFlowMutex(file),third=createFlowMutex(file);
try{
  assert.equal(await first.acquire(),true,'First publisher failed to acquire OS lock (flock missing?)');
  assert.equal(first.owned(),true,'First publisher did not hold kernel lock');
  assert.equal(await second.acquire(),false,'Second publisher acquired mutex while first is alive');
  assert.equal(await third.acquire(),false,'Third publisher acquired mutex while first is alive');
  // Old implementation would unlink after 120s. Kernel flock must remain
  // exclusive even when an owner lock file appears weeks old.
  const monthAgo=new Date(Date.now()-30*24*60*60*1000);
  fs.utimesSync(file,monthAgo,monthAgo);
  assert.equal(await second.acquire(),false,'Stale mtime incorrectly stole a live kernel lock');
  assert.equal(await first.acquire(),false,'A worker must not reenter its own Flow lock');
  first.release();
  let acquired=false;
  for(let i=0;i<50;i++){
    await delay(50);
    if(await second.acquire()){acquired=true;break}
  }
  assert.equal(acquired,true,'Kernel Flow mutex did not become available after owner death');
  assert.equal(await third.acquire(),false,'Third publisher bypassed second owner');
  second.release();
  let recovered=false;
  for(let i=0;i<50;i++){
    await delay(50);
    if(await third.acquire()){recovered=true;break}
  }
  assert.equal(recovered,true,'Kernel Flow lock leaked after release');
  third.release();

  // Crash test: a separately spawned publisher process is killed with
  // SIGKILL, not a graceful release(). Its inherited stdin pipe must close
  // so the no-fork kernel lock holder exits automatically.
  const crashCode=[
    "import {createFlowMutex} from './flow-global-mutex.mjs';",
    "const m=createFlowMutex(process.argv[1]);",
    "if(!await m.acquire())process.exit(22);",
    "process.stdout.write('HOLDER_LOCKED\\n');",
    "await new Promise(()=>{});"
  ].join('\n');
  const holder=spawn(process.execPath,['--input-type=module','-e',crashCode,file],{
    cwd:process.cwd(),stdio:['ignore','pipe','pipe']
  });
  let seen=false,detail='';
  await Promise.race([
    new Promise((resolve,reject)=>{
      holder.stdout.on('data',b=>{
        detail+=String(b);
        if(detail.includes('HOLDER_LOCKED')){seen=true;resolve()}
      });
      holder.on('exit',(code)=>reject(Error('Holder exited before lock confirmation: '+code)));
      holder.on('error',reject);
    }),
    delay(4000).then(()=>{throw Error('Timed out waiting for crash fixture')})
  ]);
  assert.equal(seen,true,'Crash fixture never held kernel lock');
  assert.equal(await first.acquire(),false,'Concurrent publisher entered crashed holder lock');
  holder.kill('SIGKILL');
  await new Promise(resolve=>holder.once('close',resolve));
  let crashReleased=false;
  for(let i=0;i<50;i++){
    await delay(50);
    if(await first.acquire()){crashReleased=true;break}
  }
  assert.equal(crashReleased,true,'OS lock survived parent SIGKILL (orphan holder)');
  first.release();

  const absent=createFlowMutex('');
  assert.equal(await absent.acquire(),false,'No shared lock path must fail closed');
  console.log('[GLOBAL FLOW MUTEX OFFLINE] PASS',JSON.stringify({
    providers:3,simultaneous_owners:1,stale_mtime:'cannot_reclaim',
    release:'kernel_lock_released',parent_sigkill:'auto_released',empty_path:'fail_closed',external_calls:0
  }));
}catch(e){
  console.error('[GLOBAL FLOW MUTEX OFFLINE] FAIL',String(e?.stack||e));
  process.exitCode=1;
}finally{
  first.release();second.release();third.release();
  fs.rmSync(root,{recursive:true,force:true});
}
