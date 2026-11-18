// Single disconnected Docker test: all three child runtimes boot concurrently
// with distinct secrets/SQLite, no Flow or platform tokens, central gate absent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'three-shows-paused-'));
const channels=[
 {id:'fruttidrama',name:'FruttiDrama',port:49760},
 {id:'earth-in-10',name:'Earth in 10',port:49761},
 {id:'dinnie',name:'Dinnie the Dinosaur',port:49762}
];
const starts=['--import=./operator-preflight.mjs','--import=./unattended-supervisor.js',
 '--import=./runtime-init.js','--import=./free-browser-provider.js',
 '--import=./flow-bootstrap.js','server.js'];
const children=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function inspect(c){
 const response=await fetch('http://127.0.0.1:'+c.port+'/factory/health',{
   signal:AbortSignal.timeout(1500)});
 assert.equal(response.status,200,c.id+' HTTP status');
 const health=await response.json();
 assert.equal(health.operator_activated,false,c.id+' operator gate open');
 assert.equal(health.publisher_enabled,false,c.id+' factory gate open');
 assert.equal(health.show,c.name,c.id+' wrong show');
 return health;
}
try{
 for(const c of channels){
  const dir=path.join(root,c.id);
  const env={...process.env,PORT:String(c.port),DATA_DIR:dir,
    PUBLISHER_SESSION_SECRET:randomBytes(48).toString('hex'),
    PUBLISHER_SETUP_TOKEN:randomBytes(48).toString('hex'),
    PUBLISHER_CHANNEL_ID:c.id,
    PUBLISHER_GLOBAL_FLOW_LOCK_PATH:'/flow-lock/flow.lock',
    PUBLISHER_GLOBAL_ACTIVATION_FILE:path.join(root,'activation-does-not-exist.json'),
    PUBLISHER_ENABLED:'false',
    PUBLISHER_CONFIG_JSON:JSON.stringify({
      identity:{publisher_name:c.name,show_name:c.name,timezone:'America/Argentina/Buenos_Aires'},
      content:{initial_episodes:[],creative_bible:''},
      publication:{selected_provider:null,providers:[]}
    })
  };
  const process=spawn(processExecPath(),starts,{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
  let log='';
  for(const stream of [process.stdout,process.stderr])stream.on('data',part=>{log=(log+part.toString()).slice(-4000)});
  children.push({c,process,logs:()=>log});
 }
 for(const row of children){
  let ok=false;
  for(let i=0;i<90;i++){
   if(row.process.exitCode!==null)throw Error('Child '+row.c.id+' exited: '+row.logs());
   try{await inspect(row.c);ok=true;break}catch{}
   await pause(100);
  }
  assert.ok(ok,'Child '+row.c.id+' not healthy: '+row.logs());
 }
 // Cross one 8s supervisor tick and the initial 12s browser provider tick.
 await pause(14000);
 for(const row of children){
  assert.equal(row.process.exitCode,null,'Paused child died: '+row.c.id+' '+row.logs());
  await inspect(row.c);
  const file=path.join(root,row.c.id,'publisher-runtime','factory.sqlite');
  const db=new DatabaseSync(file,{readOnly:true});
  try{
   for(const table of ['factory_items','factory_generations','publication_items']){
    const result=db.prepare('SELECT COUNT(*) AS n FROM '+table).get();
    assert.equal(result.n,0,row.c.id+': new unapproved record in '+table);
   }
   const activated=db.prepare("SELECT value FROM factory_meta WHERE key='automation:operatorActivated'").get()?.value;
   assert.notEqual(activated,'true',row.c.id+' silently activated');
  }finally{db.close()}
 }
 assert.equal(fs.existsSync(path.join(root,'activation-does-not-exist.json')),false);
 console.log('[THREE CHILDREN PAUSED OFFLINE] PASS',JSON.stringify({
   children:3,isolation:'separate_SQLite',automation:'OFF',
   generations:0,publication:0,recovery:0,flowVisited:false,
   dockerNetwork:'none',approval:'not-triggered'
 }));
}catch(err){
 console.error('[THREE CHILDREN PAUSED OFFLINE] FAIL',String(err?.stack||err));
 for(const row of children)console.error('[CHILD OUTPUT]',row.c.id,row.logs());
 process.exitCode=1;
}finally{
 for(const row of children)row.process.kill('SIGTERM');
 await Promise.all(children.map(row=>Promise.race([
  new Promise(resolve=>row.process.once('close',resolve)),pause(1500)
 ])));
 for(const row of children)if(row.process.exitCode===null)row.process.kill('SIGKILL');
 fs.rmSync(root,{recursive:true,force:true});
}
function processExecPath(){return process.execPath}
