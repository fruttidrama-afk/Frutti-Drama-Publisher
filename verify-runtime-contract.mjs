import fs from 'node:fs';
import { createHash } from 'node:crypto';

const read=p=>fs.readFileSync(p,'utf8');
const fail=m=>{throw new Error('[RUNTIME CONTRACT] '+m)};
const must=(v,m)=>{if(!v)fail(m)};

const master=read('GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md');
const sop=JSON.parse(read('GOOGLE_FLOW_AUTOMATION_SOP.json'));
const manifest=JSON.parse(read('FLOW_SOP_KNOWLEDGE_MANIFEST.json'));
const schema=JSON.parse(read('publisher.config.schema.json'));
const provider=read('free-browser-provider.js');
const runtimeConfig=read('runtime-config.js');
const init=read('runtime-init.js');
const server=read('server.js');

const sha=createHash('sha256').update(master).digest('hex');
must(sop.sop_id==='FLOW-SOP-v1.0','wrong SOP version');
must(sop.sha256===sha,'SOP JSON hash does not match master');
must(manifest.master_sha256===sha,'manifest hash does not match master');
must(manifest.inheritance_required===true,'knowledge inheritance not mandatory');

const a=schema.properties?.automation?.properties||{};
for(const k of ['exactly_once_submit','strict_serial_generation','project_grid_recovery','current_consent_only','review_metadata_required','golden_test_required']){
  must(a[k]?.const===true,'schema invariant '+k+' must be const true');
}
must(schema.properties?.schedule?.properties?.generation_strategy?.const==='sequential','generation strategy must be sequential');
must(schema.properties?.knowledge?.properties?.flow_sop_version?.const==='FLOW-SOP-v1.0','schema knowledge version mismatch');

for(const token of ['flow-generate-icon-button','arrow_forward','SUBMIT_BOUNDARY_ENTERED','automatic_submit_forbidden','flow-grid-tile-container','flow-tile-hover-footer','EPISODE_INTENT_REPAIRED','EARTH_IN_10_CONTENT_GATE','CREATIVE_PACKAGE_READY','creativePackageHash','source:\'creative-package\'']){
  must(provider.includes(token),'provider contract missing '+token);
}
for(const token of ['EARTH_IN_10_AUTONOMOUS_EPISODES','enforceEpisodeIntent','effectiveVideoVisualStyle','publisherWebStyleLeak']){
  must(runtimeConfig.includes(token),'runtime content contract missing '+token);
}
for(const token of ['runtime_knowledge','creativePackageHash','creativePackageId','knowledge:flowSopLoaded','automation:exactlyOnceSubmit','automation:strictSerialGeneration']){
  must(init.includes(token),'runtime-init contract missing '+token);
}
for(const token of ["app.get('/factory/knowledge'","automation_safety","containsSyntheticMedia:true","creativePackageHash=NULL","title='',description=''"]){
  must(server.includes(token),'server contract missing '+token);
}

console.log(JSON.stringify({
  ok:true,
  contract:'publisher-runtime-flow-v1',
  sop_version:sop.sop_id,
  sop_sha256:sha,
  strict_serial:true,
  exactly_once_submit:true,
  project_grid_recovery:true,
  knowledge_inheritance:true
},null,2));
