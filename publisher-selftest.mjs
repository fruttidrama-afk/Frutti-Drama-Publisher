import fs from 'node:fs';
import { createHash } from 'node:crypto';

const read=p=>fs.readFileSync(p,'utf8');
const must=(ok,msg)=>{if(!ok){console.error('[PUBLISHER SELFTEST] FAIL:',msg);process.exit(1)}};
const has=(text,token,label)=>must(text.includes(token),label+' missing '+token);

const master=read('GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md');
const machine=JSON.parse(read('GOOGLE_FLOW_AUTOMATION_SOP.json'));
const manifest=JSON.parse(read('FLOW_SOP_KNOWLEDGE_MANIFEST.json'));
const hash=createHash('sha256').update(master).digest('hex');

const {buildPublicationCopy}=await import('./publication-copy.js');
const metadataRegression=buildPublicationCopy({
  hook:'PLITVICE WATER',
  story:'A cinematic glide through Croatia’s Plitvice Lakes. Crystal turquoise water spills over moss-covered limestone terraces into layered pools surrounded by dense green forest and soft natural haze.',
  prompt:'CREATIVE BIBLE\nExample only: Create a ten-second video of Patagonia at sunrise.\n\nHOOK: PLITVICE WATER\nEPISODE INTENT: A cinematic glide through Croatia’s Plitvice Lakes. Crystal turquoise water spills over moss-covered limestone terraces into layered pools surrounded by dense green forest and soft natural haze.',
  contextTerms:[],
  hashtags:['#Shorts','#ViralShorts'],
  showName:'Earth in Ten',
  maxTitleLength:100
});
must(!/PATAGONIA/i.test(metadataRegression.title),'Earth metadata must never inherit Patagonia from Show Bible examples');
must(/PLITVICE/i.test(metadataRegression.title),'Earth metadata must derive from the current episode intent');

must(machine.sop_id==='FLOW-SOP-v1.0','SOP version');
must(machine.sha256===hash,'machine SOP hash mismatch');
must(manifest.master_sha256===hash,'manifest SOP hash mismatch');
must(manifest.inheritance_required===true,'inheritance must be required');
must(manifest.runtime_contract?.semantic_redo_interpretation===true,'semantic REDO interpretation must be inherited');
must(manifest.runtime_contract?.post_submit_timeout_resubmit===false,'post-submit timeout resubmission must be forbidden');
must(manifest.runtime_contract?.daily_flow_credit_refresh_gate===true,'daily Flow credit refresh gate must be inherited');
must(manifest.runtime_contract?.calendar_midnight_opens_batch===false,'midnight must not open an automatic batch');
must(manifest.runtime_contract?.daily_flow_credit_grant===50,'knowledge contract must encode 50 daily Flow credits');
must(manifest.runtime_contract?.paid_monthly_credits_protected_until_daily_refresh===true,'paid monthly credits must be protected');
must(machine.generation?.post_submit_timeout_action==='reconcile_only_no_resubmit','machine SOP timeout action');
must(machine.generation?.daily_credit_grant===50,'machine SOP daily credit grant');
must(machine.generation?.automatic_batch_credit_gate==='wait-for-daily-flow-refresh','machine SOP renewal-driven gate');
must(machine.generation?.calendar_midnight_opens_batch===false,'machine SOP midnight rule');
must(machine.generation?.paid_monthly_credits_protected===true,'machine SOP paid-credit protection');
must(machine.review?.feedback_interpreter==='semantic-ai','machine SOP semantic feedback interpreter');
must(Array.isArray(manifest.canonical_files)&&manifest.canonical_files.length>=7,'knowledge pack incomplete');

