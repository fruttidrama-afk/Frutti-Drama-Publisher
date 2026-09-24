import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installFacebookPublication } from './publication-facebook.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-fb-selftest-'));
const db=new DatabaseSync(path.join(root,'test.sqlite'));
db.exec(`
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
 publication:{selected_provider:'facebook',providers:[{type:'facebook',hashtags:['#DinnieTheDinosaur','#KidsAnimation','#Reels','#Viral']}]}
};
const calls=[];
const realFetch=globalThis.fetch;
globalThis.fetch=async (url,opt={})=>{
  const u=String(url);calls.push({url:u,method:opt.method||'GET',headers:opt.headers||{}});
  if(u.includes('/me/video_reels')&&u.includes('upload_phase=start'))return new Response(JSON.stringify({video_id:'fb-video-1',upload_url:'https://rupload.facebook.com/video-upload/v25.0/fb-video-1'}),{status:200,headers:{'content-type':'application/json'}});
  if(u.startsWith('https://rupload.facebook.com/'))return new Response(JSON.stringify({success:true,status:{video_status:'processing'}}),{status:200,headers:{'content-type':'application/json'}});
  if(u.includes('/me/video_reels')&&u.includes('upload_phase=finish'))return new Response(JSON.stringify({success:true}),{status:200,headers:{'content-type':'application/json'}});
  if(u.includes('/fb-video-1?')&&u.includes('fields=status'))return new Response(JSON.stringify({id:'fb-video-1',status:{video_status:'ready',publishing_phase:{status:'complete'}}}),{status:200,headers:{'content-type':'application/json'}});
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
  const beforeCalls=calls.length;
  await runtime.tick();
  if(calls.length!==beforeCalls)throw new Error('Facebook publisher attempted remote upload before scheduled time.');

  db.prepare("UPDATE publication_items SET scheduledAt=?,uploadAt=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),new Date(Date.now()-1000).toISOString(),item.id);
  await runtime.tick();
  const out=db.prepare('SELECT * FROM publication_items WHERE id=?').get(item.id);
  if(out.status!=='published'||out.videoId!=='fb-video-1'||out.remotePrivacyStatus!=='public')throw new Error('Facebook Reel did not reach published state.');
  if(out.filePath)throw new Error('Published Facebook media was not cleaned up.');
  const urls=calls.map(x=>x.url);
  if(!urls.some(x=>x.includes('upload_phase=start'))||!urls.some(x=>x.startsWith('https://rupload.facebook.com/'))||!urls.some(x=>x.includes('upload_phase=finish')))throw new Error('Facebook Reels three-phase upload flow incomplete.');
  console.log('[FACEBOOK PUBLICATION SELFTEST] PASS',JSON.stringify({calls:calls.length,videoId:out.videoId,status:out.status}));
}finally{
  runtime.close();
  globalThis.fetch=realFetch;
  try{fs.rmSync(root,{recursive:true,force:true})}catch{}
}
