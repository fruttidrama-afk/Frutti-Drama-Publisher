
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isReviewStorageUri, readReviewRange, deleteReviewObject, uploadReviewFile, reviewStorageConfigured, reviewStorageRequired } from './review-storage.js';
import { buildPublicationCopy } from './publication-copy.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const now=()=>new Date().toISOString();
const utf8=v=>Buffer.byteLength(String(v||''),'utf8');

function fmtParts(date,tz){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  return Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
}
function dayKey(date,tz){const p=fmtParts(date,tz);return p.year+'-'+p.month+'-'+p.day}
function addDay(s,n=1){const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function zonedLocal(dateStr,timeStr,tz){
  const [y,m,d]=dateStr.split('-').map(Number),[hh,mm]=String(timeStr||'00:00').split(':').map(Number);
  const target=Date.UTC(y,m-1,d,hh,mm,0);let guess=target;
  for(let i=0;i<4;i++){const p=fmtParts(new Date(guess),tz),seen=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));const diff=target-seen;if(Math.abs(diff)<1000)break;guess+=diff}
  return new Date(guess);
}
function postingTimes(config){
  const x=Array.isArray(config.schedule?.posting_times)?config.schedule.posting_times:[];
  return [...new Set(x.map(v=>String(v).trim()).filter(v=>/^\d{2}:\d{2}$/.test(v)))].sort().length?[...new Set(x.map(v=>String(v).trim()).filter(v=>/^\d{2}:\d{2}$/.test(v)))].sort():['19:00'];
}
function nextSlot(db,config){
  const tz=config.schedule.timezone,times=postingTimes(config),used=new Set(db.prepare("SELECT scheduledAt FROM publication_items WHERE status NOT IN ('cancelled','deleted')").all().map(x=>String(x.scheduledAt)));
  let day=dayKey(new Date(),tz);
  for(let di=0;di<730;di++){for(const t of times){const d=zonedLocal(day,t,tz);if(d.getTime()<=Date.now()+5*60*1000)continue;const iso=d.toISOString();if(!used.has(iso))return iso}day=addDay(day)}
  throw new Error('No se encontró un slot de publicación futuro.');
}
function isEarthIn10(config){return /earth\s*in\s*10/i.test(String(config?.identity?.show_name||''))}
function earthPromptIsEpisodeBound(row){
  const prompt=String(row?.prompt||'');
  const m=prompt.match(/EPISODE INTENT:\s*([^\n]+)/i);
  const intent=String(m?.[1]||row?.story||'').trim();
  if(!intent)return false;
  if(/Continue the configured Creative Bible and canon from the previous accepted beat/i.test(intent))return false;
  // A legacy generic hook must not veto a concrete generation prompt/story.
  // The content actually submitted to Flow is authoritative for publication copy.
  return true;
}
function creativePackageDigest(row,title,description){
  return createHash('sha256').update(JSON.stringify({
    episode:Number(row?.episode||0),
    hook:String(row?.hook||''),
    story:String(row?.story||''),
    prompt:String(row?.prompt||''),
    title:String(title||''),
    description:String(description||'')
  })).digest('hex');
}
function legacyEarthPublicationRepair(row,item,config,episode1Title=''){
  if(!isEarthIn10(config)||Number(item?.episode)!==2)return null;
  const duplicatedPatagonia=/PATAGONIA SUNRISE/i.test(String(row?.title||item?.title||''))&&/PATAGONIA SUNRISE/i.test(String(episode1Title||''));
  if(!duplicatedPatagonia)return null;
  return{
    title:'NAMIB DESERT: A solitary tree beneath glowing red dunes. #Shorts #ViralShorts',
    description:'A solitary dark tree stands against Namibia’s immense red-orange dunes as warm sunrise light stretches across the desert.\n\nEARTH IN 10\n\n#EarthIn10 #Nature #Travel #Shorts #ViralShorts',
    source:'historical-prompt-copy-audit'
  };
}
function metadata(row,config){
  const provider=(config.publication?.providers||[]).find(x=>x.type==='youtube')||{};
  // For Earth in Ten, the exact episode generation prompt is the source of truth.
  // Legacy generic-prompt rows keep their explicit reviewed copy, but every concrete
  // episode prompt is re-derived so stale copy from another episode cannot survive.
  const promptAuthoritative=isEarthIn10(config)&&earthPromptIsEpisodeBound(row);
  if(!promptAuthoritative&&String(row?.title||'').trim()&&String(row?.description||'').trim()){
    let description=String(row.description);
    while(utf8(description)>4800)description=description.slice(0,-20).trimEnd();
    return{title:String(row.title).slice(0,100),description,source:'stored-package'};
  }
  const copy=buildPublicationCopy({
    hook:row.hook,
    story:row.story,
    prompt:row.prompt,
    contextTerms:[],
    hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
    showName:config.identity.show_name,
    maxTitleLength:100
  });
  let description=copy.description;
  while(utf8(description)>4800)description=description.slice(0,-20).trimEnd();
  return{title:copy.title,description,source:promptAuthoritative?'episode-generation-prompt':'derived-fallback'};
}

