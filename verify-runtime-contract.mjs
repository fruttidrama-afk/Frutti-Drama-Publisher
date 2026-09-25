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
const facebookPublication=read('publication-facebook.js');

const sha=createHash('sha256').update(master).digest('hex');
must(sop.sop_id==='FLOW-SOP-v1.0','wrong SOP version');
must(sop.sha256===sha,'SOP JSON hash does not match master');
must(manifest.master_sha256===sha,'manifest hash does not match master');
must(manifest.inheritance_required===true,'knowledge inheritance not mandatory');

const a=schema.properties?.automation?.properties||{};
for(const k of ['exactly_once_submit','strict_serial_generation','project_grid_recovery','current_consent_only','review_metadata_required','golden_test_required']){
  must(a[k]?.const===true,'schema invariant '+k+' must be const true');
}
must(schema.properties?.schedule?.properties?.generation_strategy?.const==='sequential','generation strategy must be sequential');
must(schema.properties?.knowledge?.properties?.flow_sop_version?.const==='FLOW-SOP-v1.0','schema knowledge version mismatch');

for(const token of ['flow-generate-icon-button','arrow_forward','SUBMIT_BOUNDARY_ENTERED','automatic_submit_forbidden','flow-grid-tile-container','flow-tile-hover-footer','EPISODE_INTENT_REPAIRED','CREATIVE_PACKAGE_READY','creativePackageHash','source:\'creative-package\'','let editor=await waitFlowReady(page,30000)','FLOW_UNUSUAL_ACTIVITY_OVERNIGHT','30*60*1000','8*60*60*1000','24*60*60*1000',"'flow:noChargeStreak:provider'","Math.max(existingUntil,requestedRetryAt)","normalization may extend but NEVER shorten provider cooldown"]){
  must(provider.includes(token),'provider contract missing '+token);
}
must(!provider.includes("await waitFlowReady(page,30000);\n  const editor=await promptEditor(page);"),'provider must not re-query the Flow composer immediately after readiness');
for(const token of ["const salt=parseInt(randomUUID().replace(/-/g,'').slice(0,8),16)","const port=9400+(salt%1000)","await sleep(3000)","connectOverCDP('http://127.0.0.1:'+port,{timeout:15000})"]){
  must(provider.includes(token),'Frutti-compatible browser launch contract missing '+token);
}
must(!provider.includes('--disk-cache-dir=/tmp/publisher-chrome-cache'),'canonical browser launch must not add custom disk-cache fingerprint flags');
for(const token of ['function scheduleNoChargeRetry(db,row,opts={})','flow:transientCooldownUntil','no_charge_streak:streak',"if(providerCooldown>Date.now())return null"]){
  must(provider.includes(token),'provider no-charge runtime contract missing '+token);
}
for(const forbidden of ['FLOW_FAILED_TILE_RETRY_CLICKED','clickNativeRetry','repairEarthE10NoGeneration','repairEarthE11KnownNoCharge','repairEarthTodayAfterOperatorConfirmedOnlyFirstRender','realignEarthE11ToFruttiProtocol','rearmEarthE11AfterFullFruttiPort','rearmEarthE11AfterStableComposerFix']){
  must(!provider.includes(forbidden),'canonical Publisher runtime contains forbidden immediate-retry/show-forensic token '+forbidden);
}
for(const token of ['EARTH_IN_10_AUTONOMOUS_EPISODES','enforceEpisodeIntent','effectiveVideoVisualStyle','publisherWebStyleLeak','materializeCreativePackage','validateEpisodePrompt','SHOW_BIBLE_REQUIRED','PROMPT_QUALITY_GATE']){
  must(runtimeConfig.includes(token),'runtime content contract missing '+token);
}
for(const token of ['runtime_knowledge','creativePackageHash','creativePackageId','knowledge:flowSopLoaded','automation:exactlyOnceSubmit','automation:strictSerialGeneration']){
  must(init.includes(token),'runtime-init contract missing '+token);
}
for(const token of ["app.get('/factory/knowledge'","automation_safety","stable_composer_handoff:true","native_no_charge_retry:false","immediate_native_retry_disabled:true","adaptive_no_charge_backoff:true","unusual_activity_exponential_backoff:true","provider_wide_unusual_activity_backoff:true","monotonic_provider_cooldown:true","show_specific_repairs_isolated:true","replacement creative package required","prompt_integrity","prompt_show_bible_gate:true","atomic_creative_package:true","approval_before_external_storage:true","reject_purges_external_artifacts:true","prompts_rematerialized:true","signedReviewUrl","deleteReviewObject"]){
  must(server.includes(token),'server contract missing '+token);
}
for(const token of ['earthPromptIsEpisodeBound','episode-generation-prompt','creativePackageDigest','quota_wait','shiftPendingQueueAfter','stored-package']){
  must(publication.includes(token),'publication metadata/quota contract missing '+token);
}
for(const token of ['saveReviewAsset','local-volume-until-approval','remoteUrl=NULL','reviewVideoId=NULL']){
  must(provider.includes(token),'pre-approval local-only review contract missing '+token);
}
must(publication.includes('publishAt:item.scheduledAt'),'native YouTube upload scheduling contract missing');
must(publication.includes('publishAt:target'),'native YouTube schedule reconciliation contract missing');
must(!publication.includes('publishNowLikeManual'),'direct PRIVATE-to-PUBLIC YouTube release path must remain disabled');
for(const token of ['isReviewStorageUri','readReviewRange','deleteReviewObject','containsSyntheticMedia:true','APPROVAL_GATE','purgeRejected','purgePrivateVideosByTitle']){
  must(publication.includes(token),'publication/approval/rejection contract missing '+token);
}
for(const token of ["APPROVAL_GATE","me/video_reels","upload_phase:'start'","Authorization:'OAuth '","video_state:'PUBLISHED'","fields:'status'","FACEBOOK_AUTH_REQUIRED","purgeRejected"]){
  must(facebookPublication.includes(token),'Facebook Reels runtime contract missing '+token);
}
for(const token of ["/integrations/platform","/integrations/facebook","/facebook/oauth/callback","pages_show_list,pages_read_engagement,pages_manage_posts","FacebookReelsProvider","selectedPublicationProvider","facebookConnected"]){
  must(server.includes(token),'Facebook connection/runtime server contract missing '+token);
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
