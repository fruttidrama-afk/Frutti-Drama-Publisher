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
const GOLDEN_RECOVERY_ALLOW_NEWEST_UNUSED=String(process.env.PUBLISHER_RECOVERY_ALLOW_NEWEST_UNUSED||'false').toLowerCase()==='true';
const GOLDEN_RECOVERY_SEARCH_ALL_PROJECTS=String(process.env.PUBLISHER_RECOVERY_SEARCH_ALL_PROJECTS||'false').toLowerCase()==='true';

const BOOTSTRAP_LOCK=path.join(FACTORY_DIR,'flow-auth-bootstrap.active.json');
const STATUS_FILE=path.resolve(process.cwd(),'public','free-browser-status.json');
const PROVIDER='FreeBrowserProvider';
const GEMINI_FEEDBACK_URL='https://gemini.google.com/app';
async function saveReviewAsset(db,row,localPath,flowResult,stamp=now()){
  // HARD APPROVAL GATE: an unapproved review render must remain only on the
  // Publisher's private persistent volume. It must never be uploaded remotely.
  flowResult.review_storage='local-volume-until-approval';
  const size=fs.statSync(localPath).size;
  const contentHash=createHash('sha256').update(fs.readFileSync(localPath)).digest('hex');
  const assetId=String(flowResult?.flow_asset_id||'').trim();
  const globallyRejected=db.prepare("SELECT contentHash,episode,reason FROM flow_rejected_media_hashes WHERE contentHash=? LIMIT 1").get(contentHash);
  if(globallyRejected){
    try{fs.unlinkSync(localPath)}catch{}
    throw new Error('FLOW_REJECTED_MEDIA_REUSED: downloaded media was previously rejected as the wrong recovery for episode '+String(globallyRejected.episode||'?')+'.');
  }
  const priorSameHash=String(row?.reviewContentHash||'').trim();
  if(priorSameHash&&priorSameHash===contentHash){
    try{fs.unlinkSync(localPath)}catch{}
    throw new Error('FLOW_SAME_REVIEW_MEDIA_REUSED: replacement download is byte-identical to the media already shown for this episode.');
  }
  const rows=db.prepare("SELECT id,episode,status,reviewContentHash,flowResult FROM factory_items WHERE id<>?").all(row.id);
  for(const other of rows){
    let fr={};try{fr=JSON.parse(String(other.flowResult||'{}'))||{}}catch{}
    const otherHash=String(other.reviewContentHash||fr.content_hash||'').trim();
    if(otherHash&&otherHash===contentHash){
      try{fs.unlinkSync(localPath)}catch{}
      throw new Error('FLOW_DUPLICATE_REVIEW_MEDIA: downloaded media is already bound to episode '+other.episode+'; refusing cross-episode reuse.');
    }
  }
  if(assetId){
    const priorAsset=db.prepare("SELECT assetId,itemId,episode,contentHash,signature FROM flow_recovered_assets WHERE assetId=? LIMIT 1").get(assetId);
    if(priorAsset){
      try{fs.unlinkSync(localPath)}catch{}
      throw new Error('FLOW_ASSET_ID_ALREADY_RECOVERED: asset '+assetId.slice(0,16)+' was already recovered for episode '+priorAsset.episode+'.');
    }
  }
  flowResult.content_hash=contentHash;
  db.prepare(`UPDATE factory_items SET status='review',videoPath=?,remoteUrl=NULL,reviewVideoId=NULL,reviewArchivedAt=NULL,reviewOriginalSize=?,reviewContentHash=?,flowResult=?,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?`)
    .run(localPath,size,contentHash,JSON.stringify(flowResult),stamp,stamp,row.id);
  if(assetId){
    db.prepare("INSERT OR REPLACE INTO flow_recovered_assets(assetId,itemId,episode,contentHash,signature,recoveryProof,runId,recoveredAt) VALUES(?,?,?,?,?,?,?,?)")
      .run(assetId,row.id,Number(row.episode||0),contentHash,String(flowResult?.recovery_signature||flowResult?.matched_label||''),String(flowResult?.recovery_proof||''),String(flowResult?.generation_id||flowResult?.run_id||''),stamp);
  }
  return null;
}

