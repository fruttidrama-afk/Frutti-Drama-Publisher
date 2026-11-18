import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installFacebookPublication } from './publication-facebook.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-fb-selftest-'));
const db=new DatabaseSync(path.join(root,'test.sqlite'));
const previousGatePath=process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE;
const mockGatePath=path.join(root,'mock-operator-activation.json');
process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE=mockGatePath;
db.exec(`
CREATE TABLE factory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE publication_items(
 id TEXT PRIMARY KEY,itemId TEXT NOT NULL UNIQUE,episode INTEGER NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,
 scheduledAt TEXT NOT NULL,uploadAt TEXT NOT NULL,status TEXT NOT NULL,filePath TEXT,fileSize INTEGER,videoId TEXT,resumableSession TEXT,
 playlistId TEXT,attempts INTEGER NOT NULL DEFAULT 0,retryAt INTEGER NOT NULL DEFAULT 0,error TEXT,history TEXT NOT NULL DEFAULT '[]',
 createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
);
`);
const src=path.join(root,'approved.mp4');fs.writeFileSync(src,Buffer.alloc(2048,7));
const config={
 identity:{show_name:'Dinnie The Dinosaur',timezone:'America/Argentina/Buenos_Aires'},
 schedule:{timezone:'America/Argentina/Buenos_Aires',posting_times:['23:59'],upload_lead_minutes:0},
 publication:{selected_provider:'facebook',ai_disclosure_required:true,providers:[{type:'facebook',contains_synthetic_media:true,hashtags:['#DinnieTheDinosaur','#KidsAnimation','#Reels','#Viral']}]}
};
let publishPhase='in_progress';
const calls=[];
const realFetch=globalThis.fetch;
globalThis.fetch=async (url,opt={})=>{
  const u=String(url);calls.push({url:u,method:opt.method||'GET',headers:opt.headers||{}});
  if(u.includes('/me/video_reels')&&u.includes('upload_phase=start'))return new Response(JSON.stringify({video_id:'fb-video-1',upload_url:'https://rupload.facebook.com/video-upload/v25.0/fb-video-1'}),{status:200,headers:{'content-type':'application/json'}});
  if(u.startsWith('https://rupload.facebook.com/'))return new Response(JSON.stringify({success:true,status:{video_status:'processing'}}),{status:200,headers:{'content-type':'application/json'}});
  if(u.includes('/me/video_reels')&&u.includes('upload_phase=finish'))return new Response(JSON.stringify({success:true}),{status:200,headers:{'content-type':'application/json'}});
  if(u.includes('/fb-video-1?')&&u.includes('fields=status'))return new Response(JSON.stringify({id:'fb-video-1',status:{video_status:'ready',publishing_phase:{status:publishPhase,publish_status:publishPhase==='complete'?'published':'draft'}}}),{status:200,headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify({error:{message:'unexpected selftest request '+u,code:100}}),{status:400,headers:{'content-type':'application/json'}});
};
const runtime=installFacebookPublication({
 db,config,dataDir:root,isEnabled:()=>true,
 loadFacebookConnection:()=>({page_id:'page-1',page_name:'Dinnie',page_access_token:'test-page-token'})
});
try{
  let refused=false;
  try{runtime.enqueue({id:'bad',status:'draft'})}catch(e){refused=/APPROVAL_GATE/.test(String(e.message))}
  if(!refused)throw new Error('Facebook publication accepted a non-review item.');

  const item=runtime.enqueue({id:'approved-1',status:'review',episode:1,hook:'RAINBOW DOOR',story:'Dinnie opens a glowing leaf door.',title:'RAINBOW DOOR',description:'Dinnie finds a glowing leaf door.',prompt:'test',videoPath:src});
  if(item.provider!=='facebook'||item.status!=='queued')throw new Error('Approved Facebook item was not queued.');
  // Verify the reconstructed factory remains inert even with an overdue Reel.
  const overdue=new Date(Date.now()-1000).toISOString();
  db.prepare("UPDATE publication_items SET scheduledAt=?,uploadAt=? WHERE id=?").run(overdue,overdue,item.id);
  await runtime.tick();
  if(calls.length!==0)throw new Error('Facebook made Graph calls while global activation gate was missing.');

  // A per-channel gate alone must never override the global pause.
  db.prepare("INSERT INTO factory_meta(key,value) VALUES('automation:operatorActivated','true')").run();
  await runtime.tick();
  if(calls.length!==0)throw new Error('Facebook published despite missing global operator authorization.');

  // Isolated synthetic fixture only: no actual credentials and every Graph call
  // is intercepted by the in-memory fetch mock above. Production stays paused.
  fs.writeFileSync(mockGatePath,JSON.stringify({
    schema:1,enabled:true,activated_by:'operator',
    activation_id:'123e4567-e89b-12d3-a456-426614174000'
  }),{mode:0o600});
  await runtime.tick();
  // Meta may report a transcoded, upload-ready video while the Reel's
  // publishing phase is still incomplete. That is NOT proof of publication.
  const notPublic=db.prepare('SELECT * FROM publication_items WHERE id=?').get(item.id);
  if(notPublic.status==='published'||notPublic.remotePrivacyStatus==='public')
    throw new Error('Facebook video_status=ready was falsely accepted as PUBLIC.');
  if(!notPublic.filePath||!fs.existsSync(notPublic.filePath))
    throw new Error('Facebook deleted the only approved MP4 before publication was verified.');
  publishPhase='complete';
  await runtime.tick();
  const out=db.prepare('SELECT * FROM publication_items WHERE id=?').get(item.id);
  if(out.status!=='published'||out.videoId!=='fb-video-1'||out.remotePrivacyStatus!=='public')throw new Error('Facebook Reel did not reach published state.');
  if(out.filePath)throw new Error('Published Facebook media was not cleaned up.');
  const urls=calls.map(x=>x.url);
  if(!urls.some(x=>x.includes('upload_phase=start'))||!urls.some(x=>x.startsWith('https://rupload.facebook.com/'))||!urls.some(x=>x.includes('upload_phase=finish')))throw new Error('Facebook Reels three-phase upload flow incomplete.');
  if(urls.filter(x=>x.includes('upload_phase=finish')).length!==1)
    throw new Error('Facebook retried a finish request while waiting for publication confirmation.');
  console.log('[FACEBOOK PUBLICATION SELFTEST] PASS',JSON.stringify({calls:calls.length,videoId:out.videoId,status:out.status}));
}finally{
  runtime.close();
  globalThis.fetch=realFetch;
  if(previousGatePath===undefined)delete process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE;
  else process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE=previousGatePath;
  try{fs.rmSync(root,{recursive:true,force:true})}catch{}
}