const provider=read('free-browser-provider.js');
const runtimeConfig=read('runtime-config.js');
for(const [token,label] of [
  ['flow-generate-icon-button','verified Flow submit selector'],
  ['arrow_forward','verified Flow submit icon'],
  ['SUBMIT_ARROW_CLICKED','input evidence event'],
  ['SUBMIT_BOUNDARY_ENTERED','exactly-once boundary'],
  ['automatic_submit_forbidden','post-boundary submit lock'],
  ['flow-grid-tile-container','project-grid recovery'],
  ['flow-tile-hover-footer','recorded asset-open path'],
  ['REVIEW_METADATA_READY','review metadata gate'],
  ['EPISODE_INTENT_REPAIRED','Earth episode intent repair gate'],
  ['CREATIVE_PACKAGE_READY','prompt/title/description package checkpoint'],
  ["status IN ('regen_wait','draft') AND retryStrategy IN ('reuse_prompt','revise_prompt','new_story')",'human REDO priority queue including semantic creative rewrites'],
  ['creativePackageHash','creative package hash link'],
  ['fresh-video-asset-ambiguous','fresh Flow video correlation ambiguity guard'],
  ['FLOW_DUPLICATE_REVIEW_MEDIA','duplicate review-media rejection'],
  ["source:'creative-package'",'review metadata preservation'],
  ['let editor=await waitFlowReady(page,30000)','stable Flow composer handoff'],
  ['FLOW_UNUSUAL_ACTIVITY_OVERNIGHT','24h unusual-activity fallback'],
  ['30*60*1000','first unusual-activity delay'],
  ['8*60*60*1000','fifth unusual-activity delay'],
  ['24*60*60*1000','24h unusual-activity fallback'],
  ['GEMINI_FEEDBACK_URL','semantic AI feedback surface'],
  ['FEEDBACK_AI_INTERPRET_START','semantic REDO interpreter'],
  ['creative_rewrite','semantic creative replacement decision'],
  ['POST_SUBMIT_TIMEOUT_RECONCILIATION_ONLY','post-submit timeout reconciliation-only marker'],
  ['DAILY_FLOW_GRANT_CREDITS','50-credit daily Flow grant'],
  ['ensureDailyCreditCycle','daily credit-cycle scheduler gate'],
  ['WAITING_DAILY_FLOW_CREDIT_REFRESH','daily refill waiting state'],
  ['flow:dailyCreditBatchOpen','durable daily batch gate'],
  ['daily-flow-credit-refresh','daily refill cycle-opening evidence']
]) has(provider,token,label);
must(!provider.includes("await waitFlowReady(page,30000);\n  const editor=await promptEditor(page);"),'Flow composer must not be re-queried immediately after readiness');
for(const [token,label] of [
  ["const salt=parseInt(randomUUID().replace(/-/g,'').slice(0,8),16)",'fresh browser session salt'],
  ["const port=9400+(salt%1000)",'fresh CDP port'],
  ["await sleep(3000)",'Chrome settle period'],
  ["connectOverCDP('http://127.0.0.1:'+port,{timeout:15000})",'Frutti-compatible CDP attach']
]) has(provider,token,label);
must(!provider.includes('--disk-cache-dir=/tmp/publisher-chrome-cache'),'custom browser cache flags must stay disabled');
has(provider,"const submit=await clickSubmitExactlyOnce",'submit action object capture');
has(provider,"const submitMode=String(submit?.mode||'start-generation-direct')",'submit mode extraction');
has(provider,"pre_consent_fingerprint:String(submit?.pre_consent_fingerprint||'')",'safe consent fingerprint lifecycle handoff');
must(!provider.includes("const submitMode=await clickSubmitExactlyOnce"),'submit result must never be treated as a string');
for(const [token,label] of [
  ['function scheduleNoChargeRetry(db,row,opts={})','adaptive no-charge scheduler'],
  ['flow:transientCooldownUntil','provider-wide no-charge cooldown'],
  ["'flow:noChargeStreak:provider'",'provider-wide no-charge streak persistence'],
  ['FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED','legacy successful-render backoff repair'],
  ['FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED_V2','post-success provider streak repair v2'],
  ['flow:legacyNoChargeStreakMigratedV2','legacy streak resurrection guard'],
  ['openStrictSinglePostBaselineTile','strict single post-baseline tile recovery'],
  ['same-session-identity-verified-post-baseline-asset','same-session identity-verified recovery proof'],
  ['flow_recovered_assets','recovered Flow asset registry'],
  ['flow_rejected_media_hashes','wrong-media quarantine registry'],
  ['FLOW_ASSET_ID_ALREADY_RECOVERED','reused Flow asset ID rejection'],
  ['FLOW_REJECTED_MEDIA_REUSED','rejected content hash reuse rejection'],
  ['openVerifiedFlowAsset','post-click Flow asset verifier'],
  ['freshFlowAssetCandidates','fixed-grid asset multiset recovery'],
  ['TARGETED_RECOVERY_REVIEW_READY','targeted existing-render recovery'],
  ['generation_submit_forbidden:true','recovery-only no-submit marker'],
  ['nextSubmissionBaseline','next-submit temporal upper bound'],
  ['assetPresentInInventory','temporal bracket membership check'],
  ['download-reopen-asset-id-verified','download retry reopens same asset ID'],
  ['FLOW_STRICT_RECOVERY_PROOF_REQUIRED','strict recovery proof gate'],
  ["status IN ('review','completed')",'successful retained render daily accounting'],
  ["if(providerCooldown>Date.now())return null",'provider cooldown submit gate']
]) has(provider,token,label);
for(const forbidden of ['FLOW_FAILED_TILE_RETRY_CLICKED','clickNativeRetry','repairEarthE10NoGeneration','repairEarthE11KnownNoCharge','repairEarthTodayAfterOperatorConfirmedOnlyFirstRender','realignEarthE11ToFruttiProtocol','rearmEarthE11AfterFullFruttiPort','rearmEarthE11AfterStableComposerFix']){
  must(!provider.includes(forbidden),'canonical runtime must exclude '+forbidden);
}
has(runtimeConfig,'EARTH_IN_10_AUTONOMOUS_EPISODES','Earth autonomous geographic ideas');
has(runtimeConfig,'enforceEpisodeIntent','Earth episode intent validator');
has(runtimeConfig,'CONTENT_GATE','generic planner-placeholder prompt block');
has(runtimeConfig,'effectiveVideoVisualStyle','video/web style isolation');
has(runtimeConfig,'publisherWebStyleLeak','web-style contamination detector');
has(runtimeConfig,'materializeCreativePackage','atomic prompt/title/description creation');
has(runtimeConfig,'validateEpisodePrompt','Show Bible prompt validator');
has(runtimeConfig,'SHOW_BIBLE_REQUIRED','Show Bible hard requirement');
has(runtimeConfig,'PROMPT_QUALITY_GATE','nonempty prompt quality gate');
has(runtimeConfig,'earthIdeaConflict','Earth catalog-wide uniqueness matcher');
has(runtimeConfig,'EARTH_UNIQUE_IDEA_BANK_EXHAUSTED','Earth no-repeat exhaustion guard');
has(runtimeConfig,'EARTH_DUPLICATE_LANDSCAPE_BLOCKED','Earth duplicate landscape hard gate');
has(runtimeConfig,'Compare canonical episode metadata only','Earth uniqueness excludes embedded Show Bible prompt examples');
must(!runtimeConfig.includes("[other.hook,other.story,other.title,other.description,other.prompt]"),'Earth uniqueness must never compare full prompt/Show Bible text');

