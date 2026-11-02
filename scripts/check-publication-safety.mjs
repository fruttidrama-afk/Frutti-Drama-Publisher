import assert from 'node:assert/strict';
import fs from 'node:fs';

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
 ['Staged private uploads are not counted as public',/YOUTUBE_PRIVATE_STAGED_WAITING_19/.test(worker)&&/last.privateStaged>0/.test(worker)],
 ['YouTube approved queue has 12:30 ahead of release',/upload_lead_minutes:youtubePublicationConfigured\?390/.test(cfg)]
];
for(const [name,pass] of checks){assert.ok(pass,'FAILED: '+name);console.log('PASS '+name)}
console.log('PASS '+checks.length+' static safety invariants; no network calls, uploads, or generation.');
