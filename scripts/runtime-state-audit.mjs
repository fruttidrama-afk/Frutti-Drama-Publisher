import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright-core';

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
const expectedProjects={
 frutti:{id:'705d7ac2-30fe-4481-aa4c-076c31a64214',name:'FruttiDrama'},
 earth:{id:'800af820-b951-4035-ab20-f64df8883fb0',name:'EARTH IN 10'},
 dinnie:{id:'67620e0a-7fcf-43c6-9770-eb235ce92a65',name:'Dinnie The Dinosaur'}
};
async function inspectFlowProfile(root,name,id){
 const summary={name,profile_found:false,cookies:0,flow_cookie_count:0,origin_count:0,expected_project:expectedProjects[name]?.id||'',navigated:false,sign_in:false,exact_url:false,editor_visible:false,visible_title_match:false};
 try{
  const res=await fetch(EDGE+'?publisher_id='+encodeURIComponent(id)+'&type=profile',{headers:{authorization:'Bearer '+token}});
  if(!res.ok){summary.error='PROFILE_DOWNLOAD_'+res.status;return summary}
  const base=root+'/profile';fs.mkdirSync(base,{recursive:true});
  const tar=base+'/profile.tgz';fs.writeFileSync(tar,Buffer.from(await res.arrayBuffer()));
  if(spawnSync('tar',['-xzf',tar,'-C',base]).status!==0){summary.error='PROFILE_TAR_INVALID';return summary}
  const statePath=base+'/flow-auth-state.json';
  if(!fs.existsSync(statePath)){summary.error='PORTABLE_STATE_MISSING';return summary}
  const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
  summary.profile_found=true;
  summary.cookies=Array.isArray(state.cookies)?state.cookies.length:0;
  summary.flow_cookie_count=(state.cookies||[]).filter(c=>/google\\.com|youtube\\.com/.test(String(c.domain||''))).length;
  summary.origin_count=Array.isArray(state.origins)?state.origins.length:0;
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  try{
   const ctx=await browser.newContext({storageState:state,locale:'en-US',timezoneId:'America/Argentina/Buenos_Aires',viewport:{width:1440,height:900}});
   const page=await ctx.newPage();
   const project=expectedProjects[name];
   await page.goto('https://flow.google.com/project/'+project.id,{waitUntil:'domcontentloaded',timeout:45000});
   await page.waitForTimeout(3000);
   const url=String(page.url()||''),body=String(await page.locator('body').innerText().catch(()=>'')).slice(0,4500);
   summary.navigated=true;
   summary.sign_in=/accounts\\.google\\.com|ServiceLogin|\\/signin|\\/about(?:$|[?#])/i.test(url)||/email or phone|enter your password|sign in to continue/i.test(body);
   summary.exact_url=url.includes('/project/'+project.id);
   const head=page.locator('input[aria-label="Editable text"]');
   const title=String(await head.first().inputValue().catch(()=>'')).trim();
   summary.visible_title_match=title.toLowerCase()===project.name.toLowerCase();
   summary.editor_visible=(await page.locator('textarea,[contenteditable="true"],flow-grid-tile-container').count().catch(()=>0))>0;
   summary.classification=summary.sign_in?'AUTH_LOGIN_REQUIRED':summary.exact_url&&(summary.visible_title_match||summary.editor_visible)?'PROJECT_ACCESS_PROBABLE':summary.exact_url?'PROJECT_URL_LOADED_UNVERIFIED':'PROJECT_NOT_ACCESSIBLE';
   await ctx.close().catch(()=>{});
  }finally{await browser.close().catch(()=>{})}
 }catch(err){summary.error=String(err?.message||err).slice(0,200)}
 return summary;
}
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
 const credits=safe(()=>db.prepare("SELECT key,value FROM factory_meta WHERE key IN ('flow:lastCreditsVisible','flow:lastCreditsCheckedAt','flow:lastCreditsSource','flow:lastCreditsCheckError','flow:dailyCreditInitialWatch','flow:dailyCreditCycleUsed','flow:dailyCreditCycleOpenedAt','flow:dailyCreditRefreshWaiting') ORDER BY key").all(),[]);
 db.close();
 console.log('RUNTIME_STATE_AUDIT',JSON.stringify({name,id,bytes:fs.statSync(tar).size,meta,counts,gens,credentials,candidateStatePaths,publication,episodes,recovery,credits}));
 console.log('FLOW_READONLY_AUTH_AUDIT',JSON.stringify(await inspectFlowProfile(root,name,id)));
}
