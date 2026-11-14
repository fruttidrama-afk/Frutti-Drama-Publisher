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
 ['Facebook upload-ready is not proof of public Reel',/remotelyPublished=publishing==='complete'/.test(fb)&&!/publishing==='complete'\|\|video==='ready'/.test(fb)],
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


// A different video becoming PUBLIC must never mark the 19:00 obligation
// complete. Exercise the exact runner's post-publication identity predicate.
const releaseStart=worker.indexOf('function youtubePublicReleaseProofFromRows(');
const releaseEnd=worker.indexOf('\nfunction youtubePublicReleaseProof(obligation)',releaseStart);
assert.ok(releaseStart>0&&releaseEnd>releaseStart,'post-release remote identity predicate exists');
const releaseFn=vm.runInNewContext(worker.slice(releaseStart,releaseEnd)+'\nyoutubePublicReleaseProofFromRows');
const released={id:item,videoId:video,status:'published',remotePrivacyStatus:'public',
 remoteStatusCheckedAt:'2026-11-13T22:00:05Z',remotePublishAt:null};
const releaseClaim={...stage,claimed_at:'2026-11-13T22:00:00Z'};
assert.equal(releaseFn([released],releaseClaim),true,'fresh exact PUBLIC remote ID can complete');
for(const [rows,obligation] of [
 [[],releaseClaim],[[released,released],releaseClaim],
 [[{...released,id:'22222222-2222-4222-8222-222222222222'}],releaseClaim],
 [[{...released,videoId:'otherID123_'}],releaseClaim],
 [[{...released,status:'uploaded'}],releaseClaim],
 [[{...released,remotePrivacyStatus:'private'}],releaseClaim],
 [[{...released,remotePublishAt:'2026-11-13T22:00:00Z'}],releaseClaim],
 [[{...released,remoteStatusCheckedAt:null}],releaseClaim],
 [[{...released,remoteStatusCheckedAt:'2026-11-13T21:59:59Z'}],releaseClaim],
 [[released],{...releaseClaim,claimed_at:null}],
 [[released],{...releaseClaim,remote_video_id:'otherID123_'}]
])assert.equal(releaseFn(rows,obligation),false,'wrong, stale or ambiguous YouTube release must fail closed');
assert.match(worker,/last\.publication!==baseline\.publication\+1\|\|!youtubePublicReleaseProof\(o\)/,
 'aggregate publication count is insufficient without exact release proof');
assert.match(worker,/localClock<'19:00'/,'PUBLIC before 19:00 must not complete a stage');
assert.match(worker,/YOUTUBE_PUBLIC_RELEASE_REMOTE_ID_RECONCILIATION_REQUIRED/,
 'unverified PUBLIC release must quarantine for remote reconciliation');
assert.ok(worker.indexOf('youtubePublicReleaseProof(o)')<worker.indexOf("if(privateStagedWait){"),
 'post-release proof must run before callback completion');
console.log('PASS 12 YouTube post-release identity cases and 4 fail-closed runtime guards; no remote calls.');


