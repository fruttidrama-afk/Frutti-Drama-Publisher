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
  // HARD APPROVAL GATE: an unapproved review render must remain only on the
  // Publisher's private persistent volume. It must never be uploaded to
  // YouTube, Supabase review storage, or any other remote destination.
  flowResult.review_storage='local-volume-until-approval';
  const size=fs.statSync(localPath).size;
  db.prepare(`UPDATE factory_items SET status='review',videoPath=?,remoteUrl=NULL,reviewVideoId=NULL,reviewArchivedAt=NULL,reviewOriginalSize=?,flowResult=?,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?`)
    .run(localPath,size,JSON.stringify(flowResult),stamp,stamp,row.id);
  return null;
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
function dailyProductionLimit(db,day=artDay()){
  const base=Math.max(1,Number(BASE_DAILY_PRODUCTION_LIMIT||1));
  const overrideDay=String(process.env.PUBLISHER_DAILY_LIMIT_OVERRIDE_DAY||'').trim();
  const overrideCount=Math.max(base,Number(process.env.PUBLISHER_DAILY_LIMIT_OVERRIDE_COUNT||0)||0);
  const envTarget=overrideDay===day&&overrideCount>base?overrideCount:base;
  const manualTarget=Math.max(0,Number(meta(db,'automation:manualDailyTarget:'+day,'0'))||0);
  return Math.max(base,envTarget,manualTarget);
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
  seedInitial(db);ensureBacklog(db);setMeta(db,'automation:productionPlanVersion','publisher-runtime-v1');if(!meta(db,'automation:factoryEnabled',''))setMeta(db,'automation:factoryEnabled',String(process.env.PUBLISHER_ENABLED||'false').toLowerCase()==='true'?'true':'false');setMeta(db,'automation:freeFactoryEnabled','1');if(!meta(db,'flow:state',''))setMeta(db,'flow:state','CONECTADO');setMeta(db,'flow:message','Publisher Runtime v1 active; daily target '+dailyProductionLimit(db)+'.');
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
  const content=page.locator('[contenteditable="true"],textarea');
  let best=null,bestScore=-Infinity;
  for(let i=0;i<await content.count().catch(()=>0);i++){
    const el=content.nth(i);
    if(!(await el.isVisible().catch(()=>false)))continue;
    const box=await el.boundingBox().catch(()=>null);
    if(!box||box.y<180||box.width<180)continue;
    const ph=compact((await el.getAttribute('placeholder').catch(()=>''))+' '+(await el.getAttribute('aria-label').catch(()=>'')),180);
    let score=box.width*box.height;
    if(/What do you want to create|Qué quieres crear|Que quieres crear|prompt|create/i.test(ph))score+=500000;
    if(box.y>300)score+=100000;
    if(score>bestScore){bestScore=score;best=el}
  }
  if(best)return best;
  const placeholders=[
    page.getByPlaceholder(/What do you want to create\?/i).last(),
    page.getByPlaceholder(/Qué quieres crear\?/i).last(),
    page.getByPlaceholder(/Que quieres crear\?/i).last()
  ];
  for(const el of placeholders){
    if(await el.count().catch(()=>0)&&await el.isVisible().catch(()=>false))return el;
  }
  throw new Error('FLOW_PROMPT_EDITOR_NOT_FOUND');
}
async function generationSendButton(page,editor=null){
  const host=page.locator('flow-project-page flow-prompt-box flow-generate-icon-button').last();
  if(await host.count().catch(()=>0)&&await host.isVisible().catch(()=>false)){
    const nested=host.locator('button,[role="button"]').last();
    if(await nested.count().catch(()=>0)&&await nested.isVisible().catch(()=>false))return nested;
    const icon=host.locator('mat-icon').last();
    if(await icon.count().catch(()=>0)&&await icon.isVisible().catch(()=>false)){
      const parent=icon.locator('xpath=ancestor::button[1]').first();
      if(await parent.count().catch(()=>0)&&await parent.isVisible().catch(()=>false))return parent;
    }
    return host;
  }
  const named=page.getByRole('button',{name:/Start generation|Iniciar generaci[oó]n/i}).last();
  if(await named.count().catch(()=>0)&&await named.isVisible().catch(()=>false))return named;
  if(editor===null)editor=await promptEditor(page).catch(()=>false);
  const er=editor?await editor.boundingBox().catch(()=>null):null;
  const buttons=page.locator('button,[role="button"]');
  let best=null,bestScore=-Infinity,bestLabel='';
  for(let i=0;i<await buttons.count().catch(()=>0);i++){
    const b=buttons.nth(i);
    if(!(await b.isVisible().catch(()=>false)))continue;
    const box=await b.boundingBox().catch(()=>null);if(!box)continue;
    const label=compact(
      ((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+
      ((await b.getAttribute('title').catch(()=>''))||'')+' '+
      ((await b.innerText().catch(()=>''))||'')+' '+
      ((await b.textContent().catch(()=>''))||''),220
    );
    const n=norm(label);
    const semantic=/start generation|iniciar generaci|generar|generate|arrow forward|arrow_forward|send|enviar/.test(n);
    if(!semantic)continue;
    if(/more options|mas opciones|más opciones|settings|configur|download|descargar|export|help|ayuda|more vert|more_vert/.test(n))continue;
    let score=10000;
    if(er){
      const dy=Math.abs((box.y+box.height/2)-(er.y+er.height/2));
      if(box.x>=er.x+er.width*0.55)score+=3500;
      score-=dy*8;
    }
    if(score>bestScore){bestScore=score;best=b;bestLabel=label}
  }
  if(!best)throw new Error('GENERATION_SEND_BUTTON_NOT_FOUND:'+compact(bestLabel,120));
  return best;
}
async function classifyPromptTarget(page,editor){
  const box=await editor.boundingBox().catch(()=>null);
  const send=await generationSendButton(page,editor).catch(()=>null);
  const sendBox=send?await send.boundingBox().catch(()=>null):null;
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
  if(!liveProject().id)throw new Error('FLOW_PROJECT_NOT_CONFIGURED');
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const url=String(page.url()||'');
    if(/accounts\.google\.com|signin|ServiceLogin/i.test(url))throw new Error('FLOW_AUTH_REQUIRED');
    const text=(await getBody(page)).slice(0,12000);
    if(/verify it'?s you|verifica que eres t[uú]|captcha|security check|verificaci[oó]n de seguridad|email or phone|enter your password/i.test(text))throw new Error('FLOW_AUTH_CHALLENGE');
    if(url.includes(projectPath())){
      try{
        const editor=await promptEditor(page);
        const send=await generationSendButton(page,editor);
        if(await editor.isVisible().catch(()=>false)&&await send.isVisible().catch(()=>false))return editor;
      }catch{}
    }
    await sleep(500);
  }
  const body=compact(await getBody(page).catch(()=>''),2200);
  const title=compact(await page.title().catch(()=>''),300);
  const buttons=[];
  const bl=page.locator('button,[role="button"]');
  for(let i=0;i<Math.min(await bl.count().catch(()=>0),80);i++){
    const b=bl.nth(i);if(!(await b.isVisible().catch(()=>false)))continue;
    const label=compact(((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+((await b.innerText().catch(()=>''))||''),160);
    if(label)buttons.push(label);
  }
  publish('FLOW_READY_DIAGNOSTIC',{url:compact(page.url(),220),title,body,buttons:buttons.slice(0,30)});
  throw new Error('FLOW_NOT_READY:'+compact(page.url(),200)+':title='+title+':body='+compact(body,900));
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

  // Match the browser-launch cadence proven by the working FruttiDrama runtime:
  // fresh local X display/debug port per session and a short Chrome settle period.
  const salt=parseInt(randomUUID().replace(/-/g,'').slice(0,8),16);
  const display=':'+String(100+(salt%400));
  const port=9400+(salt%1000);
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
    await sleep(550);
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
      '--js-flags=--max-old-space-size=160','--window-size=1024,700',
      flowUrl()
    ],{env,stdio:['ignore','ignore','pipe']});
    chrome.stderr?.on('data',d=>{chromeErr=(chromeErr+String(d)).slice(-3600)});

    let cdpReady=false;
    for(let i=0;i<80;i++){
      await sleep(250);
      if(chrome.exitCode!==null)break;
      try{
        const r=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(900)});
        if(r.ok){cdpReady=true;break}
      }catch{}
    }
    if(!cdpReady)throw new Error('CHROME_CDP_NOT_READY:exit='+String(chrome.exitCode)+':stderr='+compact(chromeErr,900)+':xvfb='+compact(xvfbErr,400));

    await sleep(3000);
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:15000});
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
  const direct=page.getByRole('button',{name:/Settings trigger|Settings|Generation settings|Video settings|Configuraci[oó]n|Ajustes/i}).last();
  if(await direct.count().catch(()=>0)&&await direct.isVisible().catch(()=>false))return direct;
  const buttons=page.locator('button,[role="button"]');
  let best=null,bestScore=-Infinity,bestDesc='';
  for(let i=0;i<await buttons.count().catch(()=>0);i++){
    const b=buttons.nth(i);
    if(!(await b.isVisible().catch(()=>false)))continue;
    const box=await b.boundingBox().catch(()=>null);if(!box)continue;
    const desc=compact(
      ((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+
      ((await b.getAttribute('title').catch(()=>''))||'')+' '+
      ((await b.innerText().catch(()=>''))||'')+' '+
      ((await b.textContent().catch(()=>''))||''),320
    );
    const n=norm(desc);
    if(/start generation|generate|generar|arrow forward|arrow_forward|add ingredient|clear prompt|download|descargar|share|compartir/.test(n))continue;
    let score=0;
    if(/setting|configur|ajuste/.test(n))score+=8;
    if(/video/.test(n))score+=5;
    if(/720p/.test(n))score+=4;
    if(/crop 9 16|9 16/.test(n))score+=4;
    if(/\bx1\b/.test(n))score+=3;
    if(/\b(?:8|10)\s*s\b/.test(n))score+=2;
    if(box.y>300)score+=1;
    if(score>bestScore){bestScore=score;best=b;bestDesc=desc}
  }
  if(best&&bestScore>=5)return best;
  throw new Error('FLOW_SETTINGS_BUTTON_NOT_FOUND:'+compact(bestDesc,260));
}
async function ensureSettingsOpen(page){
  const visibleSetting=async()=>{
    const video=page.getByRole('radio',{name:/Video/i}).last();
    if(await video.count().catch(()=>0)&&await video.isVisible().catch(()=>false))return true;
    const candidates=page.getByText(/^(?:9:16|720p|8\s*s|10\s*s|x1)$/i);
    for(let i=(await candidates.count().catch(()=>0))-1;i>=0;i--){
      if(await candidates.nth(i).isVisible().catch(()=>false))return true;
    }
    return false;
  };
  if(await visibleSetting())return;
  const b=await settingsButton(page);
  await trustedClick(b);
  const deadline=Date.now()+6500;
  while(Date.now()<deadline){if(await visibleSetting())return;await sleep(180)}
  throw new Error('FLOW_SETTINGS_MENU_NOT_OPEN:'+compact(await b.innerText().catch(()=>''),220));
}
async function clickRadio(page,re,label){
  const radios=page.getByRole('radio',{name:re});
  for(let i=(await radios.count().catch(()=>0))-1;i>=0;i--){
    const r=radios.nth(i);if(!(await r.isVisible().catch(()=>false)))continue;
    const checked=await r.getAttribute('aria-checked').catch(()=>null);
    if(checked!=='true')await trustedClick(r);
    await sleep(300);
    const after=await r.getAttribute('aria-checked').catch(()=>null);
    if(after==='true'||after===null)return true;
  }
  for(const role of ['button','option','menuitem','tab']){
    const loc=page.getByRole(role,{name:re});
    for(let i=(await loc.count().catch(()=>0))-1;i>=0;i--){
      const el=loc.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
      await trustedClick(el);await sleep(320);return true;
    }
  }
  const exact=page.getByText(re);
  for(let i=(await exact.count().catch(()=>0))-1;i>=0;i--){
    const el=exact.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    await clickInteractive(el);await sleep(320);return true;
  }
  throw new Error('FLOW_SETTING_NOT_FOUND:'+label+':'+compact(await getBody(page),900));
}
async function clickOptionalSetting(page,re,label){
  try{await clickRadio(page,re,label);return true}
  catch(e){
    if(String(e?.message||e).startsWith('FLOW_SETTING_NOT_FOUND:'+label+':'))return false;
    throw e;
  }
}
async function configureFlow(page){
  await waitFlowReady(page,60000);
  await ensureSettingsOpen(page);
  await clickRadio(page,/Video/i,'Video');
  await clickRadio(page,/9\s*:\s*16|9_16|crop_9_16/i,'9:16');

  let modelButton=null,currentModel='';
  const buttons=page.locator('button,[role="button"]');
  let modelScore=-Infinity;
  for(let i=0;i<await buttons.count().catch(()=>0);i++){
    const b=buttons.nth(i);if(!(await b.isVisible().catch(()=>false)))continue;
    const txt=compact(
      ((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+
      ((await b.getAttribute('title').catch(()=>''))||'')+' '+
      ((await b.innerText().catch(()=>''))||'')+' '+
      ((await b.textContent().catch(()=>''))||''),240
    );
    const n=norm(txt);
    let score=0;
    if(/select model family|model|modelo/.test(n))score+=6;
    if(/omni/.test(n))score+=6;
    if(/flash/.test(n))score+=3;
    if(/veo/.test(n))score+=2;
    if(/settings|configur|720p|9 16|x1/.test(n))score-=3;
    if(score>modelScore){modelScore=score;modelButton=b;currentModel=txt}
  }
  const modelOk=/omni\s*1\.1\s*flash/i.test(currentModel)||(/omni/i.test(currentModel)&&/flash/i.test(currentModel));
  if(modelButton&&modelScore>=4&&!modelOk){
    await trustedClick(modelButton);await sleep(400);
    let chosen=null;
    for(const role of ['menuitem','option','radio','button']){
      const loc=page.getByRole(role);
      for(let i=(await loc.count().catch(()=>0))-1;i>=0;i--){
        const o=loc.nth(i);if(!(await o.isVisible().catch(()=>false)))continue;
        const txt=compact(((await o.getAttribute('aria-label').catch(()=>''))||'')+' '+((await o.innerText().catch(()=>''))||'')+' '+((await o.textContent().catch(()=>''))||''),180);
        if(/omni\s*1\.1\s*flash/i.test(txt)||(/omni/i.test(txt)&&/flash/i.test(txt))){chosen=o;currentModel=txt;break}
      }
      if(chosen)break;
    }
    if(!chosen)throw new Error('FLOW_MODEL_OMNI_FLASH_NOT_FOUND:'+compact(await getBody(page),900));
    await trustedClick(chosen);await sleep(450);
  }else if(!modelOk){
    const body=compact(await getBody(page),4500);
    if(!(/omni/i.test(body)&&/flash/i.test(body)))throw new Error('FLOW_MODEL_OMNI_FLASH_NOT_VERIFIED:'+body.slice(0,900));
    currentModel='Omni 1.1 Flash';
  }

  // Current Flow/Omni UI may not expose resolution or duration controls.
  // Treat those as model defaults when absent; ratio/model/output-count remain hard gates.
  const resolutionApplied=await clickOptionalSetting(page,/720p/i,'720p');
  const durationApplied=await clickOptionalSetting(page,/^10\s*s$/i,'10s');
  await clickRadio(page,/^x?\s*1$/i,'x1');

  let label='';
  try{label=compact(await(await settingsButton(page)).innerText(),300)}catch{}
  const save=page.getByRole('button',{name:/^(Save|Guardar)$/i}).last();
  if(await save.count().catch(()=>0)&&await save.isVisible().catch(()=>false)){await trustedClick(save);await sleep(450)}
  const close=page.getByRole('button',{name:/^close$|close settings|cerrar/i}).last();
  if(await close.count().catch(()=>0)&&await close.isVisible().catch(()=>false)){await trustedClick(close);await sleep(300)}
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(350);

  let summary=label;
  try{summary=compact(await(await settingsButton(page)).innerText(),340)||summary}catch{}
  const body=compact(await getBody(page),5000);
  const combined=summary+' '+body;
  if(!/video/i.test(combined)||!/(?:9\s*:\s*16|9_16|crop_9_16)/i.test(combined)||!(/\bx1\b/i.test(combined)||/\bx\s*1\b/i.test(combined))){
    throw new Error('FLOW_SETTINGS_NOT_CONFIRMED:'+compact(summary||body,700));
  }
  const applied={label:summary||'settings-applied',mode:'Video',ratio:'9:16',model:'Omni 1.1 Flash',resolution:resolutionApplied?'720p':'model-default',duration:durationApplied?'10s':'prompt/model-default',count:'x1',ingredients:false};
  publish('FLOW_SETTINGS_APPLIED',{message:JSON.stringify(applied)});
  return applied;
}

async function ingredientCount(page){
  return await page.locator('[aria-label="Ingredient"]').count().catch(()=>0);
}
async function clearComposer(page){
  await waitFlowReady(page,30000);
  const clear=page.getByRole('button',{name:/Clear prompt|Limpiar prompt|Borrar prompt|Limpiar indicaci[oó]n/i}).last();
  if(await clear.count().catch(()=>0)&&await clear.isVisible().catch(()=>false)){
    await trustedClick(clear).catch(()=>{});
    await sleep(500);
  }
  const editor=await promptEditor(page);
  await editor.fill('').catch(async()=>{await editor.click();await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');});
  await sleep(250);
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){
    if(await ingredientCount(page)===0)return true;
    const remove=page.locator('[aria-label="Ingredient"],[aria-label="Ingrediente"]');
    if(await remove.count().catch(()=>0)){
      const chip=remove.last();
      const removeButton=chip.getByRole('button',{name:/remove|delete|quitar|eliminar|cerrar|close/i}).last();
      if(await removeButton.count().catch(()=>0)&&await removeButton.isVisible().catch(()=>false))await trustedClick(removeButton).catch(()=>{});
      else await chip.click().catch(()=>{});
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
  // Composer stability invariant: waitFlowReady already resolves the live
  // generation editor. Do not immediately re-query it; Flow can remount the
  // contenteditable node after settings changes and create a transient race.
  let editor=await waitFlowReady(page,30000);
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

  try{
    await editor.fill(payload);
  }catch{
    // If Flow remounted the composer between readiness and fill, reacquire it
    // through the same readiness gate instead of a naked promptEditor query.
    editor=await waitFlowReady(page,30000);
    await editor.fill(payload);
  }
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
async function findGenerationConsentAction(page){
  const buttons=page.locator('button,[role="button"],[role="option"],[tabindex="0"]');
  const ranked=[];
  for(let i=0;i<Math.min(await buttons.count().catch(()=>0),220);i++){
    const b=buttons.nth(i);
    if(!(await b.isVisible().catch(()=>false))||!(await b.isEnabled().catch(()=>false)))continue;
    const box=await b.boundingBox().catch(()=>null);if(!box)continue;
    const label=compact(
      ((await b.innerText().catch(()=>''))||'')+' '+
      ((await b.textContent().catch(()=>''))||'')+' '+
      ((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+
      ((await b.getAttribute('title').catch(()=>''))||''),220
    );
    const n=norm(label);
    if(!/^(si|sí|yes|generar|generate|confirmar|confirm|continuar|continue|aprobar|approve)(\b|\s|,|\.)/.test(n)&&
       !/(si|sí|yes).*(generar|generate)|(generar|generate).*(video|15|puntos|points|creditos|credits)/.test(n))continue;
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
    const generationContext=/(generar|generate|generation|video)/.test(cn);
    const costContext=/(15\s*(puntos|points|creditos|credits)|cuesta|cost|usar.*puntos|use.*points|consumir.*puntos|consume.*points)/.test(cn);
    if(!generationContext||!costContext)continue;
    let score=0;
    if(/generar|generate/.test(n))score+=12;
    if(/^(si|sí|yes)\b/.test(n))score+=10;
    if(/confirm|aprobar|approve/.test(n))score+=8;
    if(/15\s*(puntos|points|creditos|credits)/.test(cn))score+=8;
    score+=Math.min(5,box.y/180);
    ranked.push({el:b,label,context:compact(context,900),score,box});
  }
  ranked.sort((a,b)=>b.score-a.score||b.box.y-a.box.y);
  return ranked[0]||null;
}
async function clickSubmitExactlyOnce(page){
  const send=await generationSendButton(page,false);
  if(!(await send.isVisible().catch(()=>false))||!(await send.isEnabled().catch(()=>false)))throw new Error('START_GENERATION_BUTTON_NOT_READY');
  await trustedClick(send);
  publish('SUBMIT_ARROW_CLICKED',{message:'Flow generation send control clicked exactly once.',control:compact(((await send.getAttribute('aria-label').catch(()=>''))||'')+' '+((await send.innerText().catch(()=>''))||''),140)});

  const deadline=Date.now()+9000;
  while(Date.now()<deadline){
    const action=await findGenerationConsentAction(page);
    if(action){
      await trustedClick(action.el);
      publish('POINT_CONSENT_CLICKED',{label:compact(action.label,140),context:compact(action.context,500),message:'Flow point-cost confirmation accepted exactly once.'});
      await sleep(700);
      return'confirmation-point-cost';
    }

    const dialogs=page.getByRole('dialog');
    for(let d=(await dialogs.count().catch(()=>0))-1;d>=0;d--){
      const dialog=dialogs.nth(d);
      if(!(await dialog.isVisible().catch(()=>false)))continue;
      const gen=dialog.getByRole('button',{name:/^(Generate|Generar|Confirm|Confirmar)$/i}).last();
      if(await gen.count().catch(()=>0)&&await gen.isVisible().catch(()=>false)&&await gen.isEnabled().catch(()=>false)){
        await trustedClick(gen);
        publish('POINT_CONSENT_CLICKED',{label:compact(await gen.innerText().catch(()=>''),120),message:'Flow generation confirmation accepted exactly once.'});
        await sleep(700);
        return'confirmation-dialog';
      }
    }
    await sleep(200);
  }

  const visibleButtons=[];
  const bs=page.locator('button,[role="button"]');
  for(let i=0;i<Math.min(await bs.count().catch(()=>0),80);i++){
    const b=bs.nth(i);if(!(await b.isVisible().catch(()=>false)))continue;
    const label=compact(((await b.getAttribute('aria-label').catch(()=>''))||'')+' '+((await b.innerText().catch(()=>''))||''),160);
    if(label)visibleButtons.push(label);
  }
  publish('POST_ARROW_NO_CONSENT',{message:'No point-cost confirmation was detected after the generation arrow.',body:compact(await getBody(page),1600),buttons:visibleButtons.slice(-30)});
  return'start-generation-direct';
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
      return{tile_count:tiles.length,ordered_signatures:sigs.slice(0,120),signatures:[...new Set(sigs)].slice(0,120),busy:/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation/i.test(body)};
    });
  }catch{return{tile_count:0,ordered_signatures:[],signatures:[],busy:false}}
}

function inventoryHasNew(current,baseline){
  if(!baseline)return false;
  if(Number(current?.tile_count||0)>Number(baseline?.tile_count||0))return true;
  const before=new Set(Array.isArray(baseline?.signatures)?baseline.signatures:[]);
  return (Array.isArray(current?.signatures)?current.signatures:[]).some(x=>!before.has(x));
}

async function reconcileAmbiguousGeneric(page,row,lc,db){
  const baselineInv=lc?.baseline_inventory||null;
  const boundary=Date.parse(String(lc?.submit_boundary_at||''));
  const age=Number.isFinite(boundary)?Date.now()-boundary:0;
  const currentInv=await captureFlowInventory(page);
  const body=(await getBody(page)).slice(0,14000);
  const busy=currentInv.busy||/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation/i.test(body);
  const baselineUsable=Boolean(baselineInv&&Number(baselineInv.tile_count||0)>0&&Array.isArray(baselineInv.signatures)&&baselineInv.signatures.length>0);
  const fresh=baselineUsable&&inventoryHasNew(currentInv,baselineInv);

  // A persisted Flow result is stronger evidence than an unusable/virtualized
  // baseline. Correlate the rendered tile to this episode before keeping the
  // job indefinitely in SUBMIT_AMBIGUOUS.
  if(!busy&&age>=20000){
    const correlated=await openEpisodeCorrelatedResult(page,row).catch(()=>null);
    if(correlated?.found){
      const startedAt=String(lc?.generation_started_at||lc?.submit_boundary_at||now());
      const next=setLifecycle(db,row,'GENERATION_STARTED',{...lc,generation_started_at:startedAt,evidence:'ambiguous-reconciled-by-'+correlated.signal,matched_label:correlated.label,matched_terms:correlated.matched,reconciled_at:now(),automatic_submit_forbidden:true});
      db.prepare("UPDATE factory_items SET status='generating',error=NULL,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
      const runId=String(next.generation_id||row.providerRunId||'');
      if(runId){
        const exists=Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE itemId=? AND runId=?").get(row.id,runId)?.n||0);
        if(!exists)try{db.prepare("INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)").run(randomUUID(),row.id,artDay(new Date(startedAt)),sha(String(row.promptHash||'')+':'+runId),CREDITS_PER_GENERATION,'running',runId,startedAt,now(),'automatic')}catch{}
      }
      publish('AMBIGUOUS_CORRELATED_RENDER',{episode:'T'+row.season+'E'+row.episode,job_id:row.id,label:correlated.label,matched:correlated.matched,signal:correlated.signal});
      return{mode:'retrieve',lifecycle:next};
    }
    publish('AMBIGUOUS_CORRELATION_DIAGNOSTIC',{episode:'T'+row.season+'E'+row.episode,job_id:row.id,terms:episodeRecoveryTerms(row),samples:(currentInv?.ordered_signatures||currentInv?.signatures||[]).slice(0,18)});
  }

  if(fresh||busy){
    const startedAt=String(lc?.generation_started_at||now());
    const next=setLifecycle(db,row,'GENERATION_STARTED',{...lc,generation_started_at:startedAt,evidence:`ambiguous-reconciled:fresh=${fresh};busy=${busy};tiles=${baselineInv?.tile_count||0}->${currentInv.tile_count}`,reconciled_at:now()});
    db.prepare("UPDATE factory_items SET status='generating',error=NULL,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
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
        db.prepare("UPDATE factory_items SET status='manual_hold',providerRunId=NULL,error=?,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(
          'Rehacer enviado pero Flow no confirmó resultado. El token quedó consumido y NO se reenviará automáticamente; se requiere un nuevo Rehacer humano.',
          now(),now(),row.id
        );
        setLifecycle(db,row,'MANUAL_HOLD_SUBMIT_NOT_CONFIRMED',{
          ...lc,
          reconciled_at:now(),
          evidence:`No new Flow result after ${Math.round(age/1000)}s; inventory unchanged at ${currentInv.tile_count} tiles.`,
          automatic_submit_forbidden:true,
          reviewer_retry:true,
          retry_token:String(row.reviewRetryToken||'')
        });
        publish('REVIEW_RETRY_NOT_CONFIRMED_HOLD',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'Reviewer retry token is consumed. Flow showed no result; automatic resubmit is forbidden until a new human Rehacer request.'});
        return{mode:'wait'};
      }
      const retryAt=Date.now()+60000;
      db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?").run(retryAt,now(),now(),row.id);
      setLifecycle(db,row,'RECONCILED_NO_GENERATION',{prior_generation_id:String(lc?.generation_id||row.providerRunId||''),submit_boundary_at:String(lc?.submit_boundary_at||''),reconciled_at:now(),evidence:`No new Flow result after ${Math.round(age/1000)}s; inventory unchanged at ${currentInv.tile_count} tiles.`,retry_at:new Date(retryAt).toISOString()});
      publish('AMBIGUOUS_RECONCILED_NO_GENERATION',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'Flow inventory unchanged; automatic episode generation may retry after backoff.'});
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
  const baseSrc=new Set((baseline||[]).map(v=>v.src).filter(Boolean));
  const beforeInv=baselineInventory||{signatures:[],tile_count:0};
  const startedAt=Date.now(),deadline=startedAt+timeout;
  let lastEvidence='';
  while(Date.now()<deadline){
    await renderAuthGuard(page);
    const bodyText=await getBody(page).catch(()=>'');
    if(/unusual activity|actividad inusual/i.test(bodyText)&&/not been charged|no (?:se )?te (?:ha )?cobrado|no se (?:te )?cobr[oó]/i.test(bodyText)){
      return{started:false,evidence:'FLOW_TRANSIENT_NO_CHARGE: Flow explicitly reported that the attempt was not charged.'};
    }
    const vids=await currentVideos(page);
    const freshVideo=vids.some(v=>v.src&&!baseSrc.has(v.src)&&Number(v.duration||0)>0);
    const inv=await captureFlowInventory(page);
    const send=await generationSendButton(page,false).catch(()=>null);
    const sendVisible=send?await send.isVisible().catch(()=>false):false;
    const sendDisabled=send?await send.isDisabled().catch(()=>false):true;
    const visibleBusy=await visibleGenerationBusyCount(page);
    const busyIncrease=visibleBusy>Number(baselineBusy||0);
    const elapsed=Date.now()-startedAt;

    let downloadableFresh=false,downloadSignal='';
    if(Number(beforeInv?.tile_count||0)>0&&elapsed>2500&&elapsed%5000<1100){
      const probe=await openUniqueFreshInventoryResult(page,beforeInv).catch(()=>null);
      downloadableFresh=Boolean(probe?.ready);
      downloadSignal=String(probe?.signal||'');
      if(probe?.opened&&!probe?.ready)await page.keyboard.press('Escape').catch(()=>{});
    }

    const started=freshVideo||busyIncrease||downloadableFresh;
    lastEvidence='freshVideo='+freshVideo+'; busy='+visibleBusy+'; baselineBusy='+baselineBusy+'; busyIncrease='+busyIncrease+'; downloadableFresh='+downloadableFresh+'; downloadSignal='+downloadSignal+'; sendVisible='+sendVisible+'; sendDisabled='+sendDisabled+'; elapsedMs='+elapsed+'; tiles='+Number(beforeInv.tile_count||0)+'->'+Number(inv.tile_count||0);
    if(started)return{started:true,evidence:lastEvidence,videos:vids,inventory:inv};
    await sleep(1000);
  }
  return{started:false,evidence:'No hard Flow generation evidence appeared. '+lastEvidence};
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
    const manualSubmit=envEnabled&&meta(db,'automation:allowSubmit','0')==='1',runtimeEnabled=meta(db,'automation:factoryEnabled','false')==='true',autoSubmit=envEnabled&&runtimeEnabled&&meta(db,'automation:freeFactoryEnabled','0')==='1'&&(reviewerRetry||effectiveDailyCount(db)<dailyProductionLimit(db)),submitAuthorized=manualSubmit||autoSubmit;
    publish('PREFLIGHT',{episode:'E'+row.episode,job_id:row.id});
    const pf=await preflight(page,row,cp);
    db.prepare('UPDATE factory_items SET transportPreflight=?,error=NULL,updatedAt=? WHERE id=?').run(JSON.stringify(pf).slice(0,20000),now(),row.id);
    setLifecycle(db,row,'PREFLIGHT_PASSED',{preflight_at:now(),settings:pf.settings,characters:cp.visual,prompt_hash:cp.hash,prepared_state_verified:Boolean(pf.prepared_state_verified)});
    if(!submitAuthorized){const used=effectiveDailyCount(db);setMeta(db,'flow:state',used>=dailyProductionLimit(db)?'ESPERANDO CRÉDITOS':'CONECTADO');setMeta(db,'flow:currentStep',used>=dailyProductionLimit(db)?'daily-limit':'preflight:passed-no-submit');publish(used>=dailyProductionLimit(db)?'DAILY_LIMIT':'PREFLIGHT_READY_NO_SUBMIT',{episode:'E'+row.episode,job_id:row.id,characters:cp.visual,settings:pf.settings});return false}
    if(manualSubmit)setMeta(db,'automation:allowSubmit','0');
    // Match FruttiDrama exactly here: preflight already verified the prompt bytes,
    // target composer and project identity. Re-querying the editor after Flow
    // commits the prompt can fail because Flow swaps the contenteditable node.
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
    const started=await waitGenerationStarted(page,baseline,baselineInventory,baselineBusy,90000);
    if(!started.started){
      const bodyAfter=await getBody(page).catch(()=>'');
      const explicitNoCharge=/unusual activity|actividad inusual/i.test(bodyAfter)&&/not been charged|no (?:se )?te (?:ha )?cobrado|no se (?:te )?cobr[oó]/i.test(bodyAfter);
      if(explicitNoCharge){
        scheduleNoChargeRetry(db,row,{run:genId,submitMode,evidence:started.evidence,reason:'Flow UI reported unusual activity and explicitly confirmed no charge.'});
        return false;
      }
      const retryAt=Date.now()+30000;
      setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{generation_id:genId,submit_mode:submitMode,consent_mode:consentMode,baseline,baseline_inventory:baselineInventory,evidence:started.evidence,last_error:'No hard Flow generation evidence after submit. Read-only reconciliation required before any new Generate.',retry_at:new Date(retryAt).toISOString(),automatic_submit_forbidden:true});
      db.prepare("UPDATE factory_items SET status='generating',error=?,nextTry=?,updatedAt=? WHERE id=?").run('SUBMIT_AMBIGUOUS — reconciliation pending; Generate is locked.',retryAt,now(),row.id);
      publish('SUBMIT_AMBIGUOUS',{episode:'E'+row.episode,job_id:row.id,message:'Submit boundary crossed without hard start evidence. Reconcile only; do not click Generate again.'});
      return false
    }
    resetNoChargeBackoff(db,row);
    const startedAt=now();lc=setLifecycle(db,row,'GENERATION_STARTED',{generation_id:genId,generation_started_at:startedAt,submit_mode:submitMode,consent_mode:consentMode,baseline,baseline_inventory:baselineInventory,evidence:started.evidence,automatic_submit_forbidden:true});
    try{db.prepare("INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)").run(randomUUID(),row.id,artDay(new Date(startedAt)),sha(cp.hash+':'+genId),CREDITS_PER_GENERATION,'running',genId,startedAt,startedAt,reviewerRetry?'review_retry':'automatic')}catch{}
    setMeta(db,'flow:lastSuccessfulGenerationAt',startedAt);publish('FLOW_RENDER_CONFIRMED',{episode:'E'+row.episode,job_id:row.id,generation_id:genId,evidence:started.evidence});return await retrieveExisting(page,row,cp,lc,db);
  }finally{await session.close().catch(()=>{})}
}
function reconcileAmbiguousNoGeneration(){return false;}
function serialReady(db,row){
  if(!row)return false;
  if(!CONFIG.content.serialized||Number(row.episode)<=1)return true;
  const gate=CONFIG.content.continuity_gate;
  if(gate==='none')return true;
  const prev=db.prepare('SELECT status,videoPath,remoteUrl,reviewVideoId,flowResult FROM factory_items WHERE episode=? LIMIT 1').get(Number(row.episode)-1);
  if(!prev)return false;
  // Same handoff used by FruttiDrama: recovery is the gate, human Review is not.
  // As soon as E(n) is safely recovered and can be shown in Review, E(n+1) may
  // generate. Approval/rejection can happen later and never blocks today's batch.
  if(['review','queued','historical','published'].includes(String(prev.status||'')))return true;
  const fr=json(prev.flowResult,{});
  return Boolean(prev.videoPath||prev.remoteUrl||prev.reviewVideoId||fr?.validated_ftyp);
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
function noChargeDelayMs(streak){
  // Global Publisher rule for Google Flow "Unusual activity" + "not charged":
  // 1st alert 30m, 2nd 1h, 3rd 2h, 4th 4h, 5th 8h.
  // The next mathematical doubling would be 16h, which crosses the operator's
  // 10-hour ceiling, so from the 6th consecutive alert onward wait a full 24h.
  if(streak<=1)return 30*60*1000;
  if(streak===2)return 60*60*1000;
  if(streak===3)return 2*60*60*1000;
  if(streak===4)return 4*60*60*1000;
  if(streak===5)return 8*60*60*1000;
  return 24*60*60*1000;
}
function resetFlowTransientCaches(db,row){
  const key='flow:transientCacheResetV1:'+row.id;
  if(meta(db,key,'')==='done')return false;
  const dirs=[
    path.join(PROFILE_DIR,'Default','Cache'),
    path.join(PROFILE_DIR,'Default','Code Cache'),
    path.join(PROFILE_DIR,'Default','GPUCache'),
    path.join(PROFILE_DIR,'Default','Service Worker','CacheStorage'),
    path.join(PROFILE_DIR,'Default','Service Worker','ScriptCache'),
    path.join(PROFILE_DIR,'GrShaderCache'),
    path.join(PROFILE_DIR,'GraphiteDawnCache'),
    path.join(PROFILE_DIR,'ShaderCache')
  ];
  let removed=0;
  for(const dir of dirs){
    try{if(fs.existsSync(dir)){fs.rmSync(dir,{recursive:true,force:true});removed++}}catch{}
  }
  setMeta(db,key,'done');
  publish('FLOW_TRANSIENT_CACHE_RESET',{episode:'E'+row.episode,job_id:row.id,removed_paths:removed,message:'Persistent Flow unusual-activity state detected. Non-cookie browser caches were cleared once; Google login cookies and the authenticated account were preserved.'});
  return true;
}
function scheduleNoChargeRetry(db,row,opts={}){
  const fresh=db.prepare("SELECT * FROM factory_items WHERE id=?").get(row.id)||row;
  const run=String(opts.run||lifecycle(db,fresh)?.generation_id||fresh.providerRunId||'');
  if(run)try{db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Google Flow explicitly reported no retained generation and no charge.',updatedAt=? WHERE itemId=? AND runId=?").run(now(),fresh.id,run)}catch{}

  // IMPORTANT: Unusual Activity belongs to the Google/Flow provider account,
  // not to an episode. The streak and cooldown are therefore provider-wide.
  const providerStreakKey='flow:noChargeStreak:provider';
  const streak=Math.max(0,Number(meta(db,providerStreakKey,'0'))||0)+1;
  setMeta(db,providerStreakKey,String(streak));
  // Keep a row counter only for diagnostics; it never controls retry timing.
  setMeta(db,'flow:noChargeStreak:'+fresh.id,String(Math.max(0,Number(meta(db,'flow:noChargeStreak:'+fresh.id,'0'))||0)+1));

  if(streak>=4)resetFlowTransientCaches(db,fresh);
  const delay=noChargeDelayMs(streak);
  const requestedRetryAt=Date.now()+delay;
  const existingUntil=Number(meta(db,'flow:transientCooldownUntil','0'))||0;
  // Provider cooldown is monotonic until a hard generation start resets it.
  // A stale/older row may NEVER shorten a newer cooldown.
  const retryAt=Math.max(existingUntil,requestedRetryAt);
  const overnight=streak>=6;
  setMeta(db,'flow:transientCooldownUntil',String(retryAt));

  db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=?,nextTry=?,runtimeAttemptCount=runtimeAttemptCount+1,lastProgressAt=?,updatedAt=? WHERE id=?")
    .run(overnight?'FLOW_UNUSUAL_ACTIVITY_OVERNIGHT — same episode preserved; next automatic retry after 24h.':'FLOW_NO_CHARGE — exponential provider backoff active; same episode remains head-of-line.',retryAt,now(),now(),fresh.id);
  setLifecycle(db,fresh,overnight?'UNUSUAL_ACTIVITY_OVERNIGHT':'TRANSIENT_NO_CHARGE_RETRY',{
    prior_generation_id:run,
    submit_mode:String(opts.submitMode||''),
    evidence:String(opts.evidence||opts.reason||''),
    provider_no_charge_streak:streak,
    retry_at:new Date(retryAt).toISOString(),
    provider_cooldown_until:new Date(retryAt).toISOString(),
    automatic_submit_forbidden:false,
    protective_overnight_wait:overnight
  });
  setMeta(db,'flow:state',overnight?'PAUSA PROTECTORA':'CONECTADO');
  setMeta(db,'flow:message',overnight
    ?'Google Flow rechazó repetidamente por actividad inusual. El proveedor completo queda en espera 24h; E'+fresh.episode+' sigue pendiente.'
    :'Google Flow rechazó sin cargo. Backoff global del proveedor activo: 30m → 1h → 2h → 4h → 8h → 24h.');
  publish(overnight?'FLOW_UNUSUAL_ACTIVITY_OVERNIGHT':'TRANSIENT_NO_CHARGE_RETRY',{
    episode:'E'+fresh.episode,
    job_id:fresh.id,
    retry_at:new Date(retryAt).toISOString(),
    provider_no_charge_streak:streak,
    cooldown_minutes:Math.round((retryAt-Date.now())/60000),
    message:overnight
      ?'Provider-wide unusual-activity streak crossed the 10h ceiling. No episode or REDO may submit for 24h.'
      :'Provider-wide unusual-activity backoff is active. No episode or REDO may bypass it.'
  });
  return retryAt;
}
function resetNoChargeBackoff(db,row){
  // Reset only after hard generation-start evidence.
  setMeta(db,'flow:noChargeStreak:provider','0');
  if(row)setMeta(db,'flow:noChargeStreak:'+row.id,'0');
  setMeta(db,'flow:transientCooldownUntil','0');
}
function normalizeLiveNoChargeCooldown(db){
  try{
    const rows=db.prepare("SELECT * FROM factory_items WHERE status='draft' AND (error LIKE 'FLOW%NO_CHARGE%' OR error LIKE 'FLOW_UNUSUAL_ACTIVITY_%') ORDER BY episode").all();

    // One-time migration from the old per-episode streak model. Use the largest
    // existing streak as a conservative floor; never sum historical rows.
    let providerStreak=Math.max(0,Number(meta(db,'flow:noChargeStreak:provider','0'))||0);
    if(providerStreak<1){
      try{
        const legacy=db.prepare("SELECT key,value FROM factory_meta WHERE key LIKE 'flow:noChargeStreak:%' AND key<>'flow:noChargeStreak:provider'").all();
        providerStreak=Math.max(0,...legacy.map(x=>Number(x.value)||0));
        if(providerStreak>0)setMeta(db,'flow:noChargeStreak:provider',String(providerStreak));
      }catch{}
    }
    if(providerStreak<1||!rows.length)return;

    const currentUntil=Number(meta(db,'flow:transientCooldownUntil','0'))||0;
    let desiredUntil=currentUntil;
    for(const row of rows){
      if(providerStreak>=4)resetFlowTransientCaches(db,row);
      const base=Date.parse(String(row.lastProgressAt||row.updatedAt||''))||Date.now();
      desiredUntil=Math.max(desiredUntil,base+noChargeDelayMs(providerStreak),Number(row.nextTry||0));
    }
    // Critical invariant: normalization may extend but NEVER shorten provider cooldown.
    setMeta(db,'flow:transientCooldownUntil',String(desiredUntil));

    for(const row of rows){
      if(Number(row.nextTry||0)<desiredUntil){
        db.prepare("UPDATE factory_items SET nextTry=?,error=?,updatedAt=? WHERE id=?").run(
          desiredUntil,
          providerStreak>=6?'FLOW_UNUSUAL_ACTIVITY_OVERNIGHT — provider-wide wait; next automatic retry after 24h.':'FLOW_NO_CHARGE — provider-wide exponential backoff active.',
          now(),row.id
        );
      }
    }
    setMeta(db,'flow:state',providerStreak>=6?'PAUSA PROTECTORA':'CONECTADO');
    setMeta(db,'flow:message','Unusual Activity global: streak '+providerStreak+'; ningún episodio puede enviar hasta '+new Date(desiredUntil).toISOString()+'.');

    const onceKey='flow:providerWideBackoffV3:'+providerStreak+':'+desiredUntil;
    if(meta(db,onceKey,'')!=='done'){
      publish('FLOW_PROVIDER_WIDE_BACKOFF_NORMALIZED',{
        provider_no_charge_streak:providerStreak,
        until:new Date(desiredUntil).toISOString(),
        cooldown_minutes:Math.max(0,Math.round((desiredUntil-Date.now())/60000)),
        blocked_rows:rows.map(r=>'E'+r.episode).slice(0,30),
        message:'Provider-wide cooldown is monotonic. Older rows cannot shorten it and no other episode may submit during the wait.'
      });
      setMeta(db,onceKey,'done');
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

  // An explicit Google no-charge/unusual-activity response is provider-wide.
  // Never let another draft or REDO bypass the cooldown and hammer the same Flow account.
  const providerCooldown=Number(meta(db,'flow:transientCooldownUntil','0'))||0;
  if(providerCooldown>Date.now())return null;

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
    db=dbOpen();ensureSchema(db);ensureProductionPlan(db);reconcileGenerationCreditAccounting(db);ensureBacklog(db);normalizeUnconfirmedPreGenerationRows(db);normalizeReauthorizedReviewerRetries(db);normalizeConsumedReviewerRetries(db);auditRedoState(db);ensureConfirmedGenerationAccounting(db);quarantinePriorDayAmbiguous(db);quarantineStaleReviewerRetryAmbiguous(db);normalizeOutOfOrderAmbiguous(db);normalizeLiveNoChargeCooldown(db);
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
    const priorityRetry=isReviewerRetry(row);
    if(used>=dailyProductionLimit(db)&&!priorityRetry){if(row&&String(lifecycle(db,row)?.state||'').toUpperCase()!=='PREFLIGHT_PASSED'){publish('NEXT_DAY_PREFLIGHT',{episode:'E'+row.episode,job_id:row.id,message:'Daily target complete; validating next job without Send.'});await processRow(db,row);return}setMeta(db,'flow:state','ESPERANDO CRÉDITOS');setMeta(db,'flow:currentStep','daily-limit');setMeta(db,'flow:message','Daily production complete: '+used+'/'+dailyProductionLimit(db)+'.');publish('DAILY_LIMIT',{used,limit:dailyProductionLimit(db),day:artDay(),next_episode:row?('E'+row.episode):null});return}
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
    publish(priorityRetry?'REVIEW_RETRY_PICKED':'PRODUCTION_PICKED',{episode:'E'+row.episode,job_id:row.id,used_today:used,remaining_today:Math.max(0,dailyProductionLimit(db)-used),daily_limit_bypassed:priorityRetry});await processRow(db,row);
  }catch(err){
    const message=compact(err?.stack||err?.message||err,900);
    try{if(db&&row){const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row,lc=lifecycle(db,fresh)||{},state=String(lc.state||'').toUpperCase(),attempts=Number(fresh.runtimeAttemptCount||0)+1,beforeGenerate=!AFTER_GENERATE.has(state)&&!AMBIGUOUS.has(state),baseBackoff=beforeGenerate?10000:60000,capBackoff=beforeGenerate?5*60*1000:60*60*1000,backoff=Math.min(capBackoff,baseBackoff*Math.pow(2,Math.min(attempts-1,6))),nextTry=Date.now()+backoff;if(/FLOW_TRANSIENT_NO_CHARGE/.test(message)){
  const run=String(lc?.generation_id||fresh.providerRunId||'');
  scheduleNoChargeRetry(db,fresh,{run,evidence:message,reason:'exception-no-charge'});
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

async function recoverApprovedPublicationMedia(){
  const raw=String(process.env.PUBLISHER_RECOVER_APPROVED_FLOW_JSON||'').trim();
  if(!raw)return;
  let spec={};try{spec=JSON.parse(raw)||{}}catch(e){publish('APPROVED_MEDIA_RECOVERY_CONFIG_ERROR',{message:compact(e?.message||e,400)});return}
  const targets=Object.entries(spec).map(([episode,v])=>({
    episode:Number(episode),
    signature:String(v?.signature||'').trim(),
    expectedSize:Number(v?.expectedSize||0)
  })).filter(x=>Number.isInteger(x.episode)&&x.episode>0);
  if(!targets.length)return;
  const recoveryKey='operator:approved-flow-recovery:'+sha(raw).slice(0,20);
  let db=null,session=null;
  if(!acquireLock()){publish('APPROVED_MEDIA_RECOVERY_WAIT',{message:'Flow browser is busy; approved-media recovery will retry later.'});return}
  try{
    db=dbOpen();
    if(meta(db,recoveryKey,'')==='done')return;
    const pending=[];
    for(const t of targets){
      const item=db.prepare("SELECT * FROM publication_items WHERE episode=? AND status NOT IN ('published','cancelled','deleted') ORDER BY createdAt DESC LIMIT 1").get(t.episode);
      const row=item?db.prepare("SELECT * FROM factory_items WHERE id=?").get(item.itemId):null;
      if(!item||!row)continue;
      if(item.filePath&&((String(item.filePath).startsWith('supabase://'))||fs.existsSync(String(item.filePath))))continue;
      const expectedSize=Number(item.fileSize||t.expectedSize||0);
      if(!expectedSize)continue;
      pending.push({...t,item,row,expectedSize});
    }
    if(!pending.length){setMeta(db,recoveryKey,'done');return}

    session=await launchLocal();
    const page=session.page||session.context.pages()[0]||await session.context.newPage();
    await ensureExpectedFlowProject(page);
    if(!String(page.url()).includes(projectPath()))await page.goto(flowUrl(),{waitUntil:'domcontentloaded',timeout:60000});
    await waitFlowReady(page,60000);
    await renderAuthGuard(page);

    const publicationDir=path.join(FACTORY_DIR,'publication');
    const recoveryDir=path.join(FACTORY_DIR,'approved-flow-recovery');
    fs.mkdirSync(publicationDir,{recursive:true,mode:0o700});
    fs.mkdirSync(recoveryDir,{recursive:true,mode:0o700});
    const usedSignatures=new Set();

    const scanCandidates=async(target)=>{
      const tiles=page.locator('flow-grid-tile-container').filter({has:page.locator('flow-video-tile')});
      const candidates=[];
      const count=Math.min(await tiles.count().catch(()=>0),120);
      const wanted=norm(target.signature);
      for(let i=0;i<count;i++){
        const tile=tiles.nth(i);if(!(await tile.isVisible().catch(()=>false)))continue;
        const sig=compact(
          String(await tile.getAttribute('aria-label').catch(()=>'')||'')+' '+
          String(await tile.innerText().catch(()=>'')||'')+' '+
          String(await tile.textContent().catch(()=>'')||''),500
        );
        const n=norm(sig);
        candidates.push({i,sig,score:wanted&&n.includes(wanted)?1000:0});
      }
      candidates.sort((a,b)=>b.score-a.score||a.i-b.i);
      // Approved-media recovery is intentionally conservative. Never scan or
      // accept an unrelated Flow tile merely because its byte size happens to
      // match. The configured signature must correlate the tile first.
      return wanted?candidates.filter(x=>x.score>0):[];

    };

    for(const target of pending){
      let recovered=false;
      const candidates=await scanCandidates(target);
      for(const cand of candidates){
        const dedupeKey=target.episode+':'+cand.i+':'+cand.sig;
        if(usedSignatures.has(dedupeKey))continue;
        const tiles=page.locator('flow-grid-tile-container').filter({has:page.locator('flow-video-tile')});
        const tile=tiles.nth(cand.i);
        if(!(await tile.isVisible().catch(()=>false)))continue;
        await tile.scrollIntoViewIfNeeded().catch(()=>{});
        await tile.hover().catch(()=>{});
        const footer=tile.locator('flow-tile-hover-footer').first();
        if(await footer.count().catch(()=>0)&&await footer.isVisible().catch(()=>false))await footer.click({force:true,timeout:5000}).catch(()=>{});
        else await tile.click({force:true,timeout:5000}).catch(()=>{});
        await sleep(1000);
        if(!(await visibleDownloadButton(page).catch(()=>null))){await page.keyboard.press('Escape').catch(()=>{});continue}
        const tmp=path.join(recoveryDir,'e'+target.episode+'-'+randomUUID()+'.mp4');
        try{
          let dl=await downloadResult(page,{uiReady:true,signal:'approved-media-size-recovery'},tmp);
          let valid=validateMp4(tmp),matchedPath=tmp;
          publish('APPROVED_MEDIA_RECOVERY_CANDIDATE',{episode:'E'+target.episode,signature:compact(cand.sig,180),size:valid.size,expected_size:target.expectedSize,download_method:dl.method});
          if(Number(valid.size)!==Number(target.expectedSize)){
            // Historical approved items were often saved as Flow's 1080p
            // Upscaled asset. If the native 720p bytes do not match, retry the
            // SAME correlated tile at the preferred quality; never move to an
            // unrelated tile.
            const preferred=path.join(recoveryDir,'e'+target.episode+'-'+randomUUID()+'-preferred.mp4');
            const p=await immediateDownloadChoice(page,preferred,{preferWanted:true});
            if(p.ok){
              const pv=validateMp4(preferred);
              publish('APPROVED_MEDIA_RECOVERY_PREFERRED_CANDIDATE',{episode:'E'+target.episode,signature:compact(cand.sig,180),size:pv.size,expected_size:target.expectedSize,download_method:p.method});
              if(Number(pv.size)===Number(target.expectedSize)){try{fs.rmSync(tmp,{force:true})}catch{};matchedPath=preferred;valid=pv;dl=p}
              else try{fs.rmSync(preferred,{force:true})}catch{}
            }else publish('APPROVED_MEDIA_RECOVERY_PREFERRED_WAIT',{episode:'E'+target.episode,signature:compact(cand.sig,160),reason:String(p.reason||'preferred-quality-unavailable')});
          }
          if(Number(valid.size)!==Number(target.expectedSize)){try{fs.rmSync(tmp,{force:true})}catch{};if(matchedPath!==tmp)try{fs.rmSync(matchedPath,{force:true})}catch{};await page.keyboard.press('Escape').catch(()=>{});continue}
          const dest=path.join(publicationDir,target.item.id+'.mp4');
          fs.copyFileSync(matchedPath,dest);try{fs.rmSync(matchedPath,{force:true})}catch{}
          let history=[];try{history=JSON.parse(String(target.item.history||'[]'))||[]}catch{}
          history.push({status:'queued',at:now(),message:'Exact approved media recovered from its existing Google Flow asset after the private YouTube staging copy was lost. No new generation was created.'});
          db.prepare(`UPDATE publication_items SET status='queued',filePath=?,fileSize=?,videoId=NULL,resumableSession=NULL,attempts=0,retryAt=0,error=NULL,history=?,updatedAt=?,aiDisclosureSyncedAt=NULL,remotePrivacyStatus=NULL,remotePublishAt=NULL,remoteStatusCheckedAt=NULL WHERE id=?`)
            .run(dest,valid.size,JSON.stringify(history.slice(-120)),now(),target.item.id);
          usedSignatures.add(dedupeKey);recovered=true;
          publish('APPROVED_MEDIA_RECOVERED',{episode:'E'+target.episode,publication_id:target.item.id,signature:compact(cand.sig,180),size:valid.size,expected_size:target.expectedSize,scheduled_at:target.item.scheduledAt});
          await page.keyboard.press('Escape').catch(()=>{});
          break;
        }catch(e){
          try{fs.rmSync(tmp,{force:true})}catch{}
          publish('APPROVED_MEDIA_RECOVERY_CANDIDATE_ERROR',{episode:'E'+target.episode,signature:compact(cand.sig,160),message:compact(e?.message||e,500)});
          await page.keyboard.press('Escape').catch(()=>{});
        }
      }
      if(!recovered)publish('APPROVED_MEDIA_RECOVERY_NOT_FOUND',{episode:'E'+target.episode,expected_size:target.expectedSize,signature:target.signature});
    }
    const left=targets.filter(t=>{
      const item=db.prepare("SELECT filePath FROM publication_items WHERE episode=? AND status NOT IN ('published','cancelled','deleted') ORDER BY createdAt DESC LIMIT 1").get(t.episode);
      return !item?.filePath;
    });
    if(!left.length)setMeta(db,recoveryKey,'done');
  }catch(e){
    publish('APPROVED_MEDIA_RECOVERY_ERROR',{message:compact(e?.stack||e?.message||e,900)});
  }finally{
    try{await session?.close()}catch{}
    try{db?.close()}catch{}
    releaseLock();
  }
}
setTimeout(()=>{void recoverApprovedPublicationMedia()},5000).unref?.();
setInterval(()=>{void recoverApprovedPublicationMedia()},10*60*1000).unref?.();

globalThis.__publisherRunProvider=()=>{void runProvider();};
setTimeout(()=>{void runProvider()},12000);
setInterval(()=>{void runProvider()},20*1000).unref();
