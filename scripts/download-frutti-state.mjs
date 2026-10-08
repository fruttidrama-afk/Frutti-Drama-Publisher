import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-frutti-state-audit';
const AUD='publisher-factory-frutti-state-audit';
const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
const req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
if(!base||!req)throw new Error('OIDC_UNAVAILABLE');
const tok=await fetch(base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD),{headers:{authorization:'Bearer '+req}});
if(!tok.ok)throw new Error('OIDC_'+tok.status);
const oidc=String((await tok.json()).value||'');
const r=await fetch(EDGE,{headers:{authorization:'Bearer '+oidc}});
if(!r.ok)throw new Error('STATE_'+r.status+' '+(await r.text()).slice(0,300));
fs.writeFileSync('/tmp/frutti-state.tgz',Buffer.from(await r.arrayBuffer()));
console.log('STATE_BYTES',fs.statSync('/tmp/frutti-state.tgz').size);

fs.rmSync('/tmp/frutti-state',{recursive:true,force:true});
fs.mkdirSync('/tmp/frutti-state',{recursive:true});
const ex=spawnSync('tar',['-xzf','/tmp/frutti-state.tgz','-C','/tmp/frutti-state'],{stdio:'inherit'});
if(ex.status!==0)throw new Error('TAR_FAILED');

const db=new DatabaseSync('/tmp/frutti-state/publisher-runtime/factory.sqlite',{readOnly:true});
for(const table of ['factory_items','factory_generations','publication_items']){
  try{
    const rows=db.prepare('select * from '+table+' order by rowid desc limit 40').all();
    console.log('STATE_'+table.toUpperCase(),JSON.stringify(rows));
  }catch(e){
    console.log('STATE_'+table.toUpperCase()+'_ERROR',String(e.message||e));
  }
}
db.close();
