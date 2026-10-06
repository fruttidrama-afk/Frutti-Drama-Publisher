import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const need=(k)=>{const v=String(process.env[k]||'').trim();if(!v)throw new Error('MISSING_'+k);return v};
const ORCH=need('FREE_RUNTIME_ORCHESTRATOR_URL').replace(/\/$/,'');
const SECRET=need('FREE_RUNTIME_RUNNER_SECRET');
const STATE_KEY=need('FREE_RUNTIME_STATE_KEY');
const PUBLISHER_ID=need('PUBLISHER_ID');
const OBLIGATION_ID=need('OBLIGATION_ID');
const KIND=need('OBLIGATION_KIND').toLowerCase();
if(!['generation','publication'].includes(KIND))throw new Error('INVALID_OBLIGATION_KIND');
const ROOT=path.join(process.env.RUNNER_TEMP||os.tmpdir(),'publisher-free-runtime');
const DATA=path.join(ROOT,'data');
const LOG=path.join(ROOT,'runtime.log');
const DB=()=>path.join(DATA,'publisher-runtime','factory.sqlite');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function run(cmd,args,opts={}){
  const r=spawnSync(cmd,args,{stdio:'inherit',...opts});
  if(r.status!==0)throw new Error('COMMAND_FAILED '+cmd+' '+args.join(' '));
}
async function signedCallback(payload){
  const body=JSON.stringify(payload);
  const sig=createHmac('sha256',SECRET).update(body).digest('hex');
  const r=await fetch(ORCH+'/callback',{method:'POST',headers:{'content-type':'application/json','x-publisher-signature':sig},body});
  if(!r.ok)throw new Error('CALLBACK_'+r.status+' '+(await r.text()).slice(0,300));
}
async function getJob(){
  const r=await fetch(ORCH+'/job/'+encodeURIComponent(OBLIGATION_ID),{headers:{authorization:'Bearer '+SECRET}});
  if(!r.ok)throw new Error('JOB_FETCH_'+r.status+' '+(await r.text()).slice(0,500));
  return await r.json();
}
async function downloadBlob(type,file){
  const r=await fetch(ORCH+'/blob/'+type+'/'+encodeURIComponent(PUBLISHER_ID),{headers:{authorization:'Bearer '+SECRET}});
  if(r.status===404)return{exists:false,etag:null};
  if(!r.ok)throw new Error('BLOB_GET_'+type+'_'+r.status);
  fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()),{mode:0o600});
  return{exists:true,etag:r.headers.get('etag')};
}
async function uploadBlob(type,file,etag){
  const headers={authorization:'Bearer '+SECRET,'content-type':'application/octet-stream'};
  if(etag)headers['if-match']=etag;
  const r=await fetch(ORCH+'/blob/'+type+'/'+encodeURIComponent(PUBLISHER_ID),{method:'PUT',headers,body:fs.readFileSync(file)});
  if(!r.ok)throw new Error('BLOB_PUT_'+type+'_'+r.status+' '+(await r.text()).slice(0,300));
}
function decrypt(enc,out){
  run('openssl',['enc','-d','-aes-256-cbc','-pbkdf2','-in',enc,'-out',out,'-pass','env:FREE_RUNTIME_STATE_KEY'],{env:{...process.env,FREE_RUNTIME_STATE_KEY:STATE_KEY}});
}
function encrypt(input,out){
  run('openssl',['enc','-aes-256-cbc','-salt','-pbkdf2','-in',input,'-out',out,'-pass','env:FREE_RUNTIME_STATE_KEY'],{env:{...process.env,FREE_RUNTIME_STATE_KEY:STATE_KEY}});
}
function tableExists(db,name){try{return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))}catch{return false}}
function metrics(){
  const dbp=DB();
  if(!fs.existsSync(dbp))return{generation:0,publication:0,stock:0};
  const db=new DatabaseSync(dbp,{timeout:5000});
  try{
    const generation=tableExists(db,'factory_generations')
      ?Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE status IN ('review','completed') AND COALESCE(credits,1)>0").get()?.n||0):0;
    const publication=tableExists(db,'publication_items')
      ?Number(db.prepare("SELECT COUNT(*) n FROM publication_items WHERE status='published'").get()?.n||0):0;
    const stock=tableExists(db,'publication_items')
      ?Number(db.prepare("SELECT COUNT(*) n FROM publication_items WHERE status NOT IN ('published','cancelled','deleted')").get()?.n||0):0;
    return{generation,publication,stock};
  }finally{db.close()}
}
function killTree(child){
  if(!child?.pid)return;
  try{process.kill(-child.pid,'SIGTERM')}catch{}
}
function pack(stateEtag,profileEtag){
  const stateTar=path.join(ROOT,'state.tgz'),stateEnc=stateTar+'.enc';
  const profileTar=path.join(ROOT,'profile.tgz'),profileEnc=profileTar+'.enc';
  fs.rmSync(stateTar,{force:true});fs.rmSync(stateEnc,{force:true});fs.rmSync(profileTar,{force:true});fs.rmSync(profileEnc,{force:true});
  run('tar',['--exclude=publisher-runtime/flow-profile','-czf',stateTar,'-C',DATA,'.']);
  encrypt(stateTar,stateEnc);
  const profileDir=path.join(DATA,'publisher-runtime','flow-profile');
  if(fs.existsSync(profileDir)){
    run('tar',['-czf',profileTar,'-C',path.dirname(profileDir),path.basename(profileDir)]);
    encrypt(profileTar,profileEnc);
  }
  return{stateEnc,profileEnc:fs.existsSync(profileEnc)?profileEnc:null,stateEtag,profileEtag};
}

fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(DATA,{recursive:true});
let child=null;
let stateInfo={etag:null},profileInfo={etag:null};
try{
  const job=await getJob();
  fs.writeFileSync(path.join(DATA,'publisher-config.json'),JSON.stringify(job.publisher?.config||{},null,2),{mode:0o600});

  const stateEnc=path.join(ROOT,'state.restore.enc'),stateTar=path.join(ROOT,'state.restore.tgz');
  stateInfo=await downloadBlob('state',stateEnc);
  if(stateInfo.exists){decrypt(stateEnc,stateTar);run('tar',['-xzf',stateTar,'-C',DATA])}

  const profileEnc=path.join(ROOT,'profile.restore.enc'),profileTar=path.join(ROOT,'profile.restore.tgz');
  profileInfo=await downloadBlob('profile',profileEnc);
  if(profileInfo.exists){
    decrypt(profileEnc,profileTar);
    const pr=path.join(DATA,'publisher-runtime');fs.mkdirSync(pr,{recursive:true});
    run('tar',['-xzf',profileTar,'-C',pr]);
  }

  if(!profileInfo.exists){
    await signedCallback({obligation_id:OBLIGATION_ID,status:'blocked',error:'MIGRATION_PROFILE_REQUIRED',approved_stock:metrics().stock});
    console.log('No portable Flow browser profile exists yet; obligation blocked safely.');
    process.exit(0);
  }

  const baseline=metrics();
  const fd=fs.openSync(LOG,'a');
  const chrome=process.env.CHROMIUM_PATH||'/usr/bin/google-chrome';
  const env={
    ...process.env,
    DATA_DIR:DATA,
    CHROMIUM_PATH:chrome,
    PUBLISHER_ENABLED:'true',
    PUBLISHER_ONESHOT_KIND:KIND,
    PUBLISHER_CONFIG_JSON:JSON.stringify(job.publisher?.config||{}),
    NODE_ENV:'production',
    PORT:'8080'
  };
  child=spawn('npm',['start'],{cwd:process.cwd(),env,stdio:['ignore',fd,fd],detached:true});

  const timeout=Number(process.env.FREE_RUNTIME_JOB_TIMEOUT_MS|| (KIND==='generation'?20*60*1000:12*60*1000));
  const deadline=Date.now()+timeout;
  let success=false,last=baseline;
  while(Date.now()<deadline){
    await sleep(5000);
    last=metrics();
    if(KIND==='generation'&&last.generation>baseline.generation){success=true;break}
    if(KIND==='publication'&&last.publication>baseline.publication){success=true;break}
    if(child.exitCode!==null){
      console.log('Runtime exited with code',child.exitCode,'; restarting once if time remains.');
      if(Date.now()+30000<deadline){
        child=spawn('npm',['start'],{cwd:process.cwd(),env,stdio:['ignore',fd,fd],detached:true});
      }else break;
    }
  }
  killTree(child);await sleep(1500);

  const packed=pack(stateInfo.etag,profileInfo.etag);
  await uploadBlob('state',packed.stateEnc,stateInfo.etag);
  if(packed.profileEnc)await uploadBlob('profile',packed.profileEnc,profileInfo.etag);

  last=metrics();
  if(success){
    await signedCallback({obligation_id:OBLIGATION_ID,status:'completed',approved_stock:last.stock});
    console.log('Completed',KIND,'obligation',OBLIGATION_ID,last);
    process.exit(0);
  }

  await signedCallback({obligation_id:OBLIGATION_ID,status:'running',error:'EPHEMERAL_RUNNER_TIMEOUT_RECONCILE_ON_RETRY',approved_stock:last.stock});
  console.log('Timed out safely; persisted state and left obligation leased for reconciliation retry.');
  process.exit(0);
}catch(err){
  killTree(child);
  const message=String(err?.stack||err).slice(0,1500);
  console.error(message);
  try{
    if(fs.existsSync(DATA)){
      const packed=pack(stateInfo.etag,profileInfo.etag);
      await uploadBlob('state',packed.stateEnc,stateInfo.etag).catch(()=>{});
      if(packed.profileEnc)await uploadBlob('profile',packed.profileEnc,profileInfo.etag).catch(()=>{});
    }
  }catch{}
  const blocked=/MISSING_|JOB_FETCH_401|BAD_SIGNATURE|PROFILE_REQUIRED|AUTH_REQUIRED/i.test(message);
  await signedCallback({obligation_id:OBLIGATION_ID,status:blocked?'blocked':'running',error:message,approved_stock:metrics().stock}).catch(()=>{});
  process.exit(blocked?0:1);
}
