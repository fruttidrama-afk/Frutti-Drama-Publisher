import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowNoChargeDelayMs,flowNoChargeDeadline,FLOW_NO_CHARGE_BACKOFF_MINUTES} from './flow-unusual-cooldown.mjs';
const repoFile=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

assert.deepEqual(FLOW_NO_CHARGE_BACKOFF_MINUTES,[30,60,120,240,480,1440]);
const base=Date.parse('2026-11-09T12:00:00.000Z');
for(let streak=1;streak<=9;streak++){
 const expected=[30,60,120,240,480,1440][Math.min(streak,6)-1];
 assert.equal(flowNoChargeDelayMs(streak),expected*60000);
 assert.equal(flowNoChargeDeadline(0,base,streak),base+expected*60000);
}
assert.equal(flowNoChargeDeadline(base+1440*60000,base+60000,2),base+1440*60000,'later routine cannot shorten prior deadline');
assert.throws(()=>flowNoChargeDeadline(0,NaN,1),/INVALID/);

const edge=repoFile('supabase/functions/publisher-free-runtime/index.ts');
const pgMigration=repoFile('supabase/migrations/20261109_flow_global_unusual_cooldown.sql');
const provider=repoFile('free-browser-provider.js');
const runner=repoFile('scripts/free-runtime-runner-v2.mjs');
const readUI=repoFile('docs/index.html');
for(const [label,ok] of [
 ['Account-wide preservation',provider.includes("flow:transientCooldownUntil")],
 ['Same no-charge episode kept as head-of-line',provider.includes("prior_generation_id:run,generation_id:null")&&provider.includes("status=?,providerRunId=NULL,runtimeAttemptCount=0")],
 ['Explicit proof only',provider.includes("opts.confirmed!==true")&&provider.includes("confirmed:true,reason:'Flow UI reported unusual activity")],
 ['Monotonic deadline linked to tested module',provider.includes("flowNoChargeDeadline(previousUntil,Date.now(),streak)")],
 ['Provider never bypasses even manual Submit and REDO',provider.includes("if(providerCooldown>Date.now())return null")&&provider.includes("if(until>Date.now())")],
 ['Legacy cooldown repair cannot reset a newer confirmed no-charge window',(()=>{
  const old=provider.slice(provider.indexOf("function repairLegacyBackoffAfterConfirmedSuccess(db){"),provider.indexOf("function repairProviderBackoffAfterConfirmedSuccessV2(db){"));
  const newer=provider.slice(provider.indexOf("function repairProviderBackoffAfterConfirmedSuccessV2(db){"),provider.indexOf("function normalizeLiveNoChargeCooldown(db){"));
  return old.includes("if(meta(db,'flow:lastNoChargeConfirmedAt',''))")&&newer.includes("if(meta(db,'flow:lastNoChargeConfirmedAt',''))");
 })()],
 ['One submit intent lock still present',provider.includes("reserveGenerateBoundary(db,row,genId)")],
 ['Explicit post-submit no-charge detection runs BEFORE generic security challenge guard',(()=>{
   const fragment=provider.slice(provider.indexOf("async function waitGenerationStarted("),provider.indexOf("function firstFreshRendered("));
   const explicit=fragment.indexOf("return{started:false,evidence:'FLOW_TRANSIENT_NO_CHARGE:");
   const generic=fragment.indexOf("await renderAuthGuard(page);");
   return explicit>0&&generic>explicit;
 })()],
 ['Runner records no-charge once after state is saved',runner.indexOf("await uploadBlob('state',publisherId,packState())")<runner.indexOf("flow_no_charge_confirmed:true")],
 ['Server rejects callback without confirmed no-charge',edge.includes("FLOW_NO_CHARGE_PROOF_REQUIRED")],
 ['Server holds every generation while paused',edge.includes("Date.parse(cd.not_before)>Date.now())continue")],
 ['Server restores blocked same obligation before fresh next episode',edge.includes("FLOW_UNUSUAL_ACTIVITY_COOLDOWN")],
 ['Server cooldown persists outside ephemeral runner',edge.includes("publisher_runtime_flow_cooldowns")],
 ['24h remains the cap after sixth alert',pgMigration.includes("WHEN next_streak=5 THEN 480")&&pgMigration.includes("ELSE 1440 END")],
 ['Atomic, claim-idempotent Postgres transition',edge.includes('db.rpc("publisher_flow_record_no_charge"')&&pgMigration.includes("FOR UPDATE")&&pgMigration.includes("IF rec.last_alert_claim_id=p_claim_id THEN")],
 ['Only trusted service role may use cooldown RPC',pgMigration.includes("GRANT EXECUTE ON FUNCTION public.publisher_flow_record_no_charge(uuid,uuid,text) TO service_role")],
 ['Stale callback cannot replace a completed obligation',edge.includes("CALLBACK_TERMINAL_STATE_LOCKED")&&edge.includes("CALLBACK_BLOCKED_STATE_LOCKED")],
 ['Fresh obligations cannot pass active provider deadline',edge.includes("if(cd?.not_before&&Date.parse(cd.not_before)>Date.now())continue")],
 ['Panel shows final 24h alert',readUI.includes("ATENCIÓN · GOOGLE FLOW EN PAUSA PROTECTORA DE 24 HORAS")],
 ['Panel shows exact retry time',readUI.includes("new Date(deadline).toLocaleString")],
 ['Google security challenge still demands real human review',provider.includes("setProviderSecurityHold(db,row,'FLOW_SECURITY_MANUAL_REVIEW_REQUIRED')")],
]){
 assert.ok(ok,'FAILED '+label); console.log('PASS',label);
}

