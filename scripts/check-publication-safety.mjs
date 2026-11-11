import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const yt=read('publication.js');
const fb=read('publication-facebook.js');
const cfg=read('runtime-config.js');
const flow=read('free-browser-provider.js');
const worker=read('scripts/free-runtime-runner-v2.mjs');
const checks=[
 ['YouTube uses 12:30 same-day private staging',/zonedLocal\(localDay,'12:30',tz\)/.test(yt)&&/upload\(item,'private'\)/.test(yt)],
 ['YouTube release only through separate privacy update',/reserveExternalAction\('youtube-public-release'/.test(yt)&&/await publishNowLikeManual\(item\)/.test(yt)],
 ['No direct public upload',!/upload\(item,'public'\)/.test(yt)&&/YOUTUBE_DIRECT_PUBLIC_UPLOAD_FORBIDDEN/.test(yt)],
 ['No native YouTube publishAt scheduling',/native_publish_at:false/.test(cfg)&&/use_publish_at:false/.test(cfg)],
 ['One durable private upload init per day',/reserveExternalAction\('youtube-private-upload'/.test(yt)&&/CREATE TABLE IF NOT EXISTS publication_safety_fences/.test(yt)],
 ['No stale-day mass YouTube catch-up',/MISSED_PUBLICATION_DAY_NO_AUTOMATIC_CATCHUP/.test(yt)],
 ['No repeated Facebook start or finish phase',/reserveExternalAction\('facebook-reel-start'/.test(fb)&&/reserveExternalAction\('facebook-reel-finish'/.test(fb)],
 ['No stale-day Facebook catch-up',/FACEBOOK_MISSED_DAY_NO_CATCHUP/.test(fb)],
 ['Generate clicks durably separated',/FLOW_MIN_SUBMIT_SPACING_MS=10\*60\*1000/.test(flow)&&/reserveGenerateBoundary\(db,row,genId\)/.test(flow)],
 ['Staged private uploads are not counted as public',/YOUTUBE_PRIVATE_STAGED_WAITING_19/.test(worker)&&/last.privateStaged>baseline.privateStaged/.test(worker)],
 ['YouTube approved queue has 12:30 ahead of release',/upload_lead_minutes:youtubePublicationConfigured\?390/.test(cfg)]
];
for(const [name,pass] of checks){assert.ok(pass,'FAILED: '+name);console.log('PASS '+name)}
console.log('PASS '+checks.length+' static safety invariants; no network calls, uploads, or generation.');

const identityStart=worker.indexOf('function verifiedYoutubeStageIdentityFromRows(');
const identityEnd=worker.indexOf('\nfunction youtubePrivateStageIdentity(',identityStart);
assert.ok(identityStart>0&&identityEnd>identityStart,'YouTube remote identity extractor exists');
const identityFn=vm.runInNewContext(worker.slice(identityStart,identityEnd)+'\nverifiedYoutubeStageIdentityFromRows');
const video='abCDeF123_-',item='11111111-1111-4111-8111-111111111111';
const row={id:item,videoId:video,remoteStatusCheckedAt:'2026-11-11T15:31:00Z',remotePublishAt:null};
const stage={remote_video_id:video,remote_item_id:item};
assert.equal(JSON.stringify(identityFn([row])),JSON.stringify(stage),'one remotely checked private stage is identified');
for(const rows of [[],[row,row],[{...row,videoId:'wrong'}],[{...row,id:'not-a-uuid'}],[{...row,remoteStatusCheckedAt:null}],[{...row,remotePublishAt:'2026-11-11T22:00:00Z'}]])
 assert.equal(identityFn(rows),null,'ambiguous, unverified or scheduled stage must fail closed');
const safetyStart=worker.indexOf('function youtubeStagingSafety(');
const safetyEnd=worker.indexOf('\nfunction killTree(',safetyStart);
assert.ok(safetyStart>0&&safetyEnd>safetyStart,'pre-worker YouTube stage identity guard exists');
const safety=vm.runInNewContext(worker.slice(safetyStart,safetyEnd)+'\nyoutubeStagingSafety');
for(const [kind,platform,clock,count,identity,obligation,expected] of [
 ['publication','youtube','12:30',0,null,null,null],
 ['publication','youtube','12:59',0,null,null,null],
 ['publication','youtube','12:30',1,null,null,'YOUTUBE_PREEXISTING_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','12:45',2,null,null,'YOUTUBE_PREEXISTING_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','19:00',1,stage,stage,null],
 ['publication','youtube','19:00',1,null,stage,'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','19:00',1,stage,null,'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','19:00',1,stage,{...stage,remote_video_id:'different01'},'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','19:00',1,stage,{...stage,remote_item_id:'22222222-2222-4222-8222-222222222222'},'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','19:00',0,stage,stage,'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','19:00',2,stage,stage,'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','23:59',1,stage,stage,null],
 ['publication','facebook','19:00',0,null,null,null],
 ['generation','youtube','12:30',1,null,null,null],
 ['publication','youtube','12:30',NaN,null,null,'YOUTUBE_PRIVATE_STAGE_METRIC_INVALID_RECONCILIATION_REQUIRED']
])assert.equal(safety(kind,platform,clock,count,identity,obligation),expected,'YouTube preflight '+clock+' count='+count);
assert.ok(worker.indexOf('const stagedSafety=youtubeStagingSafety(')<worker.indexOf("child=spawn('npm'"),'identity guard runs BEFORE any publication child starts');
assert.ok(worker.includes('last.privateStaged>baseline.privateStaged'),'new PRIVATE stage must be observed, not a preexisting tile');
assert.ok(worker.includes("YOUTUBE_MULTIPLE_PRIVATE_STAGES_REMOTE_ID_RECONCILIATION_REQUIRED"),'multiple staged videos require reconciliation');
assert.ok(worker.includes("error:'YOUTUBE_PRIVATE_STAGED_WAITING_19',...stageIdentity"),'12:30 callback persists exact ID');
console.log('PASS 15 pre-worker identity cases and 7 extraction guards; no network, upload or video actions.');
