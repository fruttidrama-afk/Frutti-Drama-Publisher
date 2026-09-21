
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG, seedInitial, ensureBacklog } from './runtime-config.js';

const DATA_DIR=path.resolve(process.env.DATA_DIR||'/data');
const DIR=path.join(DATA_DIR,'publisher-runtime');
const DB_PATH=path.join(DIR,'factory.sqlite');
const INSTANCE_MARKER=path.join(DATA_DIR,'publisher-instance.json');
const INSTANCE_ID=String(process.env.PUBLISHER_INSTANCE_ID||'').trim();
const RESET_ON_CHANGE=String(process.env.PUBLISHER_RESET_ON_INSTANCE_CHANGE||'false').toLowerCase()==='true';

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
 transportPreflight TEXT,
 runtimeAttemptCount INTEGER NOT NULL DEFAULT 0,
 lastProgressAt TEXT,
 reviewVideoId TEXT,
 reviewArchivedAt TEXT,
 reviewOriginalSize INTEGER,
 reviewPreviewSize INTEGER,
 reviewArchiveError TEXT,
 reviewFeedback TEXT,
 retryStrategy TEXT,
 reviewRetryToken TEXT,
 reviewRetrySubmittedToken TEXT,
 reviewContentHash TEXT,
 createdAt TEXT NOT NULL,
 updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS factory_status_idx ON factory_items(status,nextTry,episode);
CREATE TABLE IF NOT EXISTS factory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
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
const put=(k,v)=>db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v));
put('runtime:version','publisher-runtime-v1');
put('runtime:show',CONFIG.identity.show_name);
put('automation:provider','FreeBrowserProvider');
put('automation:tinyfishRequired','false');
put('automation:tinyfishFallback','disabled');
put('automation:factoryEnabled',String(process.env.PUBLISHER_ENABLED||'false').toLowerCase()==='true'?'true':'false');
put('automation:noEndDate','true');
put('automation:planner',CONFIG.content.serialized?'serial-config-v1':'independent-config-v1');
seedInitial(db);
ensureBacklog(db);
db.close();