// Reconnecting Meta after midnight must never turn a missed-day Reel into
// a fresh-day upload. This tests the actual production day-decision function.
const reconnectStart=fb.indexOf('function facebookReconnectDayDecision(');
const reconnectEnd=fb.indexOf('\nfunction postingTimes(',reconnectStart);
assert.ok(reconnectStart>0&&reconnectEnd>reconnectStart,'Facebook reconnect day guard exists');
const localDay=(date,tz)=>{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const p=Object.fromEntries(parts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
};
const reconnectDecision=vm.runInNewContext(fb.slice(reconnectStart,reconnectEnd)+'\nfacebookReconnectDayDecision',{dayKey:localDay});
const art='America/Argentina/Buenos_Aires';
for(const [scheduled,today,expected] of [
 ['2026-11-13T02:59:59Z','2026-11-14','quarantine'],
 ['2026-11-13T03:00:00Z','2026-11-14','quarantine'],
 ['2026-11-14T02:59:59Z','2026-11-14','quarantine'],
 ['2026-11-14T03:00:00Z','2026-11-14','resume'],
 ['2026-11-14T18:00:00Z','2026-11-14','resume'],
 ['2026-11-15T02:59:59Z','2026-11-14','resume'],
 ['2026-11-15T03:00:00Z','2026-11-14','resume'],
 ['2026-11-16T03:00:00Z','2026-11-14','resume'],
 ['2026-11-13T23:59:59Z','2026-11-15','quarantine'],
 ['2026-11-15T02:59:59Z','2026-11-15','quarantine'],
 ['2026-11-15T03:00:00Z','2026-11-15','resume'],
 ['2026-11-15T22:00:00Z','2026-11-15','resume'],
 ['2026-11-16T02:59:59Z','2026-11-15','resume'],
 ['2026-11-16T03:00:00Z','2026-11-15','resume'],
 ['2026-11-13T22:00:00Z','2026-11-13','resume'],
 ['2026-11-12T22:00:00Z','2026-11-13','quarantine'],
 ['','2026-11-14','quarantine'],
 ['invalid','2026-11-14','quarantine'],
 ['2026-11-14','2026-11-14','quarantine'],
 ['2026-11-14T03:00:00Z','2026-11-15','quarantine']
])assert.equal(reconnectDecision(scheduled,today,art),expected,'Meta reconnect day decision '+scheduled);
const reconnectBody=fb.slice(fb.indexOf('  function resumeAuthWait(){'),fb.indexOf('\n  const timer=setInterval',fb.indexOf('  function resumeAuthWait(){')));
assert.ok(reconnectBody.includes("facebookReconnectDayDecision(item.scheduledAt,today,tz)==='quarantine'"),'stale-day items quarantined');
assert.ok(reconnectBody.includes("FACEBOOK_MISSED_DAY_REMOTE_ID_RECONCILIATION_REQUIRED"),'ambiguous remote ID remains quarantined');
assert.ok(reconnectBody.includes("hist(item,'attention',item.error)"),'stale items visibly require attention');
assert.ok(!reconnectBody.includes('item.scheduledAt='),'OAuth reconnect never rewrites the original publication day');
assert.ok(!reconnectBody.includes('item.uploadAt='),'OAuth reconnect never rewrites upload day');
assert.ok(reconnectBody.includes('if(resumed)setTimeout'),'only eligible same/future-day items wake worker');
console.log('PASS 20 Facebook reconnect calendar-day cases and 6 no-catchup guards; no Meta API or media mutations.');

// Exercise the actual resumeAuthWait loop against a fake SQLite cursor:
// no network, timers, file deletion, OAuth mutation, or Meta calls.
const makeRow=(id,scheduledAt,videoId=null)=>({
 id,scheduledAt,uploadAt:scheduledAt,videoId,status:'auth_wait',retryAt:999,
 error:'FACEBOOK_AUTH_REQUIRED',filePath:'/preserved/'+id+'.mp4'
});
const cases=[
 makeRow('past-unsent','2026-11-13T22:00:00Z'),
 makeRow('past-remote','2026-11-13T22:00:00Z','123456789012345'),
 makeRow('today-due','2026-11-14T03:00:00Z'),
 makeRow('today-future','2026-11-14T22:00:00Z'),
 makeRow('future','2026-11-15T22:00:00Z'),
 makeRow('invalid','invalid')
];
const snapshots=cases.map(x=>({...x}));
const saved=[],wake=[];
const ctx={
 config:{schedule:{timezone:art}},
 db:{prepare:()=>({all:()=>cases})},
 dayKey:localDay,facebookReconnectDayDecision:reconnectDecision,
 hist:(item,status,message)=>{item.status=status;item.message=message},
 save:item=>saved.push({...item}),
 tick:()=>{throw Error('tick must not execute during offline test')},
 setTimeout:(fn,ms)=>{wake.push(ms);return{unref(){}}},
 Date
};
const actualResume=vm.runInNewContext(reconnectBody+'\nresumeAuthWait',ctx);
assert.equal(actualResume(),3,'only current/future-day items rearmed');
assert.equal(saved.length,6,'all six rows persisted with explicit disposition');
assert.equal(wake.length,1,'only one wake-up scheduled for eligible items');
assert.equal(cases[0].status,'attention');
assert.equal(cases[0].error,'FACEBOOK_MISSED_DAY_NO_CATCHUP');
assert.equal(cases[1].status,'attention');
assert.equal(cases[1].error,'FACEBOOK_MISSED_DAY_REMOTE_ID_RECONCILIATION_REQUIRED');
assert.equal(cases[5].status,'attention','invalid schedule is not silently repaired');
for(const index of [2,3,4])assert.equal(cases[index].status,'queued','eligible day resumes');
for(let i=0;i<cases.length;i++){
 assert.equal(cases[i].scheduledAt,snapshots[i].scheduledAt,'original calendar slot never rewritten');
 assert.equal(cases[i].uploadAt,snapshots[i].uploadAt,'original upload slot never rewritten');
 assert.equal(cases[i].filePath,snapshots[i].filePath,'approved original MP4 never deleted');
 assert.equal(cases[i].videoId,snapshots[i].videoId,'remote identity never changed');
}
console.log('PASS Facebook reconnect integration mock: 6 rows, 3 quarantines, 3 eligible, all identities/media/slots preserved.');



// A public watch page and oEmbed also work for some UNLISTED YouTube videos.
// During Data API quota exhaustion they are never proof of privacyStatus=public.
// Execute the EXACT production fallback with mocked HTTP responses; ensure
// zero persisted status changes and zero deletion of the human-approved MP4.
const fallbackStart=yt.indexOf('  async function publicPageFallback(item){');
const fallbackEnd=yt.indexOf('\\n  async function stageMetadata(',fallbackStart);
assert.ok(fallbackStart>0&&fallbackEnd>fallbackStart,'public-page diagnostic fallback exists');
const fallbackSource=yt.slice(fallbackStart,fallbackEnd);
assert.ok(!fallbackSource.includes("item.remotePrivacyStatus='public'"),'oEmbed cannot promote to PUBLIC');
assert.ok(!fallbackSource.includes("cleanupPublicationMedia(item)"),'oEmbed cannot delete approved media');
for(const [scenario,watchBody] of [
 ['reachable_public','<html><title>Video</title></html>'],
 ['unlisted_explicit','<html>"isUnlisted":true</html>'],
 ['unlisted_without_marker','<html><title>Video</title></html>']
]){
  let writes=0,deletions=0;
  const mockFetch=async url=>url.includes('/oembed?')
    ?{ok:true,status:200,json:async()=>({title:'A reachable video'})}
    :{ok:true,status:200,text:async()=>watchBody};
  const context={
    fetch:mockFetch,AbortSignal:{timeout:()=>({})},encodeURIComponent,
    console:{log:()=>{}},
    now:()=>{writes++;return '2026-11-14T11:00:00Z'},
    hist:()=>{writes++},save:()=>{writes++},
    cleanupPublicationMedia:async()=>{deletions++}
  };
  const fallback=vm.runInNewContext(fallbackSource+'\\npublicPageFallback',context);
  const record={id:'stock-1',episode:7,videoId:'abCDeF123_-',status:'uploaded',remotePrivacyStatus:'private',remoteStatusCheckedAt:null,filePath:'/preserved/approved.mp4'};
  const snapshot=JSON.stringify(record);
  assert.equal(await fallback(record),false,scenario+' must remain unverified');
  assert.equal(JSON.stringify(record),snapshot,scenario+' must preserve exact remote/local state');
  assert.equal(writes,0,scenario+' must not write an inferred PUBLIC status');
  assert.equal(deletions,0,scenario+' must not delete the MP4');
}
console.log('PASS 3 YouTube oEmbed/watch ambiguity cases: no false PUBLIC, no status writes, no media deletion.');
