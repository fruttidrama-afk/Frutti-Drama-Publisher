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
  const videoDetails=await page.evaluate(()=>{
    const out=[];
    const els=[...document.querySelectorAll('flow-grid-tile-container')].slice(0,20);
    for(const el of els){
      const attrs={};
      for(const a of el.attributes||[])attrs[a.name]=String(a.value||'').slice(0,300);
      const links=[...el.querySelectorAll('a')].map(a=>({href:String(a.getAttribute('href')||'').slice(0,500),aria:String(a.getAttribute('aria-label')||'').slice(0,300)}));
      const buttons=[...el.querySelectorAll('button')].map(b=>({aria:String(b.getAttribute('aria-label')||'').slice(0,300),title:String(b.getAttribute('title')||'').slice(0,300)}));
      const text=String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,500);
      out.push({text,attrs,links,buttons});
    }
    return out;
  });
  console.log('FRUTTI_READONLY_VIDEO_DETAILS',JSON.stringify(videoDetails));
  const recentPrompts=[];
  const cards=page.locator('flow-grid-tile-container');
  const cardCount=Math.min(await cards.count().catch(()=>0),8);
  for(let i=0;i<cardCount;i++){
    const card=cards.nth(i);
    const label=String(await card.getAttribute('aria-label').catch(()=>'')||'').trim();
    const reuse=card.getByRole('button',{name:/Volver a usar la instrucción|Reuse prompt/i}).first();
    if(!(await reuse.isVisible().catch(()=>false))){recentPrompts.push({label,prompt:''});continue;}
    await reuse.click().catch(()=>{});
    await sleep(1400);
    const prompt=await page.evaluate(()=>{
      const ta=[...document.querySelectorAll('textarea')].find(x=>x.offsetParent!==null);
      if(ta&&String(ta.value||'').trim())return String(ta.value||'').trim();
      const editors=[...document.querySelectorAll('[contenteditable="true"]')].filter(x=>x.offsetParent!==null);
      for(const el of editors){
        const v=String(el.innerText||el.textContent||'').trim();
        if(v.length>20)return v;
      }
      const inputs=[...document.querySelectorAll('input')].filter(x=>x.offsetParent!==null);
      for(const el of inputs){
        const v=String(el.value||'').trim();
        if(v.length>20)return v;
      }
      return '';
    });
    recentPrompts.push({label,prompt:String(prompt||'').slice(0,12000)});
    await page.keyboard.press('Escape').catch(()=>{});
    await page.goto(PROJECT_URL,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
    await sleep(2400);
    const videosNav=page.getByText('Videos',{exact:true}).first();
    if(await videosNav.isVisible().catch(()=>false)){await videosNav.click().catch(()=>{});await sleep(1800);}
  }
  console.log('FRUTTI_READONLY_RECENT_PROMPTS',JSON.stringify(recentPrompts));

  const openedDetails=[];
  await page.goto(PROJECT_URL,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  await sleep(2400);
  const videosNav2=page.getByText('Videos',{exact:true}).first();
  if(await videosNav2.isVisible().catch(()=>false)){await videosNav2.click().catch(()=>{});await sleep(1800);}
  for(let i=0;i<Math.min(await page.locator('flow-grid-tile-container').count().catch(()=>0),6);i++){
    const card=page.locator('flow-grid-tile-container').nth(i);
    const label=String(await card.getAttribute('aria-label').catch(()=>'')||'').trim();
    await card.click().catch(()=>{});
    await sleep(1600);
    const detailBody=String(await page.locator('body').innerText().catch(()=>'')).replace(/\s+/g,' ').trim().slice(0,6000);
    const detailUrl=String(page.url()||'');
    openedDetails.push({label,url:detailUrl,body:detailBody});
    await page.keyboard.press('Escape').catch(()=>{});
    await sleep(500);
    if(!/\/project\//.test(String(page.url()||''))){
      await page.goto(PROJECT_URL,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
      await sleep(1800);
      const vn=page.getByText('Videos',{exact:true}).first();
      if(await vn.isVisible().catch(()=>false)){await vn.click().catch(()=>{});await sleep(1200);}
    }
  }
  console.log('FRUTTI_READONLY_OPENED_VIDEO_DETAILS',JSON.stringify(openedDetails));
  const videoMeta=await page.evaluate(()=>[...document.querySelectorAll('flow-grid-tile-container')].slice(0,10).map((el,i)=>({
    i,
    text:String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,260),
    aria:String(el.getAttribute('aria-label')||'').slice(0,260),
    title:String(el.getAttribute('title')||'').slice(0,260)
  })));
  console.log('FRUTTI_READONLY_VIDEO_META',JSON.stringify(videoMeta));
  const latestDetails=[];
  for(let i=0;i<6;i++){
    const tile=page.locator('flow-grid-tile-container').nth(i);
    if(!(await tile.isVisible().catch(()=>false)))break;
    const aria=String(await tile.getAttribute('aria-label').catch(()=>'')||'');
    await tile.click();
    await sleep(1800);
    const detail=String(await page.locator('body').innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,12000);
    latestDetails.push({index:i,aria,detail});
    const back=page.getByText('arrow_back',{exact:true}).first();
    if(await back.isVisible().catch(()=>false))await back.click();
    else await page.keyboard.press('Escape').catch(()=>{});
    await sleep(1000);
    const videosNav=page.getByText('Videos',{exact:true}).first();
    if(await videosNav.isVisible().catch(()=>false))await videosNav.click().catch(()=>{});
    await sleep(600);
  }
  console.log('FRUTTI_READONLY_T3_DETAILS',JSON.stringify(latestDetails));
  const characterTiles=await collectVisible('Personajes');
  console.log('FRUTTI_READONLY_PERSONAJES',JSON.stringify(characterTiles));

  // Read-only preflight of the exact ingredient picker used by generation.
  const allMedia=page.getByText(/^(Todos los elementos multimedia|All media)$/i).first();
  if(await allMedia.isVisible().catch(()=>false)){await allMedia.click();await sleep(1800);}

  const norm=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const pickerChecks=[];
  for(const wantedName of ['Uva Reyes','Limón Duarte','Fresia','Don Melón']){
    await page.keyboard.press('Escape').catch(()=>{});
    await sleep(250);
    const add=page.getByRole('button',{name:/Add ingredients to the prompt box/i}).last();
    const addVisible=await add.isVisible().catch(()=>false);
    if(!addVisible){
      pickerChecks.push({name:wantedName,add_button:false,tab:false,search:false,exact_found:false,options:[]});
      continue;
    }
    await add.click().catch(()=>{});
    await sleep(650);
    let tab=page.getByRole('tab',{name:/Characters|Personajes/i}).last();
    let tabVisible=await tab.isVisible().catch(()=>false);
    if(!tabVisible){
      tab=page.getByText(/^(Characters|Personajes)$/i).last();
      tabVisible=await tab.isVisible().catch(()=>false);
    }
    if(tabVisible){await tab.click().catch(()=>{});await sleep(900);}
    const search=page.locator('input[aria-label="Search assets"],input[aria-label*="Search"],input[placeholder*="Search"],input[aria-label*="Buscar"],input[placeholder*="Buscar"]').last();
    const searchVisible=await search.isVisible().catch(()=>false);
    if(searchVisible){await search.fill(wantedName).catch(()=>{});await sleep(1000);}
    let exactFound=false,options=[];
    const deadline=Date.now()+7000;
    while(Date.now()<deadline&&!exactFound){
      const exact=page.getByRole('option',{name:wantedName,exact:true}).last();
      if(await exact.isVisible().catch(()=>false)){exactFound=true;break;}
      const opts=page.locator('[role="option"]');
      options=[];
      for(let i=0;i<Math.min(await opts.count().catch(()=>0),80);i++){
        const el=opts.nth(i);
        if(!(await el.isVisible().catch(()=>false)))continue;
        const txt=String(await el.innerText().catch(()=>'')||'').replace(/\s+/g,' ').trim();
        const aria=String(await el.getAttribute('aria-label').catch(()=>'')||'').replace(/\s+/g,' ').trim();
        const value=aria||txt;
        if(value)options.push(value.slice(0,180));
        if(norm(txt)===norm(wantedName)||norm(aria)===norm(wantedName)){exactFound=true;break;}
      }
      if(!exactFound)await sleep(400);
    }
    pickerChecks.push({name:wantedName,add_button:addVisible,tab:tabVisible,search:searchVisible,exact_found:exactFound,options:[...new Set(options)].slice(0,20)});
    await page.keyboard.press('Escape').catch(()=>{});
    await sleep(300);
  }
  console.log('FRUTTI_READONLY_PICKER_CHECKS',JSON.stringify(pickerChecks));
  const composerDom=await page.evaluate(()=>{
    const out={buttons:[],inputs:[],editables:[]};
    for(const el of document.querySelectorAll('button,[role="button"]')){
      const r=el.getBoundingClientRect(); if(r.width<10||r.height<10||r.bottom<500)continue;
      out.buttons.push({
        tag:el.tagName.toLowerCase(),
        aria:String(el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,220),
        title:String(el.getAttribute('title')||'').replace(/\s+/g,' ').trim().slice(0,220),
        text:String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,220),
        x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)
      });
    }
    for(const el of document.querySelectorAll('input,textarea')){
      const r=el.getBoundingClientRect(); if(r.width<10||r.height<10||r.bottom<500)continue;
      out.inputs.push({
        tag:el.tagName.toLowerCase(),
        aria:String(el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,220),
        placeholder:String(el.getAttribute('placeholder')||'').replace(/\s+/g,' ').trim().slice(0,220),
        value:String(el.value||'').replace(/\s+/g,' ').trim().slice(0,220),
        x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)
      });
    }
    for(const el of document.querySelectorAll('[contenteditable="true"]')){
      const r=el.getBoundingClientRect(); if(r.width<10||r.height<10||r.bottom<500)continue;
      out.editables.push({
        tag:el.tagName.toLowerCase(),
        aria:String(el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,220),
        text:String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,220),
        x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)
      });
    }
    return out;
  });
  console.log('FRUTTI_READONLY_COMPOSER_DOM',JSON.stringify(composerDom));
  await ctx.close();
}finally{await browser.close().catch(()=>{})}
// FRESH_FRUTTI_AUTH_AUDIT: 2026-10-07T22:55-03:00
// FLOW_CARD_DETAIL_AUDIT: 2026-10-07T23:00-03:00
// RECENT_PROMPT_AUDIT: 2026-10-07T23:05-03:00
// OPEN_VIDEO_DETAIL_AUDIT: 2026-10-07T23:12-03:00
// PICKER_PREFLIGHT: 2026-10-09T00:15Z
// COMPOSER_DOM_AUDIT: 2026-10-09T00:16Z
