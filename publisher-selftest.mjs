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
  ["status IN ('regen_wait','draft') AND retryStrategy IN ('reuse_prompt','revise_prompt')",'human REDO priority queue'],
  ['creativePackageHash','creative package hash link'],
  ['fresh-video-tile-occurrences','fresh Flow video correlation gate'],
  ['FLOW_DUPLICATE_REVIEW_MEDIA','duplicate review-media rejection'],
  ["source:'creative-package'",'review metadata preservation'],
  ['let editor=await waitFlowReady(page,30000)','stable Flow composer handoff'],
  ['FLOW_UNUSUAL_ACTIVITY_OVERNIGHT','24h unusual-activity fallback'],
  ['30*60*1000','first unusual-activity delay'],
  ['8*60*60*1000','fifth unusual-activity delay'],
  ['24*60*60*1000','24h unusual-activity fallback']
]) has(provider,token,label);
must(!provider.includes("await waitFlowReady(page,30000);\n  const editor=await promptEditor(page);"),'Flow composer must not be re-queried immediately after readiness');
for(const [token,label] of [
  ["const salt=parseInt(randomUUID().replace(/-/g,'').slice(0,8),16)",'fresh browser session salt'],
  ["const port=9400+(salt%1000)",'fresh CDP port'],
  ["await sleep(3000)",'Chrome settle period'],
  ["connectOverCDP('http://127.0.0.1:'+port,{timeout:15000})",'Frutti-compatible CDP attach']
]) has(provider,token,label);
must(!provider.includes('--disk-cache-dir=/tmp/publisher-chrome-cache'),'custom browser cache flags must stay disabled');
for(const [token,label] of [
  ['function scheduleNoChargeRetry(db,row,opts={})','adaptive no-charge scheduler'],
  ['flow:transientCooldownUntil','provider-wide no-charge cooldown'],
  ["'flow:noChargeStreak:provider'",'provider-wide no-charge streak persistence'],
  ['FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED','legacy successful-render backoff repair'],
  ['FLOW_PROVIDER_BACKOFF_SUCCESS_REPAIRED_V2','post-success provider streak repair v2'],
  ['flow:legacyNoChargeStreakMigratedV2','legacy streak resurrection guard'],
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
has(server,'replacement creative package required','REDO requests atomic package replacement without blanking the old prompt');
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
has(server,'show_specific_repairs_isolated:true','show-specific repair isolation health invariant');
has(server,'prompts_rematerialized:true','Show Bible edits rematerialize drafts');

const publication=read('publication.js');
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
has(server,'purgeRejected','reject endpoint purges any accidental publication artifacts');
has(publication,'APPROVAL_GATE','publication enqueue requires explicit approval');
has(publication,'purgeRejected','rejected publication artifacts are purged');
has(publication,'purgePrivateVideosByTitle','operator cleanup can delete legacy private orphan uploads');
has(publication,'readReviewRange','approved publication may stream from private cloud storage');
has(publication,'publishNowLikeManual','YouTube release must remain a direct PRIVATE to PUBLIC edit at release time');
has(publication,"status:{privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true}",'YouTube staging upload must remain plain PRIVATE with no publishAt');
if(publication.includes("privacyStatus:'private',publishAt:item.scheduledAt"))throw new Error('Native YouTube publishAt scheduling must stay disabled');

const schema=JSON.parse(read('publisher.config.schema.json'));
must(schema.properties?.schedule?.properties?.generation_strategy?.const==='sequential','Publisher Factory must enforce sequential Flow generation');
must(schema.properties?.automation?.properties?.exactly_once_submit?.const===true,'schema exactly-once invariant');
must(schema.properties?.automation?.properties?.strict_serial_generation?.const===true,'schema strict serial invariant');
must(schema.properties?.knowledge?.properties?.flow_sop_version?.const==='FLOW-SOP-v1.0','schema SOP inheritance version');
must(schema.properties?.review?.properties?.archive_provider?.const==='local-only','unapproved review media must stay local');
must(schema.properties?.review?.properties?.external_storage_before_approval?.const===false,'external review storage before approval must be forbidden');
must(schema.properties?.review?.properties?.approval_required_before_publication?.const===true,'publication must require explicit approval');
must(schema.properties?.review?.properties?.reject_purges_external_artifacts?.const===true,'rejection must purge external artifacts');

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
