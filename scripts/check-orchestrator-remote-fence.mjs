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
// Execute the EXACT Edge publication phase functions with mocked local time.
// This catches the old bug where a pending YouTube upload could be claimed at
// 19:00, and a staged video's release vanished after approved_stock reached 0.
const phaseStart=src.indexOf('function youtubePublicationPhase(');
const phaseEnd=src.indexOf('\nconst FLOW_BACKOFF_MINUTES',phaseStart);
assert.ok(phaseStart>0&&phaseEnd>phaseStart,'YouTube two-stage functions are present');
const phaseSource=src.slice(phaseStart,phaseEnd).replaceAll('p:any','p');
function evaluatePhase(clock,p){
 const functions=vm.runInNewContext(phaseSource+'\n({youtubePublicationPhase,publicationDue})',{localClock:()=>clock});
 return {phase:functions.youtubePublicationPhase(p),due:functions.publicationDue(p)};
}
const youtube=(stock)=>({platform:'youtube',timezone:'America/Argentina/Buenos_Aires',approved_stock:stock});
const facebook=(stock)=>({platform:'facebook',timezone:'America/Argentina/Buenos_Aires',approved_stock:stock,config:{schedule:{posting_times:['19:00']}}});
for(const [clock,stock,phase,due] of [
 ['12:29',1,'none',false],['12:30',1,'stage',true],
 ['12:59',1,'stage',true],['13:00',1,'none',false],
 ['18:59',1,'none',false],['19:00',1,'release',true],
 ['19:00',0,'release',true],['23:59',0,'release',true],
 ['12:30',0,'none',false]
]){
 const got=evaluatePhase(clock,youtube(stock));
 assert.equal(got.phase,phase,'YouTube phase '+clock+' stock='+stock);
 assert.equal(got.due,due,'YouTube due '+clock+' stock='+stock);
}
assert.equal(evaluatePhase('19:00',facebook(0)).due,false,'Facebook needs approved stock');
assert.equal(evaluatePhase('19:00',facebook(1)).due,true,'Facebook schedule still works');
assert.match(src,/const youtubePhase=kind==="publication"/,'claim distinguishes YouTube phases');
assert.match(src,/if\(!q\.data && youtubePhase!=="release"\)\{/,'19:00 may never claim fresh pending upload');
assert.match(src,/if\(!q\.data && youtubePhase==="release"\)\{/,'19:00 reclaims staged PRIVATE video');
assert.match(src,/\.eq\("status","blocked"\)\.eq\("last_error","YOUTUBE_PRIVATE_STAGED_WAITING_19"\)/,'only exact staged obligation is eligible');
console.log('PASS 11 mocked YouTube/Facebook clock-stock cases plus four phase fences; zero remote calls.');
// Exercise the exact Edge materializer without a network connection.
const matStart=src.indexOf('async function materialize(){');
const matEnd=src.indexOf('\nasync function releaseExpired(){',matStart);
assert.ok(matStart>0&&matEnd>matStart,'today-only materializer present');
const materializeSource=src.slice(matStart,matEnd).replace('const rows:any[]=[];','const rows=[];');
async function testMaterialize(){
 const calls=[];
 const publishers=[
  {id:'frutti',timezone:'America/Argentina/Buenos_Aires',activation_day:'2026-10-06',generation_target:3,publication_target:1},
  {id:'future',timezone:'America/Argentina/Buenos_Aires',activation_day:'2026-11-11',generation_target:3,publication_target:1}
 ];
 const mock={
  from(table){
   if(table==='publisher_runtime_publishers')return {
    select(){return this},eq(){return Promise.resolve({data:publishers,error:null})}
   };
   assert.equal(table,'publisher_runtime_obligations');
   return {upsert(rows,options){calls.push({rows,options});return Promise.resolve({error:null})}};
  }
 };
 const fn=vm.runInNewContext(materializeSource+'\nmaterialize',{
  db:mock,localDay:()=> '2026-11-10',now:()=> '2026-11-10T10:00:00Z'
 });
 await fn();
 assert.equal(calls.length,1,'one bulk upsert, not hundreds of per-day calls');
 assert.equal(calls[0].rows.length,4,'only today's three generations and one publication');
 assert.ok(calls[0].rows.every(r=>r.local_day==='2026-11-10'&&r.publisher_id==='frutti'),'no historic catch-up or future activation');
 assert.equal(calls[0].options.ignoreDuplicates,true,'never overwrite durable claimed/blocked/completed state');
 assert.equal(calls[0].options.onConflict,'publisher_id,local_day,kind,ordinal','stable obligation identity');
}
await testMaterialize();
console.log('PASS idempotent today-only materialization with preserved historic/claimed obligations; zero remote calls.');


console.log('PASS 11 real Edge guard cases: cross-day, cross-kind, publisher isolation, no-charge and fail-closed; zero remote calls.');