const init=read('runtime-init.js');
has(init,'runtime_knowledge','runtime knowledge table');
has(init,'creativePackageHash','creative package schema');
has(init,'creativePackageId','creative package id schema');
has(init,"knowledge:flowSopLoaded",'knowledge loaded marker');
has(init,"automation:exactlyOnceSubmit",'exactly-once metadata');
has(init,"automation:strictSerialGeneration",'strict serial metadata');
has(init,"automation:projectGridRecovery",'project-grid metadata');

const server=read('server.js');
has(server,"app.get('/factory/knowledge'",'knowledge endpoint');
has(server,'automation_safety','health safety block');
has(server,"status='feedback_wait'",'REDO enters semantic interpretation state before choosing a correction');
has(server,'prompt_integrity','live prompt integrity health');
has(server,'prompt_show_bible_gate:true','Show Bible prompt safety flag');
has(server,'atomic_creative_package:true','atomic creative package safety flag');
has(server,'stable_composer_handoff:true','stable Flow composer health invariant');
has(server,'native_no_charge_retry:false','native no-charge Retry disabled invariant');
has(server,'immediate_native_retry_disabled:true','immediate native retry safety invariant');
has(server,'adaptive_no_charge_backoff:true','adaptive no-charge backoff health invariant');
has(server,'provider_wide_unusual_activity_backoff:true','provider-wide unusual-activity health invariant');
has(server,'monotonic_provider_cooldown:true','monotonic provider cooldown health invariant');
has(server,'successful_render_resets_provider_backoff:true','successful render resets provider backoff');
has(server,'successful_redos_count_toward_daily_target:true','successful REDO renders count toward daily target');
has(server,'legacy_streak_resurrection_guard:true','legacy streak resurrection guard');
has(server,'strict_post_submit_recovery_match:true','strict post-submit recovery invariant');
has(server,'catalog_wide_creative_uniqueness:true','catalog-wide creative uniqueness invariant');
has(server,'no_landscape_repeat_cycle:true','no landscape repeat cycle invariant');
has(server,'youtube_preapproval_private_staging_disabled:true','no YouTube staging immediately after approval');
has(server,'cloud_stock_until_upload_window:true','cloud stock until upload window');
has(server,'private_upload_at_1230:true','private upload at 12:30');
has(server,'direct_private_to_public_at_1900:true','direct private-to-public edit at 19:00');
has(server,'native_publish_at_disabled:true','native publishAt disabled');
has(server,'youtube_upload_lead_minutes_390:true','390-minute YouTube upload lead');
has(server,'manual_stock_recovery_upload:true','manual Stock recovery upload invariant');
has(server,'recovery_upload_cloud_required:true','recovery upload must persist to cloud');
has(server,'flow_asset_identity_gate:true','Flow asset identity gate');
has(server,'recovered_asset_reuse_blocked:true','recovered Flow asset reuse blocked');
has(server,'duplicate_content_hash_guard:true','duplicate content hash guard');
has(server,'fixed_grid_multiset_recovery:true','fixed-grid multiset recovery');
has(server,'post_click_asset_identity_verified:true','post-click asset identity verification');
has(server,'recovery_token_never_submits:true','targeted recovery token can never submit');
has(server,'adjacent_submit_temporal_bracket:true','adjacent-submit temporal recovery bracket');
has(server,'download_reopen_by_asset_identity:true','download reopen by Flow asset identity');
has(server,'zero_copy_approval_handoff:true','zero-copy approval handoff');
has(server,'approval_enospc_copy_eliminated:true','approval ENOSPC duplicate-copy elimination');
has(server,'show_specific_repairs_isolated:true','show-specific repair isolation health invariant');
has(server,'prompts_rematerialized:true','Show Bible edits rematerialize drafts');

