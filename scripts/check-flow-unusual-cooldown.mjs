import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const provider=repoFile('free-browser-provider.js');
const runner=repoFile('scripts/free-runtime-runner-v2.mjs');
const readUI=repoFile('docs/index.html');
for(const [label,ok] of [
 ['Account-wide preservation',provider.includes("flow:transientCooldownUntil")],
 ['Same no-charge episode kept as head-of-line',provider.includes("prior_generation_id:run,generation_id:null")&&provider.includes("status=?,providerRunId=NULL,runtimeAttemptCount=0")],
 ['Explicit proof only',provider.includes("opts.confirmed!==true")&&provider.includes("confirmed:true,reason:'Flow UI reported unusual activity")],
 ['Monotonic deadline linked to tested module',provider.includes("flowNoChargeDeadline(previousUntil,Date.now(),streak)")],
 ['Provider never bypasses even manual Submit and REDO',provider.includes("if(providerCooldown>Date.now())return null")&&provider.includes("if(until>Date.now())")],
 ['One submit intent lock still present',provider.includes("reserveGenerateBoundary(db,row,genId)")],
 ['Runner records no-charge once after state is saved',runner.indexOf("await uploadBlob('state',publisherId,packState())")<runner.indexOf("flow_no_charge_confirmed:true")],
 ['Server rejects callback without confirmed no-charge',edge.includes("FLOW_NO_CHARGE_PROOF_REQUIRED")],
 ['Server holds every generation while paused',edge.includes("Date.parse(cd.not_before)>Date.now())continue")],
 ['Server restores blocked same obligation before fresh next episode',edge.includes("FLOW_UNUSUAL_ACTIVITY_COOLDOWN")],
 ['Server cooldown persists outside ephemeral runner',edge.includes("publisher_runtime_flow_cooldowns")],
 ['24h remains the cap after sixth alert',edge.includes("FLOW_BACKOFF_MINUTES=[30,60,120,240,480,1440]")],
 ['Fresh obligations cannot pass active provider deadline',edge.includes("if(cd?.not_before&&Date.parse(cd.not_before)>Date.now())continue")],
 ['Panel shows final 24h alert',readUI.includes("ATENCIÓN · GOOGLE FLOW EN PAUSA PROTECTORA DE 24 HORAS")],
 ['Panel shows exact retry time',readUI.includes("new Date(deadline).toLocaleString")],
 ['Google security challenge still demands real human review',provider.includes("setProviderSecurityHold(db,row,'FLOW_SECURITY_MANUAL_REVIEW_REQUIRED')")],
]){
 assert.ok(ok,'FAILED '+label); console.log('PASS',label);
}
console.log('PASS account-wide 30m,1h,2h,4h,8h,24h+ schedule; 24h repeats, no skip, no video calls');
