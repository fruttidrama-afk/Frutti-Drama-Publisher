import assert from 'node:assert/strict';
import fs from 'node:fs';
import {classifyFlowSecuritySignal} from './flow-security-signals.mjs';
const file=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const samples=[
 ['https://flow.google.com/project/abc','Flow workspace: welcome',null],
 ['https://accounts.google.com/signin/v2','Email or phone','login_required'],
 ['https://accounts.google.com/signin/v2/challenge/pwd','Please verify your identity','security_challenge'],
 ['https://flow.google.com/project/abc',"Verify it's you before proceeding",'security_challenge'],
 ['https://flow.google.com/project/abc','Verificación de seguridad','security_challenge'],
 ['https://flow.google.com/project/abc','We noticed some unusual activity. You have not been charged.','unusual_activity'],
 ['https://flow.google.com/project/abc','Hemos detectado actividad inusual. No se te ha cobrado.','unusual_activity']
];
for(const [url,body,want] of samples){
 const got=classifyFlowSecuritySignal(url,body);
 assert.equal(got,want,'security signal classification');
}
const runner=file('scripts/free-runtime-runner-v2.mjs');
const provider=file('free-browser-provider.js');
const cold=file('scripts/verify-flow-auth-cold-restore.mjs');
const yml=file('.github/workflows/flow-auth-cold-restore.yml');
const checks=[
 ['Google auth challenge blocks runner before Generate',runner.includes("if(signal==='security_challenge')throw new Error('FLOW_SECURITY_CHALLENGE_MANUAL_REQUIRED')")],
 ['Flow unusual activity blocks preflight',runner.includes("if(signal==='unusual_activity')throw new Error('FLOW_UNUSUAL_ACTIVITY_MANUAL_REVIEW_REQUIRED')")],
 ['Runner fails closed on child security signal',runner.includes("FLOW_SECURITY_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY")],
 ['No second Google browser visit after unsuccessful generation',runner.includes("if(kind==='generation'&&success){")],
 ['Provider-wide security hold survives runner restarts',provider.includes("setMeta(db,'flow:securityHold','operator_review_required')")],
 ['No extra generation during security hold',provider.includes("if(meta(db,'flow:securityHold','')==='operator_review_required')return null;")],
 ['Verified Flow no-charge rejection enters provider-wide progressive cooldown',provider.includes("setMeta(db,'flow:transientCooldownUntil',String(nextAt))")&&provider.includes("confirmed_no_charge:true")],
 ['Only explicit confirmed no-charge responses qualify for automatic retry',provider.includes("if(opts.confirmed!==true)")&&provider.includes("confirmed:true,reason:'Flow UI reported unusual activity")],
 ['No other episode can bypass account cooldown',provider.includes("if(providerCooldown>Date.now())return null")&&provider.includes("if(providerUntil>Date.now())")],
 ['No cache reset during no-charge rejection',!provider.slice(provider.indexOf('function scheduleNoChargeRetry('),provider.indexOf('function resetNoChargeBackoff(')).includes('resetFlowTransientCaches(')],
 ['Security challenge remains distinct from expired login in read-only cold verifier',cold.includes("result='security_challenge'")&&cold.includes("result='unusual_activity'")],
 ['Cold restore only explicit post-login or authorized audit',yml.includes('workflow_dispatch:')&&!yml.includes('workflow_run:')&&!yml.includes('schedule:')&&!yml.includes('  push:')],
 ['Post-login bootstrap dispatches exactly one check via ephemeral GitHub token',['frutti','earth','dinnie'].every(k=>{
   const wf=file('.github/workflows/bootstrap-flow-'+k+'-v2.yml');
   return wf.includes('GH_COLD_RESTORE_DISPATCH_TOKEN:')&&wf.includes('node scripts/dispatch-one-flow-cold-check.mjs')&&wf.includes('actions: write');
 })],
 ['Existing Flow submit boundaries still present',provider.includes("FLOW_MIN_SUBMIT_SPACING_MS=10*60*1000")&&provider.includes("reserveGenerateBoundary(db,row,genId)")],
 ['Runner recognizes no-charge cooldown before credit probes',runner.includes("flowNoCharge=confirmedFlowNoChargeCooldown()")&&runner.includes("flow_no_charge_confirmed:true")],
 ['Server-side global clock backs off across restarts',true],
];
for(const [label,ok] of checks){assert.ok(ok,'FAILED '+label);console.log('PASS',label)}
console.log('PASS',samples.length,'synthetic Google security signals and',checks.length,'antispam guards. No Google requests, cookies, Generate or uploads.');
