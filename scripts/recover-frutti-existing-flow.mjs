import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from 'playwright-core';

const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-frutti-state-repair';
const AUD='publisher-factory-frutti-state-repair';
const ROOT='/tmp/frutti-existing-recovery';
const DATA=ROOT+'/data';
const FACTORY=DATA+'/publisher-runtime';
const STATE_TAR=ROOT+'/state.tgz';
const PROFILE_TAR=ROOT+'/profile.tgz';
const OUT=ROOT+'/state-with-review.tgz';
const PROJECT='705d7ac2-30fe-4481-aa4c-076c31a64214';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const targets=[
 {ep:1,hook:'NUEVO COMIENZO',edit:'cce7c635-3009-4481-ac50-e7bd8d7d9587'},
 {ep:2,hook:'BESO INTERRUMPIDO',edit:'840d3fe0-c225-4411-85a9-118376b1a984'},
 {ep:3,hook:'CELOS DE FRESIA',edit:'7dbe5205-479a-40c9-ac4b-720d6956f6e9'},
 {ep:4,hook:'DUDA DE UVA',edit:'18acc4eb-ab1f-4c4b-8daa-30053cca939c'},
 {ep:5,hook:'LÍMITE FINAL',edit:'bcd0ce4b-01da-404a-89be-54b54857450e'},
 {ep:6,hook:'FRESIA CONTRAATACA',edit:'9d6001f4-ad9c-40c1-943c-c241ffcc2bc7'}
];

async function oidc(){
 const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||''),req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
 if(!base||!req)throw new Error('OIDC_UNAVAILABLE');
 const r=await fetch(base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD),{headers:{authorization:'Bearer '+req}});
 if(!r.ok)throw new Error('OIDC_'+r.status);
 return String((await r.json()).value||'');
}
async function api(suffix,options={}){
 return fetch(EDGE+suffix,{...options,headers:{authorization:'Bearer '+TOKEN,...(options.headers||{})}});
}
function untar(file,dest){
 fs.mkdirSync(dest,{recursive:true});
 const r=spawnSync('tar',['-xzf',file,'-C',dest],{stdio:'inherit'});
 if(r.status!==0)throw new Error('TAR_FAILED '+file);
}
function validate(file){
 const st=fs.statSync(file);
 if(st.size<100000)throw new Error('MP4_TOO_SMALL '+st.size);
 if(!fs.readFileSync(file).subarray(0,128).includes(Buffer.from('ftyp')))throw new Error('MP4_FTYP_MISSING');
 const raw=execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',file],{encoding:'utf8',timeout:30000});
 const p=JSON.parse(raw),v=(p.streams||[]).find(x=>x.codec_type==='video');
 if(!v)throw new Error('MP4_VIDEO_STREAM_MISSING');
 const duration=Number(p?.format?.duration||0);
 if(duration<6||duration>14)throw new Error('MP4_DURATION_UNEXPECTED '+duration);
 return{size:st.size,duration,width:Number(v.width||0),height:Number(v.height||0),codec:String(v.codec_name||'')};
}
async function captureDownload(page,locator,file,timeout=5000){
 const pending=page.waitForEvent('download',{timeout}).catch(()=>null);
 await locator.click({force:true}).catch(()=>{});
 const dl=await pending;
 if(!dl)return false;
 await dl.saveAs(file);
 return true;
}
async function downloadOpenVideo(page,file){
 fs.rmSync(file,{force:true});
 const trigger=page.getByRole('button',{name:/Download|Descargar/i}).last();
 if(!(await trigger.isVisible().catch(()=>false)))throw new Error('DOWNLOAD_CONTROL_NOT_VISIBLE');
 if(await captureDownload(page,trigger,file,4500))return'Direct download';
 await sleep(500);
 const menu=page.locator('flow-menu-item,[role="menuitem"]');
 const opts=[];
 for(let i=0;i<Math.min(await menu.count().catch(()=>0),30);i++){
   const el=menu.nth(i);
   if(!(await el.isVisible().catch(()=>false)))continue;
   const label=String((await el.innerText().catch(()=>''))||'')+' '+String((await el.getAttribute('aria-label').catch(()=>''))||'');
   opts.push({el,label:label.replace(/\s+/g,' ').trim()});
 }
 const chosen=opts.find(x=>/720|original|standard|normal/i.test(x.label)&&!/1080|upscal|gif/i.test(x.label))
   ||opts.find(x=>!/1080|upscal|gif/i.test(x.label))
   ||opts[0];
 if(!chosen)throw new Error('DOWNLOAD_MENU_EMPTY');
 if(!await captureDownload(page,chosen.el,file,60000))throw new Error('DOWNLOAD_TIMEOUT '+chosen.label);
 return chosen.label||'Flow native';
}

const TOKEN=await oidc();
fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(DATA,{recursive:true});

