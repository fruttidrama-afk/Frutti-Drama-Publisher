import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-flow-bootstrap';
const AUD='publisher-factory-flow-bootstrap';
const ROOT='/tmp/flow-auth-preflight';
const TAR=ROOT+'/profile.tgz';
const STATE=ROOT+'/flow-auth-state.json';
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
async function report(payload){
  const r=await api('/preflight',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok)throw new Error('PREFLIGHT_REPORT_'+r.status+' '+(await r.text()).slice(0,500));
}
function untar(){
  fs.mkdirSync(ROOT,{recursive:true});
  const r=spawnSync('tar',['-xzf',TAR,'-C',ROOT],{stdio:'inherit'});
  if(r.status!==0)throw new Error('PROFILE_TAR_EXTRACT_FAILED');
}
async function main(){
  fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
  const r=await api('/profile-download');
  if(!r.ok)throw new Error('PROFILE_DOWNLOAD_'+r.status+' '+(await r.text()).slice(0,500));
  fs.writeFileSync(TAR,Buffer.from(await r.arrayBuffer()));
  untar();
  if(!fs.existsSync(STATE))throw new Error('PORTABLE_STATE_MISSING');
  const state=JSON.parse(fs.readFileSync(STATE,'utf8'));
  const browser=await chromium.launch({
    executablePath:'/usr/bin/google-chrome',
    headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--password-store=basic','--no-first-run','--no-default-browser-check']
  });
  let verified=false,url='',projects=[];
  try{
    const ctx=await browser.newContext({
      storageState:state,
      locale:'en-US',
      timezoneId:'America/Argentina/Buenos_Aires',
      viewport:{width:1440,height:900}
    });
    const page=await ctx.newPage();
    await page.goto('https://flow.google.com/',{waitUntil:'domcontentloaded',timeout:60000});
    await sleep(5000);
    url=String(page.url()||'');
    const body=String(await page.locator('body').innerText().catch(()=>'')).slice(0,14000);
    if(/accounts\.google\.com|ServiceLogin|signin\/v2/i.test(url)||/email or phone|enter your password|sign in to continue/i.test(body)){
      throw new Error('PORTABLE_FLOW_AUTH_REJECTED');
    }
    for(let i=0;i<12;i++){await page.mouse.wheel(0,1800).catch(()=>{});await sleep(250)}
    await page.mouse.wheel(0,-26000).catch(()=>{});
    await sleep(700);
    const cards=page.locator('flow-project-card');
    const count=Math.min(await cards.count().catch(()=>0),120);
    for(let i=0;i<count;i++){
      const c=cards.nth(i);
      const name=String(await c.innerText().catch(()=>'')).replace(/\s+/g,' ').trim().slice(0,180);
      const href=String(await c.locator('a[href*="/project/"]').first().getAttribute('href').catch(()=>'')||'');
      const id=href.match(/\/project\/([a-zA-Z0-9-]+)/)?.[1]||'';
      if(id)projects.push({id,name});
    }
    verified=projects.length>0 && /flow\.google\.com/i.test(url);
    if(!verified)throw new Error('FLOW_PROJECT_LIST_NOT_VISIBLE');
    console.log('FLOW_AUTH_PREFLIGHT_OK projects='+projects.length);
    await report({verified:true,url,projects});
    await ctx.close();
  }catch(err){
    await report({verified:false,url,projects}).catch(()=>{});
    throw err;
  }finally{
    await browser.close().catch(()=>{});
  }
}
await main();
