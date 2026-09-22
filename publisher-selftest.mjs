import fs from 'node:fs';
import { createHash } from 'node:crypto';

const read=p=>fs.readFileSync(p,'utf8');
const must=(ok,msg)=>{if(!ok){console.error('[PUBLISHER SELFTEST] FAIL:',msg);process.exit(1)}};
const has=(text,token,label)=>must(text.includes(token),label+' missing '+token);

const master=read('GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md');
const machine=JSON.parse(read('GOOGLE_FLOW_AUTOMATION_SOP.json'));
const manifest=JSON.parse(read('FLOW_SOP_KNOWLEDGE_MANIFEST.json'));
const hash=createHash('sha256').update(master).digest('hex');

must(machine.sop_id==='FLOW-SOP-v1.0','SOP version');
must(machine.sha256===hash,'machine SOP hash mismatch');
must(manifest.master_sha256===hash,'manifest SOP hash mismatch');
must(manifest.inheritance_required===true,'inheritance must be required');
must(Array.isArray(manifest.canonical_files)&&manifest.canonical_files.length>=7,'knowledge pack incomplete');

const provider=read('free-browser-provider.js');
for(const [token,label] of [
  ['flow-generate-icon-button','verified Flow submit selector'],
  ['arrow_forward','verified Flow submit icon'],
  ['SUBMIT_ARROW_CLICKED','input evidence event'],
  ['SUBMIT_BOUNDARY_ENTERED','exactly-once boundary'],
  ['automatic_submit_forbidden','post-boundary submit lock'],
  ['flow-grid-tile-container','project-grid recovery'],
  ['flow-tile-hover-footer','recorded asset-open path'],
  ['REVIEW_METADATA_READY','review metadata gate']
]) has(provider,token,label);

const init=read('runtime-init.js');
has(init,'runtime_knowledge','runtime knowledge table');
has(init,"knowledge:flowSopLoaded",'knowledge loaded marker');
has(init,"automation:exactlyOnceSubmit",'exactly-once metadata');
has(init,"automation:strictSerialGeneration",'strict serial metadata');
has(init,"automation:projectGridRecovery",'project-grid metadata');

const server=read('server.js');
has(server,"app.get('/factory/knowledge'",'knowledge endpoint');
has(server,'automation_safety','health safety block');
has(server,'containsSyntheticMedia:true','YouTube synthetic-media disclosure');

const publication=read('publication.js');
has(publication,'containsSyntheticMedia:true','publication synthetic-media disclosure');
has(publication,'buildPublicationCopy','publication copy builder');

const schema=JSON.parse(read('publisher.config.schema.json'));
must(schema.properties?.schedule?.properties?.generation_strategy?.const==='sequential','Publisher Factory must enforce sequential Flow generation');
must(schema.properties?.automation?.properties?.exactly_once_submit?.const===true,'schema exactly-once invariant');
must(schema.properties?.automation?.properties?.strict_serial_generation?.const===true,'schema strict serial invariant');
must(schema.properties?.knowledge?.properties?.flow_sop_version?.const==='FLOW-SOP-v1.0','schema SOP inheritance version');

console.log(JSON.stringify({
  ok:true,
  sop_version:machine.sop_id,
  sop_sha256:hash,
  master_bytes:Buffer.byteLength(master),
  strict_serial:true,
  exactly_once_submit:true,
  project_grid_recovery:true,
  review_metadata_required:true
},null,2));
