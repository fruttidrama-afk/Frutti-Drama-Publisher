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
const runtimeConfig=read('runtime-config.js');
for(const [token,label] of [
  ['flow-generate-icon-button','verified Flow submit selector'],
  ['arrow_forward','verified Flow submit icon'],
  ['SUBMIT_ARROW_CLICKED','input evidence event'],
  ['SUBMIT_BOUNDARY_ENTERED','exactly-once boundary'],
  ['automatic_submit_forbidden','post-boundary submit lock'],
  ['flow-grid-tile-container','project-grid recovery'],
  ['flow-tile-hover-footer','recorded asset-open path'],
  ['REVIEW_METADATA_READY','review metadata gate'],
  ['EPISODE_INTENT_REPAIRED','Earth episode intent repair gate'],
  ['EARTH_IN_10_CONTENT_GATE','Earth generic prompt block'],
  ['CREATIVE_PACKAGE_READY','prompt/title/description package checkpoint'],
  ['creativePackageHash','creative package hash link'],
  ["source:'creative-package'",'review metadata preservation']
]) has(provider,token,label);
has(runtimeConfig,'EARTH_IN_10_AUTONOMOUS_EPISODES','Earth autonomous geographic ideas');
has(runtimeConfig,'enforceEpisodeIntent','Earth episode intent validator');
has(runtimeConfig,'effectiveVideoVisualStyle','video/web style isolation');
has(runtimeConfig,'publisherWebStyleLeak','web-style contamination detector');
has(runtimeConfig,'materializeCreativePackage','atomic prompt/title/description creation');
has(runtimeConfig,'validateEpisodePrompt','Show Bible prompt validator');
has(runtimeConfig,'SHOW_BIBLE_REQUIRED','Show Bible hard requirement');
has(runtimeConfig,'PROMPT_QUALITY_GATE','nonempty prompt quality gate');

const init=read('runtime-init.js');
has(init,'runtime_knowledge','runtime knowledge table');
has(init,'creativePackageHash','creative package schema');
has(init,'creativePackageId','creative package id schema');
has(init,"knowledge:flowSopLoaded",'knowledge loaded marker');
has(init,"automation:exactlyOnceSubmit",'exactly-once metadata');
has(init,"automation:strictSerialGeneration",'strict serial metadata');
has(init,"automation:projectGridRecovery",'project-grid metadata');

const server=read('server.js');
has(server,"app.get('/factory/knowledge'",'knowledge endpoint');
has(server,'automation_safety','health safety block');
has(server,'containsSyntheticMedia:true','YouTube synthetic-media disclosure');
has(server,'replacement creative package required','REDO requests atomic package replacement without blanking the old prompt');
has(server,'prompt_integrity','live prompt integrity health');
has(server,'prompt_show_bible_gate:true','Show Bible prompt safety flag');
has(server,'atomic_creative_package:true','atomic creative package safety flag');
has(server,'prompts_rematerialized:true','Show Bible edits rematerialize drafts');

const publication=read('publication.js');
has(publication,'containsSyntheticMedia:true','publication synthetic-media disclosure');
has(publication,'buildPublicationCopy','publication copy builder');
has(publication,'Publication metadata synchronized from the episode creative package.','creative package as publication source');
has(publication,"if(String(row?.title||'').trim()&&String(row?.description||'').trim())",'publication preserves package copy');

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
