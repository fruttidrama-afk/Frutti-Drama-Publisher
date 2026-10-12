import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const URL='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-frutti-state-audit';
const AUD='publisher-factory-frutti-state-audit';
const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
const access=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
if(!base||!access)throw Error('GITHUB_OIDC_MISSING');
const identity=await fetch(base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD),
 {headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(20000)});
if(!identity.ok)throw Error('OIDC_DENIED_'+identity.status);
const jwt=String((await identity.json()).value||'');
const state=await fetch(URL,{headers:{authorization:'Bearer '+jwt},signal:AbortSignal.timeout(60000)});
if(!state.ok)throw Error('SUPABASE_STATE_NOT_READABLE_'+state.status);
const data=Buffer.from(await state.arrayBuffer());
if(data.length<1024||data.length>150000000)throw Error('INVALID_ARCHIVE_BYTES');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'frutti-prompt-audit-'));
try{
 const archive=path.join(root,'state.tgz');
 fs.writeFileSync(archive,data,{mode:0o600});
 const tar=spawnSync('tar',['-xzf',archive,'-C',root,'--no-same-owner'],{encoding:'utf8',timeout:60000});
 if(tar.status!==0)throw Error('ARCHIVE_EXTRACT_FAILED');
 const sqlite=path.join(root,'publisher-runtime','factory.sqlite');
 if(!fs.existsSync(sqlite))throw Error('EXPECTED_SQLITE_NOT_FOUND');
 const db=new DatabaseSync(sqlite,{readOnly:true});
 try{
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(z=>z.name);
  console.log('PROMPT_ARCHIVE_META',JSON.stringify({archive_bytes:data.length,tables:names,
   state_archive:'publisher-runtime-state/7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7/state.tgz'}));
  const summaries=db.prepare("SELECT season, status,COUNT(*) n, SUM(CASE WHEN LENGTH(TRIM(COALESCE(prompt,'')))>0 THEN 1 ELSE 0 END) prompts_present,MIN(episode) min_episode,MAX(episode) max_episode FROM factory_items GROUP BY season,status ORDER BY season,status").all();
  console.log('PROMPT_ARCHIVE_COUNTS',JSON.stringify(summaries));
  const rows=db.prepare("SELECT id,season,episode,hook,status,attempt,revision,LENGTH(COALESCE(prompt,'')) prompt_len, LENGTH(COALESCE(story,'')) story_len, substr(COALESCE(promptHash,''),1,14) prompt_sha14 FROM factory_items ORDER BY season,episode").all();
  console.log('PROMPT_ARCHIVE_INDEX',JSON.stringify(rows.map(x=>({season:x.season,episode:x.episode,hook:String(x.hook||'').slice(0,70),status:x.status,revision:x.revision,attempt:x.attempt,prompt_chars:x.prompt_len,story_chars:x.story_len,prompt_sha14:x.prompt_sha14}))));
  const prompts=rows.filter(x=>Number(x.prompt_len)>50);
  console.log('PROMPT_ARCHIVE_VERDICT',JSON.stringify({total_items:rows.length,prompts_over_50:prompts.length,season_set:[...new Set(rows.map(x=>x.season))],episode_boundaries:{earliest:rows[0]?.episode||null,latest:rows.at(-1)?.episode||null},contains_season2:rows.some(x=>x.season===2),contains_season3:rows.some(x=>x.season===3),needs_historical_railway_db:!rows.some(x=>x.season===2)}));
  const generations=names.includes('factory_generations')?db.prepare("SELECT COUNT(*) n,COUNT(DISTINCT promptHash) hashes FROM factory_generations").get():null;
  const history=names.includes('publication_items')?db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) published FROM publication_items").get():null;
  console.log('PROMPT_ARCHIVE_ASSOCIATED',JSON.stringify({generation_rows:generations,publication_rows:history}));
 }finally{db.close()}
}finally{fs.rmSync(root,{recursive:true,force:true})}
