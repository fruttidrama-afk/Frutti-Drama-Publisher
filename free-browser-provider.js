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
  resolveVisualCharacters, buildPrompt, seedInitial, ensureBacklog
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
  const currentUrl=String(page.url()||'');
  const m=currentUrl.match(/\/project\/([a-zA-Z0-9-]+)/);
  if(m){
    const title=await visibleTopProjectTitle(page);
    if(title===expected){
      persistResolvedProject(m[1],expected);
      publish('FLOW_PROJECT_VERIFIED',{project_name:expected,project_id:m[1],message:'Exact expected Flow project verified.'});
      return{id:m[1],url:'https://flow.google.com/project/'+m[1],name:expected};
    }
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
  const chosen=matches[0];
  const href=chosen.href;
  if(!href)throw new Error('FLOW_EXPECTED_PROJECT_LINK_MISSING:'+expected);
  const absolute=href.startsWith('http')?href:'https://flow.google.com'+href;
  await page.goto(absolute,{waitUntil:'domcontentloaded',timeout:60000});
  await sleep(1600);
  const url=String(page.url()||''),mm=url.match(/\/project\/([a-zA-Z0-9-]+)/);
  if(!mm)throw new Error('FLOW_EXPECTED_PROJECT_NAVIGATION_FAILED:'+expected);
  const title=await visibleTopProjectTitle(page);
  if(title!==expected)throw new Error('FLOW_EXPECTED_PROJECT_TITLE_MISMATCH:'+compact(title,120));
  persistResolvedProject(mm[1],expected);
  publish('FLOW_PROJECT_RESOLVED',{project_name:expected,project_id:mm[1],message:'Resolved exact Flow project from project grid by name.'});
  return{id:mm[1],url:'https://flow.google.com/project/'+mm[1],name:expected};
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
      if(String(row.status||'')==='draft'&&Number(row.nextTry||0)<=Date.now())continue;
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
  const value = { ...previous, state, provider:PROVIDER, updated_at:progressAt, ...extra };
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
  console.log('[FREE BROWSER]', state, logDetail);
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
function preparePromptIfNeeded(db,row){
  let cp=checkpoint(row);if(cp)return cp;const visual=matchingCharacters(row),prompt=buildLocalPrompt(db,row,visual),hash=sha(prompt),r=registry(),roles=visual.map(name=>({name,role:'ON_SCREEN',visual:true})),handles=visual.map(name=>r.characters.find(c=>String(c.name)===String(name))?.mention||('@'+name));
  db.prepare("UPDATE factory_items SET prompt=?,promptHash=?,promptGenerationId=?,characterHandles=?,characterRoles=?,promptPayloadHash=?,promptPayloadLength=?,status='draft',providerRunId=NULL,error=NULL,nextTry=0,updatedAt=? WHERE id=?").run(prompt,hash,'runtime-prompt-v1-'+randomUUID(),JSON.stringify(handles),JSON.stringify(roles),hash,Buffer.byteLength(prompt,'utf8'),now(),row.id);
  cp=checkpoint(db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id));if(!cp)throw new Error('RUNTIME_PROMPT_CHECKPOINT_FAILED');return cp;
}