const publication=read('publication.js');
const facebookPublication=read('publication-facebook.js');
has(publication,'containsSyntheticMedia:true','YouTube synthetic-media disclosure');
has(publication,'containsSyntheticMedia:true','publication synthetic-media disclosure');
has(publication,'buildPublicationCopy','publication copy builder');
has(publication,'earthPromptIsEpisodeBound','Earth concrete prompt is publication metadata authority');
has(publication,'episode-generation-prompt','episode prompt provenance is recorded');
has(publication,'creativePackageDigest','repaired creative package hash');
has(publication,'quota_wait','YouTube quota-aware publication state');
has(publication,'shiftPendingQueueAfter','quota recovery preserves publication order');
has(publication,'stored-package','legacy/non-Earth package copy fallback');
has(server,'approval_before_external_storage:true','pre-approval external storage is forbidden');
has(server,'reject_purges_external_artifacts:true','rejection purge safety flag');
has(server,'semantic_ai_redo_interpretation:true','semantic AI REDO health invariant');
has(server,'post_submit_timeout_never_resubmits:true','post-submit timeout no-resubmit health invariant');
has(server,'daily_flow_credit_refresh_gate:true','daily Flow refill gate health invariant');
has(server,'calendar_midnight_does_not_open_batch:true','midnight must not open automatic batch');
has(server,'paid_monthly_credits_protected_until_daily_refresh:true','paid credits protected until daily refill');
has(server,'credit_cycle:creditCycleHealth','credit-cycle health observability');
has(server,"retryStrategy='ai_pending'",'REDO enters semantic AI pending state');
has(server,'purgeRejected','reject endpoint purges any accidental publication artifacts');
has(publication,'APPROVAL_GATE','publication enqueue requires explicit approval');
has(publication,'sourceMediaTransferred=true','YouTube Review file ownership transfer');
has(facebookPublication,'sourceMediaTransferred=true','Facebook Review file ownership transfer');
must(!publication.includes('fs.copyFileSync(row.videoPath,filePath)'),'same-volume YouTube approval copy must stay eliminated');
must(!facebookPublication.includes('fs.copyFileSync(row.videoPath,filePath)'),'same-volume Facebook approval copy must stay eliminated');
has(server,'[APPROVAL MEDIA HANDOFF]','approval handoff observability');
has(publication,'purgeRejected','rejected publication artifacts are purged');
has(publication,'purgePrivateVideosByTitle','operator cleanup can delete legacy private orphan uploads');
has(publication,'readReviewRange','approved publication may stream from private cloud storage');
has(server,"/publication/:id/recover-video",'per-video recovery endpoint');
has(server,"uploadReviewFile(tmp,{itemId:'stock-recovery-'",'manual recovery saves to private cloud');
has(server,"String(item.status||'')!=='backup_hold'",'manual recovery only for rescue-required videos');
has(publication,'publishNowLikeManual','explicit PRIVATE to PUBLIC release path');
has(publication,"status:{privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true}",'YouTube upload is plain PRIVATE');
has(publication,"new Date(Date.parse(scheduledAt)-390*60000).toISOString()",'YouTube upload occurs 390 minutes before release');
has(publication,"zonedLocal(localDay,'19:00',tz)",'YouTube release is normalized to 19:00');
has(publication,'Uploaded plain PRIVATE at the configured 12:30 publication-prep time. No publishAt is set.','12:30 private upload audit message');
if(publication.includes("privacyStatus:'private',publishAt:item.scheduledAt"))throw new Error('Native YouTube publishAt scheduling must stay disabled');

