
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

function publicItem(r){return{...r,history:JSON.parse(r.history||'[]'),resumableSession:undefined,filePath:r.filePath?true:false}}
function hist(row,status,message=''){const h=JSON.parse(row.history||'[]');h.push({status,at:now(),message});row.history=JSON.stringify(h.slice(-120));row.status=status;row.updatedAt=now()}
function save(db,row){db.prepare(`UPDATE publication_items SET title=?,description=?,scheduledAt=?,uploadAt=?,status=?,filePath=?,fileSize=?,videoId=?,resumableSession=?,playlistId=?,attempts=?,retryAt=?,error=?,history=?,updatedAt=? WHERE id=?`).run(row.title,row.description,row.scheduledAt,row.uploadAt,row.status,row.filePath,row.fileSize,row.videoId,row.resumableSession,row.playlistId,row.attempts,row.retryAt,row.error,row.history,row.updatedAt,row.id)}

export function installPublication({app,db,config,youtubeApi,authedClient,loadToken,dataDir}){
  const publicationDir=path.join(dataDir,'publication');fs.mkdirSync(publicationDir,{recursive:true,mode:0o700});
  let running=false,lastError=null,lastHeartbeat=null;

  function enqueue(row){
    const existing=db.prepare('SELECT * FROM publication_items WHERE itemId=?').get(row.id);if(existing)return publicItem(existing);
    const {title,description}=metadata(row,config),scheduledAt=nextSlot(db,config),uploadAt=new Date(new Date(scheduledAt).getTime()-Number(config.schedule.upload_lead_minutes||0)*60000).toISOString(),id=randomUUID();
    let filePath=null,fileSize=0,videoId=row.reviewVideoId||null;
    if(!videoId){
      if(isReviewStorageUri(row.remoteUrl)){
        filePath=String(row.remoteUrl);
        fileSize=Number(row.reviewOriginalSize||0)||Number((()=>{try{return JSON.parse(row.flowResult||'{}')?.size||0}catch{return 0}})());
        if(!fileSize)throw new Error('El MP4 aprobado en cloud storage no tiene tamaño verificable.');
      }else{
        if(!row.videoPath||!fs.existsSync(row.videoPath))throw new Error('El MP4 aprobado no está disponible.');
        filePath=path.join(publicationDir,id+'.mp4');fs.copyFileSync(row.videoPath,filePath);fileSize=fs.statSync(filePath).size;
      }
    }else fileSize=Number(row.reviewOriginalSize||0);
    const item={id,itemId:row.id,episode:Number(row.episode),title,description,scheduledAt,uploadAt,status:'queued',filePath,fileSize,videoId,resumableSession:null,playlistId:null,attempts:0,retryAt:0,error:null,history:JSON.stringify([{status:'queued',at:now(),message:'Approved for publication.'}]),createdAt:now(),updatedAt:now()};
    db.prepare('INSERT INTO publication_items(id,itemId,episode,title,description,scheduledAt,uploadAt,status,filePath,fileSize,videoId,resumableSession,playlistId,attempts,retryAt,error,history,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(item.id,item.itemId,item.episode,item.title,item.description,item.scheduledAt,item.uploadAt,item.status,item.filePath,item.fileSize,item.videoId,item.resumableSession,item.playlistId,item.attempts,item.retryAt,item.error,item.history,item.createdAt,item.updatedAt);
    return publicItem(item);
  }

  async function request(url,options={}){
    const client=authedClient(),token=await client.getAccessToken(),access=String(token?.token||token||'');
    if(!access)throw new Error('YouTube OAuth access token unavailable.');
    return await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(90000),headers:{...(options.headers||{}),Authorization:'Bearer '+access}});
  }

  async function stageMetadata(item){
    if(!item.videoId)return;
    const yt=youtubeApi();const channel=(await yt.channels.list({part:['id'],mine:true})).data.items?.[0]?.id;
    const v=(await yt.videos.list({part:['snippet','status'],id:[item.videoId]})).data.items?.[0];
    if(!v||!channel||v.snippet?.channelId!==channel)throw new Error('El video privado de staging no pertenece al canal conectado.');
    if(v.status?.privacyStatus!=='private')throw new Error('El staging dejó de ser privado; se bloqueó la programación.');
    await yt.videos.update({part:['snippet','status'],requestBody:{id:item.videoId,snippet:{title:item.title,description:item.description,categoryId:v.snippet?.categoryId||'24',tags:[...(v.snippet?.tags||[]).filter(x=>!String(x).startsWith('publisher-runtime-')),'publisher-runtime-'+item.id]},status:{privacyStatus:'private',publishAt:item.scheduledAt,selfDeclaredMadeForKids:false,containsSyntheticMedia:true}}});
  }

  async function ensureAiDisclosure(item){
    if(!item?.videoId||item.aiDisclosureSyncedAt)return;
    const yt=youtubeApi();
    const current=(await yt.videos.list({part:['status'],id:[item.videoId]})).data.items?.[0];
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
    if(next.privacyStatus==='private'&&st.publishAt)next.publishAt=st.publishAt;
    await yt.videos.update({part:['status'],requestBody:{id:item.videoId,status:next}});
    item.aiDisclosureSyncedAt=new Date().toISOString();
    hist(item,item.status||'queued','YouTube AI/synthetic-content disclosure enabled.');
    save(db,item);
  }

  async function auditExistingMetadata(){
    const items=db.prepare("SELECT * FROM publication_items WHERE status NOT IN ('cancelled','deleted') ORDER BY episode").all();
    const episode1Title=String(items.find(x=>Number(x.episode)===1)?.title||'');
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

  async function upload(item){
    if(item.videoId)return;
    if(!item.filePath)throw new Error('Archivo de publicación ausente.');
    const cloudSource=isReviewStorageUri(item.filePath);
    if(!cloudSource&&!fs.existsSync(item.filePath))throw new Error('Archivo de publicación ausente.');
    if(!item.resumableSession){
      const r=await request('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Content-Length':String(item.fileSize),'X-Upload-Content-Type':'video/mp4'},body:JSON.stringify({snippet:{title:item.title,description:item.description,categoryId:'24',tags:['publisher-runtime-'+item.id]},status:{privacyStatus:'private',publishAt:item.scheduledAt,selfDeclaredMadeForKids:false,containsSyntheticMedia:true}})});
      if(!r.ok)throw new Error('YouTube resumable init failed ('+r.status+').');
      const session=r.headers.get('location');if(!session||new URL(session).hostname!=='www.googleapis.com')throw new Error('YouTube returned an invalid resumable session.');
      item.resumableSession=session;hist(item,'uploading','Resumable session persisted before bytes.');save(db,item);
    }
    let r=await request(item.resumableSession,{method:'PUT',headers:{'Content-Length':'0','Content-Range':'bytes */'+item.fileSize}});
    while(true){
      if(r.ok){const j=await r.json();if(!j.id)throw new Error('YouTube did not return videoId.');item.videoId=j.id;item.resumableSession=null;hist(item,'uploaded','Upload complete.');save(db,item);return}
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

  async function verify(item){
    const yt=youtubeApi(),v=(await yt.videos.list({part:['status'],id:[item.videoId]})).data.items?.[0];
    if(!v)throw new Error('YouTube video not found after upload/staging.');
    if(['failed','rejected','deleted'].includes(v.status?.uploadStatus))throw new Error('YouTube rejected the video.');
    if(v.status?.privacyStatus==='public'){hist(item,'published','YouTube confirms PUBLIC.');save(db,item)}
    else if(v.status?.privacyStatus==='private'&&Date.parse(v.status?.publishAt)===Date.parse(item.scheduledAt)){hist(item,'scheduled','YouTube confirms private scheduled publication.');save(db,item)}
    else throw new Error('YouTube did not confirm the intended schedule.');
    if(['scheduled','published'].includes(item.status)&&item.filePath){
      if(isReviewStorageUri(item.filePath)){try{await deleteReviewObject(item.filePath)}catch{}}
      else try{fs.rmSync(item.filePath,{force:true})}catch{}
      item.filePath=null;save(db,item)
    }
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
    const pending=db.prepare("SELECT * FROM publication_items WHERE status NOT IN ('published','scheduled','cancelled','deleted') ORDER BY episode,scheduledAt").all();
    if(!pending.length)return[];
    const pendingIds=new Set(pending.map(x=>String(x.id)));
    const used=new Set(db.prepare("SELECT id,scheduledAt FROM publication_items WHERE status NOT IN ('cancelled','deleted')").all()
      .filter(x=>!pendingIds.has(String(x.id))).map(x=>String(x.scheduledAt)));
    const shifted=[];let cursor=afterMs;
    for(const item of pending){
      const scheduledAt=nextFreeSlotAfter(cursor,used);
      used.add(scheduledAt);cursor=Date.parse(scheduledAt);
      const uploadAt=new Date(Date.parse(scheduledAt)-Number(config.schedule.upload_lead_minutes||0)*60000).toISOString();
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
      const rows=db.prepare("SELECT * FROM publication_items WHERE filePath IS NOT NULL AND filePath<>'' AND status NOT IN ('published','cancelled','deleted') ORDER BY episode").all();
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

  async function tick(){
    if(running)return;running=true;lastHeartbeat=now();lastError=null;
    await migratePendingPublicationMedia();
    try{
      const items=db.prepare("SELECT * FROM publication_items WHERE status NOT IN ('published','cancelled','deleted') ORDER BY scheduledAt").all();
      for(const item of items){
        if(item.retryAt>Date.now())continue;
        try{
          if(item.videoId&&!item.aiDisclosureSyncedAt)await ensureAiDisclosure(item);
          if(item.status==='scheduled'){if(Date.now()>=Date.parse(item.scheduledAt)-60000)await verify(item);continue}
          if(Date.now()<Date.parse(item.uploadAt))continue;
          if(!loadToken())throw new Error('YOUTUBE_AUTH_REQUIRED');
          if(item.resumableSession&&!item.videoId){const resolved=await reconcileAmbiguous(item);if(resolved&&item.status==='attention')continue}
          if(item.videoId&&item.status==='queued'){await stageMetadata(item);hist(item,'uploaded','Existing private review staging prepared for publication.');save(db,item)}
          if(!item.videoId)await upload(item);
          await verify(item);item.attempts=0;item.retryAt=0;item.error=null;save(db,item);
        }catch(e){
          const raw=String(e?.message||e);item.attempts=Number(item.attempts||0)+1;
          if(isQuotaExceeded(e)){
            item.status='quota_wait';item.retryAt=nextYoutubeQuotaRetry();
            item.error='YouTube daily API quota exhausted. Automatic retry is scheduled after the quota reset.';
            hist(item,item.status,item.error);save(db,item);
            shiftPendingQueueAfter(item.retryAt);
            console.log('[PUBLICATION QUOTA WAIT]',JSON.stringify({episode:item.episode,retryAt:new Date(item.retryAt).toISOString()}));
          }else if(raw==='YOUTUBE_AUTH_REQUIRED'){
            item.error=raw;item.status='auth_wait';item.retryAt=0;hist(item,item.status,raw);save(db,item);
          }else if(raw==='UPLOAD_SESSION_AMBIGUOUS'){
            item.error=raw;item.status='attention';item.retryAt=0;hist(item,item.status,raw);save(db,item);
          }else{
            item.error=raw;item.status='error';item.retryAt=Date.now()+Math.min(60*60*1000,60000*Math.pow(2,Math.min(item.attempts,6)));
            hist(item,item.status,raw);save(db,item);
          }
        }
      }
    }catch(e){lastError=String(e?.message||e)}finally{lastHeartbeat=now();running=false}
  }

  app.get('/publication/items',(_req,res)=>res.json({items:db.prepare('SELECT * FROM publication_items ORDER BY scheduledAt').all().map(publicItem),scheduler:{alive:true,lastHeartbeat,lastError,indefinite:true}}));
  app.post('/publication/run',(_req,res)=>{setTimeout(()=>void tick(),0);res.status(202).json({ok:true})});
  const timer=setInterval(()=>void tick(),30000);timer.unref?.();setTimeout(()=>void migratePendingPublicationMedia().then(()=>auditExistingMetadata()).then(()=>tick()).catch(e=>{lastError=String(e?.message||e)}),900).unref?.();
  return{enqueue,tick,status:()=>({alive:true,running,lastHeartbeat,lastError,indefinite:true}),close:()=>clearInterval(timer)};
}
