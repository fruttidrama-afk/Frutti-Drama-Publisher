// End-to-end offline operator activation transaction with disposable SQLite
// and a fake health server. Never loads actual Publisher workers, Flow, or tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash} from 'node:crypto';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-activation-offline-'));
const dataRoot=path.join(root,'data');
fs.mkdirSync(dataRoot,{recursive:true});
const manifest=path.join(root,'channels.json'),readyFile=path.join(root,'ready.json');
const gate=path.join(root,'operator-activation.json');
const port=30000+Math.floor(Math.random()*12000);
const password='fixture-'+randomBytes(24).toString('hex');
const chs=['fruttidrama','earth-in-10','dinnie'].map(id=>{
 const dirname=path.join(dataRoot,id);
 fs.mkdirSync(dirname,{recursive:true});
 const file=path.join(dirname,'factory.sqlite');
 const db=new DatabaseSync(file);
 try{db.exec('CREATE TABLE factory_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')}
 finally{db.close()}
 return{id,name:id==='dinnie'?'Dinnie the Dinosaur':id==='earth-in-10'?'Earth in 10':'FruttiDrama',db_path:file};
});
const fakeHealth=http.createServer((req,res)=>{
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify({operator_activated:false,publisher_enabled:false,
   flow:{authenticated:true,configured:true},publication_connected:true}));
});
const start=await new Promise((resolve,reject)=>{
 fakeHealth.on('error',reject);
 fakeHealth.listen(0,'127.0.0.1',()=>resolve(fakeHealth.address().port));
});
for(const ch of chs)ch.status_url='http://127.0.0.1:'+start+'/health';
fs.writeFileSync(manifest,JSON.stringify({phase:'reconstruction',channels:chs}));
const child=spawn(process.execPath,['factory-hub.mjs'],{cwd:process.cwd(),env:{
 ...process.env,HUB_PORT:String(port),HUB_LISTEN_HOST:'127.0.0.1',
 PUBLISHER_HUB_USER:'test-operator',PUBLISHER_HUB_PASSWORD:password,
 PUBLISHER_HUB_MANIFEST:manifest,PUBLISHER_HUB_DATA_ROOT:dataRoot,
 PUBLISHER_GLOBAL_ACTIVATION_FILE:gate,PUBLISHER_HUB_READY_FILE:readyFile,
 PUBLISHER_HUB_ACTIVATION_ARMED:'true'
},stdio:['ignore','pipe','pipe']});
let output='';
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+String(b)).slice(-9000)});
const auth='Basic '+Buffer.from('test-operator:'+password).toString('base64');
const base='http://127.0.0.1:'+port;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const get=(pathname='/',options={})=>fetch(base+pathname,{...options,
 headers:{authorization:auth,...(options.headers||{})},signal:AbortSignal.timeout(3000)});
