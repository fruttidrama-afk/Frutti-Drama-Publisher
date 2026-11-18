import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { centralGateOpen,operatorGenerationEnvEnabled } from '../activation-gate.mjs';
test('central operator gate defaults CLOSED and rejects all invalid states',()=>{
  const old=process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-safe-'));
  const file=path.join(dir,'gate.json');
  try{
    delete process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE;
    assert.equal(centralGateOpen(),false);
    process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE=file;
    assert.equal(centralGateOpen(),false);
    fs.writeFileSync(file,'not-json');
    assert.equal(centralGateOpen(),false);
    fs.writeFileSync(file,JSON.stringify({schema:1,enabled:true}));
    assert.equal(centralGateOpen(),false);
    fs.writeFileSync(file,JSON.stringify({schema:1,enabled:false,activated_by:'operator',activation_id:'123e4567-e89b-12d3-a456-426614174000'}));
    assert.equal(centralGateOpen(),false);
    fs.writeFileSync(file,JSON.stringify({schema:1,enabled:true,activated_by:'scheduler',activation_id:'123e4567-e89b-12d3-a456-426614174000'}));
    assert.equal(centralGateOpen(),false);
    fs.writeFileSync(file,JSON.stringify({schema:1,enabled:true,activated_by:'operator',activation_id:'123e4567-e89b-12d3-a456-426614174000'}));
    assert.equal(centralGateOpen(),true);
  }finally{
    if(old===undefined)delete process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE;
    else process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE=old;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('generation remains OFF until explicit central and per-child operator activation',()=>{
  const prev=Object.fromEntries(['PUBLISHER_ENABLED','PUBLISHER_ENABLE_AFTER_MANUAL_ACTIVATION','PUBLISHER_GLOBAL_ACTIVATION_FILE']
    .map(k=>[k,process.env[k]]));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-gate-manual-'));
  try{
    const file=path.join(dir,'activation.json');
    process.env.PUBLISHER_ENABLED='false';
    process.env.PUBLISHER_ENABLE_AFTER_MANUAL_ACTIVATION='true';
    process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE=file;
    const allow=(operatorActivated,factoryEnabled)=>
      operatorGenerationEnvEnabled({operatorActivated,factoryEnabled});
    assert.equal(allow(false,false),false);
    assert.equal(allow(true,true),false,'Missing global file must keep all shows OFF');
    fs.writeFileSync(file,JSON.stringify({
      schema:1,enabled:false,activated_by:'operator',
      activation_id:'123e4567-e89b-12d3-a456-426614174000'
    }));
    assert.equal(allow(true,true),false,'Explicit STOP must override local gates');
    fs.writeFileSync(file,JSON.stringify({
      schema:1,enabled:true,activated_by:'operator',
      activation_id:'123e4567-e89b-12d3-a456-426614174000'
    }));
    assert.equal(allow(false,true),false,'No local operator activation');
    assert.equal(allow(true,false),false,'No local factory activation');
    assert.equal(allow(true,true),true,'Real operator click must be able to activate an initially OFF publisher');
    process.env.PUBLISHER_ENABLE_AFTER_MANUAL_ACTIVATION='false';
    assert.equal(allow(true,true),false,'Disarmed environment must remain OFF despite DB gates');
  }finally{
    for(const [k,v]of Object.entries(prev)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
