import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR=path.resolve(process.env.DATA_DIR||'/data');
const PUBLIC_DIR=path.resolve(process.cwd(),'public');
const STATUS_FILE=path.join(PUBLIC_DIR,'autonomy-status.json');
const VERSION='unattended-supervisor-v1';
const BASE_TARGET=Math.max(1,Math.min(20,Number(process.env.PUBLISHER_VIDEOS_PER_DAY||3)||3));
const MAX_CATCHUP_TARGET=Math.max(BASE_TARGET,Math.min(20,Number(process.env.PUBLISHER_AUTONOMY_MAX_DAILY_TARGET||12)||12));
const LOOKBACK_DAYS=Math.max(1,Math.min(14,Number(process.env.PUBLISHER_AUTONOMY_LOOKBACK_DAYS||10)||10));
const POISON_ATTEMPTS=Math.max(3,Number(process.env.PUBLISHER_AUTONOMY_POISON_ATTEMPTS||6)||6);
const RETRIEVAL_ATTEMPTS=Math.max(4,Number(process.env.PUBLISHER_AUTONOMY_RETRIEVAL_ATTEMPTS||8)||8);
const RETRIEVAL_MAX_AGE_MS=Math.max(60*60*1000,Number(process.env.PUBLISHER_AUTONOMY_RETRIEVAL_MAX_HOURS||3)*60*60*1000);
const BROWSER_RESTART_COOLDOWN_MS=30*60*1000;
let exiting=false;

