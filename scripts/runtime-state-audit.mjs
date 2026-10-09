import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-runtime-state-audit';
const AUD='publisher-factory-runtime-state-audit';
const targets=[
 ['frutti','7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7'],
 ['earth','ee4f3cc6-bece-4d1b-94b4-e9dfbe1b7887'],
 ['dinnie','d4e02dfa-be8a-43f1-abf1-2113ec4b05d6']
];
async function oidc(){
 const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||''),req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
 const r=await fetch(base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD),{headers:{authorization:'Bearer '+req}});
 if(!r.ok)throw new Error('OIDC_'+r.status);
 return String((await r.json()).value||'');
}
const token=await oidc();
for(const [name,id] of targets){
 const root='/tmp/runtime-audit-'+name;
 fs.rmSync(root,{recursive:true,force:true});fs.mkdirSync(root,{recursive:true});
 const r=await fetch(EDGE+'?publisher_id='+encodeURIComponent(id),{headers:{authorization:'Bearer '+token}});
 if(!r.ok){console.log('STATE_AUDIT_ERROR',JSON.stringify({name,status:r.status,text:(await r.text()).slice(0,300)}));continue}
 const tar=root+'/state.tgz';fs.writeFileSync(tar,Buffer.from(await r.arrayBuffer()));
 if(spawnSync('tar',['-xzf',tar,'-C',root]).status!==0){console.log('STATE_AUDIT_ERROR',JSON.stringify({name,error:'tar'}));continue}
 const dbp=root+'/publisher-runtime/factory.sqlite';
 if(!fs.existsSync(dbp)){console.log('STATE_AUDIT_ERROR',JSON.stringify({name,error:'db-missing'}));continue}
 const db=new DatabaseSync(dbp,{readOnly:true});
 const meta=db.prepare("select key,value from factory_meta where key in ('automation:factoryEnabled','automation:freeFactoryEnabled','flow:dailyCreditBatchOpen','flow:dailyCreditRefreshWaiting','flow:state','flow:currentStep','automation:activeSeason') order by key").all();
 let counts={};try{for(const x of db.prepare("select status,count(*) n from factory_items group by status").all())counts[x.status]=Number(x.n)}catch{}
 let gens=[];try{gens=db.prepare("select day,status,credits,count(*) n from factory_generations group by day,status,credits order by day desc limit 20").all()}catch{}
 db.close();
 console.log('RUNTIME_STATE_AUDIT',JSON.stringify({name,id,bytes:fs.statSync(tar).size,meta,counts,gens}));
}
