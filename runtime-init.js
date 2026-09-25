
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { CONFIG, seedInitial, ensureBacklog } from './runtime-config.js';

const DATA_DIR=path.resolve(process.env.DATA_DIR||'/data');
const DIR=path.join(DATA_DIR,'publisher-runtime');
const DB_PATH=path.join(DIR,'factory.sqlite');
const INSTANCE_MARKER=path.join(DATA_DIR,'publisher-instance.json');
const INSTANCE_ID=String(process.env.PUBLISHER_INSTANCE_ID||'').trim();
const RESET_ON_CHANGE=String(process.env.PUBLISHER_RESET_ON_INSTANCE_CHANGE||'false').toLowerCase()==='true';

function freeBytes(p){
  try{const s=fs.statfsSync(p);return Number(s.bavail)*Number(s.bsize)}catch{return null}
}
function cleanupRecreatableStorage(){
  const before=freeBytes(DATA_DIR);
  const profile=path.join(DIR,'flow-profile');
  const disposable=[
    path.join(profile,'Default','Cache'),
    path.join(profile,'Default','Code Cache'),
    path.join(profile,'Default','GPUCache'),
    path.join(profile,'Default','DawnCache'),
    path.join(profile,'Default','GraphiteDawnCache'),
    path.join(profile,'Default','ShaderCache'),
    path.join(profile,'Default','Service Worker','CacheStorage'),
    path.join(profile,'Default','Service Worker','ScriptCache'),
    path.join(profile,'GrShaderCache'),
    path.join(profile,'ShaderCache'),
    path.join(profile,'DawnCache'),
    path.join(profile,'GraphiteDawnCache'),
    path.join(profile,'component_crx_cache'),
    path.join(profile,'Crashpad'),
    path.join(profile,'BrowserMetrics')
  ];
  let removed=0;
  for(const p of disposable){
    try{
      if(!fs.existsSync(p))continue;
      const dirSize=q=>{let n=0;try{const st=fs.statSync(q);if(st.isFile())return st.size;for(const e of fs.readdirSync(q,{withFileTypes:true}))n+=dirSize(path.join(q,e.name));}catch{}return n};
      const size=dirSize(p);
      fs.rmSync(p,{recursive:true,force:true});
      removed+=Number(size||0);
    }catch{}
  }
  const generated=path.join(DIR,'generated');
  try{
    for(const name of fs.readdirSync(generated)){
      if(!/\.preview\.mp4$|\.crdownload$|\.tmp$/i.test(name))continue;
      const p=path.join(generated,name);
      try{removed+=fs.statSync(p).size||0;fs.rmSync(p,{force:true})}catch{}
    }
  }catch{}
  const after=freeBytes(DATA_DIR);
  if(removed>0||before!==after)console.log('[STORAGE CLEANUP]',JSON.stringify({removed_bytes:removed,free_before:before,free_after:after}));
}
cleanupRecreatableStorage();

if(INSTANCE_ID&&RESET_ON_CHANGE){
  let previous=null;
  try{previous=JSON.parse(fs.readFileSync(INSTANCE_MARKER,'utf8'))?.id||null}catch{}
  if(previous!==INSTANCE_ID){
    fs.rmSync(DIR,{recursive:true,force:true});
  }
  if(previous!==INSTANCE_ID){
    fs.writeFileSync(INSTANCE_MARKER,JSON.stringify({id:INSTANCE_ID,initializedAt:new Date().toISOString()},null,2),{mode:0o600});
  }
}

