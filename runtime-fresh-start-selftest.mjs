import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-fresh-start-'));
const fail=m=>{throw new Error('[FRESH START SELFTEST] '+m)};

process.env.DATA_DIR=dir;
process.env.PUBLISHER_ENABLED='true';
process.env.PUBLISHER_FLOW_SOP_VERSION='FLOW-SOP-v1.0';
process.env.PUBLISHER_FLOW_SOP_SHA256='b857758bc2f46b0759a1327a39a32566e4168b6629dfa0103357ad1ec58ffab1';
process.env.PUBLISHER_INSTANCE_ID='fresh-start-selftest';
process.env.PUBLISHER_RESET_ON_INSTANCE_CHANGE='true';
process.env.PUBLISHER_CONFIG_JSON=JSON.stringify({
  runtime_version:'publisher-runtime-v1',
  identity:{publisher_name:'Factory Selftest',show_name:'Factory Selftest',language:'en-US',timezone:'UTC'},
  content:{serialized:false,videos_per_day:3,creative_bible:'Selftest Creative Bible',initial_episodes:[{hook:'SELFTEST START',story:'A concrete first selftest episode intent with one clear visual action and payoff.'}],autonomous_seed_ideas:[{hook:'SELFTEST CONTINUATION',story:'A concrete continuation intent that changes one visual event without using an internal planner placeholder.'}]},
  generation:{provider:'google-flow',model_intent:'Omni 1.1 Flash',resolution_intent:'720p',download_quality:'1080p Upscaled',duration_seconds:10,aspect_ratio:'9:16',output_count:1,daily_credit_grant:50,automatic_batch_credit_gate:'wait-for-daily-flow-refresh',credit_refresh_poll_minutes:5,credit_refresh_guard_hours:20,credit_refresh_fallback_hours:30},
  automation:{provider:'free-browser-provider',persistent_profile:true,tinyfish_required:false,flow_sop_version:'FLOW-SOP-v1.0',flow_sop_sha256:'b857758bc2f46b0759a1327a39a32566e4168b6629dfa0103357ad1ec58ffab1',inherit_flow_sop:true,exactly_once_submit:true,strict_serial_generation:true,project_grid_recovery:true,current_consent_only:true,review_metadata_required:true,golden_test_required:true},
  knowledge:{flow_sop_version:'FLOW-SOP-v1.0',flow_sop_sha256:'b857758bc2f46b0759a1327a39a32566e4168b6629dfa0103357ad1ec58ffab1',inherit:true},
  review:{mode:'review'},
  schedule:{timezone:'UTC',indefinite:true,generation_strategy:'sequential',posting_times:['19:00'],upload_lead_minutes:390},
  publication:{providers:[{type:'youtube',hashtags:['Shorts']}]},
  security:{passkeys:true,recovery_pin:true,session_management:true}
});

try{
  await import('./runtime-init.js?fresh='+Date.now());
  const {CONFIG}=await import('./runtime-config.js');
  const dbPath=path.join(dir,'publisher-runtime','factory.sqlite');
  if(!fs.existsSync(dbPath))fail('factory.sqlite not created');
  const db=new DatabaseSync(dbPath,{readOnly:true});
  const meta=k=>db.prepare('SELECT value FROM factory_meta WHERE key=?').get(k)?.value;
  const knowledgeCount=Number(db.prepare('SELECT COUNT(*) n FROM runtime_knowledge').get()?.n||0);
  if(meta('automation:factoryEnabled')!=='false')fail('brand-new durable automation gate must start closed even when PUBLISHER_ENABLED=true');
  if(meta('knowledge:flowSopLoaded')!=='true')fail('canonical SOP pack not marked loaded');
  if(meta('knowledge:flowSopSha256')!=='b857758bc2f46b0759a1327a39a32566e4168b6629dfa0103357ad1ec58ffab1')fail('runtime SOP hash mismatch');
  if(meta('automation:exactlyOnceSubmit')!=='true')fail('exactly-once invariant missing');
  if(meta('automation:strictSerialGeneration')!=='true')fail('strict-serial invariant missing');
  if(meta('automation:projectGridRecovery')!=='true')fail('project-grid recovery invariant missing');
  if(meta('automation:reviewMetadataRequired')!=='true')fail('Review metadata invariant missing');
  if(meta('automation:dailyFlowCreditRefreshGate')!=='true')fail('daily Flow credit refresh gate invariant missing');
  if(meta('automation:calendarMidnightOpensBatch')!=='false')fail('calendar midnight must not open automatic batch');
  if(meta('automation:dailyFlowCreditGrant')!=='50')fail('daily Flow grant invariant missing');
  if(meta('automation:paidMonthlyCreditsProtectedUntilDailyRefresh')!=='true')fail('paid monthly credits protection invariant missing');
  if(knowledgeCount!==8)fail('expected 8 runtime knowledge docs, found '+knowledgeCount);
  if(CONFIG.schedule.generation_strategy!=='sequential')fail('fresh runtime is not sequential');
  if(CONFIG.schedule.indefinite!==true)fail('fresh runtime scheduler is not indefinite');
  const episodeRows=db.prepare("SELECT episode,prompt,title,description,creativePackageHash FROM factory_items ORDER BY episode").all();
  if(!episodeRows.length)fail('fresh runtime did not create backlog episodes');
  for(const row of episodeRows){
    if(!String(row.prompt||'').trim())fail('episode '+row.episode+' has an empty prompt');
    if(!String(row.prompt||'').includes('Selftest Creative Bible'))fail('episode '+row.episode+' prompt does not contain the Show Bible');
    if(!String(row.title||'').trim())fail('episode '+row.episode+' has no title in its creative package');
    if(!String(row.description||'').trim())fail('episode '+row.episode+' has no description in its creative package');
    if(!String(row.creativePackageHash||'').trim())fail('episode '+row.episode+' has no creative package hash');
  }
  db.close();
  console.log(JSON.stringify({
    ok:true,
    contract:'publisher-runtime-fresh-start-v1',
    sop_version:meta?.flow_sop_version||'FLOW-SOP-v1.0',
    sop_sha256:'b857758bc2f46b0759a1327a39a32566e4168b6629dfa0103357ad1ec58ffab1',
    knowledge_documents:knowledgeCount,
    durable_gate_initial:'false',
    env_authorization:'true',
    automatic_activation_requires_readiness:true,
    generation_strategy:CONFIG.schedule.generation_strategy,
    scheduler_indefinite:CONFIG.schedule.indefinite,
    backlog_episodes_with_nonempty_prompts:episodeRows.length,
    prompt_show_bible_gate:true,
    atomic_creative_packages:true
  },null,2));
}finally{
  fs.rmSync(dir,{recursive:true,force:true});
}
