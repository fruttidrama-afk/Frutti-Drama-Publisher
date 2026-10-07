import fs from 'node:fs';
import { chromium } from 'playwright-core';

const KEY=String(process.env.TARGET_KEY||'').trim().toLowerCase();
if(!['earth','dinnie'].includes(KEY))throw new Error('TARGET_KEY_INVALID');
const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-flow-account-bootstrap-v2';
const AUD='publisher-factory-flow-account-bootstrap-v2';
const STATE='/tmp/flow-auth-state.json';
const CONFIG='/tmp/flow-account-config.json';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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
  const r=await api('/config/'+KEY);
  if(!r.ok)throw new Error('CONFIG_'+r.status+' '+(await r.text()).slice(0,500));
  const j=await r.json();
  fs.writeFileSync(CONFIG,JSON.stringify(j,null,2));
  return j;
}
async function announce(){
  const url=String(process.env.FLOW_BOOTSTRAP_URL||'').trim();
  const r=await api('/session/'+KEY,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
  if(!r.ok)throw new Error('SESSION_ANNOUNCE_'+r.status+' '+(await r.text()).slice(0,500));
  console.log('SESSION_ANNOUNCED');
}
async function waitSignal(){
  const deadline=Date.now()+50*60*1000;
  while(Date.now()<deadline){
    const cfg=await getConfig();
    if(String(cfg.migration_state||'')==='capture_requested'){
      console.log('CAPTURE_REQUESTED');
      return cfg;
    }
    await sleep(3000);
  }
  throw new Error('CAPTURE_SIGNAL_TIMEOUT');
}
async function capture(){
  const cfg=fs.existsSync(CONFIG)?JSON.parse(fs.readFileSync(CONFIG,'utf8')):await getConfig();
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:15000});
  try{
    const ctx=browser.contexts()[0];
    if(!ctx)throw new Error('FLOW_BROWSER_CONTEXT_MISSING');
    let page=[...ctx.pages()].reverse().find(p=>/flow\.google\.com|accounts\.google\.com/i.test(String(p.url())))||ctx.pages()[0];
    if(!page)page=await ctx.newPage();

    const target=String(cfg.start_url||'https://flow.google.com/');
    await page.goto(target,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    await sleep(4500);

    const url=String(page.url()||'');
    const body=String(await page.locator('body').innerText().catch(()=>'')).slice(0,14000);
    if(/accounts\.google\.com|ServiceLogin|signin\/v2/i.test(url)||/email or phone|enter your password|sign in to continue/i.test(body)){
      throw new Error('FLOW_SESSION_NOT_AUTHENTICATED');
    }

    const expected=String(cfg.expected_project_id||'');
    let projectId=url.match(/\/project\/([a-zA-Z0-9-]+)/)?.[1]||'';
    let observedName=String(await page.title().catch(()=>'')).slice(0,180);

    if(expected){
      if(projectId!==expected)throw new Error('FLOW_EXPECTED_PROJECT_NOT_OPEN');
    }else if(!projectId){
      await page.goto('https://flow.google.com/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
      await sleep(3500);
      const cards=page.locator('flow-project-card');
      const wanted=String(cfg.project_name||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      const matches=[];
      for(let i=0;i<Math.min(await cards.count().catch(()=>0),120);i++){
        const c=cards.nth(i);
        const txt=String(await c.innerText().catch(()=>'')).replace(/\s+/g,' ').trim();
        const n=txt.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
        const href=String(await c.locator('a[href*="/project/"]').first().getAttribute('href').catch(()=>'')||'');
        const id=href.match(/\/project\/([a-zA-Z0-9-]+)/)?.[1]||'';
        if(id&&wanted&&(n===wanted||n.startsWith(wanted+' ')||n.includes(wanted)))matches.push({id,name:txt});
      }
      if(matches.length!==1)throw new Error('FLOW_TARGET_PROJECT_UNRESOLVED_'+matches.length);
      projectId=matches[0].id;
      observedName=matches[0].name;
      await page.goto('https://flow.google.com/project/'+projectId,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
      await sleep(2500);
    }

    await ctx.storageState({path:STATE});
    if(!fs.existsSync(STATE)||fs.statSync(STATE).size<500)throw new Error('FLOW_STORAGE_STATE_INVALID');

    const pr=await api('/project/'+KEY,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:projectId,project_name:observedName||cfg.project_name})});
    if(!pr.ok)throw new Error('PROJECT_PERSIST_'+pr.status+' '+(await pr.text()).slice(0,400));
    console.log('FLOW_ACCOUNT_CAPTURED',KEY,projectId);
  }finally{
    await browser.close().catch(()=>{});
  }
}
async function upload(){
  const file=String(process.env.FLOW_BOOTSTRAP_ARCHIVE||'');
  if(!file||!fs.existsSync(file))throw new Error('PROFILE_ARCHIVE_MISSING');
  const r=await api('/profile/'+KEY,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:fs.readFileSync(file)});
  if(!r.ok)throw new Error('PROFILE_UPLOAD_'+r.status+' '+(await r.text()).slice(0,500));
  console.log('PROFILE_UPLOAD_OK');
}
async function complete(){
  const r=await api('/complete/'+KEY,{method:'POST'});
  if(!r.ok)throw new Error('COMPLETE_'+r.status+' '+(await r.text()).slice(0,500));
  const j=await r.json();
  if(!j.ready)throw new Error('BOOTSTRAP_NOT_READY');
  console.log('FLOW_ACCOUNT_BOOTSTRAP_COMPLETE',KEY,j.project_id);
}

const mode=String(process.argv[2]||'');
if(mode==='config'){const j=await getConfig();process.stdout.write(String(j.start_url||'https://flow.google.com/'))}
else if(mode==='announce')await announce();
else if(mode==='waitsignal')await waitSignal();
else if(mode==='capture')await capture();
else if(mode==='upload')await upload();
else if(mode==='complete')await complete();
else throw new Error('MODE_INVALID');
