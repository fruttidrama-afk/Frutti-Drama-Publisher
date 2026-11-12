import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Pure, mocked execution of the EXACT production Edge guard. No network,
// Google Flow, uploads, token reads or publisher data mutations.
const src=fs.readFileSync(new URL('../supabase/functions/publisher-free-runtime/index.ts',import.meta.url),'utf8');
const start=src.indexOf('async function unresolvedRemoteMutation(');
const end=src.indexOf('\nasync function claim(',start);
assert.ok(start>0&&end>start,'deployed guard must be defined before claim');
const functionSource=src.slice(start,end).replace('publisherId:string,kind:string','publisherId,kind').replace('videoId:string,itemId:string','videoId,itemId');
assert.match(src,/if\(await unresolvedRemoteMutation\(String\(p\.id\),kind\)\)continue;/);
assert.match(src,/historical_reconciliation_pending===true\)continue;/);
assert.match(src,/if\(String\(p\.migration_state\|\|""\)!=="ready"\)continue;/,
  'only independently validated ready publishers can be claimed');
assert.doesNotMatch(src,/\["ready","profile_uploaded","auth_verified"\]\.includes\(migrationState\)/,
  'scheduler must not auto-promote unverified publisher profiles');
assert.doesNotMatch(src,/p\.migration_state="ready"/,
  'claim cannot mutate migration state without a cold restore');

// A profile PUT must not bypass cold-restore verification. Exercise the exact
// Edge state-transition helper with no network, profile or production writes.
const migrationStart=src.indexOf('function nextMigrationStateAfterProfileUpload(');
const migrationEnd=src.indexOf('\nfunction objectPath(',migrationStart);
assert.ok(migrationStart>0&&migrationEnd>migrationStart,'profile upload gate must exist');
const migrationSource=src.slice(migrationStart,migrationEnd).replace('current:string','current');
const migrationFn=vm.runInNewContext(migrationSource+'\nnextMigrationStateAfterProfileUpload');
for(const [before,after] of [
 ['profile_required','profile_uploaded'],
 ['profile_uploaded','profile_uploaded'],
 ['auth_verified','auth_verified'],
 ['ready','ready'],
 ['','profile_uploaded'],
 ['unknown','profile_uploaded']
])assert.equal(migrationFn(before),after,'profile upload cannot grant ready from '+before);
assert.match(src,/const next=nextMigrationStateAfterProfileUpload\(String\(cur\.data\?\.migration_state\|\|""\)\)/,
 'profile PUT must call the guarded state-transition helper');
console.log('PASS six profile-upload migration gates: only preverified ready remains ready; no remote calls.');

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
const phaseSource=src.slice(phaseStart,phaseEnd).replaceAll('p:any','p').replace('videoId:string,itemId:string','videoId,itemId');
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
assert.match(src,/if\(youtubePhase==="release"&&!validYoutubeStageIdentity\(/,'19:00 requires exact saved remote identity');
assert.match(src,/YOUTUBE_STAGE_IDENTITY_PROOF_REQUIRED/,'12:30 callback requires verified video ID and SQLite item ID');
assert.match(src,/stageProof\.remote_video_id=remoteVideoId/,'stage ID is saved durably on obligation');
assert.match(src,/YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED/,'legacy or mismatched release is frozen');
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
 assert.equal(calls[0].rows.length,4,"only today\u0027s three generations and one publication");
 assert.ok(calls[0].rows.every(r=>r.local_day==='2026-11-10'&&r.publisher_id==='frutti'),'no historic catch-up or future activation');
 assert.equal(calls[0].options.ignoreDuplicates,true,'never overwrite durable claimed/blocked/completed state');
 assert.equal(calls[0].options.onConflict,'publisher_id,local_day,kind,ordinal','stable obligation identity');
}
await testMaterialize();
console.log('PASS idempotent today-only materialization with preserved historic/claimed obligations; zero remote calls.');


// Public runtime health must not expose publisher names, errors, status,
// stock or obligations. Execute the exact production function with a mock DB.
const healthStart=src.indexOf('async function health(){');
const healthEnd=src.indexOf('\n// Owner-restricted productivity',healthStart);
assert.ok(healthStart>0&&healthEnd>healthStart,'public health implementation present');
const healthSource=src.slice(healthStart,healthEnd);
assert.ok(!/last_error|approved_stock|last_generation_at|last_publication_at|obligations|p\.data/.test(healthSource),
  'anonymous health must not return private publisher state');
assert.match(healthSource,/head:true,count:"exact"/,'health verifies DB with HEAD-only probe');
let healthProbes=0;
const healthDb={from(table){
 assert.equal(table,'publisher_runtime_publishers');
 return {select(column,options){
  assert.equal(column,'id');assert.equal(options.head,true);healthProbes++;
  return Promise.resolve({error:null});
 }};
}};
const healthFn=vm.runInNewContext(healthSource+'\nhealth',{
 db:healthDb,now:()=> '2026-11-10T22:00:00Z',
 J:(payload)=>payload
});
const healthPayload=await healthFn();
assert.deepEqual(Object.keys(healthPayload).sort(),['at','ok','version'],'health exposes liveness only');
assert.equal(healthProbes,1,'health performs exactly one read-only database probe');
console.log('PASS anonymous health privacy and DB liveness; no network calls.');
// The private watchdog status is deliberately NOT part of public /health.
// It is exposed only to the dedicated workflow-scoped GitHub OIDC identity.
assert.match(src,/if\(suffix==="\/status"&&req\.method==="GET"\)\{/);
assert.match(src,/await githubIdentity\(req,"\.github\/workflows\/publisher-productivity-watchdog\.yml"\)/);
assert.match(src,/const claims=await githubIdentity\(req\);/,'production mutations still require the runner identity');
assert.match(src,/if\(wf!==REPO\+"\/"\+workflowPath\+"@refs\/heads\/main"\)/);
const privateStart=src.indexOf('async function privateStatus(){');
const privateEnd=src.indexOf('\nDeno.serve(',privateStart);
assert.ok(privateStart>healthEnd&&privateEnd>privateStart);
const privateFn=vm.runInNewContext(src.slice(privateStart,privateEnd)+'\nprivateStatus',{
 db:{from(table){
  assert.equal(table,'publisher_runtime_publishers');
  return {select(columns){
   assert.equal(columns,'name,enabled,migration_state,last_generation_at,last_publication_at,approved_stock');
   return {order(field){assert.equal(field,'name');return Promise.resolve({data:[{name:'FruttiDrama',enabled:true}],error:null})}};
  }};
 }},J:x=>x
});
assert.deepEqual(JSON.parse(JSON.stringify(await privateFn())),{ok:true,publishers:[{name:'FruttiDrama',enabled:true}]});
console.log('PASS OIDC-isolated watchdog status, public health remains redacted; no remote calls.');

console.log('PASS 11 real Edge guard cases: cross-day, cross-kind, publisher isolation, no-charge and fail-closed; zero remote calls.');
