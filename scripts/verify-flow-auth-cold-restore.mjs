import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {classifyFlowSecuritySignal} from './flow-security-signals.mjs';

// Read-only cold restore, never click Generate or modify profile.tgz.
// Each iteration is a clean isolated browser context on a new GitHub VM.
const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-flow-account-bootstrap-v2';
const AUD='publisher-factory-flow-account-bootstrap-v2';
const KEYS={
 frutti:'705d7ac2-30fe-4481-aa4c-076c31a64214',
 earth:'800af820-b951-4035-ab20-f64df8883fb0',
 dinnie:'67620e0a-7fcf-43c6-9770-eb235ce92a65'
};
async function oidc(){
 const base=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,token=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
 if(!base||!token)throw Error('OIDC_MISSING');
 const q=base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD);
 const r=await fetch(q,{headers:{authorization:'Bearer '+token}});
 if(!r.ok)throw Error('OIDC_HTTP_'+r.status);
 const obj=await r.json();if(!obj.value)throw Error('OIDC_EMPTY');
 return obj.value;
}
async function api(key,op,options={}){
 const token=await oidc();
 return fetch(EDGE+'/'+op+'/'+key,{...options,headers:{Authorization:'Bearer '+token,...(options.headers||{})}});
}
async function report(key,result){
 const r=await api(key,'cold-report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({result})});
 if(!r.ok)throw Error('REPORT_HTTP_'+r.status);
}
async function verify(key,project){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cold-flow-'+key+'-'));
 let result='verification_error';
 let browser=null;
 try{
  const response=await api(key,'vault-read');
  if(!response.ok)throw Error(response.status===404?'AUTH_VAULT_NOT_FOUND':'AUTH_VAULT_HTTP_'+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length<200||bytes.length>40*1024*1024)throw Error('AUTH_VAULT_SIZE_INVALID');
  const file=path.join(dir,'profile.tgz');fs.writeFileSync(file,bytes,{mode:0o600});
  const listing=spawnSync('tar',['-tzf',file],{encoding:'utf8',timeout:10000});
  if(listing.status!==0)throw Error('AUTH_VAULT_ARCHIVE_INVALID');
  const members=listing.stdout.trim().split('\n');
  if(members.some(p=>p.startsWith('/')||p.includes('..')))throw Error('AUTH_VAULT_UNSAFE_ARCHIVE');
  if(!members.includes('flow-auth-state.json'))throw Error('AUTH_VAULT_NO_PORTABLE_STATE');
  const unpack=spawnSync('tar',['-xzf',file,'-C',dir,'flow-auth-state.json'],{encoding:'utf8',timeout:10000});
  if(unpack.status!==0)throw Error('AUTH_VAULT_EXTRACT_FAILED');
  const state=JSON.parse(fs.readFileSync(path.join(dir,'flow-auth-state.json'),'utf8'));
  if(!Array.isArray(state.cookies)||!state.cookies.length||!Array.isArray(state.origins))throw Error('AUTH_VAULT_STATE_INVALID');
  browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--password-store=basic','--no-first-run','--no-default-browser-check']});
  const context=await browser.newContext({storageState:state,locale:'en-US',timezoneId:'America/Argentina/Buenos_Aires',viewport:{width:1440,height:900}});
  const page=await context.newPage();
  try{
   await page.goto('https://flow.google.com/project/'+project,{waitUntil:'domcontentloaded',timeout:60000});
   await page.waitForTimeout(6500);
  }catch{result='project_inaccessible';throw Error('FLOW_PROJECT_NAVIGATION_FAILED')}
  const url=String(page.url()),body=String(await page.locator('body').innerText({timeout:10000}).catch(()=>'')).slice(0,16000);
  const signal=classifyFlowSecuritySignal(url,body);
  if(signal==='security_challenge'){result='security_challenge';throw Error('COLD_RESTORE_SECURITY_CHALLENGE')}
  if(signal==='unusual_activity'){result='unusual_activity';throw Error('COLD_RESTORE_FLOW_UNUSUAL_ACTIVITY')}
  if(signal==='login_required'){result='login_required';throw Error('COLD_RESTORE_LOGIN_REQUIRED')}
  if(!url.includes('/project/'+project)||body.trim().length<40){result='project_inaccessible';throw Error('COLD_RESTORE_EXACT_PROJECT_INACCESSIBLE')}
  const cookies=await context.cookies(['https://flow.google.com','https://accounts.google.com']);
  const hasSession=cookies.some(c=>/(^|\.)google\.com$/i.test(String(c.domain||''))&&/^(?:SID|HSID|SSID|APISID|SAPISID|__Secure-(?:1P|3P)SID(?:CC|TS)?|LSID)$/.test(String(c.name||''))&&String(c.value||'').length>8);
  if(!hasSession){result='login_required';throw Error('COLD_RESTORE_GOOGLE_COOKIES_REJECTED')}
  result='verified';
  console.log('COLD_RESTORE_OK',key,'correct_project=true','read_only=true');
 }catch(e){
  if(result==='verification_error'&&/AUTH_VAULT_/.test(String(e?.message||e)))result='vault_invalid';
  console.warn('COLD_RESTORE_RESULT',key,result,String(e?.message||e).slice(0,110));
 }finally{
  try{await browser?.close()}catch{}
  fs.rmSync(dir,{recursive:true,force:true});
  await report(key,result);
 }
 return result;
}
const keys=String(process.env.FLOW_VERIFY_ONLY||'').trim().split(',').filter(Boolean);
const selected=keys.length?keys:Object.keys(KEYS);
if(selected.some(k=>!Object.hasOwn(KEYS,k)))throw Error('UNKNOWN_TARGET_KEY');
let failed=false;
for(const key of selected){const result=await verify(key,KEYS[key]);if(result!=='verified')failed=true}
console.log('COLD_RESTORE_ALL_FINISHED',selected.join(','),'read_only=true');
if(failed)process.exitCode=1;