function canonicalPublicationState(r){
  const s=String(r?.status||'').toLowerCase(),remote=String(r?.remotePrivacyStatus||'').toLowerCase(),hasVideo=Boolean(r?.videoId);
  const platform=String(r?.provider||'youtube').toLowerCase()==='facebook'?'Facebook':'YouTube';
  if(remote==='public'||s==='published')return{
    key:'public',label:'PÚBLICO',
    message:platform+' confirma que este video ya está público.',
    resolution:'none',actionRequired:false
  };
  if(hasVideo&&(remote==='private'||['uploaded','scheduled','quota_wait'].includes(s)))return{
    key:'private',label:'PRIVADO',
    message:s==='quota_wait'
      ?'El video ya está en '+platform+' y sigue privado. El sistema volverá a sincronizarlo automáticamente.'
      :'El video ya está en '+platform+' y permanece privado hasta la hora de publicación.',
    resolution:s==='quota_wait'?'automatic':'none',actionRequired:false
  };
  if(!hasVideo&&s==='queued')return{
    key:'stock',label:'EN STOCK',
    message:'El video está guardado en el Publisher y todavía no fue enviado a '+platform+'.',
    resolution:'automatic',actionRequired:false
  };
  if(!hasVideo&&s==='quota_wait')return{
    key:'pending',label:'PENDIENTE',
    message:'Todavía no se pudo enviar a '+platform+'. Se reintentará automáticamente.',
    resolution:'automatic',actionRequired:false
  };
  if(s==='backup_hold')return{
    key:'pending',label:'RESCATE REQUERIDO',
    message:String(r?.error||'No existe una copia segura fuera de la plataforma. El video queda bloqueado hasta recuperar un respaldo cloud.'),
    resolution:'action_required',actionRequired:true
  };
  if(['uploading','publishing','processing'].includes(s))return{
    key:'pending',label:'PENDIENTE',
    message:platform+' está procesando este video. No requiere intervención.',
    resolution:'automatic',actionRequired:false
  };
  if(s==='auth_wait')return{
    key:'pending',label:'ERROR',
    message:platform+' necesita reconexión antes de continuar.',
    resolution:'action_required',actionRequired:true
  };
  if(s==='attention')return{
    key:'pending',label:'ERROR',
    message:String(r?.error||'La publicación necesita revisión manual antes de continuar.'),
    resolution:'action_required',actionRequired:true
  };
  if(s==='error'){
    const automatic=Number(r?.retryAt||0)>Date.now();
    return{
      key:'pending',label:automatic?'PENDIENTE':'ERROR',
      message:String(r?.error||(automatic?'Hubo un error transitorio y el sistema volverá a intentarlo.':'La publicación requiere intervención.')),
      resolution:automatic?'automatic':'action_required',actionRequired:!automatic
    };
  }
  return{
    key:'pending',label:'PENDIENTE',
    message:String(r?.error||'El video está esperando el siguiente paso del proceso.'),
    resolution:'automatic',actionRequired:false
  };
}
function publicItem(r){
  const state=canonicalPublicationState(r);
  return{
    ...r,
    history:JSON.parse(r.history||'[]'),
    resumableSession:undefined,
    filePath:Boolean(r.filePath),
    stockVideoUrl:r.filePath&&!r.videoId?('/publication/'+encodeURIComponent(r.id)+'/video'):null,
    canonicalStatus:state.key,
    canonicalLabel:state.label,
    canonicalMessage:state.message,
    canonicalResolution:state.resolution,
    canonicalActionRequired:state.actionRequired
  };
}
function hist(row,status,message=''){const h=JSON.parse(row.history||'[]');h.push({status,at:now(),message});row.history=JSON.stringify(h.slice(-120));row.status=status;row.updatedAt=now()}
function save(db,row){db.prepare(`UPDATE publication_items SET title=?,description=?,scheduledAt=?,uploadAt=?,status=?,filePath=?,fileSize=?,videoId=?,resumableSession=?,playlistId=?,attempts=?,retryAt=?,error=?,history=?,updatedAt=?,aiDisclosureSyncedAt=?,remotePrivacyStatus=?,remotePublishAt=?,remoteStatusCheckedAt=? WHERE id=?`).run(row.title,row.description,row.scheduledAt,row.uploadAt,row.status,row.filePath,row.fileSize,row.videoId,row.resumableSession,row.playlistId,row.attempts,row.retryAt,row.error,row.history,row.updatedAt,row.aiDisclosureSyncedAt||null,row.remotePrivacyStatus||null,row.remotePublishAt||null,row.remoteStatusCheckedAt||null,row.id)}

