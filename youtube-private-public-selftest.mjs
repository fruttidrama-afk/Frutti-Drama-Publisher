// Synthetic YouTube publication contract test. All HTTP and YouTube API
// operations are intercepted in memory. Never visits Google or publishes videos.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installPublication} from './publication.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'youtube-private-public-'));
const gatePath=path.join(root,'activation.json');
const previousGate=process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE;
const originalFetch=globalThis.fetch,OriginalDate=globalThis.Date;
let clock=OriginalDate.parse('2026-11-18T15:33:00Z'); // 12:33 Buenos Aires
class TestDate extends OriginalDate {
  constructor(...a){if(a.length)super(...a);else super(clock)}
  static now(){return clock}
}
globalThis.Date=TestDate;
process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE=gatePath;
const db=new DatabaseSync(path.join(root,'fixture.sqlite'));
db.exec(`
 CREATE TABLE factory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE publication_items(
  id TEXT PRIMARY KEY,itemId TEXT NOT NULL UNIQUE,episode INTEGER NOT NULL,
  title TEXT NOT NULL,description TEXT NOT NULL,scheduledAt TEXT NOT NULL,
  uploadAt TEXT NOT NULL,status TEXT NOT NULL,filePath TEXT,fileSize INTEGER,
  videoId TEXT,resumableSession TEXT,playlistId TEXT,attempts INTEGER NOT NULL DEFAULT 0,
  retryAt INTEGER NOT NULL DEFAULT 0,error TEXT,history TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
 );
`);
const expectedChannelId='UC'+'a'.repeat(22);
let activeChannelId=expectedChannelId;
const config={
 identity:{show_name:'Isolated YouTube Test Show',timezone:'America/Argentina/Buenos_Aires'},
 schedule:{timezone:'America/Argentina/Buenos_Aires',posting_times:['19:00'],upload_lead_minutes:390},
 publication:{selected_provider:'youtube',expected_youtube_channel_id:expectedChannelId,providers:[{type:'youtube'}],ai_disclosure_required:true}
};
const sourceFile=(name)=>{const file=path.join(root,name);fs.writeFileSync(file,Buffer.alloc(4096,77));return file};
const httpCalls=[],remoteReads=[];
let nextVideoId='yt-fixture-1',legacyPrivateReads=0,videoUpdates=0;
const remotePrivacy=new Map();
globalThis.fetch=async (url,options={})=>{
 const target=String(url),method=String(options.method||'GET'),body=options.body;
 httpCalls.push({url:target,method,body});
 if(method==='POST'&&target.startsWith('https://www.googleapis.com/upload/youtube/v3/videos?')){
   const data=JSON.parse(String(body||'{}'));
   assert.equal(data.status.privacyStatus,'private','YouTube must stage the approved Short as PRIVATE at 12:30');
   assert.equal(data.status.containsSyntheticMedia,true,'Native synthetic media disclosure missing');
   assert.equal(data.status.selfDeclaredMadeForKids,false);
   assert.equal(data.status.publishAt,undefined,'Native scheduled publishAt is forbidden');
   return new Response(null,{status:200,headers:{location:'https://www.googleapis.com/upload/fixture-session'}});
 }
 if(method==='PUT'&&target==='https://www.googleapis.com/upload/fixture-session'){
   const range=options.headers?.['Content-Range'];
   if(range==='bytes */4096')return new Response(null,{status:308});
   assert.equal(range,'bytes 0-4095/4096');
   assert.equal(Buffer.byteLength(body),4096);
   remotePrivacy.set(nextVideoId,'private');
   return new Response(JSON.stringify({id:nextVideoId,status:{privacyStatus:'private',uploadStatus:'processed'}}),
     {status:200,headers:{'content-type':'application/json'}});
 }
 throw new Error('UNEXPECTED_EXTERNAL_HTTP_REQUEST_BLOCKED:'+target);
};
const api={
 channels:{list:async()=>({data:{items:[{id:activeChannelId}]}})},
 videos:{
   list:async ({id})=>{
     const videoId=String(id?.[0]||id||'');
     remoteReads.push(videoId);
     if(videoId==='yt-legacy-private')legacyPrivateReads++;
     return {data:{items:[{id:videoId,snippet:{channelId:activeChannelId},status:{
       privacyStatus:remotePrivacy.get(videoId)||'private',uploadStatus:'processed'
     }}]}};
   },
   update:async ({part,requestBody})=>{
     assert.deepEqual(part,['status']);
     const videoId=String(requestBody?.id||'');
     assert.equal(remotePrivacy.get(videoId),'private','Release must target an existing private video');
     assert.equal(requestBody.status.privacyStatus,'public','The 19:00 action must make the same video PUBLIC');
     assert.equal(requestBody.status.publishAt,undefined,'Native YouTube scheduling is forbidden');
     assert.equal(videoId,'yt-fixture-1','Second upload, foreign video, or wrong release ID');
     videoUpdates++;remotePrivacy.set(videoId,'public');
     return{data:{id:videoId,status:{privacyStatus:'public',uploadStatus:'processed'}}};
   }
 }
};
const app={get(){},post(){}};
const runtime=installPublication({
 app,db,config,dataDir:root,isEnabled:()=>true,
 youtubeApi:()=>api,authedClient:()=>({getAccessToken:async()=>({token:'fictional-mock-token'})}),
 loadToken:()=>true
});
const gateLocal=()=>db.prepare("INSERT INTO factory_meta(key,value) VALUES('automation:operatorActivated','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
const unlockGlobal=()=>fs.writeFileSync(gatePath,JSON.stringify({schema:1,enabled:true,activated_by:'operator',
 activation_id:randomUUID()}),{mode:0o600});
const item=(number,file,title)=>runtime.enqueue({
 id:'approved-'+number,status:'review',episode:number,
 title,description:title+' is an invented synthetic clip for an offline publication test.',
 hook:'OFFLINE',story:'Synthetic only',prompt:'A ten-second abstract synthetic video',videoPath:file
});
const row=id=>db.prepare('SELECT * FROM publication_items WHERE id=?').get(id);
try{
 const source1=sourceFile('approved-one.mp4');
 const queued=item(1,source1,'TWO-STAGE TEST 1');
 assert.equal(queued.status,'queued');
 assert.ok(new OriginalDate(queued.uploadAt).getTime()<new OriginalDate(queued.scheduledAt).getTime(),
   'Approved YouTube stock needs separate PRIVATE and PUBLIC timestamps');
 // Approval after 12:30 must choose tomorrow rather than a missed same-day upload.
 assert.equal(queued.scheduledAt,'2026-11-19T22:00:00.000Z');
 db.prepare('UPDATE publication_items SET scheduledAt=?,uploadAt=? WHERE id=?')
   .run('2026-11-18T22:00:00Z','2026-11-18T15:30:00Z',queued.id);
 await runtime.tick();
 assert.equal(httpCalls.length,0,'YouTube made an external HTTP request while global pause was closed');
 gateLocal();
 await runtime.tick();
 assert.equal(httpCalls.length,0,'YouTube bypassed central pause through local operator gate');
 unlockGlobal();
 // A connected OAuth token for a different YouTube channel must be refused
 // before any videos.insert request or permanent upload fence.
 activeChannelId='UC'+'b'.repeat(22);
 await runtime.tick();
 assert.equal(httpCalls.length,0,'Wrong YouTube account uploaded externally');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_safety_fences").get().n,0,
   'Wrong YouTube account consumed the irreversible upload fence');
 assert.match(String(row(queued.id).error||''),/YOUTUBE_CHANNEL_IDENTITY_MISMATCH/);
 activeChannelId=expectedChannelId;
 db.prepare("UPDATE publication_items SET status='queued',error=NULL,retryAt=0 WHERE id=?").run(queued.id);
 await runtime.tick();
 let result=row(queued.id);
 assert.equal(result.status,'uploaded','12:30 stage did not remain PRIVATE');
 assert.equal(result.remotePrivacyStatus,'private');
 assert.equal(result.uploadMode,'private-staging-v1');
 assert.ok(result.videoId,'12:30 stage must persist the actual YouTube videoId');
 const stagedId=result.videoId;
 assert.ok(fs.existsSync(source1),'Approved original must be retained while video is PRIVATE');
 assert.equal(httpCalls.filter(x=>x.method==='POST').length,1);
 assert.equal(videoUpdates,0,'No privacy update is allowed before 19:00');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_safety_fences WHERE kind='youtube-private-upload'").get().n,1);
 await runtime.tick();
 assert.equal(httpCalls.filter(x=>x.method==='POST').length,1,'Private staging was duplicated');
 clock=OriginalDate.parse('2026-11-18T22:03:00Z'); // 19:03 Buenos Aires
 await runtime.tick();
 result=row(queued.id);
 assert.equal(result.status,'published','19:00 release never reached PUBLIC');
 assert.equal(result.remotePrivacyStatus,'public');
 assert.equal(result.videoId,stagedId,'Release must preserve the exact 12:30 YouTube ID');
 assert.equal(videoUpdates,1,'Must perform exactly one private-to-public update');
 assert.equal(httpCalls.filter(x=>x.method==='POST').length,1,'19:00 must NOT upload a second video');
 assert.equal(fs.existsSync(source1),false,'Original media must be cleared only after authenticated PUBLIC confirmation');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_safety_fences WHERE kind='youtube-public-release'").get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_safety_fences WHERE kind='youtube-direct-public-upload'").get().n,0);
 await runtime.tick();
 assert.equal(videoUpdates,1,'Published video must never receive duplicate release');
 assert.equal(httpCalls.filter(x=>x.method==='POST').length,1,'Published video must not be uploaded again');

 // Legacy private video has an unknown origin: inspect read-only and quarantine it.
 clock=OriginalDate.parse('2026-11-19T22:03:00Z');
 const srcLegacy=sourceFile('legacy-private.mp4');
 const legacy=item(3,srcLegacy,'LEGACY TEST');
 db.prepare("UPDATE publication_items SET videoId='yt-legacy-private',status='uploaded',scheduledAt=?,uploadAt=? WHERE id=?")
   .run('2026-11-19T22:00:00Z','2026-11-19T15:30:00Z',legacy.id);
 await runtime.tick();
 assert.equal(row(legacy.id).status,'attention','Legacy PRIVATE record was not held');
 assert.ok(legacyPrivateReads>=1,'Legacy private video was not inspected');
 assert.equal(videoUpdates,1,'Legacy PRIVATE video must not receive videos.update');
 assert.equal(fs.existsSync(srcLegacy),true,'Legacy video backup must survive');

 // An old direct-public fence must not be reused to start a new private upload.
 clock=OriginalDate.parse('2026-11-20T15:33:00Z');
 const srcBlocked=sourceFile('blocked-old-insert.mp4');
 const blocked=item(4,srcBlocked,'FENCED LEGACY TEST');
 db.prepare("UPDATE publication_items SET scheduledAt=?,uploadAt=? WHERE id=?")
  .run('2026-11-20T22:00:00Z','2026-11-20T15:30:00Z',blocked.id);
 db.prepare("INSERT INTO publication_safety_fences(day,kind,itemId,createdAt) VALUES(?,?,?,?)")
  .run('2026-11-20','youtube-direct-public-upload',blocked.id,new OriginalDate(clock).toISOString());
 await runtime.tick();
 assert.equal(row(blocked.id).status,'attention','Existing direct-public fence bypassed');
 assert.equal(httpCalls.filter(x=>x.method==='POST').length,1,'Legacy fence triggered duplicate YouTube insert');
 assert.equal(fs.existsSync(srcBlocked),true);
 console.log('[YOUTUBE TWO-STAGE SELFTEST] PASS',JSON.stringify({
  private_inserts:1,release_updates:1,same_video_id:true,
  no_publishAt:true,wrong_oauth_channel:'blocked',
  unrecognized_private:'quarantined',legacy_direct_insert:'fenced',offline:true
 }));
}catch(e){
 console.error('[YOUTUBE PUBLICATION SELFTEST] FAIL',String(e?.stack||e));
 process.exitCode=1;
}finally{
 runtime.close();
 db.close();
 globalThis.fetch=originalFetch;globalThis.Date=OriginalDate;
 if(previousGate===undefined)delete process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE;
 else process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE=previousGate;
 fs.rmSync(root,{recursive:true,force:true});
}