fs.mkdirSync(path.join(DIR,'generated'),{recursive:true,mode:0o700});
fs.mkdirSync(path.join(DIR,'flow-profile'),{recursive:true,mode:0o700});
const db=new DatabaseSync(DB_PATH,{timeout:5000});
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS factory_items(
 id TEXT PRIMARY KEY,
 season INTEGER NOT NULL DEFAULT 1,
 episode INTEGER NOT NULL UNIQUE,
 hook TEXT NOT NULL,
 story TEXT NOT NULL,
 prompt TEXT NOT NULL DEFAULT '',
 title TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '',
 attempt INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0,
 seed INTEGER,
 status TEXT NOT NULL DEFAULT 'draft',
 videoPath TEXT,
 remoteUrl TEXT,
 stockId TEXT,
 publishDate TEXT,
 error TEXT,
 nextTry INTEGER NOT NULL DEFAULT 0,
 providerRunId TEXT,
 flowResult TEXT,
 promptHash TEXT,
 promptGenerationId TEXT,
 characterHandles TEXT,
 characterRoles TEXT,
 promptPayloadHash TEXT,
 promptPayloadLength INTEGER,
 creativePackageHash TEXT,
 creativePackageId TEXT,
 transportPreflight TEXT,
 runtimeAttemptCount INTEGER NOT NULL DEFAULT 0,
 lastProgressAt TEXT,
 reviewVideoId TEXT,
 reviewArchivedAt TEXT,
 reviewOriginalSize INTEGER,
 reviewPreviewSize INTEGER,
 reviewArchiveError TEXT,
 reviewFeedback TEXT,
 reviewInterpretation TEXT,
 reviewInterpretationAt TEXT,
 retryStrategy TEXT,
 reviewRetryToken TEXT,
 reviewRetrySubmittedToken TEXT,
 reviewContentHash TEXT,
 createdAt TEXT NOT NULL,
 updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS factory_status_idx ON factory_items(status,nextTry,episode);
CREATE TABLE IF NOT EXISTS factory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_knowledge(
 key TEXT PRIMARY KEY,
 version TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 content TEXT NOT NULL,
 source TEXT NOT NULL,
 updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_generations(
 id TEXT PRIMARY KEY,
 itemId TEXT NOT NULL,
 day TEXT NOT NULL,
 promptHash TEXT NOT NULL UNIQUE,
 credits INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL,
 runId TEXT,
 createdAt TEXT NOT NULL,
 updatedAt TEXT NOT NULL,
 error TEXT,
 generationKind TEXT NOT NULL DEFAULT 'automatic'
);
CREATE INDEX IF NOT EXISTS factory_generations_day_idx ON factory_generations(day,createdAt);
CREATE TABLE IF NOT EXISTS factory_alerts(
 id TEXT PRIMARY KEY,
 dedupeKey TEXT NOT NULL UNIQUE,
 level TEXT NOT NULL,
 title TEXT NOT NULL,
 message TEXT NOT NULL,
 createdAt TEXT NOT NULL,
 acknowledgedAt TEXT
);
CREATE TABLE IF NOT EXISTS publication_items(
 id TEXT PRIMARY KEY,
 itemId TEXT NOT NULL UNIQUE,
 episode INTEGER NOT NULL,
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 scheduledAt TEXT NOT NULL,
 uploadAt TEXT NOT NULL,
 status TEXT NOT NULL,
 filePath TEXT,
 fileSize INTEGER,
 videoId TEXT,
 resumableSession TEXT,
 playlistId TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 retryAt INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 history TEXT NOT NULL DEFAULT '[]',
 createdAt TEXT NOT NULL,
 updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS publication_status_idx ON publication_items(status,retryAt,scheduledAt);
`);
for(const sql of [
  "ALTER TABLE factory_items ADD COLUMN creativePackageHash TEXT",
  "ALTER TABLE factory_items ADD COLUMN creativePackageId TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewInterpretation TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewInterpretationAt TEXT"
]){try{db.exec(sql)}catch{}}
const put=(k,v)=>db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v));
put('runtime:version','publisher-runtime-v1');
put('runtime:show',CONFIG.identity.show_name);
put('automation:provider','FreeBrowserProvider');
put('automation:tinyfishRequired','false');
put('automation:tinyfishFallback','disabled');
// Environment PUBLISHER_ENABLED means the runtime is allowed to automate once setup is ready.
// The durable DB gate starts closed on a brand-new Publisher and server.js opens it only after
// YouTube + exact Flow project + Creative Bible readiness has been verified.
if(!db.prepare("SELECT 1 ok FROM factory_meta WHERE key='automation:factoryEnabled'").get())put('automation:factoryEnabled','false');
put('automation:noEndDate','true');
put('automation:planner',CONFIG.content.serialized?'serial-config-v1':'independent-config-v1');

const SOP_VERSION=String(process.env.PUBLISHER_FLOW_SOP_VERSION||CONFIG.knowledge?.flow_sop_version||'FLOW-SOP-v1.0');
const knowledgeFiles=[
  'GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md',
  'GOOGLE_FLOW_AUTOMATION_SOP.json',
  'FLOW_AI_IMPLEMENTATION_BRIEF.md',
  'FLOW_RECOVERY_RUNBOOK.md',
  'FLOW_GOLDEN_TEST.md',
  'FLOW_FAILURE_CATALOG.md',
  'FLOW_CHANGELOG.md',
  'FLOW_SOP_KNOWLEDGE_MANIFEST.json'
];
let knowledgeLoaded=0,masterSha='';
for(const file of knowledgeFiles){
  try{
    const full=path.join(process.cwd(),file),content=fs.readFileSync(full,'utf8');
    const sha256=createHash('sha256').update(content).digest('hex'),updatedAt=new Date().toISOString();
    db.prepare(`INSERT INTO runtime_knowledge(key,version,sha256,content,source,updatedAt)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET version=excluded.version,sha256=excluded.sha256,content=excluded.content,source=excluded.source,updatedAt=excluded.updatedAt`)
      .run(file,SOP_VERSION,sha256,content,'runtime-repository',updatedAt);
    if(file==='GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md')masterSha=sha256;
    knowledgeLoaded++;
  }catch{}
}
put('knowledge:flowSopVersion',SOP_VERSION);
put('knowledge:flowSopSha256',masterSha||String(process.env.PUBLISHER_FLOW_SOP_SHA256||CONFIG.knowledge?.flow_sop_sha256||''));
put('knowledge:flowSopDeclaredSha256',String(process.env.PUBLISHER_FLOW_SOP_SHA256||CONFIG.knowledge?.flow_sop_sha256||''));
put('knowledge:flowSopLoaded',knowledgeLoaded===knowledgeFiles.length?'true':'false');
put('knowledge:flowSopDocumentCount',String(knowledgeLoaded));
put('knowledge:inheritToPublisher','true');
const declaredSopSha=String(process.env.PUBLISHER_FLOW_SOP_SHA256||CONFIG.knowledge?.flow_sop_sha256||'').trim();
if(knowledgeLoaded!==knowledgeFiles.length)throw new Error('FLOW_SOP_KNOWLEDGE_PACK_INCOMPLETE:'+knowledgeLoaded+'/'+knowledgeFiles.length);
if(!masterSha)throw new Error('FLOW_SOP_MASTER_HASH_MISSING');
if(declaredSopSha&&declaredSopSha!==masterSha)throw new Error('FLOW_SOP_HASH_MISMATCH:'+declaredSopSha+':'+masterSha);
console.log('[RUNTIME SOP READY]',JSON.stringify({version:SOP_VERSION,sha256:masterSha,documents:knowledgeLoaded,inherit:true}));
put('automation:exactlyOnceSubmit','true');
put('automation:strictSerialGeneration','true');
put('automation:projectGridRecovery','true');
put('automation:reviewMetadataRequired','true');
put('automation:goldenTestRequired','true');
put('automation:semanticRedoInterpretation','true');
put('automation:postSubmitTimeoutResubmit','false');
put('automation:dailyFlowCreditRefreshGate','true');
put('automation:calendarMidnightOpensBatch','false');
put('automation:dailyFlowCreditGrant','50');
put('automation:paidMonthlyCreditsProtectedUntilDailyRefresh','true');
put('automation:nativeAiDisclosureRequired','true');
put('automation:youtubeContainsSyntheticMediaAlways','true');
put('automation:facebookIsAiGeneratedAlways','true');
put('automation:legacyAiDisclosureRepairEnabled','true');
seedInitial(db);
ensureBacklog(db);
db.close();