export function installPublication({app,db,config,youtubeApi,authedClient,loadToken,dataDir,isEnabled=()=>true}){
  const publicationDir=path.join(dataDir,'publication');fs.mkdirSync(publicationDir,{recursive:true,mode:0o700});
  for(const sql of [
    "ALTER TABLE publication_items ADD COLUMN aiDisclosureSyncedAt TEXT",
    "ALTER TABLE publication_items ADD COLUMN remotePrivacyStatus TEXT",
    "ALTER TABLE publication_items ADD COLUMN remotePublishAt TEXT",
    "ALTER TABLE publication_items ADD COLUMN remoteStatusCheckedAt TEXT",
    "ALTER TABLE publication_items ADD COLUMN provider TEXT"
  ]){try{db.exec(sql)}catch{}}
  const remotePollNext=new Map(),aiDisclosureNext=new Map();
  let connectedChannelId=null;
  let running=false,lastError=null,lastHeartbeat=null;

  function enqueue(row){
    if(String(row?.status||'')!=='review')throw new Error('APPROVAL_GATE: only an explicit human-approved review item may enter publication.');
    const existing=db.prepare('SELECT * FROM publication_items WHERE itemId=?').get(row.id);
    if(existing){
      const sourceMediaTransferred=Boolean(row.videoPath&&existing.filePath&&!isReviewStorageUri(existing.filePath)&&path.resolve(String(row.videoPath))===path.resolve(String(existing.filePath)));
      return {...publicItem(existing),sourceMediaTransferred};
    }
    const {title,description}=metadata(row,config),scheduledAt=nextSlot(db,config),uploadAt=new Date(Date.parse(scheduledAt)-390*60000).toISOString(),id=randomUUID();
    let filePath=null,fileSize=0,videoId=row.reviewVideoId||null;
    let sourceMediaTransferred=false;
    if(!videoId){
      if(isReviewStorageUri(row.remoteUrl)){
        filePath=String(row.remoteUrl);
        fileSize=Number(row.reviewOriginalSize||0)||Number((()=>{try{return JSON.parse(row.flowResult||'{}')?.size||0}catch{return 0}})());
        if(!fileSize)throw new Error('El MP4 aprobado en cloud storage no tiene tamaño verificable.');
      }else{
        if(!row.videoPath||!fs.existsSync(row.videoPath))throw new Error('El MP4 aprobado no está disponible.');
        // ZERO-COPY APPROVAL HANDOFF: the Review file already lives on the
        // persistent /data volume. Approval transfers ownership of that exact
        // file to Publication instead of duplicating bytes into /publication.
        // This makes approval safe even when the persistent volume is nearly full.
        filePath=String(row.videoPath);
        fileSize=fs.statSync(filePath).size;
        sourceMediaTransferred=true;
      }
    }else fileSize=Number(row.reviewOriginalSize||0);
    const item={id,itemId:row.id,episode:Number(row.episode),title,description,scheduledAt,uploadAt,status:'queued',filePath,fileSize,videoId,resumableSession:null,playlistId:null,attempts:0,retryAt:0,error:null,history:JSON.stringify([{status:'queued',at:now(),message:'Approved for publication.'}]),createdAt:now(),updatedAt:now()};
    db.prepare('INSERT INTO publication_items(id,itemId,episode,title,description,scheduledAt,uploadAt,status,filePath,fileSize,videoId,resumableSession,playlistId,attempts,retryAt,error,history,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(item.id,item.itemId,item.episode,item.title,item.description,item.scheduledAt,item.uploadAt,item.status,item.filePath,item.fileSize,item.videoId,item.resumableSession,item.playlistId,item.attempts,item.retryAt,item.error,item.history,item.createdAt,item.updatedAt);
    db.prepare("UPDATE publication_items SET provider='youtube' WHERE id=?").run(item.id);
    item.provider='youtube';
    return {...publicItem(item),sourceMediaTransferred};
  }

  async function request(url,options={}){
    const client=authedClient(),token=await client.getAccessToken(),access=String(token?.token||token||'');
    if(!access)throw new Error('YouTube OAuth access token unavailable.');
    return await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(90000),headers:{...(options.headers||{}),Authorization:'Bearer '+access}});
  }
  async function connectedChannel(){
    if(connectedChannelId)return connectedChannelId;
    const yt=youtubeApi(),id=(await yt.channels.list({part:['id'],mine:true})).data.items?.[0]?.id;
    if(!id)throw new Error('Connected YouTube channel could not be resolved.');
    connectedChannelId=String(id);return connectedChannelId;
  }
  async function cleanupPublicationMedia(item){
    if(!item.filePath)return;
    if(isReviewStorageUri(item.filePath)){try{await deleteReviewObject(item.filePath)}catch{}}
    else try{fs.rmSync(item.filePath,{force:true})}catch{}
    item.filePath=null;save(db,item);
  }
  async function applyRemoteStatus(item,v,source='YouTube API'){
    if(!v)throw new Error('YouTube video not found.');
    const st=v.status||{},privacy=String(st.privacyStatus||''),uploadStatus=String(st.uploadStatus||'');
    if(['failed','rejected','deleted'].includes(uploadStatus))throw new Error('YouTube rejected the video.');
    item.remotePrivacyStatus=privacy||null;
    item.remotePublishAt=st.publishAt||null;
    item.remoteStatusCheckedAt=now();
    if(privacy==='public'){
      if(String(item.status)!=='published')hist(item,'published',source+' confirms PUBLIC.');
      else item.updatedAt=now();
      item.error=null;item.retryAt=0;save(db,item);
      console.log('[PUBLICATION REMOTE STATE]',JSON.stringify({episode:item.episode,videoId:item.videoId,state:'published',source,scheduledAt:item.scheduledAt}));
      await cleanupPublicationMedia(item);
      return'published';
    }
    if(privacy==='private'&&st.publishAt){
      item.remotePublishAt=st.publishAt;
      if(String(item.status)!=='uploaded')hist(item,'uploaded',source+' found forbidden legacy publishAt; runtime will remove it and keep the video plain PRIVATE until the release-time edit.');
      else item.updatedAt=now();
      item.error=null;item.retryAt=0;save(db,item);
      console.log('[PUBLICATION FORBIDDEN PUBLISH_AT DETECTED]',JSON.stringify({episode:item.episode,videoId:item.videoId,publishAt:st.publishAt,scheduledAt:item.scheduledAt,source}));
      return'uploaded';
    }
    if(privacy==='private'){
      if(String(item.status)!=='uploaded')hist(item,'uploaded',source+' confirms PRIVATE; scheduling is not yet confirmed.');
      else item.updatedAt=now();
      item.error=null;save(db,item);
      return'uploaded';
    }
    throw new Error('Unexpected YouTube privacy status: '+(privacy||'missing'));
  }
  async function readRemoteStatus(item){
    const yt=youtubeApi(),v=(await yt.videos.list({part:['status','snippet'],id:[item.videoId]})).data.items?.[0];
    return await applyRemoteStatus(item,v,'YouTube API');
  }
  async function publicPageFallback(item){
    if(!item?.videoId)return false;
    try{
      const publicUrl='https://www.youtube.com/watch?v='+encodeURIComponent(item.videoId);
      const [o,w]=await Promise.all([
        fetch('https://www.youtube.com/oembed?format=json&url='+encodeURIComponent(publicUrl),{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0'}}).catch(()=>null),
        fetch(publicUrl+'&hl=en&bpctr=9999999999',{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'Mozilla/5.0'}}).catch(()=>null)
      ]);
      const oembed=o&&o.ok?await o.json().catch(()=>null):null;
      const body=w&&w.ok?await w.text().catch(()=>''):'';
      const unlisted=/isUnlisted(?:\\?["']|&quot;)\s*[:=]\s*true/i.test(body)||/"isUnlisted"\s*:\s*true/i.test(body);
      const privateMarker=/LOGIN_REQUIRED|Private video|This video is private|"isPrivate"\s*:\s*true/i.test(body);
      const unavailable=/Video unavailable|UNPLAYABLE|ERROR/i.test(body)&&!oembed;
      const title=String(oembed?.title||'').trim();
      console.log('[PUBLICATION PUBLIC FALLBACK CHECK]',JSON.stringify({episode:item.episode,videoId:item.videoId,oembedStatus:o?.status||0,watchStatus:w?.status||0,title:title.slice(0,120),unlisted,privateMarker,unavailable}));
      if(!oembed||!title||unlisted||privateMarker||unavailable)return false;
      item.remotePrivacyStatus='public';
      item.remoteStatusCheckedAt=now();
      if(String(item.status)!=='published')hist(item,'published','YouTube public oEmbed/watch page confirms the video is publicly reachable while Data API quota is unavailable.');
      item.error=null;item.retryAt=0;save(db,item);
      console.log('[PUBLICATION PUBLIC FALLBACK]',JSON.stringify({episode:item.episode,videoId:item.videoId,state:'published',evidence:'oembed+watch-public'}));
      await cleanupPublicationMedia(item);
      return true;
    }catch(e){
      console.log('[PUBLICATION PUBLIC FALLBACK ERROR]',JSON.stringify({episode:item.episode,videoId:item.videoId,error:String(e?.message||e).slice(0,300)}));
      return false;
    }
  }

  async function stageMetadata(item){
    if(!item.videoId)return null;
    const yt=youtubeApi(),channel=await connectedChannel();
    const v=(await yt.videos.list({part:['snippet','status'],id:[item.videoId]})).data.items?.[0];
    if(!v||v.snippet?.channelId!==channel)throw new Error('El video de staging no pertenece al canal conectado.');
    if(v.status?.privacyStatus==='public')return await applyRemoteStatus(item,v,'YouTube API');
    if(v.status?.privacyStatus!=='private')throw new Error('YouTube returned an unexpected staging privacy state.');
    const remotePublishAt=v.status?.publishAt?new Date(v.status.publishAt).toISOString():null;
    const copyDiff=String(v.snippet?.title||'')!==String(item.title||'')||String(v.snippet?.description||'')!==String(item.description||'');
    const mustUnschedule=Boolean(remotePublishAt);
    if(!copyDiff&&!mustUnschedule){
      item.remotePrivacyStatus='private';item.remotePublishAt=null;item.remoteStatusCheckedAt=now();
      if(String(item.status)!=='uploaded')hist(item,'uploaded','YouTube confirms plain PRIVATE staging with final metadata; no publishAt is set.');
      else item.updatedAt=now();
      item.error=null;save(db,item);
      return'uploaded';
    }
    const updated=(await yt.videos.update({part:['snippet','status'],requestBody:{
      id:item.videoId,
      snippet:{title:item.title,description:item.description,categoryId:v.snippet?.categoryId||'24',tags:[...(v.snippet?.tags||[]).filter(x=>!String(x).startsWith('publisher-runtime-')),'publisher-runtime-'+item.id]},
      status:{privacyStatus, selfDeclaredMadeForKids:false,containsSyntheticMedia:true}
    }})).data;
    item.aiDisclosureSyncedAt=now();
    item.remotePublishAt=null;
    item.history=JSON.stringify([...(JSON.parse(item.history||'[]')),{status:'uploaded',at:now(),message:mustUnschedule?'Old YouTube publishAt removed. Video remains plain PRIVATE until the runtime flips it PUBLIC at release time.':'Final metadata confirmed while video remains plain PRIVATE until release time.'}].slice(-120));
    item.status='uploaded';item.updatedAt=now();item.error=null;item.retryAt=0;save(db,item);
    return await applyRemoteStatus(item,updated||{status:{privacyStatus:'private'}},'YouTube private staging update');
  }

  async function ensureAiDisclosure(item){
    if(!item?.videoId||item.aiDisclosureSyncedAt)return;
    const yt=youtubeApi(),current=(await yt.videos.list({part:['status'],id:[item.videoId]})).data.items?.[0];
    if(!current)throw new Error('YouTube video not found for AI disclosure.');
    const st=current.status||{};
    const next={
      privacyStatus:st.privacyStatus||'private',
      license:st.license||'youtube',
      embeddable:st.embeddable!==false,
      publicStatsViewable:st.publicStatsViewable!==false,
      selfDeclaredMadeForKids:st.selfDeclaredMadeForKids===true,
      containsSyntheticMedia:true
    };
    await yt.videos.update({part:['status'],requestBody:{id:item.videoId,status:next}});
    item.aiDisclosureSyncedAt=now();
    hist(item,item.status||'uploaded','YouTube AI/synthetic-content disclosure enabled and persisted.');
    save(db,item);
  }

  async function auditExistingMetadata(){
    const items=db.prepare("SELECT * FROM publication_items WHERE COALESCE(provider,'youtube')='youtube' AND status NOT IN ('cancelled','deleted') ORDER BY episode").all();
    const episode1Title=String(items.find(x=>Number(x.episode)===1)?.title||'');
    // One-time repair for the live Earth in Ten queue after the old quota handler
    // moved LOCAL dates for videos that already existed on YouTube. The exact E1
    // public page was independently verified live; the operator also confirmed E2
    // is already scheduled in YouTube. Remote API reconciliation remains authoritative
    // and will correct these fields again after quota resets if YouTube differs.
    if(isEarthIn10(config)){
      const verified=[
        {episode:1,videoId:'b8t40dWR8Wo',state:'published',date:'2026-09-22',privacy:'public',evidence:'live-public-page-verified'},
        {episode:2,videoId:'ENNYHWE65WE',state:'scheduled',date:'2026-09-23',privacy:'private',evidence:'operator-confirmed-youtube-schedule'}
      ];
      for(const v of verified){
        const item=items.find(x=>Number(x.episode)===v.episode&&String(x.videoId||'')===v.videoId);
        if(!item)continue;
        const scheduledAt=zonedLocal(v.date,'19:00',config.schedule.timezone).toISOString();
        const needs=String(item.status)!==v.state||String(item.scheduledAt)!==scheduledAt||String(item.remotePrivacyStatus||'')!==v.privacy;
        if(needs){
          item.scheduledAt=scheduledAt;
          item.remotePrivacyStatus=v.privacy;
          item.remotePublishAt=v.state==='scheduled'?scheduledAt:null;
          item.remoteStatusCheckedAt=now();
          item.error=null;item.retryAt=0;
          hist(item,v.state,'Repaired stale local Publishing state after quota-induced schedule drift; evidence='+v.evidence+'. YouTube remains authoritative after quota reset.');
          save(db,item);
          console.log('[PUBLICATION LEGACY STATE REPAIRED]',JSON.stringify({episode:item.episode,videoId:item.videoId,status:item.status,scheduledAt:item.scheduledAt,evidence:v.evidence}));
        }
      }
    }
    let corrected=0,factoryCorrected=0,synced=0,quotaRetryAt=0;const report=[];
    for(const item of items){
      const row=db.prepare('SELECT episode,hook,story,prompt,title,description,creativePackageHash,creativePackageId,flowResult FROM factory_items WHERE id=?').get(item.itemId);
      if(!row)continue;
      const legacyRepair=legacyEarthPublicationRepair(row,item,config,episode1Title);
      const copy=legacyRepair||metadata(row,config),description=copy.description;
      const promptAuthoritative=isEarthIn10(config)&&earthPromptIsEpisodeBound(row);
      const repairFactory=Boolean(legacyRepair)||promptAuthoritative;
      let factoryChanged=false;
      if(repairFactory){
        const packageHash=creativePackageDigest(row,copy.title,description);
        factoryChanged=row.title!==copy.title||row.description!==description||String(row.creativePackageHash||'')!==packageHash;
        if(factoryChanged){
          let flowResult=String(row.flowResult||'');
          if(legacyRepair){
            let flow={};try{flow=JSON.parse(flowResult||'{}')||{}}catch{}
            flow.publication_override={
              title:copy.title,description,
              reason:'legacy-e2-namib-metadata-regression-repair',
              source:'historical-publication-copy-audit'
            };
            flowResult=JSON.stringify(flow);
          }
          db.prepare("UPDATE factory_items SET title=?,description=?,creativePackageHash=?,creativePackageId=COALESCE(creativePackageId,?),flowResult=?,updatedAt=? WHERE id=?")
            .run(copy.title,description,packageHash,'creative-package-repaired-'+randomUUID(),flowResult,now(),item.itemId);
          factoryCorrected++;
        }
      }
      const changed=item.title!==copy.title||item.description!==description;
      report.push({episode:item.episode,title:copy.title,changed,factory_changed:factoryChanged,source:copy.source});
      if(changed){
        item.title=copy.title;item.description=description;
        hist(item,item.status,legacyRepair?'Legacy E2 metadata restored from its historical prompt-copy audit.':'Publication metadata synchronized from this episode generation prompt.');
        save(db,item);corrected++;
      }
      const storedQuotaError=String(item.status||'')==='error'&&/quota/i.test(String(item.error||''));
      if(storedQuotaError){
        item.retryAt=nextYoutubeQuotaRetry();quotaRetryAt=Math.max(quotaRetryAt,item.retryAt);
        item.error='YouTube daily API quota exhausted. Automatic retry is scheduled after the quota reset.';
        hist(item,'quota_wait',item.error);save(db,item);
      }
      // Only sync YouTube immediately when copy actually changed. Routine publication
      // scheduling remains in tick(), avoiding needless API calls against daily quota.
      if(changed&&item.videoId&&loadToken()&&!['published','cancelled','deleted'].includes(String(item.status||''))){
        try{await stageMetadata(item);synced++}catch{}
      }
    }
    if(quotaRetryAt)shiftPendingQueueAfter(quotaRetryAt);
    if(report.length)console.log('[PUBLICATION COPY AUDIT]',JSON.stringify({corrected,factoryCorrected,synced,quotaNormalized:Boolean(quotaRetryAt),items:report}));
  }

  async function upload(item,privacyStatus='private'){
    if(item.videoId)return;
    if(!item.filePath)throw new Error('Archivo de publicación ausente.');
    const cloudSource=isReviewStorageUri(item.filePath);
    if(!cloudSource&&!fs.existsSync(item.filePath))throw new Error('Archivo de publicación ausente.');
    if(!item.resumableSession){
      const r=await request('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Content-Length':String(item.fileSize),'X-Upload-Content-Type':'video/mp4'},body:JSON.stringify({snippet:{title:item.title,description:item.description,categoryId:'24',tags:['publisher-runtime-'+item.id]},status:{privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true}})});
      if(!r.ok)throw new Error('YouTube resumable init failed ('+r.status+').');
      const session=r.headers.get('location');if(!session||new URL(session).hostname!=='www.googleapis.com')throw new Error('YouTube returned an invalid resumable session.');
      item.resumableSession=session;hist(item,'uploading','Resumable session persisted before bytes.');save(db,item);
    }
    let r=await request(item.resumableSession,{method:'PUT',headers:{'Content-Length':'0','Content-Range':'bytes */'+item.fileSize}});
    while(true){
      if(r.ok){const j=await r.json();if(!j.id)throw new Error('YouTube did not return videoId.');item.videoId=j.id;item.resumableSession=null;item.aiDisclosureSyncedAt=now();if(j.status)await applyRemoteStatus(item,j,'YouTube upload response');else{hist(item,'uploaded','Upload complete.');save(db,item)}return}
      if([404,410].includes(r.status))throw new Error('UPLOAD_SESSION_AMBIGUOUS');
      if(r.status!==308)throw new Error('Upload interrupted ('+r.status+').');
      const range=r.headers.get('range'),offset=range?Number(range.match(/-(\d+)$/)?.[1])+1:0;
      if(!Number.isSafeInteger(offset)||offset>=item.fileSize)throw new Error('Invalid resumable progress.');
      const end=Math.min(offset+8*1024*1024,item.fileSize);
      let buf;
      if(cloudSource)buf=await readReviewRange(item.filePath,offset,end-1);
      else{
        buf=Buffer.alloc(end-offset);const fd=fs.openSync(item.filePath,'r');
        try{const n=fs.readSync(fd,buf,0,buf.length,offset);if(n!==buf.length)throw new Error('Incomplete local media.')}finally{fs.closeSync(fd)}
      }
      r=await request(item.resumableSession,{method:'PUT',headers:{'Content-Type':'video/mp4','Content-Length':String(buf.length),'Content-Range':'bytes '+offset+'-'+(end-1)+'/'+item.fileSize},body:buf});
    }
  }

  async function publishNowLikeManual(item){
    if(!item?.videoId)throw new Error('No hay videoId para publicar.');
    const yt=youtubeApi(),channel=await connectedChannel();
    const v=(await yt.videos.list({part:['snippet','status'],id:[item.videoId]})).data.items?.[0];
    if(!v||v.snippet?.channelId!==channel)throw new Error('El video no pertenece al canal conectado.');
    if(v.status?.privacyStatus==='public')return await applyRemoteStatus(item,v,'YouTube API');
    if(v.status?.privacyStatus!=='private')throw new Error('El video dejó de estar privado antes de su hora de publicación.');
    const st=v.status||{};
    const next={
      privacyStatus:'public',
      license:st.license||'youtube',
      embeddable:st.embeddable!==false,
      publicStatsViewable:st.publicStatsViewable!==false,
      selfDeclaredMadeForKids:st.selfDeclaredMadeForKids===true,
      containsSyntheticMedia:true
    };
    const updated=(await yt.videos.update({part:['status'],requestBody:{id:item.videoId,status:next}})).data;
    item.aiDisclosureSyncedAt=now();
    item.remotePublishAt=null;
    hist(item,item.status||'uploaded','Release executed as a direct PRIVATE → PUBLIC transition at the configured posting time; no prior publishAt schedule.');
    save(db,item);
    return await applyRemoteStatus(item,updated||{status:{privacyStatus:'public'}},'YouTube direct release');
  }

  async function verify(item){
    return await readRemoteStatus(item);
  }

  async function reconcileAmbiguous(item){
    if(!item.resumableSession)return false;
    const r=await request(item.resumableSession,{method:'PUT',headers:{'Content-Length':'0','Content-Range':'bytes */'+item.fileSize}});
    if(r.ok){const j=await r.json();if(j.id){item.videoId=j.id;item.resumableSession=null;hist(item,'uploaded','Recovered completed ambiguous resumable upload.');save(db,item);return true}}
    if(r.status===308)return false;
    item.status='attention';item.error='Resumable session expired ambiguously. Reconcile YouTube before any new upload.';save(db,item);return true;
  }

  function isQuotaExceeded(e){
    const status=Number(e?.response?.status||e?.status||0);
    const reasons=[
      ...(Array.isArray(e?.response?.data?.error?.errors)?e.response.data.error.errors.map(x=>x?.reason):[]),
      e?.response?.data?.error?.status,
      e?.code
    ].filter(Boolean).join(' ');
    const msg=String(e?.message||e||'');
    return status===403&&/quota|quotaExceeded|dailyLimitExceeded/i.test(reasons+' '+msg);
  }
  function nextYoutubeQuotaRetry(){
    const tz='America/Los_Angeles',today=dayKey(new Date(),tz),tomorrow=addDay(today,1);
    return zonedLocal(tomorrow,'00:05',tz).getTime();
  }
  function nextFreeSlotAfter(afterMs,used){
    const tz=config.schedule.timezone,times=postingTimes(config);let day=dayKey(new Date(afterMs),tz);
    for(let di=0;di<730;di++){
      for(const t of times){
        const d=zonedLocal(day,t,tz),iso=d.toISOString();
        if(d.getTime()<=afterMs+5*60*1000||used.has(iso))continue;
        return iso;
      }
      day=addDay(day);
    }
    throw new Error('No se encontró un slot de publicación posterior a la recuperación de cuota.');
  }
  function shiftPendingQueueAfter(afterMs){
    const pending=db.prepare("SELECT * FROM publication_items WHERE COALESCE(provider,'youtube')='youtube' AND videoId IS NULL AND status NOT IN ('published','scheduled','cancelled','deleted') ORDER BY episode,scheduledAt").all();
    if(!pending.length)return[];
    const pendingIds=new Set(pending.map(x=>String(x.id)));
    const used=new Set(db.prepare("SELECT id,scheduledAt FROM publication_items WHERE COALESCE(provider,'youtube')='youtube' AND status NOT IN ('cancelled','deleted')").all()
      .filter(x=>!pendingIds.has(String(x.id))).map(x=>String(x.scheduledAt)));
    const shifted=[];let cursor=afterMs;
    for(const item of pending){
      const scheduledAt=nextFreeSlotAfter(cursor,used);
      used.add(scheduledAt);cursor=Date.parse(scheduledAt);
      const uploadAt=new Date(Date.parse(scheduledAt)-390*60000).toISOString();
      if(item.scheduledAt!==scheduledAt||item.uploadAt!==uploadAt){
        item.scheduledAt=scheduledAt;item.uploadAt=uploadAt;
        hist(item,item.status,'Publication slot moved forward automatically because YouTube API quota resets after the previous slot.');
        save(db,item);shifted.push({episode:item.episode,scheduledAt});
      }
    }
    if(shifted.length)console.log('[PUBLICATION QUOTA RESCHEDULE]',JSON.stringify({after:new Date(afterMs).toISOString(),shifted}));
    return shifted;
  }

  let cloudMigrationRunning=false;
  async function migratePendingPublicationMedia(){
    if(cloudMigrationRunning||(!reviewStorageConfigured()&&!reviewStorageRequired()))return;
    cloudMigrationRunning=true;
    try{
      const rows=db.prepare("SELECT * FROM publication_items WHERE COALESCE(provider,'youtube')='youtube' AND filePath IS NOT NULL AND filePath<>'' AND status NOT IN ('published','cancelled','deleted') ORDER BY episode").all();
      for(const item of rows){
        if(isReviewStorageUri(item.filePath)||item.videoId)continue;
        if(!fs.existsSync(item.filePath))continue;
        try{
          const local=item.filePath;
          const cloud=await uploadReviewFile(local,{itemId:'publication-'+item.id,revision:0});
          item.filePath=cloud.uri;
          item.fileSize=cloud.size||item.fileSize||fs.statSync(local).size;
          hist(item,item.status,'Publication media moved to private cloud storage; YouTube quota is reserved for publication only.');
          save(db,item);
          try{fs.rmSync(local,{force:true})}catch{}
          console.log('[PUBLICATION CLOUD MIGRATION]',JSON.stringify({episode:item.episode,size:item.fileSize}));
        }catch(e){
          console.error('[PUBLICATION CLOUD MIGRATION ERROR]',JSON.stringify({episode:item.episode,error:String(e?.message||e).slice(0,500)}));
          if(reviewStorageRequired())throw e;
        }
      }
    }finally{cloudMigrationRunning=false}
  }

  try{
    const auditRows=db.prepare("SELECT episode,title,status,filePath,videoId,resumableSession,scheduledAt,uploadAt FROM publication_items WHERE status NOT IN ('published','cancelled','deleted') ORDER BY episode").all()
      .map(x=>({episode:x.episode,title:String(x.title||'').slice(0,80),status:x.status,videoId:Boolean(x.videoId),cloud:isReviewStorageUri(x.filePath),local:Boolean(x.filePath&&!isReviewStorageUri(x.filePath)&&fs.existsSync(x.filePath)),hasPath:Boolean(x.filePath),session:Boolean(x.resumableSession),scheduledAt:x.scheduledAt,uploadAt:x.uploadAt}));
    console.log('[PUBLICATION STORAGE AUDIT]',JSON.stringify(auditRows));
  }catch{}
  function normalizeTimedYoutubePublicationPolicy(){
    try{
      const tz=config.schedule.timezone;
      const rows=db.prepare("SELECT * FROM publication_items WHERE COALESCE(provider,'youtube')='youtube' AND status NOT IN ('published','cancelled','deleted') ORDER BY scheduledAt").all();
      const changed=[];
      for(const item of rows){
        const base=Date.parse(String(item.scheduledAt||''));
        if(!Number.isFinite(base))continue;
        const localDay=dayKey(new Date(base),tz);
        const release=zonedLocal(localDay,'19:00',tz);
        const scheduledAt=release.toISOString();
        const uploadAt=scheduledAt;
        if(String(item.scheduledAt)!==scheduledAt||String(item.uploadAt)!==uploadAt){
          item.scheduledAt=scheduledAt;item.uploadAt=uploadAt;
          hist(item,item.status,'YouTube clock normalized: keep media in Publisher stock until release time; upload directly PUBLIC at 19:00 ART. Pre-publication YouTube uploads are forbidden.');
          save(db,item);changed.push({episode:item.episode,uploadAt,scheduledAt,videoId:Boolean(item.videoId)});
        }
      }
      if(changed.length)console.log('[PUBLICATION STOCK_UNTIL_19_DIRECT_PUBLIC NORMALIZED]',JSON.stringify({timezone:tz,changed}));
    }catch(e){console.log('[PUBLICATION TIMED POLICY NORMALIZE WARNING]',String(e?.message||e).slice(0,500))}
  }
  normalizeTimedYoutubePublicationPolicy();

  async function tick(){
    if(!isEnabled()||running)return;running=true;lastHeartbeat=now();lastError=null;
    await migratePendingPublicationMedia();
    try{
      const items=db.prepare("SELECT * FROM publication_items WHERE COALESCE(provider,'youtube')='youtube' AND status NOT IN ('cancelled','deleted') AND (status<>'published' OR aiDisclosureSyncedAt IS NULL) ORDER BY scheduledAt").all();
      for(const item of items){
        try{
          const t=Date.now();
          if(item.videoId&&loadToken()&&t>=Number(remotePollNext.get(item.id)||0)){
            try{
              const state=await readRemoteStatus(item);
              remotePollNext.set(item.id,t+(state==='published'?24*60*60*1000:state==='scheduled'?10*60*1000:3*60*1000));
            }catch(e){
              const quota=isQuotaExceeded(e),msg=String(e?.message||e);
              remotePollNext.set(item.id,quota?nextYoutubeQuotaRetry():t+5*60*1000);
              if(quota)await publicPageFallback(item);
              else if(/YouTube video not found/i.test(msg)&&item.videoId&&!item.filePath){
                item.status='backup_hold';item.remotePrivacyStatus=null;item.remotePublishAt=null;
                item.error='YouTube no confirma este video y no existe respaldo cloud/local. Rescate requerido antes de cualquier publicación.';
                hist(item,'backup_hold',item.error);save(db,item);
                console.log('[PUBLICATION BACKUP HOLD]',JSON.stringify({episode:item.episode,videoId:item.videoId,message:item.error}));
              }else console.log('[PUBLICATION REMOTE STATUS WARNING]',JSON.stringify({episode:item.episode,error:msg.slice(0,500)}));
            }
          }
          if(item.videoId&&!item.aiDisclosureSyncedAt&&loadToken()&&Date.now()>=Number(aiDisclosureNext.get(item.id)||0)){
            try{await ensureAiDisclosure(item);aiDisclosureNext.delete(item.id)}
            catch(e){
              const quota=isQuotaExceeded(e);
              aiDisclosureNext.set(item.id,quota?nextYoutubeQuotaRetry():Date.now()+15*60*1000);
              console.log('[PUBLICATION AI DISCLOSURE WAIT]',JSON.stringify({episode:item.episode,quota,error:String(e?.message||e).slice(0,500)}));
            }
          }
          if(item.status==='published')continue;
          if(item.status==='backup_hold')continue;
          if(item.retryAt>Date.now())continue;
          const releaseAt=Date.parse(item.scheduledAt),uploadAt=Date.parse(item.uploadAt),clock=Date.now();
          // uploadAt only gates videos that have not been uploaded yet.
          // Existing YouTube videos must be eligible for migration immediately,
          // even if a legacy local uploadAt field drifted to a wrong date.
          if(!item.videoId&&clock<uploadAt)continue;
          if(!loadToken())throw new Error('YOUTUBE_AUTH_REQUIRED');
          if(item.resumableSession&&!item.videoId){const resolved=await reconcileAmbiguous(item);if(resolved&&item.status==='attention')continue}

          // YOUTUBE DISTRIBUTION-SAFE CLOCK:
          // approval -> Publisher/cloud stock only; NOTHING is uploaded to YouTube early.
          // release time (19:00 ART) -> upload directly PUBLIC in the initial videos.insert.
          // A future episode must never exist on YouTube as PRIVATE or scheduled.
          if(clock<releaseAt){
            item.attempts=0;item.retryAt=0;item.error=null;save(db,item);
            continue;
          }

          if(!item.videoId){
            await upload(item,'public');
            await verify(item);
          }else{
            // Legacy repair path only: an already-uploaded PRIVATE video from the
            // retired staging policy is released immediately once its release time arrives.
            await publishNowLikeManual(item);
            await verify(item);
          }
          item.attempts=0;item.retryAt=0;item.error=null;save(db,item);
        }catch(e){
          const raw=String(e?.message||e);item.attempts=Number(item.attempts||0)+1;
          if(isQuotaExceeded(e)){
            const retryAt=nextYoutubeQuotaRetry();
            item.retryAt=retryAt;
            item.error='YouTube daily API quota exhausted. Remote state will be reconciled automatically after reset.';
            if(!['scheduled','published'].includes(String(item.status||'')))hist(item,'quota_wait',item.error);
            else{item.updatedAt=now();save(db,item)}
            if(!item.videoId)shiftPendingQueueAfter(retryAt);
            console.log('[PUBLICATION QUOTA WAIT]',JSON.stringify({episode:item.episode,videoId:Boolean(item.videoId),status:item.status,retryAt:new Date(retryAt).toISOString()}));
          }else if(raw==='YOUTUBE_AUTH_REQUIRED'){
            item.error=raw;if(!['scheduled','published'].includes(String(item.status||'')))item.status='auth_wait';item.retryAt=0;hist(item,item.status,raw);save(db,item);
          }else if(raw==='UPLOAD_SESSION_AMBIGUOUS'){
            item.error=raw;item.status='attention';item.retryAt=0;hist(item,item.status,raw);save(db,item);
          }else{
            item.error=raw;if(!['scheduled','published'].includes(String(item.status||'')))item.status='error';item.retryAt=Date.now()+Math.min(60*60*1000,60000*Math.pow(2,Math.min(item.attempts,6)));
            hist(item,item.status,raw);save(db,item);
          }
        }
      }
    }catch(e){lastError=String(e?.message||e)}finally{lastHeartbeat=now();running=false}
  }

  app.get('/publication/:id/video',async(req,res)=>{try{
    const item=db.prepare('SELECT id,filePath,videoId,status FROM publication_items WHERE id=?').get(req.params.id);
    if(!item)return res.sendStatus(404);
    if(!item.filePath)return res.status(404).json({error:'Este video ya no conserva una copia local de Stock.'});
    if(isReviewStorageUri(item.filePath)){
      const url=await signedReviewUrl(item.filePath,1800);
      if(!url)return res.status(404).json({error:'No se pudo abrir la copia privada del video.'});
      return res.redirect(302,url);
    }
    const abs=path.resolve(item.filePath),root=path.resolve(dataDir)+path.sep;
    if(!abs.startsWith(root)||!fs.existsSync(abs))return res.status(404).json({error:'La copia local de Stock ya no está disponible.'});
    res.setHeader('Cache-Control','private, max-age=0, no-store');
    return res.sendFile(abs);
  }catch(e){res.status(500).json({error:String(e?.message||e)})}});
  async function purgeRejected(row){
    const matches=db.prepare("SELECT * FROM publication_items WHERE itemId=? AND COALESCE(provider,'youtube')='youtube' AND status NOT IN ('published','deleted')").all(String(row?.id||''));
    const deleted=[];
    for(const item of matches){
      if(item.videoId){
        try{
          const yt=youtubeApi();
          const remote=(await yt.videos.list({part:['status','snippet'],id:[item.videoId]})).data.items?.[0]||null;
          const privacy=String(remote?.status?.privacyStatus||'');
          if(privacy==='public')throw new Error('REFUSE_DELETE_PUBLIC_VIDEO');
          await yt.videos.delete({id:item.videoId});
          deleted.push({videoId:item.videoId,privacy:privacy||'unknown'});
        }catch(e){
          const m=String(e?.message||e);
          if(!/videoNotFound|not found|404/i.test(m))throw e;
        }
      }
      await cleanupPublicationMedia(item);
      db.prepare('DELETE FROM publication_items WHERE id=?').run(item.id);
    }
    return{purged:matches.length,remoteDeleted:deleted};
  }

  async function purgePrivateVideosByTitle(titles=[]){
    const wanted=[...new Set((titles||[]).map(x=>String(x||'').trim()).filter(Boolean))];
    if(!wanted.length)return{purged:0,matches:[]};
    if(!loadToken())throw new Error('YOUTUBE_AUTH_REQUIRED');
    const yt=youtubeApi();
    const ch=(await yt.channels.list({part:['contentDetails'],mine:true})).data.items?.[0];
    const uploads=ch?.contentDetails?.relatedPlaylists?.uploads;
    if(!uploads)throw new Error('YOUTUBE_UPLOADS_PLAYLIST_NOT_FOUND');
    const normalize=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
    const targets=wanted.map(x=>normalize(x));
    const ids=[];let pageToken=undefined;
    do{
      const page=await yt.playlistItems.list({part:['contentDetails'],playlistId:uploads,maxResults:50,pageToken});
      for(const it of page.data.items||[]){const id=it.contentDetails?.videoId;if(id)ids.push(String(id))}
      pageToken=page.data.nextPageToken||undefined;
    }while(pageToken&&ids.length<500);
    const matches=[],privateInventory=[];
    for(let i=0;i<ids.length;i+=50){
      const batch=ids.slice(i,i+50);
      const r=await yt.videos.list({part:['status','snippet'],id:batch});
      for(const v of r.data.items||[]){
        const title=String(v.snippet?.title||''),n=normalize(title),privacy=String(v.status?.privacyStatus||'');
        if(privacy==='private')privateInventory.push({videoId:v.id,title,privacy,publishedAt:v.snippet?.publishedAt||null});
        const wantedMatch=targets.some(t=>n===t||n.startsWith(t+' ')||t.startsWith(n+' '));
        if(!wantedMatch||privacy==='public')continue;
        await yt.videos.delete({id:v.id});
        matches.push({videoId:v.id,title,privacy});
      }
    }
    return{purged:matches.length,matches,privateInventory:privateInventory.slice(0,100)};
  }

  app.get('/publication/items',(_req,res)=>res.json({items:db.prepare('SELECT * FROM publication_items ORDER BY scheduledAt').all().map(publicItem),scheduler:{alive:true,lastHeartbeat,lastError,indefinite:true}}));
  app.post('/publication/run',(_req,res)=>{setTimeout(()=>void tick(),0);res.status(202).json({ok:true})});
  const timer=setInterval(()=>void tick(),30000);timer.unref?.();setTimeout(()=>void migratePendingPublicationMedia().then(()=>auditExistingMetadata()).then(()=>tick()).catch(e=>{lastError=String(e?.message||e)}),900).unref?.();
  return{enqueue,purgeRejected,purgePrivateVideosByTitle,tick,status:()=>({alive:true,running,lastHeartbeat,lastError,indefinite:true}),close:()=>clearInterval(timer)};
}
