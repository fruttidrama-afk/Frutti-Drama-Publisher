// Integration check for the central dashboard in a disposable local fixture.
// Never uses production databases, credentials, Flow, YouTube, or Meta.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-hub-offline-'));
const port=39200+Math.floor(Math.random()*20000);
const pass='offline-'+randomBytes(20).toString('hex');
const file=path.join(folder,'channels.json');
const activation=path.join(folder,'operator-activation.json');
fs.writeFileSync(file,JSON.stringify({phase:'reconstruction',channels:[
  {id:'fruttidrama',name:'FruttiDrama',status_url:'',panel_url:''},
  {id:'dinnie',name:'Dinnie the Dinosaur',status_url:'',panel_url:''}
]}));
const child=spawn(process.execPath,['factory-hub.mjs'],{
 cwd:process.cwd(),env:{...process.env,
 HUB_PORT:String(port),HUB_LISTEN_HOST:'127.0.0.1',
 PUBLISHER_HUB_USER:'offline',PUBLISHER_HUB_PASSWORD:pass,
 PUBLISHER_HUB_MANIFEST:file,PUBLISHER_GLOBAL_ACTIVATION_FILE:activation,
 PUBLISHER_HUB_ACTIVATION_ARMED:'true',
 PUBLISHER_HUB_READY_FILE:path.join(folder,'ready.json')
 },stdio:['ignore','pipe','pipe']
});
let output='';
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+String(b)).slice(-6000)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const uri='http://127.0.0.1:'+port+'/';
const auth='Basic '+Buffer.from('offline:'+pass).toString('base64');
const get=(target='/',options={})=>fetch(uri.replace(/\/$/,'')+target,{...options,signal:AbortSignal.timeout(1000)});
try{
 let up=false;
 for(let i=0;i<100;i++){
   if(child.exitCode!==null)throw Error('Hub unexpectedly exited: '+output);
   try{await get();up=true;break}catch{}
   await sleep(75);
 }
 assert.ok(up,'Hub never responded: '+output);
 const unauth=await get();
 assert.equal(unauth.status,401,'Hub must reject requests without credentials');
 const wrong=await get('/',{headers:{authorization:'Basic '+Buffer.from('offline:wrong').toString('base64')}});
 assert.equal(wrong.status,401,'Hub must reject wrong credentials');
 const home=await get('/',{headers:{authorization:auth}});
 assert.equal(home.status,200);
 const html=await home.text();
 assert.ok(html.includes('FruttiDrama')&&html.includes('Dinnie the Dinosaur'),'Hub channel cards missing');
 assert.ok(html.includes('disabled aria-disabled="true"'),'Activation must visibly remain disabled before reconciliation');
 const attempt=await get('/api/activate',{method:'POST',headers:{
   authorization:auth,'Content-Type':'application/json','X-Publisher-Operator':'explicit-click'
 },body:JSON.stringify({confirm:'ACTIVAR AUTOMATIZACIÓN'})});
 assert.equal(attempt.status,423,'Activation must reject incomplete preactivation');
 assert.equal(fs.existsSync(activation),false,'Rejected activation modified the global gate');
 const stop=await get('/api/stop',{method:'POST',headers:{authorization:auth,'X-Publisher-Operator':'explicit-click','Content-Type':'application/json'},body:'{}'});
 assert.equal(stop.status,207,'Stop must report missing synthetic child DBs but still close the central gate');
 const stopped=await stop.json();
 assert.equal(stopped.global_stopped,true,'Emergency stop did not close the global gate');
 assert.equal(JSON.parse(fs.readFileSync(activation,'utf8')).enabled,false,'Emergency stop left global gate enabled');
 const auditFile=path.join(folder,'operator-audit.ndjson');
 assert.ok(fs.existsSync(auditFile),'Operator stop audit was not persisted');
 const audit=JSON.parse(fs.readFileSync(auditFile,'utf8').trim().split('\n')[0]);
 const {recordHash,...data}=audit;
 assert.equal(data.action,'emergency_stop','Wrong operator audit action');
 assert.equal(recordHash,createHash('sha256').update(data.previousHash+'\n'+JSON.stringify(data)).digest('hex'),'Operator audit hash chain mismatch');
 console.log('[HUB OFFLINE] PASS',JSON.stringify({unauthenticated:'401',wrong_password:'401',cards:2,activation:'locked',emergency_stop:'closed_global_gate',audit:'hash_verified'}));
}catch(e){
 console.error('[HUB OFFLINE] FAIL',String(e?.stack||e));
 console.error('[HUB OFFLINE] PROCESS',output);
 process.exitCode=1;
}finally{
 child.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>child.once('close',resolve)),sleep(1500)]);
 if(child.exitCode===null)child.kill('SIGKILL');
 fs.rmSync(folder,{recursive:true,force:true});
}