const schema=JSON.parse(read('publisher.config.schema.json'));
must(schema.properties?.schedule?.properties?.generation_strategy?.const==='sequential','Publisher Factory must enforce sequential Flow generation');
must(schema.properties?.automation?.properties?.exactly_once_submit?.const===true,'schema exactly-once invariant');
must(schema.properties?.automation?.properties?.strict_serial_generation?.const===true,'schema strict serial invariant');
must(schema.properties?.generation?.properties?.daily_credit_grant?.const===50,'schema daily Flow grant invariant');
must(schema.properties?.generation?.properties?.automatic_batch_credit_gate?.const==='wait-for-daily-flow-refresh','schema renewal-driven batch gate invariant');
must(schema.properties?.generation?.properties?.credit_refresh_poll_minutes?.default===5,'schema credit poll default');
must(schema.properties?.generation?.properties?.credit_refresh_guard_hours?.default===20,'schema credit guard default');
must(schema.properties?.generation?.properties?.credit_refresh_fallback_hours?.default===30,'schema credit fallback default');
must(schema.properties?.knowledge?.properties?.flow_sop_version?.const==='FLOW-SOP-v1.0','schema SOP inheritance version');
must(schema.properties?.review?.properties?.archive_provider?.const==='local-only','unapproved review media must stay local');
must(schema.properties?.review?.properties?.external_storage_before_approval?.const===false,'external review storage before approval must be forbidden');
must(schema.properties?.review?.properties?.approval_required_before_publication?.const===true,'publication must require explicit approval');
must(schema.properties?.review?.properties?.reject_purges_external_artifacts?.const===true,'rejection must purge external artifacts');
const ytSchema=(schema.properties?.publication?.properties?.providers?.items?.oneOf||[]).find(x=>x?.properties?.type?.const==='youtube');
must(ytSchema?.properties?.privacy_before_publish?.const==='private','YouTube schema private-first policy');
must(ytSchema?.properties?.release_mode?.const==='private_then_public_at_posting_time','YouTube schema explicit private-to-public release');
must(ytSchema?.properties?.use_publish_at?.const===false,'YouTube schema forbids publishAt');
must(ytSchema?.properties?.upload_lead_minutes?.const===390,'YouTube schema 390-minute lead');

console.log(JSON.stringify({
  ok:true,
  sop_version:machine.sop_id,
  sop_sha256:hash,
  master_bytes:Buffer.byteLength(master),
  strict_serial:true,
  exactly_once_submit:true,
  project_grid_recovery:true,
  review_metadata_required:true
},null,2));

