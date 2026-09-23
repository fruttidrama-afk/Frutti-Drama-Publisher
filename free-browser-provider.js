import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import {
  CONFIG, SHOW,
  DURATION_SECONDS, DURATION_LABEL, ASPECT_RATIO, OUTPUT_COUNT, OUTPUT_LABEL,
  MODEL_INTENT, RESOLUTION_INTENT, DAILY_LIMIT, CREDIT_PER_GENERATION,
  DAILY_CREDIT_BUDGET, TIMEZONE, registry as configRegistry,
  resolveVisualCharacters, buildPrompt, seedInitial, ensureBacklog, enforceEpisodeIntent, materializeCreativePackage, validateEpisodePrompt
} from './runtime-config.js';
import { buildPublicationCopy } from './publication-copy.js';
import { uploadReviewFile, reviewStorageConfigured, reviewStorageRequired } from './review-storage.js';

const CHROMIUM_PATH=String(process.env.CHROMIUM_PATH||'/usr/bin/chromium');
const DATA_DIR=path.resolve(process.env.DATA_DIR||(process.env.RAILWAY_ENVIRONMENT?'/data':'./data'));
const FACTORY_DIR=path.join(DATA_DIR,'publisher-runtime');
const DB_PATH=path.join(FACTORY_DIR,'factory.sqlite');
const VIDEO_DIR=path.join(FACTORY_DIR,'generated');
const PROFILE_DIR=path.join(FACTORY_DIR,'flow-profile');
const MIGRATION_OK=path.join(FACTORY_DIR,'free-browser-profile-ready.json');
const MIGRATION_ATTEMPT=path.join(FACTORY_DIR,'free-browser-profile-attempt.json');
const LOCK_FILE=path.join(FACTORY_DIR,'free-browser-provider.lock');
let LOCK_HEARTBEAT=null;
const LOCK_STALE_MS=90*1000;
const GOLDEN_RECOVERY_TOKEN=String(process.env.PUBLISHER_RECOVER_GOLDEN_RUN||'').trim();
const EXPECTED_FLOW_PROJECT_NAME=String(process.env.PUBLISHER_EXPECTED_FLOW_PROJECT_NAME||'').trim();
const GOLDEN_RECOVERY_EPISODE=Math.max(1,Number(process.env.PUBLISHER_RECOVERY_TARGET_EPISODE||1));
const GOLDEN_RECOVERY_TERMS=String(process.env.PUBLISHER_RECOVERY_PROMPT_TERMS||'').split('|').map(x=>String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()).filter(Boolean);

const BOOTSTRAP_LOCK=path.join(FACTORY_DIR,'flow-auth-bootstrap.active.json');
const STATUS_FILE=path.resolve(process.cwd(),'public','free-browser-status.json');
const PROVIDER='FreeBrowserProvider';
async function saveReviewAsset(db,row,localPath,flowResult,stamp=now()){
  let cloud=null;
  if(reviewStorageConfigured()||reviewStorageRequired())cloud=await uploadReviewFile(localPath,{itemId:row.id,revision:row.revision});
  if(cloud){
    flowResult.review_storage=cloud.provider;
    db.prepare(`UPDATE factory_items SET status='review',videoPath=NULL,remoteUrl=?,reviewOriginalSize=?,flowResult=?,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?`)
      .run(cloud.uri,cloud.size,JSON.stringify(flowResult),stamp,stamp,row.id);
    try{fs.rmSync(localPath,{force:true})}catch{}
  }else{
    db.prepare(`UPDATE factory_items SET status='review',videoPath=?,remoteUrl=NULL,flowResult=?,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?`)
      .run(localPath,JSON.stringify(flowResult),stamp,stamp,row.id);
  }
  return cloud;
}

const INSTANCE_ID=randomUUID();
const BASE_DAILY_PRODUCTION_LIMIT=DAILY_LIMIT;
const CREDITS_PER_GENERATION=CREDIT_PER_GENERATION;
const DAILY_FLOW_CREDIT_BUDGET=DAILY_CREDIT_BUDGET;
const PRODUCTION_START_EPISODE=1;
const escapeRe=v=>String(v??'').replace(/[.*+?^$()|[\]\\]/g,'\\$&');
function liveProject(){
  let g={...(CONFIG.generation||{})};
  try{const p=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'publisher-config.json'),'utf8'));g={...g,...(p.generation||{})}}catch{}
  try{const v=JSON.parse(fs.readFileSync(path.join(FACTORY_DIR,'flow-auth-verified.json'),'utf8'));if(v?.project_id)g={...g,project_id:v.project_id,project_url:'https://flow.google.com/project/'+v.project_id,project_name:v.project_name||g.project_name}}catch{}
  const id=String(g.project_id||'').trim(),url=String(g.project_url||(id?'https://flow.google.com/project/'+id:'')).trim(),name=String(g.project_name||CONFIG.identity?.show_name||SHOW||'Flow Project').trim();
  return{id,url,name};
}
function projectPath(){const p=liveProject();if(!p.id)throw new Error('FLOW_PROJECT_NOT_CONFIGURED');return'/project/'+p.id}
function flowUrl(){const p=liveProject();if(!p.url)throw new Error('FLOW_PROJECT_NOT_CONFIGURED');return p.url}
function projectName(){return liveProject().name}

async function visibleTopProjectTitle(page){
  const inputs=page.locator('input[aria-label="Editable text"]');
  for(let i=0;i<Math.min(await inputs.count().catch(()=>0),20);i++){
    const el=inputs.nth(i); if(!(await el.isVisible().catch(()=>false)))continue;
    const b=await el.boundingBox().catch(()=>null); if(!b||b.y>120)continue;
    return String(await el.inputValue().catch(()=>'')).trim();
  }
  return '';
}
function persistResolvedProject(id,name){
  const file=path.join(FACTORY_DIR,'flow-auth-verified.json');
  let v={};try{v=JSON.parse(fs.readFileSync(file,'utf8'))||{}}catch{}
  const next={...v,ok:true,project_id:id,project_url:'https://flow.google.com/project/'+id,project_name:name,verified_at:now()};
  fs.writeFileSync(file,JSON.stringify(next,null,2),{mode:0o600});
}
async function ensureExpectedFlowProject(page){
  const expected=EXPECTED_FLOW_PROJECT_NAME;
  if(!expected)return liveProject();

  const acceptExactProject=async(id,source)=>{
    const title=await visibleTopProjectTitle(page);
    const docTitle=compact(await page.title().catch(()=>''),300);
    const configuredId=String(liveProject().id||'');
    const titleMatches=title===expected;
    const docMatches=norm(docTitle).includes(norm(expected));
    const idMatches=Boolean(configuredId&&String(id)===configuredId);
    // Flow sometimes hides the editable title control. Exact configured project
    // UUID is authoritative; visible/document title is an additional check when available.
    if(titleMatches||docMatches||idMatches){
      persistResolvedProject(id,expected);
      publish('FLOW_PROJECT_VERIFIED',{project_name:expected,project_id:id,source,title:title||null,document_title:docTitle||null,message:'Exact expected Flow project verified.'});
      return{id,url:'https://flow.google.com/project/'+id,name:expected};
    }
    return null;
  };

  const currentUrl=String(page.url()||'');
  const m=currentUrl.match(/\/project\/([a-zA-Z0-9-]+)/);
  if(m){
    const accepted=await acceptExactProject(m[1],'current-project-url');
    if(accepted)return accepted;
  }

  await page.goto('https://flow.google.com/',{waitUntil:'domcontentloaded',timeout:60000});
  await sleep(2200);
  const cards=page.locator('flow-project-card');
  const seen=[],matches=[];
  for(let i=0;i<Math.min(await cards.count().catch(()=>0),60);i++){
    const card=cards.nth(i); if(!(await card.isVisible().catch(()=>false)))continue;
    const text=compact(await card.innerText().catch(()=>''),500);
    const a=card.locator('a[href*="/project/"]').first();
    const href=String(await a.getAttribute('href').catch(()=>'')||'');
    if(text||href)seen.push({i,text:compact(text,180),href:compact(href,220)});
    const lines=text.split(/\n+/).map(x=>x.trim()).filter(Boolean);
    const nt=norm(text),ne=norm(expected);
    if(lines.some(x=>norm(x)===ne)||nt===ne||nt.startsWith(ne+' '))matches.push({i,card,a,href,text});
  }
  if(matches.length!==1){
    publish('FLOW_EXPECTED_PROJECT_NOT_FOUND',{message:'Expected project "'+expected+'" not uniquely found. Visible cards='+JSON.stringify(seen.slice(0,20))});
    throw new Error('FLOW_EXPECTED_PROJECT_NOT_FOUND:'+expected+':matches='+matches.length);
  }
  const chosen=matches[0],href=chosen.href;
  if(!href)throw new Error('FLOW_EXPECTED_PROJECT_LINK_MISSING:'+expected);
  const absolute=href.startsWith('http')?href:'https://flow.google.com'+href;
  await page.goto(absolute,{waitUntil:'domcontentloaded',timeout:60000});
  await sleep(1600);
  const url=String(page.url()||''),mm=url.match(/\/project\/([a-zA-Z0-9-]+)/);
  if(!mm)throw new Error('FLOW_EXPECTED_PROJECT_NAVIGATION_FAILED:'+expected);
  const accepted=await acceptExactProject(mm[1],'project-grid-exact-name');
  if(!accepted)throw new Error('FLOW_EXPECTED_PROJECT_TITLE_MISMATCH:'+compact(await visibleTopProjectTitle(page),120));
  return accepted;
}

function modelMatches(v){const text=String(v||'');if(!MODEL_INTENT)return true;if(new RegExp(escapeRe(MODEL_INTENT),'i').test(text))return true;if(/omni/i.test(MODEL_INTENT)&&/omni/i.test(text)){if(/flash/i.test(MODEL_INTENT))return/flash/i.test(text);return true}return false}
const AFTER_GENERATE = new Set(['GENERATION_STARTED','RETRIEVING','RETRIEVAL_PENDING','RETRIEVED','REVIEW_READY']);
const AMBIGUOUS = new Set(['SUBMIT_BOUNDARY_ENTERED','SUBMIT_AMBIGUOUS']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = v => createHash('sha256').update(String(v), 'utf8').digest('hex');
const compact = (v, n=700) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const json = (v, f=null) => { try { return JSON.parse(String(v ?? '')); } catch { return f; } };
const now = () => new Date().toISOString();
const artDay = (d=new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
function dailyProductionLimit(day=artDay()){
  const base=Math.max(1,Number(BASE_DAILY_PRODUCTION_LIMIT||1));
  const overrideDay=String(process.env.PUBLISHER_DAILY_LIMIT_OVERRIDE_DAY||'').trim();
  const overrideCount=Math.max(base,Number(process.env.PUBLISHER_DAILY_LIMIT_OVERRIDE_COUNT||0)||0);
  return overrideDay===day&&overrideCount>base?overrideCount:base;
}
function dailyGenerationCount(db, day=artDay()) {
  return Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE day=? AND credits>0 AND COALESCE(generationKind,'automatic')<>'review_retry'").get(day)?.n||0);
}
function effectiveDailyCount(db,day=artDay()){return dailyGenerationCount(db,day)}
function ensureConfirmedGenerationAccounting(db){
  try{
    const rows=db.prepare("SELECT * FROM factory_items WHERE status IN ('generating','review') ORDER BY episode").all();
    for(const row of rows){
      const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
      if(!AFTER_GENERATE.has(state))continue;
      const runId=String(lc.generation_id||row.providerRunId||'').trim();
      if(!runId||/^manual-flow-golden-run:/.test(runId))continue;
      const existing=db.prepare("SELECT id,credits,status,generationKind FROM factory_generations WHERE itemId=? AND runId=? LIMIT 1").get(row.id,runId);
      const startedAt=String(lc.generation_started_at||lc.reconciled_at||row.lastProgressAt||now());
      const day=artDay(new Date(startedAt));
      const status=String(row.status)==='review'?'review':'running';
      if(existing){
        if(Number(existing.credits||0)<=0 || ['no_generation','infra_rejected'].includes(String(existing.status||''))){
          try{
            db.prepare("UPDATE factory_generations SET day=?,credits=?,status=?,error=NULL,generationKind='automatic',updatedAt=? WHERE id=?")
              .run(day,CREDITS_PER_GENERATION,status,now(),existing.id);
            publish('GENERATION_ACCOUNTING_REPAIRED',{episode:'E'+row.episode,job_id:row.id,run_id:runId,status,mode:'reactivated-existing'});
          }catch(e){publish('GENERATION_ACCOUNTING_REPAIR_WARNING',{episode:'E'+row.episode,message:compact(e?.message||e,300)})}
        }
        continue;
      }
      try{
        db.prepare("INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)")
          .run(randomUUID(),row.id,day,sha(String(row.promptHash||'')+':'+runId),CREDITS_PER_GENERATION,status,runId,startedAt,now(),'automatic');
        publish('GENERATION_ACCOUNTING_REPAIRED',{episode:'E'+row.episode,job_id:row.id,run_id:runId,status,mode:'inserted'});
      }catch(e){publish('GENERATION_ACCOUNTING_REPAIR_WARNING',{episode:'E'+row.episode,message:compact(e?.message||e,300)})}
    }
  }catch(e){publish('GENERATION_ACCOUNTING_REPAIR_WARNING',{message:compact(e?.message||e,300)})}
}
function reconcileGenerationCreditAccounting(db){
  try{
    db.prepare("UPDATE factory_generations SET credits=? WHERE credits>0 AND status NOT IN ('no_generation','infra_rejected') AND (runId='manual-flow-demo' OR runId LIKE 'free-%') AND credits<>?").run(CREDITS_PER_GENERATION,CREDITS_PER_GENERATION);
  }catch{}
  try{
    db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Superseded run produced no retained media; released from daily accounting.',updatedAt=? WHERE status='running' AND credits>0 AND runId LIKE 'free-%' AND EXISTS (SELECT 1 FROM factory_items i WHERE i.id=factory_generations.itemId AND i.videoPath IS NULL AND (i.providerRunId IS NULL OR i.providerRunId<>factory_generations.runId))").run(now());
  }catch{}
  try{
    const stale=db.prepare("SELECT id,providerRunId,reviewRetryToken,reviewRetrySubmittedToken FROM factory_items WHERE status='generating' AND videoPath IS NULL AND error LIKE '%RENDER_TIMEOUT%'").all();
    for(const row of stale){
      const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
      if(AFTER_GENERATE.has(state)||AMBIGUOUS.has(state))continue;
      const reviewerConsumed=String(row.reviewRetryToken||'')&&String(row.reviewRetryToken||'')===String(row.reviewRetrySubmittedToken||'');
      if(reviewerConsumed)continue;
      const run=String(row.providerRunId||'');
      if(run)db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='No Flow render was produced; released from daily accounting.',updatedAt=? WHERE itemId=? AND runId=? AND status='running'").run(now(),row.id,run);
      db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
      setLifecycle(db,row,'RECONCILED_NO_GENERATION',{prior_generation_id:run,reconciled_at:now(),evidence:'Runtime render timeout with zero playable videos and zero fresh Flow tiles; released for a clean submit retry.'});
      publish('STALE_FALSE_START_RELEASED',{job_id:row.id,message:'False generation start removed from daily accounting; job returned to draft.'});
    }
  }catch{}
  try{
    db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE videoPath IS NULL AND error LIKE '%WRONG_FLOW_MODE_TEXT_RESPONSE_AFTER_SEND%'").run(now(),now());
  }catch{}
}
function normalizeUnconfirmedPreGenerationRows(db){
  try{
    const forceEpisode=Number(process.env.PUBLISHER_FORCE_RESET_EPISODE||0);
    if(forceEpisode>0){
      const resetToken=String(process.env.PUBLISHER_RUNTIME_VERSION||'default');
      const resetKey='operator:force-reset:'+forceEpisode+':'+resetToken;
      if(meta(db,resetKey,'')!=='done'){
        const row=db.prepare("SELECT * FROM factory_items WHERE episode=? AND videoPath IS NULL").get(forceEpisode);
        if(row){
          db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Forced clean retry: operator confirmed prior attempts produced no Flow video.',updatedAt=? WHERE itemId=? AND status='running'").run(now(),row.id);
          db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=? AND videoPath IS NULL").run(now(),now(),row.id);
          setLifecycle(db,row,'FORCED_CLEAN_RETRY',{reconciled_at:now(),episode:forceEpisode,evidence:'Operator confirmed no automated video exists in Flow; one clean retry authorized.',automatic_submit_forbidden:false});
          publish('FORCED_CLEAN_RETRY',{episode:'E'+forceEpisode,job_id:row.id,message:'One-shot reset applied; stale retrieval/generation state cleared.'});
        }
        setMeta(db,resetKey,'done');
      }
    }
    const rows=db.prepare("SELECT * FROM factory_items WHERE videoPath IS NULL AND status NOT IN ('review','queued','historical','published') AND (reviewFeedback IS NULL OR TRIM(reviewFeedback)='') ORDER BY episode").all();
    let repaired=0;
    for(const row of rows){
      const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
      if(AFTER_GENERATE.has(state))continue;
      const confirmed=Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE itemId=? AND credits>0 AND status NOT IN ('no_generation','infra_rejected')").get(row.id)?.n||0);
      if(confirmed>0)continue;
      if(String(row.status||'')==='draft')continue;
      if(AMBIGUOUS.has(state))continue;
      db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
      setLifecycle(db,row,'UNCONFIRMED_ATTEMPT_RESET',{reconciled_at:now(),automatic_submit_forbidden:false,evidence:'No hard Flow generation evidence or retained media exists.'});
      repaired++;
    }
    if(repaired)publish('UNCONFIRMED_ATTEMPTS_RESET',{message:'Reset '+repaired+' pre-generation attempt(s); strict episode ordering will retry the earliest episode only.'});
  }catch(e){publish('UNCONFIRMED_RESET_WARNING',{message:compact(e?.message||e,300)})}
}
function ensureProductionPlan(db){
  seedInitial(db);ensureBacklog(db);setMeta(db,'automation:productionPlanVersion','publisher-runtime-v1');if(!meta(db,'automation:factoryEnabled',''))setMeta(db,'automation:factoryEnabled',String(process.env.PUBLISHER_ENABLED||'false').toLowerCase()==='true'?'true':'false');setMeta(db,'automation:freeFactoryEnabled','1');if(!meta(db,'flow:state',''))setMeta(db,'flow:state','CONECTADO');setMeta(db,'flow:message','Publisher Runtime v1 active; daily target '+dailyProductionLimit()+'.');
}
function dbOpen() { return new DatabaseSync(DB_PATH, { timeout:5000 }); }
function meta(db, key, fallback='') { return db.prepare('SELECT value FROM factory_meta WHERE key=?').get(key)?.value ?? fallback; }
function setMeta(db, key, value) { db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value)); }
function lifecycle(db, row) { return json(meta(db, `flow:generationLifecycle:${row.id}`, ''), null); }
function setLifecycle(db, row, state, extra={}) {
  const previous = lifecycle(db,row) || {};
  const progressAt=now();
  // Explicit transition arguments are authoritative. Many callers carry the
  // previous lifecycle in `extra`; applying extra last silently restored the
  // OLD state and trapped REDO jobs in SUBMIT_BOUNDARY_ENTERED forever.
  const value = { ...previous, ...extra, state, provider:PROVIDER, updated_at:progressAt };
  setMeta(db, `flow:generationLifecycle:${row.id}`, JSON.stringify(value));
  try{db.prepare('UPDATE factory_items SET lastProgressAt=?,updatedAt=? WHERE id=?').run(progressAt,progressAt,row.id);}catch{}
  setMeta(db, 'flow:currentStep', state.toLowerCase());
  setMeta(db, 'flow:state', state === 'REVIEW_READY' ? 'CONECTADO' : 'GENERANDO');
  setMeta(db, 'flow:message', `${row.season}x${row.episode} ${state} vía ${PROVIDER}.`);
  return value;
}
function publish(state, extra={}) {
  const payload = { state, at:now(), provider:PROVIDER, tinyfish_required:false, ...extra };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(payload, null, 2), { encoding:'utf8', mode:0o644 }); } catch {}
  const logDetail=extra?.message||compact(JSON.stringify(extra||{}),2400);
  console.log('[FREE BROWSER]', state, compact(JSON.stringify(extra||{}),3200));
}
function pidAlive(pid){
  const n=Number(pid);
  if(!Number.isInteger(n)||n<=0)return false;
  try{process.kill(n,0);return true;}catch{return false;}
}
function bootstrapOwnsProfile() {
  try {
    if (!fs.existsSync(BOOTSTRAP_LOCK)) return false;
    const raw=json(fs.readFileSync(BOOTSTRAP_LOCK,'utf8'),{});
    const age = Date.now() - fs.statSync(BOOTSTRAP_LOCK).mtimeMs;
    if (!pidAlive(raw?.pid) || age > 2*60*60*1000) { try { fs.unlinkSync(BOOTSTRAP_LOCK); } catch {} return false; }
    const lockedProfile=String(raw?.profile_dir||'').trim();
    // Old bootstrap locks belong to /browser-profile, while the production
    // provider now uses /gflow-cli/profile_fruttidrama. Only block on the same profile.
    if(!lockedProfile) return false;
    return path.resolve(lockedProfile)===path.resolve(PROFILE_DIR);
  } catch { return false; }
}
function touchLockLease(){
  try{
    if(!fs.existsSync(LOCK_FILE))return;
    const raw=json(fs.readFileSync(LOCK_FILE,'utf8'),{});
    if(String(raw?.instance_id||'')!==INSTANCE_ID)return;
    fs.writeFileSync(LOCK_FILE,JSON.stringify({pid:process.pid,instance_id:INSTANCE_ID,at:now(),lease:true}),{mode:0o600});
  }catch{}
}
function acquireLock() {
  try {
    if (bootstrapOwnsProfile()) return false;
    if (fs.existsSync(LOCK_FILE)){
      let stale=false;
      try{
        const age=Date.now()-fs.statSync(LOCK_FILE).mtimeMs;
        stale=age>LOCK_STALE_MS;
      }catch{stale=true;}
      if(!stale)return false;
      try{fs.unlinkSync(LOCK_FILE);}catch{}
    }
    const fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid:process.pid, instance_id:INSTANCE_ID, at:now(), lease:true })); fs.closeSync(fd);
    clearInterval(LOCK_HEARTBEAT);
    LOCK_HEARTBEAT=setInterval(touchLockLease,30000);LOCK_HEARTBEAT.unref?.();
    return true;
  } catch { return false; }
}
function releaseLock() {
  clearInterval(LOCK_HEARTBEAT);LOCK_HEARTBEAT=null;
  try{
    if(!fs.existsSync(LOCK_FILE))return;
    const raw=json(fs.readFileSync(LOCK_FILE,'utf8'),{});
    if(String(raw?.instance_id||'')===INSTANCE_ID)fs.unlinkSync(LOCK_FILE);
  }catch{}
}
function registry(){return configRegistry();}
function ensureSchema(db) {
  for (const sql of [
    `ALTER TABLE factory_items ADD COLUMN promptGenerationId TEXT`,
    `ALTER TABLE factory_items ADD COLUMN characterRoles TEXT`,
    `ALTER TABLE factory_items ADD COLUMN promptPayloadHash TEXT`,
    `ALTER TABLE factory_items ADD COLUMN promptPayloadLength INTEGER`,
    `ALTER TABLE factory_items ADD COLUMN creativePackageHash TEXT`,
    `ALTER TABLE factory_items ADD COLUMN creativePackageId TEXT`,
    `ALTER TABLE factory_items ADD COLUMN transportPreflight TEXT`,
    `ALTER TABLE factory_items ADD COLUMN runtimeAttemptCount INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE factory_items ADD COLUMN lastProgressAt TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewFeedback TEXT`,
    `ALTER TABLE factory_items ADD COLUMN retryStrategy TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewRetryToken TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewRetrySubmittedToken TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewContentHash TEXT`,
    `ALTER TABLE factory_generations ADD COLUMN generationKind TEXT NOT NULL DEFAULT 'automatic'`
  ]) { try { db.exec(sql); } catch {} }
}
function checkpoint(row){
  const prompt=String(row?.prompt||'');if(prompt.length<400)return null;const hash=sha(prompt);if(String(row.promptHash||'')!==hash)return null;if(String(row.promptPayloadHash||hash)!==hash)return null;if(Number(row.promptPayloadLength||Buffer.byteLength(prompt,'utf8'))!==Buffer.byteLength(prompt,'utf8'))return null;
  const roles=json(row.characterRoles,[]),visual=Array.isArray(roles)?roles.filter(r=>r?.visual===true&&r?.role==='ON_SCREEN').map(r=>String(r.name||'').trim()).filter(Boolean):[];if(visual.length>3)return null;return{prompt,hash,visual,bytes:Buffer.byteLength(prompt,'utf8'),first:prompt.slice(0,180),last:prompt.slice(-180)};
}
function matchingCharacters(row){return resolveVisualCharacters(row);}
function previousContinuity(db,row){if(!CONFIG.content.serialized)return'Independent episode.';const prev=db.prepare('SELECT hook,story,status FROM factory_items WHERE episode<? ORDER BY episode DESC LIMIT 1').get(Number(row.episode));return prev?('Previous canonical beat: '+prev.hook+' — '+prev.story):(CONFIG.content.canon||'Start from the configured Creative Bible.');}
function buildLocalPrompt(db,row,visual){return buildPrompt(db,row,visual);}
function creativePackageHash(row,prompt,title,description){
  return sha(JSON.stringify({
    episode:Number(row?.episode||0),
    hook:String(row?.hook||''),
    story:String(row?.story||''),
    prompt:String(prompt||''),
    title:String(title||''),
    description:String(description||'')
  }));
}
function buildCreativePackage(row,prompt){
  const provider=(CONFIG.publication?.providers||[]).find(x=>x.type==='youtube')||{};
  const copy=buildPublicationCopy({
    hook:row.hook,
    story:row.story,
    prompt,
    contextTerms:[],
    hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
    showName:CONFIG.identity?.show_name||SHOW,
    maxTitleLength:100
  });
  let description=String(copy.description||'');
  while(Buffer.byteLength(description,'utf8')>4800)description=description.slice(0,-30).trimEnd();
  const title=String(copy.title||'').slice(0,100);
  if(!title.trim()||!description.trim())throw new Error('CREATIVE_PACKAGE_METADATA_EMPTY');
  return{title,description,hash:creativePackageHash(row,prompt,title,description),id:'creative-package-v1-'+randomUUID()};
}
function packageMatches(row){
  const prompt=String(row?.prompt||''),title=String(row?.title||''),description=String(row?.description||'');
  if(!prompt||!title||!description||!String(row?.creativePackageHash||''))return false;
  if(String(row.creativePackageHash)!==creativePackageHash(row,prompt,title,description))return false;
  if(/earth\s*in\s*10/i.test(String(CONFIG.identity?.show_name||SHOW||''))){
    const provider=(CONFIG.publication?.providers||[]).find(x=>x.type==='youtube')||{};
    const expected=buildPublicationCopy({
      hook:row.hook,story:row.story,prompt,contextTerms:[],
      hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
      showName:CONFIG.identity?.show_name||SHOW,maxTitleLength:100
    });
    let d=String(expected.description||'');
    while(Buffer.byteLength(d,'utf8')>4800)d=d.slice(0,-30).trimEnd();
    if(title!==String(expected.title||'').slice(0,100)||description!==d)return false;
  }
  return true;
}
function preparePromptIfNeeded(db,row){
  const revise=String(row?.retryStrategy||'')==='revise_prompt'&&String(row?.reviewFeedback||'').trim().length>=3&&retryTokenOpen(row);
  const pkg=materializeCreativePackage(db,row,{force:revise});
  row=pkg.row;
  if(pkg.repaired)publish('EPISODE_INTENT_REPAIRED',{episode:'E'+row.episode,job_id:row.id,reason:pkg.reason,hook:compact(row.hook,120),story:compact(row.story,320)});
  if(pkg.created)publish('CREATIVE_PACKAGE_READY',{episode:'E'+row.episode,job_id:row.id,prompt_hash:row.promptHash,package_hash:row.creativePackageHash,title:row.title,reason:revise?'human-redo-revision':'episode-materialization'});
  validateEpisodePrompt(row,row.prompt);
  const cp=checkpoint(row);
  if(!cp||!packageMatches(row))throw new Error('RUNTIME_CREATIVE_PACKAGE_CHECKPOINT_FAILED');
  return{...cp,title:row.title,description:row.description,creativePackageHash:row.creativePackageHash,creativePackageId:row.creativePackageId};
}

