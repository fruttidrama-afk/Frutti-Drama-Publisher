import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';

const PUBLISHER_ID='7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7';
const PROJECT_URL='https://flow.google.com/project/705d7ac2-30fe-4481-aa4c-076c31a64214';
const ORCH='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-frutti-readonly-profile';
const AUD='publisher-factory-frutti-readonly-audit';
const root=path.join(process.env.RUNNER_TEMP||'/tmp','frutti-readonly-audit');
const profileTar=path.join(root,'profile.tgz');
const factory=path.join(root,'publisher-runtime');
const stateFile=path.join(factory,'flow-auth-state.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function oidc(){
  const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||''),req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
  const u=base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD);
  const r=await fetch(u,{headers:{authorization:'Bearer '+req}});
  if(!r.ok)throw new Error('OIDC_'+r.status);
  return String((await r.json()).value||'');
}
const token=await oidc();
fs.rmSync(root,{recursive:true,force:true});fs.mkdirSync(factory,{recursive:true});
const res=await fetch(ORCH,{headers:{authorization:'Bearer '+token}});
if(!res.ok)throw new Error('PROFILE_'+res.status);
fs.writeFileSync(profileTar,Buffer.from(await res.arrayBuffer()));
const {spawnSync}=await import('node:child_process');
if(spawnSync('tar',['-xzf',profileTar,'-C',factory]).status!==0)throw new Error('TAR_FAILED');
const storage=JSON.parse(fs.readFileSync(stateFile,'utf8'));
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{
  const ctx=await browser.newContext({storageState:storage,locale:'en-US',timezoneId:'America/Argentina/Buenos_Aires',viewport:{width:1440,height:900}});
  const page=await ctx.newPage();
  await page.goto(PROJECT_URL,{waitUntil:'domcontentloaded',timeout:60000});
  await sleep(5000);
  const body=String(await page.locator('body').innerText().catch(()=>'')).slice(0,12000);
  if(/email or phone|enter your password|sign in to continue/i.test(body))throw new Error('AUTH_REQUIRED');
  const title=String(await page.title().catch(()=>''));
  console.log('FRUTTI_READONLY_URL',JSON.stringify(String(page.url()||'')));
  console.log('FRUTTI_READONLY_BODY',JSON.stringify(body.slice(0,2500)));
  const chars=page.getByText('Characters',{exact:true}).first();
  if(await chars.isVisible().catch(()=>false)){await chars.click();await sleep(4500);}
  const candidates=await page.evaluate(()=>{
    const out=[];
    for(const el of document.querySelectorAll('[role="option"],flow-character-card,flow-grid-tile-container')){
      const r=el.getBoundingClientRect();if(r.width<20||r.height<20)continue;
      const aria=String(el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
      const text=String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
      const v=aria||text;if(v&&v.length<160)out.push(v);
    }
    return [...new Set(out)];
  });
  console.log('FRUTTI_READONLY_PROJECT_TITLE',JSON.stringify(title));
  console.log('FRUTTI_READONLY_CHARACTERS',JSON.stringify(candidates));

  async function collectVisible(label){
    const nav=page.getByText(label,{exact:true}).first();
    if(await nav.isVisible().catch(()=>false)){await nav.click();await sleep(3500);}
    const vals=await page.evaluate(()=>{
      const out=[];
      const sels=['flow-grid-tile-container','flow-character-card','[role="option"]','[role="listitem"]'];
      for(const sel of sels){
        for(const el of document.querySelectorAll(sel)){
          const r=el.getBoundingClientRect();
          if(r.width<20||r.height<20||r.bottom<80)continue;
          const aria=String(el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
          const text=String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
          const v=aria||text;
          if(v&&v.length<220)out.push(v);
        }
      }
      return [...new Set(out)];
    });
    return vals;
  }
  const videoTiles=await collectVisible('Videos');
  console.log('FRUTTI_READONLY_VIDEOS',JSON.stringify(videoTiles));
  const characterTiles=await collectVisible('Personajes');
  console.log('FRUTTI_READONLY_PERSONAJES',JSON.stringify(characterTiles));
  await ctx.close();
}finally{await browser.close().catch(()=>{})}
// FRESH_FRUTTI_AUTH_AUDIT: 2026-10-07T22:55-03:00
