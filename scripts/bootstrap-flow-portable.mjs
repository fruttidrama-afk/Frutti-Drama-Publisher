import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const MODE=String(process.argv[2]||'').trim();
const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-flow-bootstrap';
const AUD='publisher-factory-flow-bootstrap';
const CONFIG_FILE='/tmp/flow-bootstrap-config.json';
const STATE_FILE='/tmp/flow-auth-state.json';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const norm=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

async function oidc(){
  const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
  const req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
  if(!base||!req)throw new Error('GITHUB_OIDC_UNAVAILABLE');
  const url=base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD);
  const r=await fetch(url,{headers:{authorization:'Bearer '+req}});
  if(!r.ok)throw new Error('OIDC_'+r.status);
  const j=await r.json();
  if(!j.value)throw new Error('OIDC_VALUE_MISSING');
  return String(j.value);
}
async function api(suffix,options={}){
  const token=await oidc();
  return fetch(EDGE+suffix,{...options,headers:{authorization:'Bearer '+token,...(options.headers||{})}});
}
async function getConfig(){
  const r=await api('/config');
  if(!r.ok)throw new Error('CONFIG_'+r.status+' '+(await r.text()).slice(0,500));
  const j=await r.json();
  fs.writeFileSync(CONFIG_FILE,JSON.stringify(j,null,2));
  return j;
}
async function announce(){
  const url=String(process.env.FLOW_BOOTSTRAP_URL||'').trim();
  const password=String(process.env.FLOW_BOOTSTRAP_PASSWORD||'').trim();
  const r=await api('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,password})});
  if(!r.ok)throw new Error('SESSION_ANNOUNCE_'+r.status+' '+(await r.text()).slice(0,500));
  console.log('SESSION_ANNOUNCED');
}
async function waitSignal(){
  const deadline=Date.now()+50*60*1000;
  while(Date.now()<deadline){
    const cfg=await getConfig();
    if((cfg.targets||[]).some(x=>String(x.migration_state||'')==='capture_requested')){
      console.log('CAPTURE_REQUESTED');
      return;
    }
    await sleep(3000);
  }
  throw new Error('CAPTURE_SIGNAL_TIMEOUT');
}
async function persistProject(t,id,name){
  const r=await api('/project',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publisher_id:t.id,project_id:id,project_name:name})});
  if(!r.ok)console.log('PROJECT_PERSIST_WARNING',t.name,r.status);
  else console.log('RESOLVED_FLOW_PROJECT',t.name,id);
}
async function capture(){
  const cfg=fs.existsSync(CONFIG_FILE)?JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')):await getConfig();
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:15000});
  try{
    const ctx=browser.contexts()[0];
    if(!ctx)throw new Error('FLOW_BROWSER_CONTEXT_MISSING');
    const pages=ctx.pages();
    const page=[...pages].reverse().find(p=>/flow\.google\.com/i.test(String(p.url())))||pages[pages.length-1];
    if(!page)throw new Error('FLOW_PAGE_MISSING');
    const url=String(page.url()||'');
    const body=String(await page.locator('body').innerText().catch(()=>'')).slice(0,12000);
    if(/accounts\.google\.com|ServiceLogin|signin\/v2/i.test(url)||/email or phone|enter your password|sign in to continue/i.test(body)){
      throw new Error('FLOW_SESSION_NOT_AUTHENTICATED');
    }
    await page.goto('https://flow.google.com/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    await sleep(3000);
    const visibleProjectCards=await page.locator('flow-project-card').count().catch(()=>0);
    if(visibleProjectCards<1)throw new Error('FLOW_AUTHENTICATION_NOT_CONFIRMED');
    for(let i=0;i<10;i++){await page.mouse.wheel(0,1800).catch(()=>{});await sleep(300)}
    await page.mouse.wheel(0,-25000).catch(()=>{});
    const cards=page.locator('flow-project-card');
    const rows=[];
    for(let i=0;i<Math.min(await cards.count().catch(()=>0),120);i++){
      const c=cards.nth(i);
      const txt=String(await c.innerText().catch(()=>'')).replace(/\s+/g,' ').trim();
      const href=String(await c.locator('a[href*="/project/"]').first().getAttribute('href').catch(()=>'')||'');
      const id=href.match(/\/project\/([a-zA-Z0-9-]+)/)?.[1]||'';
      if(id)rows.push({id,text:txt});
    }
    console.log('FLOW_PROJECT_COUNT',rows.length);
    for(const t of cfg.targets||[]){
      const existing=String(t.project_url||'').match(/\/project\/([a-zA-Z0-9-]+)/)?.[1]||'';
      if(existing){await persistProject(t,existing,t.project_name||t.name);continue}
      const expected=norm(t.project_name||t.name);
      const matches=rows.filter(x=>{
        const n=norm(x.text);
        return expected&&(n===expected||n.startsWith(expected+' ')||n.includes(expected));
      });
      if(matches.length===1)await persistProject(t,matches[0].id,t.project_name||t.name);
      else console.log('FLOW_PROJECT_UNRESOLVED',t.name,'matches='+matches.length);
    }
    await ctx.storageState({path:STATE_FILE});
    const size=fs.statSync(STATE_FILE).size;
    console.log('FLOW_STORAGE_STATE_CAPTURED',size);
    if(size<500)throw new Error('FLOW_STORAGE_STATE_TOO_SMALL');
  }finally{
    await browser.close().catch(()=>{});
  }
}
async function upload(){
  const file=String(process.env.FLOW_BOOTSTRAP_ARCHIVE||'');
  if(!file||!fs.existsSync(file))throw new Error('PROFILE_ARCHIVE_MISSING');
  const r=await api('/profile',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:fs.readFileSync(file)});
  if(!r.ok)throw new Error('PROFILE_UPLOAD_'+r.status+' '+(await r.text()).slice(0,500));
  console.log('PROFILE_UPLOAD_OK',await r.text());
}

if(MODE==='config'){
  const j=await getConfig();
  process.stdout.write(String(j.start_url||'https://flow.google.com/'));
}else if(MODE==='announce')await announce();
else if(MODE==='waitsignal')await waitSignal();
else if(MODE==='capture')await capture();
else if(MODE==='upload')await upload();
else throw new Error('MODE_INVALID');
