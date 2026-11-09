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
 ['Provider cannot auto retry after unusual activity',provider.includes("setProviderSecurityHold(db,fresh,'FLOW_UNUSUAL_ACTIVITY_MANUAL_REVIEW_REQUIRED')")],
 ['No cache reset during no-charge rejection',!provider.slice(provider.indexOf('function scheduleNoChargeRetry('),provider.indexOf('function resetNoChargeBackoff(')).includes('resetFlowTransientCaches(')],
 ['Security challenge remains distinct from expired login in read-only cold verifier',cold.includes("result='security_challenge'")&&cold.includes("result='unusual_activity'")],
 ['Cold restore only explicit post-login or authorized audit',yml.includes('workflow_dispatch:')&&!yml.includes('workflow_run:')&&!yml.includes('schedule:')&&!yml.includes('  push:')],
 ['Post-login bootstrap dispatches exactly one check via ephemeral GitHub token',['frutti','earth','dinnie'].every(k=>{
   const wf=file('.github/workflows/bootstrap-flow-'+k+'-v2.yml');
   return wf.includes('GH_COLD_RESTORE_DISPATCH_TOKEN:')&&wf.includes('node scripts/dispatch-one-flow-cold-check.mjs')&&wf.includes('actions: write');
 })],
 ['Existing Flow submit boundaries still present',provider.includes("FLOW_MIN_SUBMIT_SPACING_MS=10*60*1000")&&provider.includes("reserveGenerateBoundary(db,row,genId)")],
];
for(const [label,ok] of checks){assert.ok(ok,'FAILED '+label);console.log('PASS',label)}
console.log('PASS',samples.length,'synthetic Google security signals and',checks.length,'antispam guards. No Google requests, cookies, Generate or uploads.');
