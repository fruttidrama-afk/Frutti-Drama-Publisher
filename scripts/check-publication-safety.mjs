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

const safetyStart=worker.indexOf('function youtubeStagingSafety(');
const safetyEnd=worker.indexOf('\nfunction killTree(',safetyStart);
assert.ok(safetyStart>0&&safetyEnd>safetyStart,'pre-worker YouTube stage identity guard exists');
const safety=vm.runInNewContext(worker.slice(safetyStart,safetyEnd)+'\nyoutubeStagingSafety');
for(const [kind,platform,clock,count,expected] of [
 ['publication','youtube','12:30',0,null],
 ['publication','youtube','12:59',0,null],
 ['publication','youtube','12:30',1,'YOUTUBE_PREEXISTING_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','12:45',2,'YOUTUBE_PREEXISTING_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','19:00',1,null],
 ['publication','youtube','19:00',0,'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','19:00',2,'YOUTUBE_STAGED_PRIVATE_REMOTE_ID_RECONCILIATION_REQUIRED'],
 ['publication','youtube','23:59',1,null],
 ['publication','facebook','19:00',0,null],
 ['generation','youtube','12:30',1,null],
 ['publication','youtube','12:30',NaN,'YOUTUBE_PRIVATE_STAGE_METRIC_INVALID_RECONCILIATION_REQUIRED']
])assert.equal(safety(kind,platform,clock,count),expected,'YouTube preflight '+clock+' count='+count);
assert.ok(worker.indexOf('const stagedSafety=youtubeStagingSafety(')<worker.indexOf("child=spawn('npm'"),'identity guard runs BEFORE any publication child starts');
assert.ok(worker.includes('last.privateStaged>baseline.privateStaged'),'new PRIVATE stage must be observed, not a preexisting tile');
assert.ok(worker.includes("YOUTUBE_MULTIPLE_PRIVATE_STAGES_REMOTE_ID_RECONCILIATION_REQUIRED"),'multiple staged videos require reconciliation');
console.log('PASS 11 pre-worker YouTube stage identity cases; prevents duplicate upload and wrong-video release, no remote calls.');