function reviewMetadata(row,flowResult={}){
  const provider=(CONFIG.publication?.providers||[]).find(x=>x.type==='youtube')||{};
  const terms=Array.isArray(flowResult?.matched_terms)?flowResult.matched_terms:[];
  const copy=buildPublicationCopy({
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
    const m=reviewMetadata(row,flowResult);
    db.prepare('UPDATE factory_items SET title=?,description=?,updatedAt=? WHERE id=?').run(m.title,m.description,now(),row.id);
    publish('REVIEW_METADATA_READY',{episode:'E'+row.episode,job_id:row.id,title:m.title});
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
  const send=page.getByRole('button',{name:/Start generation/i}).last();
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
  if(!String(page.url()||'').includes(projectPath()))throw new Error('WRONG_FLOW_PROJECT');const inputs=page.locator('input[aria-label="Editable text"]');let titleInput=null,current='';
  for(let i=0;i<await inputs.count().catch(()=>0);i++){const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const b=await el.boundingBox().catch(()=>null);if(!b||b.y>100)continue;titleInput=el;current=String(await el.inputValue().catch(()=>''));break}if(!titleInput)throw new Error('PROJECT_TITLE_CONTROL_NOT_FOUND');if(current.trim()===projectName())return{repaired:false,previous:projectName()};
  const corrupt=current.length>180||/PRODUCTION PROMPT|GENERATION PROMPT|VIDEO FACTORY|PUBLISHER RUNTIME|DURATION \/ FORMAT|ANTI-GLITCH/i.test(current);if(!corrupt)throw new Error('PROJECT_TITLE_UNEXPECTED_VALUE:'+compact(current,120));const previous=compact(current,180);await titleInput.fill(projectName());await titleInput.press('Enter').catch(()=>{});await page.keyboard.press('Tab').catch(()=>{});
  const deadline=Date.now()+7000;while(Date.now()<deadline){const value=String(await titleInput.inputValue().catch(()=>''));if(value.trim()===projectName()){publish('PROJECT_TITLE_REPAIRED',{message:'Flow project title restored to configured publisher project.'});return{repaired:true,previous}}await sleep(250)}throw new Error('PROJECT_TITLE_REPAIR_NOT_CONFIRMED');
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
  if(!liveProject().id||!String(page.url()||'').includes(projectPath()))throw new Error('WRONG_FLOW_PROJECT');const inputs=page.locator('input[aria-label="Editable text"]');let titleInput=null,titleValue='';
  for(let i=0;i<await inputs.count().catch(()=>0);i++){const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const b=await el.boundingBox().catch(()=>null);if(!b||b.y>100)continue;titleInput=el;titleValue=String(await el.inputValue().catch(()=>'')).trim();break}
  if(!titleInput)throw new Error('PROJECT_TITLE_CONTROL_NOT_FOUND');const prefix=compact(payload,120);if(titleValue!==projectName())throw new Error('PROJECT_TITLE_NOT_CONFIGURED:'+compact(titleValue,120));if(prefix&&titleValue.includes(prefix))throw new Error('PROJECT_TITLE_CONTAMINATED_WITH_PROMPT');
  return{project:projectName(),project_id:liveProject().id,title_verified:true,source:'exact-project-title-input',document_title_observed:compact(await page.title().catch(()=>''),300)};
}
async function waitFlowReady(page,timeout=60000){
  if(!liveProject().id)throw new Error('FLOW_PROJECT_NOT_CONFIGURED');const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const url=String(page.url()||'');if(/accounts\.google\.com|signin|ServiceLogin/i.test(url))throw new Error('FLOW_AUTH_REQUIRED');const text=(await getBody(page)).slice(0,12000);if(/verify it'?s you|captcha|security check|email or phone|enter your password/i.test(text))throw new Error('FLOW_AUTH_CHALLENGE');if(url.includes(projectPath())){try{const editor=await promptEditor(page),send=page.getByRole('button',{name:/Start generation/i}).last();if(await editor.isVisible().catch(()=>false)&&await send.isVisible().catch(()=>false))return editor}catch{}}await sleep(500)}throw new Error('FLOW_NOT_READY:'+compact(page.url(),200));
}
function cleanChromiumLocks() {
  for (const name of ['SingletonLock','SingletonSocket','SingletonCookie']) try { fs.unlinkSync(path.join(PROFILE_DIR,name)); } catch {}
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
async function stopProfileChrome(){
  for(const pid of profileChromePids()){try{process.kill(pid,'SIGTERM');}catch{}}
  if(profileChromePids().length)await sleep(900);
  for(const pid of profileChromePids()){try{process.kill(pid,'SIGKILL');}catch{}}
  cleanChromiumLocks();
}
async function launchLocal() {
  if(!fs.existsSync(path.join(PROFILE_DIR,'Default','Cookies')))throw new Error('GFLOW_AUTH_PROFILE_MISSING');
  await stopProfileChrome();
  cleanChromiumLocks();

  const salt=parseInt(randomUUID().replace(/-/g,'').slice(0,8),16);
  const display=':'+String(100+(salt%400));
  const port=9400+(salt%1000);
  const xvfb=spawn('Xvfb',[display,'-screen','0','1024x700x24','-nolisten','tcp','-ac'],{stdio:['ignore','ignore','pipe']});
  let xvfbErr='';xvfb.stderr?.on('data',d=>{xvfbErr=(xvfbErr+String(d)).slice(-1600);});
  await sleep(550);
  if(xvfb.exitCode!==null)throw new Error('XVFB_START_FAILED:'+compact(xvfbErr,500));

  const env={...process.env,DISPLAY:display};
  const chrome=spawn('/usr/bin/google-chrome-stable',[
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
  let chromeErr='';chrome.stderr?.on('data',d=>{chromeErr=(chromeErr+String(d)).slice(-3000);});

  let cdpReady=false;
  for(let i=0;i<80;i++){
    await sleep(250);
    if(chrome.exitCode!==null)break;
    try{
      const r=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(900)});
      if(r.ok){cdpReady=true;break;}
    }catch{}
  }
  if(!cdpReady){
    const exit=chrome.exitCode;
    try{chrome.kill('SIGTERM');}catch{};try{xvfb.kill('SIGTERM');}catch{};
    await sleep(250);
    throw new Error('CHROME_CDP_NOT_READY:exit='+String(exit)+':stderr='+compact(chromeErr,700)+':xvfb='+compact(xvfbErr,300));
  }

  await sleep(3000);
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:15000});
  const context=browser.contexts()[0];
  if(!context)throw new Error('CHROME_CDP_CONTEXT_MISSING');
  const pages=context.pages();
  const page=[...pages].reverse().find(p=>String(p.url()).includes('flow.google.com'))||pages[0]||await context.newPage();
  const close=async()=>{
    try{await browser.close();}catch{}
    try{chrome.kill('SIGTERM');}catch{}
    await sleep(450);
    try{xvfb.kill('SIGTERM');}catch{}
    await stopProfileChrome().catch(()=>{});
  };
  return {browser,context,page,close};
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
    if(!/approve|aprobar|15\s*points|15\s*puntos/.test(n))continue;
    const isNew=i>=Number(before?.count||0)||box.y>Number(before?.maxY??-1)+8;
    if(isNew)candidates.push({el,i,box,text,n});
  }
  candidates.sort((a,b)=>b.box.y-a.box.y||b.i-a.i);
  return candidates[0]||null;
}
async function visibleGenerationBusyCount(page){
  const busy=page.locator('text=/Generating|Processing|Rendering|Creating video|Generando|Procesando|Starting generation|Initiating|Creando video|Preparando video/i');
  let n=0;
  for(let i=0;i<Math.min(await busy.count().catch(()=>0),80);i++)if(await busy.nth(i).isVisible().catch(()=>false))n++;
  return n;
}
async function generationTransitionVisible(page,baselineInventory,baselineVideos,baselineBusy=0){
  const inv=await captureFlowInventory(page);
  const vids=await currentVideos(page);
  const baseSrc=new Set((baselineVideos||[]).map(v=>v.src).filter(Boolean));
  const freshVideo=vids.some(v=>v.src&&!baseSrc.has(v.src));
  const freshInventory=inventoryHasNew(inv,baselineInventory);
  const send=page.getByRole('button',{name:/Start generation|Iniciar generación/i}).last();
  const sendVisible=await send.isVisible().catch(()=>false);
  const sendDisabled=await send.isDisabled().catch(()=>false);
  const visibleBusy=await visibleGenerationBusyCount(page);
  const controlTransition=(!sendVisible||sendDisabled)&&visibleBusy>Number(baselineBusy||0);
  return{started:Boolean(freshVideo||freshInventory||controlTransition),freshVideo,freshInventory,controlTransition,visibleBusy,sendVisible,sendDisabled,inventory:inv,videos:vids};
}
async function approveFlowPointConsent(page,permission,baselineInventory,baselineVideos,baselineBusy=0){
  if(!permission)return{approved:false,mode:null,label:null};
  const labels=[['Aprobar siempre','approve-always'],['Always approve','approve-always'],['Approve always','approve-always'],['Aprobar','approve-once'],['Approve','approve-once']];
  for(const [label,mode] of labels){
    const exact=permission.el.getByText(new RegExp('^'+escapeRe(label)+'$','i'));
    for(let i=(await exact.count().catch(()=>0))-1;i>=0;i--){
      const hit=exact.nth(i);
      if(!(await hit.isVisible().catch(()=>false)))continue;
      await hit.scrollIntoViewIfNeeded().catch(()=>{});
      await hit.click({force:true,timeout:5000});
      const deadline=Date.now()+8000;
      while(Date.now()<deadline){
        await sleep(250);
        const stillVisible=await hit.isVisible().catch(()=>false);
        const transition=await generationTransitionVisible(page,baselineInventory,baselineVideos,baselineBusy);
        if(!stillVisible||transition.started){
          publish('POINT_CONSENT_CONFIRMED',{message:label+' accepted; controlGone='+(!stillVisible)+' transition='+JSON.stringify({freshVideo:transition.freshVideo,freshInventory:transition.freshInventory,busy:transition.busy,sendVisible:transition.sendVisible,sendDisabled:transition.sendDisabled})});
          return{approved:true,mode,label};
        }
      }
      publish('POINT_CONSENT_NOT_ACCEPTED',{message:label+' remained actionable and no generation transition followed.'});
      throw new Error('FLOW_CONSENT_CLICK_NOT_ACCEPTED:'+label);
    }
  }
  throw new Error('FLOW_PERMISSION_MESSAGE_WITHOUT_APPROVAL_CONTROL:'+compact(permission.text,300));
}
async function clickSubmitExactlyOnce(page,baselineInventory,baselineVideos,baselineBusy=0){
  const permissionBefore=await permissionSnapshot(page);

  // Muestra 3 exact path: refocus the prompt top row, then click the arrow icon
  // inside flow-generate-icon-button. Do not use a generic button guess here.
  const promptTop=page.locator('flow-project-page flow-prompt-box div.prompt-top-row').last();
  if(await promptTop.count().catch(()=>0)&&await promptTop.isVisible().catch(()=>false)){
    await promptTop.click({position:{x:Math.max(5,Math.min(40,(await promptTop.boundingBox().catch(()=>({width:80}))).width-5)),y:8}}).catch(()=>{});
    await sleep(180);
  }

  let arrow=page.locator('flow-project-page flow-prompt-box flow-generate-icon-button mat-icon').last();
  if(!(await arrow.count().catch(()=>0))||!(await arrow.isVisible().catch(()=>false))){
    arrow=page.getByRole('img',{name:/Iniciar generación|Start generation/i}).last();
  }
  if(!(await arrow.count().catch(()=>0))||!(await arrow.isVisible().catch(()=>false)))throw new Error('FLOW_GENERATE_ARROW_NOT_FOUND');

  const box=await arrow.boundingBox().catch(()=>null);
  if(!box)throw new Error('FLOW_GENERATE_ARROW_NO_BOX');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down(); await sleep(80); await page.mouse.up();
  publish('SUBMIT_ARROW_CLICKED',{message:'Recorder-exact flow-generate-icon-button mat-icon / arrow_forward'});

  // Consent is optional because "Always approve" may already be persisted.
  // Only handle a permission message that appears after this exact click.
  const consentDeadline=Date.now()+4500;
  while(Date.now()<consentDeadline){
    await sleep(250);
    const permission=await newPermissionMessage(page,permissionBefore);
    if(permission){
      const consent=await approveFlowPointConsent(page,permission,baselineInventory,baselineVideos,baselineBusy);
      return'composer-arrow-'+consent.mode;
    }
  }

  publish('POST_ARROW_NO_CONSENT',{message:'No new permission message appeared after recorder-exact arrow click.'});
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
async function reconcileAmbiguousGeneric(page,row,lc,db){
  const baselineInv=lc?.baseline_inventory||null;
  const boundary=Date.parse(String(lc?.submit_boundary_at||''));
  const age=Number.isFinite(boundary)?Date.now()-boundary:0;
  const currentInv=await captureFlowInventory(page);
  const body=(await getBody(page)).slice(0,14000);
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
        db.prepare("UPDATE factory_items SET status='manual_hold',providerRunId=NULL,error=?,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(
          'REDO was submitted but Flow did not confirm a result. Token stays consumed; automatic resubmit is forbidden.',
          now(),now(),row.id
        );
        setLifecycle(db,row,'MANUAL_HOLD_SUBMIT_NOT_CONFIRMED',{...lc,reconciled_at:now(),automatic_submit_forbidden:true,reviewer_retry:true,retry_token:String(row.reviewRetryToken||'')});
        publish('REVIEW_RETRY_NOT_CONFIRMED_HOLD',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'REDO token consumed; no automatic second Generate.'});
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
  let lastEvidence='';
  while(Date.now()<deadline){
    await renderAuthGuard(page);
    const vids=await currentVideos(page);
    const freshVideo=vids.some(v=>v.src&&!baseSrc.has(v.src)&&Number(v.duration||0)>0);
    const inv=await captureFlowInventory(page);
    const newVideoTile=Number(inv.video_tile_count||0)>baseVideoTiles;
    const elapsed=Date.now()-startedAt;
    lastEvidence=`freshPlayableVideo=${freshVideo}; videoTiles=${baseVideoTiles}->${inv.video_tile_count||0}; allTiles=${baselineInventory?.tile_count||0}->${inv.tile_count||0}; elapsedMs=${elapsed}`;
    if(freshVideo||newVideoTile){
      return{started:true,evidence:lastEvidence,videos:vids,inventory:inv,render_complete:true};
    }
    await sleep(1200);
  }
  return{started:false,evidence:'No real rendered video appeared after the submit boundary. '+lastEvidence};
}
function firstFreshRendered(vids,baseline){
  const baseSrc=new Set((baseline||[]).map(v=>v.src).filter(Boolean));
  const fresh=(vids||[]).filter(v=>v.readyState>=2&&v.duration>0&&v.src&&!baseSrc.has(v.src));
  return fresh.length===1?fresh[0]:null;
}
async function visibleDownloadButton(page){
  const named=page.getByRole('button',{name:/Download|Export|Descargar/i});
  for(let i=(await named.count())-1;i>=0;i--){
    const c=named.nth(i);
    if(await c.isVisible().catch(()=>false))return c;
  }
  const buttons=page.locator('button,[role="button"]');
  for(let i=(await buttons.count())-1;i>=0;i--){
    const c=buttons.nth(i);
    if(!(await c.isVisible().catch(()=>false)))continue;
    const txt=compact((await c.innerText().catch(()=>''))+' '+(await c.getAttribute('aria-label').catch(()=>''))+' '+(await c.getAttribute('title').catch(()=>'')),180);
    if(/download|export|descargar|file_download/i.test(txt))return c;
  }
  return null;
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
async function downloadResult(page,rendered,localPath){
  if(rendered?.i>=0){
    const v=page.locator('video').nth(rendered.i);if(await v.isVisible().catch(()=>false))await v.click({position:{x:10,y:10}}).catch(()=>{});
    let trigger=await visibleDownloadButton(page);
    if(trigger){
      await trigger.click();await sleep(500);
      const wanted=CONFIG.generation.download_quality||'1080p Upscaled',opt=page.getByText(new RegExp(escapeRe(wanted),'i')).last();
      if(await opt.count().catch(()=>0)&&await opt.isVisible().catch(()=>false)){const p=page.waitForEvent('download',{timeout:15*60*1000});await opt.click();const dl=await p;await dl.saveAs(localPath);return{method:wanted}}
      const menuItems=page.locator('flow-menu-item'),visibleItems=[];
      for(let i=0;i<Math.min(await menuItems.count().catch(()=>0),20);i++){const it=menuItems.nth(i);if(await it.isVisible().catch(()=>false))visibleItems.push(it);}
      if(visibleItems.length>=3){const p=page.waitForEvent('download',{timeout:15*60*1000});await visibleItems[2].click({force:true,timeout:5000});const dl=await p;await dl.saveAs(localPath);return{method:'recorder-menu-item-3-fallback'}}
      await page.keyboard.press('Escape').catch(()=>{});
    }
    if(rendered.src&&/^https?:/i.test(rendered.src)){const r=await page.context().request.get(rendered.src,{timeout:90000});if(r.ok()){fs.writeFileSync(localPath,await r.body(),{mode:0o600});return{method:'direct-video-url'}}}
    throw new Error('FRESH_VIDEO_DOWNLOAD_FAILED_NO_GENERIC_FALLBACK');
  }
  if(!rendered?.uiReady)throw new Error('DOWNLOAD_WITHOUT_UNIQUE_FRESH_EVIDENCE');
  let trigger=await visibleDownloadButton(page);
  if(!trigger)throw new Error('UNIQUE_FRESH_TILE_DOWNLOAD_CONTROL_MISSING');
  await trigger.click();await sleep(500);
  const wanted=CONFIG.generation.download_quality||'1080p Upscaled',opt=page.getByText(new RegExp(escapeRe(wanted),'i')).last();
  if(await opt.count().catch(()=>0)&&await opt.isVisible().catch(()=>false)){
    const p=page.waitForEvent('download',{timeout:15*60*1000});await opt.click();const dl=await p;await dl.saveAs(localPath);return{method:wanted};
  }
  const menuItems=page.locator('flow-menu-item');
  const visibleItems=[];
  for(let i=0;i<Math.min(await menuItems.count().catch(()=>0),20);i++){const it=menuItems.nth(i);if(await it.isVisible().catch(()=>false))visibleItems.push(it);}
  if(visibleItems.length>=3){
    const p=page.waitForEvent('download',{timeout:15*60*1000});
    await visibleItems[2].click({force:true,timeout:5000});
    const dl=await p;await dl.saveAs(localPath);
    return{method:'recorder-menu-item-3-fallback'};
  }
  throw new Error('UNIQUE_FRESH_TILE_DOWNLOAD_OPTION_MISSING');
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
    db.prepare(`UPDATE factory_items SET status='review',videoPath=?,providerRunId=NULL,flowResult=?,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?`).run(localPath,JSON.stringify(flowResult),recoveredAt,recoveredAt,row.id);
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

async function retrieveExisting(page,row,cp,lc,db){setLifecycle(db,row,'RETRIEVING',{generation_id:lc?.generation_id||row.providerRunId||'',baseline:lc?.baseline||[],baseline_inventory:lc?.baseline_inventory||null});const baseline=Array.isArray(lc?.baseline)?lc.baseline:[],baselineInventory=lc?.baseline_inventory||null,deadline=Date.now()+15*60*1000;let rendered=null,lastVideos=[],uiSignal=null,lastHeartbeat=0;while(Date.now()<deadline){await renderAuthGuard(page);if(Date.now()-lastHeartbeat>10000){lastHeartbeat=Date.now();try{db.prepare('UPDATE factory_items SET lastProgressAt=?,updatedAt=? WHERE id=?').run(now(),now(),row.id);}catch{}}lastVideos=await currentVideos(page);rendered=firstFreshRendered(lastVideos,baseline);if(rendered)break;const text=await getBody(page);if(/failed to generate|generation failed|couldn't generate|no se pudo generar/i.test(text))throw new Error('FLOW_GENERATION_FAILED');const stillBusy=/generating|processing|rendering|creating video|generando|procesando|upscaling/i.test(text);if(baselineInventory){uiSignal=await openUniqueFreshInventoryResult(page,baselineInventory);if(Date.now()-lastHeartbeat<2500||!uiSignal?.ready)publish('RETRIEVAL_PROGRESS',{episode:'E'+row.episode,job_id:row.id,signal:uiSignal?.signal||'none',stillBusy,videos:lastVideos.length});if(uiSignal?.ready){rendered={uiReady:true,signal:uiSignal.signal};break;}}await sleep(2500);}if(!rendered)throw new Error(`RENDER_TIMEOUT:videos=${lastVideos.length}:ui=${uiSignal?.signal||'none'}`);const localPath=path.join(VIDEO_DIR,`${row.id}.mp4`);try{fs.unlinkSync(localPath);}catch{}const dl=await downloadResult(page,rendered,localPath),valid=validateMp4(localPath),flowResult={provider:PROVIDER,generation_id:lc?.generation_id||row.providerRunId||'',generation_started_at:lc?.generation_started_at||'',duration:valid.duration,width:valid.width,height:valid.height,size:valid.size,codec:valid.codec,validated_ftyp:true,download_quality:dl.method||CONFIG.generation.download_quality||'downloaded asset',retrieved_at:now()};persistReviewMetadata(db,row,flowResult);db.prepare(`UPDATE factory_items SET status='review',videoPath=?,flowResult=?,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?`).run(localPath,JSON.stringify(flowResult),now(),now(),row.id);try{db.prepare(`UPDATE factory_generations SET status='review',updatedAt=?,error=NULL WHERE itemId=? AND runId=?`).run(now(),row.id,String(lc?.generation_id||row.providerRunId||''));}catch{}setLifecycle(db,row,'REVIEW_READY',{...lc,generation_id:lc?.generation_id||row.providerRunId||'',size:valid.size,duration:valid.duration,width:valid.width,height:valid.height,download_quality:flowResult.download_quality,retrieved_at:now()});setMeta(db,'flow:lastSuccessfulGenerationAt',lc?.generation_started_at||now());setMeta(db,'flow:lastSuccessfulMp4At',now());setMeta(db,'automation:provider',PROVIDER);setMeta(db,'automation:paidDependencyDetected','false');setMeta(db,'automation:tinyfishRequired','false');try{fs.writeFileSync(path.join(FACTORY_DIR,'flow-browser-self-test.json'),JSON.stringify({at:now(),ok:true,stage:'real-production-review-ready',provider:PROVIDER,episode:`T${row.season}E${row.episode}`,mp4_valid:true,duration:valid.duration,width:valid.width,height:valid.height,codec:valid.codec},null,2),{mode:0o600});}catch{}publish('REVIEW_READY',{episode:`T${row.season}E${row.episode}`,job_id:row.id,generation_id:lc?.generation_id||row.providerRunId||'',size:valid.size,duration:valid.duration,resolution:`${valid.width}x${valid.height}`,factory_url:`/factory/video/${row.id}`});return true;}
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
  return['queued','historical','published'].includes(String(prev.status||''));
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
function normalizeConsumedReviewerRetries(db){
  const rows=db.prepare("SELECT * FROM factory_items WHERE retryStrategy IN ('reuse_prompt','revise_prompt') AND reviewFeedback IS NOT NULL AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken AND status NOT IN ('review','queued','historical','published')").all();
  for(const row of rows){
    const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
    if(AFTER_GENERATE.has(state)||AMBIGUOUS.has(state)){
      if(String(row.status||'')!=='generating')db.prepare("UPDATE factory_items SET status='generating',nextTry=0,error='REDO already submitted: recovery only; Generate is locked.',updatedAt=? WHERE id=?").run(now(),row.id);
    }else if(String(row.status||'')!=='manual_hold'){
      db.prepare("UPDATE factory_items SET status='manual_hold',nextTry=0,error='REDO token already consumed without recoverable generation evidence. A new human REDO is required.',updatedAt=? WHERE id=?").run(now(),row.id);
      setLifecycle(db,row,'MANUAL_HOLD_CONSUMED_RETRY',{...lc,reviewer_retry:true,retry_token:String(row.reviewRetryToken||''),automatic_submit_forbidden:true,held_at:now()});
    }
  }
}
function auditRedoState(db){
  const consumed=Number(db.prepare("SELECT COUNT(*) n FROM factory_items WHERE status IN ('draft','regen_wait') AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken").get()?.n||0);
  if(consumed)throw new Error('REDO_STATE_INVARIANT_FAILED:'+consumed);
}

function productionCandidate(db){
  const blocker=db.prepare("SELECT * FROM factory_items WHERE status NOT IN ('review','queued','historical','published') ORDER BY episode LIMIT 1").get();
  if(!blocker)return null;
  const due=Number(blocker.nextTry||0)<=Date.now();
  if(String(blocker.status)==='generating')return due?blocker:null;
  if(!['draft','regen_wait'].includes(String(blocker.status||'')))return null;
  if(!due)return null;
  if(isReviewerRetry(blocker))return blocker;
  if(String(blocker.reviewFeedback||'').trim())return null;
  return blocker;
}
async function runProvider(){
  if(bootstrapOwnsProfile()){publish('AUTH_BOOTSTRAP_ACTIVE',{message:'Flow bootstrap owns the persistent browser profile; provider is paused.'});return}
  if(!acquireLock())return;let db,row=null;
  try{
    if(!fs.existsSync(DB_PATH)){publish('WAITING_FOR_DB',{message:'Runtime database not ready yet.'});return}
    db=dbOpen();ensureSchema(db);ensureProductionPlan(db);reconcileGenerationCreditAccounting(db);ensureBacklog(db);normalizeUnconfirmedPreGenerationRows(db);normalizeConsumedReviewerRetries(db);auditRedoState(db);ensureConfirmedGenerationAccounting(db);
    setMeta(db,'automation:provider',PROVIDER);setMeta(db,'automation:paidDependencyDetected','false');setMeta(db,'automation:tinyfishRequired','false');setMeta(db,'automation:tinyfishFallback','disabled');setMeta(db,'automation:freeBrowserProfile',PROFILE_DIR);
    setMeta(db,'automation:serialFlowMode','true');
    setMeta(db,'automation:serialFlowSop','FLOW-SERIAL-GEN-RECOVER-001');
    const migrated=await migrateProfileOnce(db);if(!migrated)return;
    const goldenRecovery=await recoverGoldenRunIfRequested(db);
    if(goldenRecovery.needed&&!goldenRecovery.done)return;
    const used=effectiveDailyCount(db);row=productionCandidate(db);
    if(row&&String(row.status)==='generating'){publish('RECOVERY_PICKED',{episode:'E'+row.episode,job_id:row.id,state:String(lifecycle(db,row)?.state||''),used_today:used});await processRow(db,row);return}
    const priorityRetry=isReviewerRetry(row);
    if(used>=dailyProductionLimit()&&!priorityRetry){if(row&&String(lifecycle(db,row)?.state||'').toUpperCase()!=='PREFLIGHT_PASSED'){publish('NEXT_DAY_PREFLIGHT',{episode:'E'+row.episode,job_id:row.id,message:'Daily target complete; validating next job without Send.'});await processRow(db,row);return}setMeta(db,'flow:state','ESPERANDO CRÉDITOS');setMeta(db,'flow:currentStep','daily-limit');setMeta(db,'flow:message','Daily production complete: '+used+'/'+dailyProductionLimit()+'.');publish('DAILY_LIMIT',{used,limit:dailyProductionLimit(),day:artDay(),next_episode:row?('E'+row.episode):null});return}
    if(!row){ensureBacklog(db);row=productionCandidate(db);if(!row){const blocker=db.prepare("SELECT episode,status,nextTry,error FROM factory_items WHERE status NOT IN ('review','queued','historical','published') ORDER BY episode LIMIT 1").get();setMeta(db,'flow:state','CONECTADO');setMeta(db,'flow:currentStep','idle');publish('IDLE',{message:blocker?('Head-of-line E'+blocker.episode+' status='+blocker.status+' nextTry='+blocker.nextTry+' error='+compact(blocker.error||'',180)):'No production candidate yet.'});return}}
    publish(priorityRetry?'REVIEW_RETRY_PICKED':'PRODUCTION_PICKED',{episode:'E'+row.episode,job_id:row.id,used_today:used,remaining_today:Math.max(0,dailyProductionLimit()-used),daily_limit_bypassed:priorityRetry});await processRow(db,row);
  }catch(err){
    const message=compact(err?.stack||err?.message||err,900);
    try{if(db&&row){const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row,lc=lifecycle(db,fresh)||{},state=String(lc.state||'').toUpperCase(),attempts=Number(fresh.runtimeAttemptCount||0)+1,beforeGenerate=!AFTER_GENERATE.has(state)&&!AMBIGUOUS.has(state),baseBackoff=beforeGenerate?10000:60000,capBackoff=beforeGenerate?5*60*1000:60*60*1000,backoff=Math.min(capBackoff,baseBackoff*Math.pow(2,Math.min(attempts-1,6))),nextTry=Date.now()+backoff;if(/FLOW_GENERATION_FAILED/.test(message)){db.prepare("UPDATE factory_items SET status='failed_after_generate',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=0,updatedAt=? WHERE id=?").run(attempts,now(),message,now(),fresh.id);setLifecycle(db,fresh,'FAILED_AFTER_GENERATE',{last_error:message,attempt_count:attempts})}else if(AFTER_GENERATE.has(state)){db.prepare("UPDATE factory_items SET status='generating',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id);setLifecycle(db,fresh,'RETRIEVAL_PENDING',{...lc,last_error:message,attempt_count:attempts,retry_at:new Date(nextTry).toISOString()})}else if(AMBIGUOUS.has(state)){db.prepare("UPDATE factory_items SET status='generating',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id)}else if(reviewerRetryTokenConsumed(fresh)){
  db.prepare("UPDATE factory_items SET status='manual_hold',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=0,updatedAt=? WHERE id=?").run(attempts,now(),message,now(),fresh.id);
  setLifecycle(db,fresh,'MANUAL_HOLD_CONSUMED_RETRY',{...lc,last_error:message,attempt_count:attempts,automatic_submit_forbidden:true,retry_token:String(fresh.reviewRetryToken||'')});
}else{db.prepare("UPDATE factory_items SET status='draft',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id);setLifecycle(db,fresh,'FAILED_BEFORE_GENERATE',{last_error:message,attempt_count:attempts,retry_at:new Date(nextTry).toISOString()})}}if(db){setMeta(db,'flow:state',/FLOW_AUTH/.test(message)?'REQUIERE REAUTENTICACIÓN':'ERROR');setMeta(db,'flow:message',message)}}catch{}publish('ERROR',{message,episode:row?('E'+row.episode):null});
  }finally{try{db?.close()}catch{}releaseLock()}
}
globalThis.__publisherRunProvider=()=>{void runProvider();};
setTimeout(()=>{void runProvider()},12000);
setInterval(()=>{void runProvider()},20*1000).unref();