const INSTANCE_ID=randomUUID();
const BASE_DAILY_PRODUCTION_LIMIT=DAILY_LIMIT;
const CREDITS_PER_GENERATION=CREDIT_PER_GENERATION;
const DAILY_FLOW_CREDIT_BUDGET=DAILY_CREDIT_BUDGET;
const PRODUCTION_START_EPISODE=1;
const DAILY_FLOW_GRANT_CREDITS=Math.max(1,Number(CONFIG.generation?.daily_credit_grant||50));
const DAILY_BATCH_CREDIT_COST=Math.max(1,Number(BASE_DAILY_PRODUCTION_LIMIT||1)*Number(CREDITS_PER_GENERATION||15));
const CREDIT_REFRESH_POLL_MS=Math.max(60000,Number(CONFIG.generation?.credit_refresh_poll_minutes||5)*60*1000);
const CREDIT_REFRESH_GUARD_MS=Math.max(6*60*60*1000,Number(CONFIG.generation?.credit_refresh_guard_hours||20)*60*60*1000);
const CREDIT_REFRESH_FALLBACK_MS=Math.max(CREDIT_REFRESH_GUARD_MS+60*60*1000,Number(CONFIG.generation?.credit_refresh_fallback_hours||30)*60*60*1000);
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
  // Count successful retained videos, including human-requested REDO renders.
  // The UI counter and the autonomous 3/day target must describe actual videos
  // generated today, not only "automatic" generationKind rows.
  return Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE day=? AND credits>0 AND status IN ('review','completed')").get(day)?.n||0);
}
function dayFromCandidates(...values){
  for(const value of values){
    const ms=Date.parse(String(value||''));if(Number.isFinite(ms))return artDay(new Date(ms));
  }
  return'';
}
function retainedDailyCount(db,day=artDay()){
  let count=0;
  try{
    const rows=db.prepare("SELECT status,flowResult,providerRunId,lastProgressAt,updatedAt,stockId,reviewContentHash FROM factory_items WHERE status IN ('review','queued','historical','published')").all();
    for(const row of rows){
      const flow=json(row.flowResult,{})||{};
      // These lifecycle states are only reachable after a retained video exists.
      // Count the row itself as generation evidence even if a legacy recovery
      // lost auxiliary hash/run-id fields.
      if(dayFromCandidates(flow?.generation_started_at,row.lastProgressAt,row.updatedAt)===day)count++;
    }
  }catch{}
  return count;
}
function approvedPublicationCount(db,day=artDay()){
  let count=0;
  try{
    const rows=db.prepare("SELECT p.createdAt,p.status,f.flowResult,f.lastProgressAt,f.updatedAt FROM publication_items p JOIN factory_items f ON f.id=p.itemId WHERE p.status NOT IN ('cancelled','deleted')").all();
    for(const row of rows){
      let flow={};try{flow=json(row.flowResult,{})||{}}catch{}
      // Approval/publication creation is hard evidence that this retained video
      // exists. Prefer today's publication timestamp before legacy factory
      // timestamps, which may predate a reset/recovery and previously caused a
      // false 2/3 count followed by an unwanted fourth generation.
      if(dayFromCandidates(row.createdAt)===day){count++;continue}
      if(dayFromCandidates(flow?.generation_started_at,row.lastProgressAt,row.updatedAt)===day)count++;
    }
  }catch{}
  return count;
}
function pendingReviewCount(db,day=artDay()){
  let count=0;
  try{
    const rows=db.prepare("SELECT flowResult,lastProgressAt,updatedAt FROM factory_items WHERE status='review'").all();
    for(const row of rows){
      const flow=json(row.flowResult,{})||{};
      const stamp=String(flow?.generation_started_at||row.lastProgressAt||row.updatedAt||'');
      const ms=Date.parse(stamp);if(Number.isFinite(ms)&&artDay(new Date(ms))===day)count++;
    }
  }catch{}
  return count;
}
function immutableAutomaticStarts(db,day=artDay()){
  return Math.max(0,Number(meta(db,'automation:confirmedAutomaticStarts:'+day,'0'))||0);
}
function recordAutomaticStart(db,runId,startedAt){
  const day=artDay(new Date(startedAt)),key='automation:confirmedAutomaticRun:'+String(runId);
  if(meta(db,key,'')==='1')return;
  setMeta(db,key,'1');
  setMeta(db,'automation:confirmedAutomaticStarts:'+day,String(immutableAutomaticStarts(db,day)+1));
}
function effectiveDailyCount(db,day=artDay()){
  const approvedPlusReview=approvedPublicationCount(db,day)+pendingReviewCount(db,day);
  // Hard credit-safety floor: once an automatic Flow render is confirmed
  // started, that slot is spent for the day and can never be reopened by a
  // reset/recovery/delete. Only an explicit REDO or Generate Extra may exceed
  // the autonomous target.
  return Math.max(dailyGenerationCount(db,day),retainedDailyCount(db,day),approvedPlusReview,immutableAutomaticStarts(db,day));
}
function ensureConfirmedGenerationAccounting(db){
  try{
    // Retained media remains a confirmed generation even after the operator
    // approves it and the factory row moves from review -> queued/published.
    // Reconcile all retained states so a fast approval can never make the
    // daily generation counter lose an episode.
    const rows=db.prepare("SELECT * FROM factory_items WHERE status IN ('generating','review','queued','historical','published') ORDER BY episode").all();
    for(const row of rows){
      const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
      let flow={};try{flow=json(row.flowResult,{})||{}}catch{}
      const retained=Boolean(
        ['review','queued','historical','published'].includes(String(row.status||'')) &&
        (flow?.validated_ftyp||flow?.content_hash||row.reviewContentHash||row.stockId||row.videoPath||row.remoteUrl)
      );
      if(!AFTER_GENERATE.has(state)&&!retained)continue;
      let runId=String(lc.generation_id||flow?.generation_id||row.providerRunId||'').trim();
      // A retained, validated MP4 is itself hard proof that one generation
      // completed. Legacy/reset recovery can legitimately lose the original
      // runId while preserving the media + publication stock record. Give that
      // retained item one deterministic accounting identity instead of letting
      // the daily counter drop and generating an unwanted fourth video.
      if(!runId&&retained)runId='retained-'+String(row.id);
      if(!runId||/^manual-flow-golden-run:/.test(runId))continue;
      const existing=db.prepare("SELECT id,credits,status,generationKind FROM factory_generations WHERE itemId=? AND runId=? LIMIT 1").get(row.id,runId);
      const startedAt=String(lc.generation_started_at||flow?.generation_started_at||lc.reconciled_at||row.lastProgressAt||row.updatedAt||now());
      const day=artDay(new Date(startedAt));
      const generationStatus=retained?'review':'running';
      if(existing){
        const needsRepair=
          Number(existing.credits||0)<=0 ||
          ['no_generation','infra_rejected'].includes(String(existing.status||'')) ||
          (retained&&String(existing.status||'')!=='review');
        if(needsRepair){
          try{
            db.prepare("UPDATE factory_generations SET day=?,credits=?,status=?,error=NULL,generationKind=COALESCE(NULLIF(generationKind,''),'automatic'),updatedAt=? WHERE id=?")
              .run(day,CREDITS_PER_GENERATION,generationStatus,now(),existing.id);
            publish('GENERATION_ACCOUNTING_REPAIRED',{episode:'E'+row.episode,job_id:row.id,run_id:runId,status:generationStatus,mode:'normalized-existing'});
          }catch(e){publish('GENERATION_ACCOUNTING_REPAIR_WARNING',{episode:'E'+row.episode,message:compact(e?.message||e,300)})}
        }
        continue;
      }
      try{
        db.prepare("INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)")
          .run(randomUUID(),row.id,day,sha(String(row.promptHash||'')+':'+runId),CREDITS_PER_GENERATION,generationStatus,runId,startedAt,now(),'automatic');
        publish('GENERATION_ACCOUNTING_REPAIRED',{episode:'E'+row.episode,job_id:row.id,run_id:runId,status:generationStatus,mode:'inserted-retained'});
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
    const stale=db.prepare("SELECT * FROM factory_items WHERE status='generating' AND videoPath IS NULL AND error LIKE '%RENDER_TIMEOUT%'").all();
    for(const row of stale){
      const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
      if(AFTER_GENERATE.has(state)||AMBIGUOUS.has(state))continue;
      const run=String(row.providerRunId||lc.generation_id||'');
      const retryAt=Date.now()+60000;
      db.prepare("UPDATE factory_items SET status='generating',error='SUBMIT_AMBIGUOUS — render timeout is recovery-only; Generate remains locked.',nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?")
        .run(retryAt,now(),now(),row.id);
      setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{
        ...lc,generation_id:run||String(lc.generation_id||''),reconciled_at:now(),
        last_error:'RENDER_TIMEOUT without explicit provider rejection; timeout cannot authorize another submit.',
        retry_at:new Date(retryAt).toISOString(),automatic_submit_forbidden:true
      });
      publish('STALE_RENDER_TIMEOUT_LOCKED',{episode:'E'+row.episode,job_id:row.id,message:'Historical render timeout converted to recovery-only ambiguity; no automatic resubmit is permitted.'});
    }
  }catch{}
  try{
    const wrong=db.prepare("SELECT * FROM factory_items WHERE videoPath IS NULL AND error LIKE '%WRONG_FLOW_MODE_TEXT_RESPONSE_AFTER_SEND%'").all();
    for(const row of wrong){
      const lc=lifecycle(db,row)||{};
      db.prepare("UPDATE factory_items SET status='manual_hold',nextTry=0,error='Wrong Flow mode response occurred after submit; a new human intent is required before retry.',lastProgressAt=?,updatedAt=? WHERE id=?")
        .run(now(),now(),row.id);
      setLifecycle(db,row,'MANUAL_HOLD_POST_SUBMIT_MODE_MISMATCH',{
        ...lc,held_at:now(),automatic_submit_forbidden:true,
        evidence:'A post-submit non-video response was observed. The prior intent will not be automatically resubmitted.'
      });
      publish('POST_SUBMIT_MODE_MISMATCH_HELD',{episode:'E'+row.episode,job_id:row.id,message:'Post-submit mode mismatch moved to manual hold; Generate remains locked.'});
    }
  }catch{}
}
function normalizeUnconfirmedPreGenerationRows(db){
  try{
    const forceEpisode=Number(process.env.PUBLISHER_FORCE_RESET_EPISODE||0);
    if(forceEpisode>0){
      const resetToken=String(process.env.PUBLISHER_FORCE_RESET_TOKEN||process.env.PUBLISHER_RUNTIME_VERSION||'default');
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
    const forcedReviewEpisodes=String(process.env.PUBLISHER_FORCE_RESET_REVIEW_EPISODES||'').split(',').map(x=>Number(x.trim())).filter(x=>Number.isInteger(x)&&x>0);
    const forcedReviewToken=String(process.env.PUBLISHER_FORCE_RESET_REVIEW_TOKEN||'').trim();
    if(forcedReviewEpisodes.length&&forcedReviewToken){
      for(const episode of [...new Set(forcedReviewEpisodes)]){
        const resetKey='operator:force-reset-invalid-review:'+episode+':'+forcedReviewToken;
        if(meta(db,resetKey,'')==='done')continue;
        const bad=db.prepare("SELECT * FROM factory_items WHERE episode=? LIMIT 1").get(episode);
        if(bad&&['review','generating'].includes(String(bad.status||''))){
          try{if(bad.videoPath&&fs.existsSync(bad.videoPath))fs.unlinkSync(bad.videoPath)}catch{}
          db.prepare("UPDATE factory_generations SET credits=0,status='no_generation',error='Invalid review reset: no episode-specific Flow generation was proven.',updatedAt=? WHERE itemId=?").run(now(),bad.id);
          db.prepare(`UPDATE factory_items SET status='draft',videoPath=NULL,remoteUrl=NULL,stockId=NULL,providerRunId=NULL,flowResult=NULL,
            prompt='',promptHash=NULL,promptGenerationId=NULL,characterHandles=NULL,characterRoles=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,
            creativePackageHash=NULL,creativePackageId=NULL,transportPreflight=NULL,runtimeAttemptCount=0,lastProgressAt=?,reviewVideoId=NULL,
            reviewArchivedAt=NULL,reviewOriginalSize=NULL,reviewPreviewSize=NULL,reviewArchiveError=NULL,reviewContentHash=NULL,
            reviewFeedback=NULL,retryStrategy=NULL,reviewRetryToken=NULL,reviewRetrySubmittedToken=NULL,
            title='',description='',error=NULL,nextTry=0,updatedAt=? WHERE id=?`).run(now(),now(),bad.id);
          setLifecycle(db,bad,'FORCED_INVALID_REVIEW_RESET',{episode,reconciled_at:now(),evidence:'Operator verified this review card reused pre-existing/manual Flow media and no new episode render existed.',automatic_submit_forbidden:false});
          publish('INVALID_REVIEW_RESET',{episode:'E'+episode,job_id:bad.id,message:'Invalid or excess generation cleared; episode returned to draft without counting or retrieving the orphan Flow output.'});
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
function generationPauseUntilMs(){
  const raw=String(process.env.PUBLISHER_GENERATION_PAUSED_UNTIL||'').trim();
  if(!raw)return 0;
  const ms=Date.parse(raw);
  return Number.isFinite(ms)?ms:0;
}
function generationPauseActive(){
  const until=generationPauseUntilMs();
  return Boolean(until&&Date.now()<until);
}
function generationPauseIso(){
  const until=generationPauseUntilMs();
  return until?new Date(until).toISOString():'';
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
    `ALTER TABLE factory_items ADD COLUMN reviewInterpretation TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewInterpretationAt TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewInterpretation TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewInterpretationAt TEXT`,
    `ALTER TABLE factory_generations ADD COLUMN generationKind TEXT NOT NULL DEFAULT 'automatic'`
  ]) { try { db.exec(sql); } catch {} }
  try{db.exec(`
    CREATE TABLE IF NOT EXISTS flow_recovered_assets(
      assetId TEXT PRIMARY KEY,
      itemId TEXT NOT NULL,
      episode INTEGER NOT NULL,
      contentHash TEXT,
      signature TEXT,
      recoveryProof TEXT,
      runId TEXT,
      recoveredAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS flow_rejected_media_hashes(
      contentHash TEXT PRIMARY KEY,
      episode INTEGER,
      reason TEXT,
      rejectedAt TEXT NOT NULL
    );
  `)}catch{}
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
  const providers=CONFIG.publication?.providers||[],provider=providers.find(x=>x.type===CONFIG.publication?.selected_provider)||providers[0]||{};
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

async function flowSettingsPanelOpen(page){
  const body=compact(await getBody(page).catch(()=>''),5000);
  return /Agent settings|Confirm before generating|Video generation default|Image generation default|Generation settings/i.test(body);
}
async function closeFlowSettings(page,{timeout=9000}={}){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    try{
      const editor=await promptEditor(page);
      const send=await generationSendButton(page,editor);
      if(await editor.isVisible().catch(()=>false)&&await send.isVisible().catch(()=>false))return true;
    }catch{}
    if(!(await flowSettingsPanelOpen(page)))return true;

    // Current Flow renders Agent settings as a collapsible left panel. Its
    // reliable close control exposes either the accessible name "Collapse" or
    // the Material icon text "left_panel_close". Prefer that exact control
    // before generic Close/Escape fallbacks.
    let collapsed=false;
    const collapseNamed=page.getByRole('button',{name:/^(?:Collapse|Contraer|Ocultar panel|Collapse panel)$/i}).last();
    if(await collapseNamed.count().catch(()=>0)&&await collapseNamed.isVisible().catch(()=>false)){
      await trustedClick(collapseNamed).catch(()=>{});collapsed=true;await sleep(450);
    }
    if(!collapsed){
      const icons=page.locator('mat-icon');
      for(let i=(await icons.count().catch(()=>0))-1;i>=0;i--){
        const icon=icons.nth(i);
        if(!(await icon.isVisible().catch(()=>false)))continue;
        const txt=compact((await icon.innerText().catch(()=>''))+' '+(await icon.textContent().catch(()=>'')),80);
        if(!/left_panel_close|close/i.test(txt))continue;
        const button=icon.locator('xpath=ancestor::button[1]').first();
        if(await button.count().catch(()=>0)&&await button.isVisible().catch(()=>false)){
          await trustedClick(button).catch(()=>{});collapsed=true;await sleep(450);break;
        }
      }
    }
    if(collapsed){
      try{
        const editor=await promptEditor(page);
        const send=await generationSendButton(page,editor);
        if(await editor.isVisible().catch(()=>false)&&await send.isVisible().catch(()=>false))return true;
      }catch{}
    }

    const selectors=[
      'button[aria-label*="close" i]',
      '[role="button"][aria-label*="close" i]',
      'button[title*="close" i]',
      '[role="button"][title*="close" i]'
    ];
    let clicked=false;
    for(const sel of selectors){
      const loc=page.locator(sel);
      for(let i=(await loc.count().catch(()=>0))-1;i>=0;i--){
        const b=loc.nth(i);
        if(!(await b.isVisible().catch(()=>false)))continue;
        await trustedClick(b).catch(()=>{});
        clicked=true;await sleep(350);break;
      }
      if(clicked)break;
    }
    if(!clicked){
      const named=page.getByRole('button',{name:/^(Close|Cerrar)$|close settings|cerrar configuraci[oó]n/i});
      for(let i=(await named.count().catch(()=>0))-1;i>=0;i--){
        const b=named.nth(i);
        if(!(await b.isVisible().catch(()=>false)))continue;
        await trustedClick(b).catch(()=>{});clicked=true;await sleep(350);break;
      }
    }
    await page.keyboard.press('Escape').catch(()=>{});
    await sleep(300);
    if(await flowSettingsPanelOpen(page)){
      try{
        const toggle=await settingsButton(page);
        if(await toggle.isVisible().catch(()=>false)){await trustedClick(toggle).catch(()=>{});await sleep(450)}
      }catch{}
    }
    await sleep(250);
  }
  const body=compact(await getBody(page).catch(()=>''),1200);
  throw new Error('FLOW_SETTINGS_PANEL_STUCK_OPEN:'+body);
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
      try{
        if(await flowSettingsPanelOpen(page)){
          await closeFlowSettings(page,{timeout:3500});
          const editor=await promptEditor(page);
          const send=await generationSendButton(page,editor);
          if(await editor.isVisible().catch(()=>false)&&await send.isVisible().catch(()=>false))return editor;
        }
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

// ---------------------------------------------------------------------------
// DAILY FLOW CREDIT-CYCLE GATE
// Google Flow grants 50 daily credits independently of the local calendar day.
// Autonomous production is therefore keyed to the observed Flow credit refresh,
// not to 00:00 in the Publisher timezone.
// ---------------------------------------------------------------------------
function parseVisibleCreditNumber(raw){
  const digits=String(raw??'').replace(/\D/g,'');
  if(!digits)return null;
  const n=Number(digits);
  return Number.isSafeInteger(n)&&n>=0&&n<10000000?n:null;
}
async function extractVisibleFlowCredits(page){
  const candidates=[];
  const creditWord=/credits?|cr[eé]ditos?|points?|puntos?/i;
  const add=(raw,source='text')=>{
    const line=compact(raw,320);
    if(!line||!creditWord.test(line))return;
    const patterns=[
      /([0-9][0-9.,\s]*)\s*(?:google\s+flow\s+|ai\s+)?(?:credits?|cr[eé]ditos?|points?|puntos?)/ig,
      /(?:credits?|cr[eé]ditos?|points?|puntos?)\s*[:\-]?\s*([0-9][0-9.,\s]*)/ig
    ];
    for(const rx of patterns){
      let m;
      while((m=rx.exec(line))){
        const value=parseVisibleCreditNumber(m[1]);
        if(value===null)continue;
        let score=0;
        if(/available|remaining|balance|disponib|restant|saldo|left|quedan/i.test(line))score+=8;
        if(/google\s+flow|ai\s+credits?|cr[eé]ditos?\s+de\s+ia/i.test(line))score+=3;
        if(/per\s+generation|por\s+generaci[oó]n|cost|cuesta|required|requiere|reserved|reservad/i.test(line))score-=7;
        candidates.push({value,line,score,source});
      }
    }
  };
  const scan=(raw,source)=>{
    const lines=String(raw||'').split(/\n+/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
    for(let i=0;i<lines.length;i++){
      add(lines[i],source);
      if(creditWord.test(lines[i]))add([lines[i-1],lines[i],lines[i+1],lines[i+2]].filter(Boolean).join(' | '),source+'-context');
    }
  };

  scan(await page.locator('body').innerText({timeout:10000}).catch(()=>''),'body');

  const labelled=page.locator('[aria-label*="credit" i],[title*="credit" i],[aria-label*="crédito" i],[title*="crédito" i],[aria-label*="point" i],[title*="point" i],[aria-label*="punto" i],[title*="punto" i]');
  const count=Math.min(await labelled.count().catch(()=>0),40);
  for(let i=0;i<count;i++){
    const el=labelled.nth(i);
    if(!(await el.isVisible().catch(()=>false)))continue;
    const aria=await el.getAttribute('aria-label').catch(()=>null);
    const title=await el.getAttribute('title').catch(()=>null);
    const text=await el.innerText().catch(()=>null);
    const context=await el.evaluate(node=>{
      const parts=[];let p=node;
      for(let depth=0;depth<4&&p;depth++,p=p.parentElement){
        const t=String(p.innerText||p.textContent||'').replace(/\s+/g,' ').trim();
        if(t&&t.length<260)parts.push(t);
      }
      return parts.join(' | ');
    }).catch(()=>'');
    add([aria,title,text,context].filter(Boolean).join(' '),'label-context');
  }

  // The remaining Flow balance is often shown only in the Google account menu.
  if(!candidates.length){
    const viewport=page.viewportSize()||{width:1024,height:700};
    const selectors=[
      'button[aria-label*="Google Account" i]','[role="button"][aria-label*="Google Account" i]',
      'button[aria-label*="Cuenta de Google" i]','[role="button"][aria-label*="Cuenta de Google" i]',
      'button[aria-label*="account" i]','[role="button"][aria-label*="account" i]',
      'button[aria-label*="cuenta" i]','[role="button"][aria-label*="cuenta" i]',
      'button[aria-label*="profile" i]','[role="button"][aria-label*="profile" i]',
      'button[aria-label*="perfil" i]','[role="button"][aria-label*="perfil" i]'
    ];
    const accountButtons=[];
    for(const sel of selectors){
      const loc=page.locator(sel),n=Math.min(await loc.count().catch(()=>0),12);
      for(let i=0;i<n;i++){
        const el=loc.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
        const box=await el.boundingBox().catch(()=>null);
        if(!box||box.y>180||box.x<viewport.width*.45)continue;
        accountButtons.push({el,box});
      }
    }
    accountButtons.sort((a,b)=>b.box.x-a.box.x||a.box.y-b.box.y);
    if(accountButtons[0]){
      await accountButtons[0].el.click({force:true,timeout:4000}).catch(()=>{});
      await sleep(900);
      scan(await page.locator('body').innerText({timeout:5000}).catch(()=>''),'profile-menu');
      for(const frame of page.frames()){
        if(frame===page.mainFrame())continue;
        scan(await frame.locator('body').innerText({timeout:2500}).catch(()=>''),'profile-frame');
      }
      await page.keyboard.press('Escape').catch(()=>{});
    }
  }

  // Conservative toolbar-number fallback. It is accepted only if no labelled
  // balance was found, and heavily penalizes common video-resolution numbers.
  if(!candidates.length){
    const viewport=page.viewportSize()||{width:1024,height:700};
    const numeric=page.locator('button,[role="button"],[role="status"],[role="meter"],[aria-valuenow],span');
    const numericCount=Math.min(await numeric.count().catch(()=>0),650);
    const fallback=[];
    for(let i=0;i<numericCount;i++){
      const el=numeric.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
      const box=await el.boundingBox().catch(()=>null);
      if(!box||box.y>190||box.x<viewport.width*.42)continue;
      const raw=String(await el.innerText().catch(()=>'')||await el.getAttribute('aria-valuenow').catch(()=>'')||'').trim();
      if(!/^[0-9][0-9.,\s]*$/.test(raw))continue;
      const value=parseVisibleCreditNumber(raw);
      if(value===null||value>100000)continue;
      let score=(box.x/viewport.width)*10+Math.max(0,(190-box.y)/190)*5;
      if(value>=25)score+=2;
      if([720,1080,1920,3840].includes(value))score-=8;
      if(value<=10)score-=5;
      fallback.push({value,line:'visible Flow toolbar balance '+raw,score,source:'toolbar-number'});
    }
    fallback.sort((a,b)=>b.score-a.score||b.value-a.value);
    if(fallback.length)candidates.push(fallback[0]);
  }

  if(!candidates.length)throw new Error('FLOW_CREDITS_NOT_FOUND');
  candidates.sort((a,b)=>b.score-a.score||b.value-a.value);
  return candidates[0];
}
async function syncVisibleFlowCredits(db,{force=false,maxAgeMs=CREDIT_REFRESH_POLL_MS}={}){
  const checkedAt=meta(db,'flow:lastCreditsCheckedAt','');
  const checkedMs=Date.parse(checkedAt);
  const cached=parseVisibleCreditNumber(meta(db,'flow:lastCreditsVisible',''));
  if(!force&&cached!==null&&Number.isFinite(checkedMs)&&Date.now()-checkedMs<maxAgeMs){
    return{ok:true,credits:cached,checkedAt,cached:true,source:meta(db,'flow:lastCreditsSource','google-flow-live')};
  }
  const session=await launchLocal();
  try{
    const page=session.page||session.context.pages()[0]||await session.context.newPage();
    await ensureExpectedFlowProject(page);
    if(!String(page.url()).includes(projectPath()))await page.goto(flowUrl(),{waitUntil:'domcontentloaded',timeout:60000});
    await waitFlowReady(page,60000);
    const hit=await extractVisibleFlowCredits(page);
    const at=now();
    setMeta(db,'flow:lastCreditsVisible',String(hit.value));
    setMeta(db,'flow:lastCreditsCheckedAt',at);
    setMeta(db,'flow:lastCreditsSource',String(hit.source||'google-flow-live'));
    setMeta(db,'flow:lastCreditsEvidence',compact(hit.line||'',500));
    setMeta(db,'flow:lastCreditsCheckError','');
    publish('FLOW_CREDITS_SYNCED',{credits:hit.value,source:hit.source,evidence:compact(hit.line||'',220)});
    return{ok:true,credits:hit.value,checkedAt:at,cached:false,source:hit.source,evidence:hit.line};
  }catch(err){
    setMeta(db,'flow:lastCreditsCheckError',compact(err?.message||err,300));
    throw err;
  }finally{await session.close().catch(()=>{})}
}
function creditCycleState(db){return json(meta(db,'flow:dailyCreditCycle',''),null)}
function persistCreditCycle(db,cycle){
  setMeta(db,'flow:dailyCreditCycle',JSON.stringify(cycle));
  setMeta(db,'flow:dailyCreditCycleId',String(cycle?.id||''));
  setMeta(db,'flow:dailyCreditCycleOpenedAt',String(cycle?.opened_at||''));
}
function creditCycleUsage(db,cycle=creditCycleState(db)){
  const startMs=Date.parse(String(cycle?.opened_at||''));
  if(!Number.isFinite(startMs))return 0;
  const runs=new Set();
  try{
    const rows=db.prepare("SELECT runId,createdAt,credits,status FROM factory_generations WHERE credits>0 AND status NOT IN ('no_generation','infra_rejected') ORDER BY createdAt").all();
    for(const row of rows){
      const ms=Date.parse(String(row.createdAt||''));if(!Number.isFinite(ms)||ms<startMs)continue;
      const run=String(row.runId||'').trim();if(run)runs.add(run);
    }
  }catch{}
  // A submit boundary can be ambiguous before factory_generations is inserted.
  // Count that intent conservatively so a crash/timeout can never open a fourth slot.
  try{
    const rows=db.prepare("SELECT * FROM factory_items WHERE status='generating'").all();
    for(const row of rows){
      const lc=lifecycle(db,row)||{},boundary=Date.parse(String(lc.submit_boundary_at||''));
      if(!Number.isFinite(boundary)||boundary<startMs)continue;
      const state=String(lc.state||'').toUpperCase();
      if(['TRANSIENT_NO_CHARGE_RETRY','UNUSUAL_ACTIVITY_OVERNIGHT','WAITING_FOR_CREDITS'].includes(state))continue;
      const run=String(lc.generation_id||row.providerRunId||'').trim();if(run)runs.add(run);
    }
  }catch{}
  return runs.size;
}
function recentCreditCycleBootstrap(db){
  try{
    const rows=db.prepare("SELECT runId,createdAt,credits,status FROM factory_generations WHERE credits>0 AND status NOT IN ('no_generation','infra_rejected') ORDER BY createdAt DESC LIMIT 12").all();
    if(!rows.length)return null;
    const latestMs=Date.parse(String(rows[0].createdAt||''));
    if(!Number.isFinite(latestMs)||Date.now()-latestMs>36*60*60*1000)return null;
    const cluster=rows.filter(r=>{const ms=Date.parse(String(r.createdAt||''));return Number.isFinite(ms)&&latestMs-ms<=3*60*60*1000});
    const openedMs=Math.min(...cluster.map(r=>Date.parse(String(r.createdAt||''))).filter(Number.isFinite));
    if(!Number.isFinite(openedMs))return null;
    return{id:'history-'+new Date(openedMs).toISOString(),opened_at:new Date(openedMs).toISOString(),opening_balance:null,last_balance:null,last_checked_at:null,post_batch_baseline_captured:false,source:'generation-history-bootstrap',evidence:'Existing recent Flow generation cluster anchors the current daily credit cycle.',grant_credits:DAILY_FLOW_GRANT_CREDITS,batch_cost:DAILY_BATCH_CREDIT_COST,target:Number(BASE_DAILY_PRODUCTION_LIMIT||1)};
  }catch{return null}
}
function openDailyCreditCycle(db,credits,source,evidence){
  const stamp=now();
  const cycle={
    id:'daily-credit-'+stamp+'-'+randomUUID().slice(0,8),
    opened_at:stamp,
    opening_balance:Number.isFinite(Number(credits))?Number(credits):null,
    last_balance:Number.isFinite(Number(credits))?Number(credits):null,
    last_checked_at:Number.isFinite(Number(credits))?stamp:null,
    post_batch_baseline_captured:false,
    source:String(source||'flow-credit-refresh'),
    evidence:compact(evidence||'',500),
    grant_credits:DAILY_FLOW_GRANT_CREDITS,
    batch_cost:DAILY_BATCH_CREDIT_COST,
    target:Number(BASE_DAILY_PRODUCTION_LIMIT||1)
  };
  persistCreditCycle(db,cycle);
  setMeta(db,'flow:dailyCreditRenewalEvidence',cycle.evidence||cycle.source);
  setMeta(db,'flow:dailyCreditBatchOpen','true');
  setMeta(db,'flow:dailyCreditRefreshWaiting','false');
  setMeta(db,'flow:dailyCreditCycleUsed','0');
  setMeta(db,'flow:dailyCreditCycleTarget',String(cycle.target));
  publish('DAILY_FLOW_CREDIT_CYCLE_OPENED',{cycle_id:cycle.id,credits:cycle.opening_balance,grant_credits:DAILY_FLOW_GRANT_CREDITS,target:cycle.target,source:cycle.source,evidence:cycle.evidence});
  return cycle;
}
async function ensureDailyCreditCycle(db){
  let cycle=creditCycleState(db);
  if(!cycle){
    cycle=recentCreditCycleBootstrap(db);
    if(cycle){
      persistCreditCycle(db,cycle);
      publish('DAILY_FLOW_CREDIT_CYCLE_BOOTSTRAPPED',{cycle_id:cycle.id,opened_at:cycle.opened_at,source:cycle.source});
    }
  }

  // First-ever publisher/account bootstrap. For a free-looking balance around 50,
  // the current daily allocation is already visibly present and can seed cycle 1.
  // A larger paid balance is ambiguous (monthly/purchased credits may be mixed in),
  // so it is observed but not treated as a daily refresh until a refill is seen.
  if(!cycle){
    let sync=null;
    try{sync=await syncVisibleFlowCredits(db,{force:false,maxAgeMs:CREDIT_REFRESH_POLL_MS})}catch(err){
      setMeta(db,'flow:dailyCreditBatchOpen','false');
      setMeta(db,'flow:dailyCreditRefreshWaiting','true');
      setMeta(db,'flow:state','ESPERANDO CRÉDITOS');
      setMeta(db,'flow:currentStep','credit-balance-unavailable');
      setMeta(db,'flow:message','Esperando una lectura confiable del saldo de créditos de Google Flow antes de iniciar el lote diario.');
      return{open:false,used:0,target:Number(BASE_DAILY_PRODUCTION_LIMIT||1),reason:'credit-balance-unavailable',error:compact(err?.message||err,240)};
    }
    const watch=json(meta(db,'flow:dailyCreditInitialWatch',''),{})||{};
    const previous=parseVisibleCreditNumber(watch.balance);
    const current=Number(sync.credits);
    if(current>=DAILY_BATCH_CREDIT_COST&&current<=DAILY_FLOW_GRANT_CREDITS+10){
      cycle=openDailyCreditCycle(db,current,'initial-daily-allocation-visible','Visible Flow balance is consistent with the current 50-credit daily allocation.');
    }else if(previous!==null&&current>previous){
      const delta=current-previous;
      if(delta>=15&&delta<=DAILY_FLOW_GRANT_CREDITS+10){
        cycle=openDailyCreditCycle(db,current,'observed-first-daily-refill','Visible Flow balance increased by '+delta+' credits while waiting for the first daily refill.');
      }
    }
    if(!cycle){
      setMeta(db,'flow:dailyCreditInitialWatch',JSON.stringify({balance:current,checked_at:sync.checkedAt,source:sync.source}));
      setMeta(db,'flow:dailyCreditBatchOpen','false');
      setMeta(db,'flow:dailyCreditRefreshWaiting','true');
      setMeta(db,'flow:state','ESPERANDO CRÉDITOS');
      setMeta(db,'flow:currentStep','waiting-first-daily-credit-refresh');
      setMeta(db,'flow:message','Saldo de Flow observado ('+current+'). Esperando evidencia de la renovación diaria de 50 créditos antes de iniciar el lote automático.');
      publish('WAITING_FIRST_DAILY_FLOW_CREDIT_REFRESH',{credits:current,grant_credits:DAILY_FLOW_GRANT_CREDITS});
      return{open:false,used:0,target:Number(BASE_DAILY_PRODUCTION_LIMIT||1),reason:'waiting-first-daily-credit-refresh',credits:current};
    }
  }

  let used=creditCycleUsage(db,cycle);
  const target=Number(BASE_DAILY_PRODUCTION_LIMIT||1);
  const openedMs=Date.parse(String(cycle.opened_at||''));
  const ageMs=Number.isFinite(openedMs)?Date.now()-openedMs:0;
  setMeta(db,'flow:dailyCreditCycleUsed',String(used));
  setMeta(db,'flow:dailyCreditCycleTarget',String(target));

  // Capture the post-batch balance exactly once. This is the clean baseline from
  // which the next 50-credit refresh is detected (normally +45 after 3×15 spends,
  // because the unused 5 daily credits expire instead of rolling over).
  if(used>=target&&!cycle.post_batch_baseline_captured){
    try{
      const sync=await syncVisibleFlowCredits(db,{force:true,maxAgeMs:0});
      cycle={...cycle,last_balance:Number(sync.credits),last_checked_at:sync.checkedAt,post_batch_baseline_captured:true,post_batch_balance:Number(sync.credits),post_batch_baseline_at:sync.checkedAt};
      persistCreditCycle(db,cycle);
      publish('DAILY_FLOW_POST_BATCH_BALANCE_CAPTURED',{cycle_id:cycle.id,credits:sync.credits,used,target});
    }catch(err){
      publish('DAILY_FLOW_POST_BATCH_BALANCE_PENDING',{cycle_id:cycle.id,message:compact(err?.message||err,240)});
    }
  }

  // Until the refresh window approaches, finish the current cycle if slots remain.
  if(ageMs<CREDIT_REFRESH_GUARD_MS){
    const open=used<target;
    setMeta(db,'flow:dailyCreditBatchOpen',open?'true':'false');
    setMeta(db,'flow:dailyCreditRefreshWaiting',open?'false':'true');
    if(!open){
      setMeta(db,'flow:state','ESPERANDO CRÉDITOS');
      setMeta(db,'flow:currentStep','waiting-daily-credit-refresh');
      setMeta(db,'flow:message','Lote de '+target+' generaciones completo. Esperando la próxima renovación diaria de 50 créditos de Flow; el cambio de fecha no abre un lote nuevo.');
    }
    return{open,used,target,cycle,reason:open?'current-credit-cycle-open':'batch-complete-waiting-refresh'};
  }

  // Inside the renewal window we deliberately stop automatic production until
  // the Flow balance proves that the new daily allocation arrived.
  let sync=null;
  try{sync=await syncVisibleFlowCredits(db,{force:false,maxAgeMs:CREDIT_REFRESH_POLL_MS})}catch(err){
    setMeta(db,'flow:dailyCreditBatchOpen','false');
    setMeta(db,'flow:dailyCreditRefreshWaiting','true');
    setMeta(db,'flow:state','ESPERANDO CRÉDITOS');
    setMeta(db,'flow:currentStep','waiting-daily-credit-refresh');
    setMeta(db,'flow:message','Esperando la renovación diaria de créditos. La lectura de saldo falló de forma transitoria; no se usarán créditos mensuales por calendario.');
    return{open:false,used,target,cycle,reason:'credit-refresh-read-failed',error:compact(err?.message||err,240)};
  }

  const current=Number(sync.credits);
  const previous=parseVisibleCreditNumber(cycle.last_balance);
  let renewed=false,renewalReason='';
  if(previous!==null&&current>previous){
    const delta=current-previous;
    // 3 canonical generations cost 45 credits. Because unused daily credits do
    // not roll over, the visible combined balance normally rises by 45-50.
    // For an incomplete prior cycle, smaller positive refills can be legitimate.
    const knownSpend=Math.min(DAILY_FLOW_GRANT_CREDITS,Math.max(0,used*CREDITS_PER_GENERATION));
    const minExpected=Math.max(10,Math.min(DAILY_FLOW_GRANT_CREDITS,knownSpend)-10);
    if(delta>=minExpected&&delta<=DAILY_FLOW_GRANT_CREDITS+10){
      renewed=true;
      renewalReason='Visible Flow balance increased by '+delta+' credits after the prior credit cycle.';
    }
  }

  cycle={...cycle,last_balance:current,last_checked_at:sync.checkedAt};
  persistCreditCycle(db,cycle);

  // Safety fallback: a daily allocation can replace unspent daily credits and
  // therefore produce little/no net balance increase. After a wide 30h window,
  // a sufficient live balance is accepted as renewal evidence rather than
  // stalling forever. This path never fires early and never keys off midnight.
  if(!renewed&&ageMs>=CREDIT_REFRESH_FALLBACK_MS&&current>=DAILY_BATCH_CREDIT_COST){
    renewed=true;
    renewalReason='Timed renewal fallback after '+Math.round(ageMs/3600000)+'h with at least '+DAILY_BATCH_CREDIT_COST+' live Flow credits visible; protects against non-rollover masking the balance delta.';
  }

  if(renewed){
    const next=openDailyCreditCycle(db,current,'daily-flow-credit-refresh',renewalReason);
    return{open:true,used:0,target,cycle:next,reason:'daily-flow-credit-refresh',credits:current};
  }

  setMeta(db,'flow:dailyCreditBatchOpen','false');
  setMeta(db,'flow:dailyCreditRefreshWaiting','true');
  setMeta(db,'flow:state','ESPERANDO CRÉDITOS');
  setMeta(db,'flow:currentStep','waiting-daily-credit-refresh');
  setMeta(db,'flow:message','Esperando que Google Flow renueve los 50 créditos diarios. Saldo visible: '+current+'. No se iniciará el lote automático por cambio de fecha.');
  publish('WAITING_DAILY_FLOW_CREDIT_REFRESH',{cycle_id:cycle.id,credits:current,previous_balance:previous,used,target,cycle_age_hours:Math.round(ageMs/360000)/10,grant_credits:DAILY_FLOW_GRANT_CREDITS});
  return{open:false,used,target,cycle,reason:'waiting-daily-credit-refresh',credits:current};
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

function feedbackContext(db,row){
  const prior=db.prepare("SELECT episode,hook,story,status FROM factory_items WHERE season=? AND episode<? ORDER BY episode DESC LIMIT 12").all(Number(row.season),Number(row.episode)).reverse();
  const future=db.prepare("SELECT episode,hook,story,status FROM factory_items WHERE season=? AND episode>? ORDER BY episode LIMIT 8").all(Number(row.season),Number(row.episode));
  return{
    show_name:String(CONFIG.identity?.show_name||SHOW||'Publisher'),
    serialized:Boolean(CONFIG.content?.serialized),
    creative_bible:compact(CONFIG.content?.creative_bible||'',12000),
    season:Number(row.season),episode:Number(row.episode),
    current:{hook:String(row.hook||''),story:String(row.story||''),prompt:compact(row.prompt||'',5000)},
    feedback:String(row.reviewFeedback||'').trim(),
    prior:prior.map(x=>({episode:Number(x.episode),hook:String(x.hook||''),story:String(x.story||''),status:String(x.status||'')})),
    future:future.map(x=>({episode:Number(x.episode),hook:String(x.hook||''),story:String(x.story||''),status:String(x.status||'')}))
  };
}
function validateAiFeedbackResult(raw,row){
  if(!raw||typeof raw!=='object')throw new Error('FEEDBACK_AI_INVALID_OBJECT');
  const decision=String(raw.decision||'').trim();
  if(!['render_retry','prompt_revision','creative_rewrite'].includes(decision))throw new Error('FEEDBACK_AI_INVALID_DECISION:'+decision);
  const reason=compact(raw.reason||'',1400);
  if(!reason)throw new Error('FEEDBACK_AI_REASON_MISSING');
  const out={
    decision,reason,
    prompt_changes:compact(raw.prompt_changes||'',1600),
    new_hook:compact(raw.new_hook||'',100).toUpperCase(),
    new_story:compact(raw.new_story||'',1200),
    new_information:compact(raw.new_information||'',600)
  };
  if(decision==='prompt_revision'&&!out.prompt_changes)throw new Error('FEEDBACK_AI_PROMPT_CHANGES_MISSING');
  if(decision==='creative_rewrite'){
    if(!out.new_hook||!out.new_story||!out.new_information)throw new Error('FEEDBACK_AI_CREATIVE_PACKAGE_INCOMPLETE');
    if(norm(out.new_hook+' '+out.new_story)===norm(String(row.hook||'')+' '+String(row.story||'')))throw new Error('FEEDBACK_AI_REPEATED_SAME_STORY');
  }
  return out;
}
async function geminiFeedbackInterpretation(db,row){
  publish('FEEDBACK_AI_STAGE',{episode:'T'+row.season+'E'+row.episode,stage:'launch-browser'});
  const session=await launchLocal();
  const marker='PUBLISHER_AI_'+randomUUID().replace(/-/g,'').slice(0,16).toUpperCase();
  const start=marker+'_START',end=marker+'_END';
  try{
    const page=session.page;
    await page.goto(GEMINI_FEEDBACK_URL,{waitUntil:'domcontentloaded',timeout:45000});
    await sleep(1800);
    for(const re of [/I agree|Acepto/i,/Get started|Empezar/i,/Continue|Continuar/i]){
      const btn=page.getByRole('button',{name:re}).last();
      if(await btn.count().catch(()=>0)&&await btn.isVisible().catch(()=>false)){await btn.click({timeout:3000}).catch(()=>{});await sleep(700)}
    }
    const body0=compact(await page.locator('body').innerText().catch(()=>''),5000);
    let input=null;
    for(const candidate of [
      page.locator('rich-textarea div[contenteditable="true"]').last(),
      page.locator('div[contenteditable="true"][role="textbox"]').last(),
      page.locator('div[contenteditable="true"]').last(),
      page.locator('textarea').last()
    ]){
      if(await candidate.count().catch(()=>0)&&await candidate.isVisible().catch(()=>false)){input=candidate;break}
    }
    if(!input)throw new Error('FEEDBACK_AI_GEMINI_INPUT_NOT_FOUND:'+body0.slice(0,500));
    const ctx=feedbackContext(db,row);
    const instruction=[
      'You are the semantic review interpreter for an autonomous short-form video Publisher.',
      'Understand the HUMAN feedback by meaning, not by keywords or spelling.',
      'The Show Bible is authoritative. Never invent a change that contradicts it.',
      'Choose exactly one action:',
      'render_retry = story, prompt and metadata are correct; only the stochastic render/glitch failed.',
      'prompt_revision = the SAME episode idea is correct but execution instructions must change.',
      'creative_rewrite = the reviewer rejects the premise, continuity, repeated information, narrative event, chosen place/topic, or what the audience is learning; create a materially different episode idea that still obeys the Show Bible.',
      '',
      'For serialized shows, preserve accepted continuity and do not re-reveal information the audience already knows.',
      'For non-serialized shows, still avoid repeating the rejected concept and produce a genuinely distinct replacement.',
      'Human feedback is authoritative even when dictated, misspelled, informal or incomplete.',
      '',
      'Return exactly ONE JSON object between the markers, with no prose outside them.',
      start,
      '{"decision":"render_retry|prompt_revision|creative_rewrite","reason":"semantic explanation","prompt_changes":"required only for prompt_revision","new_hook":"short hook required only for creative_rewrite","new_story":"replacement episode intent required only for creative_rewrite","new_information":"what is genuinely different/new required only for creative_rewrite"}',
      end,
      '',
      'PUBLISHER CONTEXT JSON:',
      JSON.stringify(ctx)
    ].join('\n');
    await input.click({timeout:5000});
    await input.fill(instruction).catch(async()=>{await page.keyboard.press('Control+A').catch(()=>{});await page.keyboard.insertText(instruction)});
    let sent=false;
    for(const re of [/Send message|Enviar mensaje|Send|Enviar/i]){
      const b=page.getByRole('button',{name:re}).last();
      if(await b.count().catch(()=>0)&&await b.isVisible().catch(()=>false)&&await b.isEnabled().catch(()=>false)){await b.click({timeout:4000}).catch(()=>{});sent=true;break}
    }
    if(!sent)await page.keyboard.press('Enter');
    const deadline=Date.now()+60000;
    let parsed=null,lastBody='';
    while(Date.now()<deadline){
      await sleep(1000);
      lastBody=await page.locator('body').innerText().catch(()=>lastBody);
      const pos=lastBody.lastIndexOf(start);
      if(pos>=0){
        const e=lastBody.indexOf(end,pos+start.length);
        if(e>pos){
          const raw=lastBody.slice(pos+start.length,e).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
          try{parsed=JSON.parse(raw)}catch{}
          if(parsed)break;
        }
      }
    }
    if(!parsed)throw new Error('FEEDBACK_AI_GEMINI_RESPONSE_NOT_PARSED:'+compact(lastBody.slice(-1800),1800));
    return validateAiFeedbackResult(parsed,row);
  }finally{await session.close().catch(()=>{})}
}
function applyAiFeedbackDecision(db,row,ai){
  const stamp=now();
  const interpretation=JSON.stringify({...ai,interpreted_at:stamp,engine:'gemini-web-semantic'});
  if(ai.decision==='render_retry'){
    db.prepare("UPDATE factory_items SET status='regen_wait',retryStrategy='reuse_prompt',reviewInterpretation=?,reviewInterpretationAt=?,providerRunId=NULL,flowResult=NULL,error='AI: creative package is correct; repeat render only.',nextTry=0,runtimeAttemptCount=0,updatedAt=? WHERE id=?")
      .run(interpretation,stamp,stamp,row.id);
  }else if(ai.decision==='prompt_revision'){
    db.prepare("UPDATE factory_items SET status='regen_wait',retryStrategy='revise_prompt',reviewInterpretation=?,reviewInterpretationAt=?,prompt='',promptHash=NULL,promptGenerationId=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,creativePackageHash=NULL,creativePackageId=NULL,providerRunId=NULL,flowResult=NULL,error='AI: keep episode intent and rebuild prompt from human feedback.',nextTry=0,runtimeAttemptCount=0,updatedAt=? WHERE id=?")
      .run(interpretation,stamp,stamp,row.id);
  }else{
    db.prepare("UPDATE factory_items SET hook=?,story=?,status='regen_wait',retryStrategy='new_story',reviewInterpretation=?,reviewInterpretationAt=?,prompt='',promptHash=NULL,promptGenerationId=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,title='',description='',creativePackageHash=NULL,creativePackageId=NULL,providerRunId=NULL,flowResult=NULL,error='AI: narrative feedback requires a new creative package.',nextTry=0,runtimeAttemptCount=0,updatedAt=? WHERE id=?")
      .run(ai.new_hook,ai.new_story,interpretation,stamp,stamp,row.id);
    const freshForPackage=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id);
    materializeCreativePackage(db,freshForPackage,{force:true});
  }
  const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row;
  setLifecycle(db,fresh,'RETRY_REQUESTED',{
    generation_id:null,generation_started_at:null,submit_boundary_at:null,
    baseline:[],baseline_inventory:null,last_error:null,retry_at:null,
    reviewer_retry:true,retry_token:String(fresh.reviewRetryToken||''),
    review_feedback:String(fresh.reviewFeedback||'').slice(0,1200),
    retry_strategy:String(fresh.retryStrategy||''),
    ai_interpretation:interpretation,retry_requested_at:stamp,
    automatic_submit_forbidden:false
  });
  return fresh;
}
async function interpretPendingReviewFeedback(db){
  const row=db.prepare("SELECT * FROM factory_items WHERE status='feedback_wait' AND retryStrategy='ai_pending' AND reviewFeedback IS NOT NULL AND nextTry<=? ORDER BY updatedAt,episode LIMIT 1").get(Date.now());
  if(!row)return'none';
  publish('FEEDBACK_AI_INTERPRET_START',{episode:'T'+row.season+'E'+row.episode,job_id:row.id,message:'Semantic AI is interpreting the complete human feedback before deciding render retry, prompt revision, or creative rewrite.'});
  try{
    const ai=await geminiFeedbackInterpretation(db,row);
    publish('FEEDBACK_AI_RESULT',{episode:'T'+row.season+'E'+row.episode,job_id:row.id,decision:ai.decision,reason:ai.reason,new_hook:ai.new_hook||null,new_information:ai.new_information||null});
    const fresh=applyAiFeedbackDecision(db,row,ai);
    publish('FEEDBACK_AI_INTERPRET_DONE',{episode:'T'+fresh.season+'E'+fresh.episode,job_id:fresh.id,decision:ai.decision,reason:ai.reason});
    return'ready';
  }catch(err){
    const attempts=Number(row.runtimeAttemptCount||0)+1;
    const retryAt=Date.now()+Math.min(15*60*1000,60000*Math.max(1,attempts));
    db.prepare("UPDATE factory_items SET runtimeAttemptCount=?,error=?,nextTry=?,updatedAt=? WHERE id=?")
      .run(attempts,'AI feedback interpretation pending: '+compact(err?.message||err,500),retryAt,now(),row.id);
    publish('FEEDBACK_AI_INTERPRET_RETRY',{episode:'T'+row.season+'E'+row.episode,job_id:row.id,retry_at:new Date(retryAt).toISOString(),message:compact(err?.message||err,500)});
    return'retry';
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
  const settingsBody=await getBody(page).catch(()=>'');
  if(/Confirm before generating|Confirmar antes de generar/i.test(settingsBody)){
    await clickRadio(page,/^(?:Never|Nunca)$/i,'confirm-never');
  }
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
  await closeFlowSettings(page,{timeout:9000});
  await sleep(250);

  let summary=label;
  try{summary=compact(await(await settingsButton(page)).innerText(),340)||summary}catch{}
  // Do not re-infer the selected values after closing Flow's settings sheet.
  // The current UI collapses to an icon-only "tune" button, so the selected
  // values disappear from accessible text. The hard gates are the successful
  // checked clicks above (Video, 9:16, Omni Flash, x1).
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
    if(bn.length>180)continue;
    const actionLike=/^(si|yes|generar|generate|confirmar|confirm|continuar|continue|aprobar|approve)(\b|\s|,|\.)/.test(bn)||
      /^(si|yes)\s*,?\s*(generar|generate)\b/.test(bn)||
      /^(generar|generate)\s+video\b/.test(bn);
    if(!actionLike)continue;
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
  const busy=page.locator('text=/Generating|Processing|Rendering|Creating video|Generando|Procesando|Starting generation|Initiating|Creando video|Preparando video|Thinking|Pensando/i');
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
  return{started:Boolean(freshVideo||freshInventory),freshVideo,freshInventory,controlTransition,visibleBusy,sendVisible,sendDisabled,inventory:inv,videos:vids};
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
    if(n.length>180)continue;
    const actionLike=/^(si|yes|generar|generate|confirmar|confirm|continuar|continue|aprobar|approve)(\b|\s|,|\.)/.test(n)||
      /^(si|yes)\s*,?\s*(generar|generate)\b/.test(n)||
      /^(generar|generate)\s+video\b/.test(n);
    if(!actionLike)continue;
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
function consentActionFingerprint(action){
  if(!action)return'';
  const y=Math.round(Number(action?.box?.y||0)/8)*8;
  return sha(norm(String(action.label||''))+'|'+norm(String(action.context||''))+'|'+String(y));
}
async function visibleDialogFingerprints(page){
  const out=new Set(),dialogs=page.getByRole('dialog');
  for(let i=0;i<Math.min(await dialogs.count().catch(()=>0),30);i++){
    const d=dialogs.nth(i);if(!(await d.isVisible().catch(()=>false)))continue;
    const t=norm(await d.innerText().catch(()=>''));
    if(t)out.add(sha(t));
  }
  return out;
}
async function clickSubmitExactlyOnce(page){
  const preConsent=await findGenerationConsentAction(page).catch(()=>null);
  const preConsentFingerprint=consentActionFingerprint(preConsent);
  const preDialogs=await visibleDialogFingerprints(page);
  const send=await generationSendButton(page,false);
  if(!(await send.isVisible().catch(()=>false))||!(await send.isEnabled().catch(()=>false)))throw new Error('START_GENERATION_BUTTON_NOT_READY');
  await trustedClick(send);
  publish('SUBMIT_ARROW_CLICKED',{message:'Flow generation send control clicked exactly once.',control:compact(((await send.getAttribute('aria-label').catch(()=>''))||'')+' '+((await send.innerText().catch(()=>''))||''),140)});

  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
    const action=await findGenerationConsentAction(page).catch(()=>null);
    if(action){
      const fp=consentActionFingerprint(action);
      if(preConsentFingerprint&&fp===preConsentFingerprint){
        publish('STALE_CONSENT_IGNORED',{label:compact(action.label,140),message:'Pre-existing Flow permission control ignored; only a new post-submit consent may be accepted.'});
      }else{
        await trustedClick(action.el);
        const mode=/always approve|approve always|aprobar siempre/.test(norm(action.label))?'approve-always':'confirmation-point-cost';
        publish('POINT_CONSENT_CLICKED',{label:compact(action.label,140),context:compact(action.context,500),message:mode==='approve-always'?'Current Flow consent set to Always approve exactly once.':'Current Flow point-cost confirmation accepted exactly once.'});
        await sleep(700);
        return{mode,pre_consent_fingerprint:preConsentFingerprint};
      }
    }

    const dialogs=page.getByRole('dialog');
    for(let d=(await dialogs.count().catch(()=>0))-1;d>=0;d--){
      const dialog=dialogs.nth(d);
      if(!(await dialog.isVisible().catch(()=>false)))continue;
      const dialogText=norm(await dialog.innerText().catch(()=>''));
      if(dialogText&&preDialogs.has(sha(dialogText)))continue;
      const gen=dialog.getByRole('button',{name:/^(Generate|Generar|Confirm|Confirmar)$/i}).last();
      if(await gen.count().catch(()=>0)&&await gen.isVisible().catch(()=>false)&&await gen.isEnabled().catch(()=>false)){
        await trustedClick(gen);
        publish('POINT_CONSENT_CLICKED',{label:compact(await gen.innerText().catch(()=>''),120),message:'New post-submit Flow generation confirmation accepted exactly once.'});
        await sleep(700);
        return{mode:'confirmation-dialog',pre_consent_fingerprint:preConsentFingerprint};
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
  publish('POST_ARROW_NO_CONSENT',{message:'No new post-submit point-cost confirmation was detected after the generation arrow.',body:compact(await getBody(page),1600),buttons:visibleButtons.slice(-30)});
  return{mode:'start-generation-direct',pre_consent_fingerprint:preConsentFingerprint};
}

async function renderAuthGuard(page){
  const url=String(page.url()||'');
  if(/accounts\.google\.com|signin|ServiceLogin/i.test(url))throw new Error('FLOW_AUTH_REQUIRED_DURING_RENDER');
  const text=(await getBody(page)).slice(0,12000);
  if(/verify it'?s you|verifica que eres t[uú]|captcha|security check|verificaci[oó]n de seguridad/i.test(text))throw new Error('FLOW_AUTH_CHALLENGE_DURING_RENDER');
  return true;
}

function enrichFlowAsset(raw={}){
  const seed=String(raw.identity_seed||'').trim();
  const signature=String(raw.signature||'').trim();
  const strength=seed?'strong':'weak';
  const identitySource=seed||('signature:'+signature);
  return{...raw,asset_id:sha(identitySource),identity_strength:strength};
}
async function visibleFlowVideoAssets(page){
  const raw=await page.evaluate(()=>{
    const visible=el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20;};
    const compact=s=>String(s||'').replace(/\s+/g,' ').trim();
    const safeUrl=v=>{
      if(!v)return'';
      try{
        const u=new URL(String(v),location.href);
        if(u.protocol==='blob:')return'';
        const kept=[];
        for(const [k,val] of u.searchParams.entries()){
          if(/^(?:id|asset|media|generation|video|name|key)$/i.test(k)&&String(val).length<220)kept.push(k+'='+val);
        }
        return u.origin+u.pathname+(kept.length?'?'+kept.sort().join('&'):'');
      }catch{return''}
    };
    const descriptor=(node,domIndex)=>{
      const signature=compact(node.getAttribute('aria-label')||node.innerText||node.textContent||'').slice(0,500);
      const identityParts=[];
      const attrs=[];
      const collect=(el,prefix)=>{
        if(!el?.getAttributeNames)return;
        for(const name of el.getAttributeNames()){
          const value=compact(el.getAttribute(name));
          if(!value||value.length>1800)continue;
          if(/^(?:id|data-|aria-label|href|src|poster|name|title)/i.test(name))attrs.push(prefix+name+'='+value.slice(0,500));
          if(/(?:^id$|data-.*(?:id|key|asset|media|generation|video)|(?:asset|media|generation|video)[-_]?id)/i.test(name)&&value.length>=4){
            identityParts.push(prefix+name+'='+value.slice(0,500));
          }
          if(/^(?:href|src|poster)$/i.test(name)){
            const u=safeUrl(value);if(u)identityParts.push(prefix+name+'='+u);
          }
        }
      };
      collect(node,'tile:');
      const descendants=[...node.querySelectorAll('flow-video-tile,video,source,img,a,[data-id],[data-asset-id],[data-media-id],[data-generation-id]')].slice(0,40);
      descendants.forEach((el,i)=>{
        collect(el,'d'+i+':');
        for(const prop of ['currentSrc','src','poster','href']){
          let v='';try{v=el[prop]||''}catch{}
          const u=safeUrl(v);if(u)identityParts.push('d'+i+':'+prop+'='+u);
        }
      });
      return{dom_index:domIndex,signature,identity_seed:[...new Set(identityParts)].sort().join('|').slice(0,12000),attributes:[...new Set(attrs)].slice(0,120)};
    };
    const all=[...document.querySelectorAll('flow-grid-tile-container')];
    const visibleTiles=all.filter(visible);
    const videoNodes=all.map((el,i)=>({el,i})).filter(x=>visible(x.el)&&Boolean(x.el.querySelector('flow-video-tile,video')));
    const sigs=visibleTiles.map(el=>compact(el.getAttribute('aria-label')||el.innerText||el.textContent||'').slice(0,220)).filter(Boolean);
    const body=compact(document.body?.innerText||'');
    return{
      tile_count:visibleTiles.length,
      ordered_signatures:sigs.slice(0,120),
      video_assets:videoNodes.slice(0,120).map(x=>descriptor(x.el,x.i)),
      busy:/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation|thinking|pensando/i.test(body)||/\bStop\b|\bDetener\b/i.test(body)
    };
  }).catch(()=>null);
  if(!raw)return[];
  return (raw.video_assets||[]).map(enrichFlowAsset);
}
async function captureFlowInventory(page){
  try{
    const raw=await page.evaluate(()=>{
      const visible=el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20;};
      const compact=s=>String(s||'').replace(/\s+/g,' ').trim();
      const safeUrl=v=>{
        if(!v)return'';
        try{
          const u=new URL(String(v),location.href);
          if(u.protocol==='blob:')return'';
          const kept=[];
          for(const [k,val] of u.searchParams.entries()){
            if(/^(?:id|asset|media|generation|video|name|key)$/i.test(k)&&String(val).length<220)kept.push(k+'='+val);
          }
          return u.origin+u.pathname+(kept.length?'?'+kept.sort().join('&'):'');
        }catch{return''}
      };
      const descriptor=(node,domIndex)=>{
        const signature=compact(node.getAttribute('aria-label')||node.innerText||node.textContent||'').slice(0,500);
        const parts=[];
        const collect=(el,prefix)=>{
          if(!el?.getAttributeNames)return;
          for(const name of el.getAttributeNames()){
            const value=compact(el.getAttribute(name));
            if(!value||value.length>1800)continue;
            if(/(?:^id$|data-.*(?:id|key|asset|media|generation|video)|(?:asset|media|generation|video)[-_]?id)/i.test(name)&&value.length>=4)parts.push(prefix+name+'='+value.slice(0,500));
            if(/^(?:href|src|poster)$/i.test(name)){const u=safeUrl(value);if(u)parts.push(prefix+name+'='+u)}
          }
        };
        collect(node,'tile:');
        [...node.querySelectorAll('flow-video-tile,video,source,img,a,[data-id],[data-asset-id],[data-media-id],[data-generation-id]')].slice(0,40).forEach((el,i)=>{
          collect(el,'d'+i+':');
          for(const prop of ['currentSrc','src','poster','href']){let v='';try{v=el[prop]||''}catch{}const u=safeUrl(v);if(u)parts.push('d'+i+':'+prop+'='+u)}
        });
        return{dom_index:domIndex,signature,identity_seed:[...new Set(parts)].sort().join('|').slice(0,12000)};
      };
      const all=[...document.querySelectorAll('flow-grid-tile-container')];
      const tiles=all.filter(visible);
      const videoNodes=all.map((el,i)=>({el,i})).filter(x=>visible(x.el)&&Boolean(x.el.querySelector('flow-video-tile,video')));
      const sigs=tiles.map(el=>compact(el.getAttribute('aria-label')||el.innerText||el.textContent||'').slice(0,220)).filter(Boolean);
      const body=compact(document.body?.innerText||'');
      return{
        tile_count:tiles.length,ordered_signatures:sigs.slice(0,120),signatures:[...new Set(sigs)].slice(0,120),
        video_tile_count:videoNodes.length,
        raw_video_assets:videoNodes.slice(0,120).map(x=>descriptor(x.el,x.i)),
        busy:/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation|thinking|pensando/i.test(body)||/\bStop\b|\bDetener\b/i.test(body)
      };
    });
    const assets=(raw.raw_video_assets||[]).map(enrichFlowAsset);
    const videoSigs=assets.map(x=>String(x.signature||'').slice(0,220)).filter(Boolean);
    return{
      tile_count:Number(raw.tile_count||0),
      ordered_signatures:Array.isArray(raw.ordered_signatures)?raw.ordered_signatures:[],
      signatures:Array.isArray(raw.signatures)?raw.signatures:[],
      video_tile_count:assets.length,
      ordered_video_signatures:videoSigs,
      video_signatures:[...new Set(videoSigs)],
      ordered_video_assets:assets.map(x=>({asset_id:x.asset_id,identity_strength:x.identity_strength,signature:x.signature,dom_index:x.dom_index})),
      video_asset_ids:assets.map(x=>x.asset_id),
      busy:Boolean(raw.busy)
    };
  }catch{return{tile_count:0,ordered_signatures:[],signatures:[],video_tile_count:0,ordered_video_signatures:[],video_signatures:[],ordered_video_assets:[],video_asset_ids:[],busy:false}}
}

function recoveredFlowAssetIds(db){
  const ids=new Set();
  try{for(const r of db.prepare("SELECT assetId FROM flow_recovered_assets").all())if(r.assetId)ids.add(String(r.assetId))}catch{}
  try{
    for(const r of db.prepare("SELECT flowResult FROM factory_items WHERE flowResult IS NOT NULL").all()){
      let f={};try{f=JSON.parse(String(r.flowResult||'{}'))||{}}catch{}
      for(const v of [f.flow_asset_id,f.viewer_asset_id])if(v)ids.add(String(v));
    }
  }catch{}
  return ids;
}
function recoveredFlowSignatures(db){
  const sigs=new Set();
  try{for(const r of db.prepare("SELECT signature FROM flow_recovered_assets WHERE signature IS NOT NULL").all())if(r.signature)sigs.add(norm(r.signature))}catch{}
  try{
    for(const r of db.prepare("SELECT flowResult FROM factory_items WHERE flowResult IS NOT NULL").all()){
      let f={};try{f=JSON.parse(String(r.flowResult||'{}'))||{}}catch{}
      for(const v of [f.recovery_signature,f.matched_label])if(v)sigs.add(norm(v));
    }
  }catch{}
  return sigs;
}

function inventoryHasNew(current,baseline){
  if(!baseline)return false;
  if(Number(current?.video_tile_count||0)>Number(baseline?.video_tile_count||0))return true;
  const before=new Map();
  for(const sig of (Array.isArray(baseline?.ordered_video_signatures)?baseline.ordered_video_signatures:[]))before.set(sig,(before.get(sig)||0)+1);
  const after=Array.isArray(current?.ordered_video_signatures)?current.ordered_video_signatures:[];
  for(const sig of after){const n=before.get(sig)||0;if(n>0)before.set(sig,n-1);else return true;}
  return false;
}

function episodeRecoveryTerms(row){
  const raw=[
    String(row?.title||''),
    String(row?.hook||''),
    String(row?.story||'').slice(0,500)
  ].join(' ');
  const stop=new Set(['dinnie','dinosaur','episode','the','and','with','from','this','that','into','your','show','video','next','chapter','continue','configured','creative','bible','canon','previous','accepted','beat']);
  const words=raw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/[a-z0-9]{4,}/g)||[];
  return [...new Set(words.filter(w=>!stop.has(w)))].slice(0,12);
}

async function openEpisodeCorrelatedResult(page,row,baselineInv=null,db=null){
  const terms=episodeRecoveryTerms(row);
  if(!terms.length)return{found:false,signal:'no-specific-recovery-terms',matched:[]};
  const inv=await captureFlowInventory(page);
  const baselineIds=new Set((baselineInv?.ordered_video_assets||[]).map(x=>String(x?.asset_id||'')).filter(Boolean));
  const baselineSigs=new Map();
  for(const sig of (Array.isArray(baselineInv?.ordered_video_signatures)?baselineInv.ordered_video_signatures:[]))baselineSigs.set(norm(sig),(baselineSigs.get(norm(sig))||0)+1);
  const usedIds=db?recoveredFlowAssetIds(db):new Set();
  const usedSigs=db?recoveredFlowSignatures(db):new Set();
  const candidates=[];
  for(const a of (inv.ordered_video_assets||[])){
    const id=String(a?.asset_id||''),sig=String(a?.signature||''),n=norm(sig);
    if(id&&baselineIds.has(id))continue;
    if(!baselineIds.size){
      const left=baselineSigs.get(n)||0;
      if(left>0){baselineSigs.set(n,left-1);continue}
    }
    if(id&&usedIds.has(id))continue;
    if(String(a?.identity_strength||'')!=='strong'&&usedSigs.has(n))continue;
    const matched=terms.filter(t=>n.includes(t));
    candidates.push({...a,matched,score:matched.length});
  }
  candidates.sort((a,b)=>b.score-a.score||Number(a.dom_index)-Number(b.dom_index));
  const best=candidates[0];
  if(!best||best.score<2||best.score===Number(candidates[1]?.score||-1)){
    return{found:false,signal:'no-unique-correlated-visible-asset',matched:best?.matched||[],label:best?.signature||'',asset_id:best?.asset_id||null,candidates:candidates.slice(0,8)};
  }
  const opened=await openVerifiedFlowAsset(page,best,{db,row,signal:'correlated-visible-asset-download-ready'});
  if(opened?.ready)return{found:true,signal:opened.signal,matched:best.matched,label:best.signature,index:best.dom_index,asset_id:best.asset_id,viewer_asset_id:opened.viewer_asset_id||null,identity_strength:best.identity_strength};
  return{found:false,signal:opened?.signal||'correlated-asset-not-ready',matched:best.matched,label:best.signature,index:best.dom_index,asset_id:best.asset_id};
}

async function reconcileAmbiguousGeneric(page,row,lc,db){
  const baselineInv=lc?.baseline_inventory||null;
  const boundary=Date.parse(String(lc?.submit_boundary_at||''));
  const age=Number.isFinite(boundary)?Date.now()-boundary:0;
  let currentInv=await captureFlowInventory(page);
  let body=(await getBody(page)).slice(0,14000);

  const lateConsent=await findGenerationConsentAction(page).catch(()=>null);
  if(lateConsent){
    const lateFp=consentActionFingerprint(lateConsent);
    if(String(lc?.pre_consent_fingerprint||'')&&lateFp===String(lc.pre_consent_fingerprint)){
      publish('STALE_CONSENT_IGNORED',{
        episode:'T'+row.season+'E'+row.episode,job_id:row.id,
        label:compact(lateConsent.label,160),
        message:'Delayed permission control matches the pre-submit snapshot and will not be clicked.'
      });
    }else{
      await trustedClick(lateConsent.el);
      publish('LATE_POINT_CONSENT_RECOVERED',{
        episode:'T'+row.season+'E'+row.episode,job_id:row.id,
        label:compact(lateConsent.label,160),
        message:'New delayed Flow generation consent accepted once; generation remains unconfirmed until a fresh video result appears.'
      });
      await sleep(900);
      currentInv=await captureFlowInventory(page);
      body=(await getBody(page)).slice(0,14000);
    }
  }

  const visibleBusy=currentInv.busy||/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation/i.test(body)||/\bStop\b|\bDetener\b/i.test(body);
  const baselineUsable=Boolean(
    baselineInv&&
    Number.isFinite(Number(baselineInv.video_tile_count))&&
    Array.isArray(baselineInv.ordered_video_signatures||baselineInv.video_signatures)
  );
  const fresh=baselineUsable&&inventoryHasNew(currentInv,baselineInv);

  if(fresh){
    const startedAt=String(lc?.generation_started_at||lc?.submit_boundary_at||now());
    const next=setLifecycle(db,row,'GENERATION_STARTED',{
      ...lc,generation_started_at:startedAt,
      evidence:`ambiguous-reconciled-by-fresh-video;videoTiles=${baselineInv?.video_tile_count||0}->${currentInv.video_tile_count||0}`,
      reconciled_at:now(),automatic_submit_forbidden:true
    });
    db.prepare("UPDATE factory_items SET status='generating',error=NULL,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
    publish('AMBIGUOUS_RECONCILED_GENERATION',{episode:`T${row.season}E${row.episode}`,job_id:row.id,evidence:next.evidence});
    return{mode:'retrieve',lifecycle:next};
  }

  if(!visibleBusy&&age>=20000){
    const correlated=await openEpisodeCorrelatedResult(page,row,baselineInv,db).catch(()=>null);
    if(correlated?.found){
      const startedAt=String(lc?.generation_started_at||lc?.submit_boundary_at||now());
      const next=setLifecycle(db,row,'GENERATION_STARTED',{
        ...lc,generation_started_at:startedAt,
        evidence:'ambiguous-reconciled-by-'+correlated.signal,
        matched_label:correlated.label,matched_terms:correlated.matched,
        reconciled_at:now(),automatic_submit_forbidden:true
      });
      db.prepare("UPDATE factory_items SET status='generating',error=NULL,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
      publish('AMBIGUOUS_CORRELATED_RENDER',{episode:'T'+row.season+'E'+row.episode,job_id:row.id,label:correlated.label,matched:correlated.matched,signal:correlated.signal});
      return{mode:'retrieve',lifecycle:next};
    }
    publish('AMBIGUOUS_CORRELATION_DIAGNOSTIC',{
      episode:'T'+row.season+'E'+row.episode,job_id:row.id,
      terms:episodeRecoveryTerms(row),
      samples:(currentInv?.ordered_video_signatures||currentInv?.video_signatures||[]).slice(0,18),
      busy_supporting_only:Boolean(visibleBusy),page_body:compact(body,1800)
    });
  }

  // POST_SUBMIT_TIMEOUT_RECONCILIATION_ONLY
  // SOP invariant: elapsed time plus an unchanged project grid is NOT positive
  // proof that Google Flow did not accept the submit. Once the exactly-once
  // boundary has been crossed, this job remains read-only recovery/reconciliation
  // until a fresh asset, an explicit provider no-charge/failure signal, or a new
  // human-authorized intent supplies stronger evidence.
  if(baselineInv&&age>=5*60*1000&&!fresh&&!visibleBusy){
    publish('AMBIGUOUS_TIMEOUT_REMAINS_LOCKED',{
      episode:'T'+row.season+'E'+row.episode,job_id:row.id,
      age_seconds:Math.round(age/1000),
      message:'Timeout alone cannot authorize another Generate click; serial lock remains held.'
    });
  }

  const retryAt=Date.now()+60000;
  db.prepare("UPDATE factory_items SET status='generating',error=?,nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?").run(
    'SUBMIT_AMBIGUOUS — awaiting hard post-baseline video evidence; Generate remains locked.',
    retryAt,now(),now(),row.id
  );
  setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{
    ...lc,last_error:'Awaiting fresh post-baseline video evidence; Generate remains forbidden.',
    retry_at:new Date(retryAt).toISOString(),last_inventory:currentInv,
    busy_supporting_only:Boolean(visibleBusy),automatic_submit_forbidden:true
  });
  publish('SUBMIT_AMBIGUOUS',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'Read-only Flow reconciliation pending. No Generate will be clicked without a fresh video result.'});
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

    const freshInventory=inventoryHasNew(inv,beforeInv);
    const started=freshVideo||freshInventory||downloadableFresh;
    lastEvidence='freshVideo='+freshVideo+'; freshVideoInventory='+freshInventory+'; busy='+visibleBusy+'; baselineBusy='+baselineBusy+'; busyIncreaseSupportingOnly='+busyIncrease+'; downloadableFresh='+downloadableFresh+'; downloadSignal='+downloadSignal+'; sendVisible='+sendVisible+'; sendDisabled='+sendDisabled+'; elapsedMs='+elapsed+'; videoTiles='+Number(beforeInv.video_tile_count||0)+'->'+Number(inv.video_tile_count||0);
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
async function openVerifiedFlowAsset(page,descriptor,{db=null,row=null,signal='verified-flow-asset'}={}){
  if(!descriptor?.asset_id)return{ready:false,opened:false,signal:'candidate-asset-id-missing'};
  if(db){
    const used=recoveredFlowAssetIds(db);
    if(used.has(String(descriptor.asset_id)))return{ready:false,opened:false,signal:'candidate-asset-id-already-recovered',asset_id:descriptor.asset_id};
  }
  const inv=await captureFlowInventory(page);
  const freshDescriptor=(inv.ordered_video_assets||[]).find(x=>Number(x.dom_index)===Number(descriptor.dom_index));
  if(!freshDescriptor||String(freshDescriptor.asset_id)!==String(descriptor.asset_id)){
    return{ready:false,opened:false,signal:'candidate-dom-identity-changed-before-click',expected:descriptor.asset_id,actual:freshDescriptor?.asset_id||null};
  }
  const all=page.locator('flow-grid-tile-container');
  const target=all.nth(Number(descriptor.dom_index));
  if(!(await target.isVisible().catch(()=>false))||!(await target.locator('flow-video-tile,video').count().catch(()=>0))){
    return{ready:false,opened:false,signal:'candidate-tile-not-visible'};
  }
  await target.scrollIntoViewIfNeeded().catch(()=>{});
  await target.hover().catch(()=>{});
  const footer=target.locator('flow-tile-hover-footer').first();
  if(await footer.count().catch(()=>0)&&await footer.isVisible().catch(()=>false))await footer.click({force:true,timeout:5000}).catch(()=>{});
  else await target.click({force:true,timeout:5000}).catch(()=>{});
  await sleep(1000);

  const viewer=await page.evaluate(()=>{
    const safe=v=>{
      if(!v)return'';
      try{const u=new URL(String(v),location.href);if(u.protocol==='blob:')return'';return u.origin+u.pathname}catch{return''}
    };
    return [...document.querySelectorAll('video')].map(v=>{
      const r=v.getBoundingClientRect();
      return{visible:r.width>40&&r.height>40,area:r.width*r.height,src:safe(v.currentSrc||v.src||''),poster:safe(v.poster||'')};
    }).filter(x=>x.visible).sort((a,b)=>b.area-a.area)[0]||null;
  }).catch(()=>null);
  const viewerSeed=viewer?[viewer.src,viewer.poster].filter(Boolean).join('|'):'';
  const viewerAssetId=viewerSeed?sha('viewer:'+viewerSeed):'';
  if(db&&viewerAssetId&&recoveredFlowAssetIds(db).has(viewerAssetId)){
    await page.keyboard.press('Escape').catch(()=>{});
    return{ready:false,opened:false,signal:'viewer-asset-id-already-recovered',asset_id:descriptor.asset_id,viewer_asset_id:viewerAssetId};
  }
  const d=await visibleDownloadButton(page);
  if(!d){await page.keyboard.press('Escape').catch(()=>{});return{ready:false,opened:false,signal:'verified-candidate-no-download',asset_id:descriptor.asset_id}}
  return{ready:true,opened:true,signal,asset_id:descriptor.asset_id,identity_strength:descriptor.identity_strength,signature:descriptor.signature,index:descriptor.dom_index,viewer_asset_id:viewerAssetId||null};
}

function freshFlowAssetCandidates(current,baselineInv,db,row){
  const assets=Array.isArray(current?.ordered_video_assets)?current.ordered_video_assets:[];
  const baselineAssets=Array.isArray(baselineInv?.ordered_video_assets)?baselineInv.ordered_video_assets:[];
  const baselineCount=Number(baselineInv?.video_tile_count||0);
  const usedIds=db?recoveredFlowAssetIds(db):new Set();
  const usedSigs=db?recoveredFlowSignatures(db):new Set();
  let fresh=[],missing=0,method='signature-multiset';

  if(baselineAssets.length&&baselineAssets.some(x=>x?.asset_id)){
    method='asset-id-multiset';
    const remain=new Map();
    for(const x of baselineAssets){const id=String(x?.asset_id||'');if(id)remain.set(id,(remain.get(id)||0)+1)}
    for(const a of assets){
      const id=String(a?.asset_id||'');
      const n=remain.get(id)||0;
      if(id&&n>0)remain.set(id,n-1);else fresh.push(a);
    }
    missing=[...remain.values()].reduce((sum,n)=>sum+Math.max(0,Number(n||0)),0);
  }else{
    const baselineList=Array.isArray(baselineInv?.ordered_video_signatures)&&baselineInv.ordered_video_signatures.length
      ? baselineInv.ordered_video_signatures
      : (Array.isArray(baselineInv?.video_signatures)?baselineInv.video_signatures:[]);
    const remain=new Map();for(const sig of baselineList)remain.set(String(sig),(remain.get(String(sig))||0)+1);
    for(const a of assets){
      const sig=String(a?.signature||'');
      const n=remain.get(sig)||0;
      if(sig&&n>0)remain.set(sig,n-1);else fresh.push(a);
    }
    missing=[...remain.values()].reduce((sum,n)=>sum+Math.max(0,Number(n||0)),0);
  }

  const rejected=[];
  fresh=fresh.filter(a=>{
    if(a?.asset_id&&usedIds.has(String(a.asset_id))){rejected.push({asset_id:a.asset_id,reason:'asset-id-already-recovered',signature:a.signature});return false}
    if(String(a?.identity_strength||'')!=='strong'&&a?.signature&&usedSigs.has(norm(a.signature))){rejected.push({asset_id:a.asset_id,reason:'weak-signature-already-recovered',signature:a.signature});return false}
    return true;
  });
  const delta=Number(current?.video_tile_count||assets.length)-baselineCount;
  return{fresh,missing,delta,method,rejected};
}

async function openUniqueFreshInventoryResult(page,baselineInv,{allowMultiple=false,db=null,row=null}={}){
  const current=await captureFlowInventory(page);
  const diff=freshFlowAssetCandidates(current,baselineInv,db,row);
  let candidates=diff.fresh;
  if(candidates.length>1&&row){
    const terms=episodeRecoveryTerms(row);
    const scored=candidates.map(a=>{
      const n=norm(a.signature||'');const matched=terms.filter(t=>n.includes(t));
      return{...a,matched,score:matched.length};
    }).sort((a,b)=>b.score-a.score||Number(a.dom_index)-Number(b.dom_index));
    if(scored[0]?.score>=2&&scored[0].score>Number(scored[1]?.score||-1))candidates=[scored[0]];
  }
  const purePostBaselineBurst=allowMultiple&&candidates.length>0&&(Number(current.video_tile_count||0)-Number(baselineInv?.video_tile_count||0))===candidates.length;
  const safeUniqueReplacement=candidates.length===1&&diff.missing<=1&&Math.abs(diff.delta)<=1;
  if(!safeUniqueReplacement&&!purePostBaselineBurst){
    return{ready:false,opened:false,signal:`fresh-video-asset-ambiguous:fresh=${candidates.length}:missing=${diff.missing}:delta=${diff.delta}:method=${diff.method}`,candidates:candidates.slice(0,8),rejected:diff.rejected};
  }
  const chosen=candidates[0];
  const opened=await openVerifiedFlowAsset(page,chosen,{db,row,signal:diff.delta===0?'unique-fresh-fixed-grid-asset':'unique-fresh-added-asset'});
  return{...opened,missing:diff.missing,delta:diff.delta,method:diff.method,rejected:diff.rejected};
}

async function openLatestExpectedVideoTile(page,baselineInv,db=null,row=null){
  // Kept as a compatibility wrapper. It no longer assumes DOM index 0 is the
  // new render; it delegates to identity-aware multiset recovery.
  return await openUniqueFreshInventoryResult(page,baselineInv,{db,row});
}

async function openStrictSinglePostBaselineTile(page,baselineInv,db=null,row=null){
  const opened=await openUniqueFreshInventoryResult(page,baselineInv,{db,row});
  return{...opened,strict:true,signal:opened?.ready?'strict-identity-verified-post-baseline-asset':String(opened?.signal||'strict-asset-not-ready')};
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
  let opened=false;
  try{
    await clickInteractive(trigger);
    opened=true;
  }catch{}
  if(!opened){
    try{await trustedClick(trigger);opened=true}catch{}
  }
  if(!opened)throw new Error('FLOW_DOWNLOAD_MENU_CLICK_FAILED');
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
  let attempt=await immediateDownloadChoice(page,localPath,{preferWanted:false});
  if(attempt.ok)return{method:attempt.method};
  // Flow can remount/close the editor between correlation and the actual
  // download click. Re-open the exact post-baseline video tile we correlated,
  // then retry the native download menu once without submitting anything new.
  if(Number.isInteger(Number(rendered?.index))){
    await page.keyboard.press('Escape').catch(()=>{});
    await sleep(500);
    const tiles=page.locator('flow-grid-tile-container').filter({has:page.locator('flow-video-tile,video')});
    const idx=Number(rendered.index),count=await tiles.count().catch(()=>0);
    if(idx>=0&&idx<count){
      const tile=tiles.nth(idx);
      await tile.scrollIntoViewIfNeeded().catch(()=>{});
      await tile.hover().catch(()=>{});
      const footer=tile.locator('flow-tile-hover-footer').first();
      if(await footer.count().catch(()=>0)&&await footer.isVisible().catch(()=>false))await footer.click({force:true,timeout:5000}).catch(()=>{});
      else await tile.click({force:true,timeout:5000}).catch(()=>{});
      await sleep(1200);
      attempt=await immediateDownloadChoice(page,localPath,{preferWanted:false});
      if(attempt.ok)return{method:attempt.method+' after tile reopen'};
    }
  }
  throw new Error('UNIQUE_FRESH_TILE_DOWNLOAD_FAILED:'+String(attempt.reason||'unknown'));
}
function validateMp4(localPath){
  const st=fs.statSync(localPath);if(st.size<100000)throw new Error('MP4_TOO_SMALL:'+st.size);const head=fs.readFileSync(localPath).subarray(0,128);if(!head.includes(Buffer.from('ftyp')))throw new Error('MP4_FTYP_MISSING');
  const raw=execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',localPath],{encoding:'utf8',timeout:30000}),probe=JSON.parse(raw),stream=(probe.streams||[]).find(s=>s.codec_type==='video');if(!stream)throw new Error('MP4_VIDEO_STREAM_MISSING');
  const duration=Number(probe?.format?.duration||0),width=Number(stream.width||0),height=Number(stream.height||0),tol=Math.max(2.5,DURATION_SECONDS*.25);if(Math.abs(duration-DURATION_SECONDS)>tol)throw new Error('MP4_DURATION_UNEXPECTED:'+duration);
  const parts=ASPECT_RATIO.split(':').map(Number);if(width>0&&height>0&&parts.length===2&&parts.every(Number.isFinite)){const expected=parts[0]/parts[1],actual=width/height;if(Math.abs(actual-expected)>Math.max(.12,expected*.22))throw new Error('MP4_ASPECT_UNEXPECTED:'+width+'x'+height)}
  return{size:st.size,duration,width,height,codec:String(stream.codec_name||'')};
}

async function findGoldenRecoveryAsset(page,allowHistory=true,db=null,row=null){
  if(!GOLDEN_RECOVERY_TERMS.length)throw new Error('GOLDEN_RECOVERY_TERMS_MISSING');
  const inv=await captureFlowInventory(page);
  const lc=row&&db?lifecycle(db,row)||{}:{};
  const baseline=lc?.baseline_inventory||null;
  const usedIds=db?recoveredFlowAssetIds(db):new Set();
  const usedSigs=db?recoveredFlowSignatures(db):new Set();
  const diff=baseline?freshFlowAssetCandidates(inv,baseline,db,row):{fresh:inv.ordered_video_assets||[],missing:0,delta:0,method:'no-baseline',rejected:[]};
  const freshIds=new Set((diff.fresh||[]).map(x=>String(x.asset_id||'')));
  const candidates=[];

  for(const a of (inv.ordered_video_assets||[])){
    const id=String(a?.asset_id||''),sig=String(a?.signature||''),n=norm(sig);
    if(!id||usedIds.has(id))continue;
    if(String(a?.identity_strength||'')!=='strong'&&sig&&usedSigs.has(n))continue;
    const matched=GOLDEN_RECOVERY_TERMS.filter(t=>n.includes(t));
    const isFresh=freshIds.has(id);
    const score=matched.length*100+(isFresh?25:0)+(String(a?.identity_strength||'')==='strong'?5:0)-Math.min(20,Number(a.dom_index||0));
    candidates.push({...a,matched,isFresh,score});
  }

  candidates.sort((a,b)=>b.score-a.score||Number(a.dom_index)-Number(b.dom_index));
  const required=Math.min(2,GOLDEN_RECOVERY_TERMS.length);
  const semantic=candidates.filter(x=>x.matched.length>=required);
  let chosen=null,source='';

  if(semantic.length){
    const freshSemantic=semantic.filter(x=>x.isFresh);
    const pool=freshSemantic.length?freshSemantic:semantic;
    const top=pool[0],runner=pool[1];
    if(!runner||top.matched.length>runner.matched.length){
      chosen=top;source=freshSemantic.length?'fresh-semantic-asset':'semantic-asset';
    }else if(GOLDEN_RECOVERY_ALLOW_NEWEST_UNUSED){
      // Flow renders newest-first in the visible project grid. We only use
      // DOM order as a final tie-breaker AFTER semantic match, unused asset ID,
      // and baseline freshness checks. It is never identity by itself.
      chosen=[...pool].sort((a,b)=>Number(a.dom_index)-Number(b.dom_index))[0];
      source=freshSemantic.length?'fresh-semantic-newest-unused-tiebreak':'semantic-newest-unused-tiebreak';
    }
  }else if(GOLDEN_RECOVERY_ALLOW_NEWEST_UNUSED){
    const pool=(diff.fresh||[]).filter(a=>a?.asset_id&&!usedIds.has(String(a.asset_id)));
    if(pool.length){
      chosen=[...pool].sort((a,b)=>Number(a.dom_index)-Number(b.dom_index))[0];
      source='fresh-newest-unused-fallback';
    }
  }

  publish('FLOW_RECOVERY_IDENTITY_SCAN',{
    episode:row?('E'+row.episode):null,
    baseline_method:diff.method,
    current_video_tiles:Number(inv.video_tile_count||0),
    fresh_candidates:(diff.fresh||[]).map(x=>({asset_id:String(x.asset_id||'').slice(0,16),identity_strength:x.identity_strength,signature:compact(x.signature,140),dom_index:x.dom_index})).slice(0,20),
    rejected:(diff.rejected||[]).map(x=>({asset_id:String(x.asset_id||'').slice(0,16),reason:x.reason,signature:compact(x.signature,120)})).slice(0,20),
    ranked:candidates.slice(0,12).map(x=>({asset_id:String(x.asset_id||'').slice(0,16),fresh:x.isFresh,matched:x.matched,signature:compact(x.signature,160),dom_index:x.dom_index}))
  });

  if(chosen){
    const opened=await openVerifiedFlowAsset(page,chosen,{db,row,signal:'targeted-recovery-identity-verified'});
    if(opened?.ready){
      publish('FLOW_RECOVERY_ASSET_SELECTED',{
        episode:row?('E'+row.episode):null,
        asset_id:String(chosen.asset_id||'').slice(0,24),
        viewer_asset_id:String(opened.viewer_asset_id||'').slice(0,24)||null,
        identity_strength:chosen.identity_strength,
        signature:compact(chosen.signature,240),
        matched_terms:chosen.matched,
        fresh:Boolean(chosen.isFresh),
        dom_index:chosen.dom_index,
        source
      });
      return{found:true,matched:chosen.matched,label:chosen.signature,signature:chosen.signature,source,index:chosen.dom_index,asset_id:chosen.asset_id,viewer_asset_id:opened.viewer_asset_id||null,identity_strength:chosen.identity_strength,fresh:Boolean(chosen.isFresh)};
    }
  }

  // Optional session-history scan is intentionally conservative and remains
  // within the SAME Flow project. Cross-project searching is disabled by
  // default because it can recover unrelated media with similar prompt text.
  if(allowHistory){
    const history=page.getByRole('button',{name:/Open session history|Session history|Historial de sesiones/i}).last();
    if(await history.count().catch(()=>0)&&await history.isVisible().catch(()=>false)){
      await history.click().catch(()=>{});await sleep(1000);
      const retry=await findGoldenRecoveryAsset(page,false,db,row);
      if(retry?.found)return{...retry,source:'session-history/'+String(retry.source||'identity-scan')};
    }
  }

  return{
    found:false,
    candidates:candidates.slice(0,12).map(x=>({asset_id:String(x.asset_id||''),matched:x.matched,fresh:x.isFresh,identity_strength:x.identity_strength,label:compact(x.signature,240),dom_index:x.dom_index})),
    rejected:diff.rejected||[],
    url:page.url()
  };
}

async function recoverGoldenRunIfRequested(db){
  if(!GOLDEN_RECOVERY_TOKEN)return{needed:false,done:false};
  const metaKey='recovery:golden:'+GOLDEN_RECOVERY_TOKEN;
  const prior=json(meta(db,metaKey,''),null);
  if(prior?.status==='completed')return{needed:true,done:true,prior};

  let row=db.prepare('SELECT * FROM factory_items WHERE episode=? ORDER BY season DESC LIMIT 1').get(GOLDEN_RECOVERY_EPISODE);
  if(!row)throw new Error('GOLDEN_RECOVERY_TARGET_EPISODE_NOT_FOUND:'+GOLDEN_RECOVERY_EPISODE);
  const forceReplace=String(process.env.PUBLISHER_RECOVERY_FORCE_REPLACE||'false').toLowerCase()==='true';
  if(!forceReplace&&row.videoPath&&fs.existsSync(row.videoPath)&&String(row.status)==='review'){
    const done={status:'completed',at:now(),episode:row.episode,job_id:row.id,existing:true};
    setMeta(db,metaKey,JSON.stringify(done));return{needed:true,done:true,prior:done};
  }

  // Preserve the proven-wrong media hash before replacing the Review file.
  // This prevents that exact old render from ever being accepted again.
  const priorWrongHash=String(row.reviewContentHash||'').trim();
  if(forceReplace&&priorWrongHash){
    try{db.prepare("INSERT OR IGNORE INTO flow_rejected_media_hashes(contentHash,episode,reason,rejectedAt) VALUES(?,?,?,?)")
      .run(priorWrongHash,Number(row.episode||0),'Operator confirmed wrong Flow asset was recovered for this episode.',now())}catch{}
  }

  publish('TARGETED_RECOVERY_START',{
    episode:'E'+row.episode,job_id:row.id,
    recovery_token:GOLDEN_RECOVERY_TOKEN,
    generation_submit_forbidden:true,
    message:'Recovery-only mode: existing Flow media will be identified and downloaded. Generate is forbidden.'
  });

  const session=await launchLocal();
  try{
    const page=session.page||session.context.pages()[0]||await session.context.newPage();
    await ensureExpectedFlowProject(page);
    if(!String(page.url()).includes(projectPath()))await page.goto(flowUrl(),{waitUntil:'domcontentloaded',timeout:60000});
    await waitFlowReady(page,60000);await renderAuthGuard(page);

    let found=await findGoldenRecoveryAsset(page,true,db,row);
    const searchedProjects=[];
    if(!found.found&&GOLDEN_RECOVERY_SEARCH_ALL_PROJECTS){
      // Disabled by default. A targeted recovery must stay inside the exact
      // configured project unless an operator explicitly authorizes a broader search.
      try{
        await page.goto('https://flow.google.com/',{waitUntil:'domcontentloaded',timeout:60000});await sleep(2200);
        const cards=page.locator('flow-project-card');
        for(let i=0;i<Math.min(await cards.count().catch(()=>0),30)&&!found.found;i++){
          const card=cards.nth(i);if(!(await card.isVisible().catch(()=>false)))continue;
          const a=card.locator('a[href*="/project/"]').first();
          const href=String(await a.getAttribute('href').catch(()=>'')||'');if(!href)continue;
          const absolute=href.startsWith('http')?href:'https://flow.google.com'+href;
          searchedProjects.push({index:i,href});
          await page.goto(absolute,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});await sleep(2200);
          try{await waitFlowReady(page,20000)}catch{}
          const attempt=await findGoldenRecoveryAsset(page,true,db,row);
          if(attempt?.found)found={...attempt,project_href:href,project_index:i};
        }
      }catch(e){searchedProjects.push({error:compact(e?.message||e,300)})}
    }

    if(!found.found){
      const pending={status:'pending',at:now(),episode:row.episode,job_id:row.id,last:'identity-verified-asset-not-found',candidates:found.candidates||[],rejected:found.rejected||[],searched_projects:searchedProjects};
      setMeta(db,metaKey,JSON.stringify(pending));
      publish('TARGETED_RECOVERY_PENDING',{
        episode:'E'+row.episode,job_id:row.id,
        candidates:(found.candidates||[]).slice(0,12),
        rejected:(found.rejected||[]).slice(0,12),
        generation_submit_forbidden:true,
        message:'No unique unused Flow asset matched strongly enough. Recovery remains read-only; no regeneration will occur.'
      });
      return{needed:true,done:false};
    }

    const localPath=path.join(VIDEO_DIR,`${row.id}.mp4`);
    try{fs.unlinkSync(localPath)}catch{}
    const dl=await downloadResult(page,{uiReady:true,signal:'targeted-recovery-identity-verified',asset_id:found.asset_id,viewer_asset_id:found.viewer_asset_id},localPath);
    const valid=validateMp4(localPath);
    const recoveredAt=now();
    const existingLifecycle=lifecycle(db,row)||{};
    const existingGenerationId=String(row.providerRunId||existingLifecycle.generation_id||'');
    const runId=existingGenerationId||('existing-flow-recovery:'+GOLDEN_RECOVERY_TOKEN);
    const flowResult={
      provider:PROVIDER,
      targeted_existing_recovery:true,
      recovery_token:GOLDEN_RECOVERY_TOKEN,
      generation_id:runId,
      flow_asset_id:String(found.asset_id||''),
      viewer_asset_id:String(found.viewer_asset_id||''),
      recovery_proof:'operator-confirmed-existing-flow-asset-identity-verified',
      recovery_signature:String(found.signature||found.label||''),
      matched_terms:Array.isArray(found.matched)?found.matched:GOLDEN_RECOVERY_TERMS,
      matched_label:found.label||null,
      identity_strength:found.identity_strength||null,
      fresh_against_submit_baseline:Boolean(found.fresh),
      source:found.source||'targeted-identity-scan',
      duration:valid.duration,width:valid.width,height:valid.height,size:valid.size,codec:valid.codec,
      validated_ftyp:true,
      download_quality:dl.method||CONFIG.generation.download_quality||'downloaded asset',
      retrieved_at:recoveredAt
    };
    persistReviewMetadata(db,row,flowResult);
    await saveReviewAsset(db,row,localPath,flowResult,recoveredAt);

    // This is recovery of an existing render, not another generation. Preserve
    // the original generation accounting and merely mark its row review-ready.
    if(existingGenerationId){
      try{db.prepare("UPDATE factory_generations SET status='review',error=NULL,updatedAt=? WHERE itemId=? AND runId=?")
        .run(recoveredAt,row.id,existingGenerationId)}catch{}
    }else{
      try{
        const exists=Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE itemId=? AND day=? AND credits>0").get(row.id,artDay())?.n||0);
        if(!exists)db.prepare(`INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(),row.id,artDay(),String(row.promptHash||sha(runId)),0,'review',runId,recoveredAt,recoveredAt,'existing-render-recovery-no-new-generation','recovery');
      }catch(e){publish('TARGETED_RECOVERY_ACCOUNTING_WARNING',{message:compact(e?.message||e,300)})}
    }

    db.prepare('UPDATE factory_items SET providerRunId=NULL,updatedAt=? WHERE id=?').run(recoveredAt,row.id);
    setLifecycle(db,row,'REVIEW_READY',{
      ...existingLifecycle,
      generation_id:runId,
      targeted_existing_recovery:true,
      recovery_token:GOLDEN_RECOVERY_TOKEN,
      flow_asset_id:flowResult.flow_asset_id,
      viewer_asset_id:flowResult.viewer_asset_id,
      recovery_signature:flowResult.recovery_signature,
      recovery_proof:flowResult.recovery_proof,
      size:valid.size,duration:valid.duration,width:valid.width,height:valid.height,
      retrieved_at:recoveredAt,
      automatic_submit_forbidden:true
    });
    const done={
      status:'completed',at:recoveredAt,episode:row.episode,job_id:row.id,run_id:runId,
      flow_asset_id:flowResult.flow_asset_id,
      viewer_asset_id:flowResult.viewer_asset_id,
      recovery_signature:flowResult.recovery_signature,
      content_hash:flowResult.content_hash||null,
      size:valid.size,duration:valid.duration,resolution:`${valid.width}x${valid.height}`
    };
    setMeta(db,metaKey,JSON.stringify(done));
    setMeta(db,'flow:lastSuccessfulMp4At',recoveredAt);
    publish('TARGETED_RECOVERY_REVIEW_READY',{
      episode:'E'+row.episode,job_id:row.id,
      flow_asset_id:String(flowResult.flow_asset_id||'').slice(0,24),
      viewer_asset_id:String(flowResult.viewer_asset_id||'').slice(0,24)||null,
      recovery_signature:compact(flowResult.recovery_signature,220),
      content_hash:String(flowResult.content_hash||'').slice(0,24),
      size:valid.size,duration:valid.duration,resolution:done.resolution,
      no_new_generation:true,
      factory_url:`/factory/video/${row.id}`
    });
    return{needed:true,done:true,prior:done};
  }finally{await session.close().catch(()=>{})}
}

async function retrieveExisting(page,row,cp,lc,db){
  setLifecycle(db,row,'RETRIEVING',{
    generation_id:lc?.generation_id||row.providerRunId||'',
    generation_session_instance:lc?.generation_session_instance||null,
    baseline:lc?.baseline||[],
    baseline_inventory:lc?.baseline_inventory||null
  });
  const baseline=Array.isArray(lc?.baseline)?lc.baseline:[];
  const baselineInventory=lc?.baseline_inventory||null;
  const sameSubmitSession=String(lc?.generation_session_instance||'')===INSTANCE_ID;
  const deadline=Date.now()+15*60*1000;
  let rendered=null,lastVideos=[],uiSignal=null,lastHeartbeat=0,emptyEvidenceSince=0;
  const generationStartedMs=Date.parse(String(lc?.generation_started_at||lc?.submit_boundary_at||''))||Date.now();

  while(Date.now()<deadline){
    await renderAuthGuard(page);
    if(Date.now()-lastHeartbeat>10000){
      lastHeartbeat=Date.now();
      try{db.prepare('UPDATE factory_items SET lastProgressAt=?,updatedAt=? WHERE id=?').run(now(),now(),row.id)}catch{}
    }

    // A viewer that predates the current proof is never accepted.
    const alreadyOpenDownload=await visibleDownloadButton(page).catch(()=>null);
    if(alreadyOpenDownload){await page.keyboard.press('Escape').catch(()=>{});await sleep(350)}

    lastVideos=await currentVideos(page);
    rendered=firstFreshRendered(lastVideos,baseline);
    if(rendered){
      const srcIdentity=String(rendered.src||'').replace(/[?#].*$/,'');
      rendered={...rendered,recoveryProof:'fresh-video-src-post-baseline',assetId:srcIdentity?sha('fresh-video-src:'+srcIdentity):null,identityStrength:'weak'};
      break;
    }

    const text=await getBody(page);
    if(flowCreditFailure(text))throw new Error('FLOW_INSUFFICIENT_CREDITS');
    if(/failed to generate|generation failed|couldn't generate|no se pudo generar/i.test(text))throw new Error('FLOW_GENERATION_FAILED');
    const stillBusy=/generating|processing|rendering|creating video|generando|procesando|upscaling/i.test(text);

    if(baselineInventory){
      const inv=await captureFlowInventory(page);
      const before=Number(baselineInventory.video_tile_count||0);
      const after=Number(inv.video_tile_count||0);
      const delta=after-before;

      // Strongest normal path: same browser session + exactly one new video tile.
      // Flow keeps newest media at the front of the grid, so choose ONLY that tile.
      if(sameSubmitSession&&delta===1){
        uiSignal=await openStrictSinglePostBaselineTile(page,baselineInventory,db,row);
        if(uiSignal?.ready){
          rendered={uiReady:true,signal:uiSignal.signal,baselineInventory,index:uiSignal.index,signature:uiSignal.signature,assetId:uiSignal.asset_id||null,viewerAssetId:uiSignal.viewer_asset_id||null,identityStrength:uiSignal.identity_strength||null,recoveryProof:'same-session-identity-verified-post-baseline-asset'};
          break;
        }
      }else if(delta>0){
        // Multiple post-baseline tiles or a restarted browser are ambiguous.
        // Never guess the first "fresh-looking" tile: require episode correlation.
        const correlated=await openEpisodeCorrelatedResult(page,row,baselineInventory,db).catch(()=>null);
        if(correlated?.found){
          rendered={uiReady:true,signal:correlated.signal,baselineInventory,index:correlated.index,signature:correlated.label,assetId:correlated.asset_id||null,viewerAssetId:correlated.viewer_asset_id||null,identityStrength:correlated.identity_strength||null,recoveryProof:'episode-correlated-post-baseline-asset',matchedTerms:correlated.matched};
          break;
        }
        uiSignal={ready:false,signal:`strict-ambiguous-post-baseline-delta:${delta};correlation:${correlated?.signal||'none'}`};
      }else if(!stillBusy&&Date.now()-generationStartedMs>15000){
        // Virtualized grids can keep total count unchanged after a restart. In
        // that case only a prompt/episode-correlated non-baseline tile is valid.
        const correlated=await openEpisodeCorrelatedResult(page,row,baselineInventory,db).catch(()=>null);
        if(correlated?.found){
          rendered={uiReady:true,signal:correlated.signal,baselineInventory,index:correlated.index,signature:correlated.label,assetId:correlated.asset_id||null,viewerAssetId:correlated.viewer_asset_id||null,identityStrength:correlated.identity_strength||null,recoveryProof:'episode-correlated-virtualized-grid-asset',matchedTerms:correlated.matched};
          break;
        }
        uiSignal={ready:false,signal:'strict-no-correlated-post-baseline-result'};
      }else{
        uiSignal={ready:false,signal:`strict-waiting;delta:${delta};busy:${stillBusy?1:0}`};
      }

      if(Date.now()-lastHeartbeat<2500||!uiSignal?.ready){
        publish('RETRIEVAL_PROGRESS',{episode:'E'+row.episode,job_id:row.id,signal:uiSignal?.signal||'none',stillBusy,videos:lastVideos.length,same_submit_session:sameSubmitSession});
      }
      if(!stillBusy&&lastVideos.length===0&&delta<=0&&Date.now()-generationStartedMs>20*60*1000){
        if(!emptyEvidenceSince)emptyEvidenceSince=Date.now();
        if(Date.now()-emptyEvidenceSince>20000)throw new Error('FLOW_NO_RETAINED_RENDER_AFTER_20M');
      }else emptyEvidenceSince=0;
    }
    await sleep(2500);
  }

  if(!rendered)throw new Error(`RENDER_TIMEOUT_STRICT_MATCH:videos=${lastVideos.length}:ui=${uiSignal?.signal||'none'}`);

  const localPath=path.join(VIDEO_DIR,`${row.id}.mp4`);
  try{fs.unlinkSync(localPath)}catch{}
  const dl=await downloadResult(page,rendered,localPath);
  const valid=validateMp4(localPath);
  const flowResult={
    provider:PROVIDER,
    generation_id:lc?.generation_id||row.providerRunId||'',
    generation_started_at:lc?.generation_started_at||'',
    generation_session_instance:lc?.generation_session_instance||null,
    recovery_proof:rendered.recoveryProof||rendered.signal||'fresh-video-src-post-baseline',
    recovery_signature:rendered.signature||null,
    recovery_matched_terms:rendered.matchedTerms||[],
    flow_asset_id:rendered.assetId||rendered.asset_id||null,
    viewer_asset_id:rendered.viewerAssetId||rendered.viewer_asset_id||null,
    asset_identity_strength:rendered.identityStrength||rendered.identity_strength||null,
    duration:valid.duration,width:valid.width,height:valid.height,size:valid.size,codec:valid.codec,
    validated_ftyp:true,download_quality:dl.method||CONFIG.generation.download_quality||'downloaded asset',retrieved_at:now()
  };
  if(!/^fresh-video-src-post-baseline|same-session-identity-verified-post-baseline-asset|episode-correlated-/.test(String(flowResult.recovery_proof||''))){
    try{fs.unlinkSync(localPath)}catch{}
    throw new Error('FLOW_STRICT_RECOVERY_PROOF_REQUIRED');
  }

  persistReviewMetadata(db,row,flowResult);
  await saveReviewAsset(db,row,localPath,flowResult);
  try{db.prepare(`UPDATE factory_generations SET status='review',updatedAt=?,error=NULL WHERE itemId=? AND runId=?`).run(now(),row.id,String(lc?.generation_id||row.providerRunId||''))}catch{}
  resetNoChargeBackoff(db,row);
  setLifecycle(db,row,'REVIEW_READY',{...lc,generation_id:lc?.generation_id||row.providerRunId||'',recovery_proof:flowResult.recovery_proof,flow_asset_id:flowResult.flow_asset_id||null,viewer_asset_id:flowResult.viewer_asset_id||null,recovery_signature:flowResult.recovery_signature||null,size:valid.size,duration:valid.duration,width:valid.width,height:valid.height,download_quality:flowResult.download_quality,retrieved_at:now()});
  setMeta(db,'flow:lastSuccessfulGenerationAt',lc?.generation_started_at||now());
  setMeta(db,'flow:lastSuccessfulMp4At',now());
  setMeta(db,'automation:provider',PROVIDER);
  setMeta(db,'automation:paidDependencyDetected','false');
  setMeta(db,'automation:tinyfishRequired','false');
  try{fs.writeFileSync(path.join(FACTORY_DIR,'flow-browser-self-test.json'),JSON.stringify({at:now(),ok:true,stage:'real-production-review-ready',provider:PROVIDER,episode:`T${row.season}E${row.episode}`,mp4_valid:true,recovery_proof:flowResult.recovery_proof,duration:valid.duration,width:valid.width,height:valid.height,codec:valid.codec},null,2),{mode:0o600})}catch{}
  publish('REVIEW_READY',{episode:`T${row.season}E${row.episode}`,job_id:row.id,generation_id:lc?.generation_id||row.providerRunId||'',recovery_proof:flowResult.recovery_proof,flow_asset_id:String(flowResult.flow_asset_id||'').slice(0,24)||null,viewer_asset_id:String(flowResult.viewer_asset_id||'').slice(0,24)||null,size:valid.size,duration:valid.duration,resolution:`${valid.width}x${valid.height}`,factory_url:`/factory/video/${row.id}`});
  return true;
}

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
    const pauseAllowsSubmit=!generationPauseActive();
    const manualSubmit=envEnabled&&pauseAllowsSubmit&&meta(db,'automation:allowSubmit','0')==='1',runtimeEnabled=meta(db,'automation:factoryEnabled','false')==='true',creditCycleOpen=meta(db,'flow:dailyCreditBatchOpen','false')==='true',cycleUsed=creditCycleUsage(db),extraAuthorized=dailyProductionLimit(db)>Number(BASE_DAILY_PRODUCTION_LIMIT||1)&&effectiveDailyCount(db)<dailyProductionLimit(db),autoSubmit=envEnabled&&pauseAllowsSubmit&&runtimeEnabled&&meta(db,'automation:freeFactoryEnabled','0')==='1'&&(reviewerRetry||extraAuthorized||(creditCycleOpen&&cycleUsed<Number(BASE_DAILY_PRODUCTION_LIMIT||1))),submitAuthorized=manualSubmit||autoSubmit;
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
    setLifecycle(db,row,'SUBMIT_BOUNDARY_ENTERED',{generation_id:genId,submit_boundary_at:now(),generation_session_instance:INSTANCE_ID,baseline,baseline_inventory:baselineInventory,reviewer_retry:reviewerRetry,retry_token:reviewerRetry?String(row.reviewRetryToken||''):null});
    const submitMode=await clickSubmitExactlyOnce(page,baselineInventory,baseline,baselineBusy);
    const priorConsent=meta(db,'flow:consentMode','UNKNOWN');
    const consentMode=/approve-always/i.test(submitMode)?'ALWAYS_APPROVED':(/approve-once|confirm-generate/i.test(submitMode)?'PER_GENERATION':(priorConsent==='ALWAYS_APPROVED'?'ALWAYS_APPROVED':'NO_DIALOG_OBSERVED'));
    setMeta(db,'flow:consentMode',consentMode);
    setLifecycle(db,row,'SUBMIT_BOUNDARY_ENTERED',{generation_id:genId,submit_boundary_at:now(),generation_session_instance:INSTANCE_ID,submit_mode:submitMode,consent_mode:consentMode,pre_consent_fingerprint:submit.pre_consent_fingerprint||'',baseline,baseline_inventory:baselineInventory,reviewer_retry:reviewerRetry,retry_token:reviewerRetry?String(row.reviewRetryToken||''):null,automatic_submit_forbidden:true});
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
    const startedAt=now();lc=setLifecycle(db,row,'GENERATION_STARTED',{generation_id:genId,generation_started_at:startedAt,generation_session_instance:INSTANCE_ID,submit_mode:submitMode,consent_mode:consentMode,baseline,baseline_inventory:baselineInventory,evidence:started.evidence,automatic_submit_forbidden:true});
    if(!reviewerRetry)recordAutomaticStart(db,genId,startedAt);
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
  return Boolean(token&&token===submitted&&['reuse_prompt','revise_prompt','new_story'].includes(String(row?.retryStrategy||''))&&String(row?.reviewFeedback||'').trim().length>=3);
}
function isReviewerRetry(row){
  return !!row&&['reuse_prompt','revise_prompt','new_story'].includes(String(row.retryStrategy||''))&&String(row.reviewFeedback||'').trim().length>=3&&['regen_wait','draft'].includes(String(row.status||''))&&retryTokenOpen(row);
}
function normalizeReauthorizedReviewerRetries(db){
  try{
    const rows=db.prepare("SELECT * FROM factory_items WHERE status='generating' AND retryStrategy IN ('reuse_prompt','revise_prompt','new_story') AND reviewFeedback IS NOT NULL AND reviewRetryToken IS NOT NULL AND (reviewRetrySubmittedToken IS NULL OR reviewRetrySubmittedToken<>reviewRetryToken)").all();
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
  const rows=db.prepare("SELECT * FROM factory_items WHERE retryStrategy IN ('reuse_prompt','revise_prompt','new_story') AND reviewFeedback IS NOT NULL AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken AND status NOT IN ('review','queued','historical','published')").all();
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
  const rows=db.prepare("SELECT * FROM factory_items WHERE status='generating' AND retryStrategy IN ('reuse_prompt','revise_prompt','new_story') AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken ORDER BY episode").all();
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


function normalizeRecoverableBrowserRetrievalCrash(db){
  try{
    const rows=db.prepare("SELECT * FROM factory_items WHERE status='generating' AND (error LIKE '%Target crashed%' OR error LIKE '%Target closed%' OR error LIKE '%Browser closed%') ORDER BY episode").all();
    let repaired=0;
    for(const row of rows){
      const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
      if(!AFTER_GENERATE.has(state)&&!AMBIGUOUS.has(state))continue;
      db.prepare("UPDATE factory_items SET nextTry=0,error='Browser renderer crashed during retrieval; retrying existing Flow result only. Generate remains locked.',lastProgressAt=?,updatedAt=? WHERE id=?")
        .run(now(),now(),row.id);
      setLifecycle(db,row,'RETRIEVAL_PENDING',{...lc,recovery_reason:'browser-renderer-crash',automatic_submit_forbidden:true,retry_at:new Date().toISOString()});
      publish('BROWSER_RETRIEVAL_CRASH_RECOVERED',{episode:'E'+row.episode,job_id:row.id,message:'Browser crash after generation was converted to immediate retrieval-only recovery. No duplicate Generate will be sent.'});
      repaired++;
    }
    return repaired;
  }catch(e){publish('BROWSER_RETRIEVAL_CRASH_REPAIR_WARNING',{message:compact(e?.message||e,400)});return 0}
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
  // A confirmed retained render is definitive evidence that the Flow account
  // recovered. Reset *every* legacy per-item streak as well as the provider
  // streak; otherwise normalizeLiveNoChargeCooldown could resurrect an old
  // pre-success streak and incorrectly jump straight back to a 24h cooldown.
  const stamp=now();
  try{db.prepare("UPDATE factory_meta SET value='0' WHERE key LIKE 'flow:noChargeStreak:%'").run()}catch{}
  setMeta(db,'flow:noChargeStreak:provider','0');
  setMeta(db,'flow:legacyNoChargeStreakMigratedV2','done');
  setMeta(db,'flow:transientCooldownUntil','0');
  setMeta(db,'flow:lastProviderRecoveryAt',stamp);
  try{
    db.prepare("UPDATE factory_items SET nextTry=0,error=NULL,updatedAt=? WHERE status='draft' AND providerRunId IS NULL AND (error LIKE 'FLOW%NO_CHARGE%' OR error LIKE 'FLOW_UNUSUAL_ACTIVITY_%')").run(stamp);
  }catch{}
  publish('FLOW_PROVIDER_BACKOFF_RESET',{
    episode:row?('E'+row.episode):null,
    message:'Confirmed retained render reset provider-wide and all legacy per-item unusual-activity streaks; stale cooldown rows were released.'
  });
}
function repairLegacyBackoffAfterConfirmedSuccess(db){
  const key='repair:provider-backoff-after-confirmed-success-v1';
  if(meta(db,key,'')==='done')return;
  try{
    const globalStreak=Math.max(0,Number(meta(db,'flow:noChargeStreak:provider','0'))||0);
    if(globalStreak<2){setMeta(db,key,'done');return}

    const success=db.prepare("SELECT itemId,updatedAt,createdAt FROM factory_generations WHERE credits>0 AND status IN ('review','completed') ORDER BY updatedAt DESC LIMIT 1").get();
    const successAt=Date.parse(String(success?.updatedAt||success?.createdAt||''))||0;
    if(!successAt){setMeta(db,key,'done');return}

    const lifecycleRows=db.prepare("SELECT key,value FROM factory_meta WHERE key LIKE 'flow:generationLifecycle:%'").all();
    const after=[];
    const before=[];
    for(const x of lifecycleRows){
      const lc=json(x.value,null);if(!lc)continue;
      const st=String(lc.state||'').toUpperCase();
      if(!['TRANSIENT_NO_CHARGE_RETRY','UNUSUAL_ACTIVITY_OVERNIGHT'].includes(st))continue;
      const at=Date.parse(String(lc.updated_at||lc.retry_at||''))||0;
      const itemId=String(x.key||'').split(':').pop();
      if(at>successAt)after.push({itemId,at,lc});else if(at>0)before.push({itemId,at,lc});
    }
    if(!after.length){resetNoChargeBackoff(db,null);setMeta(db,key,'done');return}

    // This migration repairs the legacy bug where a successful render did not
    // reset the provider streak. Only alerts AFTER the latest confirmed render
    // belong to the current streak. Under the fixed serial provider there can
    // be only one such current alert during this migration.
    const currentStreak=Math.max(1,after.length);
    const latestAlert=Math.max(...after.map(x=>x.at));
    const retryAt=latestAlert+noChargeDelayMs(currentStreak);
    const due=retryAt<=Date.now();
    setMeta(db,'flow:noChargeStreak:provider',String(currentStreak));
    setMeta(db,'flow:transientCooldownUntil',String(due?0:retryAt));

    for(const x of before){
      try{db.prepare("UPDATE factory_items SET nextTry=0,error=NULL,updatedAt=? WHERE id=? AND status='draft' AND providerRunId IS NULL").run(now(),x.itemId)}catch{}
    }
    for(const x of after){
      try{
        db.prepare("UPDATE factory_items SET nextTry=?,error=?,updatedAt=? WHERE id=? AND status='draft' AND providerRunId IS NULL").run(
          due?0:retryAt,
          due?null:'FLOW_NO_CHARGE — provider-wide exponential backoff active.',
          now(),x.itemId
        );
      }catch{}
    }
    publish('FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED',{
      prior_provider_streak:globalStreak,
      current_provider_streak:currentStreak,
      latest_confirmed_success:new Date(successAt).toISOString(),
      latest_alert:new Date(latestAlert).toISOString(),
      retry_at:due?null:new Date(retryAt).toISOString(),
      retry_due_now:due,
      message:'Legacy provider streak was recalculated from alerts after the latest confirmed retained render.'
    });
  }catch(e){publish('FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIR_WARNING',{message:compact(e?.message||e,500)})}
  setMeta(db,key,'done');
}

function repairProviderBackoffAfterConfirmedSuccessV2(db){
  const key='repair:provider-backoff-after-confirmed-success-v2';
  if(meta(db,key,'')==='done')return;
  try{
    const success=db.prepare("SELECT itemId,updatedAt,createdAt FROM factory_generations WHERE credits>0 AND status IN ('review','completed') ORDER BY updatedAt DESC LIMIT 1").get();
    const successAt=Date.parse(String(success?.updatedAt||success?.createdAt||''))||0;
    if(!successAt){setMeta(db,key,'done');return}

    const lifecycleRows=db.prepare("SELECT key,value FROM factory_meta WHERE key LIKE 'flow:generationLifecycle:%'").all();
    const after=[];
    const before=[];
    for(const x of lifecycleRows){
      const lc=json(x.value,null);if(!lc)continue;
      const st=String(lc.state||'').toUpperCase();
      if(!['TRANSIENT_NO_CHARGE_RETRY','UNUSUAL_ACTIVITY_OVERNIGHT'].includes(st))continue;
      const at=Date.parse(String(lc.updated_at||lc.retry_at||''))||0;
      const itemId=String(x.key||'').split(':').pop();
      if(at>successAt)after.push({itemId,at,lc});else if(at>0)before.push({itemId,at,lc});
    }

    // Clear all legacy counters first so a later normalization cannot restore a
    // pre-success streak. Current streak is ONLY alerts after latest success.
    try{db.prepare("UPDATE factory_meta SET value='0' WHERE key LIKE 'flow:noChargeStreak:%'").run()}catch{}
    setMeta(db,'flow:legacyNoChargeStreakMigratedV2','done');
    setMeta(db,'flow:lastProviderRecoveryAt',new Date(successAt).toISOString());

    if(!after.length){
      setMeta(db,'flow:noChargeStreak:provider','0');
      setMeta(db,'flow:transientCooldownUntil','0');
      for(const x of before){
        try{db.prepare("UPDATE factory_items SET nextTry=0,error=NULL,updatedAt=? WHERE id=? AND status='draft' AND providerRunId IS NULL").run(now(),x.itemId)}catch{}
      }
      publish('FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED_V2',{
        current_provider_streak:0,
        latest_confirmed_success:new Date(successAt).toISOString(),
        retry_at:null,
        message:'No unusual-activity alert exists after the latest successful render; stale provider cooldown fully cleared.'
      });
      setMeta(db,key,'done');return;
    }

    // Strict serial mode means each post-success alert is one real provider
    // rejection. Count only those alerts, never historical per-item counters.
    after.sort((a,b)=>a.at-b.at);
    const currentStreak=Math.max(1,after.length);
    const latestAlert=after[after.length-1].at;
    const retryAt=latestAlert+noChargeDelayMs(currentStreak);
    const due=retryAt<=Date.now();
    setMeta(db,'flow:noChargeStreak:provider',String(currentStreak));
    setMeta(db,'flow:transientCooldownUntil',String(due?0:retryAt));

    for(const x of before){
      try{db.prepare("UPDATE factory_items SET nextTry=0,error=NULL,updatedAt=? WHERE id=? AND status='draft' AND providerRunId IS NULL").run(now(),x.itemId)}catch{}
    }
    for(const x of after){
      try{
        db.prepare("UPDATE factory_items SET nextTry=?,error=?,updatedAt=? WHERE id=? AND status='draft' AND providerRunId IS NULL").run(
          due?0:retryAt,
          due?null:'FLOW_NO_CHARGE — provider-wide exponential backoff active.',
          now(),x.itemId
        );
      }catch{}
    }
    publish('FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED_V2',{
      current_provider_streak:currentStreak,
      latest_confirmed_success:new Date(successAt).toISOString(),
      latest_alert:new Date(latestAlert).toISOString(),
      retry_at:due?null:new Date(retryAt).toISOString(),
      retry_due_now:due,
      message:'Provider streak rebuilt only from alerts after latest retained render; historical streaks cannot be resurrected.'
    });
  }catch(e){publish('FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIR_V2_WARNING',{message:compact(e?.message||e,500)})}
  setMeta(db,key,'done');
}

function normalizeLiveNoChargeCooldown(db){
  try{
    const rows=db.prepare("SELECT * FROM factory_items WHERE status='draft' AND (error LIKE 'FLOW%NO_CHARGE%' OR error LIKE 'FLOW_UNUSUAL_ACTIVITY_%') ORDER BY episode").all();

    // One-time migration from the old per-episode streak model. Never resurrect
    // legacy item streaks after a confirmed provider recovery.
    let providerStreak=Math.max(0,Number(meta(db,'flow:noChargeStreak:provider','0'))||0);
    const legacyMigrated=meta(db,'flow:legacyNoChargeStreakMigratedV2','')==='done';
    const recoveredAt=String(meta(db,'flow:lastProviderRecoveryAt','')).trim();
    if(providerStreak<1&&!legacyMigrated&&!recoveredAt){
      try{
        const legacy=db.prepare("SELECT key,value FROM factory_meta WHERE key LIKE 'flow:noChargeStreak:%' AND key<>'flow:noChargeStreak:provider'").all();
        providerStreak=Math.max(0,...legacy.map(x=>Number(x.value)||0));
        if(providerStreak>0)setMeta(db,'flow:noChargeStreak:provider',String(providerStreak));
        setMeta(db,'flow:legacyNoChargeStreakMigratedV2','done');
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
  const retries=db.prepare("SELECT * FROM factory_items WHERE status IN ('regen_wait','draft') AND retryStrategy IN ('reuse_prompt','revise_prompt','new_story') AND reviewFeedback IS NOT NULL AND TRIM(reviewFeedback)<>'' ORDER BY updatedAt,episode").all();
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
    db=dbOpen();ensureSchema(db);ensureProductionPlan(db);reconcileGenerationCreditAccounting(db);ensureBacklog(db);normalizeUnconfirmedPreGenerationRows(db);normalizeReauthorizedReviewerRetries(db);normalizeConsumedReviewerRetries(db);auditRedoState(db);ensureConfirmedGenerationAccounting(db);normalizeRecoverableBrowserRetrievalCrash(db);quarantinePriorDayAmbiguous(db);quarantineStaleReviewerRetryAmbiguous(db);normalizeOutOfOrderAmbiguous(db);repairLegacyBackoffAfterConfirmedSuccess(db);repairProviderBackoffAfterConfirmedSuccessV2(db);normalizeLiveNoChargeCooldown(db);
    setMeta(db,'automation:provider',PROVIDER);setMeta(db,'automation:paidDependencyDetected','false');setMeta(db,'automation:tinyfishRequired','false');setMeta(db,'automation:tinyfishFallback','disabled');setMeta(db,'automation:freeBrowserProfile',PROFILE_DIR);
    setMeta(db,'automation:serialFlowMode','true');
    setMeta(db,'automation:serialFlowSop','FLOW-SERIAL-GEN-RECOVER-001');
    setMeta(db,'automation:serialHandoffMode','recover-to-review-no-approval-gate');
    setMeta(db,'maintenance:supabasePasskeysLastOutcome','deferred_while_content_worker_active');

    // Recovery token is a dedicated READ-ONLY Flow operation. It runs before
    // the generation-pause gate because the pause blocks submits, not retrieval.
    // If a token is present, this worker tick ALWAYS returns after recovery:
    // successful or pending. It can never fall through to Generate.
    const migrated=await migrateProfileOnce(db);if(!migrated)return;
    const goldenRecovery=await recoverGoldenRunIfRequested(db);
    if(goldenRecovery.needed)return;

    if(generationPauseActive()){
      const until=generationPauseIso();
      setMeta(db,'flow:state','PAUSADO');
      setMeta(db,'flow:currentStep','generation-paused-until');
      setMeta(db,'flow:message','Generation paused by operator until '+until+'. Publication remains active.');
      publish('GENERATION_PAUSED',{until,message:'No Google Flow generation may be submitted before the configured pause expires.'});
      return;
    }
    const feedbackState=await interpretPendingReviewFeedback(db);if(feedbackState==='retry')return;
    row=productionCandidate(db);
    const legacyUsed=effectiveDailyCount(db);
    if(row&&String(row.status)==='generating'){publish('RECOVERY_PICKED',{episode:'E'+row.episode,job_id:row.id,state:String(lifecycle(db,row)?.state||''),used_today:legacyUsed});await processRow(db,row);return}
    const priorityRetry=isReviewerRetry(row);
    const manualExtraAuthorized=dailyProductionLimit(db)>Number(BASE_DAILY_PRODUCTION_LIMIT||1)&&effectiveDailyCount(db)<dailyProductionLimit(db);
    let creditGate={open:true,used:manualExtraAuthorized?effectiveDailyCount(db):creditCycleUsage(db),target:manualExtraAuthorized?dailyProductionLimit(db):Number(BASE_DAILY_PRODUCTION_LIMIT||1),reason:priorityRetry?'reviewer-retry-bypass':(manualExtraAuthorized?'operator-generate-extra-bypass':'unknown')};
    if(!priorityRetry&&!manualExtraAuthorized){
      creditGate=await ensureDailyCreditCycle(db);
      if(!creditGate.open){
        publish('AUTOMATIC_BATCH_WAITING_FOR_DAILY_CREDITS',{used:creditGate.used,target:creditGate.target,reason:creditGate.reason,credits:creditGate.credits??null,cycle_id:creditGate.cycle?.id||null});
        return;
      }
    }
    const used=Number(creditGate.used||0);
    if(used>=Number(BASE_DAILY_PRODUCTION_LIMIT||1)&&!priorityRetry&&!manualExtraAuthorized){
      setMeta(db,'flow:dailyCreditBatchOpen','false');
      setMeta(db,'flow:dailyCreditRefreshWaiting','true');
      setMeta(db,'flow:state','ESPERANDO CRÉDITOS');
      setMeta(db,'flow:currentStep','waiting-daily-credit-refresh');
      setMeta(db,'flow:message','Lote automático completo: '+used+'/'+dailyProductionLimit(db)+'. Esperando la próxima renovación diaria de 50 créditos de Google Flow.');
      publish('DAILY_CREDIT_BATCH_COMPLETE',{used,limit:dailyProductionLimit(db),credit_cycle_id:creditGate.cycle?.id||null,next_episode:row?('E'+row.episode):null});
      return;
    }
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
    publish(priorityRetry?'REVIEW_RETRY_PICKED':(manualExtraAuthorized?'MANUAL_EXTRA_PICKED':'PRODUCTION_PICKED'),{episode:'E'+row.episode,job_id:row.id,used_credit_cycle:used,remaining_credit_cycle:Math.max(0,creditGate.target-used),credit_cycle_id:creditGate.cycle?.id||null,daily_limit_bypassed:priorityRetry||manualExtraAuthorized});await processRow(db,row);
  }catch(err){
    const message=compact(err?.stack||err?.message||err,900);
    try{if(db&&row){const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row,lc=lifecycle(db,fresh)||{},state=String(lc.state||'').toUpperCase(),attempts=Number(fresh.runtimeAttemptCount||0)+1,beforeGenerate=!AFTER_GENERATE.has(state)&&!AMBIGUOUS.has(state),browserRetrievalCrash=/Target crashed|Target closed|Browser closed/i.test(message)&&(AFTER_GENERATE.has(state)||AMBIGUOUS.has(state)),baseBackoff=browserRetrievalCrash?5000:(beforeGenerate?10000:60000),capBackoff=browserRetrievalCrash?15000:(beforeGenerate?5*60*1000:60*60*1000),backoff=Math.min(capBackoff,baseBackoff*Math.pow(2,Math.min(attempts-1,6))),nextTry=Date.now()+backoff;if(/FLOW_TRANSIENT_NO_CHARGE/.test(message)){
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