const change=(pathname,body)=>get(pathname,{method:'POST',headers:{
 'Content-Type':'application/json','X-Publisher-Operator':'explicit-click'
},body:JSON.stringify(body)});
const metadata=(ch,k)=>{
 const db=new DatabaseSync(ch.db_path,{readOnly:true});
 try{return db.prepare('SELECT value FROM factory_meta WHERE key=?').get(k)?.value||null}
 finally{db.close()}
};
const checkAudit=()=>{
 const audit=path.join(root,'operator-audit.ndjson');
 let prev='0'.repeat(64);
 const records=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse);
 for(const record of records){
  const {recordHash,...data}=record;
  assert.equal(data.previousHash,prev,'Operator audit chain is broken');
  assert.equal(recordHash,createHash('sha256').update(prev+'\n'+JSON.stringify(data)).digest('hex'));
  prev=recordHash;
 }
 return records;
};
try{
 let responding=false;
 for(let i=0;i<100;i++){
   if(child.exitCode!==null)throw Error('Hub startup failed: '+output);
   try{const h=await get('/');if(h.status===200){responding=true;break}}catch{}
   await sleep(90);
 }
 assert.equal(responding,true,'Hub never responded: '+output);
 let html=await (await get('/')).text();
 assert.ok(html.includes('disabled aria-disabled="true"'),'Pre-review activation was not disabled');
 assert.equal((await change('/api/activate',{confirm:'ACTIVAR AUTOMATIZACIÓN'})).status,423);
 assert.equal(fs.existsSync(gate),false,'Rejected attempt must not write activation gate');
 fs.writeFileSync(readyFile,JSON.stringify({schema:1,all_tests_passed:true,
   historical_reconciliation_completed:true,operator_preactivation_review_complete:true,
   channel_ids:chs.map(c=>c.id)}));
 html=await (await get('/')).text();
 assert.ok(html.includes('id="activate"'),'Explicitly ready fixture must show the activation control');
 const withoutHeader=await get('/api/activate',{method:'POST',
   headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'ACTIVAR AUTOMATIZACIÓN'})});
 assert.equal(withoutHeader.status,403,'Activation must require deliberate operator action header');
 assert.equal((await change('/api/activate',{confirm:'incorrect'})).status,400,
   'Activation must reject incorrect human confirmation');
 assert.equal(fs.existsSync(gate),false,'Invalid confirmation wrote global gate');
 const activate=await change('/api/activate',{confirm:'ACTIVAR AUTOMATIZACIÓN'});
 assert.equal(activate.status,200,'Explicit fixture activation rejected: '+await activate.text());
 const g=JSON.parse(fs.readFileSync(gate,'utf8'));
 assert.equal(g.enabled,true,'Synthetic activation did not set global gate');
 for(const ch of chs){
   assert.equal(metadata(ch,'automation:operatorActivated'),'true','Child operator gate not enabled');
   assert.equal(metadata(ch,'automation:factoryEnabled'),'true','Child factory gate not enabled');
   assert.equal(metadata(ch,'automation:allowSubmit'),'0','Manual submit cannot be implicitly authorized');
 }
 const audit=checkAudit();
 assert.deepEqual(audit.map(x=>x.action),['activation_requested','activation_authorized'],
   'Synthetic activation request and completion must both be audited');
 const stop=await change('/api/stop',{});
 assert.equal(stop.status,200,'Synthetic emergency stop failed: '+await stop.text());
 assert.equal(JSON.parse(fs.readFileSync(gate,'utf8')).enabled,false,'Emergency stop did not close global gate');
 for(const ch of chs){
   assert.equal(metadata(ch,'automation:operatorActivated'),'false');
   assert.equal(metadata(ch,'automation:factoryEnabled'),'false');
 }
 assert.deepEqual(checkAudit().map(x=>x.action),
   ['activation_requested','activation_authorized','emergency_stop']);
 // Even if manifest has a matching name, a symlink escaping the private
 // data volume must never be granted operator write permissions.
 const outside=path.join(root,'external.sqlite');
 fs.copyFileSync(chs[0].db_path,outside);
 const symlink=path.join(dataRoot,'outside.sqlite');
 fs.symlinkSync(outside,symlink);
 const changed=chs.map(x=>({...x}));
 changed[0].db_path=symlink;
 fs.writeFileSync(manifest,JSON.stringify({channels:changed}));
 assert.equal((await change('/api/activate',{confirm:'ACTIVAR AUTOMATIZACIÓN'})).status,423,
   'Symlink outside private mount bypassed activation safety gate');
 assert.equal(JSON.parse(fs.readFileSync(gate,'utf8')).enabled,false,
   'Rejected unsafe DB path unexpectedly reopened global activation');
 console.log('[HUB ACTIVATION OFFLINE] PASS',JSON.stringify({
   source:'synthetic',activation:'explicit-only',ready_fixture:'true',
   child_db_gates:3,submit_gates:'closed',stop:'global-and-children',
   audit:'three-verified-entries',escape_symlink:'rejected',real_publishers_affected:0
 }));
}catch(e){
 console.error('[HUB ACTIVATION OFFLINE] FAIL',String(e?.stack||e));
 console.error('[HUB ACTIVATION OFFLINE] LOG',output);
 process.exitCode=1;
}finally{
 child.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>child.once('close',resolve)),sleep(1500)]);
 if(child.exitCode===null)child.kill('SIGKILL');
 await new Promise(resolve=>fakeHealth.close(resolve));
 fs.rmSync(root,{recursive:true,force:true});
}
