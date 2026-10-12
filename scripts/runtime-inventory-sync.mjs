import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const edge='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-runtime-state-audit';
const audience='publisher-factory-runtime-state-audit';
const ids=[
 ['FruttiDrama','7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7'],
 ['EARTH IN 10','ee4f3cc6-bece-4d1b-94b4-e9dfbe1b7887'],
 ['Dinnie The Dinosaur','d4e02dfa-be8a-43f1-abf1-2113ec4b05d6']
];
async function token(){
 const url=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
 const bearer=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
 if(!url||!bearer)throw Error('MISSING_WORKFLOW_IDENTITY');
 const response=await fetch(url+(url.includes('?')?'&':'?')+'audience='+encodeURIComponent(audience),{headers:{authorization:'Bearer '+bearer}});
 if(!response.ok)throw Error('OIDC_'+response.status);
 return String((await response.json()).value||'');
}
const identity=await token();
function table(db,name){return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))}
function safe(fn,fallback){try{return fn()}catch{return fallback}}
function count(db,sql){return safe(()=>Number(db.prepare(sql).get()?.n||0),0)}
let synced=0;
for(const [name,id] of ids){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pf-inventory-'));
 try{
  const response=await fetch(edge+'?publisher_id='+encodeURIComponent(id),{headers:{authorization:'Bearer '+identity}});
  if(!response.ok)throw Error('DOWNLOAD_'+response.status);
  const archive=path.join(root,'state.tgz');fs.writeFileSync(archive,Buffer.from(await response.arrayBuffer()));
  const tar=spawnSync('tar',['-xzf',archive,'-C',root],{stdio:'pipe'});
  if(tar.status!==0)throw Error('INVALID_ARCHIVE');
  const file=path.join(root,'publisher-runtime','factory.sqlite');
  if(!fs.existsSync(file))throw Error('SQLITE_NOT_FOUND');
  const db=new DatabaseSync(file,{readOnly:true});
  let payload;
  try{
   const reviews=table(db,'factory_items')?safe(()=>db.prepare("SELECT id,season,episode,status,hook,title,videoPath,reviewVideoId,updatedAt FROM factory_items WHERE status IN ('review','regen_wait','review_pending') ORDER BY season DESC,episode DESC LIMIT 120").all().map(x=>({
    id:x.id,season:x.season,episode:x.episode,status:x.status,
    hook:String(x.hook||'').slice(0,220),title:String(x.title||'').slice(0,220),
    has_media:Boolean(String(x.videoPath||'').trim()),review_video_id_present:Boolean(String(x.reviewVideoId||'').trim()),
    updated_at:x.updatedAt
   })),[]):[];
   const stock=table(db,'publication_items')?safe(()=>db.prepare("SELECT id,episode,status,title,scheduledAt,filePath,videoId FROM publication_items WHERE status NOT IN ('published','cancelled','deleted') ORDER BY scheduledAt,episode LIMIT 120").all().map(x=>({
    id:x.id,episode:x.episode,status:x.status,title:String(x.title||'').slice(0,220),
    scheduled_at:x.scheduledAt,has_media:Boolean(String(x.filePath||'').trim()),
    remote_id_present:Boolean(String(x.videoId||'').trim())
   })),[]):[];
   const meta=table(db,'factory_meta')?safe(()=>db.prepare("SELECT value FROM factory_meta WHERE key='automation:activeSeason'").get()?.value,null):null;
   payload={
    source_updated_at:fs.statSync(file).mtime.toISOString(),
    source_bytes:fs.statSync(archive).size,
    active_season:meta?Number(meta):null,
    review_items:reviews,stock_items:stock,
    counts:{
     review:table(db,'factory_items')?count(db,"SELECT COUNT(*) n FROM factory_items WHERE status='review'"):0,
     draft:table(db,'factory_items')?count(db,"SELECT COUNT(*) n FROM factory_items WHERE status='draft'"):0,
     stock:table(db,'publication_items')?count(db,"SELECT COUNT(*) n FROM publication_items WHERE status NOT IN ('published','cancelled','deleted')"):0,
     published:table(db,'publication_items')?count(db,"SELECT COUNT(*) n FROM publication_items WHERE status='published'"):0,
     generation:table(db,'factory_generations')?count(db,"SELECT COUNT(*) n FROM factory_generations WHERE status IN ('review','completed') AND COALESCE(credits,1)>0"):0
    }
   };
  }finally{db.close()}
  const uploaded=await fetch(edge+'?publisher_id='+encodeURIComponent(id)+'&type=inventory',{method:'POST',headers:{authorization:'Bearer '+identity,'content-type':'application/json'},body:JSON.stringify(payload)});
  if(!uploaded.ok)throw Error('SYNC_'+uploaded.status+':'+(await uploaded.text()).slice(0,200));
  console.log('INVENTORY_SYNC_OK',JSON.stringify({publisher:name,review:payload.counts.review,stock:payload.counts.stock,drafts:payload.counts.draft,bytes:payload.source_bytes}));
  synced++;
 }catch(e){console.error('INVENTORY_SYNC_FAILED',name,String(e?.message||e).slice(0,200))}
 finally{fs.rmSync(root,{recursive:true,force:true})}
}
if(synced!==ids.length)throw Error('INVENTORY_INCOMPLETE:'+synced+'/'+ids.length);
