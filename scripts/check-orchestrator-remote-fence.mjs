import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Pure, mocked execution of the EXACT production Edge guard. No network,
// Google Flow, uploads, token reads or publisher data mutations.
const src=fs.readFileSync(new URL('../supabase/functions/publisher-free-runtime/index.ts',import.meta.url),'utf8');
const start=src.indexOf('async function unresolvedRemoteMutation(');
const end=src.indexOf('\nasync function claim(',start);
assert.ok(start>0&&end>start,'deployed guard must be defined before claim');
const functionSource=src.slice(start,end).replace('publisherId:string,kind:string','publisherId,kind');
assert.match(src,/if\(await unresolvedRemoteMutation\(String\(p\.id\),kind\)\)continue;/);
assert.match(src,/historical_reconciliation_pending===true\)continue;/);
assert.match(src,/LEASE_EXPIRED_REMOTE_RECONCILIATION_REQUIRED/);
assert.match(src,/\.eq\("status","pending"\)\.eq\("last_error","RUNNER_LEASE_EXPIRED"\)/);

function testDb(rows,fail=false){
 return {from(table){
  assert.equal(table,'publisher_runtime_obligations');
  const filters=[],state={or:null};
  return {
   select(){return this},
   eq(k,v){filters.push([k,v]);return this},
   or(expr){state.or=expr;return this},
   limit(n){
    if(fail)return Promise.resolve({data:null,error:new Error('DATABASE_READ_FAILED')});
    let result=rows.filter(r=>filters.every(([k,v])=>r[k]===v));
    if(state.or){
     const needles=state.or.split(',').map(x=>x.split('.ilike.')[1].replaceAll('%','').toLowerCase());
     result=result.filter(r=>needles.some(x=>String(r.last_error||'').toLowerCase().includes(x)));
    }
    return Promise.resolve({data:result.slice(0,n),error:null});
   }
  };
 }};
}
async function run(rows,publisher='dinnie',kind='generation',fail=false){
 const fn=vm.runInNewContext(functionSource+'\nunresolvedRemoteMutation',{db:testDb(rows,fail)});
 return await fn(publisher,kind);
}
const row=(last_error,status='blocked',kind='generation',publisher_id='dinnie')=>({last_error,status,kind,publisher_id});
assert.equal(await run([row('LEGACY_LEASE_EXPIRED_REMOTE_RECONCILIATION_REQUIRED')]),true,'older ambiguous Generate blocks new day');
assert.equal(await run([row('LEASE_EXPIRED_REMOTE_RECONCILIATION_REQUIRED')]),true,'lease expiry is not submit proof');
assert.equal(await run([row('RUNTIME_CHILD_EXITED_RECONCILIATION_REQUIRED')]),true,'crash requires reconciliation');
assert.equal(await run([row('SUBMIT_AMBIGUOUS_REMOTE_ID_UNVERIFIED')]),true,'ambiguous submit cannot be replayed');
assert.equal(await run([row('RUNNER_LEASE_EXPIRED','pending')]),true,'legacy pending is not fresh work');
assert.equal(await run([row('WAITING_DAILY_FLOW_CREDIT_REFRESH')]),false,'credit wait is not ambiguous');
assert.equal(await run([row('FLOW_UNUSUAL_ACTIVITY_COOLDOWN')]),false,'verified no-charge has separate clock');
assert.equal(await run([row('LEASE_EXPIRED_REMOTE_RECONCILIATION_REQUIRED','blocked','publication')]),false,'independent approved publication not blocked by generation');
assert.equal(await run([row('LEASE_EXPIRED_REMOTE_RECONCILIATION_REQUIRED','blocked','generation','earth')]),false,'one publisher cannot block another');
assert.equal(await run([row('LEASE_EXPIRED_REMOTE_RECONCILIATION_REQUIRED','blocked','publication')],'dinnie','publication'),true,'ambiguous upload blocks later upload');
await assert.rejects(()=>run([], 'dinnie','generation',true),/DATABASE_READ_FAILED/);
console.log('PASS 11 real Edge guard cases: cross-day, cross-kind, publisher isolation, no-charge and fail-closed; zero remote calls.');
