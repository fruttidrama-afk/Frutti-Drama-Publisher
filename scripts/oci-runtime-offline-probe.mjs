// Disposable full-start smoke test. Only execute with Docker --network none.
// Uses a newly created ephemeral test DB; no Flow login, Google/Meta tokens,
// persistent volumes, production URLs, or publication activity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {randomBytes,createHash,createHmac} from 'node:crypto';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'oci-runtime-offline-'));
const port=49881;
const secret=randomBytes(48).toString('hex');
const setupToken=randomBytes(32).toString('hex');
const env={
  ...process.env, DATA_DIR:temp, PORT:String(port), PUBLISHER_SESSION_SECRET:secret, PUBLISHER_SETUP_TOKEN:setupToken,
  PUBLISHER_ENABLED:'false',PUBLISHER_GLOBAL_ACTIVATION_FILE:path.join(temp,'gate-not-present.json'),
  PUBLISHER_CONFIG_JSON:JSON.stringify({
    identity:{publisher_name:'Offline Probe',show_name:'Offline Probe',timezone:'UTC'},
    content:{creative_bible:'Offline probe. No real content or production output is authorized.',initial_episodes:[]},
    publication:{selected_provider:null,providers:[]}
  })
};
const parts=['--import=./unattended-supervisor.js','--import=./runtime-init.js','--import=./free-browser-provider.js','--import=./flow-bootstrap.js','server.js'];
const child=spawn(process.execPath,parts,{env,cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
let output='';
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+String(b)).slice(-16000)});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function get(endpoint,accept='application/json'){
  return fetch('http://127.0.0.1:'+port+endpoint,{headers:{Accept:accept},redirect:'manual',signal:AbortSignal.timeout(1000)});
}
try{
  let ready=false;
  for(let i=0;i<120;i++){
    if(child.exitCode!==null)throw Error('Runtime exited during offline startup: '+child.exitCode);
    try{const res=await get('/factory/health');if(res.status===200){ready=true;break}}catch{}
    await sleep(100);
  }
  assert.ok(ready,'Offline runtime did not respond on localhost; last log: '+output.slice(-1800));
  const auth=await get('/flow/bootstrap/status');
  assert.equal(auth.status,401,'Flow remote-control status must require publisher authentication');
  const img=await get('/flow/bootstrap/screen.png');
  assert.equal(img.status,401,'Flow screenshot must require publisher authentication');
  const root=await get('/flow/bootstrap','text/html');
  assert.equal(root.status,302,'Flow bootstrap panel must redirect anonymous users');
  // A correctly signed cookie still must be rejected if the session was never
  // issued/registered. This protects revoked sessions from being resurrected.
  const exp=Date.now()+3600000;
  const nonce=randomBytes(18).toString('base64url');
  const payload=String(exp)+'.'+nonce;
  const signature=createHmac('sha256',createHash('sha256').update(secret).digest()).update(payload).digest('base64url');
  const forged=await fetch('http://127.0.0.1:'+port+'/auth/sessions',{headers:{Cookie:'publisher_session='+payload+'.'+signature},redirect:'manual',signal:AbortSignal.timeout(1000)});
  assert.equal(forged.status,401,'Unknown signed session cookie must not auto-register itself');
  // Only use synthetic credentials in this fully isolated ephemeral database.
  const setup=await fetch('http://127.0.0.1:'+port+'/setup/activate',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({token:setupToken}),signal:AbortSignal.timeout(1000)});
  assert.equal(setup.status,200,'Synthetic operator setup must be available');
  const cookie=setup.headers.get('set-cookie')?.split(';')[0]||'';
  assert.ok(cookie.includes('publisher_session='),'Synthetic session cookie missing');
  const authenticated=await fetch('http://127.0.0.1:'+port+'/auth/sessions',{headers:{Cookie:cookie},signal:AbortSignal.timeout(1000)});
  assert.equal(authenticated.status,200,'Issued signed session must be accepted');
  for(const target of ['/factory/run','/publication/run','/api/schedule','/api/show-bible','/integrations/platform',
    '/factory/example-id/approve','/factory/example-id/reject','/factory/import-stock/1','/publication/example-id/recover-video']){
    const blocked=await fetch('http://127.0.0.1:'+port+target,{
      method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},
      body:JSON.stringify({}),signal:AbortSignal.timeout(1000)});
    assert.equal(blocked.status,423,'Paused runtime accepted mutation '+target+': HTTP '+blocked.status);
  }

  const dbFile=path.join(temp,'publisher-runtime','factory.sqlite');
  assert.ok(fs.existsSync(dbFile),'Factory offline fixture DB missing');
  const db=new DatabaseSync(dbFile);
  try{
    const activated=db.prepare("SELECT value FROM factory_meta WHERE key='automation:operatorActivated'").get()?.value;
    assert.notEqual(activated,'true','Synthetic factory was auto-activated');
    const generations=db.prepare('SELECT COUNT(*) as n FROM factory_generations').get()?.n;
    assert.equal(Number(generations),0,'Synthetic offline factory created generation runs');
    const publications=db.prepare('SELECT COUNT(*) as n FROM publication_items').get()?.n;
    assert.equal(Number(publications),0,'Synthetic offline factory created publications');
  }finally{db.close()}
  console.log('[OCI OFFLINE RUNTIME] PASS',JSON.stringify({
    health:'reachable',operator_activated:false,flow_controls:'authenticated',manual_mutation_endpoints:'locked',unknown_signed_cookies:'rejected',new_generations:0,new_publications:0,network:'Docker none',flowVisited:false
  }));
}catch(e){
  console.error('[OCI OFFLINE RUNTIME] FAIL',String(e?.message||e));
  console.error('[OCI OFFLINE RUNTIME] PROCESS OUTPUT',output.slice(-6000));
  process.exitCode=1;
}finally{
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>child.once('close',resolve)),sleep(2500)]);
  if(child.exitCode===null)child.kill('SIGKILL');
  fs.rmSync(temp,{recursive:true,force:true});
}
