import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const ORCH=String(process.env.FREE_RUNTIME_ORCHESTRATOR_URL||'https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-free-runtime').replace(/\/$/,'');
const AUD='publisher-factory-free-runtime';
const VERSION='supabase-oidc-portable-flow-v2';
const ROOT=path.join(process.env.RUNNER_TEMP||os.tmpdir(),'publisher-free-runtime');
const DATA=path.join(ROOT,'data');
const FACTORY=path.join(DATA,'publisher-runtime');
const PROFILE=path.join(FACTORY,'flow-profile');
const PORTABLE_STATE=path.join(FACTORY,'flow-auth-state.json');
const LOG=path.join(ROOT,'runtime.log');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let CURRENT=null;

function run(cmd,args,opts={}){
  const r=spawnSync(cmd,args,{stdio:'inherit',...opts});
  if(r.status!==0)throw new Error('COMMAND_FAILED '+cmd+' '+args.join(' '));
}
async function oidc(){
  const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
  const token=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
  if(!base||!token)throw new Error('GITHUB_OIDC_UNAVAILABLE');
  const url=base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD);
  const r=await fetch(url,{headers:{authorization:'Bearer '+token}});
  if(!r.ok)throw new Error('GITHUB_OIDC_'+r.status);
  const j=await r.json();
  if(!j.value)throw new Error('GITHUB_OIDC_VALUE_MISSING');
  return String(j.value);
}
async function api(suffix,options={}){
  const token=await oidc();
  return fetch(ORCH+suffix,{...options,headers:{authorization:'Bearer '+token,...(options.headers||{})}});
}
async function claim(){
  const publisher_id=String(process.env.MANUAL_PUBLISHER_ID||'').trim();
  const kind=String(process.env.MANUAL_KIND||'').trim();
  const r=await api('/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publisher_id,kind})});
  if(!r.ok)throw new Error('CLAIM_'+r.status+' '+(await r.text()).slice(0,500));
  return (await r.json()).job||null;
}
async function callback(payload){
  const r=await api('/callback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok)throw new Error('CALLBACK_'+r.status+' '+(await r.text()).slice(0,500));
}
async function downloadBlob(type,publisherId,file){
  const r=await api('/blob/'+type+'/'+encodeURIComponent(publisherId));
  if(r.status===404)return false;
  if(!r.ok)throw new Error('BLOB_GET_'+type+'_'+r.status);
  fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()),{mode:0o600});
  return true;
}
async function uploadBlob(type,publisherId,file){
  const r=await api('/blob/'+type+'/'+encodeURIComponent(publisherId),{method:'PUT',headers:{'content-type':'application/octet-stream'},body:fs.readFileSync(file)});
  if(!r.ok)throw new Error('BLOB_PUT_'+type+'_'+r.status+' '+(await r.text()).slice(0,300));
}
function tableExists(db,name){
  try{return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))}catch{return false}
}
function dbPath(){
  const candidates=[path.join(FACTORY,'factory.sqlite'),path.join(DATA,'frutti-factory','factory.sqlite')];
  return candidates.find(fs.existsSync)||candidates[0];
}
function rebasePersistedMediaPaths(){
  const dbp=dbPath();
  if(!fs.existsSync(dbp))return{factory:0,publication:0};
  const db=new DatabaseSync(dbp,{timeout:5000});
  let factory=0,publication=0;
  try{
    const resolveLocal=(value)=>{
      const raw=String(value||'').trim();
      if(!raw||raw.includes('://')||fs.existsSync(raw))return raw;
      const base=path.basename(raw);
      const candidates=[
        path.join(FACTORY,'generated',base),
        path.join(FACTORY,'stock',base),
        path.join(FACTORY,'publication',base),
        path.join(FACTORY,'manual-recovery',base)
      ];
      return candidates.find(fs.existsSync)||raw;
    };
    if(tableExists(db,'factory_items')){
      const rows=db.prepare("SELECT id,videoPath FROM factory_items WHERE videoPath IS NOT NULL AND TRIM(videoPath)<>''").all();
      const upd=db.prepare("UPDATE factory_items SET videoPath=?,updatedAt=? WHERE id=?");
      for(const row of rows){
        const next=resolveLocal(row.videoPath);
        if(next&&next!==String(row.videoPath||'')&&fs.existsSync(next)){
          upd.run(next,new Date().toISOString(),row.id);
          factory++;
        }
      }
    }
    if(tableExists(db,'publication_items')){
      const rows=db.prepare("SELECT id,filePath FROM publication_items WHERE filePath IS NOT NULL AND TRIM(filePath)<>''").all();
      const upd=db.prepare("UPDATE publication_items SET filePath=?,updatedAt=? WHERE id=?");
      for(const row of rows){
        const next=resolveLocal(row.filePath);
        if(next&&next!==String(row.filePath||'')&&fs.existsSync(next)){
          upd.run(next,new Date().toISOString(),row.id);
          publication++;
        }
      }
    }
  }finally{db.close()}
  if(factory||publication)console.log('Rebased persisted media paths',{factory,publication});
  return{factory,publication};
}
function metrics(){
  const dbp=dbPath();
  if(!fs.existsSync(dbp))return{generation:0,publication:0,stock:0,review:0};
  const db=new DatabaseSync(dbp,{timeout:5000});
  try{
    const generation=tableExists(db,'factory_generations')
      ?Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE status IN ('review','completed') AND COALESCE(credits,1)>0").get()?.n||0):0;
    const publication=tableExists(db,'publication_items')
      ?Number(db.prepare("SELECT COUNT(*) n FROM publication_items WHERE status='published'").get()?.n||0):0;
    const stock=tableExists(db,'publication_items')
      ?Number(db.prepare("SELECT COUNT(*) n FROM publication_items WHERE status NOT IN ('published','cancelled','deleted')").get()?.n||0):0;
    const review=tableExists(db,'factory_items')
      ?Number(db.prepare("SELECT COUNT(*) n FROM factory_items WHERE status='review'").get()?.n||0):0;
    return{generation,publication,stock,review};
  }finally{db.close()}
}
function killTree(child){
  if(!child?.pid)return;
  try{process.kill(-child.pid,'SIGTERM')}catch{}
}
function chromiumPath(){
  return process.env.CHROMIUM_PATH||'/usr/bin/google-chrome';
}
async function seedProfileFromPortableState(projectUrl){
  if(fs.existsSync(path.join(PROFILE,'Default','Cookies')))return;
  if(!fs.existsSync(PORTABLE_STATE))throw new Error('MIGRATION_PROFILE_REQUIRED');
  const storage=JSON.parse(fs.readFileSync(PORTABLE_STATE,'utf8'));
  fs.mkdirSync(PROFILE,{recursive:true});
  const ctx=await chromium.launchPersistentContext(PROFILE,{
    executablePath:chromiumPath(),
    headless:true,
    locale:'en-US',
    timezoneId:'America/Argentina/Buenos_Aires',
    viewport:{width:1440,height:900},
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--password-store=basic','--no-first-run','--no-default-browser-check']
  });
  try{
    if(Array.isArray(storage.cookies)&&storage.cookies.length)await ctx.addCookies(storage.cookies);
    for(const origin of Array.isArray(storage.origins)?storage.origins:[]){
      if(!origin?.origin||!Array.isArray(origin.localStorage)||!origin.localStorage.length)continue;
      const page=await ctx.newPage();
      try{
        await page.goto(origin.origin,{waitUntil:'domcontentloaded',timeout:30000});
        await page.evaluate(items=>{for(const i of items)localStorage.setItem(i.name,i.value)},origin.localStorage);
      }catch{}
      await page.close().catch(()=>{});
    }
    const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(projectUrl||'https://flow.google.com/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    await sleep(2500);
    const url=String(page.url()||'');
    const body=String(await page.locator('body').innerText().catch(()=>'')).slice(0,10000);
    if(/accounts\.google\.com|ServiceLogin|signin\/v2|\/about(?:$|[?#])/i.test(url)||/email or phone|enter your password|sign in to continue/i.test(body)){
      throw new Error('AUTH_REQUIRED_PORTABLE_STATE_REJECTED');
    }
  }finally{
    await ctx.close().catch(()=>{});
  }
}
async function capturePortableState(){
  if(!fs.existsSync(PROFILE))return false;
  const ctx=await chromium.launchPersistentContext(PROFILE,{
    executablePath:chromiumPath(),
    headless:true,
    locale:'en-US',
    timezoneId:'America/Argentina/Buenos_Aires',
    viewport:{width:1280,height:800},
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--password-store=basic','--no-first-run','--no-default-browser-check']
  });
  try{
    await ctx.storageState({path:PORTABLE_STATE});
    return fs.existsSync(PORTABLE_STATE)&&fs.statSync(PORTABLE_STATE).size>500;
  }finally{
    await ctx.close().catch(()=>{});
  }
}
function packState(){
  fs.mkdirSync(FACTORY,{recursive:true});
  const stateTar=path.join(ROOT,'state.tgz');
  fs.rmSync(stateTar,{force:true});
  run('tar',['--exclude=publisher-runtime/flow-profile','--exclude=publisher-runtime/flow-auth-state.json','--exclude=frutti-factory/gflow-cli/profile_fruttidrama','-czf',stateTar,'-C',DATA,'.']);
  return stateTar;
}
function packPortableProfile(){
  if(!fs.existsSync(PORTABLE_STATE))return null;
  const profileTar=path.join(ROOT,'profile.tgz');
  fs.rmSync(profileTar,{force:true});
  run('tar',['-czf',profileTar,'-C',FACTORY,'flow-auth-state.json']);
  return profileTar;
}
function statusSnapshot(){
  for(const p of [path.join(process.cwd(),'public','free-browser-status.json'),path.join(process.cwd(),'public','autonomy-status.json')]){
    try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{}
  }
  return null;
}

fs.rmSync(ROOT,{recursive:true,force:true});
fs.mkdirSync(FACTORY,{recursive:true});
let child=null,job=null;
try{
  console.log('Free Runtime',VERSION);
  job=await claim();
  if(!job){console.log('No durable obligation is due.');process.exit(0)}
  CURRENT=job;
  const p=job.publisher,o=job.obligation,claimId=job.claim_id;
  const publisherId=String(p.id),kind=String(o.kind);
  console.log('Claimed',kind,'obligation',o.id,'for',p.name);

  const stateTar=path.join(ROOT,'state.restore.tgz');
  if(await downloadBlob('state',publisherId,stateTar))run('tar',['-xzf',stateTar,'-C',DATA]);
  rebasePersistedMediaPaths();

  const profileTar=path.join(ROOT,'profile.restore.tgz');
  const hasProfile=await downloadBlob('profile',publisherId,profileTar);
  if(hasProfile)run('tar',['-xzf',profileTar,'-C',FACTORY]);

  fs.writeFileSync(path.join(DATA,'publisher-config.json'),JSON.stringify(p.config||{},null,2),{mode:0o600});
  if(!hasProfile||!fs.existsSync(PORTABLE_STATE)){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:'MIGRATION_PROFILE_REQUIRED',approved_stock:metrics().stock});
    console.log('Portable Flow authentication is not migrated yet.');
    process.exit(0);
  }

  await seedProfileFromPortableState(String(p.config?.generation?.project_url||'https://flow.google.com/'));

  const baseline=metrics();
  const fd=fs.openSync(LOG,'a');
  const env={
    ...process.env,
    DATA_DIR:DATA,
    PUBLISHER_FLOW_PROFILE_DIR:PROFILE,
    CHROMIUM_PATH:chromiumPath(),
    PUBLISHER_ENABLED:'true',
    PUBLISHER_ONESHOT_KIND:kind,
    PUBLISHER_EXPECTED_FLOW_PROJECT_NAME:String(p.config?.generation?.project_name||p.name||''),
    PUBLISHER_CONFIG_JSON:JSON.stringify(p.config||{}),
    NODE_ENV:'production',
    PORT:'8080'
  };
  child=spawn('npm',['start'],{cwd:process.cwd(),env,stdio:['ignore',fd,fd],detached:true});
  await callback({obligation_id:o.id,claim_id:claimId,status:'running',approved_stock:baseline.stock});

  const timeout=Number(process.env.FREE_RUNTIME_JOB_TIMEOUT_MS||(kind==='generation'?22*60*1000:12*60*1000));
  const deadline=Date.now()+timeout;
  let success=false,last=baseline,creditWait=false;
  while(Date.now()<deadline){
    await sleep(5000);
    last=metrics();
    if(kind==='generation'&&(last.generation>baseline.generation||last.review>baseline.review)){success=true;break}
    if(kind==='publication'&&last.publication>baseline.publication){success=true;break}
    const snap=statusSnapshot();
    const state=String(snap?.state||snap?.generation?.state||'');
    if(kind==='generation'&&/DAILY_CREDIT_BATCH_COMPLETE|AUTOMATIC_BATCH_WAITING_FOR_DAILY_CREDITS|WAITING_DAILY_FLOW_CREDIT_REFRESH/i.test(state)){creditWait=true;break}
    if(child.exitCode!==null&&Date.now()+30000<deadline){
      child=spawn('npm',['start'],{cwd:process.cwd(),env,stdio:['ignore',fd,fd],detached:true});
    }
  }

  killTree(child);
  await sleep(2500);
  await capturePortableState().catch(e=>console.log('PORTABLE_STATE_REFRESH_WARNING',String(e?.message||e)));
  await uploadBlob('state',publisherId,packState());
  const portableTar=packPortableProfile();
  if(portableTar)await uploadBlob('profile',publisherId,portableTar);
  last=metrics();

  if(success){
    await callback({obligation_id:o.id,claim_id:claimId,status:'completed',approved_stock:last.stock});
    console.log('Completed',kind,o.id,last);
    process.exit(0);
  }
  if(creditWait){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:'WAITING_DAILY_FLOW_CREDIT_REFRESH',approved_stock:last.stock});
    console.log('Daily free Flow batch closed; no paid credits authorized.');
    process.exit(0);
  }

  await callback({obligation_id:o.id,claim_id:claimId,status:'running',error:'EPHEMERAL_RUNNER_TIMEOUT_RECONCILE_ONLY',approved_stock:last.stock});
  console.log('Timed out safely; persisted state for reconciliation.');
  process.exit(0);
}catch(err){
  killTree(child);
  const message=String(err?.stack||err).slice(0,1800);
  console.error(message);
  if(CURRENT){
    const blocked=/GITHUB_OIDC|MIGRATION_PROFILE_REQUIRED|AUTH_REQUIRED|MISSING_/i.test(message);
    await callback({
      obligation_id:CURRENT.obligation.id,
      claim_id:CURRENT.claim_id,
      status:blocked?'blocked':'running',
      error:message,
      approved_stock:metrics().stock
    }).catch(()=>{});
  }
  process.exit(CURRENT?1:0);
}
// EARTH_GOLDEN_TRIGGER: 2026-10-07T20:46-03:00
