import fs from 'node:fs';
import { createHash } from 'node:crypto';

const read=p=>fs.readFileSync(p,'utf8');
const fail=m=>{throw new Error('[RUNTIME CONTRACT] '+m)};
const must=(v,m)=>{if(!v)fail(m)};

const master=read('GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md');
const sop=JSON.parse(read('GOOGLE_FLOW_AUTOMATION_SOP.json'));
const manifest=JSON.parse(read('FLOW_SOP_KNOWLEDGE_MANIFEST.json'));
const schema=JSON.parse(read('publisher.config.schema.json'));
const provider=read('free-browser-provider.js');
const runtimeConfig=read('runtime-config.js');
const init=read('runtime-init.js');
const server=read('server.js');
const publication=read('publication.js');

const sha=createHash('sha256').update(master).digest('hex');
must(sop.sop_id==='FLOW-SOP-v1.0','wrong SOP version');
must(sop.sha256===sha,'SOP JSON hash does not match master');
must(manifest.master_sha256===sha,'manifest hash does not match master');
must(manifest.inheritance_required===true,'knowledge inheritance not mandatory');
must(manifest.runtime_contract?.semantic_redo_interpretation===true,'knowledge contract must require semantic REDO interpretation');
must(manifest.runtime_contract?.post_submit_timeout_resubmit===false,'knowledge contract must forbid post-submit timeout resubmit');
must(manifest.runtime_contract?.daily_flow_credit_refresh_gate===true,'knowledge contract must require daily Flow credit refresh gate');
must(manifest.runtime_contract?.calendar_midnight_opens_batch===false,'knowledge contract must forbid midnight batch reset');
must(manifest.runtime_contract?.daily_flow_credit_grant===50,'knowledge contract must encode 50 daily Flow credits');
must(manifest.runtime_contract?.paid_monthly_credits_protected_until_daily_refresh===true,'knowledge contract must protect paid monthly credits');
must(sop.generation?.post_submit_timeout_action==='reconcile_only_no_resubmit','machine SOP timeout action mismatch');
must(sop.generation?.daily_credit_grant===50,'machine SOP daily Flow grant mismatch');
must(sop.generation?.automatic_batch_credit_gate==='wait-for-daily-flow-refresh','machine SOP credit-cycle gate missing');
must(sop.generation?.calendar_midnight_opens_batch===false,'machine SOP must forbid midnight batch opening');
must(sop.generation?.paid_monthly_credits_protected===true,'machine SOP must protect paid monthly credits');
must(sop.review?.feedback_interpreter==='semantic-ai','machine SOP semantic feedback interpreter missing');

const a=schema.properties?.automation?.properties||{};
for(const k of ['exactly_once_submit','strict_serial_generation','project_grid_recovery','current_consent_only','review_metadata_required','golden_test_required','semantic_redo_interpretation']){
  must(a[k]?.const===true,'schema invariant '+k+' must be const true');
}
must(a.post_submit_timeout_resubmit?.const===false,'schema invariant post_submit_timeout_resubmit must be const false');
const g=schema.properties?.generation?.properties||{};
must(g.daily_credit_grant?.const===50,'schema daily_credit_grant must be const 50');
must(g.automatic_batch_credit_gate?.const==='wait-for-daily-flow-refresh','schema must require renewal-driven automatic batch');
must(g.credit_refresh_poll_minutes?.default===5,'schema credit refresh poll default must be 5 minutes');
must(g.credit_refresh_guard_hours?.default===20,'schema credit refresh guard default must be 20h');
must(g.credit_refresh_fallback_hours?.default===30,'schema credit refresh fallback default must be 30h');
must(schema.properties?.schedule?.properties?.generation_strategy?.const==='sequential','generation strategy must be sequential');
must(schema.properties?.knowledge?.properties?.flow_sop_version?.const==='FLOW-SOP-v1.0','schema knowledge version mismatch');
const ytSchema=(schema.properties?.publication?.properties?.providers?.items?.oneOf||[]).find(x=>x?.properties?.type?.const==='youtube');
must(ytSchema?.properties?.privacy_before_publish?.const==='private','YouTube schema must upload private first');
must(ytSchema?.properties?.release_mode?.const==='private_then_public_at_posting_time','YouTube schema release mode mismatch');
must(ytSchema?.properties?.use_publish_at?.const===false,'YouTube schema must forbid publishAt');
must(ytSchema?.properties?.upload_lead_minutes?.const===390,'YouTube schema must require 390-minute lead');