function reviewMetadata(row,flowResult={}){
  const provider=(CONFIG.publication?.providers||[]).find(x=>x.type==='youtube')||{};
  const terms=Array.isArray(flowResult?.matched_terms)?flowResult.matched_terms:[];
  const override=flowResult?.publication_override;
  const copy=override?.title&&override?.description
    ? {title:String(override.title),description:String(override.description)}
    : buildPublicationCopy({
        hook:row.hook,
        story:row.story,
        prompt:row.prompt,
        contextTerms:terms,
        hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
        showName:CONFIG.identity?.show_name||SHOW,
        maxTitleLength:100
      });
  let description=String(copy.description||'');
  while(Buffer.byteLength(description,'utf8')>4800)description=description.slice(0,-30).trimEnd();
  return{title:String(copy.title||'').slice(0,100),description};
}
function persistReviewMetadata(db,row,flowResult={}){
  try{
    const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row;
    if(packageMatches(fresh)){
      const m={title:String(fresh.title),description:String(fresh.description)};
      publish('REVIEW_METADATA_READY',{episode:'E'+fresh.episode,job_id:fresh.id,title:m.title,source:'creative-package',package_hash:fresh.creativePackageHash});
      return m;
    }
    const m=reviewMetadata(fresh,flowResult),pkgHash=creativePackageHash(fresh,fresh.prompt,m.title,m.description);
    db.prepare('UPDATE factory_items SET title=?,description=?,creativePackageHash=?,creativePackageId=?,updatedAt=? WHERE id=?')
      .run(m.title,m.description,pkgHash,'creative-package-legacy-'+randomUUID(),now(),fresh.id);
    publish('REVIEW_METADATA_READY',{episode:'E'+fresh.episode,job_id:fresh.id,title:m.title,source:'legacy-repair',package_hash:pkgHash});
    return m;
  }catch(e){
    publish('REVIEW_METADATA_WARNING',{episode:'E'+row.episode,job_id:row.id,message:compact(e?.message||e,400)});
    return null;
  }
}
async function getBody(page) { return await page.locator('body').innerText().catch(()=> ''); }

async function promptEditor(page) {
  // Flow exposes another visible input named "Editable text" that is not the
  // generation composer. Prefer the contenteditable closest to Start generation.
  const content=page.locator('[contenteditable="true"]');
  let best=null,bestScore=-Infinity;
  const send=page.getByRole('button',{name:/Start generation|Iniciar generación/i}).last();
  const sendBox=await send.boundingBox().catch(()=>null);
  for(let i=0;i<await content.count();i++){
    const c=content.nth(i);
    if(!(await c.isVisible().catch(()=>false)))continue;
    const box=await c.boundingBox().catch(()=>null);
    if(!box)continue;
    const area=box.width*box.height;
    const dy=sendBox?Math.abs((box.y+box.height/2)-(sendBox.y+sendBox.height/2)):0;
    const score=area-dy*1000;
    if(score>bestScore){bestScore=score;best=c;}
  }
  if(best)return best;
  const old=page.getByPlaceholder('What do you want to create?').last();
  if(await old.count().catch(()=>0)&&await old.isVisible().catch(()=>false))return old;
  throw new Error('FLOW_PROMPT_EDITOR_NOT_FOUND');
}


async function classifyPromptTarget(page,editor){
  const box=await editor.boundingBox().catch(()=>null);
  const send=page.getByRole('button',{name:/Start generation/i}).last();
  const sendBox=await send.boundingBox().catch(()=>null);
  if(!box||!sendBox)return'OTHER';
  const dy=Math.abs((box.y+box.height/2)-(sendBox.y+sendBox.height/2));
  if(box.y<140||dy>220)return'OTHER';
  return'VIDEO_PROMPT_COMPOSER';
}
async function ensureCanonicalProjectTitle(page){
  if(!String(page.url()||'').includes(projectPath()))throw new Error('WRONG_FLOW_PROJECT');
  const inputs=page.locator('input[aria-label="Editable text"]');let titleInput=null,current='';
  for(let i=0;i<await inputs.count().catch(()=>0);i++){
    const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    const b=await el.boundingBox().catch(()=>null);if(!b||b.y>100)continue;
    titleInput=el;current=String(await el.inputValue().catch(()=>''));break;
  }
  if(!titleInput){
    return{repaired:false,previous:projectName(),source:'exact-project-url-title-control-hidden'};
  }
  if(current.trim()===projectName())return{repaired:false,previous:projectName(),source:'title-input'};
  const corrupt=current.length>180||/PRODUCTION PROMPT|GENERATION PROMPT|VIDEO FACTORY|PUBLISHER RUNTIME|DURATION \/ FORMAT|ANTI-GLITCH/i.test(current);
  if(!corrupt)throw new Error('PROJECT_TITLE_UNEXPECTED_VALUE:'+compact(current,120));
  const previous=compact(current,180);
  await titleInput.fill(projectName());await titleInput.press('Enter').catch(()=>{});await page.keyboard.press('Tab').catch(()=>{});
  const deadline=Date.now()+7000;
  while(Date.now()<deadline){
    const value=String(await titleInput.inputValue().catch(()=>''));
    if(value.trim()===projectName()){
      publish('PROJECT_TITLE_REPAIRED',{message:'Flow project title restored to configured publisher project.'});
      return{repaired:true,previous,source:'title-input'};
    }
    await sleep(250);
  }
  throw new Error('PROJECT_TITLE_REPAIR_NOT_CONFIRMED');
}

async function projectTitleDiagnostic(page){
  try{const rows=await page.evaluate(()=>{const out=[];for(const el of document.querySelectorAll('input,textarea,[contenteditable="true"],button,[role="button"],[role="textbox"],h1,h2,[aria-label]')){const r=el.getBoundingClientRect();if(r.width<4||r.height<4||r.y<0||r.y>220)continue;const text=String((typeof el.value==='string'&&el.value)||el.innerText||el.textContent||'').replace(/\s+/g,' ').trim(),aria=String(el.getAttribute('aria-label')||'').trim(),title=String(el.getAttribute('title')||'').trim();if(!text&&!aria&&!title)continue;out.push({tag:el.tagName.toLowerCase(),text:text.slice(0,180),aria:aria.slice(0,120),title:title.slice(0,120),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});if(out.length>=60)break}return out});const diag={at:now(),document_title:compact(await page.title().catch(()=>''),260),url:compact(page.url(),220),candidates:rows};try{fs.writeFileSync(path.join(FACTORY_DIR,'flow-project-title-diagnostic.json'),JSON.stringify(diag,null,2),{mode:0o600})}catch{}publish('PROJECT_TITLE_REPAIR_REQUIRED',{message:'Configured Flow project title could not be verified.',evidence:JSON.stringify(rows.slice(0,8)).slice(0,900)});return diag}catch{return null}
}
async function repairProjectTitleIfContaminated(page){
  if(!String(page.url()||'').includes(projectPath()))throw new Error('WRONG_FLOW_PROJECT');const more=page.getByRole('button',{name:/More options for the project/i}).last();if(!(await more.count().catch(()=>0))||!(await more.isVisible().catch(()=>false)))throw new Error('PROJECT_TITLE_CONTEXT_NOT_FOUND');
  const inputs=page.locator('input[aria-label="Editable text"]');let titleInput=null;for(let i=0;i<await inputs.count().catch(()=>0);i++){const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const b=await el.boundingBox().catch(()=>null);if(!b||b.y>100||b.x>240||b.width>320)continue;titleInput=el;break}if(!titleInput)throw new Error('PROJECT_TITLE_INPUT_NOT_FOUND');
  const current=String(await titleInput.inputValue().catch(()=>'')).replace(/\s+/g,' ').trim();if(current===projectName())return{repaired:false,before:current,after:projectName()};const contaminated=current.length>180||/PRODUCTION PROMPT|GENERATION PROMPT|VIDEO FACTORY|PUBLISHER RUNTIME|DURATION \/ FORMAT|ANTI-GLITCH/i.test(current);if(!contaminated)throw new Error('PROJECT_TITLE_UNEXPECTED_VALUE:'+compact(current,120));
  await titleInput.fill(projectName());await titleInput.press('Enter').catch(()=>{});await page.keyboard.press('Tab').catch(()=>{});await sleep(1000);const after=String(await titleInput.inputValue().catch(()=>'')).replace(/\s+/g,' ').trim();if(after!==projectName())throw new Error('PROJECT_TITLE_REPAIR_NOT_PERSISTED:'+compact(after,120));publish('PROJECT_TITLE_REPAIRED',{message:'Configured Flow project title restored; no generation submitted.'});return{repaired:true,before:compact(current,180),after};
}
async function verifyProjectIdentity(page,payload=''){
  if(!liveProject().id||!String(page.url()||'').includes(projectPath()))throw new Error('WRONG_FLOW_PROJECT');
  const inputs=page.locator('input[aria-label="Editable text"]');let titleInput=null,titleValue='';
  for(let i=0;i<await inputs.count().catch(()=>0);i++){
    const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    const b=await el.boundingBox().catch(()=>null);if(!b||b.y>100)continue;
    titleInput=el;titleValue=String(await el.inputValue().catch(()=>'')).trim();break;
  }
  const prefix=compact(payload,120);
  if(titleInput){
    if(titleValue!==projectName())throw new Error('PROJECT_TITLE_NOT_CONFIGURED:'+compact(titleValue,120));
    if(prefix&&titleValue.includes(prefix))throw new Error('PROJECT_TITLE_CONTAMINATED_WITH_PROMPT');
    return{project:projectName(),project_id:liveProject().id,title_verified:true,source:'exact-project-title-input',document_title_observed:compact(await page.title().catch(()=>''),300)};
  }
  return{project:projectName(),project_id:liveProject().id,title_verified:true,source:'exact-project-url-title-control-hidden',document_title_observed:compact(await page.title().catch(()=>''),300)};
}

async function waitFlowReady(page,timeout=60000){
  if(!liveProject().id)throw new Error('FLOW_PROJECT_NOT_CONFIGURED');const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const url=String(page.url()||'');if(/accounts\.google\.com|signin|ServiceLogin/i.test(url))throw new Error('FLOW_AUTH_REQUIRED');const text=(await getBody(page)).slice(0,12000);if(/verify it'?s you|captcha|security check|email or phone|enter your password/i.test(text))throw new Error('FLOW_AUTH_CHALLENGE');if(url.includes(projectPath())){try{const editor=await promptEditor(page),send=page.getByRole('button',{name:/Start generation/i}).last();if(await editor.isVisible().catch(()=>false)&&await send.isVisible().catch(()=>false))return editor}catch{}}await sleep(500)}throw new Error('FLOW_NOT_READY:'+compact(page.url(),200));
}
function cleanChromiumLocks() {
  for (const name of ['SingletonLock','SingletonSocket','SingletonCookie']) try { fs.unlinkSync(path.join(PROFILE_DIR,name)); } catch {}
  try{
    for(const name of fs.readdirSync('/tmp')){
      if(/^\.X\d+-lock$/.test(name))try{fs.unlinkSync(path.join('/tmp',name))}catch{}
    }
  }catch{}
  try{
    const dir='/tmp/.X11-unix';
    for(const name of fs.readdirSync(dir)){
      if(/^X\d+$/.test(name))try{fs.unlinkSync(path.join(dir,name))}catch{}
    }
  }catch{}
}
function browserInfraPids(){
  const out=[];let names=[];try{names=fs.readdirSync('/proc')}catch{return out}
  for(const name of names){
    if(!/^\d+$/.test(name))continue;
    const pid=Number(name);if(!pid||pid===process.pid)continue;
    try{
      const cmd=fs.readFileSync('/proc/'+name+'/cmdline').toString('utf8').replace(/\0/g,' ');
      if(/Xvfb|google-chrome|chrome_crashpad_handler|\/chrome\b/i.test(cmd))out.push(pid);
    }catch{}
  }
  return [...new Set(out)];
}
function profileChromePids(){
  const out=[];let names=[];try{names=fs.readdirSync('/proc');}catch{return out;}
  for(const name of names){
    if(!/^\d+$/.test(name))continue;
    const pid=Number(name);if(!pid||pid===process.pid)continue;
    try{
      const cmd=fs.readFileSync('/proc/'+name+'/cmdline').toString('utf8').replace(/\0/g,' ');
      if(/google-chrome|chrome/i.test(cmd)&&cmd.includes(PROFILE_DIR))out.push(pid);
    }catch{}
  }
  return [...new Set(out)];
}
async function stopBrowserInfra(){
  const pids=browserInfraPids();
  for(const pid of pids){try{process.kill(pid,'SIGTERM')}catch{}}
  if(pids.length)await sleep(700);
  for(const pid of browserInfraPids()){try{process.kill(pid,'SIGKILL')}catch{}}
  cleanChromiumLocks();
}
async function stopProfileChrome(){await stopBrowserInfra()}
async function launchLocal() {
  if(!fs.existsSync(path.join(PROFILE_DIR,'Default','Cookies')))throw new Error('GFLOW_AUTH_PROFILE_MISSING');

  // Exactly one browser/Xvfb pair may exist in this worker. Previous code could
  // leak Xvfb/Chrome when connectOverCDP timed out, eventually exhausting
  // pthread/fork resources and freezing the next episode.
  await stopBrowserInfra();

  const display=':99';
  const port=9222;
  let xvfb=null,chrome=null,browser=null;
  let xvfbErr='',chromeErr='';
  const cleanup=async()=>{
    try{await browser?.close()}catch{}
    try{chrome?.kill('SIGTERM')}catch{}
    try{xvfb?.kill('SIGTERM')}catch{}
    await sleep(300);
    try{chrome?.kill('SIGKILL')}catch{}
    try{xvfb?.kill('SIGKILL')}catch{}
    await stopBrowserInfra().catch(()=>{});
  };

  try{
    xvfb=spawn('Xvfb',[display,'-screen','0','1024x700x24','-nolisten','tcp','-ac'],{stdio:['ignore','ignore','pipe']});
    xvfb.stderr?.on('data',d=>{xvfbErr=(xvfbErr+String(d)).slice(-1800)});
    await sleep(650);
    if(xvfb.exitCode!==null)throw new Error('XVFB_START_FAILED:'+compact(xvfbErr,700));

    const env={...process.env,DISPLAY:display};
    chrome=spawn('/usr/bin/google-chrome-stable',[
      '--user-data-dir='+PROFILE_DIR,
      '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--remote-allow-origins=*',
      '--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer',
      '--renderer-process-limit=1','--disable-site-isolation-trials','--no-zygote',
      '--disable-features=IsolateOrigins,site-per-process,CalculateNativeWinOcclusion,OptimizationHints,MediaRouter',
      '--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-default-apps',
      '--metrics-recording-only','--no-first-run','--no-default-browser-check','--password-store=basic',
      '--disk-cache-dir=/tmp/publisher-chrome-cache','--disk-cache-size=16777216','--media-cache-size=8388608',
      '--js-flags=--max-old-space-size=160','--window-size=1024,700',
      flowUrl()
    ],{env,stdio:['ignore','ignore','pipe']});
    chrome.stderr?.on('data',d=>{chromeErr=(chromeErr+String(d)).slice(-3600)});

    let cdpReady=false;
    for(let i=0;i<100;i++){
      await sleep(250);
      if(chrome.exitCode!==null)break;
      try{
        const r=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(900)});
        if(r.ok){cdpReady=true;break}
      }catch{}
    }
    if(!cdpReady)throw new Error('CHROME_CDP_NOT_READY:exit='+String(chrome.exitCode)+':stderr='+compact(chromeErr,900)+':xvfb='+compact(xvfbErr,400));

    browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:30000});
    const context=browser.contexts()[0];
    if(!context)throw new Error('CHROME_CDP_CONTEXT_MISSING');
    const pages=context.pages();
    const page=[...pages].reverse().find(p=>String(p.url()).includes('flow.google.com'))||pages[0]||await context.newPage();
    return {browser,context,page,close:cleanup};
  }catch(err){
    await cleanup();
    throw err;
  }
}

