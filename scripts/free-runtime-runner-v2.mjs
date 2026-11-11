import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { classifyFlowSecuritySignal } from './flow-security-signals.mjs';

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
  if(!fs.existsSync(dbp))return{generation:0,publication:0,stock:0,review:0,privateStaged:0};
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
    // Only a persisted PRIVATE YouTube video for TODAY's publication is staged;
    // this is NOT a publication and must not complete the release obligation.
    const localParts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const dayTokens=Object.fromEntries(localParts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const today=dayTokens.year+'-'+dayTokens.month+'-'+dayTokens.day;
    // Legacy publisher SQLite schemas often do NOT have a provider column.
    // Never let a monitoring metric crash the runner BEFORE video generation.
    const pubCols=tableExists(db,'publication_items')
      ?new Set(db.prepare("PRAGMA table_info(publication_items)").all().map(c=>String(c.name))):new Set();
    const stagedCols=['videoId','remotePrivacyStatus','scheduledAt','status'].every(k=>pubCols.has(k));
    const providerFilter=pubCols.has('provider')?" AND COALESCE(provider,'youtube')='youtube'":"";
    const privateStaged=stagedCols
      ?Number(db.prepare("SELECT COUNT(*) n FROM publication_items WHERE videoId IS NOT NULL AND remotePrivacyStatus='private' AND substr(scheduledAt,1,10)=? AND status NOT IN ('published','cancelled','deleted')"+providerFilter).get(today)?.n||0):0;
    return{generation,publication,stock,review,privateStaged};
  }finally{db.close()}
}
// Fail closed before launching a publication worker when the local-day
// PRIVATE YouTube stage cannot be bound to exactly one durable obligation.
// A private tile from an older/unknown attempt is not proof that THIS claim
// staged a new video; never upload again to discover which one it was.
function youtubeStagingSafety(kind,platform,clock,privateStaged){
  if(kind!=='publication'||String(platform||'').toLowerCase()!=='youtube')return null;
  const n=Number(privateStaged);
  if(!Number.isSafeInteger(n)||n<0)return 'YOUTUBE_PRIVATE_STAGE_METRIC_INVALID_RECONCILIATION_REQUIRED';
  if(clock>='12:30'&&clock<'13:00'&&n!==0)return 'YOUTUBE_PREEXISTING_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED';
  if(clock>='19:00'&&n!==1)return 'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED';
  return null;
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

async function validateFlowAuthAndRefreshState(projectUrl){
  // A successful Chrome launch or a nonempty cookie file does NOT prove that
  // Google has accepted the account session. Read only: no Generate clicks.
  const expectedId=String(projectUrl||'').match(/\/project\/([a-f0-9-]+)/i)?.[1]||'';
  if(!expectedId)throw new Error('FLOW_EXPECTED_PROJECT_ID_REQUIRED');
  const candidate=PORTABLE_STATE+'.verified-'+process.pid;
  let browser=null,ctx=null;
  const useProfile=fs.existsSync(path.join(PROFILE,'Default','Cookies'));
  try{
    const options={
      executablePath:chromiumPath(),headless:true,
      args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--password-store=basic','--no-first-run','--no-default-browser-check']
    };
    if(useProfile){
      ctx=await chromium.launchPersistentContext(PROFILE,{...options,locale:'en-US',timezoneId:'America/Argentina/Buenos_Aires',viewport:{width:1440,height:900}});
    }else{
      if(!fs.existsSync(PORTABLE_STATE))throw new Error('FLOW_AUTH_STATE_MISSING');
      browser=await chromium.launch(options);
      ctx=await browser.newContext({storageState:PORTABLE_STATE,locale:'en-US',timezoneId:'America/Argentina/Buenos_Aires',viewport:{width:1440,height:900}});
    }
    const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(projectUrl,{waitUntil:'domcontentloaded',timeout:55000});
    await sleep(3000);
    const url=String(page.url());
    const body=String(await page.locator('body').innerText({timeout:10000}).catch(()=>'')).slice(0,12000);
    const signal=classifyFlowSecuritySignal(url,body);
    // Do not keep probing a Google identity challenge or Flow's own abuse
    // screen; never attempt a CAPTCHA, 2FA, or policy challenge automatically.
    if(signal==='security_challenge')throw new Error('FLOW_SECURITY_CHALLENGE_MANUAL_REQUIRED');
    if(signal==='unusual_activity')throw new Error('FLOW_UNUSUAL_ACTIVITY_MANUAL_REVIEW_REQUIRED');
    if(signal==='login_required')throw new Error('FLOW_AUTH_REQUIRED_OR_PROJECT_INACCESSIBLE');
    if(!url.includes('/project/'+expectedId))throw new Error('FLOW_AUTH_REQUIRED_OR_PROJECT_INACCESSIBLE');
    const cookies=await ctx.cookies(['https://flow.google.com','https://accounts.google.com']);
    const hasGoogleSession=cookies.some(c=>
      /(^|\.)google\.com$/i.test(String(c.domain||''))&&
      /^(?:SID|HSID|SSID|APISID|SAPISID|__Secure-(?:1P|3P)SID(?:CC|TS)?|LSID)$/.test(String(c.name||''))&&
      String(c.value||'').length>8
    );
    if(!hasGoogleSession)throw new Error('FLOW_AUTH_GOOGLE_SESSION_COOKIES_MISSING');
    await ctx.storageState({path:candidate,indexedDB:true});
    const snapshot=JSON.parse(fs.readFileSync(candidate,'utf8'));
    if(!Array.isArray(snapshot.cookies)||!snapshot.cookies.length||!Array.isArray(snapshot.origins)||fs.statSync(candidate).size<500)
      throw new Error('FLOW_AUTH_VERIFIED_SNAPSHOT_INVALID');
    fs.renameSync(candidate,PORTABLE_STATE);
    return{ok:true,persistent_profile:useProfile};
  }finally{
    try{fs.rmSync(candidate,{force:true})}catch{}
    try{await ctx?.close()}catch{}
    try{await browser?.close()}catch{}
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
  const entries=['flow-auth-state.json'];
  if(fs.existsSync(path.join(PROFILE,'Default','Cookies')))entries.push('flow-profile');
  const exclusions=[
    '*/Cache','*/Code Cache','*/GPUCache','*/Media Cache','*/Crashpad',
    '*/Service Worker/CacheStorage','*/Service Worker/ScriptCache',
    '*/OptimizationGuidePredictionModels','*/GrShaderCache',
    '*/ShaderCache','*/DawnCache','*/Safe Browsing',
    '*/SingletonLock','*/SingletonCookie','*/SingletonSocket'
  ];
  const args=exclusions.map(pattern=>'--exclude='+pattern);
  run('tar',[...args,'-czf',profileTar,'-C',FACTORY,...entries]);
  if(fs.statSync(profileTar).size>=39*1024*1024){
    // The private Edge currently caps uploads at 40MiB. Never let growing
    // browser caches break an otherwise successful generation.
    fs.rmSync(profileTar,{force:true});
    run('tar',['-czf',profileTar,'-C',FACTORY,'flow-auth-state.json']);
    console.warn('FLOW_AUTH_PROFILE_TRIMMED_TO_PORTABLE_STATE');
  }
  return profileTar;
}
function statusSnapshot(){
  for(const p of [path.join(process.cwd(),'public','free-browser-status.json'),path.join(process.cwd(),'public','autonomy-status.json')]){
    try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{}
  }
  return null;
}
function confirmedFlowNoChargeCooldown(){
  const dbp=path.join(FACTORY,'factory.sqlite');
  if(!fs.existsSync(dbp))return null;
  const db=new DatabaseSync(dbp,{timeout:5000,readOnly:true});
  try{
    const meta=(key)=>String(db.prepare('SELECT value FROM factory_meta WHERE key=?').get(key)?.value||'');
    const state=meta('flow:state');
    const reason=meta('flow:lastNoChargeConfirmedAt');
    const until=Number(meta('flow:transientCooldownUntil')||0);
    return state==='FLOW_UNUSUAL_ACTIVITY_COOLDOWN'&&reason&&until>Date.now()
      ?{until,streak:Number(meta('flow:noChargeStreak:provider')||0)}:null;
  }finally{db.close()}
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
  // No Flow render or credits may be attempted if the Earth/Frutti/Dinnie
  // creative authority is missing. Hard-block instead of crash/restart storms.
  if(kind==='generation'&&!String(p.config?.content?.creative_bible||'').trim()){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:'SHOW_BIBLE_REQUIRED_CONFIGURATION_MISSING',approved_stock:metrics().stock});
    console.error('SHOW_BIBLE_REQUIRED_CONFIGURATION_MISSING; no video submitted.');
    process.exit(0);
  }
  if(kind==='generation'&&(!hasProfile||!fs.existsSync(PORTABLE_STATE))){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:'MIGRATION_PROFILE_REQUIRED',approved_stock:metrics().stock});
    console.log('Portable Flow authentication is not migrated yet. No video submitted.');
    process.exit(0);
  }

  // YouTube/Facebook publication must be independent of Flow authentication.
  // Publishing already-approved media cannot be blocked by an unrelated
  // Google Flow login, and must never need Generate or free Flow credits.
  const expectedProjectUrl=String(p.config?.generation?.project_url||('https://flow.google.com/project/'+String(p.config?.generation?.project_id||'')));
  if(kind==='generation'){
    await validateFlowAuthAndRefreshState(expectedProjectUrl);
    console.log('Flow authentication preflight verified for configured project (read-only).');
  }

  const baseline=metrics();
  const localClock=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
  const stagedSafety=youtubeStagingSafety(kind,p.platform,localClock,baseline.privateStaged);
  if(stagedSafety){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:stagedSafety,approved_stock:baseline.stock});
    console.error(stagedSafety+'; no YouTube upload or privacy mutation attempted.');
    process.exit(0);
  }
  const fd=fs.openSync(LOG,'a');
  const env={
    ...process.env,
    DATA_DIR:DATA,
    PUBLISHER_FLOW_PROFILE_DIR:PROFILE,
    PUBLISHER_FLOW_STORAGE_STATE:PORTABLE_STATE,
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
  let success=false,last=baseline,creditWait=false,creditProbeFailure=null,privateStagedWait=false,flowNoCharge=null,childFatal=null,restarts=0;
  while(Date.now()<deadline){
    await sleep(5000);
    last=metrics();
    if(kind==='generation'&&(last.generation>baseline.generation||last.review>baseline.review)){success=true;break}
    if(kind==='publication'&&last.publication>baseline.publication){success=true;break}
    if(kind==='generation'){
      flowNoCharge=confirmedFlowNoChargeCooldown();
      if(flowNoCharge){
        console.log('FLOW_UNUSUAL_ACTIVITY_COOLDOWN_CONFIRMED', 'streak='+flowNoCharge.streak,
          'not_before='+new Date(flowNoCharge.until).toISOString(),
          'no_remote_retry=true');
        break;
      }
    }
    if(kind==='publication'&&String(p.platform||'').toLowerCase()==='youtube'&&last.privateStaged>baseline.privateStaged){
      if(last.privateStaged!==1){childFatal='YOUTUBE_MULTIPLE_PRIVATE_STAGES_REMOTE_ID_RECONCILIATION_REQUIRED';break}
      const h=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
      if(h<'19:00'){privateStagedWait=true;break}
    }
    const snap=statusSnapshot();
    const state=String(snap?.state||snap?.generation?.state||'');
    // An unreadable credit balance is NOT evidence that the 50 free daily credits are exhausted.
    // This status is emitted by ensureDailyCreditCycle for project/login/credit-reading errors too.
    if(kind==='generation'&&state==='AUTOMATIC_BATCH_WAITING_FOR_DAILY_CREDITS'&&/^(credit-balance-unavailable|credit-refresh-read-failed)$/.test(String(snap?.reason||''))){
      creditProbeFailure='FLOW_CREDIT_PROBE_UNAVAILABLE:'+String(snap.reason);
      break;
    }
    if(kind==='generation'&&/DAILY_CREDIT_BATCH_COMPLETE|AUTOMATIC_BATCH_WAITING_FOR_DAILY_CREDITS|WAITING_DAILY_FLOW_CREDIT_REFRESH|WAITING_FIRST_DAILY_FLOW_CREDIT_REFRESH/i.test(state)){creditWait=true;break}
    if(child.exitCode!==null){
      const tail=fs.existsSync(LOG)?fs.readFileSync(LOG,'utf8').slice(-13000):'';
      const permanent=/SHOW_BIBLE_REQUIRED|CREATIVE_BIBLE_REQUIRED|CONFIG_SCHEMA_INVALID|PUBLISHER_CONFIG_INVALID/.test(tail);
      const googleChallenge=/FLOW_AUTH_CHALLENGE|FLOW_SECURITY_CHALLENGE|FLOW_UNUSUAL_ACTIVITY|FLOW_AUTH_REQUIRED_DURING_RENDER|FLOW_LOGIN_REQUIRED/.test(tail);
      if(googleChallenge){
        childFatal='FLOW_SECURITY_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY';
        console.error(childFatal,'exit_code='+String(child.exitCode));break;
      }
      if(permanent){
        childFatal='RUNTIME_CONFIGURATION_INVALID_BLOCKED_NO_RESTART';
        console.error(childFatal,'exit_code='+String(child.exitCode));break;
      }
      // An unknown crash might occur AFTER a remote submit. Restarting with
      // a fresh local state would risk a duplicate. Fail closed for human/
      // remote-ID reconciliation, not 258 restarts in 22 minutes.
      childFatal='RUNTIME_CHILD_EXITED_RECONCILIATION_REQUIRED';
      console.error(childFatal,'exit_code='+String(child.exitCode),'restarts='+restarts);
      break;
    }
  }

  killTree(child);
  await sleep(2500);
  const hasPersistentProfile=fs.existsSync(path.join(PROFILE,'Default','Cookies'));
  // Refresh cookies/IndexedDB only after read-only Google + exact-project
  // validation. If Google invalidates a session, retain the last-known-good
  // vault and block production; never overwrite it with a signed-out state.
  let authenticatedAfterRun=false;
  // A security challenge, missing credits, ambiguity or crashed worker is not
  // permission to open Google in ANOTHER fresh browser. Recheck only after a
  // real new generation/review result, when refreshing auth is useful.
  if(kind==='generation'&&success){
    try{
      await validateFlowAuthAndRefreshState(expectedProjectUrl);
      authenticatedAfterRun=true;
    }catch(e){
      console.warn('FLOW_AUTH_REFRESH_SKIPPED_LAST_GOOD_PRESERVED',String(e?.message||e).slice(0,140));
    }
    if(!fs.existsSync(PORTABLE_STATE)||fs.statSync(PORTABLE_STATE).size<500)throw new Error('PORTABLE_FLOW_STATE_LOST');
    console.log('Flow auth state preserved',{portable_bytes:fs.statSync(PORTABLE_STATE).size,persistent_profile:hasPersistentProfile});
  }
  await uploadBlob('state',publisherId,packState());
  // A failed post-run check must never replace the authenticated remote vault
  // with a possibly signed-out or half-written Chrome profile.
  const portableTar=authenticatedAfterRun?packPortableProfile():null;
  if(portableTar)await uploadBlob('profile',publisherId,portableTar);
  last=metrics();

  if(success){
    await callback({obligation_id:o.id,claim_id:claimId,status:'completed',approved_stock:last.stock});
    console.log('Completed',kind,o.id,last);
    process.exit(0);
  }
  if(childFatal){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:childFatal,approved_stock:last.stock});
    console.error('Blocked unsafe child restart; runtime state archived for reconciliation.');
    process.exit(1);
  }
  if(flowNoCharge){
    // State has already been uploaded to Supabase. Report a one-time,
    // account-wide delay using this exact OIDC claim (idempotent on receipt).
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',
      error:'FLOW_UNUSUAL_ACTIVITY_COOLDOWN',flow_no_charge_confirmed:true,
      flow_item_id:String(o.id),approved_stock:last.stock});
    console.log('Flow explicit no-charge rejection saved; no new Generate until global deadline.');
    process.exit(0);
  }
  if(privateStagedWait){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:'YOUTUBE_PRIVATE_STAGED_WAITING_19',approved_stock:last.stock});
    console.log('YouTube private staging verified. Will explicitly change privacy at 19:00 ART; no new upload permitted.');
    process.exit(0);
  }
  if(creditProbeFailure){
    // The provider has not submitted anything: keep this obligation reconcile-only
    // until its lease expires, then safely retry the pre-submit credit reading.
    await callback({obligation_id:o.id,claim_id:claimId,status:'running',error:creditProbeFailure,approved_stock:last.stock});
    console.error(creditProbeFailure+'; no video submitted or paid credits authorized.');
    process.exit(1);
  }
  if(creditWait){
    await callback({obligation_id:o.id,claim_id:claimId,status:'blocked',error:'WAITING_DAILY_FLOW_CREDIT_REFRESH',approved_stock:last.stock});
    console.log('Daily free Flow batch closed; no paid credits authorized.');
    process.exit(0);
  }

  await callback({obligation_id:o.id,claim_id:claimId,status:'running',error:'EPHEMERAL_RUNNER_TIMEOUT_RECONCILE_ONLY',approved_stock:last.stock});
  console.log('Timed out safely; persisted state for reconciliation. GitHub job must fail visibly.');
  process.exit(1);
}catch(err){
  killTree(child);
  const message=String(err?.stack||err).slice(0,1800);
  console.error(message);
  if(CURRENT){
    const blocked=/GITHUB_OIDC|MIGRATION_PROFILE_REQUIRED|AUTH_REQUIRED|MISSING_|FLOW_AUTH|FLOW_EXPECTED|SHOW_BIBLE_REQUIRED|AUTH_VAULT|FLOW_SECURITY_CHALLENGE|FLOW_UNUSUAL_ACTIVITY|GOOGLE_SECURITY/i.test(message);
    await callback({
      obligation_id:CURRENT.obligation.id,
      claim_id:CURRENT.claim_id,
      status:blocked?'blocked':'running',
      error:message,
      approved_stock:metrics().stock
    }).catch(()=>{});
  }
  process.exit(1);
}
// EARTH_GOLDEN_TRIGGER: 2026-10-07T20:46-03:00
