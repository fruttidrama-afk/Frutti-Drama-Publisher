// Synthetic YouTube publication contract test. All HTTP and YouTube API
// operations are intercepted in memory. Never visits Google or publishes videos.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {installPublication} from './publication.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'youtube-direct-public-'));
const gatePath=path.join(root,'activation.json');
const previousGate=process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE;
const originalFetch=globalThis.fetch,OriginalDate=globalThis.Date;
let clock=OriginalDate.parse('2026-11-18T19:03:00Z');
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
const config={
 identity:{show_name:'Isolated YouTube Test Show',timezone:'UTC'},
 schedule:{timezone:'UTC',posting_times:['19:00'],upload_lead_minutes:0},
 publication:{selected_provider:'youtube',providers:[{type:'youtube'}],ai_disclosure_required:true}
};
const sourceFile=(name)=>{const file=path.join(root,name);fs.writeFileSync(file,Buffer.alloc(4096,77));return file};
const httpCalls=[],remoteReads=[];
let nextVideoStatus='public',nextVideoId='yt-fixture-1',legacyPrivateReads=0,videoUpdates=0;
globalThis.fetch=async (url,options={})=>{
 const target=String(url),method=String(options.method||'GET'),body=options.body;
 httpCalls.push({url:target,method,body});
 if(method==='POST'&&target.startsWith('https://www.googleapis.com/upload/youtube/v3/videos?')){
   const data=JSON.parse(String(body||'{}'));
   assert.equal(data.status.privacyStatus,'public','YouTube insert was initialized as PRIVATE');
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
   return new Response(JSON.stringify({id:nextVideoId,status:{privacyStatus:nextVideoStatus,uploadStatus:'processed'}}),
     {status:200,headers:{'content-type':'application/json'}});
 }
 throw new Error('UNEXPECTED_EXTERNAL_HTTP_REQUEST_BLOCKED:'+target);
};
const api={
 channels:{list:async()=>({data:{items:[{id:'fixture-channel'}]}})},
 videos:{
   list:async ({id})=>{
     const videoId=String(id?.[0]||id||'');
     remoteReads.push(videoId);
     if(videoId==='yt-legacy-private')legacyPrivateReads++;
     return {data:{items:[{id:videoId,snippet:{channelId:'fixture-channel'},status:{
       privacyStatus:videoId==='yt-legacy-private'?'private':
         videoId==='yt-fixture-2'?'private':'public',uploadStatus:'processed'
     }}]}};
   },
   update:async()=>{videoUpdates++;throw Error('PRIVATE_TO_PUBLIC_UPDATE_FORBIDDEN')}
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
 const queued=item(1,source1,'PUBLIC TEST 1');
 assert.equal(queued.status,'queued');
 assert.equal(new OriginalDate(queued.uploadAt).getTime(),new OriginalDate(queued.scheduledAt).getTime(),
   'New YouTube stock still has a hidden private pre-upload time');
 db.prepare('UPDATE publication_items SET scheduledAt=?,uploadAt=? WHERE id=?')
   .run('2026-11-18T19:00:00Z','2026-11-18T19:00:00Z',queued.id);
 await runtime.tick();
 assert.equal(httpCalls.length,0,'YouTube made an external HTTP request while global pause was closed');
 gateLocal();
 await runtime.tick();
 assert.equal(httpCalls.length,0,'YouTube bypassed central pause through local operator gate');
 unlockGlobal();
 await runtime.tick();
 let result=row(queued.id);
 assert.equal(result.status,'published','Mock PUBLIC upload never verified published');
 assert.equal(result.remotePrivacyStatus,'public');
 assert.equal(result.uploadMode,'direct-public');
 assert.equal(result.aiDisclosureSyncedAt!==null,true);
 assert.equal(fs.existsSync(source1),false,'Approved source should be cleaned up only after public confirmation');
 assert.equal(httpCalls.filter(x=>x.method==='POST').length,1,'YouTube inserted a video more than once');
 assert.equal(videoUpdates,0,'YouTube performed a PRIVATE -> PUBLIC update');
 const previousCalls=httpCalls.length;
 await runtime.tick();
 assert.equal(httpCalls.length,previousCalls,'Published video issued another YouTube upload');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_safety_fences WHERE kind='youtube-direct-public-upload'").get().n,1);

 // Day 2: YouTube unexpectedly reports PRIVATE even when insert requested PUBLIC.
 // This must NOT trigger a privacy change, and the original MP4 must survive.
 clock=OriginalDate.parse('2026-11-19T19:03:00Z');
 const source2=sourceFile('approved-two.mp4');
 const queued2=item(2,source2,'PUBLIC TEST 2');
 db.prepare('UPDATE publication_items SET scheduledAt=?,uploadAt=? WHERE id=?')
   .run('2026-11-19T19:00:00Z','2026-11-19T19:00:00Z',queued2.id);
 nextVideoId='yt-fixture-2';nextVideoStatus='private';
 await runtime.tick();
 const bad=row(queued2.id);
 assert.equal(bad.status,'attention','YouTube unexpectedly PRIVATE upload must require operator attention');
 assert.equal(bad.remotePrivacyStatus,'private');
 assert.equal(fs.existsSync(source2),true,'PRIVATE video result deleted the only approved MP4');
 assert.equal(videoUpdates,0,'YouTube unexpectedly changed private video visibility');
 assert.equal(httpCalls.filter(x=>x.method==='POST').length,2,'Unexpected duplicate YouTube insert after PRIVATE status');

 // Existing legacy PRIVATE video is read-only, never converted by automation.
 const srcLegacy=sourceFile('legacy-private.mp4');
 const legacy=item(3,srcLegacy,'LEGACY TEST');
 db.prepare("UPDATE publication_items SET videoId='yt-legacy-private',status='uploaded',scheduledAt=?,uploadAt=? WHERE id=?")
   .run('2026-11-19T19:00:00Z','2026-11-19T19:00:00Z',legacy.id);
 await runtime.tick();
 assert.equal(row(legacy.id).status,'attention','Legacy PRIVATE record was not held');
 assert.ok(legacyPrivateReads>=1,'Legacy YouTube video must be inspected read-only');
 assert.equal(videoUpdates,0,'Legacy PRIVATE video must never receive videos.update');
 assert.equal(fs.existsSync(srcLegacy),true,'Legacy unreconciled MP4 must be preserved');
 console.log('[YOUTUBE PUBLICATION SELFTEST] PASS',JSON.stringify({
  platform_calls:httpCalls.length,direct_public_inserts:2,
  private_staging_inserts:0,privacy_switch_updates:videoUpdates,
  public_verified:true,private_result:'manual_hold_with_original',
  legacy_private:'read_only',offline:true
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