for(const [suffix,file] of [['/state',STATE_TAR],['/profile',PROFILE_TAR]]){
 const r=await api(suffix);
 if(!r.ok)throw new Error('GET_'+suffix+'_'+r.status+' '+(await r.text()).slice(0,300));
 fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));
}
const cfgRes=await api('/config');
if(!cfgRes.ok)throw new Error('CONFIG_'+cfgRes.status+' '+(await cfgRes.text()).slice(0,300));
const config=await cfgRes.json();

untar(STATE_TAR,DATA);
untar(PROFILE_TAR,FACTORY);
fs.writeFileSync(DATA+'/publisher-config.json',JSON.stringify(config,null,2));

process.env.DATA_DIR=DATA;
process.env.PUBLISHER_CONFIG_JSON=JSON.stringify(config);
process.env.PUBLISHER_ENABLED='false';
await import('../runtime-init.js?fruttiRecovery='+Date.now());

const authState=FACTORY+'/flow-auth-state.json';
if(!fs.existsSync(authState))throw new Error('FLOW_AUTH_STATE_MISSING');
const storage=JSON.parse(fs.readFileSync(authState,'utf8'));
const browser=await chromium.launch({
 executablePath:'/usr/bin/google-chrome',
 headless:true,
 args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--password-store=basic','--no-first-run','--no-default-browser-check']
});

const dbPath=FACTORY+'/factory.sqlite';
const db=new DatabaseSync(dbPath);
fs.mkdirSync(FACTORY+'/generated',{recursive:true});
const recovered=[];
try{
 const ctx=await browser.newContext({storageState:storage,locale:'en-US',timezoneId:'America/Argentina/Buenos_Aires',viewport:{width:1440,height:900}});
 const page=await ctx.newPage();
 for(const t of targets){
   const row=db.prepare('select * from factory_items where season=3 and episode=?').get(t.ep);
   if(!row)throw new Error('T3E'+t.ep+'_ROW_MISSING');
   const dest=path.join(FACTORY,'generated',row.id+'.mp4');
   if(row.status==='review'&&fs.existsSync(dest)){
     recovered.push({episode:t.ep,existing:true,size:fs.statSync(dest).size});
     continue;
   }
   const url='https://flow.google.com/project/'+PROJECT+'/edit/'+t.edit;
   await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
   await sleep(4200);
   const current=String(page.url()||'');
   const body=String(await page.locator('body').innerText().catch(()=>''));
   if(!current.includes('/project/'+PROJECT+'/edit/'+t.edit))throw new Error('T3E'+t.ep+'_WRONG_EDIT_URL '+current);
   if(!body.includes('FRUTTIDRAMA T3E'+t.ep)||!body.includes(t.hook))throw new Error('T3E'+t.ep+'_PROMPT_IDENTITY_MISMATCH');
   const method=await downloadOpenVideo(page,dest);
   const valid=validate(dest);
   const flowResult={
     provider:'FreeBrowserProvider',
     targeted_existing_recovery:true,
     no_new_generation:true,
     generation_submit_forbidden:true,
     recovery_proof:'exact-flow-edit-url-and-prompt-identity',
     flow_edit_id:t.edit,
     flow_edit_url:url,
     recovery_signature:'FRUTTIDRAMA T3E'+t.ep+' '+t.hook,
     duration:valid.duration,width:valid.width,height:valid.height,size:valid.size,codec:valid.codec,
     validated_ftyp:true,download_quality:method,retrieved_at:new Date().toISOString(),
     review_storage:'private-runtime-state-until-approval'
   };
   const stamp=new Date().toISOString();
   db.prepare("update factory_items set status='review',videoPath=?,remoteUrl=null,reviewVideoId=null,reviewOriginalSize=?,flowResult=?,error=null,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? where id=?")
     .run(dest,valid.size,JSON.stringify(flowResult),stamp,stamp,row.id);
   try{
     db.prepare("insert into factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) values(lower(hex(randomblob(16))),?,?,?,?,?,?,?,?,?,?)")
       .run(row.id,'2026-10-07','recovery:t3e'+t.ep,0,'review','existing-flow-edit:'+t.edit,stamp,stamp,'existing-render-recovery-no-new-generation','recovery');
   }catch{}
   recovered.push({episode:t.ep,edit:t.edit,size:valid.size,duration:valid.duration,resolution:valid.width+'x'+valid.height,method});
   console.log('FRUTTI_EXISTING_RECOVERED',JSON.stringify(recovered.at(-1)));
 }
 await ctx.close();
}finally{
 db.close();
 await browser.close().catch(()=>{});
}

fs.rmSync(OUT,{force:true});
const pack=spawnSync('tar',['-czf',OUT,'-C',DATA,'.'],{stdio:'inherit'});
if(pack.status!==0)throw new Error('STATE_PACK_FAILED');
const up=await api('/state',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:fs.readFileSync(OUT)});
if(!up.ok)throw new Error('STATE_UPLOAD_'+up.status+' '+(await up.text()).slice(0,300));
console.log('FRUTTI_EXISTING_RECOVERY_COMPLETE',JSON.stringify({recovered,state_bytes:fs.statSync(OUT).size,upload:await up.text()}));
