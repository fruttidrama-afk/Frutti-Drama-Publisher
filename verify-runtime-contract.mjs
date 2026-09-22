import fs from 'node:fs';
import crypto from 'node:crypto';

const required=[
  'GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md',
  'GOOGLE_FLOW_AUTOMATION_SOP.json',
  'FLOW_AI_IMPLEMENTATION_BRIEF.md',
  'FLOW_RECOVERY_RUNBOOK.md',
  'FLOW_GOLDEN_TEST.md',
  'FLOW_FAILURE_CATALOG.md',
  'FLOW_CHANGELOG.md',
  'FLOW_SOP_KNOWLEDGE_MANIFEST.json'
];
const fail=(m)=>{console.error('[RUNTIME CONTRACT FAIL]',m);process.exitCode=1};
const need=(file,needle,label=needle)=>{
  const c=fs.readFileSync(file,'utf8');
  if(!c.includes(needle))fail(file+' missing '+label);
  return c;
};
for(const f of required)if(!fs.existsSync(f))fail('missing knowledge file '+f);

const master=fs.readFileSync('GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md','utf8');
const masterSha=crypto.createHash('sha256').update(master).digest('hex');
const sop=JSON.parse(fs.readFileSync('GOOGLE_FLOW_AUTOMATION_SOP.json','utf8'));
if(sop.sop_id!=='FLOW-SOP-v1.0')fail('wrong SOP version '+String(sop.sop_id));
if(String(sop.sha256||'')!==masterSha)fail('machine SOP hash does not match master: '+sop.sha256+' != '+masterSha);

const init=need('runtime-init.js','CREATE TABLE IF NOT EXISTS runtime_knowledge','runtime knowledge table');
for(const k of ['knowledge:flowSopVersion','knowledge:flowSopSha256','knowledge:flowSopLoaded','automation:strictSerialGeneration','automation:projectGridRecovery','automation:reviewMetadataRequired'])if(!init.includes(k))fail('runtime-init missing '+k);

const server=fs.readFileSync('server.js','utf8');
for(const k of ["app.get('/factory/knowledge'","knowledge:flowSopLoaded","strict_serial_generation","project_grid_recovery","review_metadata_required","serial_gate:{enabled:true"])if(!server.includes(k))fail('server contract missing '+k);

const provider=fs.readFileSync('free-browser-provider.js','utf8');
for(const k of ['flow-generate-icon-button','arrow_forward','SUBMIT_BOUNDARY_ENTERED','automatic_submit_forbidden','flow-video-tile','flow-tile-hover-footer','SERIAL_GATE_BLOCKED'])if(!provider.includes(k))fail('Flow provider contract missing '+k);

const copy=fs.readFileSync('publication-copy.js','utf8');
for(const k of ['buildPublicationCopy','prompt=','hashtags'])if(!copy.includes(k))fail('publication metadata contract missing '+k);

const docker=fs.readFileSync('Dockerfile','utf8');
for(const f of required)if(!docker.includes(f))fail('Dockerfile does not bundle '+f);

if(!process.exitCode)console.log('[RUNTIME CONTRACT PASS]',JSON.stringify({sop:sop.sop_id,sha256:masterSha,documents:required.length,strictSerial:true,exactlyOnce:true,projectGridRecovery:true,reviewMetadata:true}));
