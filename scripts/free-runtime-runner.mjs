import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ORCH=String(process.env.FREE_RUNTIME_ORCHESTRATOR_URL||'https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-free-runtime').replace(/\/$/,'');
const AUD='publisher-factory-free-runtime';
const FREE_RUNTIME_VERSION='supabase-oidc-v1';
const ROOT=path.join(process.env.RUNNER_TEMP||os.tmpdir(),'publisher-free-runtime');
const DATA=path.join(ROOT,'data');
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
  return await fetch(ORCH+suffix,{...options,headers:{authorization:'Bearer '+token,...(options.headers||{})}});
}
async function claim(){
  const publisher_id=String(process.env.MANUAL_PUBLISHER_ID||'').trim();
  const kind=String(process.env.MANUAL_KIND||'').trim();
  const r=await api('/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publisher_id,kind})});
  if(!r.ok)throw new Error('CLAIM_'+r.status+' '+(await r.text()).slice(0,500));
  const j=await r.json();
  return j.job||null;
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
function tableExists(db,name){try{return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))}catch{return false}}
function dbPath(){
  const candidates=[
    path.join(DATA,'publisher-runtime','factory.sqlite'),
    path.join(DATA,'frutti-factory','factory.sqlite')
  ];
  return candidates.find(fs.existsSync)||candidates[0];
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
function pruneProfile(profileDir){
  if(!fs.existsSync(profileDir))return;
  for(const name of ['SingletonCookie','SingletonLock','SingletonSocket','DevToolsActivePort']){
    try{fs.rmSync(path.join(profileDir,name),{force:true,recursive:true})}catch{}
  }
  const cacheNames=new Set(['Cache','Code Cache','GPUCache','ShaderCache','GrShaderCache','DawnCache','GraphiteDawnCache']);
  const walk=(dir,depth=0)=>{
    if(depth>7)return;
    let rows=[];try{rows=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
    for(const row of rows){
      if(!row.isDirectory())continue;
      const p=path.join(dir,row.name);
      if(cacheNames.has(row.name)){try{fs.rmSync(p,{recursive:true,force:true})}catch{};continue}
      walk(p,depth+1);
    }
  };
  walk(profileDir);
}
function pack(){
  const stateTar=path.join(ROOT,'state.tgz'),profileTar=path.join(ROOT,'profile.tgz');
  fs.rmSync(stateTar,{force:true});fs.rmSync(profileTar,{force:true});
  run('tar',['--exclude=publisher-runtime/flow-profile','--exclude=frutti-factory/gflow-cli/profile_fruttidrama','-czf',stateTar,'-C',DATA,'.']);
  let profileDir=path.join(DATA,'publisher-runtime','flow-profile');
  if(!fs.existsSync(profileDir)){
    const legacy=path.join(DATA,'frutti-factory','gflow-cli','profile_fruttidrama');
    if(fs.existsSync(legacy))profileDir=legacy;
  }
  if(fs.existsSync(profileDir)){
    pruneProfile(profileDir);
    run('tar',['-czf',profileTar,'-C',path.dirname(profileDir),path.basename(profileDir)]);
  }
  return{stateTar,profileTar:fs.existsSync(profileTar)?profileTar:null};
}
function statusSnapshot(){
  for(const p of [
    path.join(process.cwd(),'public','free-browser-status.json'),
    path.join(process.cwd(),'public','autonomy-status.json')
  ]){
    try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{}
  }
  return null;
}

fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(DATA,{recursive:true});
let child=null,job=null;
try{
  console.log('Free Runtime',FREE_RUNTIME_VERSION);\n  job=await claim();
  if(!job){console.log('No durable obligation is due.');process.exit(0)}
  CURRENT=job;
  const p=job.publisher,o=job.obligation,claimId=job.claim_id;
  const publisherId=String(p.id),kind=String(o.kind);
  console.log('Claimed',kind,'obligation',o.id,'for',p.name);

  const stateTar=path.join(ROOT,'state.restore.tgz');
  const hasState=await downloadBlob('state',publisherId,stateTar);
  if(hasState)run('tar',['-xzf',stateTar,'-C',DATA]);

  const profileTar=path.join(ROOT,'profile.restore.tgz');
  const hasProfile=await downloadBlob('profile',publisherId,profileTar);
  if(hasProfile){
    const root=path.join(DATA,'publisher-runtime');fs.mkdirSync(root,{recursive:true});
    run('tar',['-xzf',profileTar,'-C',root]);
  }

  fs.writeFileSync(path.join(DATA,'publisher-config.json'),JSON.stringify(p.config||{},null,2),{mode:0o600});
  if(!hasProfile){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:'MIGRATION_PROFILE_REQUIRED',approved_stock:metrics().stock});
    console.log('Portable Flow profile is not migrated yet; obligation blocked safely.');
    process.exit(0);
  }

  const baseline=metrics();
  const fd=fs.openSync(LOG,'a');
  const env={
    ...process.env,
    DATA_DIR:DATA,
    CHROMIUM_PATH:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',
    PUBLISHER_ENABLED:'true',
    PUBLISHER_ONESHOT_KIND:kind,
    PUBLISHER_CONFIG_JSON:JSON.stringify(p.config||{}),
    NODE_ENV:'production',
    PORT:'8080'
  };
  child=spawn('npm',['start'],{cwd:process.cwd(),env,stdio:['ignore',fd,fd],detached:true});

  await callback({obligation_id:o.id,claim_id:claimId,status:'running',approved_stock:baseline.stock});
  const timeout=Number(process.env.FREE_RUNTIME_JOB_TIMEOUT_MS|| (kind==='generation'?22*60*1000:12*60*1000));
  const deadline=Date.now()+timeout;
  let success=false,last=baseline,creditWait=false;
  while(Date.now()<deadline){
    await sleep(5000);last=metrics();
    if(kind==='generation'&&(last.generation>baseline.generation||last.review>baseline.review)){success=true;break}
    if(kind==='publication'&&last.publication>baseline.publication){success=true;break}
    const snap=statusSnapshot();
    const state=String(snap?.state||snap?.generation?.state||'');
    if(kind==='generation'&&/DAILY_CREDIT_BATCH_COMPLETE|AUTOMATIC_BATCH_WAITING_FOR_DAILY_CREDITS|WAITING_DAILY_FLOW_CREDIT_REFRESH/i.test(state)){creditWait=true;break}
    if(child.exitCode!==null&&Date.now()+30000<deadline){
      console.log('Runtime exited with code',child.exitCode,'; restarting the same durable obligation.');
      child=spawn('npm',['start'],{cwd:process.cwd(),env,stdio:['ignore',fd,fd],detached:true});
    }
  }
  killTree(child);await sleep(1500);

  const packed=pack();
  await uploadBlob('state',publisherId,packed.stateTar);
  if(packed.profileTar)await uploadBlob('profile',publisherId,packed.profileTar);
  last=metrics();

  if(success){
    await callback({obligation_id:o.id,claim_id:claimId,status:'completed',approved_stock:last.stock});
    console.log('Completed',kind,o.id,last);process.exit(0);
  }
  if(creditWait){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:'WAITING_DAILY_FLOW_CREDIT_REFRESH',approved_stock:last.stock});
    console.log('Daily free Flow batch is closed; debt preserved without spending paid credits.');process.exit(0);
  }

  await callback({obligation_id:o.id,claim_id:claimId,status:'running',error:'EPHEMERAL_RUNNER_TIMEOUT_RECONCILE_ONLY',approved_stock:last.stock});
  console.log('Timed out safely; state persisted. The same obligation will only reconcile after lease expiry.');process.exit(0);
}catch(err){
  killTree(child);
  const message=String(err?.stack||err).slice(0,1800);
  console.error(message);
  try{
    if(CURRENT&&fs.existsSync(DATA)){
      const packed=pack(),p=String(CURRENT.publisher.id);
      await uploadBlob('state',p,packed.stateTar).catch(()=>{});
      if(packed.profileTar)await uploadBlob('profile',p,packed.profileTar).catch(()=>{});
    }
  }catch{}
  if(CURRENT){
    const o=CURRENT.obligation;
    const blocked=/GITHUB_OIDC|MIGRATION_PROFILE_REQUIRED|AUTH_REQUIRED|MISSING_/i.test(message);
    await callback({obligation_id:o.id,claim_id:CURRENT.claim_id,status:blocked?'blocked':'running',error:message,approved_stock:metrics().stock}).catch(()=>{});
  }
  process.exit(CURRENT?1:0);
}
