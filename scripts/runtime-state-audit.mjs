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

 const table=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
 const safe=(fn,fallback)=>{try{return fn()}catch{return fallback}};
 const candidateStatePaths=[];
 function inspectStateDir(dir,depth=0){
   if(depth>7||candidateStatePaths.length>=75)return;
   for(const e of safe(()=>fs.readdirSync(dir,{withFileTypes:true}),[])){
     const full=dir+'/'+e.name,relative=full.slice(root.length+1);
     if(e.isDirectory()){inspectStateDir(full,depth+1);continue}
     if(/token|secret|credential|oauth|facebook|auth|profile|sqlite|storage/i.test(e.name))candidateStatePaths.push(relative);
   }
 }
 inspectStateDir(root);
 const credentials=['secrets.json','youtube-token.json','auth.json'].map(file=>{
   const f=root+'/publisher-runtime/'+file;
   if(!fs.existsSync(f))return{file,present:false};
   const info=safe(()=>JSON.parse(fs.readFileSync(f,'utf8')),{});
   return{file,present:true,encrypted_envelope:Boolean(info&&info.v===1&&info.iv&&info.tag&&info.data)};
 });
 const publication=table('publication_items')?safe(()=>db.prepare("SELECT episode,status,COALESCE(provider,'youtube') provider,CASE WHEN videoId IS NOT NULL AND TRIM(videoId)<>'' THEN 1 ELSE 0 END remote_id,COALESCE(remotePrivacyStatus,'') remote_privacy,scheduledAt,uploadAt,filePath FROM publication_items ORDER BY scheduledAt DESC LIMIT 30").all().map(x=>({episode:x.episode,status:x.status,provider:x.provider,remote_id:Boolean(x.remote_id),remote_privacy:x.remote_privacy,scheduledAt:x.scheduledAt,uploadAt:x.uploadAt,media:x.filePath?(String(x.filePath).includes('://')?'cloud':fs.existsSync(x.filePath)?'local':'missing'):'none'})),[]):[];
 const episodes=table('factory_items')?safe(()=>db.prepare("SELECT season,episode,status,hook,CASE WHEN videoPath IS NOT NULL AND TRIM(videoPath)<>'' THEN 1 ELSE 0 END has_media FROM factory_items ORDER BY season DESC,episode DESC LIMIT 16").all(),[]):[];
 const recovery=table('flow_recovered_assets')?safe(()=>({
   count:db.prepare("SELECT COUNT(*) n FROM flow_recovered_assets").get().n,
   duplicate_assets:db.prepare("SELECT COUNT(*) n FROM (SELECT assetId FROM flow_recovered_assets GROUP BY assetId HAVING COUNT(*)>1)").get().n,
   latest:db.prepare("SELECT episode,substr(assetId,1,12) asset_prefix,recoveredAt FROM flow_recovered_assets ORDER BY recoveredAt DESC LIMIT 8").all()
 }),null):null;
 const credits=safe(()=>db.prepare("SELECT key,value FROM factory_meta WHERE key IN ('flow:lastCreditsVisible','flow:lastCreditsCheckedAt','flow:lastCreditsSource','flow:dailyCreditCycleUsed','flow:dailyCreditCycleOpenedAt','flow:dailyCreditRefreshWaiting') ORDER BY key").all(),[]);
 db.close();
 console.log('RUNTIME_STATE_AUDIT',JSON.stringify({name,id,bytes:fs.statSync(tar).size,meta,counts,gens,credentials,candidateStatePaths,publication,episodes,recovery,credits}));
}
