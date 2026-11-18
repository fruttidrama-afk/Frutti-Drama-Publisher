// Pure offline operator-preflight test. No DB, cloud, browser or real secrets.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const validSecret=randomBytes(48).toString('hex');
function run({secret=validSecret,channel='',show=''}={}){
  const env={...process.env,PUBLISHER_SESSION_SECRET:secret,
    PUBLISHER_CHANNEL_ID:channel,
    PUBLISHER_CONFIG_JSON:show?JSON.stringify({identity:{show_name:show}}):''};
  return spawnSync(process.execPath,['--import=./operator-preflight.mjs','-e','console.log("PRECHECK_ACCEPTED")'],{
    cwd:process.cwd(),env,encoding:'utf8',timeout:5000});
}
for(const [id,name] of [['fruttidrama','FruttiDrama'],['earth-in-10','Earth in 10'],['dinnie','Dinnie the Dinosaur']]){
  const yes=run({channel:id,show:name});
  assert.equal(yes.status,0,'Correct channel config rejected: '+id+' '+yes.stderr);
  assert.match(yes.stdout,/PRECHECK_ACCEPTED/);
}
for(const candidate of [
  {secret:'',channel:'fruttidrama',show:'FruttiDrama',error:'PUBLISHER_SESSION_SECRET_REQUIRED'},
  {secret:'REPLACE_WITH_FAKE_SECRET_EXAMPLE_123456789',channel:'dinnie',show:'Dinnie the Dinosaur',error:'PUBLISHER_SESSION_SECRET_REQUIRED'},
  {channel:'fruttidrama',show:'Dinnie the Dinosaur',error:'PUBLISHER_CHANNEL_IDENTITY_MISMATCH'},
  {channel:'earth-in-10',show:'FruttiDrama',error:'PUBLISHER_CHANNEL_IDENTITY_MISMATCH'},
  {channel:'dinnie',show:'',error:'PUBLISHER_CHANNEL_CONFIG_REQUIRED'},
  {channel:'unregistered',show:'Unknown',error:'PUBLISHER_UNKNOWN_CHANNEL_ID'}
]){
  const result=run(candidate);
  assert.notEqual(result.status,0,'Fail-closed preflight accepted invalid input: '+candidate.error);
  assert.match(result.stderr,new RegExp(candidate.error));
}
console.log('[OPERATOR PREFLIGHT OFFLINE] PASS',JSON.stringify({correct_channels:3,invalid_cases_rejected:6,external_calls:0}));
