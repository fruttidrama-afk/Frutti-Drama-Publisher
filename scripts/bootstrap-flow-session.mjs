import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const MODE=String(process.argv[2]||'').trim();
const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-flow-bootstrap';
const AUD='publisher-factory-flow-bootstrap';
const CONFIG_FILE=path.resolve(process.env.RUNNER_TEMP||'/tmp','flow-bootstrap-config.json');
const PROFILE_DIR=path.resolve(process.env.FLOW_BOOTSTRAP_PROFILE||path.join(process.env.RUNNER_TEMP||'/tmp','flow-bootstrap-profile'));

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function norm(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
async function oidc(){
  const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||''),req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
  if(!base||!req)throw new Error('GITHUB_OIDC_UNAVAILABLE');
  const url=base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD);
  const r=await fetch(url,{headers:{authorization:'Bearer '+req}});
  if(!r.ok)throw new Error('OIDC_'+r.status);
  const j=await r.json();if(!j.value)throw new Error('OIDC_VALUE_MISSING');
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
async function cdp(){
  for(let i=0;i<120;i++){
    try{
      const r=await fetch('http://127.0.0.1:9222/json/version',{signal:AbortSignal.timeout(700)});
      if(r.ok)return chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:5000});
    }catch{}
    await sleep(1000);
  }
  throw new Error('CHROME_CDP_TIMEOUT');
}
async function authenticated(page){
  const url=String(page.url()||'');
  const body=String(await page.locator('body').innerText().catch(()=>'')).slice(0,16000);
  if(/accounts\.google\.com|ServiceLogin|signin\/v2/i.test(url))return false;
  if(/email or phone|enter your password|verify it'?s you|choose an account|sign in to continue|captcha|security check/i.test(body))return false;
  return /flow\.google\.com/i.test(url)&&body.length>80;
}
async function discoverProjects(browser,cfg){
  const ctx=browser.contexts()[0]||await browser.newContext();
  let page=ctx.pages()[0]||await ctx.newPage();
  await page.goto('https://flow.google.com/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  await sleep(3000);
  const cards=page.locator('flow-project-card');
  const rows=[];
  for(let i=0;i<Math.min(await cards.count().catch(()=>0),80);i++){
    const c=cards.nth(i);if(!(await c.isVisible().catch(()=>false)))continue;
    const txt=String(await c.innerText().catch(()=>'')).replace(/\s+/g,' ').trim();
    const a=c.locator('a[href*="/project/"]').first();
    const href=String(await a.getAttribute('href').catch(()=>'')||'');
    const m=href.match(/\/project\/([a-zA-Z0-9-]+)/);
    if(txt||href)rows.push({txt,href,id:m?.[1]||''});
  }
  console.log('FLOW PROJECTS VISIBLE:',rows.map(x=>({name:x.txt.slice(0,120),id:x.id})));
  for(const t of cfg.targets||[]){
    const expected=norm(t.project_name||t.name);
    let match=null;
    if(t.project_url){
      const mm=String(t.project_url).match(/\/project\/([a-zA-Z0-9-]+)/);
      if(mm)match={id:mm[1],name:t.project_name||t.name};
    }
    if(!match){
      const candidates=rows.filter(x=>{
        const n=norm(x.txt),e=expected;
        return e&&(n===e||n.startsWith(e+' ')||n.includes(e));
      }).filter(x=>x.id);
      if(candidates.length===1)match={id:candidates[0].id,name:t.project_name||t.name};
    }
    if(match){
      const r=await api('/project',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publisher_id:t.id,project_id:match.id,project_name:match.name})});
      if(!r.ok)console.log('Project persist warning',t.name,r.status,(await r.text()).slice(0,300));
      else console.log('Resolved Flow project',t.name,match.id);
    }else{
      console.log('Flow project unresolved',t.name,'— profile will still be saved.');
    }
  }
}
async function waitAuth(){
  const cfg=fs.existsSync(CONFIG_FILE)?JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')):await getConfig();
  const browser=await cdp();
  try{
    const ctx=browser.contexts()[0]||await browser.newContext();
    let stable=0;
    const deadline=Date.now()+48*60*1000;
    while(Date.now()<deadline){
      const pages=ctx.pages();
      const page=[...pages].reverse().find(p=>/flow\.google\.com|accounts\.google\.com/i.test(String(p.url())))||pages[pages.length-1];
      if(page&&await authenticated(page)){stable++;if(stable>=4){console.log('FLOW_AUTHENTICATED');await discoverProjects(browser,cfg);return}}
      else stable=0;
      await sleep(3000);
    }
    throw new Error('FLOW_AUTH_TIMEOUT');
  }finally{
    await browser.close().catch(()=>{});
  }
}
async function upload(){
  const tar=String(process.env.FLOW_BOOTSTRAP_ARCHIVE||'');
  if(!tar||!fs.existsSync(tar))throw new Error('PROFILE_ARCHIVE_MISSING');
  const r=await api('/profile',{method:'PUT',headers:{'content-type':'application/gzip'},body:fs.readFileSync(tar)});
  if(!r.ok)throw new Error('PROFILE_UPLOAD_'+r.status+' '+(await r.text()).slice(0,500));
  console.log('PROFILE_UPLOAD_OK',await r.text());
}
async function announce(){
  const url=String(process.env.FLOW_BOOTSTRAP_URL||'').trim();
  const password=String(process.env.FLOW_BOOTSTRAP_PASSWORD||'').trim();
  const r=await api('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,password})});
  if(!r.ok)throw new Error('SESSION_ANNOUNCE_'+r.status+' '+(await r.text()).slice(0,500));
  console.log('SESSION_ANNOUNCED');
}
if(MODE==='config'){
  const j=await getConfig();
  process.stdout.write(String(j.start_url||'https://flow.google.com/'));
}else if(MODE==='wait'){
  await waitAuth();
}else if(MODE==='upload'){
  await upload();
}else if(MODE==='announce'){
  await announce();
}else{
  throw new Error('MODE must be config|wait|upload|announce');
}
// BOOTSTRAP_RESTART_MARKER: 2026-10-07-resume-1416