function now(){return new Date().toISOString()}
function readJson(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'))||fallback}catch{return fallback}}
function config(){return readJson(path.join(DATA_DIR,'publisher-config.json'),{})}
function timezone(){const c=config();return String(c?.schedule?.timezone||c?.identity?.timezone||'America/Argentina/Buenos_Aires')}
function fmt(date=new Date(),tz=timezone()){
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
}
function dayKey(date=new Date(),tz=timezone()){const p=fmt(date,tz);return `${p.year}-${p.month}-${p.day}`}
function addDay(day,n=1){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function zonedLocal(dateStr,timeStr,tz=timezone()){
  const [y,m,d]=dateStr.split('-').map(Number),[hh,mm]=String(timeStr||'19:00').split(':').map(Number);
  const target=Date.UTC(y,m-1,d,hh,mm,0);let guess=target;
  for(let i=0;i<4;i++){const p=fmt(new Date(guess),tz),seen=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second),diff=target-seen;if(Math.abs(diff)<1000)break;guess+=diff}
  return new Date(guess);
}
function dbPath(){
  const explicit=String(process.env.PUBLISHER_FACTORY_DB_PATH||'').trim();
  const candidates=[explicit,path.join(DATA_DIR,'publisher-runtime','factory.sqlite'),path.join(DATA_DIR,'frutti-factory','factory.sqlite')].filter(Boolean);
  return candidates.find(p=>fs.existsSync(p))||candidates[0];
}
function tableExists(db,name){try{return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))}catch{return false}}
function columns(db,table){try{return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>String(x.name)))}catch{return new Set()}}
function meta(db,key,fallback=''){try{return db.prepare('SELECT value FROM factory_meta WHERE key=?').get(key)?.value??fallback}catch{return fallback}}
function setMeta(db,key,value){try{db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,String(value))}catch{}}
function ensureSchema(db){
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_daily_obligations(day TEXT PRIMARY KEY,generationTarget INTEGER NOT NULL DEFAULT 0,generationCompleted INTEGER NOT NULL DEFAULT 0,generationDeficit INTEGER NOT NULL DEFAULT 0,publicationTarget INTEGER NOT NULL DEFAULT 0,publicationCompleted INTEGER NOT NULL DEFAULT 0,stockAvailable INTEGER NOT NULL DEFAULT 0,updatedAt TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_quarantine(id INTEGER PRIMARY KEY AUTOINCREMENT,itemId TEXT NOT NULL,season INTEGER,episode INTEGER,phase TEXT NOT NULL,signature TEXT NOT NULL,reason TEXT NOT NULL,providerRunId TEXT,quarantinedAt TEXT NOT NULL,UNIQUE(itemId,signature));`);
}
function localDayOf(value,tz=timezone()){const ms=Date.parse(String(value||''));return Number.isFinite(ms)?dayKey(new Date(ms),tz):''}
function successfulGenerationsByDay(db){
  const out=new Map();
  if(!tableExists(db,'factory_generations'))return out;
  const c=columns(db,'factory_generations');
  const rows=db.prepare('SELECT * FROM factory_generations').all();
  for(const r of rows){
    const status=String(r.status||'').toLowerCase();
    if(!['review','completed'].includes(status))continue;
    if(c.has('credits')&&Number(r.credits||0)<=0)continue;
    const day=String(r.day||'').match(/^\d{4}-\d{2}-\d{2}$/)?.[0]||localDayOf(r.updatedAt||r.createdAt);
    if(day)out.set(day,(out.get(day)||0)+1);
  }
  return out;
}
function successfulPublicationsByDay(db){
  const out=new Map();
  if(!tableExists(db,'publication_items'))return out;
  for(const r of db.prepare("SELECT * FROM publication_items WHERE status='published'").all()){
    const day=localDayOf(r.remotePublishAt||r.updatedAt||r.scheduledAt);
    if(day)out.set(day,(out.get(day)||0)+1);
  }
  return out;
}
function activationDay(db){
  const raw=meta(db,'automation:readinessActivatedAt','');
  let ms=Date.parse(raw);
  if(!Number.isFinite(ms)&&tableExists(db,'factory_generations')){
    const r=db.prepare("SELECT createdAt,updatedAt FROM factory_generations WHERE status IN ('review','completed') ORDER BY COALESCE(createdAt,updatedAt) LIMIT 1").get();
    ms=Date.parse(String(r?.createdAt||r?.updatedAt||''));
  }
  const floor=new Date(Date.now()-LOOKBACK_DAYS*86400000);
  if(!Number.isFinite(ms)||ms<floor.getTime())ms=floor.getTime();
  return dayKey(new Date(ms));
}
function postingTime(){const c=config(),arr=c?.schedule?.posting_times;return Array.isArray(arr)&&/^\d{2}:\d{2}$/.test(String(arr[0]||''))?String(arr[0]):'19:00'}
function stockCount(db){
  if(!tableExists(db,'publication_items'))return 0;
  const c=columns(db,'publication_items');
  const rows=db.prepare("SELECT * FROM publication_items WHERE status NOT IN ('published','cancelled','deleted')").all();
  return rows.filter(r=>!['backup_hold','attention'].includes(String(r.status||''))&&Boolean(r.videoId||r.filePath||(c.has('remoteUrl')&&r.remoteUrl))).length;
}
function normalizePublicationQueue(db,publishedToday){
  if(!tableExists(db,'publication_items'))return{changed:0,pending:0};
  const c=columns(db,'publication_items');
  if(!c.has('scheduledAt'))return{changed:0,pending:0};
  const rows=db.prepare("SELECT * FROM publication_items WHERE status NOT IN ('published','cancelled','deleted','processing','publishing','backup_hold','attention') ORDER BY scheduledAt,episode,createdAt").all()
    .filter(r=>Boolean(r.videoId||r.filePath||(c.has('remoteUrl')&&r.remoteUrl)));
  if(!rows.length)return{changed:0,pending:0};
  const current=Date.now(),today=dayKey(),tz=timezone(),time=postingTime();
  const seen=new Set();let needs=false;
  for(const r of rows){const d=localDayOf(r.scheduledAt,tz);if(!d||Date.parse(String(r.scheduledAt||''))<current-5*60*1000||seen.has(d)){needs=true;break}seen.add(d)}
  if(!needs)return{changed:0,pending:rows.length};
  let day=today;
  const releaseToday=zonedLocal(today,time,tz);
  let firstAt;
  if(publishedToday>0||releaseToday.getTime()<current-5*60*1000){day=addDay(today,1);firstAt=zonedLocal(day,time,tz)}else firstAt=releaseToday;
  let changed=0;
  for(let i=0;i<rows.length;i++){
    const at=i===0?firstAt:zonedLocal(addDay(day,i),time,tz);
    const iso=at.toISOString();
    if(String(rows[i].scheduledAt)!==iso||String(rows[i].uploadAt||'')!==iso){
      const sets=['scheduledAt=?'];const vals=[iso];if(c.has('uploadAt')){sets.push('uploadAt=?');vals.push(iso)}if(c.has('updatedAt')){sets.push('updatedAt=?');vals.push(now())}vals.push(rows[i].id);
      db.prepare(`UPDATE publication_items SET ${sets.join(',')} WHERE id=?`).run(...vals);changed++;
    }
  }
  return{changed,pending:rows.length};
}
function lifecycle(db,row){try{return JSON.parse(meta(db,'flow:generationLifecycle:'+row.id,'{}'))||{}}catch{return{}}}
function saveLifecycle(db,row,state,extra={}){const prior=lifecycle(db,row);setMeta(db,'flow:generationLifecycle:'+row.id,JSON.stringify({...prior,...extra,state,provider:'FreeBrowserProvider',updated_at:now()}))}
function classifyError(message=''){
  const s=String(message);
  if(/FLOW_CHARACTER_PICKER_EMPTY|CHARACTER_NOT_FOUND|CHARACTER_SEARCH_INPUT_NOT_FOUND|CHARACTERS_PICKER_NOT_FOUND|CHARACTER_EXACT_MATCH_FAILED/i.test(s))return'character-asset';
  if(/FLOW_SETTING_NOT_FOUND|FLOW_SETTINGS_|FLOW_MODEL_|PROMPT_EDITOR_NOT_FOUND|GENERATION_SEND_BUTTON_NOT_FOUND|PROJECT_TITLE_/i.test(s))return'flow-ui-deterministic';
  if(/XVFB_START_FAILED|CHROME_CDP_NOT_READY|connectOverCDP|Target crashed|Target closed|Browser closed/i.test(s))return'browser-infra';
  if(/RENDER_TIMEOUT_STRICT_MATCH|FLOW_STRICT_RECOVERY_PROOF_REQUIRED|UNIQUE_FRESH_TILE_DOWNLOAD_FAILED|no-unique-correlated-visible-asset/i.test(s))return'post-submit-retrieval';
  if(/FLOW_AUTH|AUTH_REQUIRED|login|sign.?in/i.test(s))return'authentication';
  return'';
}
function quarantine(db,row,phase,signature,reason){
  const stamp=now(),lc=lifecycle(db,row),run=String(row.providerRunId||lc.generation_id||'');
  db.prepare('INSERT OR IGNORE INTO autonomy_quarantine(itemId,season,episode,phase,signature,reason,providerRunId,quarantinedAt) VALUES(?,?,?,?,?,?,?,?)').run(String(row.id),Number(row.season||0),Number(row.episode||0),phase,signature,reason,run||null,stamp);
  db.prepare("UPDATE factory_items SET status='historical',nextTry=0,error=?,lastProgressAt=?,updatedAt=? WHERE id=?").run('AUTONOMY_QUARANTINED: '+reason,stamp,stamp,row.id);
  saveLifecycle(db,row,'AUTONOMY_POISON_QUARANTINED',{...lc,quarantined_at:stamp,quarantine_phase:phase,quarantine_signature:signature,automatic_submit_forbidden:true,daily_production_unblocked:true,preserved_generation_id:run||null});
  console.error('[AUTONOMY QUARANTINE]',JSON.stringify({episode:row.episode,season:row.season,phase,signature,reason}));
}
function supervisePoison(db){
  if(!tableExists(db,'factory_items'))return{quarantined:0,restart:false};
  const c=columns(db,'factory_items');
  if(!c.has('runtimeAttemptCount'))return{quarantined:0,restart:false};
  const rows=db.prepare("SELECT * FROM factory_items WHERE status IN ('draft','regen_wait','generating') AND error IS NOT NULL ORDER BY episode").all();
  let quarantined=0,restart=false;
  for(const row of rows){
    const signature=classifyError(row.error);if(!signature)continue;
    const attempts=Number(row.runtimeAttemptCount||0);
    if(signature==='browser-infra'&&attempts>=4){
      const last=Number(meta(db,'autonomy:lastBrowserRestartAt','0'))||0;
      if(Date.now()-last>BROWSER_RESTART_COOLDOWN_MS){setMeta(db,'autonomy:lastBrowserRestartAt',String(Date.now()));restart=true}continue;
    }
    if(['character-asset','flow-ui-deterministic'].includes(signature)&&String(row.status)!=='generating'&&attempts>=POISON_ATTEMPTS){quarantine(db,row,'pre-submit',signature,`${signature} repeated ${attempts} times; isolated so later daily production can continue without a duplicate submit.`);quarantined++;continue}
    if(signature==='post-submit-retrieval'&&String(row.status)==='generating'&&attempts>=RETRIEVAL_ATTEMPTS){
      const lc=lifecycle(db,row),boundary=Date.parse(String(lc.submit_boundary_at||lc.generation_started_at||row.createdAt||''));
      if(Number.isFinite(boundary)&&Date.now()-boundary>=RETRIEVAL_MAX_AGE_MS){quarantine(db,row,'post-submit-recovery',signature,`Read-only recovery failed ${attempts} times for more than ${Math.round((Date.now()-boundary)/3600000)}h; original submit identity is preserved and later production is unblocked.`);quarantined++}
    }
  }
  return{quarantined,restart};
}
function obligations(db){
  const gens=successfulGenerationsByDay(db),pubs=successfulPublicationsByDay(db),start=activationDay(db),today=dayKey();let d=start,totalDeficit=0;
  const stock=stockCount(db),records=[];
  while(d<=today){
    const g=gens.get(d)||0,p=pubs.get(d)||0,gTarget=BASE_TARGET,pTarget=stock>0||p>0?1:0,def=Math.max(0,gTarget-g);totalDeficit+=def;
    db.prepare("INSERT INTO autonomy_daily_obligations(day,generationTarget,generationCompleted,generationDeficit,publicationTarget,publicationCompleted,stockAvailable,updatedAt) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET generationTarget=excluded.generationTarget,generationCompleted=excluded.generationCompleted,generationDeficit=excluded.generationDeficit,publicationTarget=excluded.publicationTarget,publicationCompleted=excluded.publicationCompleted,stockAvailable=excluded.stockAvailable,updatedAt=excluded.updatedAt").run(d,gTarget,g,def,pTarget,p,stock,now());
    records.push({day:d,generation_target:gTarget,generation_completed:g,generation_deficit:def,publication_target:pTarget,publication_completed:p});d=addDay(d,1);
  }
  const todayCompleted=gens.get(today)||0,publishedToday=pubs.get(today)||0,priorDeficit=records.filter(x=>x.day!==today).reduce((s,x)=>s+x.generation_deficit,0);
  const target=Math.min(MAX_CATCHUP_TARGET,BASE_TARGET+priorDeficit);
  if(priorDeficit>0)setMeta(db,'automation:manualDailyTarget:'+today,String(Math.max(target,BASE_TARGET)));
  return{today,totalDeficit,priorDeficit,todayCompleted,publishedToday,target,stock,records};
}
function writeStatus(payload){try{fs.mkdirSync(PUBLIC_DIR,{recursive:true});fs.writeFileSync(STATUS_FILE,JSON.stringify(payload,null,2),{mode:0o644})}catch{}}
async function tick(){
  const file=dbPath();if(!file||!fs.existsSync(file)){writeStatus({ok:false,version:VERSION,at:now(),reason:'database-not-ready'});return}
  let db;
  try{
    db=new DatabaseSync(file,{timeout:5000});ensureSchema(db);setMeta(db,'automation:autonomySupervisorVersion',VERSION);
    if(String(process.env.PUBLISHER_ENABLED||'true').toLowerCase()!=='false')setMeta(db,'automation:factoryEnabled','true');
    const poison=supervisePoison(db),o=obligations(db),normalized=normalizePublicationQueue(db,o.publishedToday);
    const lastGeneration=tableExists(db,'factory_generations')?db.prepare("SELECT updatedAt,createdAt FROM factory_generations WHERE status IN ('review','completed') ORDER BY COALESCE(updatedAt,createdAt) DESC LIMIT 1").get():null;
    const lastPublication=tableExists(db,'publication_items')?db.prepare("SELECT updatedAt,remotePublishAt,status,videoId FROM publication_items WHERE status='published' ORDER BY COALESCE(remotePublishAt,updatedAt) DESC LIMIT 1").get():null;
    const payload={ok:true,version:VERSION,at:now(),timezone:timezone(),generation:{base_target:BASE_TARGET,today_completed:o.todayCompleted,today_target:o.target,prior_deficit:o.priorDeficit,total_lookback_deficit:o.totalDeficit,last_success:lastGeneration?.updatedAt||lastGeneration?.createdAt||null},publication:{today_completed:o.publishedToday,target:o.stock>0?1:0,stock_available:o.stock,last_success:lastPublication?.remotePublishAt||lastPublication?.updatedAt||null,queue_rescheduled:normalized.changed},quarantine:{count:Number(db.prepare('SELECT COUNT(*) n FROM autonomy_quarantine').get()?.n||0),new_this_tick:poison.quarantined},browser_restart_requested:poison.restart};
    writeStatus(payload);setMeta(db,'autonomy:lastSupervisorHeartbeat',payload.at);setMeta(db,'autonomy:lastStatus',JSON.stringify(payload));
    if(poison.restart&&!exiting){exiting=true;setTimeout(()=>process.exit(42),500).unref?.()}
  }catch(err){writeStatus({ok:false,version:VERSION,at:now(),reason:String(err?.stack||err).slice(0,1500)});console.error('[AUTONOMY SUPERVISOR ERROR]',err)}finally{try{db?.close()}catch{}}
}

setTimeout(()=>void tick(),8000).unref?.();
setInterval(()=>void tick(),60*1000).unref?.();