async function seedPersistentProfile(storage, ua='') {
  cleanChromiumLocks();
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR,{executablePath:CHROMIUM_PATH,headless:true,acceptDownloads:true,userAgent:ua||undefined,locale:'en-US',timezoneId:TIMEZONE,viewport:{width:1440,height:1000},args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  try {
    if (Array.isArray(storage?.cookies) && storage.cookies.length) await ctx.addCookies(storage.cookies);
    for (const origin of Array.isArray(storage?.origins) ? storage.origins : []) {
      if (!origin?.origin || !Array.isArray(origin?.localStorage) || !origin.localStorage.length) continue;
      const p = await ctx.newPage();
      try { await p.goto(origin.origin,{waitUntil:'domcontentloaded',timeout:30000}); await p.evaluate(items=>{for(const i of items)localStorage.setItem(i.name,i.value);},origin.localStorage); } catch {}
      try { await p.close(); } catch {}
    }
    const p = ctx.pages()[0] || await ctx.newPage(); await p.goto(flowUrl(),{waitUntil:'domcontentloaded',timeout:60000}); await waitFlowReady(p,60000);
  } finally { await ctx.close().catch(()=>{}); }
}
async function migrateProfileOnce(db) {
  const cookies=path.join(PROFILE_DIR,'Default','Cookies');
  if(fs.existsSync(cookies)){
    setMeta(db,'automation:provider',PROVIDER);
    setMeta(db,'automation:paidDependencyDetected','false');
    setMeta(db,'automation:tinyfishRequired','false');
    setMeta(db,'automation:tinyfishMigrationComplete','true');
    setMeta(db,'automation:tinyfishCallsAfterMigration','0');
    return true;
  }
  setMeta(db,'flow:state','REQUIERE REAUTENTICACIÓN');
  setMeta(db,'flow:message','Falta el perfil autenticado de Google Flow.');
  publish('AUTH_BOOTSTRAP_REQUIRED',{message:'Authenticated gflow Chrome profile is missing. No paid fallback will be used.'});
  return false;
}

async function visibleExact(page,text) {
  const loc=page.getByText(text,{exact:true}); for(let i=(await loc.count())-1;i>=0;i--){const c=loc.nth(i);if(await c.isVisible().catch(()=>false))return c;} return null;
}
async function clickInteractive(locator) { await locator.evaluate(el=>{const t=el.closest('button,[role="button"],[role="option"],[role="menuitem"],[role="radio"],[role="tab"]')||el;if(typeof t.click==='function')t.click();else t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}); }
async function trustedClick(locator){
  try{
    await locator.scrollIntoViewIfNeeded().catch(()=>{});
    const box=await locator.boundingBox().catch(()=>null);
    if(box){
      const page=locator.page();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      await page.mouse.down();
      await sleep(80);
      await page.mouse.up();
      return true;
    }
  }catch{}
  await locator.click({timeout:4000}).catch(async()=>{await clickInteractive(locator)});
  return true;
}
async function settingsButton(page) {
  const direct=page.getByRole('button',{name:/Settings trigger|Settings|Generation settings|Video settings/i}).last();
  if(await direct.count().catch(()=>0)&&await direct.isVisible().catch(()=>false))return direct;
  const buttons=page.locator('button');let best=null,bestScore=-1,bestDesc='';
  for(let i=0;i<await buttons.count().catch(()=>0);i++){
    const b=buttons.nth(i);if(!(await b.isVisible().catch(()=>false)))continue;
    const desc=compact(((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+((await b.getAttribute('title').catch(()=>''))||'')+' '+((await b.innerText().catch(()=>''))||''),240),n=norm(desc);
    if(/start generation|generate|add ingredients|clear prompt|download|share/i.test(desc))continue;
    let score=0;if(/setting|configur/.test(n))score+=7;if(/video/.test(n))score+=4;if(n.includes(norm(ASPECT_RATIO)))score+=4;if(n.includes(norm(DURATION_LABEL)))score+=3;if(n.includes(norm(OUTPUT_LABEL)))score+=2;if(/model|resolution|aspect|duration|output/.test(n))score+=2;
    const box=await b.boundingBox().catch(()=>null);if(box&&box.y>350)score+=1;
    if(score>bestScore){bestScore=score;best=b;bestDesc=desc}
  }
  if(best&&bestScore>=4)return best;
  const samples=[];for(let i=0;i<Math.min(await buttons.count().catch(()=>0),50);i++){const b=buttons.nth(i);if(!(await b.isVisible().catch(()=>false)))continue;const d=compact(((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+((await b.innerText().catch(()=>''))||''),100);if(d)samples.push(d)}
  throw new Error('FLOW_SETTINGS_BUTTON_NOT_FOUND:'+compact(samples.join(' | '),650));
}
async function ensureSettingsOpen(page){
  const visibleSetting=async()=>{
    const radio=page.getByRole('radio',{name:/Video/i}).last();
    if(await radio.count().catch(()=>0)&&await radio.isVisible().catch(()=>false))return true;
    const ratio=page.getByText(new RegExp('^'+escapeRe(ASPECT_RATIO)+'$','i')).last();
    if(await ratio.count().catch(()=>0)&&await ratio.isVisible().catch(()=>false))return true;
    return false;
  };
  if(await visibleSetting())return;
  const b=await settingsButton(page);
  await clickInteractive(b);
  const deadline=Date.now()+6500;
  while(Date.now()<deadline){if(await visibleSetting())return;await sleep(180)}
  throw new Error('FLOW_SETTINGS_MENU_NOT_OPEN:'+compact(await b.innerText().catch(()=>''),180));
}
async function clickRadio(page,re,label){
  const radios=page.getByRole('radio',{name:re});
  for(let i=(await radios.count().catch(()=>0))-1;i>=0;i--){
    const r=radios.nth(i);if(!(await r.isVisible().catch(()=>false)))continue;
    const checked=await r.getAttribute('aria-checked').catch(()=>null);
    if(checked!=='true')await clickInteractive(r);
    await sleep(300);
    const after=await r.getAttribute('aria-checked').catch(()=>null);
    if(after==='true'||after===null)return true;
  }
  const roles=['button','option','menuitem','tab'];
  for(const role of roles){
    const loc=page.getByRole(role,{name:re});
    for(let i=(await loc.count().catch(()=>0))-1;i>=0;i--){
      const el=loc.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
      await clickInteractive(el);await sleep(320);return true;
    }
  }
  const exact=page.getByText(re);
  for(let i=(await exact.count().catch(()=>0))-1;i>=0;i--){
    const el=exact.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    await clickInteractive(el);await sleep(320);return true;
  }
  const body=compact(await getBody(page),1200);
  throw new Error('FLOW_SETTING_NOT_FOUND:'+label+':'+body);
}
async function configureFlow(page){
  await waitFlowReady(page,60000);
  await ensureSettingsOpen(page);
  await clickRadio(page,/Video/i,'Video');
  await clickRadio(page,new RegExp('^'+escapeRe(ASPECT_RATIO)+'$','i'),ASPECT_RATIO);

  const modelTokens=norm(MODEL_INTENT).split(' ').filter(x=>x.length>2);
  let modelButton=null,currentModel='';
  const directModel=page.getByRole('button',{name:/Select model family|Model|Omni|Veo|Flash/i});
  for(let i=(await directModel.count().catch(()=>0))-1;i>=0;i--){
    const btn=directModel.nth(i);
    if(!(await btn.isVisible().catch(()=>false)))continue;
    const txt=compact(((await btn.getAttribute('aria-label').catch(()=>''))||'')+' '+((await btn.innerText().catch(()=>''))||''),220);
    if(/model|omni|veo|flash/i.test(txt)){modelButton=btn;currentModel=txt;break}
  }
  if(!modelButton){
    const buttons=page.locator('button');let scoreBest=-1;
    for(let i=0;i<await buttons.count().catch(()=>0);i++){
      const btn=buttons.nth(i);
      if(!(await btn.isVisible().catch(()=>false)))continue;
      const txt=compact(((await btn.getAttribute('aria-label').catch(()=>''))||'')+' '+((await btn.getAttribute('title').catch(()=>''))||'')+' '+((await btn.innerText().catch(()=>''))||''),240),n=norm(txt);
      let score=modelTokens.filter(t=>n.includes(t)).length*3;
      if(/model|omni|veo|flash/.test(n))score+=4;
      if(/aspect|duration|resolution|output|settings/.test(n))score-=2;
      if(score>scoreBest){scoreBest=score;modelButton=btn;currentModel=txt}
    }
    if(scoreBest<3)modelButton=null;
  }
  if(modelButton&&!modelMatches(currentModel)){
    await clickInteractive(modelButton);await sleep(350);
    const candidates=[];
    for(const role of ['menuitem','option','radio','button']){
      const loc=page.getByRole(role);
      for(let i=0;i<await loc.count().catch(()=>0);i++){
        const opt=loc.nth(i);
        if(!(await opt.isVisible().catch(()=>false)))continue;
        const txt=compact(((await opt.getAttribute('aria-label').catch(()=>''))||'')+' '+((await opt.innerText().catch(()=>''))||''),180),n=norm(txt);
        let score=modelTokens.filter(t=>n.includes(t)).length;
        if(/omni/i.test(MODEL_INTENT)&&/omni/i.test(txt))score+=3;
        if(/veo/i.test(MODEL_INTENT)&&/veo/i.test(txt))score+=3;
        if(/flash/i.test(MODEL_INTENT)&&/flash/i.test(txt))score+=2;
        if(score>0)candidates.push({o:opt,txt,score});
      }
    }
    candidates.sort((x,y)=>y.score-x.score);
    const chosen=candidates[0];
    if(!chosen)throw new Error('FLOW_MODEL_INTENT_NOT_FOUND:'+MODEL_INTENT);
    await clickInteractive(chosen.o);await sleep(450);currentModel=chosen.txt;
  }else if(!modelButton){
    const body=compact(await getBody(page),5000);
    const line=body.split(/\n|\|/).find(x=>modelMatches(x));
    if(!line)throw new Error('FLOW_VIDEO_MODEL_NOT_VERIFIED:'+MODEL_INTENT+':'+body.slice(0,700));
    currentModel=compact(line,200);
  }
  if(!modelMatches(currentModel))throw new Error('FLOW_VIDEO_MODEL_MISMATCH:'+MODEL_INTENT+':'+compact(currentModel,220));
  if(/omni/i.test(MODEL_INTENT)&&/flash/i.test(MODEL_INTENT)&&!(/omni/i.test(currentModel)&&/flash/i.test(currentModel))){
    const settingsText=compact(await getBody(page),5000);
    if(!(/omni/i.test(settingsText)&&/flash/i.test(settingsText)))throw new Error('FLOW_OMNI_FLASH_NOT_ACTIVE:'+compact(currentModel,220));
    currentModel='Omni Flash';
  }

  let resolutionApplied='default';
  const resRe=new RegExp(escapeRe(RESOLUTION_INTENT),'i');
  const resRadio=page.getByRole('radio',{name:resRe}).last();
  if(await resRadio.count().catch(()=>0)&&await resRadio.isVisible().catch(()=>false)){
    if((await resRadio.getAttribute('aria-checked').catch(()=>null))!=='true')await clickInteractive(resRadio);
    await sleep(250);resolutionApplied=RESOLUTION_INTENT;
  }else{
    const exact=page.getByText(resRe).last();
    if(await exact.count().catch(()=>0)&&await exact.isVisible().catch(()=>false)){
      await clickInteractive(exact);await sleep(250);resolutionApplied=RESOLUTION_INTENT;
    }else{
      publish('FLOW_SETTING_DEFAULT',{setting:'resolution',requested:RESOLUTION_INTENT,message:'Resolution control is not exposed by this Flow model; keeping the model default.'});
    }
  }

  let durationApplied='prompt-enforced';
  try{
    await clickRadio(page,new RegExp('^'+escapeRe(DURATION_LABEL)+'$','i'),DURATION_LABEL);
    durationApplied=DURATION_LABEL;
  }catch(e){
    if(!String(e?.message||e).startsWith('FLOW_SETTING_NOT_FOUND:'))throw e;
    publish('FLOW_SETTING_DEFAULT',{setting:'duration',requested:DURATION_LABEL,message:'Duration control is not exposed by this Flow model; exact duration remains enforced in the generation prompt.'});
  }

  let outputApplied='default';
  try{
    await clickRadio(page,new RegExp('^'+escapeRe(OUTPUT_LABEL)+'$','i'),OUTPUT_LABEL);
    outputApplied=OUTPUT_LABEL;
  }catch(e){
    if(!String(e?.message||e).startsWith('FLOW_SETTING_NOT_FOUND:'))throw e;
    publish('FLOW_SETTING_DEFAULT',{setting:'output_count',requested:OUTPUT_LABEL,message:'Output-count control is not exposed by this Flow model; keeping the model default.'});
  }

  if(CONFIG.characters.length){
    const ingredients=page.getByRole('radio',{name:/Ingredients/i}).last();
    if(await ingredients.count().catch(()=>0)&&await ingredients.isVisible().catch(()=>false)){
      if((await ingredients.getAttribute('aria-checked').catch(()=>null))!=='true')await clickInteractive(ingredients);
      await sleep(300);
    }
  }

  let label='';
  try{label=compact(await(await settingsButton(page)).innerText(),300)}catch{}
  const save=page.getByRole('button',{name:/^Save$/i}).last();
  if(await save.count().catch(()=>0)&&await save.isVisible().catch(()=>false)){await clickInteractive(save);await sleep(500)}
  const closeButtons=page.getByRole('button',{name:/^close$|close settings|cerrar/i});
  for(let i=(await closeButtons.count().catch(()=>0))-1;i>=0;i--){const x=closeButtons.nth(i);if(await x.isVisible().catch(()=>false)){await clickInteractive(x);await sleep(300);break}}
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(350);
  const applied={label:label||'settings-applied',mode:'Video',ratio:ASPECT_RATIO,model:currentModel,resolution:resolutionApplied,duration:durationApplied,count:outputApplied,ingredients:CONFIG.characters.length>0};
  publish('FLOW_SETTINGS_APPLIED',{message:JSON.stringify(applied)});
  return applied;
}
async function ingredientCount(page){
  return await page.locator('[aria-label="Ingredient"]').count().catch(()=>0);
}
async function clearComposer(page){
  await waitFlowReady(page,30000);
  const clear=page.getByRole('button',{name:/Clear prompt/i}).last();
  if(await clear.count().catch(()=>0)&&await clear.isVisible().catch(()=>false)){
    await clear.click().catch(()=>{});
    await sleep(500);
  }
  const editor=await promptEditor(page);
  await editor.fill('').catch(async()=>{await editor.click();await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');});
  await sleep(250);
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){
    if(await ingredientCount(page)===0)return true;
    const remove=page.locator('[aria-label="Ingredient"]');
    if(await remove.count().catch(()=>0)){
      await remove.last().click().catch(()=>{});
      await sleep(250);
    }else break;
  }
  if(await ingredientCount(page)!==0)throw new Error('FLOW_PROMPT_CLEAR_FAILED');
  return true;
}
async function composerAdd(page) {
  const named=page.getByRole('button',{name:/Add ingredients to the prompt box/i}).last();
  if(!(await named.count().catch(()=>0))||!(await named.isVisible().catch(()=>false)))throw new Error('ADD_INGREDIENTS_BUTTON_NOT_FOUND');
  await clickInteractive(named);await sleep(550);
}
async function visibleAddToPromptButton(page){
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){
    const buttons=page.locator('button');
    const count=await buttons.count();
    for(let i=count-1;i>=0;i--){
      const c=buttons.nth(i);
      if(!(await c.isVisible().catch(()=>false)))continue;
      const txt=compact(await c.innerText().catch(()=>''),120);
      if(/^Add to prompt$/i.test(txt))return c;
    }
    await sleep(200);
  }
  return null;
}
async function attachCharacter(page,name){
  const before=await ingredientCount(page);
  await composerAdd(page);

  const tab=page.getByRole('tab',{name:/Characters/i}).last();
  if(await tab.count().catch(()=>0)&&await tab.isVisible().catch(()=>false)){
    await clickInteractive(tab);
  }else{
    const chars=await visibleExact(page,'Characters');
    if(!chars)throw new Error('CHARACTERS_PICKER_NOT_FOUND');
    await clickInteractive(chars);
  }
  await sleep(650);

  let candidate=page.getByRole('option',{name,exact:true}).last();
  if(!(await candidate.count().catch(()=>0))||!(await candidate.isVisible().catch(()=>false))){
    const search=page.locator('input[aria-label="Search assets"]').last();
    if(!(await search.count().catch(()=>0))||!(await search.isVisible().catch(()=>false)))throw new Error(`CHARACTER_SEARCH_INPUT_NOT_FOUND:${name}`);
    await search.fill(name);await sleep(650);
    candidate=page.getByRole('option',{name,exact:true}).last();
  }
  if(!(await candidate.count().catch(()=>0))||!(await candidate.isVisible().catch(()=>false)))throw new Error(`CHARACTER_NOT_FOUND:${name}`);

  const selectedText=compact(await candidate.innerText().catch(()=>''),120);
  if(norm(selectedText)!==norm(name))throw new Error(`CHARACTER_EXACT_MATCH_FAILED:${name}:${selectedText}`);
  await clickInteractive(candidate);await sleep(700);

  const add=await visibleAddToPromptButton(page);
  if(add){await clickInteractive(add).catch(()=>{});await sleep(650);}
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(300);

  const deadline=Date.now()+4000;
  let after=await ingredientCount(page);
  while(after<before+1&&Date.now()<deadline){await sleep(200);after=await ingredientCount(page);}
  if(after!==before+1)throw new Error(`CHARACTER_INGREDIENT_COUNT_FAILED:${name}:${before}->${after}`);
  return{name,before,after,exact_option:true,confirmation_clicked:Boolean(add)};
}
async function fillPrompt(page,cp){
  await waitFlowReady(page,30000);
  const editor=await promptEditor(page);
  const payload=String(cp.prompt||'').replace(/\s+/g,' ').trim();
  if(payload.length<700)throw new Error('PROMPT_PAYLOAD_TOO_SHORT');
  const target=await classifyPromptTarget(page,editor);
  if(target!=='VIDEO_PROMPT_COMPOSER')throw new Error('PROMPT_TARGET_NOT_VIDEO_COMPOSER:'+target);
  await ensureCanonicalProjectTitle(page);
  await verifyProjectIdentity(page,'');

  const read=async()=>{
    const raw=await editor.evaluate(el=>String(
      (typeof el.value==='string'&&el.value) ||
      el.innerText ||
      el.textContent ||
      ''
    )).catch(()=> '');
    return String(raw||'').replace(/\s+/g,' ').trim();
  };

  await editor.fill(payload).catch(()=>{});
  await sleep(500);
  let value=await read();
  const first=payload.slice(0,140),last=payload.slice(-140);

  if(!value.includes(first)||!value.includes(last)){
    await editor.click();
    await page.keyboard.press('Control+A').catch(()=>{});
    await page.keyboard.press('Backspace').catch(()=>{});
    await page.keyboard.insertText(payload);
    await sleep(600);
    value=await read();
  }

  if(!value.includes(first)||!value.includes(last)){
    throw new Error(`PROMPT_INJECTION_FAILED:${value.length}:${payload.length}`);
  }
  const bytes=Buffer.byteLength(value,'utf8'),expected=Buffer.byteLength(payload,'utf8');
  if(Math.abs(bytes-expected)>8)throw new Error(`PROMPT_LENGTH_MISMATCH:${bytes}:${expected}`);
  const projectGuard=await verifyProjectIdentity(page,payload);
  return{payload_length:value.length,payload_bytes:bytes,target:'VIDEO_PROMPT_COMPOSER',projectGuard};
}
async function verifyPreparedState(page,row,cp){
  await waitFlowReady(page,30000);const settings=await configureFlow(page);let count=await ingredientCount(page),repairedCharacters=false;
  if(count!==cp.visual.length){if(count!==0)throw new Error('PREPARED_CHARACTER_PARTIAL_STATE:'+count+':'+cp.visual.length);for(const name of cp.visual)await attachCharacter(page,name);count=await ingredientCount(page);if(count!==cp.visual.length)throw new Error('PREPARED_CHARACTER_REPAIR_FAILED:'+count+':'+cp.visual.length);repairedCharacters=true}
  const payload=String(cp.prompt||'').replace(/\s+/g,' ').trim(),first=payload.slice(0,140),last=payload.slice(-140);let editor=await promptEditor(page),raw=await editor.evaluate(el=>String((typeof el.value==='string'&&el.value)||el.innerText||el.textContent||'')).catch(()=>''),value=String(raw||'').replace(/\s+/g,' ').trim(),repairedPrompt=false;
  if(!value||!value.includes(first)||!value.includes(last)||Math.abs(Buffer.byteLength(value,'utf8')-Buffer.byteLength(payload,'utf8'))>8){await fillPrompt(page,cp);editor=await promptEditor(page);raw=await editor.evaluate(el=>String((typeof el.value==='string'&&el.value)||el.innerText||el.textContent||'')).catch(()=>'');value=String(raw||'').replace(/\s+/g,' ').trim();repairedPrompt=true}
  if(!value.includes(first)||!value.includes(last))throw new Error('PREPARED_PROMPT_REPAIR_FAILED');if(String(row.providerRunId||''))throw new Error('PREPARED_JOB_ALREADY_STARTED');
  const body=(await getBody(page)).slice(0,12000);if(/generating|processing|rendering|creating video|generando|procesando/i.test(body))throw new Error('PREPARED_EXISTING_GENERATION_VISIBLE');
  const target=await classifyPromptTarget(page,editor);if(target!=='VIDEO_PROMPT_COMPOSER')throw new Error('PREPARED_PROMPT_TARGET_CHANGED:'+target);await ensureCanonicalProjectTitle(page);const projectGuard=await verifyProjectIdentity(page,payload);
  return{provider:PROVIDER,prompt_target:target,project_guard:projectGuard,prompt_verified:true,visual_assets_ready:true,characters:cp.visual,ingredient_count:count,settings,prepared_state_verified:true,repaired_characters:repairedCharacters,repaired_prompt:repairedPrompt,verified_at:now(),duration:DURATION_LABEL,ratio:ASPECT_RATIO,model:settings.model,resolution:RESOLUTION_INTENT,output_count:OUTPUT_COUNT};
}
async function preflight(page,row,cp){
  await clearComposer(page);const settings=await configureFlow(page),attachments=[];for(const name of cp.visual)attachments.push(await attachCharacter(page,name));const count=await ingredientCount(page);if(count!==cp.visual.length)throw new Error('CHARACTER_INGREDIENT_TOTAL_FAILED:'+count+':'+cp.visual.length);const promptGuard=await fillPrompt(page,cp);return{provider:PROVIDER,payload_retrieved:true,prompt_verified:true,first_fragment_seen:true,last_fragment_seen:true,visual_assets_ready:true,auth_required:false,duration:DURATION_LABEL,ratio:ASPECT_RATIO,model:settings.model,resolution:RESOLUTION_INTENT,output_count:OUTPUT_COUNT,characters:cp.visual,attachments,ingredient_count:count,prompt_target:promptGuard.target,project_guard:promptGuard.projectGuard,settings,at:now()};
}
async function currentVideos(page){return await page.locator('video').evaluateAll(vs=>vs.map((v,i)=>({i,src:v.currentSrc||v.src||'',duration:Number(v.duration||0),readyState:Number(v.readyState||0),w:Number(v.videoWidth||0),h:Number(v.videoHeight||0)}))).catch(()=>[]);}
async function findConsentControl(page,label){
  const target=norm(label);
  // Prefer the latest exact text occurrence in DOM order. Flow keeps old consent
  // cards mounted above the current one, so ".last()" is the safest target.
  const direct=page.getByText(new RegExp('^'+escapeRe(label)+'$','i'));
  for(let i=(await direct.count().catch(()=>0))-1;i>=0;i--){
    const el=direct.nth(i);
    if(!(await el.isVisible().catch(()=>false)))continue;
    await el.scrollIntoViewIfNeeded().catch(()=>{});
    const box=await el.boundingBox().catch(()=>null);
    if(box&&box.width>=20&&box.height>=12)return{el,txt:compact(await el.innerText().catch(()=>label),120),n:target,area:box.width*box.height,box,sel:'text-exact',score:120,order:i};
  }
  const selectors=['button','[role="button"]','[tabindex]','div','span'];
  const ranked=[];let order=0;
  for(const sel of selectors){
    const loc=page.locator(sel),count=Math.min(await loc.count().catch(()=>0),700);
    for(let i=0;i<count;i++,order++){
      const el=loc.nth(i);
      if(!(await el.isVisible().catch(()=>false)))continue;
      const txt=compact((await el.innerText().catch(()=>''))||'',120),n=norm(txt);
      if(!n)continue;
      const exact=n===target;
      const suffix=n.endsWith(' '+target);
      if(!exact&&!suffix)continue;
      if(target==='aprobar'&&/siempre/.test(n))continue;
      if(target==='approve'&&/always/.test(n))continue;
      await el.scrollIntoViewIfNeeded().catch(()=>{});
      const box=await el.boundingBox().catch(()=>null);if(!box||box.width<20||box.height<12)continue;
      const area=box.width*box.height;
      ranked.push({el,txt,n,area,box,sel,order,score:(exact?100:80)-Math.min(40,txt.length)});
    }
  }
  ranked.sort((a,b)=>b.order-a.order||b.score-a.score||a.area-b.area);
  return ranked[0]||null;
}
async function permissionSnapshot(page){
  const loc=page.locator('flow-permission-message');
  const items=[];
  for(let i=0;i<Math.min(await loc.count().catch(()=>0),80);i++){
    const el=loc.nth(i);
    if(!(await el.isVisible().catch(()=>false)))continue;
    const box=await el.boundingBox().catch(()=>null);
    if(!box)continue;
    const text=compact(await el.innerText().catch(()=>''),700);
    items.push({i,y:box.y,text,norm:norm(text)});
  }
  return{count:items.length,maxY:items.length?Math.max(...items.map(x=>x.y)):-1,items};
}
async function newPermissionMessage(page,before){
  const loc=page.locator('flow-permission-message');
  const candidates=[];
  for(let i=0;i<Math.min(await loc.count().catch(()=>0),80);i++){
    const el=loc.nth(i);
    if(!(await el.isVisible().catch(()=>false)))continue;
    const box=await el.boundingBox().catch(()=>null);if(!box)continue;
    const text=compact(await el.innerText().catch(()=>''),900),n=norm(text);
    if(!/approve|aprobar|15\s*(points|puntos|credits|creditos)|cuesta|cost/.test(n))continue;
    const isNew=i>=Number(before?.count||0)||box.y>Number(before?.maxY??-1)+8;
    if(isNew)candidates.push({el,i,box,text,n});
  }
  candidates.sort((a,b)=>b.box.y-a.box.y||b.i-a.i);
  if(candidates[0])return candidates[0];

  // Current Flow variants sometimes render the point-cost confirmation outside
  // <flow-permission-message>. Detect only an enabled confirmation control whose
  // nearby context explicitly mentions both generation/video and the point cost.
  const buttons=page.locator('button,[role="button"],[role="option"],[tabindex="0"]');
  const generic=[];
  for(let i=0;i<Math.min(await buttons.count().catch(()=>0),240);i++){
    const b=buttons.nth(i);
    if(!(await b.isVisible().catch(()=>false))||!(await b.isEnabled().catch(()=>false)))continue;
    const box=await b.boundingBox().catch(()=>null);if(!box)continue;
    const label=compact(
      ((await b.innerText().catch(()=>''))||'')+' '+
      ((await b.textContent().catch(()=>''))||'')+' '+
      ((await b.getAttribute('aria-label').catch(()=>''))||''),220
    );
    const bn=norm(label);
    if(!/^(si|sí|yes|generar|generate|confirmar|confirm|continuar|continue|aprobar|approve)(\b|\s|,|\.)/.test(bn)&&
       !/(si|sí|yes).*(generar|generate)|(generar|generate).*(video|15|puntos|points|creditos|credits)/.test(bn))continue;
    let context='';
    try{
      context=await b.evaluate(el=>{
        const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
        let p=el;
        for(let depth=0;depth<7&&p;depth++,p=p.parentElement){
          const t=clean(p.innerText||p.textContent||'');
          if(t.length>=20&&t.length<=1800)return t;
        }
        return clean(document.body?.innerText||'').slice(-1800);
      });
    }catch{}
    const cn=norm(context);
    if(!/(generar|generate|generation|video)/.test(cn))continue;
    if(!/(15\s*(puntos|points|creditos|credits)|cuesta|cost|usar.*puntos|use.*points|consumir.*puntos|consume.*points)/.test(cn))continue;
    let score=0;
    if(/generar|generate/.test(bn))score+=12;
    if(/^(si|sí|yes)\b/.test(bn))score+=10;
    if(/confirm|aprobar|approve/.test(bn))score+=8;
    score+=Math.min(5,box.y/180);
    generic.push({el:b,action:b,i,box,text:context,n:cn,label,score,generic:true});
  }
  generic.sort((a,b)=>b.score-a.score||b.box.y-a.box.y);
  return generic[0]||null;
}

function flowCreditFailure(text){
  const n=norm(text);
  return /not enough (?:points|credits)|insufficient (?:points|credits)|you need .* (?:points|credits)|no tienes suficientes (?:puntos|creditos)|puntos insuficientes|creditos insuficientes|sin suficientes (?:puntos|creditos)/i.test(n);
}
async function visibleGenerationBusyCount(page){
  const busy=page.locator('text=/Generating|Processing|Rendering|Creating video|Generando|Procesando|Starting generation|Initiating|Creando video|Preparando video/i');
  let n=0;
  for(let i=0;i<Math.min(await busy.count().catch(()=>0),80);i++)if(await busy.nth(i).isVisible().catch(()=>false))n++;
  const progress=page.locator('text=/^(?:[1-9]|[1-9][0-9])%$/');
  for(let i=0;i<Math.min(await progress.count().catch(()=>0),40);i++)if(await progress.nth(i).isVisible().catch(()=>false))n++;
  return n;
}

async function generationTransitionVisible(page,baselineInventory,baselineVideos,baselineBusy=0){
  const inv=await captureFlowInventory(page);
  const vids=await currentVideos(page);
  const baseSrc=new Set((baselineVideos||[]).map(v=>v.src).filter(Boolean));
  const freshVideo=vids.some(v=>v.src&&!baseSrc.has(v.src)&&Number(v.duration||0)>0);
  const freshInventory=inventoryHasNew(inv,baselineInventory);
  const send=page.getByRole('button',{name:/Start generation|Iniciar generación/i}).last();
  const sendVisible=await send.isVisible().catch(()=>false);
  const sendDisabled=await send.isDisabled().catch(()=>false);
  const visibleBusy=await visibleGenerationBusyCount(page);
  const busyIncrease=visibleBusy>Number(baselineBusy||0);
  const controlTransition=(!sendVisible||sendDisabled)&&busyIncrease;
  return{started:Boolean(freshVideo||busyIncrease),freshVideo,freshInventory,controlTransition,visibleBusy,sendVisible,sendDisabled,inventory:inv,videos:vids};
}

async function approveFlowPointConsent(page,permission,baselineInventory,baselineVideos,baselineBusy=0){
  if(!permission)return{approved:false,mode:null,label:null};

  if(permission.action){
    const label=compact(permission.label||await permission.action.innerText().catch(()=>''),160);
    await trustedClick(permission.action);
    await sleep(500);
    publish('POINT_CONSENT_CONFIRMED',{message:'Generic Flow point-cost confirmation accepted: '+label,context:compact(permission.text,500)});
    return{approved:true,mode:'confirm-generate',label};
  }

  const labels=[
    ['Aprobar siempre','approve-always'],['Always approve','approve-always'],['Approve always','approve-always'],
    ['Sí, generar','confirm-generate'],['Si, generar','confirm-generate'],['Yes, generate','confirm-generate'],
    ['Generar video','confirm-generate'],['Generate video','confirm-generate'],
    ['Generar','confirm-generate'],['Generate','confirm-generate'],
    ['Confirmar','confirm-generate'],['Confirm','confirm-generate'],
    ['Sí','confirm-generate'],['Si','confirm-generate'],['Yes','confirm-generate'],
    ['Aprobar','approve-once'],['Approve','approve-once']
  ];
  for(const [label,mode] of labels){
    const exact=permission.el.getByText(new RegExp('^'+escapeRe(label)+'$','i'));
    for(let i=(await exact.count().catch(()=>0))-1;i>=0;i--){
      const hit=exact.nth(i);
      if(!(await hit.isVisible().catch(()=>false)))continue;
      await hit.scrollIntoViewIfNeeded().catch(()=>{});
      await trustedClick(hit);
      const deadline=Date.now()+8000;
      while(Date.now()<deadline){
        await sleep(250);
        const stillVisible=await hit.isVisible().catch(()=>false);
        const transition=await generationTransitionVisible(page,baselineInventory,baselineVideos,baselineBusy);
        if(!stillVisible||transition.started){
          publish('POINT_CONSENT_CONFIRMED',{message:label+' accepted; controlGone='+(!stillVisible)+' transition='+JSON.stringify({freshVideo:transition.freshVideo,busy:transition.visibleBusy,sendVisible:transition.sendVisible,sendDisabled:transition.sendDisabled})});
          return{approved:true,mode,label};
        }
      }
      publish('POINT_CONSENT_NOT_ACCEPTED',{message:label+' remained actionable and no generation transition followed.'});
      throw new Error('FLOW_CONSENT_CLICK_NOT_ACCEPTED:'+label);
    }
  }
  throw new Error('FLOW_PERMISSION_MESSAGE_WITHOUT_APPROVAL_CONTROL:'+compact(permission.text,300));
}

// runtime-contract marker: flow-generate-icon-button / arrow_forward
async function clickSubmitExactlyOnce(page,baselineInventory,baselineVideos,baselineBusy=0){
  const permissionBefore=await permissionSnapshot(page);

  const promptTop=page.locator('flow-project-page flow-prompt-box div.prompt-top-row').last();
  if(await promptTop.count().catch(()=>0)&&await promptTop.isVisible().catch(()=>false)){
    await promptTop.click({position:{x:Math.max(5,Math.min(40,(await promptTop.boundingBox().catch(()=>({width:80}))).width-5)),y:8}}).catch(()=>{});
    await sleep(180);
  }

  let icon=page.locator('flow-project-page flow-prompt-box flow-generate-icon-button mat-icon').last();
  if(!(await icon.count().catch(()=>0))||!(await icon.isVisible().catch(()=>false))){
    icon=page.getByRole('img',{name:/Iniciar generación|Start generation/i}).last();
  }
  if(!(await icon.count().catch(()=>0))||!(await icon.isVisible().catch(()=>false)))throw new Error('FLOW_GENERATE_ARROW_NOT_FOUND');

  let target=icon.locator('xpath=ancestor::button[1]').first();
  if(!(await target.count().catch(()=>0))||!(await target.isVisible().catch(()=>false))){
    target=icon.locator('xpath=ancestor::*[@role="button"][1]').first();
  }
  if(!(await target.count().catch(()=>0))||!(await target.isVisible().catch(()=>false))){
    target=icon.locator('xpath=ancestor::flow-generate-icon-button[1]').first();
  }
  if(!(await target.count().catch(()=>0))||!(await target.isVisible().catch(()=>false)))target=icon;

  await trustedClick(target);
  publish('SUBMIT_ARROW_CLICKED',{message:'Interactive Flow generate control clicked exactly once.',control:compact(((await target.getAttribute('aria-label').catch(()=>''))||'')+' '+((await target.innerText().catch(()=>''))||''),180)});

  const consentDeadline=Date.now()+9000;
  while(Date.now()<consentDeadline){
    await sleep(250);
    const permission=await newPermissionMessage(page,permissionBefore);
    if(permission){
      const consent=await approveFlowPointConsent(page,permission,baselineInventory,baselineVideos,baselineBusy);
      return'composer-arrow-'+consent.mode;
    }
    const transition=await generationTransitionVisible(page,baselineInventory,baselineVideos,baselineBusy);
    if(transition.started)return'composer-arrow-direct-confirmed';
  }

  const buttons=[];
  const bs=page.locator('button,[role="button"]');
  for(let i=0;i<Math.min(await bs.count().catch(()=>0),100);i++){
    const b=bs.nth(i);if(!(await b.isVisible().catch(()=>false)))continue;
    const label=compact(((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+((await b.innerText().catch(()=>''))||''),180);
    if(label)buttons.push(label);
  }
  const postBody=await getBody(page);
  publish('POST_ARROW_NO_CONSENT',{message:'No generation transition or point-cost confirmation followed the generate click.',body:compact(postBody,1800),buttons:buttons.slice(-35)});
  if(/unusual activity|actividad inusual/i.test(postBody)&&/not been charged|no (?:se )?te (?:ha )?cobrado|no se (?:te )?cobr[oó]/i.test(postBody))throw new Error('FLOW_TRANSIENT_NO_CHARGE');
  return'composer-arrow-direct';
}

async function renderAuthGuard(page){
  const url=String(page.url()||'');
  if(/accounts\.google\.com|signin|ServiceLogin/i.test(url))throw new Error('FLOW_AUTH_REQUIRED_DURING_RENDER');
  const text=(await getBody(page)).slice(0,12000);
  if(/verify it'?s you|verifica que eres t[uú]|captcha|security check|verificaci[oó]n de seguridad/i.test(text))throw new Error('FLOW_AUTH_CHALLENGE_DURING_RENDER');
  return true;
}
async function captureFlowInventory(page){
  try{
    return await page.evaluate(()=>{
      const tiles=[...document.querySelectorAll('flow-grid-tile-container')].filter(el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20;});
      const sigs=tiles.map(el=>String(el.getAttribute('aria-label')||el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,220)).filter(Boolean);
      const body=String(document.body?.innerText||'').replace(/\s+/g,' ').trim();
      const videoOptions=[...document.querySelectorAll('flow-a2ui-video-option')].filter(el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20;});
      const videoOptionNames=videoOptions.map(el=>{
        const img=el.querySelector('img,[role="img"]');
        return String(img?.getAttribute('aria-label')||img?.getAttribute('alt')||el.getAttribute('aria-label')||el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,1200);
      }).filter(Boolean);
      const videoTiles=tiles.filter(el=>!!el.querySelector('flow-video-tile'));
      const videoTileSigs=videoTiles.map(el=>String(el.getAttribute('aria-label')||el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,500)).filter(Boolean);
      return{
        tile_count:tiles.length,
        ordered_signatures:sigs.slice(0,120),
        signatures:[...new Set(sigs)].slice(0,120),
        video_tile_count:videoTiles.length,
        video_tile_signatures:videoTileSigs.slice(0,80),
        video_option_count:videoOptions.length,
        video_option_names:videoOptionNames.slice(-40),
        busy:/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation|creating|preparing video|creando video|preparando video/i.test(body)
      };
    });
  }catch{return{tile_count:0,ordered_signatures:[],signatures:[],video_tile_count:0,video_tile_signatures:[],video_option_count:0,video_option_names:[],busy:false}}
}
function inventoryHasNew(current,baseline){
  if(!baseline)return false;
  if(Number(current?.tile_count||0)>Number(baseline?.tile_count||0))return true;
  if(Number(current?.video_option_count||0)>Number(baseline?.video_option_count||0))return true;
  const beforeNames=new Set(Array.isArray(baseline?.video_option_names)?baseline.video_option_names:[]);
  if((Array.isArray(current?.video_option_names)?current.video_option_names:[]).some(x=>!beforeNames.has(x)))return true;
  const before=new Set(Array.isArray(baseline?.signatures)?baseline.signatures:[]);
  return (Array.isArray(current?.signatures)?current.signatures:[]).some(x=>!before.has(x));
}
function episodeRecoveryTerms(row){
  const hook=norm(String(row?.hook||''));
  const story=norm(String(row?.story||''));
  const stop=new Set(['cinematic','video','through','while','under','above','below','across','into','from','with','this','that','their','there','where','soft','natural','light','morning','sunrise','dawn','landscape','water','clouds','mist']);
  const hookTokens=hook.split(' ').filter(x=>x.length>=5&&!stop.has(x));
  const storyTokens=story.split(' ').filter(x=>x.length>=6&&!stop.has(x));
  return{hook,anchors:[...new Set([...hookTokens.slice(0,3),...storyTokens.slice(0,5)])].slice(0,8)};
}
async function findEpisodeRecoveryAsset(page,row,allowHistory=true){
  const terms=episodeRecoveryTerms(row);
  const candidates=[],seen=new Set();
  const selectors=['flow-grid-tile-container','flow-a2ui-video-option','img','[role="img"]','[aria-label]'];
  for(const sel of selectors){
    const loc=page.locator(sel),count=Math.min(await loc.count().catch(()=>0),900);
    for(let i=0;i<count;i++){
      const el=loc.nth(i);
      if(!(await el.isVisible().catch(()=>false)))continue;
      const info=await el.evaluate(node=>{
        const r=node.getBoundingClientRect();
        const raw=[
          node.getAttribute?.('aria-label')||'',
          node.getAttribute?.('alt')||'',
          node.getAttribute?.('title')||'',
          node.innerText||'',
          node.textContent||''
        ].join(' ').replace(/\s+/g,' ').trim();
        return{raw:raw.slice(0,6000),area:r.width*r.height};
      }).catch(()=>null);
      if(!info?.raw||info.area<1200)continue;
      const n=norm(info.raw);
      const matched=terms.anchors.filter(t=>n.includes(t));
      const hookMatch=terms.hook.length>=8&&n.includes(terms.hook);
      if(!hookMatch&&matched.length<Math.min(2,Math.max(1,terms.anchors.length)))continue;
      const key=info.raw.slice(0,700);if(seen.has(key))continue;seen.add(key);
      candidates.push({el,label:compact(info.raw,900),matched,score:(hookMatch?1000:0)+matched.length*100+Math.min(info.area/10000,50)});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  for(const hit of candidates.slice(0,20)){
    const interactive=hit.el.locator('xpath=ancestor-or-self::button | ancestor-or-self::*[@role="button"] | ancestor-or-self::flow-grid-tile-container').last();
    const target=await interactive.count().catch(()=>0)?interactive:hit.el;
    await target.scrollIntoViewIfNeeded().catch(()=>{});
    await target.click({force:true,timeout:5000}).catch(()=>{});
    await sleep(1000);
    const d=await visibleDownloadButton(page);
    if(d)return{found:true,label:hit.label,matched:hit.matched,source:'episode-prompt-correlation'};
    await page.keyboard.press('Escape').catch(()=>{});await sleep(250);
  }
  if(allowHistory){
    const history=page.getByRole('button',{name:/Open session history|Session history|Historial de sesiones/i}).last();
    if(await history.count().catch(()=>0)&&await history.isVisible().catch(()=>false)){
      await history.click().catch(()=>{});await sleep(900);
      const retry=await findEpisodeRecoveryAsset(page,row,false);
      if(retry?.found)return{...retry,source:'session-history/'+retry.source};
      await page.keyboard.press('Escape').catch(()=>{});
    }
  }
  const samples=[];
  for(const sel of ['flow-grid-tile-container','flow-a2ui-video-option','img','[role="img"]']){
    const loc=page.locator(sel),count=Math.min(await loc.count().catch(()=>0),40);
    for(let i=0;i<count;i++){
      const el=loc.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
      const raw=compact(((await el.getAttribute('aria-label').catch(()=>''))||'')+' '+((await el.getAttribute('alt').catch(()=>''))||'')+' '+((await el.getAttribute('title').catch(()=>''))||'')+' '+((await el.innerText().catch(()=>''))||''),500);
      if(raw&&!samples.includes(raw))samples.push(raw);
      if(samples.length>=20)break;
    }
    if(samples.length>=20)break;
  }
  return{found:false,terms,samples};
}
async function recoverReviewerRetryAsset(page,row,lc,db){
  const found=await findEpisodeRecoveryAsset(page,row,true);
  if(!found?.found){
    publish('REVIEW_RETRY_RECOVERY_DIAGNOSTIC',{episode:'E'+row.episode,job_id:row.id,terms:found?.terms||null,samples:found?.samples||[]});
    return false;
  }
  const localPath=path.join(VIDEO_DIR,`${row.id}.mp4`);
  try{fs.unlinkSync(localPath)}catch{}
  const dl=await downloadResult(page,{uiReady:true,signal:'review-redo-prompt-correlation'},localPath);
  const valid=validateMp4(localPath),recoveredAt=now();
  const flowResult={
    provider:PROVIDER,generation_id:lc?.generation_id||row.providerRunId||'',
    generation_started_at:lc?.generation_started_at||lc?.submit_boundary_at||'',
    reviewer_retry_recovery:true,matched_label:found.label,matched_terms:found.matched,
    duration:valid.duration,width:valid.width,height:valid.height,size:valid.size,codec:valid.codec,
    validated_ftyp:true,download_quality:dl.method||CONFIG.generation.download_quality||'downloaded asset',
    retrieved_at:recoveredAt
  };
  persistReviewMetadata(db,row,flowResult);
  await saveReviewAsset(db,row,localPath,flowResult,recoveredAt);
  const runId=String(lc?.generation_id||row.providerRunId||'');
  if(runId)try{db.prepare("UPDATE factory_generations SET status='review',updatedAt=?,error=NULL WHERE itemId=? AND runId=?").run(recoveredAt,row.id,runId)}catch{}
  setLifecycle(db,row,'REVIEW_READY',{...lc,generation_id:runId,reviewer_retry:true,recovered_by_prompt_correlation:true,matched_label:found.label,size:valid.size,duration:valid.duration,width:valid.width,height:valid.height,retrieved_at:recoveredAt,automatic_submit_forbidden:true});
  publish('REVIEW_RETRY_RECOVERED',{episode:'E'+row.episode,job_id:row.id,generation_id:runId,title:String(row.title||''),matched:found.matched,size:valid.size});
  publish('REVIEW_READY',{episode:`T${row.season}E${row.episode}`,job_id:row.id,generation_id:runId,size:valid.size,duration:valid.duration,resolution:`${valid.width}x${valid.height}`,factory_url:`/factory/video/${row.id}`});
  return true;
}

async function reconcileAmbiguousGeneric(page,row,lc,db){
  const baselineInv=lc?.baseline_inventory||null;
  const boundary=Date.parse(String(lc?.submit_boundary_at||''));
  const age=Number.isFinite(boundary)?Date.now()-boundary:0;
  const currentInv=await captureFlowInventory(page);
  const body=(await getBody(page)).slice(0,14000);
  if(/unusual activity|actividad inusual/i.test(body)&&/not been charged|no (?:se )?te (?:ha )?cobrado|no se (?:te )?cobr[oó]/i.test(body)){
    const run=String(lc?.generation_id||row.providerRunId||'');
    if(run)try{db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Google Flow transient unusual-activity rejection; explicitly not charged.',updatedAt=? WHERE itemId=? AND runId=?").run(now(),row.id,run)}catch{}
    const retryAt=Date.now()+5*60*1000;
    db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error='FLOW_TRANSIENT_NO_CHARGE — automatic retry scheduled.',nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?").run(retryAt,now(),now(),row.id);
    setLifecycle(db,row,'TRANSIENT_NO_CHARGE_RETRY',{prior_generation_id:run,reconciled_at:now(),retry_at:new Date(retryAt).toISOString(),automatic_submit_forbidden:false});
    publish('TRANSIENT_NO_CHARGE_RETRY',{episode:'E'+row.episode,job_id:row.id,retry_at:new Date(retryAt).toISOString(),message:'Recovered an ambiguous no-charge rejection. It will retry automatically and is not counted as a generation.'});
    return{mode:'wait'};
  }
  const busy=currentInv.busy||/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation/i.test(body);
  const fresh=inventoryHasNew(currentInv,baselineInv);
  if(fresh||busy){
    const startedAt=String(lc?.generation_started_at||now());
    const next=setLifecycle(db,row,'GENERATION_STARTED',{...lc,generation_started_at:startedAt,evidence:`ambiguous-reconciled:fresh=${fresh};busy=${busy};tiles=${baselineInv?.tile_count||0}->${currentInv.tile_count}`,reconciled_at:now(),automatic_submit_forbidden:true});
    db.prepare("UPDATE factory_items SET status='generating',error=NULL,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
    const runId=String(next.generation_id||row.providerRunId||'');
    if(runId){
      const exists=Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE itemId=? AND runId=?").get(row.id,runId)?.n||0);
      if(!exists)try{db.prepare("INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)").run(randomUUID(),row.id,artDay(new Date(startedAt)),sha(String(row.promptHash||'')+':'+runId),CREDITS_PER_GENERATION,'running',runId,startedAt,now(),'automatic')}catch{}
    }
    publish('AMBIGUOUS_RECONCILED_GENERATION',{episode:`T${row.season}E${row.episode}`,job_id:row.id,evidence:next.evidence});
    return{mode:'retrieve',lifecycle:next};
  }
  if(baselineInv&&age>=5*60*1000){
    const before=Array.isArray(baselineInv.signatures)?baselineInv.signatures:[];
    const after=Array.isArray(currentInv.signatures)?currentInv.signatures:[];
    const sameCount=Number(currentInv.tile_count||0)===Number(baselineInv.tile_count||0);
    const sameSigs=before.length===after.length&&before.every(x=>after.includes(x));
    if(sameCount&&sameSigs&&!busy){
      if(reviewerRetryTokenConsumed(row)){
        const recovered=await recoverReviewerRetryAsset(page,row,lc,db).catch(e=>{
          publish('REVIEW_RETRY_RECOVERY_WARNING',{episode:'E'+row.episode,job_id:row.id,message:compact(e?.message||e,500)});
          return false;
        });
        if(recovered)return{mode:'done'};
        const reauthCount=Number(lc?.retry_reauthorization_count||0);
        if(age>=8*60*1000&&reauthCount<1){
          db.prepare("UPDATE factory_items SET status='regen_wait',providerRunId=NULL,reviewRetrySubmittedToken=NULL,error='Verified no retained REDO render after submit; one clean retry re-authorized.',nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?")
            .run(now(),now(),row.id);
          setLifecycle(db,row,'REDO_RETRY_REAUTHORIZED',{...lc,reconciled_at:now(),reviewer_retry:true,retry_token:String(row.reviewRetryToken||''),retry_reauthorization_count:reauthCount+1,prior_submit_unretained:true,automatic_submit_forbidden:false});
          publish('REVIEW_RETRY_REAUTHORIZED',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'No Flow render exists after the prior REDO submit; exactly one clean retry has been re-authorized.'});
          return{mode:'wait'};
        }
        const retryAt=Date.now()+45000;
        db.prepare("UPDATE factory_items SET status='generating',error=?,nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?").run(
          'REDO submitted; prompt-correlated recovery is still searching Flow. Generate remains locked to prevent duplicates.',
          retryAt,now(),now(),row.id
        );
        setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{...lc,reconciled_at:now(),automatic_submit_forbidden:true,reviewer_retry:true,retry_token:String(row.reviewRetryToken||''),retry_at:new Date(retryAt).toISOString(),recovery_mode:'prompt-correlated',retry_reauthorization_count:reauthCount});
        publish('REVIEW_RETRY_RECOVERY_PENDING',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'REDO result not correlated yet; recovery continues automatically without a duplicate Generate.'});
        return{mode:'wait'};
      }
      const retryAt=Date.now()+60000;
      db.prepare("UPDATE factory_items SET status='generating',error=?,nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?").run('SUBMIT_AMBIGUOUS — inventory unchanged is not proof of no generation; Generate remains locked.',retryAt,now(),now(),row.id);
      setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{...lc,reconciled_at:now(),evidence:`Inventory unchanged after ${Math.round(age/1000)}s; this is insufficient to prove no generation.`,retry_at:new Date(retryAt).toISOString(),automatic_submit_forbidden:true,last_inventory:currentInv});
      publish('AMBIGUOUS_STILL_LOCKED',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'No unique result yet. Generate stays locked; reconciliation will continue.'});
      return{mode:'wait'};
    }
  }
  const retryAt=Date.now()+60000;
  db.prepare("UPDATE factory_items SET status='generating',error=?,nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?").run('SUBMIT_AMBIGUOUS — reconciliation pending; no automatic resubmit',retryAt,now(),now(),row.id);
  setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{...lc,last_error:'Reconciliation pending; Generate remains forbidden.',retry_at:new Date(retryAt).toISOString(),last_inventory:currentInv});
  publish('SUBMIT_AMBIGUOUS',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'Read-only Flow reconciliation pending. No Generate will be clicked.'});
  return{mode:'wait'};
}
async function waitGenerationStarted(page,baseline,baselineInventory,baselineBusy=0,timeout=90000){
  const baseSrc=new Set((baseline||[]).map(v=>v.src).filter(Boolean)),startedAt=Date.now(),deadline=startedAt+timeout;
  const baseVideoTiles=Number(baselineInventory?.video_tile_count||0);
  let lastEvidence='',sawProvisionalTile=false,provisionalSince=0,vanishedSince=0,lastTileProbeAt=0;
  while(Date.now()<deadline){
    await renderAuthGuard(page);
    const bodyText=await getBody(page).catch(()=>'');
    if(flowCreditFailure(bodyText))throw new Error('FLOW_INSUFFICIENT_CREDITS');
    if(/unusual activity|actividad inusual/i.test(bodyText)&&/not been charged|no (?:se )?te (?:ha )?cobrado|no se (?:te )?cobr[oó]/i.test(bodyText))throw new Error('FLOW_TRANSIENT_NO_CHARGE');
    if(/failed to generate|generation failed|couldn't generate|no se pudo generar/i.test(bodyText))throw new Error('FLOW_GENERATION_FAILED');
    const vids=await currentVideos(page);
    const freshVideo=vids.some(v=>v.src&&!baseSrc.has(v.src)&&Number(v.duration||0)>0);
    const inv=await captureFlowInventory(page);
    const busyCount=await visibleGenerationBusyCount(page).catch(()=>0);
    const bodyBusy=/generating|processing|rendering|creating video|generando|procesando|upscaling|preparing video|preparando video/i.test(bodyText);
    const hardBusy=Number(busyCount||0)>Number(baselineBusy||0)||bodyBusy;
    const tileCount=Number(inv.video_tile_count||0),newVideoTile=tileCount>baseVideoTiles;
    const elapsed=Date.now()-startedAt;
    lastEvidence=`freshPlayableVideo=${freshVideo}; busy=${hardBusy}; busyCount=${baselineBusy}->${busyCount}; videoTiles=${baseVideoTiles}->${tileCount}; allTiles=${baselineInventory?.tile_count||0}->${inv.tile_count||0}; elapsedMs=${elapsed}`;

    // Hard evidence only. A transient Flow grid node is NOT proof that a
    // generation exists: Flow virtualizes/replaces tile DOM while updating.
    if(freshVideo||hardBusy){
      return{started:true,evidence:lastEvidence,videos:vids,inventory:inv,render_complete:freshVideo};
    }

    if(newVideoTile){
      sawProvisionalTile=true;
      vanishedSince=0;
      if(!provisionalSince)provisionalSince=Date.now();
      // A tile becomes hard render evidence only when its editor exposes an
      // enabled Download control. Visible-but-disabled controls do not count.
      if(Date.now()-lastTileProbeAt>5000){
        lastTileProbeAt=Date.now();
        const probe=await openLatestExpectedVideoTile(page,baselineInventory).catch(()=>null);
        if(probe?.ready){
          return{started:true,evidence:lastEvidence+'; enabledDownload=true',videos:vids,inventory:inv,render_complete:true};
        }
      }
      if(Date.now()-provisionalSince>8*60*1000){
        return{started:false,evidence:lastEvidence+'; provisional tile never became downloadable; submit remains locked for recovery-only reconciliation'};
      }
    }else if(sawProvisionalTile){
      if(!vanishedSince)vanishedSince=Date.now();
      // The supposed new tile appeared, then vanished, while Flow reports no
      // busy state and no playable media. Treat that as no retained generation
      // instead of blocking the head-of-line episode for 20+ minutes.
      if(Date.now()-vanishedSince>45000){
        return{started:false,evidence:lastEvidence+'; provisional tile vanished; this is ambiguous, not proof that Generate did nothing'};
      }
    }
    await sleep(1200);
  }
  return{started:false,evidence:'No hard Flow generation evidence appeared after the submit boundary. '+lastEvidence};
}
function firstFreshRendered(vids,baseline){
  const baseSrc=new Set((baseline||[]).map(v=>v.src).filter(Boolean));
  const fresh=(vids||[]).filter(v=>v.readyState>=2&&v.duration>0&&v.src&&!baseSrc.has(v.src));
  return fresh.length===1?fresh[0]:null;
}
async function visibleDownloadButton(page){
  const usable=async c=>{
    if(!(await c.isVisible().catch(()=>false)))return false;
    if(await c.isDisabled().catch(()=>false))return false;
    if(String(await c.getAttribute('aria-disabled').catch(()=>'')||'').toLowerCase()==='true')return false;
    if(await c.getAttribute('disabled').catch(()=>null)!==null)return false;
    return true;
  };
  const named=page.getByRole('button',{name:/Download|Export|Descargar/i});
  for(let i=(await named.count())-1;i>=0;i--){
    const c=named.nth(i);
    if(await usable(c))return c;
  }
  const buttons=page.locator('button,[role="button"]');
  for(let i=(await buttons.count())-1;i>=0;i--){
    const c=buttons.nth(i);
    if(!(await usable(c)))continue;
    const txt=compact((await c.innerText().catch(()=>''))+' '+(await c.getAttribute('aria-label').catch(()=>''))+' '+(await c.getAttribute('title').catch(()=>'')),180);
    if(/download|export|descargar|file_download/i.test(txt))return c;
  }
  return null;
}
async function openLatestExpectedVideoTile(page,baselineInv){
  const expected=Math.max(1,Number(baselineInv?.video_tile_count||0)+1);
  const tiles=page.locator('flow-grid-tile-container').filter({has:page.locator('flow-video-tile')});
  const visible=[];
  const count=Math.min(await tiles.count().catch(()=>0),120);
  for(let i=0;i<count;i++){
    const tile=tiles.nth(i);
    if(await tile.isVisible().catch(()=>false))visible.push(tile);
  }
  // Flow virtualizes the project grid after reload. The newest tile remains at
  // the front while older tiles may be unmounted, so visible.length can be far
  // below the historical expected count even though the result is present.
  if(!visible.length)return{ready:false,opened:false,signal:`no-visible-video-tiles;expected:${expected}`};
  const target=visible[0];
  await target.scrollIntoViewIfNeeded().catch(()=>{});
  await target.hover().catch(()=>{});
  const footer=target.locator('flow-tile-hover-footer').first();
  if(await footer.count().catch(()=>0)&&await footer.isVisible().catch(()=>false)){
    await footer.click({force:true,timeout:5000}).catch(()=>{});
  }else{
    await target.click({force:true,timeout:5000}).catch(()=>{});
  }
  await sleep(1200);
  const d=await visibleDownloadButton(page);
  if(d)return{ready:true,opened:true,signal:`latest-visible-video-tile:${visible.length};expected:${expected}`,index:0};
  await page.keyboard.press('Escape').catch(()=>{});
  return{ready:false,opened:false,signal:`latest-video-tile-no-download:${visible.length};expected:${expected}`};
}

async function openUniqueFreshInventoryResult(page,baselineInv){
  const tiles=page.locator('flow-grid-tile-container'),count=Math.min(await tiles.count().catch(()=>0),120),baselineCount=Number(baselineInv?.tile_count||0);
  // Do not require count-baseline===1 after a reload. Flow can virtualize the grid
  // so one new tile can replace one old mounted tile and total DOM count stays equal.
  // Signature multiset correlation is the durable criterion.
  const baselineList=Array.isArray(baselineInv?.ordered_signatures)&&baselineInv.ordered_signatures.length?baselineInv.ordered_signatures:(Array.isArray(baselineInv?.signatures)?baselineInv.signatures:[]);
  const remaining=new Map();for(const sig of baselineList)remaining.set(sig,(remaining.get(sig)||0)+1);
  const fresh=[];
  for(let i=0;i<count;i++){
    const el=tiles.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    const aria=String(await el.getAttribute('aria-label').catch(()=>'')||'').replace(/\s+/g,' ').trim();
    const inner=String(await el.innerText().catch(()=>'')||'').replace(/\s+/g,' ').trim();
    const content=String(await el.textContent().catch(()=>'')||'').replace(/\s+/g,' ').trim();
    const sig=compact(aria||inner||content,220);if(!sig)continue;
    const left=remaining.get(sig)||0;if(left>0){remaining.set(sig,left-1);continue}
    fresh.push({el,sig,i});
  }
  if(fresh.length!==1)return{ready:false,opened:false,signal:`fresh-tile-occurrences:${fresh.length};dom-delta:${count-baselineCount}`};
  const target=fresh[0].el;
  await target.scrollIntoViewIfNeeded().catch(()=>{});
  await target.hover().catch(()=>{});
  const footer=target.locator('flow-tile-hover-footer').first();
  if(await footer.count().catch(()=>0)&&await footer.isVisible().catch(()=>false)){
    await footer.click({force:true,timeout:5000}).catch(()=>{});
  }else{
    await target.click({force:true,timeout:5000}).catch(()=>{});
  }
  await sleep(1000);
  const d=await visibleDownloadButton(page);
  if(d)return{ready:true,opened:true,signal:'unique-fresh-inventory-video-tile',signature:fresh[0].sig,index:fresh[0].i};
  await page.keyboard.press('Escape').catch(()=>{});
  return{ready:false,opened:false,signal:'unique-fresh-tile-no-download'};
}
async function openLatestGeneratedResult(page){
  let d=await visibleDownloadButton(page);
  if(d)return{ready:true,opened:false,signal:'download-visible'};
  const prompt=await promptEditor(page).catch(()=>null);
  const pb=prompt?await prompt.boundingBox().catch(()=>null):null;
  const selectors=['img','[role="img"]','canvas','video','[style*="background-image"]','[role="button"]','[tabindex="0"]'];
  const candidates=[];
  for(const sel of selectors){
    const loc=page.locator(sel),count=Math.min(await loc.count().catch(()=>0),80);
    for(let i=0;i<count;i++){
      const el=loc.nth(i);
      if(!(await el.isVisible().catch(()=>false)))continue;
      const b=await el.boundingBox().catch(()=>null);if(!b)continue;
      const area=b.width*b.height;
      if(area<18000||b.width<120||b.height<100)continue;
      if(pb && b.y>=pb.y-20)continue;
      if(b.x<120&&b.width<220)continue;
      const label=compact((await el.innerText().catch(()=>''))+' '+(await el.getAttribute('aria-label').catch(()=>''))+' '+(await el.getAttribute('title').catch(()=>''))+' '+(await el.getAttribute('alt').catch(()=>'')),220);
      if(/add ingredient|settings|start generation|send|prompt|character|clear prompt|search assets|upload/i.test(label))continue;
      candidates.push({el,area,y:b.y,x:b.x,w:b.width,h:b.height,sel,label});
    }
  }
  candidates.sort((a,b)=>b.area-a.area||b.y-a.y);
  for(const cand of candidates.slice(0,14)){
    await cand.el.click({position:{x:Math.max(5,Math.min(cand.w-5,cand.w/2)),y:Math.max(5,Math.min(cand.h-5,cand.h/2))}}).catch(()=>{});
    await sleep(700);
    d=await visibleDownloadButton(page);
    if(d)return{ready:true,opened:true,signal:'result-opened',candidate:{selector:cand.sel,area:Math.round(cand.area),x:Math.round(cand.x),y:Math.round(cand.y)}};
    await page.keyboard.press('Escape').catch(()=>{});
    await sleep(250);
  }
  const buttonLabels=[];
  const allButtons=page.locator('button,[role="button"]');
  for(let i=0;i<Math.min(await allButtons.count().catch(()=>0),80);i++){
    const el=allButtons.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    const txt=compact((await el.innerText().catch(()=>''))+' '+(await el.getAttribute('aria-label').catch(()=>''))+' '+(await el.getAttribute('title').catch(()=>'')),120);
    if(txt)buttonLabels.push(txt);
  }
  publish('RETRIEVAL_SCAN',{
    message:'No download control yet.',
    buttons:[...new Set(buttonLabels)].slice(-24),
    large_candidates:candidates.slice(0,8).map(c=>({selector:c.sel,label:compact(c.label,80),area:Math.round(c.area),x:Math.round(c.x),y:Math.round(c.y)})),
    frames:page.frames().map(f=>compact(f.url(),140)).filter(Boolean).slice(0,8)
  });
  return{ready:false,opened:false,signal:'no-result-control'};
}
async function clickAndCaptureDownload(page,option,localPath,timeout=60000){
  const dir='/tmp/publisher-flow-downloads';
  try{fs.rmSync(dir,{recursive:true,force:true})}catch{}
  fs.mkdirSync(dir,{recursive:true,mode:0o700});

  let cdp=null,downloadMeta=null;
  const responseCandidates=[];
  const responseHandler=async response=>{
    try{
      const url=String(response.url()||'');
      const h=await response.allHeaders().catch(()=>({}));
      const type=String(h['content-type']||h['Content-Type']||'');
      const disposition=String(h['content-disposition']||h['Content-Disposition']||'');
      if(/video\/|application\/octet-stream/i.test(type)||/attachment/i.test(disposition)||/videoplayback|googleusercontent|storage\.googleapis|download/i.test(url)){
        responseCandidates.push({url,type,disposition,status:response.status(),at:Date.now()});
      }
    }catch{}
  };
  page.on('response',responseHandler);

  try{
    cdp=await page.context().newCDPSession(page);
    await cdp.send('Network.enable').catch(()=>{});
    await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:dir,eventsEnabled:true}).catch(async()=>{
      await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:dir}).catch(()=>{});
    });
    cdp.on('Browser.downloadWillBegin',e=>{
      downloadMeta={guid:String(e?.guid||''),url:String(e?.url||''),filename:String(e?.suggestedFilename||''),at:Date.now()};
      publish('DOWNLOAD_WILL_BEGIN',{message:compact(JSON.stringify(downloadMeta),900)});
    });
    cdp.on('Browser.downloadProgress',e=>{
      if(String(e?.state||'')==='completed')downloadMeta={...(downloadMeta||{}),guid:String(e?.guid||downloadMeta?.guid||''),completed:true,receivedBytes:Number(e?.receivedBytes||0),at:Date.now()};
    });
  }catch{}

  const playwrightDownload=page.waitForEvent('download',{timeout}).catch(()=>null);
  let playwrightHandled=false;
  await trustedClick(option);

  const deadline=Date.now()+timeout;
  let seenPath='',seenSize=-1,stable=0;
  while(Date.now()<deadline){
    if(!playwrightHandled){
      const dl=await Promise.race([playwrightDownload,sleep(300).then(()=>null)]);
      if(dl){
        playwrightHandled=true;
        try{
          await dl.saveAs(localPath);
          page.off('response',responseHandler);
          try{await cdp?.detach()}catch{}
          publish('DOWNLOAD_PLAYWRIGHT_CAPTURED',{message:'Captured Flow download through Playwright saveAs.'});
          return true;
        }catch(e){
          publish('PLAYWRIGHT_SAVEAS_FAILED',{message:compact(e?.message||e,700)});
          // Browser.setDownloadBehavior moves the file out of Playwright's
          // transient artifact directory in attached Chrome sessions. Keep
          // polling the durable CDP download directory instead of aborting.
          try{
            const stream=await dl.createReadStream().catch(()=>null);
            if(stream){
              await new Promise((resolve,reject)=>{
                const out=fs.createWriteStream(localPath,{mode:0o600});
                stream.on('error',reject);out.on('error',reject);out.on('finish',resolve);stream.pipe(out);
              });
              const st=fs.statSync(localPath);
              if(st.size>100000){
                page.off('response',responseHandler);
                try{await cdp?.detach()}catch{}
                publish('DOWNLOAD_STREAM_CAPTURED',{message:'Recovered Flow download from Playwright stream ('+st.size+' bytes).'});
                return true;
              }
              try{fs.rmSync(localPath,{force:true})}catch{}
            }
          }catch(streamErr){
            publish('PLAYWRIGHT_STREAM_FAILED',{message:compact(streamErr?.message||streamErr,500)});
          }
        }
      }
    }

    let names=[];try{names=fs.readdirSync(dir)}catch{}
    const complete=names.filter(n=>!n.endsWith('.crdownload')&&!n.endsWith('.tmp')&&!n.startsWith('.'));
    for(const name of complete){
      const p=path.join(dir,name);
      let st=null;try{st=fs.statSync(p)}catch{}
      if(!st?.isFile()||st.size<100000)continue;
      if(seenPath===p&&seenSize===st.size)stable++;else{seenPath=p;seenSize=st.size;stable=0}
      if(stable>=2){
        fs.copyFileSync(p,localPath);
        page.off('response',responseHandler);
        try{await cdp?.detach()}catch{}
        publish('DOWNLOAD_FILE_CAPTURED',{message:'Captured browser download '+name+' ('+st.size+' bytes).'});
        return true;
      }
    }

    if(downloadMeta?.completed){
      const candidates=[downloadMeta.guid,downloadMeta.filename].filter(Boolean).map(n=>path.join(dir,n));
      for(const p of candidates){
        try{
          const st=fs.statSync(p);
          if(st.isFile()&&st.size>100000){
            fs.copyFileSync(p,localPath);
            page.off('response',responseHandler);
            try{await cdp?.detach()}catch{}
            publish('DOWNLOAD_FILE_CAPTURED',{message:'Captured completed CDP download '+path.basename(p)+' ('+st.size+' bytes).'});
            return true;
          }
        }catch{}
      }
    }
  }

  // Some Flow download actions return a signed media URL without emitting a
  // Playwright download event in an externally attached Chrome session.
  const urls=[
    downloadMeta?.url,
    ...responseCandidates.slice().sort((a,b)=>b.at-a.at).map(x=>x.url)
  ].filter(x=>/^https?:/i.test(String(x||'')));
  for(const url of [...new Set(urls)]){
    try{
      const r=await page.context().request.get(url,{timeout:90000});
      if(!r.ok())continue;
      const body=await r.body();
      if(body.length<100000)continue;
      fs.writeFileSync(localPath,body,{mode:0o600});
      const head=body.subarray(0,128);
      if(head.includes(Buffer.from('ftyp'))){
        page.off('response',responseHandler);
        try{await cdp?.detach()}catch{}
        publish('DOWNLOAD_URL_CAPTURED',{message:'Recovered Flow media from the signed download response ('+body.length+' bytes).'});
        return true;
      }
      try{fs.rmSync(localPath,{force:true})}catch{}
    }catch{}
  }

  publish('DOWNLOAD_CAPTURE_TIMEOUT',{message:compact(JSON.stringify({
    download:downloadMeta,
    responses:responseCandidates.slice(-12)
  }),5000)});
  page.off('response',responseHandler);
  try{await cdp?.detach()}catch{}
  return false;
}
async function openDownloadMenu(page){
  const trigger=await visibleDownloadButton(page);
  if(!trigger)return null;
  await trigger.click({force:true,timeout:5000});
  await sleep(500);
  return trigger;
}
async function immediateDownloadChoice(page,localPath,{preferWanted=true}={}){
  const wanted=CONFIG.generation.download_quality||'1080p Upscaled';
  if(!await openDownloadMenu(page))return{ok:false,reason:'no-download-control'};
  const opt=page.getByText(new RegExp(escapeRe(wanted),'i')).last();
  if(preferWanted&&await opt.count().catch(()=>0)&&await opt.isVisible().catch(()=>false)){
    const ok=await clickAndCaptureDownload(page,opt,localPath,20000);
    if(ok)return{ok:true,method:wanted};
    return{ok:false,reason:'preferred-quality-deferred',preferred:wanted};
  }
  const menuItems=page.locator('flow-menu-item');
  const visibleItems=[];
  for(let i=0;i<Math.min(await menuItems.count().catch(()=>0),20);i++){
    const it=menuItems.nth(i);
    if(!(await it.isVisible().catch(()=>false)))continue;
    const text=compact(await it.innerText().catch(()=>''),120);
    const aria=compact(await it.getAttribute('aria-label').catch(()=>''),120);
    const href=String(await it.evaluate(el=>{
      const a=el.matches?.('a[href]')?el:el.querySelector?.('a[href]');
      return a?.href||el.closest?.('a[href]')?.href||'';
    }).catch(()=>'' )||'');
    const label=compact(text+' '+aria,160);
    visibleItems.push({it,text,aria,label,href});
  }
  publish('DOWNLOAD_MENU_OPTIONS',{message:visibleItems.map(x=>(x.label||'(unlabeled)')+(x.href?' href='+compact(x.href,180):'')).join(' | ')});
  const fallback=
    visibleItems.find(x=>/720|original|standard|normal/i.test(x.label)&&!/1080|upscal/i.test(x.label))||
    visibleItems.find(x=>!/1080|upscal|gif/i.test(x.label))||
    visibleItems[2]||
    visibleItems[0];
  if(!fallback)return{ok:false,reason:'no-download-option'};
  let target=fallback.it;
  if(fallback.text){
    const textTarget=page.getByText(new RegExp(escapeRe(fallback.text),'i')).last();
    if(await textTarget.count().catch(()=>0)&&await textTarget.isVisible().catch(()=>false))target=textTarget;
  }
  if(/^https?:/i.test(fallback.href||'')){
    try{
      const direct=await page.context().request.get(fallback.href,{timeout:90000});
      if(direct.ok()){
        const body=await direct.body();
        if(body.length>100000&&body.subarray(0,128).includes(Buffer.from('ftyp'))){
          fs.writeFileSync(localPath,body,{mode:0o600});
          publish('DOWNLOAD_DIRECT_HREF',{message:'Recovered Flow media directly from the quality option href.'});
          return{ok:true,method:(fallback.text||fallback.label||'direct-download')+' (direct href)'};
        }
      }
    }catch{}
  }
  publish('DOWNLOAD_OPTION_CLICK',{message:'Clicking '+String(fallback.text||fallback.label||'fallback')+' with trusted pointer input.'});
  const ok=await clickAndCaptureDownload(page,target,localPath,60000);
  if(!ok)return{ok:false,reason:'fallback-download-timeout',label:fallback.label};
  return{ok:true,method:(fallback.label||'standard-download')+' (recovery fallback)'};
}
async function downloadResult(page,rendered,localPath){
  if(rendered?.i>=0){
    const v=page.locator('video').nth(rendered.i);
    if(await v.isVisible().catch(()=>false))await v.click({position:{x:10,y:10}}).catch(()=>{});
    let attempt=await immediateDownloadChoice(page,localPath,{preferWanted:true});
    if(attempt.ok)return{method:attempt.method};
    if(rendered.src&&/^https?:/i.test(rendered.src)){
      const r=await page.context().request.get(rendered.src,{timeout:90000});
      if(r.ok()){
        fs.writeFileSync(localPath,await r.body(),{mode:0o600});
        return{method:'direct-video-url'};
      }
    }
    if(attempt.reason==='preferred-quality-deferred'){
      publish('DOWNLOAD_1080_DEFERRED',{message:'1080p upscale did not emit a file yet; recovering the same render at an immediate quality.'});
      await page.keyboard.press('Escape').catch(()=>{});
      await sleep(900);
      attempt=await immediateDownloadChoice(page,localPath,{preferWanted:false});
      if(attempt.ok)return{method:attempt.method};
    }
    throw new Error('FRESH_VIDEO_DOWNLOAD_FAILED_NO_GENERIC_FALLBACK:'+String(attempt.reason||'unknown'));
  }
  if(!rendered?.uiReady)throw new Error('DOWNLOAD_WITHOUT_UNIQUE_FRESH_EVIDENCE');
  // Recovery from a project tile prioritizes the already-rendered native file.
  // Do not start a fresh 1080p upscale job while the serial queue is blocked.
  const attempt=await immediateDownloadChoice(page,localPath,{preferWanted:false});
  if(attempt.ok)return{method:attempt.method};
  throw new Error('UNIQUE_FRESH_TILE_DOWNLOAD_FAILED:'+String(attempt.reason||'unknown'));
}
function validateMp4(localPath){
  const st=fs.statSync(localPath);if(st.size<100000)throw new Error('MP4_TOO_SMALL:'+st.size);const head=fs.readFileSync(localPath).subarray(0,128);if(!head.includes(Buffer.from('ftyp')))throw new Error('MP4_FTYP_MISSING');
  const raw=execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',localPath],{encoding:'utf8',timeout:30000}),probe=JSON.parse(raw),stream=(probe.streams||[]).find(s=>s.codec_type==='video');if(!stream)throw new Error('MP4_VIDEO_STREAM_MISSING');
  const duration=Number(probe?.format?.duration||0),width=Number(stream.width||0),height=Number(stream.height||0),tol=Math.max(2.5,DURATION_SECONDS*.25);if(Math.abs(duration-DURATION_SECONDS)>tol)throw new Error('MP4_DURATION_UNEXPECTED:'+duration);
  const parts=ASPECT_RATIO.split(':').map(Number);if(width>0&&height>0&&parts.length===2&&parts.every(Number.isFinite)){const expected=parts[0]/parts[1],actual=width/height;if(Math.abs(actual-expected)>Math.max(.12,expected*.22))throw new Error('MP4_ASPECT_UNEXPECTED:'+width+'x'+height)}
  return{size:st.size,duration,width,height,codec:String(stream.codec_name||'')};
}

