import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-frutti-state-repair';
const AUD='publisher-factory-frutti-state-repair';
const ROOT='/tmp/frutti-autonomy-resume';
const TAR=ROOT+'/state.tgz';
const OUT=ROOT+'/state-resumed.tgz';

async function oidc(){
  const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||''),req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
  if(!base||!req)throw new Error('OIDC_UNAVAILABLE');
  const r=await fetch(base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD),{headers:{authorization:'Bearer '+req}});
  if(!r.ok)throw new Error('OIDC_'+r.status);
  return String((await r.json()).value||'');
}
const token=await oidc();
fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
const get=await fetch(EDGE+'/state',{headers:{authorization:'Bearer '+token}});
if(!get.ok)throw new Error('STATE_GET_'+get.status+' '+(await get.text()).slice(0,300));
fs.writeFileSync(TAR,Buffer.from(await get.arrayBuffer()));
if(spawnSync('tar',['-xzf',TAR,'-C',ROOT],{stdio:'inherit'}).status!==0)throw new Error('STATE_EXTRACT_FAILED');

const db=new DatabaseSync(ROOT+'/publisher-runtime/factory.sqlite');
const stamp=new Date().toISOString();
const put=db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
db.exec('BEGIN IMMEDIATE');
try{
  put.run('automation:factoryEnabled','true');
  put.run('automation:freeFactoryEnabled','1');
  put.run('automation:resumedAfterMigration',stamp);
  try{db.prepare("UPDATE factory_items SET nextTry=0,error=NULL,updatedAt=? WHERE season=3 AND status IN ('draft','regen_wait') AND providerRunId IS NULL").run(stamp)}catch{}
  db.exec('COMMIT');
}catch(e){db.exec('ROLLBACK');throw e}
const check=db.prepare("select key,value from factory_meta where key in ('automation:factoryEnabled','automation:freeFactoryEnabled','automation:activeSeason') order by key").all();
db.close();
console.log('FRUTTI_AUTONOMY_RESUMED',JSON.stringify(check));

fs.rmSync(OUT,{force:true});
if(spawnSync('tar',['-czf',OUT,'-C',ROOT,'publisher-runtime','publisher-config.json'],{stdio:'inherit'}).status!==0)throw new Error('STATE_PACK_FAILED');
const putRes=await fetch(EDGE+'/state',{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/octet-stream'},body:fs.readFileSync(OUT)});
if(!putRes.ok)throw new Error('STATE_PUT_'+putRes.status+' '+(await putRes.text()).slice(0,300));
console.log('FRUTTI_AUTONOMY_STATE_UPLOAD_OK',await putRes.text());