for(const token of ['flow-generate-icon-button','arrow_forward','SUBMIT_BOUNDARY_ENTERED','automatic_submit_forbidden','flow-grid-tile-container','flow-tile-hover-footer','EPISODE_INTENT_REPAIRED','CREATIVE_PACKAGE_READY','creativePackageHash','source:\'creative-package\'','let editor=await waitFlowReady(page,30000)','FLOW_UNUSUAL_ACTIVITY_OVERNIGHT','30*60*1000','8*60*60*1000','24*60*60*1000','GEMINI_FEEDBACK_URL','FEEDBACK_AI_INTERPRET_START','creative_rewrite','POST_SUBMIT_TIMEOUT_RECONCILIATION_ONLY','DAILY_FLOW_GRANT_CREDITS','ensureDailyCreditCycle','WAITING_DAILY_FLOW_CREDIT_REFRESH','flow:dailyCreditBatchOpen','daily-flow-credit-refresh']){
  must(provider.includes(token),'provider contract missing '+token);
}
must(!provider.includes("await waitFlowReady(page,30000);\n  const editor=await promptEditor(page);"),'provider must not re-query the Flow composer immediately after readiness');
for(const token of ["const salt=parseInt(randomUUID().replace(/-/g,'').slice(0,8),16)","const port=9400+(salt%1000)","await sleep(3000)","connectOverCDP('http://127.0.0.1:'+port,{timeout:15000})"]){
  must(provider.includes(token),'Frutti-compatible browser launch contract missing '+token);
}
must(!provider.includes('--disk-cache-dir=/tmp/publisher-chrome-cache'),'canonical browser launch must not add custom disk-cache fingerprint flags');
for(const token of ['function scheduleNoChargeRetry(db,row,opts={})','flow:transientCooldownUntil',"'flow:noChargeStreak:provider'","if(providerCooldown>Date.now())return null",'FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED',"status IN ('review','completed')",'flow:legacyNoChargeStreakMigratedV2','FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED_V2','openStrictSinglePostBaselineTile','same-session-identity-verified-post-baseline-asset','FLOW_STRICT_RECOVERY_PROOF_REQUIRED','flow_recovered_assets','flow_rejected_media_hashes','FLOW_ASSET_ID_ALREADY_RECOVERED','FLOW_REJECTED_MEDIA_REUSED','openVerifiedFlowAsset','freshFlowAssetCandidates','TARGETED_RECOVERY_REVIEW_READY','generation_submit_forbidden:true']){
  must(provider.includes(token),'provider no-charge runtime contract missing '+token);
}
for(const forbidden of ['FLOW_FAILED_TILE_RETRY_CLICKED','clickNativeRetry','repairEarthE10NoGeneration','repairEarthE11KnownNoCharge','repairEarthTodayAfterOperatorConfirmedOnlyFirstRender','realignEarthE11ToFruttiProtocol','rearmEarthE11AfterFullFruttiPort','rearmEarthE11AfterStableComposerFix']){
  must(!provider.includes(forbidden),'canonical Publisher runtime contains forbidden immediate-retry/show-forensic token '+forbidden);
}
for(const token of ['EARTH_IN_10_AUTONOMOUS_EPISODES','enforceEpisodeIntent','effectiveVideoVisualStyle','publisherWebStyleLeak','materializeCreativePackage','validateEpisodePrompt','SHOW_BIBLE_REQUIRED','PROMPT_QUALITY_GATE','earthIdeaConflict','earthCurrentIntentConflict','EARTH_UNIQUE_IDEA_BANK_EXHAUSTED','EARTH_DUPLICATE_LANDSCAPE_BLOCKED']){
  must(runtimeConfig.includes(token),'runtime content contract missing '+token);
}
for(const token of ['runtime_knowledge','creativePackageHash','creativePackageId','knowledge:flowSopLoaded','automation:exactlyOnceSubmit','automation:strictSerialGeneration']){
  must(init.includes(token),'runtime-init contract missing '+token);
}
for(const token of ["app.get('/factory/knowledge'","automation_safety","stable_composer_handoff:true","native_no_charge_retry:false","immediate_native_retry_disabled:true","adaptive_no_charge_backoff:true","unusual_activity_exponential_backoff:true","provider_wide_unusual_activity_backoff:true","monotonic_provider_cooldown:true","successful_render_resets_provider_backoff:true","successful_redos_count_toward_daily_target:true","legacy_streak_resurrection_guard:true","strict_post_submit_recovery_match:true","catalog_wide_creative_uniqueness:true","no_landscape_repeat_cycle:true","youtube_preapproval_private_staging_disabled:true","cloud_stock_until_upload_window:true","private_upload_at_1230:true","direct_private_to_public_at_1900:true","native_publish_at_disabled:true","youtube_upload_lead_minutes_390:true","manual_stock_recovery_upload:true","recovery_upload_cloud_required:true","flow_asset_identity_gate:true","recovered_asset_reuse_blocked:true","duplicate_content_hash_guard:true","fixed_grid_multiset_recovery:true","post_click_asset_identity_verified:true","recovery_token_never_submits:true","show_specific_repairs_isolated:true","status='feedback_wait'","prompt_integrity","prompt_show_bible_gate:true","atomic_creative_package:true","approval_before_external_storage:true","reject_purges_external_artifacts:true","semantic_ai_redo_interpretation:true","post_submit_timeout_never_resubmits:true","daily_flow_credit_refresh_gate:true","calendar_midnight_does_not_open_batch:true","paid_monthly_credits_protected_until_daily_refresh:true","credit_cycle:creditCycleHealth","ai_pending","prompts_rematerialized:true","signedReviewUrl","deleteReviewObject"]){
  must(server.includes(token),'server contract missing '+token);
}
for(const token of ['earthPromptIsEpisodeBound','episode-generation-prompt','creativePackageDigest','quota_wait','shiftPendingQueueAfter','stored-package']){
  must(publication.includes(token),'publication metadata/quota contract missing '+token);
}
for(const token of ['saveReviewAsset','local-volume-until-approval','remoteUrl=NULL','reviewVideoId=NULL']){
  must(provider.includes(token),'pre-approval local-only review contract missing '+token);
}
must(server.includes("/publication/:id/recover-video"),'per-video manual recovery endpoint missing');
must(server.includes("uploadReviewFile(tmp,{itemId:'stock-recovery-'"),'manual recovery must persist to private cloud');
must(server.includes("String(item.status||'')!=='backup_hold'"),'manual recovery must be restricted to backup_hold');
must(publication.includes('publishNowLikeManual'),'explicit PRIVATE-to-PUBLIC release path missing');
must(publication.includes("status:{privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true}"),'12:30 plain PRIVATE upload contract missing');
must(publication.includes("new Date(Date.parse(scheduledAt)-390*60000).toISOString()"),'390-minute upload lead contract missing');
must(publication.includes("zonedLocal(localDay,'19:00',tz)"),'19:00 release-time normalization missing');
must(publication.includes('Uploaded plain PRIVATE at the configured 12:30 publication-prep time. No publishAt is set.'),'12:30 private upload evidence missing');
must(!publication.includes("privacyStatus:'private',publishAt:item.scheduledAt"),'native YouTube publishAt scheduling must remain disabled');
for(const token of ['isReviewStorageUri','readReviewRange','deleteReviewObject','containsSyntheticMedia:true','APPROVAL_GATE','purgeRejected','purgePrivateVideosByTitle']){
  must(publication.includes(token),'publication/approval/rejection contract missing '+token);
}

console.log(JSON.stringify({
  ok:true,
  contract:'publisher-runtime-flow-v1',
  sop_version:sop.sop_id,
  sop_sha256:sha,
  strict_serial:true,
  exactly_once_submit:true,
  project_grid_recovery:true,
  knowledge_inheritance:true
},null,2));
