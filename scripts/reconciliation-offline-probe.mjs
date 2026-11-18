// Offline fixture proving historical video/prompt inventory never fabricates
// episode mappings and never modifies any publisher database or source MP4.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'reconciliation-offline-'));
const port=34000+Math.floor(Math.random()*20000);
const secret=randomBytes(32).toString('hex');
const media=path.join(root,'media');
const store=path.join(root,'store');
const files=path.join(media,'fruttidrama');
fs.mkdirSync(files,{recursive:true});
fs.mkdirSync(path.join(store,'posts'),{recursive:true});
const a=Buffer.alloc(4096,42),b=Buffer.alloc(4096,91);
fs.writeFileSync(path.join(files,'video-a.mp4'),a);
fs.writeFileSync(path.join(files,'video-b.mp4'),b);
const h=s=>createHash('sha256').update(s).digest('hex');
fs.writeFileSync(path.join(store,'posts','fruttidrama.json'),JSON.stringify([
  {id:'historical-post-A',title:'TEXTO ORIGINAL',prompt:'Use the established FruttiDrama visual identities. Uva meets Limón in the hacienda garden.',description:'Unverified historical source post'}
]));
const manifest=path.join(root,'channels.json');
fs.writeFileSync(manifest,JSON.stringify({channels:[{id:'fruttidrama',name:'FruttiDrama',status_url:'',panel_url:''}]}));
const child=spawn(process.execPath,['factory-hub.mjs'],{cwd:process.cwd(),env:{...process.env,
 HUB_PORT:String(port),HUB_LISTEN_HOST:'127.0.0.1',PUBLISHER_HUB_USER:'offline',
 PUBLISHER_HUB_PASSWORD:secret,PUBLISHER_HUB_MANIFEST:manifest,
 PUBLISHER_GLOBAL_ACTIVATION_FILE:path.join(root,'missing-gate.json'),
 PUBLISHER_HUB_ACTIVATION_ARMED:'false',
 PUBLISHER_HUB_READY_FILE:path.join(root,'missing-readiness.json'),
 PUBLISHER_RECONCILIATION_MEDIA_ROOT:media,PUBLISHER_RECONCILIATION_STORE_ROOT:store
},stdio:['ignore','pipe','pipe']});
let output='';
for(const stream of [child.stdout,child.stderr])stream.on('data',s=>{output=(output+String(s)).slice(-8000)});
const auth='Basic '+Buffer.from('offline:'+secret).toString('base64');
const base='http://127.0.0.1:'+port;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const http=(endpoint,opt={})=>fetch(base+endpoint,{...opt,headers:{Authorization:auth,...(opt.headers||{})},signal:AbortSignal.timeout(2500)});
const q='/reconciliation/api/';
try{
 let ready=false;
 for(let i=0;i<100;i++){
   if(child.exitCode!==null)throw Error('Hub exited: '+output);
   try{const r=await http('/');if(r.status===200){ready=true;break}}catch{}
   await sleep(100);
 }
 assert.ok(ready,'Hub not available: '+output);
 const unauth=await fetch(base+q+'videos?channel=fruttidrama');
 assert.equal(unauth.status,401,'Historical media must require Hub authentication');
 const ui=await http('/reconciliation?channel=fruttidrama');
 assert.equal(ui.status,200);
 const html=await ui.text();
 assert.ok(html.includes('Videos recuperados')&&html.includes('Posts y prompts históricos'),'Both required manual panes must exist');
 const v=await (await http(q+'videos?channel=fruttidrama')).json();
 assert.equal(v.videos.length,2,'Both real MP4 assets must appear independently');
 assert.ok(v.videos.some(x=>x.hash===h(a))&&v.videos.some(x=>x.hash===h(b)),'Video identity must be full SHA256');
 const p=await (await http(q+'posts?channel=fruttidrama')).json();
 assert.equal(p.posts.length,1,'Imported source posts must be visible');
 const empty=await (await http(q+'assignments?channel=fruttidrama')).json();
 assert.equal(empty.assignments.length,0,'Source post must not imply a video mapping');
 const range=await http(q+'video?channel=fruttidrama&hash='+h(a),{headers:{Range:'bytes=0-9'}});
 assert.equal(range.status,206,'Read-only MP4 endpoint must support partial playback');
 assert.deepEqual(Buffer.from(await range.arrayBuffer()),a.subarray(0,10));
 const prompt=p.posts[0].prompt;
 const record={channel:'fruttidrama',videoHash:h(a),season:2,episode:8,flowPrompt:prompt,sourcePostId:'historical-post-A'};
 const url=q+'assign?channel=fruttidrama';
 const denied=await http(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)});
 assert.equal(denied.status,403,'Manual attestation header is mandatory');
 const invalidSource=await http(url,{method:'POST',headers:{'Content-Type':'application/json','X-Reconciliation-Operator':'manual-verified'},
   body:JSON.stringify({...record,flowPrompt:prompt+' altered after copying'})});
 assert.equal(invalidSource.status,422,'Altered prompt must never be attributed to an exact historical source post');
 const save=await http(url,{method:'POST',headers:{'Content-Type':'application/json','X-Reconciliation-Operator':'manual-verified'},body:JSON.stringify(record)});
 assert.equal(save.status,200,'Operator assignment could not be saved');
 const saved=await save.json();
 assert.equal(saved.assignments.length,1);
 assert.equal(saved.assignments[0].flowPrompt,prompt,'Exact original prompt bytes must be retained');
 assert.equal(saved.assignments[0].flowPromptSha256,h(prompt));
 assert.equal(saved.assignments[0].metadataState,'pending-canonical-copy-review','Do not fabricate metadata');
 const conflict=await http(url,{method:'POST',headers:{'Content-Type':'application/json','X-Reconciliation-Operator':'manual-verified'},
   body:JSON.stringify({...record,videoHash:h(b)})});
 assert.equal(conflict.status,409,'Different video cannot silently claim the same season/episode');
 const final=await (await http(q+'assignments?channel=fruttidrama')).json();
 assert.equal(final.assignments.length,1,'Rejected duplicate assignment changed the ledger');
 assert.equal(h(fs.readFileSync(path.join(files,'video-a.mp4'))),h(a),'Source MP4 was modified');
 assert.equal(fs.existsSync(path.join(root,'publisher-runtime','factory.sqlite')),false,'Reconciliation must never create a production DB');
 const assignmentsFile=path.join(store,'assignments','fruttidrama.json');
 fs.writeFileSync(assignmentsFile,'{invalid-json',{mode:0o600});
 const corrupt=await http(q+'assignments?channel=fruttidrama');
 assert.equal(corrupt.status,400,'Malformed historical ledger must not silently appear empty');
 const cannotOverwrite=await http(url,{method:'POST',headers:{'Content-Type':'application/json','X-Reconciliation-Operator':'manual-verified'},body:JSON.stringify(record)});
 assert.equal(cannotOverwrite.status,400,'Damaged historical ledger must reject mutation');
 assert.equal(fs.readFileSync(assignmentsFile,'utf8'),'{invalid-json','Damaged ledger was overwritten with fresh state');
 console.log('[RECONCILIATION OFFLINE] PASS',JSON.stringify({real_videos:2,imported_posts:1,guessed_links:0,operator_verified:1,duplicate_episode:'rejected',video_range:'206',publisher_db_writes:0,corrupt_ledger:'protected',source_prompt_mismatch:'rejected'}));
}catch(e){
 console.error('[RECONCILIATION OFFLINE] FAIL',String(e?.stack||e));
 console.error('[RECONCILIATION OFFLINE] HUB',output);
 process.exitCode=1;
}finally{
 child.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>child.once('close',resolve)),sleep(1500)]);
 if(child.exitCode===null)child.kill('SIGKILL');
 fs.rmSync(root,{recursive:true,force:true});
}
