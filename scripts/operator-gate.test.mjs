import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { centralGateOpen } from '../activation-gate.mjs';
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
