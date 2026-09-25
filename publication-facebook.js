import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPublicationCopy } from './publication-copy.js';

const now=()=>new Date().toISOString();
const GRAPH_VERSION=String(process.env.META_GRAPH_VERSION||'v26.0').replace(/^\/+|\/+$/g,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function fmtParts(date,tz){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  return Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
}
function dayKey(date,tz){const p=fmtParts(date,tz);return p.year+'-'+p.month+'-'+p.day}
function addDay(s,n=1){const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function zonedLocal(dateStr,timeStr,tz){
  const [y,m,d]=dateStr.split('-').map(Number),[hh,mm]=String(timeStr||'00:00').split(':').map(Number);
  const target=Date.UTC(y,m-1,d,hh,mm,0);let guess=target;
  for(let i=0;i<4;i++){
    const p=fmtParts(new Date(guess),tz),seen=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
    const diff=target-seen;if(Math.abs(diff)<1000)break;guess+=diff;
  }
  return new Date(guess);
}
function postingTimes(config){
  const x=Array.isArray(config.schedule?.posting_times)?config.schedule.posting_times:[];
  const valid=[...new Set(x.map(v=>String(v).trim()).filter(v=>/^\d{2}:\d{2}$/.test(v)))].sort();
  return valid.length?valid:['19:00'];
}
function nextSlot(db,config){
  const tz=config.schedule?.timezone||config.identity?.timezone||'UTC',times=postingTimes(config);
  const used=new Set(db.prepare("SELECT scheduledAt FROM publication_items WHERE status NOT IN ('cancelled','deleted')").all().map(x=>String(x.scheduledAt)));
  let day=dayKey(new Date(),tz);
  for(let di=0;di<730;di++){
    for(const t of times){
      const d=zonedLocal(day,t,tz);
      if(d.getTime()<=Date.now()+5*60*1000)continue;
      const iso=d.toISOString();if(!used.has(iso))return iso;
    }
    day=addDay(day);
  }
  throw new Error('No se encontró un slot futuro para Facebook.');
}
function providerConfig(config){
  return (config.publication?.providers||[]).find(x=>x.type==='facebook')||{};
}
function appendMissingTags(text,tags){
  let out=String(text||'').trim();
  const lower=out.toLowerCase();
  const missing=(tags||[]).filter(t=>!lower.includes(String(t).toLowerCase()));
  if(missing.length)out+=(out?'\n\n':'')+missing.join(' ');
  return out.trim();
}
function metadata(row,config){
  const provider=providerConfig(config);
  const tags=Array.isArray(provider.hashtags)?provider.hashtags:[];
  if(String(row?.title||'').trim()&&String(row?.description||'').trim()){
    return{
      title:String(row.title).slice(0,255),
      description:appendMissingTags(String(row.description).slice(0,62000),tags),
      source:'stored-package'
    };
  }
  const copy=buildPublicationCopy({
    hook:row.hook,story:row.story,prompt:row.prompt,
    contextTerms:[],hashtags:tags,showName:config.identity?.show_name||'',maxTitleLength:100
  });
  return{title:String(copy.title||'').slice(0,255),description:String(copy.description||'').slice(0,62000),source:'derived'};
}
function fbError(json,status){
  const e=json?.error||{};
  const err=new Error(String(e.message||('Facebook Graph HTTP '+status)));
  err.code=Number(e.code||status||0);err.subcode=Number(e.error_subcode||0);err.fb=e;
  return err;
}
function isAuthError(e){
  const code=Number(e?.code||0),msg=String(e?.message||'');
  return code===190
    ||(code===200&&/cannot call api for app .* on behalf of user/i.test(msg))
    ||/oauth|access token|session.*invalid|permissions? error|reconnect facebook|FACEBOOK_RECONNECT_REQUIRED/i.test(msg);
}
function isRateLimit(e){return [4,17,32,613].includes(Number(e?.code))||/rate limit|too many/i.test(String(e?.message||''))}
function canonical(row){
  const s=String(row.status||'').toLowerCase();
  if(s==='published'||String(row.remotePrivacyStatus||'').toLowerCase()==='public')return{key:'public',label:'PÚBLICO',message:'Facebook confirma que el Reel fue enviado a publicación.',resolution:'none',actionRequired:false};
  if(['processing','publishing'].includes(s))return{key:'pending',label:'PENDIENTE',message:'Facebook está procesando el Reel aprobado.',resolution:'automatic',actionRequired:false};
  if(s==='auth_wait')return{key:'pending',label:'RECONECTAR FACEBOOK',message:'La autorización de Facebook venció o dejó de incluir la Página configurada. Reconectá la misma cuenta/Página; el Reel se reanuda automáticamente sin duplicarse.',resolution:'action_required',actionRequired:true};
  if(s==='queued')return{key:'stock',label:'EN STOCK',message:'El video aprobado está guardado en el Publisher y se publicará automáticamente en Facebook a la hora configurada.',resolution:'automatic',actionRequired:false};
  if(s==='error')return{key:'pending',label:'PENDIENTE',message:String(row.error||'Facebook volverá a intentarlo automáticamente.'),resolution:'automatic',actionRequired:false};
  return{key:'pending',label:'PENDIENTE',message:String(row.error||'Esperando el siguiente paso de publicación en Facebook.'),resolution:'automatic',actionRequired:false};
}
function publicItem(row){
  const state=canonical(row);
  return{...row,history:JSON.parse(row.history||'[]'),resumableSession:undefined,filePath:Boolean(row.filePath),canonicalStatus:state.key,canonicalLabel:state.label,canonicalMessage:state.message,canonicalResolution:state.resolution||'automatic',canonicalActionRequired:Boolean(state.actionRequired??safeAction(row))};
}
function safeAction(row){return String(row.status||'')==='auth_wait'}
function hist(row,status,message=''){const h=JSON.parse(row.history||'[]');h.push({status,at:now(),message});row.history=JSON.stringify(h.slice(-120));row.status=status;row.updatedAt=now()}

export function installFacebookPublication({db,config,dataDir,loadFacebookConnection,refreshFacebookConnection=null,isEnabled=()=>true}){
  const dir=path.join(dataDir,'facebook-publication');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  for(const sql of [
    "ALTER TABLE publication_items ADD COLUMN provider TEXT",
    "ALTER TABLE publication_items ADD COLUMN remoteUrl TEXT",
    "ALTER TABLE publication_items ADD COLUMN remotePrivacyStatus TEXT",
    "ALTER TABLE publication_items ADD COLUMN remotePublishAt TEXT",
    "ALTER TABLE publication_items ADD COLUMN remoteStatusCheckedAt TEXT",
    "ALTER TABLE publication_items ADD COLUMN aiDisclosureSyncedAt TEXT"
  ]){try{db.exec(sql)}catch{}}
  let running=false,lastHeartbeat=null,lastError=null;

  function save(row){
    db.prepare(`UPDATE publication_items SET title=?,description=?,scheduledAt=?,uploadAt=?,status=?,filePath=?,fileSize=?,videoId=?,resumableSession=?,playlistId=?,attempts=?,retryAt=?,error=?,history=?,updatedAt=?,provider=?,remoteUrl=?,remotePrivacyStatus=?,remotePublishAt=?,remoteStatusCheckedAt=?,aiDisclosureSyncedAt=? WHERE id=?`)
      .run(row.title,row.description,row.scheduledAt,row.uploadAt,row.status,row.filePath,row.fileSize,row.videoId,row.resumableSession,row.playlistId,row.attempts,row.retryAt,row.error,row.history,row.updatedAt,row.provider||'facebook',row.remoteUrl||null,row.remotePrivacyStatus||null,row.remotePublishAt||null,row.remoteStatusCheckedAt||null,row.aiDisclosureSyncedAt||null,row.id);
  }
  function connection(){
    const c=loadFacebookConnection?.()||{};
    if(!c.page_id||!c.page_access_token)throw new Error('FACEBOOK_AUTH_REQUIRED');
    return c;
  }
  async function graph(pathname,{method='GET',params={},token,body,headers={}}={}){
    const u=new URL('https://graph.facebook.com/'+GRAPH_VERSION+'/'+String(pathname).replace(/^\/+/,'')); 
    for(const [k,v] of Object.entries(params||{}))if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));
    if(token)u.searchParams.set('access_token',token);
    const r=await fetch(u,{method,body,headers,signal:AbortSignal.timeout(90000)});
    const json=await r.json().catch(()=>({}));
    if(!r.ok||json?.error)throw fbError(json,r.status);
    return json;
  }
  async function remoteStatus(item){
    const c=connection();
    if(!item.videoId)return null;
    const j=await graph(item.videoId,{params:{fields:'status,is_ai_generated'},token:c.page_access_token});
    item.remoteStatusCheckedAt=now();
    if(j?.is_ai_generated===true&&!item.aiDisclosureSyncedAt){
      item.aiDisclosureSyncedAt=now();
      hist(item,item.status||'processing','Facebook confirms native AI-generated disclosure is enabled.');
      save(item);
    }
    const st=j?.status||{},publishing=String(st?.publishing_phase?.status||'').toLowerCase(),video=String(st?.video_status||'').toLowerCase();
    if(publishing==='complete'||video==='ready'){
      item.remotePrivacyStatus='public';item.remotePublishAt=item.remotePublishAt||now();item.error=null;item.retryAt=0;
      if(item.status!=='published')hist(item,'published','Facebook Reels API confirms publishing/processing complete.');
      save(item);
      if(item.filePath){try{fs.rmSync(item.filePath,{force:true})}catch{}item.filePath=null;save(item)}
      return'published';
    }
    item.remotePrivacyStatus='processing';item.updatedAt=now();save(item);
    return'processing';
  }
  function enqueue(row){
    if(String(row?.status||'')!=='review')throw new Error('APPROVAL_GATE: only an explicit human-approved review item may enter Facebook publication.');
    const existing=db.prepare('SELECT * FROM publication_items WHERE itemId=?').get(row.id);
    if(existing){
      const sourceMediaTransferred=Boolean(row.videoPath&&existing.filePath&&path.resolve(String(row.videoPath))===path.resolve(String(existing.filePath)));
      return {...publicItem(existing),sourceMediaTransferred};
    }
    const {title,description}=metadata(row,config),scheduledAt=nextSlot(db,config),id=randomUUID();
    if(!row.videoPath||!fs.existsSync(row.videoPath))throw new Error('El MP4 aprobado no está disponible localmente.');
    // ZERO-COPY APPROVAL HANDOFF: Publication takes ownership of the exact
    // Review file. Do not duplicate a multi-megabyte video on the same volume.
    const filePath=String(row.videoPath),fileSize=fs.statSync(filePath).size,sourceMediaTransferred=true;
    const item={id,itemId:row.id,episode:Number(row.episode),title,description,scheduledAt,uploadAt:scheduledAt,status:'queued',filePath,fileSize,videoId:null,resumableSession:null,playlistId:null,attempts:0,retryAt:0,error:null,history:JSON.stringify([{status:'queued',at:now(),message:'Approved for Facebook Reel publication.'}]),createdAt:now(),updatedAt:now(),provider:'facebook',remoteUrl:null,remotePrivacyStatus:null,remotePublishAt:null,remoteStatusCheckedAt:null};
    db.prepare('INSERT INTO publication_items(id,itemId,episode,title,description,scheduledAt,uploadAt,status,filePath,fileSize,videoId,resumableSession,playlistId,attempts,retryAt,error,history,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(item.id,item.itemId,item.episode,item.title,item.description,item.scheduledAt,item.uploadAt,item.status,item.filePath,item.fileSize,item.videoId,item.resumableSession,item.playlistId,item.attempts,item.retryAt,item.error,item.history,item.createdAt,item.updatedAt);
    db.prepare("UPDATE publication_items SET provider='facebook' WHERE id=?").run(item.id);
    return {...publicItem(item),sourceMediaTransferred};
  }
  async function createOrResume(item,c){
    if(item.videoId&&item.resumableSession)return;
    const start=await graph('me/video_reels',{method:'POST',params:{upload_phase:'start'},token:c.page_access_token});
    if(!start.video_id||!start.upload_url)throw new Error('Facebook did not return video_id/upload_url.');
    item.videoId=String(start.video_id);item.resumableSession=String(start.upload_url);item.remotePrivacyStatus='session-created';hist(item,'publishing','Facebook Reel upload session created and persisted for restart-safe delivery.');save(item);
  }
  async function uploadBinary(item,c){
    if(!item.filePath||!fs.existsSync(item.filePath))throw new Error('Approved Reel file is missing.');
    const data=fs.readFileSync(item.filePath),url=String(item.resumableSession||'');
    if(!url)throw new Error('Facebook upload URL missing.');
    const r=await fetch(url,{method:'POST',headers:{Authorization:'OAuth '+c.page_access_token,offset:'0',file_size:String(data.length),'Content-Type':'application/octet-stream'},body:data,signal:AbortSignal.timeout(180000)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||j?.error)throw fbError(j,r.status);
    item.fileSize=data.length;item.remotePrivacyStatus='uploaded';hist(item,'publishing','Facebook received the Reel binary.');save(item);
  }
  async function ensureAiDisclosure(item){
    if(!item?.videoId||item.aiDisclosureSyncedAt)return true;
    const c=connection();
    const current=await graph(item.videoId,{params:{fields:'id,is_ai_generated'},token:c.page_access_token});
    if(current?.is_ai_generated===true){
      item.aiDisclosureSyncedAt=now();
      hist(item,item.status||'published','Facebook AI-generated disclosure verified on the existing Reel.');
      save(item);
      return true;
    }
    // Meta exposes is_ai_generated on the Video object. Retrofit the existing
    // asset in place; never re-upload and never create a duplicate Reel.
    const updated=await graph(item.videoId,{method:'POST',params:{is_ai_generated:true},token:c.page_access_token});
    if(updated?.success===false)throw new Error('FACEBOOK_AI_DISCLOSURE_RETROFIT_NOT_CONFIRMED');
    const verify=await graph(item.videoId,{params:{fields:'id,is_ai_generated'},token:c.page_access_token});
    if(verify?.is_ai_generated!==true)throw new Error('FACEBOOK_AI_DISCLOSURE_RETROFIT_UNVERIFIED');
    item.aiDisclosureSyncedAt=now();
    hist(item,item.status||'published','Facebook native AI-generated disclosure retrofitted and verified on the existing Reel without re-upload.');
    save(item);
    return true;
  }
  async function finish(item,c){
    const provider=providerConfig(config);
    if(provider.contains_synthetic_media!==true||config.publication?.ai_disclosure_required!==true){
      throw new Error('AI_DISCLOSURE_CONTRACT_REQUIRED: Facebook publication is blocked unless native AI disclosure is mandatory.');
    }
    const j=await graph('me/video_reels',{
      method:'POST',
      params:{
        video_id:item.videoId,
        upload_phase:'finish',
        video_state:'PUBLISHED',
        description:item.description||'',
        title:item.title||'',
        is_ai_generated:true
      },
      token:c.page_access_token
    });
    if(j?.success!==true)throw new Error('Facebook did not confirm Reel publish with AI disclosure.');
    item.aiDisclosureSyncedAt=now();
    item.remotePrivacyStatus='processing';item.remotePublishAt=now();
    hist(item,'processing','Facebook accepted the Reel for publishing with native AI-generated disclosure enabled (is_ai_generated=true).');
    save(item);
  }
  async function publish(item){
    let c=connection();
    const run=async()=>{
      // Restart-safe phase machine:
      // session-created -> uploaded -> processing -> published.
      // Never repeat a completed phase merely because the process restarted.
      if(item.videoId&&item.remotePrivacyStatus==='processing'){
        try{await remoteStatus(item)}catch(e){if(isAuthError(e))throw e}
        return;
      }
      await createOrResume(item,c);
      if(item.remotePrivacyStatus!=='uploaded'&&item.remotePrivacyStatus!=='processing'){
        await uploadBinary(item,c);
      }
      if(item.remotePrivacyStatus==='uploaded'){
        await finish(item,c);
      }
      for(let i=0;i<6;i++){
        await sleep(i?2500:900);
        try{const state=await remoteStatus(item);if(state==='published')return}catch(e){if(isAuthError(e))throw e}
      }
    };
    try{
      await run();
    }catch(e){
      if(!isAuthError(e)||typeof refreshFacebookConnection!=='function')throw e;
      // Meta occasionally invalidates a Page token while the long-lived user
      // token remains usable. Repair only the credential for the exact configured
      // Page, persist it, then resume the same phase machine. Completed phases are
      // durable, so this retry cannot duplicate a Reel.
      const repaired=await refreshFacebookConnection();
      if(!repaired?.page_id||!repaired?.page_access_token)throw e;
      c=repaired;
      item.error=null;item.retryAt=0;
      hist(item,'publishing','Facebook Page Access Token refreshed automatically; resuming the same Reel delivery.');
      save(item);
      await run();
    }
  }
  async function purgeRejected(row){
    const items=db.prepare("SELECT * FROM publication_items WHERE itemId=? AND COALESCE(provider,'')='facebook' AND status NOT IN ('published','deleted')").all(String(row?.id||''));
    let remoteDeleted=0;
    for(const item of items){
      if(item.videoId){
        try{
          const c=connection();
          await graph(item.videoId,{method:'DELETE',token:c.page_access_token});remoteDeleted++;
        }catch(e){
          if(!/unsupported|not found|does not exist|100/i.test(String(e?.message||''))&&!isAuthError(e))throw e;
        }
      }
      if(item.filePath)try{fs.rmSync(item.filePath,{force:true})}catch{}
      db.prepare('DELETE FROM publication_items WHERE id=?').run(item.id);
    }
    return{purged:items.length,remoteDeleted};
  }
  async function tick(){
    if(!isEnabled()||running)return;
    running=true;lastHeartbeat=now();lastError=null;
    try{
      const items=db.prepare("SELECT * FROM publication_items WHERE COALESCE(provider,'')='facebook' AND status NOT IN ('cancelled','deleted') AND (status<>'published' OR aiDisclosureSyncedAt IS NULL) ORDER BY scheduledAt").all();
      for(const item of items){
        if(Number(item.retryAt||0)>Date.now())continue;
        try{
          if(item.videoId&&!item.aiDisclosureSyncedAt){
            await ensureAiDisclosure(item);
          }
          if(String(item.status||'')==='published')continue;
          if(Date.now()<Date.parse(item.scheduledAt))continue;
          await publish(item);
          item.attempts=0;item.retryAt=0;item.error=null;save(item);
        }catch(e){
          const raw=String(e?.message||e),auth=isAuthError(e),rate=isRateLimit(e),wasPublished=String(item.status||'')==='published'||String(item.remotePrivacyStatus||'')==='public';
          item.attempts=Number(item.attempts||0)+1;
          if(wasPublished){
            // Never downgrade or republish an already-public Reel just because a
            // post-publication AI-disclosure retrofit is temporarily unavailable.
            item.error='AI disclosure repair pending: '+raw;
            item.retryAt=Date.now()+(rate?30*60*1000:Math.min(60*60*1000,60000*Math.pow(2,Math.min(item.attempts,6))));
            hist(item,'published',item.error);
            save(item);
            continue;
          }
          item.error=raw;
          if(raw==='FACEBOOK_AUTH_REQUIRED'||auth){item.status='auth_wait';item.retryAt=0}
          else{item.status='error';item.retryAt=Date.now()+(rate?30*60*1000:Math.min(60*60*1000,60000*Math.pow(2,Math.min(item.attempts,6))))}
          hist(item,item.status,raw);save(item);
        }
      }
    }catch(e){lastError=String(e?.message||e)}
    finally{lastHeartbeat=now();running=false}
  }
  function resumeAuthWait(){
    const stamp=now();
    const rows=db.prepare("SELECT * FROM publication_items WHERE COALESCE(provider,'')='facebook' AND status IN ('auth_wait','error') AND status NOT IN ('published','cancelled','deleted') ORDER BY scheduledAt").all();
    for(const item of rows){
      item.status='queued';item.error=null;item.retryAt=0;
      if(Date.parse(String(item.scheduledAt||''))<=Date.now())item.scheduledAt=stamp;
      item.uploadAt=item.scheduledAt;
      hist(item,'queued','Facebook authorization refreshed; publication retry armed immediately.');
      save(item);
    }
    if(rows.length)setTimeout(()=>void tick(),250).unref?.();
    return rows.length;
  }
  const timer=setInterval(()=>void tick(),30000);timer.unref?.();
  setTimeout(()=>void tick(),1200).unref?.();
  return{
    enqueue,purgeRejected,tick,resumeAuthWait,ensureAiDisclosure,
    items:()=>db.prepare("SELECT * FROM publication_items WHERE COALESCE(provider,'')='facebook' ORDER BY scheduledAt").all().map(publicItem),
    status:()=>({alive:true,running,lastHeartbeat,lastError,indefinite:true,provider:'facebook',graphVersion:GRAPH_VERSION}),
    close:()=>clearInterval(timer)
  };
}