async function findGoldenRecoveryAsset(page,allowHistory=true){
  if(!GOLDEN_RECOVERY_TERMS.length)throw new Error('GOLDEN_RECOVERY_TERMS_MISSING');

  // Recorder "muestra 2" proves the non-chat recovery path:
  // project grid -> first/latest visible video tile -> hover footer -> editor.
  // This one-time Golden Run recovery is safe because the operator confirmed
  // the Patagonia render is the latest real generation in this project.
  const videoTiles=page.locator('flow-grid-tile-container').filter({has:page.locator('flow-video-tile')});
  const visibleVideoTiles=[];
  for(let i=0;i<Math.min(await videoTiles.count().catch(()=>0),120);i++){
    const tile=videoTiles.nth(i);
    if(await tile.isVisible().catch(()=>false))visibleVideoTiles.push(tile);
  }
  if(visibleVideoTiles.length){
    const tile=visibleVideoTiles[0];
    await tile.scrollIntoViewIfNeeded().catch(()=>{});
    await tile.hover().catch(()=>{});
    const footer=tile.locator('flow-tile-hover-footer').first();
    if(await footer.count().catch(()=>0)&&await footer.isVisible().catch(()=>false)){
      await footer.click({force:true,timeout:5000}).catch(()=>{});
    }else{
      await tile.click({force:true,timeout:5000}).catch(()=>{});
    }
    await sleep(1200);
    const d=await visibleDownloadButton(page);
    if(d)return{found:true,matched:['recorder-project-grid','latest-video-tile'],label:'first visible project video tile',source:'project-grid-latest-video'};
    await page.keyboard.press('Escape').catch(()=>{});await sleep(300);
  }

  // Exact Golden Run recorder path: flow-a2ui-video-option > ... > img with
  // accessible name equal to the generated prompt. Use Playwright's computed
  // accessible name rather than brittle Material IDs/XPath.
  const goldenImgs=page.getByRole('img',{name:/patagonia/i});
  for(let i=(await goldenImgs.count().catch(()=>0))-1;i>=0;i--){
    const img=goldenImgs.nth(i);if(!(await img.isVisible().catch(()=>false)))continue;
    const acc=compact(await img.getAttribute('aria-label').catch(()=>''),1600);
    const alt=compact(await img.getAttribute('alt').catch(()=>''),1600);
    const raw=norm((acc||'')+' '+(alt||''));
    if(!(raw.includes('glacial lake')||raw.includes('sunrise')||raw.includes('turquoise')))continue;
    await img.scrollIntoViewIfNeeded().catch(()=>{});
    await img.click({force:true,timeout:5000}).catch(()=>{});
    await sleep(1200);
    const d=await visibleDownloadButton(page);
    if(d)return{found:true,matched:['patagonia','recorder-accessible-name'],label:compact(acc||alt,700),source:'recorder-role-img'};
    await page.keyboard.press('Escape').catch(()=>{});await sleep(300);
  }
  const selectors=['flow-grid-tile-container','img','[role="img"]','[aria-label]','button','[role="button"]'];
  const candidates=[];
  const seen=new Set();
  for(const sel of selectors){
    const loc=page.locator(sel),count=Math.min(await loc.count().catch(()=>0),1200);
    for(let i=0;i<count;i++){
      const el=loc.nth(i);
      if(!(await el.isVisible().catch(()=>false)))continue;
      const info=await el.evaluate(node=>{
        const r=node.getBoundingClientRect();
        const raw=[
          node.getAttribute?.('aria-label')||'',
          node.getAttribute?.('alt')||'',
          node.getAttribute?.('title')||'',
          node.innerText||'',
          node.textContent||''
        ].join(' ').replace(/\s+/g,' ').trim();
        return{raw:raw.slice(0,5000),area:r.width*r.height,x:r.x,y:r.y,w:r.width,h:r.height,tag:node.tagName};
      }).catch(()=>null);
      if(!info||!info.raw||info.area<3000)continue;
      const n=norm(info.raw);
      const matched=GOLDEN_RECOVERY_TERMS.filter(t=>n.includes(t));
      if(matched.length<Math.min(3,GOLDEN_RECOVERY_TERMS.length))continue;
      const key=info.raw.slice(0,500);
      if(seen.has(key))continue;seen.add(key);
      candidates.push({el,matched,score:matched.length*100000+Math.min(info.area,500000),info});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  for(const cand of candidates.slice(0,24)){
    const target=cand.el;
    const interactive=target.locator('xpath=ancestor-or-self::button | ancestor-or-self::*[@role="button"] | ancestor-or-self::flow-grid-tile-container').last();
    const clickTarget=await interactive.count().catch(()=>0)?interactive:target;
    await clickTarget.scrollIntoViewIfNeeded().catch(()=>{});
    await clickTarget.click({force:true,timeout:5000}).catch(async()=>{await target.click({force:true,timeout:5000}).catch(()=>{})});
    await sleep(1000);
    const d=await visibleDownloadButton(page);
    if(d)return{found:true,matched:cand.matched,label:compact(cand.info.raw,700)};
    await page.keyboard.press('Escape').catch(()=>{});await sleep(300);
  }
  // Golden Run recorder showed the rendered option inside the chat. The visible
  // bubble may expose the prompt as ordinary text instead of an aria-label, so
  // correlate the whole bubble and then click its media child.
  const chatContainers=page.locator('flow-chat-bubble,flow-a2ui-message-renderer,flow-a2ui-video-option,article,section');
  const chatMatches=[];
  for(let i=0;i<Math.min(await chatContainers.count().catch(()=>0),320);i++){
    const el=chatContainers.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    const raw=compact(await el.innerText().catch(()=>''),6000);if(!raw)continue;
    const n=norm(raw),matched=GOLDEN_RECOVERY_TERMS.filter(t=>n.includes(t));
    if(matched.length<Math.min(3,GOLDEN_RECOVERY_TERMS.length))continue;
    const media=el.locator('flow-a2ui-video-option,img,video,[role="img"],canvas,button');
    if(!(await media.count().catch(()=>0)))continue;
    chatMatches.push({el,media,matched,label:compact(raw,700),score:matched.length});
  }
  chatMatches.sort((a,b)=>b.score-a.score);
  for(const hit of chatMatches.slice(0,12)){
    let clicked=false;
    const count=Math.min(await hit.media.count().catch(()=>0),30);
    for(let j=count-1;j>=0;j--){
      const m=hit.media.nth(j);if(!(await m.isVisible().catch(()=>false)))continue;
      const box=await m.boundingBox().catch(()=>null);if(!box||box.width<60||box.height<50)continue;
      await m.scrollIntoViewIfNeeded().catch(()=>{});
      await m.click({force:true,timeout:4000}).catch(()=>{});
      await sleep(900);
      const d=await visibleDownloadButton(page);
      if(d)return{found:true,matched:hit.matched,label:hit.label,source:'chat-bubble'};
      await page.keyboard.press('Escape').catch(()=>{});await sleep(250);
      clicked=true;
    }
    if(!clicked){
      await hit.el.click({force:true,timeout:4000}).catch(()=>{});await sleep(900);
      const d=await visibleDownloadButton(page);
      if(d)return{found:true,matched:hit.matched,label:hit.label,source:'chat-container'};
      await page.keyboard.press('Escape').catch(()=>{});await sleep(250);
    }
  }

  if(allowHistory){
    const history=page.getByRole('button',{name:/Open session history|Session history|Historial de sesiones/i}).last();
    if(await history.count().catch(()=>0)&&await history.isVisible().catch(()=>false)){
      await history.click().catch(()=>{});await sleep(1000);
      const retry=await findGoldenRecoveryAsset(page,false);
      if(retry?.found)return{...retry,source:'session-history/'+String(retry.source||'scan')};
      const tags=await page.evaluate(()=>[...new Set([...document.querySelectorAll('*')].map(e=>e.tagName.toLowerCase()).filter(x=>/session|history/.test(x)))].slice(0,80)).catch(()=>[]);
      retry.history_tags=tags;
      retry.history_body=compact(await getBody(page).catch(()=>''),7000);
      return retry;
    }
  }

  const body=compact(await getBody(page).catch(()=>''),12000);
  const buttons=[];
  const btns=page.locator('button,[role="button"],[role="tab"]');
  for(let i=0;i<Math.min(await btns.count().catch(()=>0),180);i++){
    const b=btns.nth(i);if(!(await b.isVisible().catch(()=>false)))continue;
    const label=compact(((await b.innerText().catch(()=>''))||'')+' '+((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+((await b.getAttribute('title').catch(()=>''))||''),180);
    if(label)buttons.push(label);
  }
  const partial=[];
  const els=page.locator('img,[role="img"],flow-grid-tile-container,[aria-label]');
  for(let i=0;i<Math.min(await els.count().catch(()=>0),700);i++){
    const el=els.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    const raw=compact(((await el.getAttribute('aria-label').catch(()=>''))||'')+' '+((await el.getAttribute('alt').catch(()=>''))||'')+' '+((await el.getAttribute('title').catch(()=>''))||'')+' '+((await el.innerText().catch(()=>''))||''),500);
    if(!raw)continue;const n=norm(raw),matched=GOLDEN_RECOVERY_TERMS.filter(t=>n.includes(t));if(matched.length)partial.push({matched,label:raw});
  }
  return{found:false,candidates:candidates.slice(0,10).map(x=>({matched:x.matched,label:compact(x.info.raw,240)})),partial:partial.slice(0,30),buttons:[...new Set(buttons)].slice(0,80),body_has_terms:GOLDEN_RECOVERY_TERMS.map(t=>[t,norm(body).includes(t)]),url:page.url()};
}
async function recoverGoldenRunIfRequested(db){
  if(!GOLDEN_RECOVERY_TOKEN)return{needed:false,done:false};
  const metaKey='recovery:golden:'+GOLDEN_RECOVERY_TOKEN;
  const prior=json(meta(db,metaKey,''),null);
  if(prior?.status==='completed')return{needed:true,done:true,prior};
  let row=db.prepare('SELECT * FROM factory_items WHERE episode=? LIMIT 1').get(GOLDEN_RECOVERY_EPISODE);
  if(!row)throw new Error('GOLDEN_RECOVERY_TARGET_EPISODE_NOT_FOUND:'+GOLDEN_RECOVERY_EPISODE);
  const forceReplace=String(process.env.PUBLISHER_RECOVERY_FORCE_REPLACE||'false').toLowerCase()==='true';
  if(!forceReplace&&row.videoPath&&fs.existsSync(row.videoPath)&&String(row.status)==='review'){
    const done={status:'completed',at:now(),episode:row.episode,job_id:row.id,existing:true};
    setMeta(db,metaKey,JSON.stringify(done));return{needed:true,done:true,prior:done};
  }
  publish('GOLDEN_RECOVERY_START',{episode:'E'+row.episode,job_id:row.id});
  const session=await launchLocal();
  try{
    const page=session.page||session.context.pages()[0]||await session.context.newPage();
    await ensureExpectedFlowProject(page);
    if(!String(page.url()).includes(projectPath()))await page.goto(flowUrl(),{waitUntil:'domcontentloaded',timeout:60000});
    await waitFlowReady(page,60000);await renderAuthGuard(page);
    let found=await findGoldenRecoveryAsset(page);
    let searchedProjects=[];
    if(!found.found){
      // The Chrome Recorder Golden Run began at Flow home and selected the
      // third project card. Browser session history is not guaranteed to sync
      // across profiles, so search project cards directly, prioritizing card #3.
      try{
        await page.goto('https://flow.google.com/',{waitUntil:'domcontentloaded',timeout:60000});await sleep(2500);
        const cards=page.locator('flow-project-card');
        const discovered=[];
        for(let i=0;i<Math.min(await cards.count().catch(()=>0),30);i++){
          const card=cards.nth(i);if(!(await card.isVisible().catch(()=>false)))continue;
          const a=card.locator('a[href*="/project/"]').first();
          const href=String(await a.getAttribute('href').catch(()=>'')||'');
          const text=compact(await card.innerText().catch(()=>''),500);
          const img=card.locator('img').first();
          const alt=compact((await img.getAttribute('alt').catch(()=>''))||'',220);
          if(href)discovered.push({i,href,text,alt});
        }
        const order=[...discovered.filter(x=>x.i===2),...discovered.filter(x=>x.i!==2)];
        for(const p of order){
          const absolute=p.href.startsWith('http')?p.href:'https://flow.google.com'+p.href;
          searchedProjects.push({index:p.i,href:p.href,text:p.text,alt:p.alt});
          await page.goto(absolute,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});await sleep(2500);
          try{await waitFlowReady(page,25000)}catch{}
          const attempt=await findGoldenRecoveryAsset(page,true);
          if(attempt?.found){found={...attempt,project_href:p.href,project_index:p.i,project_text:p.text};break}
        }
      }catch(e){
        searchedProjects.push({error:compact(e?.message||e,300)});
      }
    }
    if(!found.found){
      setMeta(db,metaKey,JSON.stringify({status:'pending',at:now(),episode:row.episode,job_id:row.id,last:'asset-not-found',candidates:found.candidates||[],searched_projects:searchedProjects}));
      publish('GOLDEN_RECOVERY_PENDING',{episode:'E'+row.episode,job_id:row.id,message:'Patagonia Golden Run asset not uniquely found yet; production remains paused. diag='+compact(JSON.stringify({url:found.url,body_has_terms:found.body_has_terms,partial:(found.partial||[]).slice(0,12),buttons:(found.buttons||[]).slice(0,40),history_tags:found.history_tags||[],history_body:compact(found.history_body||'',2200),searched_projects:searchedProjects}),9000),url:found.url,body_has_terms:found.body_has_terms,partial:found.partial,buttons:found.buttons});
      return{needed:true,done:false};
    }
    const localPath=path.join(VIDEO_DIR,`${row.id}.mp4`);
    try{fs.unlinkSync(localPath);}catch{}
    const dl=await downloadResult(page,{uiReady:true,signal:'golden-run-prompt-match'},localPath);
    const valid=validateMp4(localPath);
    const recoveredAt=now(),runId='manual-flow-golden-run:'+GOLDEN_RECOVERY_TOKEN;
    const flowResult={provider:PROVIDER,manual_golden_run:true,recovery_token:GOLDEN_RECOVERY_TOKEN,matched_terms:GOLDEN_RECOVERY_TERMS,matched_label:found.label,duration:valid.duration,width:valid.width,height:valid.height,size:valid.size,codec:valid.codec,validated_ftyp:true,download_quality:dl.method||CONFIG.generation.download_quality||'downloaded asset',retrieved_at:recoveredAt};
    persistReviewMetadata(db,row,flowResult);
    await saveReviewAsset(db,row,localPath,flowResult,recoveredAt);
    db.prepare('UPDATE factory_items SET providerRunId=NULL,updatedAt=? WHERE id=?').run(recoveredAt,row.id);
    if(forceReplace){
      try{db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Superseded by verified Golden Run recovery from the exact Earth Flow project.',updatedAt=? WHERE itemId=? AND day=?").run(recoveredAt,row.id,artDay())}catch{}
    }
    const exists=Number(db.prepare('SELECT COUNT(*) n FROM factory_generations WHERE runId=? OR (itemId=? AND day=? AND status=? AND error=?)').get(runId,row.id,artDay(),'review','manual-golden-run')?.n||0);
    if(!exists){
      try{db.prepare(`INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),row.id,artDay(),sha(runId+':'+row.id),CREDITS_PER_GENERATION,'review',runId,recoveredAt,recoveredAt,'manual-golden-run','automatic')}catch(e){publish('GOLDEN_RECOVERY_ACCOUNTING_WARNING',{message:compact(e?.message||e,300)})}
    }
    setLifecycle(db,row,'REVIEW_READY',{generation_id:runId,manual_golden_run:true,recovery_token:GOLDEN_RECOVERY_TOKEN,size:valid.size,duration:valid.duration,width:valid.width,height:valid.height,retrieved_at:recoveredAt,automatic_submit_forbidden:true});
    const done={status:'completed',at:recoveredAt,episode:row.episode,job_id:row.id,run_id:runId,size:valid.size,duration:valid.duration,resolution:`${valid.width}x${valid.height}`};
    setMeta(db,metaKey,JSON.stringify(done));
    setMeta(db,'flow:lastSuccessfulMp4At',recoveredAt);
    publish('GOLDEN_RECOVERY_REVIEW_READY',{episode:'E'+row.episode,job_id:row.id,size:valid.size,duration:valid.duration,resolution:done.resolution,factory_url:`/factory/video/${row.id}`});
    return{needed:true,done:true,prior:done};
  }finally{await session.close().catch(()=>{})}
}

async function retrieveExisting(page,row,cp,lc,db){setLifecycle(db,row,'RETRIEVING',{generation_id:lc?.generation_id||row.providerRunId||'',baseline:lc?.baseline||[],baseline_inventory:lc?.baseline_inventory||null});const baseline=Array.isArray(lc?.baseline)?lc.baseline:[],baselineInventory=lc?.baseline_inventory||null,deadline=Date.now()+15*60*1000;let rendered=null,lastVideos=[],uiSignal=null,lastHeartbeat=0,emptyEvidenceSince=0;const generationStartedMs=Date.parse(String(lc?.generation_started_at||lc?.submit_boundary_at||''))||Date.now();while(Date.now()<deadline){await renderAuthGuard(page);if(Date.now()-lastHeartbeat>10000){lastHeartbeat=Date.now();try{db.prepare('UPDATE factory_items SET lastProgressAt=?,updatedAt=? WHERE id=?').run(now(),now(),row.id);}catch{}}const alreadyOpenDownload=await visibleDownloadButton(page).catch(()=>null);if(alreadyOpenDownload){rendered={uiReady:true,signal:'download-already-visible',baselineInventory};break;}lastVideos=await currentVideos(page);rendered=firstFreshRendered(lastVideos,baseline);if(rendered)break;const text=await getBody(page);if(flowCreditFailure(text))throw new Error('FLOW_INSUFFICIENT_CREDITS');if(/failed to generate|generation failed|couldn't generate|no se pudo generar/i.test(text))throw new Error('FLOW_GENERATION_FAILED');const stillBusy=/generating|processing|rendering|creating video|generando|procesando|upscaling/i.test(text);if(baselineInventory){
  uiSignal=await openLatestExpectedVideoTile(page,baselineInventory);
  if(!uiSignal?.ready)uiSignal=await openUniqueFreshInventoryResult(page,baselineInventory);
  if(Date.now()-lastHeartbeat<2500||!uiSignal?.ready)publish('RETRIEVAL_PROGRESS',{episode:'E'+row.episode,job_id:row.id,signal:uiSignal?.signal||'none',stillBusy,videos:lastVideos.length});
  if(uiSignal?.ready){rendered={uiReady:true,signal:uiSignal.signal,baselineInventory};break;}
  const noFresh=/fresh-tile-occurrences:0|video-tile-count:\d+</.test(String(uiSignal?.signal||''))&&!/latest-video-tile-no-download/.test(String(uiSignal?.signal||''));
  if(!stillBusy&&lastVideos.length===0&&noFresh&&Date.now()-generationStartedMs>20*60*1000){if(!emptyEvidenceSince)emptyEvidenceSince=Date.now();if(Date.now()-emptyEvidenceSince>20000)throw new Error('FLOW_NO_RETAINED_RENDER_AFTER_20M');}else emptyEvidenceSince=0;
}await sleep(2500);}if(!rendered)throw new Error(`RENDER_TIMEOUT:videos=${lastVideos.length}:ui=${uiSignal?.signal||'none'}`);const localPath=path.join(VIDEO_DIR,`${row.id}.mp4`);try{fs.unlinkSync(localPath);}catch{}const dl=await downloadResult(page,rendered,localPath),valid=validateMp4(localPath),flowResult={provider:PROVIDER,generation_id:lc?.generation_id||row.providerRunId||'',generation_started_at:lc?.generation_started_at||'',duration:valid.duration,width:valid.width,height:valid.height,size:valid.size,codec:valid.codec,validated_ftyp:true,download_quality:dl.method||CONFIG.generation.download_quality||'downloaded asset',retrieved_at:now()};persistReviewMetadata(db,row,flowResult);await saveReviewAsset(db,row,localPath,flowResult);try{db.prepare(`UPDATE factory_generations SET status='review',updatedAt=?,error=NULL WHERE itemId=? AND runId=?`).run(now(),row.id,String(lc?.generation_id||row.providerRunId||''));}catch{}setLifecycle(db,row,'REVIEW_READY',{...lc,generation_id:lc?.generation_id||row.providerRunId||'',size:valid.size,duration:valid.duration,width:valid.width,height:valid.height,download_quality:flowResult.download_quality,retrieved_at:now()});setMeta(db,'flow:lastSuccessfulGenerationAt',lc?.generation_started_at||now());setMeta(db,'flow:lastSuccessfulMp4At',now());setMeta(db,'automation:provider',PROVIDER);setMeta(db,'automation:paidDependencyDetected','false');setMeta(db,'automation:tinyfishRequired','false');try{fs.writeFileSync(path.join(FACTORY_DIR,'flow-browser-self-test.json'),JSON.stringify({at:now(),ok:true,stage:'real-production-review-ready',provider:PROVIDER,episode:`T${row.season}E${row.episode}`,mp4_valid:true,duration:valid.duration,width:valid.width,height:valid.height,codec:valid.codec},null,2),{mode:0o600});}catch{}publish('REVIEW_READY',{episode:`T${row.season}E${row.episode}`,job_id:row.id,generation_id:lc?.generation_id||row.providerRunId||'',size:valid.size,duration:valid.duration,resolution:`${valid.width}x${valid.height}`,factory_url:`/factory/video/${row.id}`});return true;}
async function processRow(db,row){
  const cp=preparePromptIfNeeded(db,row);row=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id);let lc=lifecycle(db,row);const state=String(lc?.state||'').toUpperCase(),session=await launchLocal(),context=session.context;
  try{
    const page=session.page||context.pages()[0]||await context.newPage();
    await ensureExpectedFlowProject(page);
    if(!String(page.url()).includes(projectPath()))await page.goto(flowUrl(),{waitUntil:'domcontentloaded',timeout:60000});
    await waitFlowReady(page,60000);
    const verifiedTitle=await visibleTopProjectTitle(page);
    if(EXPECTED_FLOW_PROJECT_NAME&&verifiedTitle!==EXPECTED_FLOW_PROJECT_NAME)throw new Error('FLOW_TARGET_PROJECT_NOT_VERIFIED:'+compact(verifiedTitle,120));
    if(AFTER_GENERATE.has(state))return await retrieveExisting(page,row,cp,lc,db);
    if(AMBIGUOUS.has(state)){const reconciled=await reconcileAmbiguousGeneric(page,row,lc,db);if(reconciled.mode==='retrieve')return await retrieveExisting(page,row,cp,reconciled.lifecycle,db);return false}
    const reviewerRetry=isReviewerRetry(row);
    const otherActive=db.prepare("SELECT id,episode,status FROM factory_items WHERE id<>? AND status='generating' ORDER BY episode LIMIT 1").get(row.id);
    if(otherActive){
      publish('SERIAL_GATE_BLOCKED',{episode:'E'+row.episode,job_id:row.id,blocking_episode:'E'+otherActive.episode,blocking_job_id:otherActive.id});
      return false;
    }
    const envEnabled=String(process.env.PUBLISHER_ENABLED||'true').toLowerCase()!=='false';
    const manualSubmit=envEnabled&&meta(db,'automation:allowSubmit','0')==='1',runtimeEnabled=meta(db,'automation:factoryEnabled','false')==='true',autoSubmit=envEnabled&&runtimeEnabled&&meta(db,'automation:freeFactoryEnabled','0')==='1'&&(reviewerRetry||effectiveDailyCount(db)<dailyProductionLimit()),submitAuthorized=manualSubmit||autoSubmit;
    publish('PREFLIGHT',{episode:'E'+row.episode,job_id:row.id});
    const pf=await preflight(page,row,cp);
    db.prepare('UPDATE factory_items SET transportPreflight=?,error=NULL,updatedAt=? WHERE id=?').run(JSON.stringify(pf).slice(0,20000),now(),row.id);
    setLifecycle(db,row,'PREFLIGHT_PASSED',{preflight_at:now(),settings:pf.settings,characters:cp.visual,prompt_hash:cp.hash,prepared_state_verified:Boolean(pf.prepared_state_verified)});
    if(!submitAuthorized){const used=effectiveDailyCount(db);setMeta(db,'flow:state',used>=dailyProductionLimit()?'ESPERANDO CRÉDITOS':'CONECTADO');setMeta(db,'flow:currentStep',used>=dailyProductionLimit()?'daily-limit':'preflight:passed-no-submit');publish(used>=dailyProductionLimit()?'DAILY_LIMIT':'PREFLIGHT_READY_NO_SUBMIT',{episode:'E'+row.episode,job_id:row.id,characters:cp.visual,settings:pf.settings});return false}
    if(manualSubmit)setMeta(db,'automation:allowSubmit','0');
    const baseline=await currentVideos(page),baselineInventory=await captureFlowInventory(page),baselineBusy=await visibleGenerationBusyCount(page),genId='free-'+randomUUID();
    if(reviewerRetry){
      const token=String(row.reviewRetryToken||'');
      const claimed=db.prepare("UPDATE factory_items SET status='generating',providerRunId=?,reviewRetrySubmittedToken=reviewRetryToken,error=NULL,updatedAt=? WHERE id=? AND reviewRetryToken=? AND (reviewRetrySubmittedToken IS NULL OR reviewRetrySubmittedToken<>reviewRetryToken)").run(genId,now(),row.id,token);
      if(Number(claimed.changes||0)!==1)throw new Error('REVIEW_RETRY_ALREADY_SUBMITTED');
    }else db.prepare("UPDATE factory_items SET status='generating',providerRunId=?,error=NULL,updatedAt=? WHERE id=?").run(genId,now(),row.id);
    setLifecycle(db,row,'SUBMIT_BOUNDARY_ENTERED',{generation_id:genId,submit_boundary_at:now(),baseline,baseline_inventory:baselineInventory,reviewer_retry:reviewerRetry,retry_token:reviewerRetry?String(row.reviewRetryToken||''):null});
    const submitMode=await clickSubmitExactlyOnce(page,baselineInventory,baseline,baselineBusy);
    const priorConsent=meta(db,'flow:consentMode','UNKNOWN');
    const consentMode=/approve-always/i.test(submitMode)?'ALWAYS_APPROVED':(/approve-once|confirm-generate/i.test(submitMode)?'PER_GENERATION':(priorConsent==='ALWAYS_APPROVED'?'ALWAYS_APPROVED':'NO_DIALOG_OBSERVED'));
    setMeta(db,'flow:consentMode',consentMode);
    setLifecycle(db,row,'SUBMIT_BOUNDARY_ENTERED',{generation_id:genId,submit_boundary_at:now(),submit_mode:submitMode,consent_mode:consentMode,baseline,baseline_inventory:baselineInventory,reviewer_retry:reviewerRetry,retry_token:reviewerRetry?String(row.reviewRetryToken||''):null,automatic_submit_forbidden:true});
    const started=await waitGenerationStarted(page,baseline,baselineInventory,baselineBusy,12*60*1000);
    if(!started.started){
      const retryAt=Date.now()+30000;
      setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{generation_id:genId,submit_mode:submitMode,consent_mode:consentMode,baseline,baseline_inventory:baselineInventory,evidence:started.evidence,last_error:'No hard Flow generation evidence after submit. Read-only reconciliation required before any new Generate.',retry_at:new Date(retryAt).toISOString(),automatic_submit_forbidden:true});
      db.prepare("UPDATE factory_items SET status='generating',error=?,nextTry=?,updatedAt=? WHERE id=?").run('SUBMIT_AMBIGUOUS — reconciliation pending; Generate is locked.',retryAt,now(),row.id);
      publish('SUBMIT_AMBIGUOUS',{episode:'E'+row.episode,job_id:row.id,message:'Submit boundary crossed without hard start evidence. Reconcile only; do not click Generate again.'});
      return false
    }
    const startedAt=now();lc=setLifecycle(db,row,'GENERATION_STARTED',{generation_id:genId,generation_started_at:startedAt,submit_mode:submitMode,consent_mode:consentMode,baseline,baseline_inventory:baselineInventory,evidence:started.evidence,automatic_submit_forbidden:true});
    try{db.prepare("INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)").run(randomUUID(),row.id,artDay(new Date(startedAt)),sha(cp.hash+':'+genId),CREDITS_PER_GENERATION,'running',genId,startedAt,startedAt,reviewerRetry?'review_retry':'automatic')}catch{}
    setMeta(db,'flow:lastSuccessfulGenerationAt',startedAt);publish('FLOW_RENDER_CONFIRMED',{episode:'E'+row.episode,job_id:row.id,generation_id:genId,evidence:started.evidence});return await retrieveExisting(page,row,cp,lc,db);
  }finally{await session.close().catch(()=>{})}
}
function reconcileAmbiguousNoGeneration(){return false;}
function serialReady(db,row){
  if(!row)return false;if(!CONFIG.content.serialized||Number(row.episode)<=1)return true;
  const prev=db.prepare('SELECT status FROM factory_items WHERE episode<? ORDER BY episode DESC LIMIT 1').get(Number(row.episode));if(!prev)return false;
  const gate=CONFIG.content.continuity_gate;if(gate==='none')return true;
  // Strict handoff: the next episode may start only after the previous render
  // has been recovered into Review (or has already advanced beyond Review).
  // Approve/Redo is NOT required. Draft/regen rows never count as recovered,
  // even if stale media fields from an older attempt still exist.
  return ['review','queued','historical','published'].includes(String(prev.status||''));
}
function retryTokenOpen(row){
  const token=String(row?.reviewRetryToken||'').trim(),submitted=String(row?.reviewRetrySubmittedToken||'').trim();
  return Boolean(token&&token!==submitted);
}
function reviewerRetryTokenConsumed(row){
  const token=String(row?.reviewRetryToken||'').trim(),submitted=String(row?.reviewRetrySubmittedToken||'').trim();
  return Boolean(token&&token===submitted&&['reuse_prompt','revise_prompt'].includes(String(row?.retryStrategy||''))&&String(row?.reviewFeedback||'').trim().length>=3);
}
function isReviewerRetry(row){
  return !!row&&['reuse_prompt','revise_prompt'].includes(String(row.retryStrategy||''))&&String(row.reviewFeedback||'').trim().length>=3&&['regen_wait','draft'].includes(String(row.status||''))&&retryTokenOpen(row);
}
function normalizeReauthorizedReviewerRetries(db){
  try{
    const rows=db.prepare("SELECT * FROM factory_items WHERE status='generating' AND retryStrategy IN ('reuse_prompt','revise_prompt') AND reviewFeedback IS NOT NULL AND reviewRetryToken IS NOT NULL AND (reviewRetrySubmittedToken IS NULL OR reviewRetrySubmittedToken<>reviewRetryToken)").all();
    for(const row of rows){
      const lc=lifecycle(db,row)||{};
      if(Number(lc.retry_reauthorization_count||0)<1&&!lc.prior_submit_unretained)continue;
      db.prepare("UPDATE factory_items SET status='regen_wait',providerRunId=NULL,error='Verified clean REDO retry ready to submit now.',nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
      setLifecycle(db,row,'REDO_RETRY_REAUTHORIZED',{...lc,reviewer_retry:true,retry_token:String(row.reviewRetryToken||''),automatic_submit_forbidden:false,retry_reauthorization_count:Math.max(1,Number(lc.retry_reauthorization_count||0)),recovered_state_bug:true});
      publish('REVIEW_RETRY_REAUTH_STATE_REPAIRED',{episode:'E'+row.episode,job_id:row.id,message:'Recovered REDO from stale lifecycle state; clean retry is ready immediately.'});
    }
  }catch(e){publish('REVIEW_RETRY_REAUTH_REPAIR_WARNING',{message:compact(e?.message||e,400)})}
}
function normalizeConsumedReviewerRetries(db){
  const rows=db.prepare("SELECT * FROM factory_items WHERE retryStrategy IN ('reuse_prompt','revise_prompt') AND reviewFeedback IS NOT NULL AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken AND status NOT IN ('review','queued','historical','published')").all();
  for(const row of rows){
    const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
    if(AFTER_GENERATE.has(state)||AMBIGUOUS.has(state)){
      if(String(row.status||'')!=='generating')db.prepare("UPDATE factory_items SET status='generating',nextTry=0,error='REDO already submitted: recovery only; Generate is locked.',updatedAt=? WHERE id=?").run(now(),row.id);
    }else if(state==='MANUAL_HOLD_SUBMIT_NOT_CONFIRMED'){
      db.prepare("UPDATE factory_items SET status='generating',nextTry=0,error='REDO recovery resumed after runtime upgrade; Generate remains locked.',updatedAt=? WHERE id=?").run(now(),row.id);
      setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{...lc,reviewer_retry:true,retry_token:String(row.reviewRetryToken||''),automatic_submit_forbidden:true,recovery_mode:'prompt-correlated',resumed_at:now()});
      publish('REVIEW_RETRY_RECOVERY_RESUMED',{episode:'E'+row.episode,job_id:row.id});
    }else if(String(row.status||'')!=='manual_hold'){
      db.prepare("UPDATE factory_items SET status='manual_hold',nextTry=0,error='REDO token already consumed without any submit-boundary evidence. A new human REDO is required.',updatedAt=? WHERE id=?").run(now(),row.id);
      setLifecycle(db,row,'MANUAL_HOLD_CONSUMED_RETRY',{...lc,reviewer_retry:true,retry_token:String(row.reviewRetryToken||''),automatic_submit_forbidden:true,held_at:now()});
    }
  }
}
function auditRedoState(db){
  const consumed=Number(db.prepare("SELECT COUNT(*) n FROM factory_items WHERE status IN ('draft','regen_wait') AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken").get()?.n||0);
  if(consumed)throw new Error('REDO_STATE_INVARIANT_FAILED:'+consumed);
}

function quarantinePriorDayAmbiguous(db){
  const today=artDay();
  const rows=db.prepare("SELECT * FROM factory_items WHERE status='generating' ORDER BY episode").all();
  let quarantined=0;
  for(const row of rows){
    const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
    if(!AMBIGUOUS.has(state))continue;
    const boundary=String(lc.submit_boundary_at||lc.reconciled_at||row.lastProgressAt||row.updatedAt||'');
    const d=new Date(boundary);
    if(!Number.isFinite(d.getTime())||artDay(d)>=today)continue;
    db.prepare("UPDATE factory_items SET status='manual_hold',nextTry=0,error=?,lastProgressAt=?,updatedAt=? WHERE id=?")
      .run('Previous-day ambiguous submit quarantined automatically. Generate remains locked for this episode; daily production may continue with later episodes.',now(),now(),row.id);
    setLifecycle(db,row,'MANUAL_HOLD_PRIOR_DAY_AMBIGUOUS',{
      ...lc,
      quarantined_at:now(),
      quarantined_from_state:state,
      automatic_submit_forbidden:true,
      automatic_recovery_forbidden:false,
      daily_production_unblocked:true
    });
    publish('PRIOR_DAY_AMBIGUOUS_QUARANTINED',{episode:'E'+row.episode,job_id:row.id,message:'Old ambiguous submit moved out of the daily production head-of-line. No duplicate Generate will be sent.'});
    quarantined++;
  }
  return quarantined;
}

function quarantineStaleReviewerRetryAmbiguous(db){
  const rows=db.prepare("SELECT * FROM factory_items WHERE status='generating' AND retryStrategy IN ('reuse_prompt','revise_prompt') AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken ORDER BY episode").all();
  let held=0;
  for(const row of rows){
    const lc=lifecycle(db,row)||{};
    if(String(lc.state||'').toUpperCase()!=='SUBMIT_AMBIGUOUS')continue;
    const reauth=Number(lc.retry_reauthorization_count||0);
    if(reauth<1)continue;
    const boundary=Date.parse(String(lc.submit_boundary_at||lc.reconciled_at||row.lastProgressAt||row.updatedAt||''));
    if(!Number.isFinite(boundary)||Date.now()-boundary<15*60*1000)continue;
    db.prepare("UPDATE factory_items SET status='manual_hold',nextTry=0,error=?,lastProgressAt=?,updatedAt=? WHERE id=?")
      .run('REDO quedó ambiguo incluso después del único reintento limpio permitido. Se mantiene bloqueado contra duplicados y deja de frenar la producción diaria.',now(),now(),row.id);
    setLifecycle(db,row,'MANUAL_HOLD_STALE_REDO_AMBIGUOUS',{
      ...lc,
      held_at:now(),
      automatic_submit_forbidden:true,
      automatic_recovery_forbidden:false,
      daily_production_unblocked:true,
      reviewer_retry:true,
      retry_token:String(row.reviewRetryToken||'')
    });
    publish('STALE_REDO_AMBIGUOUS_QUARANTINED',{episode:'E'+row.episode,job_id:row.id,message:'Stale REDO ambiguity quarantined after the single allowed clean retry. No duplicate Generate will be sent; daily production is unblocked.'});
    held++;
  }
  return held;
}


function repairEarthE10NoGeneration(db){
  const key='repair:earth-e10-no-generation-v1';
  if(meta(db,key,'')==='done')return false;
  const row=db.prepare("SELECT * FROM factory_items WHERE episode=10 LIMIT 1").get();
  if(!row){setMeta(db,key,'done');return false;}
  const lc=lifecycle(db,row)||{};
  const state=String(lc.state||'').toUpperCase();
  const mode=String(lc.submit_mode||'');
  const noResult=String(row.status||'')==='generating'&&state==='SUBMIT_AMBIGUOUS'&&/composer-arrow-direct/.test(mode);
  if(noResult){
    const run=String(lc.generation_id||row.providerRunId||'');
    if(run){
      try{db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Operator verified no Flow generation after direct arrow click.',updatedAt=? WHERE itemId=? AND runId=?").run(now(),row.id,run)}catch{}
    }
    db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?")
      .run(now(),now(),row.id);
    setLifecycle(db,row,'NO_GENERATION_REPAIRED',{prior_generation_id:run,repaired_at:now(),automatic_submit_forbidden:false,evidence:'No render or generation exists in Flow; previous direct arrow click produced no confirmation and no hard start evidence.'});
    publish('NO_GENERATION_REPAIRED',{episode:'E10',job_id:row.id,message:'False ambiguous submit cleared. E10 is ready for one clean automatic submit using the repaired interactive control and point-cost confirmation.'});
  }
  setMeta(db,key,'done');
  return noResult;
}

function repairEarthE11KnownNoCharge(db){
  const key='repair:earth-e11-known-no-charge-v1';
  if(meta(db,key,'')==='done')return false;
  const row=db.prepare("SELECT * FROM factory_items WHERE episode=11 LIMIT 1").get();
  if(!row){setMeta(db,key,'done');return false;}
  const lc=lifecycle(db,row)||{};
  if(String(row.status||'')==='generating'&&String(lc.state||'').toUpperCase()==='SUBMIT_AMBIGUOUS'){
    const run=String(lc.generation_id||row.providerRunId||'');
    if(run)try{db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Known Google Flow no-charge unusual-activity rejection.',updatedAt=? WHERE itemId=? AND runId=?").run(now(),row.id,run)}catch{}
    db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
    setLifecycle(db,row,'KNOWN_NO_CHARGE_REPAIRED',{prior_generation_id:run,repaired_at:now(),automatic_submit_forbidden:false,evidence:'Live Flow UI explicitly reported unusual activity and that this generation was not charged.'});
    publish('KNOWN_NO_CHARGE_REPAIRED',{episode:'E11',job_id:row.id,message:'Verified no-charge E11 attempt cleared. Automatic production can retry immediately under the repaired detector.'});
    setMeta(db,key,'done');
    return true;
  }
  setMeta(db,key,'done');
  return false;
}

function repairEarthTodayAfterOperatorConfirmedOnlyFirstRender(db){
  const key='repair:earth-2026-09-23-only-e10-rendered-v1';
  if(meta(db,key,'')==='done')return false;

  // Operator verified live in Google Flow that only the first successful render
  // of the day exists. All later E11+ attempts produced no retained generation.
  // Clear those stale pre/reconciliation states once, then let strict serial
  // production restart from E11. Review/queued/published rows are never touched.
  const rows=db.prepare("SELECT * FROM factory_items WHERE episode>=11 AND status NOT IN ('review','queued','historical','published') AND (reviewFeedback IS NULL OR TRIM(reviewFeedback)='') ORDER BY episode").all();
  let repaired=0;
  for(const row of rows){
    try{
      db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Operator confirmed no retained Google Flow render after today\\'s first successful episode.',updatedAt=? WHERE itemId=? AND status NOT IN ('review','completed')").run(now(),row.id);
    }catch{}
    db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?")
      .run(now(),now(),row.id);
    setLifecycle(db,row,'OPERATOR_CONFIRMED_NO_GENERATION_RESET',{
      repaired_at:now(),
      automatic_submit_forbidden:false,
      operator_evidence:"Only today's first successful Earth in Ten render is present in Google Flow; later attempts retained no generation."
    });
    repaired++;
  }
  setMeta(db,key,'done');
  if(repaired)publish('TODAY_STALE_ATTEMPTS_RESET',{repaired,message:'Cleared stale E11+ no-generation states after operator verification. Strict serial production resumes from E11 only.'});
  return repaired>0;
}

function normalizeOutOfOrderAmbiguous(db){
  // Any ambiguous submit for episode N that was created before N-1 reached
  // Review is a legacy sequencing violation. Preserve the submit evidence and
  // forbid duplicates, but do not let it block the rightful earlier episode.
  const active=db.prepare("SELECT * FROM factory_items WHERE status='generating' ORDER BY episode").all();
  for(const row of active){
    const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
    if(!AMBIGUOUS.has(state))continue;
    if(serialReady(db,row))continue;
    db.prepare("UPDATE factory_items SET status='out_of_order_hold',nextTry=0,error=?,lastProgressAt=?,updatedAt=? WHERE id=?")
      .run('Out-of-order ambiguous submit preserved for later recovery. Generate is locked; earlier serial episode has priority.',now(),now(),row.id);
    setLifecycle(db,row,'OUT_OF_ORDER_AMBIGUOUS_HOLD',{
      ...lc,
      held_at:now(),
      automatic_submit_forbidden:true,
      out_of_order:true,
      daily_production_unblocked:true
    });
    publish('OUT_OF_ORDER_AMBIGUOUS_HELD',{episode:'E'+row.episode,job_id:row.id,message:'Legacy out-of-order submit quarantined. Earlier episode can continue; no duplicate Generate will be sent.'});
  }

  const held=db.prepare("SELECT * FROM factory_items WHERE status='out_of_order_hold' ORDER BY episode").all();
  for(const row of held){
    if(!serialReady(db,row))continue;
    const lc=lifecycle(db,row)||{};
    db.prepare("UPDATE factory_items SET status='generating',nextTry=0,error='Out-of-order submit reached its serial turn; recovery only.',lastProgressAt=?,updatedAt=? WHERE id=?")
      .run(now(),now(),row.id);
    setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{
      ...lc,
      resumed_at:now(),
      automatic_submit_forbidden:true,
      out_of_order_recovery_resumed:true
    });
    publish('OUT_OF_ORDER_AMBIGUOUS_RESUMED',{episode:'E'+row.episode,job_id:row.id,message:'Episode reached its serial turn; recovering the preserved submit before any new Generate.'});
    break;
  }
}
function normalizeLiveNoChargeCooldown(db){
  try{
    const rows=db.prepare("SELECT * FROM factory_items WHERE status='draft' AND error LIKE 'FLOW_TRANSIENT_NO_CHARGE%' ORDER BY episode").all();
    for(const row of rows){
      const key='flow:noChargeStreak:'+row.id;
      let streak=Number(meta(db,key,'0'))||0;
      if(streak<2){streak=2;setMeta(db,key,String(streak))}
      const minUntil=Date.now()+20*60*1000;
      if(Number(row.nextTry||0)<minUntil){
        db.prepare("UPDATE factory_items SET nextTry=?,error=?,updatedAt=? WHERE id=?").run(minUntil,'FLOW_TRANSIENT_NO_CHARGE — automatic retry scheduled after 20m cooldown.',now(),row.id);
        setMeta(db,'flow:transientCooldownUntil',String(minUntil));
        publish('FLOW_TRANSIENT_COOLDOWN_EXTENDED',{episode:'E'+row.episode,job_id:row.id,until:new Date(minUntil).toISOString(),message:'Repeated no-charge unusual-activity responses detected. Cooldown extended automatically to stop hammering Flow.'});
      }
    }
  }catch(e){publish('FLOW_TRANSIENT_COOLDOWN_WARNING',{message:compact(e?.message||e,300)})}
}
function seedTransientCooldownFromRecentNoCharge(db){
  const key='repair:flow-transient-cooldown-seed-v1';
  if(meta(db,key,'')==='done')return;
  const row=db.prepare("SELECT updatedAt FROM factory_items WHERE error LIKE 'FLOW_TRANSIENT_NO_CHARGE%' ORDER BY updatedAt DESC LIMIT 1").get();
  const at=Date.parse(String(row?.updatedAt||''))||0;
  if(at&&Date.now()-at<30*60*1000){
    const until=Math.max(Date.now()+60*1000,at+10*60*1000);
    setMeta(db,'flow:transientCooldownUntil',String(until));
    publish('FLOW_TRANSIENT_COOLDOWN_ARMED',{until:new Date(until).toISOString(),message:'Recent Google Flow unusual-activity/no-charge response detected. New submits pause briefly, then resume automatically on the same serial episode.'});
  }
  setMeta(db,key,'done');
}


function productionCandidate(db){
  // Recovery always wins, but out-of-order ambiguous rows are quarantined by
  // normalizeOutOfOrderAmbiguous() before this function runs.
  const inflight=db.prepare("SELECT * FROM factory_items WHERE status='generating' ORDER BY episode LIMIT 1").get();
  if(inflight){
    const last=Date.parse(String(inflight.lastProgressAt||inflight.updatedAt||''))||0;
    const due=Number(inflight.nextTry||0)<=Date.now()||(last>0&&Date.now()-last>60*1000);
    return due?inflight:null;
  }

  // Human REDO remains immediate once its continuity predecessor is recovered.
  const retries=db.prepare("SELECT * FROM factory_items WHERE status IN ('regen_wait','draft') AND retryStrategy IN ('reuse_prompt','revise_prompt') AND reviewFeedback IS NOT NULL AND TRIM(reviewFeedback)<>'' ORDER BY updatedAt,episode").all();
  for(const retry of retries){
    if(Number(retry.nextTry||0)<=Date.now()&&isReviewerRetry(retry)&&serialReady(db,retry))return retry;
  }

  // Strict normal head-of-line: NEVER skip an earlier draft just because it is
  // in retry/cooldown. This is the core generate -> recover -> next guarantee.
  const first=db.prepare("SELECT * FROM factory_items WHERE status IN ('draft','regen_wait') AND (reviewFeedback IS NULL OR TRIM(reviewFeedback)='') ORDER BY episode LIMIT 1").get();
  if(!first)return null;
  if(!serialReady(db,first))return null;
  if(Number(first.nextTry||0)>Date.now())return null;
  return first;
}

const SUPABASE_PASSKEY_BOOTSTRAP=String(process.env.PUBLISHER_SUPABASE_PASSKEY_BOOTSTRAP||'').trim()==='1';
const SUPABASE_PASSKEY_PROJECT_REF=String(process.env.PUBLISHER_SUPABASE_PASSKEY_PROJECT_REF||'wrflttnmlrsuzuukdhtf').trim();
const SUPABASE_PASSKEY_STATE=path.join(FACTORY_DIR,'supabase-passkey-bootstrap.json');

function readSupabasePasskeyState(){
  try{return JSON.parse(fs.readFileSync(SUPABASE_PASSKEY_STATE,'utf8'))||{}}catch{return{}}
}
function writeSupabasePasskeyState(v){
  try{fs.writeFileSync(SUPABASE_PASSKEY_STATE,JSON.stringify(v,null,2),{mode:0o600})}catch{}
}
async function configurePublisherFactorySupabasePasskeysIfRequested(db){
  if(!SUPABASE_PASSKEY_BOOTSTRAP)return{requested:false,done:false};
  const prior=readSupabasePasskeyState();
  if(prior?.done===true){
    setMeta(db,'maintenance:supabasePasskeys','done');
    return{requested:true,done:true};
  }
  const lastAttempt=Date.parse(String(prior?.attempted_at||''))||0;
  if(prior?.status==='auth_required'&&Date.now()-lastAttempt<30*60*1000){
    setMeta(db,'maintenance:supabasePasskeys','auth_required');
    return{requested:true,done:false,authRequired:true};
  }

  const target='https://supabase.com/dashboard/project/'+encodeURIComponent(SUPABASE_PASSKEY_PROJECT_REF)+'/auth/passkeys';
  let session=null;
  try{
    publish('SUPABASE_PASSKEY_BOOTSTRAP_START',{target,message:'FreeBrowserProvider is opening Supabase Passkeys settings.'});
    session=await launchLocal();
    const page=await session.context.newPage();
    await page.goto(target,{waitUntil:'domcontentloaded',timeout:60000});
    await sleep(3500);
    const url=String(page.url()||'');
    const body=compact(await page.locator('body').innerText().catch(()=>''),6000);
    const authScreen=/sign in|log in|continue with github|continue with google|welcome back/i.test(body)&&!/relying party|enable passkey authentication|passkeys/i.test(body);
    if(/\/sign-in|\/login/i.test(url)||authScreen){
      const state={done:false,status:'auth_required',attempted_at:now(),url};
      writeSupabasePasskeyState(state);
      setMeta(db,'maintenance:supabasePasskeys','auth_required');
      publish('SUPABASE_PASSKEY_AUTH_REQUIRED',{url,message:'FreeBrowserProvider reached Supabase, but its persistent browser profile is not authenticated to the Supabase dashboard. No credentials were guessed and no paid browser fallback was used.'});
      return{requested:true,done:false,authRequired:true};
    }

    const findInput=async(pattern)=>{
      const byLabel=page.getByLabel(pattern).first();
      if(await byLabel.count().catch(()=>0)&&await byLabel.isVisible().catch(()=>false))return byLabel;
      const labels=page.locator('label');
      for(let i=0;i<Math.min(await labels.count().catch(()=>0),80);i++){
        const l=labels.nth(i),txt=compact(await l.innerText().catch(()=>''),240);
        if(!pattern.test(txt))continue;
        const id=await l.getAttribute('for').catch(()=>null);
        if(id){const safeId=String(id).replace(/\\/g,'\\\\').replace(/"/g,'\\"');const el=page.locator('[id="'+safeId+'"]').first();if(await el.count().catch(()=>0))return el}
        const el=l.locator('input,textarea').first();if(await el.count().catch(()=>0))return el;
      }
      return null;
    };

    const display=await findInput(/Relying Party Display Name|Display Name/i);
    const rpId=await findInput(/Relying Party ID|RP ID/i);
    const origins=await findInput(/Relying Party Origins|Origins/i);
    if(!display||!rpId||!origins)throw new Error('SUPABASE_PASSKEY_FIELDS_NOT_FOUND');

    const switches=page.getByRole('switch');
    let toggle=null;
    for(let i=0;i<Math.min(await switches.count().catch(()=>0),20);i++){
      const sw=switches.nth(i);
      const label=compact((await sw.getAttribute('aria-label').catch(()=>''))+' '+(await sw.textContent().catch(()=>'')),240);
      if(/passkey/i.test(label)){toggle=sw;break}
    }
    if(!toggle){
      const checkbox=page.locator('input[type="checkbox"]').first();
      if(await checkbox.count().catch(()=>0))toggle=checkbox;
    }
    if(!toggle)throw new Error('SUPABASE_PASSKEY_ENABLE_CONTROL_NOT_FOUND');

    const checked=await toggle.isChecked().catch(async()=>String(await toggle.getAttribute('aria-checked').catch(()=>''))==='true');
    if(!checked)await toggle.click();

    await display.fill('Publisher Factory');
    await rpId.fill('fruttidrama-afk.github.io');
    await origins.fill('https://fruttidrama-afk.github.io');

    const saveCandidates=[
      page.getByRole('button',{name:/save/i}).last(),
      page.getByRole('button',{name:/update/i}).last(),
      page.getByRole('button',{name:/apply/i}).last()
    ];
    let saved=false;
    for(const b of saveCandidates){
      if(await b.count().catch(()=>0)&&await b.isVisible().catch(()=>false)&&await b.isEnabled().catch(()=>false)){
        await b.click();saved=true;break;
      }
    }
    if(!saved)throw new Error('SUPABASE_PASSKEY_SAVE_BUTTON_NOT_FOUND');

    await sleep(1800);
    const finalDisplay=String(await display.inputValue().catch(()=>'')).trim();
    const finalRp=String(await rpId.inputValue().catch(()=>'')).trim();
    const finalOrigins=String(await origins.inputValue().catch(()=>'')).trim();
    const finalChecked=await toggle.isChecked().catch(async()=>String(await toggle.getAttribute('aria-checked').catch(()=>''))==='true');
    if(!finalChecked||finalDisplay!=='Publisher Factory'||finalRp!=='fruttidrama-afk.github.io'||!finalOrigins.includes('https://fruttidrama-afk.github.io')){
      throw new Error('SUPABASE_PASSKEY_POST_SAVE_VERIFICATION_FAILED');
    }

    const state={done:true,status:'configured',attempted_at:now(),configured_at:now(),rp_display_name:finalDisplay,rp_id:finalRp,rp_origins:finalOrigins};
    writeSupabasePasskeyState(state);
    setMeta(db,'maintenance:supabasePasskeys','done');
    publish('SUPABASE_PASSKEY_BOOTSTRAP_DONE',{message:'Publisher Factory passkeys enabled through FreeBrowserProvider.',rp_id:finalRp,rp_origins:finalOrigins});
    return{requested:true,done:true};
  }catch(err){
    const message=compact(err?.stack||err?.message||err,900);
    writeSupabasePasskeyState({done:false,status:'retryable_error',attempted_at:now(),error:message});
    setMeta(db,'maintenance:supabasePasskeys','retryable_error');
    publish('SUPABASE_PASSKEY_BOOTSTRAP_ERROR',{message});
    return{requested:true,done:false,error:message};
  }finally{
    try{await session?.close()}catch{}
  }
}

async function runProvider(){
  if(bootstrapOwnsProfile()){publish('AUTH_BOOTSTRAP_ACTIVE',{message:'Flow bootstrap owns the persistent browser profile; provider is paused.'});return}
  if(!acquireLock())return;let db,row=null;
  try{
    if(!fs.existsSync(DB_PATH)){publish('WAITING_FOR_DB',{message:'Runtime database not ready yet.'});return}
    db=dbOpen();ensureSchema(db);ensureProductionPlan(db);reconcileGenerationCreditAccounting(db);ensureBacklog(db);normalizeUnconfirmedPreGenerationRows(db);normalizeReauthorizedReviewerRetries(db);normalizeConsumedReviewerRetries(db);auditRedoState(db);ensureConfirmedGenerationAccounting(db);repairEarthE10NoGeneration(db);repairEarthE11KnownNoCharge(db);repairEarthTodayAfterOperatorConfirmedOnlyFirstRender(db);quarantinePriorDayAmbiguous(db);quarantineStaleReviewerRetryAmbiguous(db);normalizeOutOfOrderAmbiguous(db);normalizeLiveNoChargeCooldown(db);seedTransientCooldownFromRecentNoCharge(db);
    setMeta(db,'automation:provider',PROVIDER);setMeta(db,'automation:paidDependencyDetected','false');setMeta(db,'automation:tinyfishRequired','false');setMeta(db,'automation:tinyfishFallback','disabled');setMeta(db,'automation:freeBrowserProfile',PROFILE_DIR);
    setMeta(db,'automation:serialFlowMode','true');
    setMeta(db,'automation:serialFlowSop','FLOW-SERIAL-GEN-RECOVER-001');
    setMeta(db,'automation:serialHandoffMode','recover-to-review-no-approval-gate');
    setMeta(db,'maintenance:supabasePasskeysLastOutcome','deferred_while_content_worker_active');
    const migrated=await migrateProfileOnce(db);if(!migrated)return;
    const goldenRecovery=await recoverGoldenRunIfRequested(db);
    if(goldenRecovery.needed&&!goldenRecovery.done)return;
    const used=effectiveDailyCount(db);row=productionCandidate(db);
    if(row&&String(row.status)==='generating'){publish('RECOVERY_PICKED',{episode:'E'+row.episode,job_id:row.id,state:String(lifecycle(db,row)?.state||''),used_today:used});await processRow(db,row);return}
    const cooldownUntil=Number(meta(db,'flow:transientCooldownUntil','0'))||0;
    if(row&&cooldownUntil>Date.now()){
      setMeta(db,'flow:state','CONECTADO');
      setMeta(db,'flow:currentStep','transient-cooldown');
      setMeta(db,'flow:message','Google Flow cooldown activo; el mismo episodio serial se reintentará automáticamente.');
      publish('FLOW_TRANSIENT_COOLDOWN',{episode:'E'+row.episode,job_id:row.id,until:new Date(cooldownUntil).toISOString(),message:'Waiting out Google Flow unusual-activity cooldown. No later episode will be attempted.'});
      return;
    }
    const priorityRetry=isReviewerRetry(row);
    if(used>=dailyProductionLimit()&&!priorityRetry){if(row&&String(lifecycle(db,row)?.state||'').toUpperCase()!=='PREFLIGHT_PASSED'){publish('NEXT_DAY_PREFLIGHT',{episode:'E'+row.episode,job_id:row.id,message:'Daily target complete; validating next job without Send.'});await processRow(db,row);return}setMeta(db,'flow:state','ESPERANDO CRÉDITOS');setMeta(db,'flow:currentStep','daily-limit');setMeta(db,'flow:message','Daily production complete: '+used+'/'+dailyProductionLimit()+'.');publish('DAILY_LIMIT',{used,limit:dailyProductionLimit(),day:artDay(),next_episode:row?('E'+row.episode):null});return}
    if(!row){ensureBacklog(db);row=productionCandidate(db);if(!row){
      const waiting=db.prepare("SELECT episode,status,nextTry,error FROM factory_items WHERE status IN ('draft','regen_wait') AND (reviewFeedback IS NULL OR TRIM(reviewFeedback)='') ORDER BY episode LIMIT 1").get();
      setMeta(db,'flow:state','CONECTADO');setMeta(db,'flow:currentStep',waiting&&Number(waiting.nextTry||0)>Date.now()?'serial-backoff':'idle');
      const message=waiting
        ? ('Serial head-of-line E'+waiting.episode+' '+(Number(waiting.nextTry||0)>Date.now()?('waiting until '+new Date(Number(waiting.nextTry)).toISOString()):('status='+waiting.status))+(waiting.error?' error='+compact(waiting.error,180):''))
        : 'No production candidate yet.';
      setMeta(db,'flow:message',message);
      publish(waiting&&Number(waiting.nextTry||0)>Date.now()?'SERIAL_HEAD_WAIT':'IDLE',{episode:waiting?('E'+waiting.episode):null,next_try:waiting?.nextTry||0,message});
      return
    }}
    publish(priorityRetry?'REVIEW_RETRY_PICKED':'PRODUCTION_PICKED',{episode:'E'+row.episode,job_id:row.id,used_today:used,remaining_today:Math.max(0,dailyProductionLimit()-used),daily_limit_bypassed:priorityRetry});await processRow(db,row);
  }catch(err){
    const message=compact(err?.stack||err?.message||err,900);
    try{if(db&&row){const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row,lc=lifecycle(db,fresh)||{},state=String(lc.state||'').toUpperCase(),attempts=Number(fresh.runtimeAttemptCount||0)+1,beforeGenerate=!AFTER_GENERATE.has(state)&&!AMBIGUOUS.has(state),baseBackoff=beforeGenerate?10000:60000,capBackoff=beforeGenerate?5*60*1000:60*60*1000,backoff=Math.min(capBackoff,baseBackoff*Math.pow(2,Math.min(attempts-1,6))),nextTry=Date.now()+backoff;if(/FLOW_TRANSIENT_NO_CHARGE/.test(message)){
  const run=String(lc?.generation_id||fresh.providerRunId||'');
  if(run)try{db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Google Flow transient unusual-activity rejection; explicitly not charged.',updatedAt=? WHERE itemId=? AND runId=?").run(now(),fresh.id,run)}catch{}
  const streakKey='flow:noChargeStreak:'+fresh.id;
  const streak=Math.max(1,(Number(meta(db,streakKey,'0'))||0)+1);
  setMeta(db,streakKey,String(streak));
  const cooldownMinutes=Math.min(60,10*Math.pow(2,Math.min(streak-1,3)));
  const retryAt=Date.now()+cooldownMinutes*60*1000;
  setMeta(db,'flow:transientCooldownUntil',String(retryAt));
  db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),'FLOW_TRANSIENT_NO_CHARGE — automatic retry scheduled after '+cooldownMinutes+'m cooldown.',retryAt,now(),fresh.id);
  setLifecycle(db,fresh,'TRANSIENT_NO_CHARGE_RETRY',{prior_generation_id:run,last_error:message,attempt_count:attempts,no_charge_streak:streak,cooldown_minutes:cooldownMinutes,retry_at:new Date(retryAt).toISOString(),automatic_submit_forbidden:false});
  setMeta(db,'flow:state','ESPERANDO FLOW');
  setMeta(db,'flow:message','Google Flow rechazó temporalmente la generación por actividad inusual sin cobrar puntos. Reintento automático del mismo episodio después del cooldown; no se avanza al siguiente hasta recuperarlo.');
  publish('TRANSIENT_NO_CHARGE_RETRY',{episode:'E'+fresh.episode,job_id:fresh.id,retry_at:new Date(retryAt).toISOString(),streak,cooldown_minutes:cooldownMinutes,message:'Flow explicitly reported no charge. The same episode will retry automatically after a progressive cooldown; this attempt is not counted.'});
}else if(/FLOW_INSUFFICIENT_CREDITS/.test(message)){
  const run=String(lc?.generation_id||fresh.providerRunId||'');
  if(run)db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Flow reported insufficient credits; no retained video.',updatedAt=? WHERE itemId=? AND runId=?").run(now(),fresh.id,run);
  const retryAt=Date.now()+60*60*1000;
  db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),'WAITING_FOR_FLOW_CREDITS',retryAt,now(),fresh.id);
  setLifecycle(db,fresh,'WAITING_FOR_CREDITS',{prior_generation_id:run,last_error:message,attempt_count:attempts,retry_at:new Date(retryAt).toISOString(),automatic_submit_forbidden:false});
  setMeta(db,'flow:state','ESPERANDO CRÉDITOS');
  setMeta(db,'flow:message','Google Flow reported insufficient credits. Production will retry later without counting this as a completed generation.');
}else if(/FLOW_NO_RETAINED_RENDER_AFTER_(?:20M|TRANSIENT_TILE)/.test(message)){
  const run=String(lc?.generation_id||fresh.providerRunId||'');
  const retryAt=Date.now()+60000;
  db.prepare("UPDATE factory_items SET status='generating',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?")
    .run(attempts,now(),'SUBMIT_AMBIGUOUS — result not recovered yet; Generate remains locked.',retryAt,now(),fresh.id);
  setLifecycle(db,fresh,'SUBMIT_AMBIGUOUS',{...lc,generation_id:run||lc?.generation_id||'',reconciled_at:now(),last_error:message,retry_at:new Date(retryAt).toISOString(),automatic_submit_forbidden:true});
  publish('NO_RETAINED_RENDER_LOCKED',{episode:'E'+fresh.episode,job_id:fresh.id,message:'Result not recovered yet. Exactly-once rule keeps Generate locked; recovery will continue without resubmitting the prompt.'});
}else if(/FLOW_GENERATION_FAILED/.test(message)){db.prepare("UPDATE factory_items SET status='failed_after_generate',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=0,updatedAt=? WHERE id=?").run(attempts,now(),message,now(),fresh.id);setLifecycle(db,fresh,'FAILED_AFTER_GENERATE',{last_error:message,attempt_count:attempts})}else if(AFTER_GENERATE.has(state)){db.prepare("UPDATE factory_items SET status='generating',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id);setLifecycle(db,fresh,'RETRIEVAL_PENDING',{...lc,last_error:message,attempt_count:attempts,retry_at:new Date(nextTry).toISOString()})}else if(AMBIGUOUS.has(state)){db.prepare("UPDATE factory_items SET status='generating',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id)}else if(reviewerRetryTokenConsumed(fresh)){
  db.prepare("UPDATE factory_items SET status='manual_hold',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=0,updatedAt=? WHERE id=?").run(attempts,now(),message,now(),fresh.id);
  setLifecycle(db,fresh,'MANUAL_HOLD_CONSUMED_RETRY',{...lc,last_error:message,attempt_count:attempts,automatic_submit_forbidden:true,retry_token:String(fresh.reviewRetryToken||'')});
}else{db.prepare("UPDATE factory_items SET status='draft',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id);setLifecycle(db,fresh,'FAILED_BEFORE_GENERATE',{last_error:message,attempt_count:attempts,retry_at:new Date(nextTry).toISOString()})}}if(db&&!/FLOW_TRANSIENT_NO_CHARGE|FLOW_INSUFFICIENT_CREDITS/.test(message)){setMeta(db,'flow:state',/FLOW_AUTH/.test(message)?'REQUIERE REAUTENTICACIÓN':'ERROR');setMeta(db,'flow:message',message)}}catch{}publish(/FLOW_TRANSIENT_NO_CHARGE/.test(message)?'FLOW_COOLDOWN':'ERROR',{message,episode:row?('E'+row.episode):null});
  }finally{try{db?.close()}catch{}releaseLock()}
}
globalThis.__publisherRunProvider=()=>{void runProvider();};
setTimeout(()=>{void runProvider()},12000);
setInterval(()=>{void runProvider()},20*1000).unref();