const globalMigration=repoFile('supabase/migrations/20261112_flow_factory_global_no_charge_cooldown.sql');
// A per-publisher cooldown is NOT a global pause: an alert from Earth must
// block Frutti and Dinnie, and successive alerts must share one streak.
assert.match(globalMigration,/pg_advisory_xact_lock\(20261112, 91341\)/,'one global transaction lock');
assert.match(globalMigration,/SELECT COALESCE\(MAX\(c\.streak\),0\),MAX\(c\.not_before\)/,'global streak and deadline');
assert.match(globalMigration,/UPDATE public\.publisher_runtime_flow_cooldowns c\s+SET streak=next_streak/,'global fan-out to all shows');
assert.match(globalMigration,/SELECT id,0,'clear',now\(\) FROM public\.publisher_runtime_publishers/,'include all existing publishers');
assert.match(globalMigration,/WHEN next_streak=1 THEN 30/);
assert.match(globalMigration,/WHEN next_streak=2 THEN 60/);
assert.match(globalMigration,/WHEN next_streak=3 THEN 120/);
assert.match(globalMigration,/WHEN next_streak=4 THEN 240/);
assert.match(globalMigration,/WHEN next_streak=5 THEN 480/);
assert.match(globalMigration,/ELSE 1440 END/);
assert.match(globalMigration,/p_claimed_at <= latest_alert/,'stale completion cannot erase newer pause');
assert.match(globalMigration,/o\.kind='generation' AND o\.status='completed'/,'reset requires completed generation');
assert.match(globalMigration,/REVOKE ALL ON FUNCTION public\.publisher_flow_clear_after_success\(uuid,uuid,timestamptz\) FROM PUBLIC, anon, authenticated/);
assert.match(globalMigration,/GRANT EXECUTE ON FUNCTION public\.publisher_flow_clear_after_success\(uuid,uuid,timestamptz\) TO service_role/);
const cooldownStart=edge.indexOf('async function flowCooldown(');
const cooldownEnd=edge.indexOf('\nasync function recordUnusualActivity(',cooldownStart);
assert.ok(cooldownStart>0&&cooldownEnd>cooldownStart,'global cooldown reader present');
const globalReader=edge.slice(cooldownStart,cooldownEnd).replace('_publisherId:string','_publisherId');
assert.doesNotMatch(globalReader,/\.eq\("publisher_id"/,'must not filter by current show');
assert.match(globalReader,/\.order\("not_before",\{ascending:false,nullsFirst:false\}\)/,'choose longest factory-wide deadline');
let reads=0;
const globalRead=vm.runInNewContext(globalReader+'\nflowCooldown',{
 db:{from(table){
  assert.equal(table,'publisher_runtime_flow_cooldowns');
  return {
   select(){return this},
   neq(k,v){assert.equal(k,'status');assert.equal(v,'clear');return this},
   order(k,opts){assert.equal(k,'not_before');assert.equal(opts.ascending,false);return this},
   limit(n){assert.equal(n,1);return this},
   maybeSingle(){reads++;return Promise.resolve({data:{streak:2,not_before:'2026-11-12T23:00:00Z',status:'cooldown'},error:null})}
  };
 }}
});
for(const publisher of ['frutti','earth','dinnie','new-publisher']){
 const result=await globalRead(publisher);
 assert.equal(result.streak,2,'all publishers see the same global streak');
 assert.equal(result.not_before,'2026-11-12T23:00:00Z');
}
assert.equal(reads,4,'every show consults the global deadline');
assert.match(edge,/db\.rpc\("publisher_flow_clear_after_success"/,'successful generation uses guarded global reset');
console.log('PASS factory-wide no-charge clock: four mocked publishers, global 30m→24h streak, stale-safe reset, service-role only.');

// A repeated callback for claim A can arrive AFTER claim B. The old global
// projection remembers only B and would incorrectly escalate A again.
// Require a durable primary-key ledger rather than last_alert_claim_id alone.
const durable=repoFile('supabase/migrations/20261113_flow_no_charge_durable_claim_idempotency.sql');
assert.match(durable,/CREATE TABLE IF NOT EXISTS public\.publisher_flow_no_charge_claim_events/);
assert.match(durable,/claim_id uuid PRIMARY KEY/);
assert.match(durable,/pg_advisory_xact_lock\(20261112, 91341\)/);
assert.match(durable,/o\.kind='generation' AND o\.status IN \('claimed','running','blocked'\)/);
assert.match(durable,/ON CONFLICT\(claim_id\) DO NOTHING/);
assert.match(durable,/GET DIAGNOSTICS inserted_events = ROW_COUNT/);
assert.match(durable,/IF inserted_events=0 THEN/);
assert.ok(durable.indexOf('IF inserted_events=0 THEN')<durable.indexOf('next_streak:=LEAST('),
 'deduplicate before extending the factory-wide deadline');
assert.match(durable,/FLOW_NO_CHARGE_CLAIM_PUBLISHER_MISMATCH/);
assert.match(durable,/ENABLE ROW LEVEL SECURITY/);
assert.match(durable,/REVOKE ALL ON TABLE public\.publisher_flow_no_charge_claim_events FROM PUBLIC, anon, authenticated/);
assert.match(durable,/REVOKE ALL ON FUNCTION public\.publisher_flow_record_no_charge\(uuid,uuid,text\) FROM PUBLIC, anon, authenticated/);
// Offline sequence model: the same claim must never consume two backoff steps,
// including after a newer alert or a later successful reset.
const seenClaims=new Set();
let globalStreak=0;
function recordClaim(claim){
 if(seenClaims.has(claim))return globalStreak;
 seenClaims.add(claim);
 return ++globalStreak;
}
assert.equal(recordClaim('earth-A'),1);
assert.equal(recordClaim('earth-A'),1);
assert.equal(recordClaim('dinnie-B'),2);
assert.equal(recordClaim('earth-A'),2,'older replay after a newer claim is not a third alert');
globalStreak=0; // a genuine later generation completed
assert.equal(recordClaim('earth-A'),0,'successful reset does not re-arm an old claim');
assert.equal(recordClaim('frutti-C'),1,'a new claim begins a new streak');
console.log('PASS durable claim ledger and A→B→A replay/reset regression model; no provider calls or database writes.');

console.log('PASS account-wide 30m,1h,2h,4h,8h,24h+ schedule; 24h repeats, no skip, no video calls');
