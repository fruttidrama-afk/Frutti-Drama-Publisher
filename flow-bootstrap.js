
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';
import { chromium } from 'playwright-core';
import { PROJECT_URL, PROJECT_ID, PROJECT_NAME } from './runtime-config.js';

const DATA_DIR=path.resolve(process.env.DATA_DIR||'/data');
const DIR=path.join(DATA_DIR,'publisher-runtime');
const PROFILE_DIR=path.join(DIR,'flow-profile');
const BOOTSTRAP_LOCK=path.join(DIR,'flow-auth-bootstrap.active.json');
const PROVIDER_LOCK=path.join(DIR,'free-browser-provider.lock');
const DISPLAY=':94';
const VIEW={width:1024,height:700};
const DEBUG_PORT=9334;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const compact=(v,n=500)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,n);
let xvfb=null,chrome=null;

fs.mkdirSync(PROFILE_DIR,{recursive:true,mode:0o700});

function pidAlive(pid){const n=Number(pid);if(!Number.isInteger(n)||n<=0)return false;try{process.kill(n,0);return true}catch{return false}}
function providerBusy(){
  try{
    if(!fs.existsSync(PROVIDER_LOCK))return false;
    const raw=JSON.parse(fs.readFileSync(PROVIDER_LOCK,'utf8')),age=Date.now()-fs.statSync(PROVIDER_LOCK).mtimeMs;
    if(!pidAlive(raw?.pid)||age>30*60*1000){fs.rmSync(PROVIDER_LOCK,{force:true});return false}
    return true;
  }catch{return false}
}
function mark(){fs.writeFileSync(BOOTSTRAP_LOCK,JSON.stringify({pid:process.pid,profile_dir:PROFILE_DIR,at:new Date().toISOString()},null,2),{mode:0o600})}
function clear(){try{fs.rmSync(BOOTSTRAP_LOCK,{force:true})}catch{}}
function pids(){
 const out=[];let names=[];try{names=fs.readdirSync('/proc')}catch{return out}
 for(const name of names){if(!/^\d+$/.test(name))continue;try{const cmd=fs.readFileSync('/proc/'+name+'/cmdline').toString('utf8').replace(/\0/g,' ');if(/google-chrome|chrome/i.test(cmd)&&cmd.includes(PROFILE_DIR))out.push(Number(name))}catch{}}
 return [...new Set(out)];
}
function env(){return{...process.env,DISPLAY}}
function windowId(){
 const r=spawnSync('xdotool',['search','--onlyvisible','--class','google-chrome'],{env:env(),encoding:'utf8',timeout:3000});
 return String(r.stdout||'').trim().split(/\s+/).filter(Boolean).pop()||'';
}
function windowTitle(){const w=windowId();if(!w)return'';const r=spawnSync('xdotool',['getwindowname',w],{env:env(),encoding:'utf8',timeout:3000});return compact(r.stdout||r.stderr||'',220)}
async function stop(){
 for(const pid of pids())try{process.kill(pid,'SIGTERM')}catch{}
 if(pids().length)await sleep(900);
 for(const pid of pids())try{process.kill(pid,'SIGKILL')}catch{}
 try{chrome?.kill('SIGTERM')}catch{};try{xvfb?.kill('SIGTERM')}catch{};chrome=null;xvfb=null;clear();
 for(const n of ['SingletonLock','SingletonSocket','SingletonCookie'])try{fs.rmSync(path.join(PROFILE_DIR,n),{force:true})}catch{}
}
async function start(){
 if(providerBusy())throw new Error('El worker está usando el perfil de Flow. Reintentá en unos segundos.');
 if(pids().length&&windowId())return;
 await stop();mark();
 xvfb=spawn('Xvfb',[DISPLAY,'-screen','0',VIEW.width+'x'+VIEW.height+'x24','-nolisten','tcp','-ac'],{stdio:'ignore'});
 await sleep(500);
 chrome=spawn('/usr/bin/google-chrome-stable',[
   '--user-data-dir='+PROFILE_DIR,
   '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+DEBUG_PORT,'--remote-allow-origins=*',
   '--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer',
   '--renderer-process-limit=1','--disable-site-isolation-trials',
   '--disable-features=IsolateOrigins,site-per-process,CalculateNativeWinOcclusion,OptimizationHints,MediaRouter',
   '--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-default-apps',
   '--metrics-recording-only','--no-first-run','--no-default-browser-check','--password-store=basic',
   '--window-size='+VIEW.width+','+VIEW.height,
   'https://accounts.google.com/AccountChooser?hl=es&continue='+encodeURIComponent('https://flow.google.com/')
 ],{env:env(),stdio:'ignore'});
 await sleep(1800);
}
async function navigate(url){
 await start();const w=windowId();if(!w)throw new Error('No hay una ventana activa de Chrome.');
 spawnSync('xdotool',['windowactivate','--sync',w],{env:env(),timeout:3000});
 spawnSync('xdotool',['key','--clearmodifiers','ctrl+l'],{env:env(),timeout:3000});await sleep(120);
 spawnSync('xdotool',['type','--clearmodifiers','--delay','6','--',String(url)],{env:env(),timeout:12000});
 spawnSync('xdotool',['key','--clearmodifiers','Return'],{env:env(),timeout:3000});await sleep(4500);
 return{title:windowTitle(),running:Boolean(pids().length)};
}
function shot(){
 const file=path.join(DIR,'flow-bootstrap-screen.png'),r=spawnSync('scrot',['-o',file],{env:env(),timeout:5000});
 if(r.status!==0||!fs.existsSync(file))throw new Error('No se pudo capturar Chrome.');
 return fs.readFileSync(file);
}
async function cdp(){
 for(let i=0;i<40;i++){try{const r=await fetch('http://127.0.0.1:'+DEBUG_PORT+'/json/version',{signal:AbortSignal.timeout(800)});if(r.ok)return await chromium.connectOverCDP('http://127.0.0.1:'+DEBUG_PORT,{timeout:5000})}catch{}await sleep(250)}
 throw new Error('Chrome todavía no está listo.');
}
async function page(){
 const b=await cdp(),ctx=b.contexts()[0],pages=ctx?.pages?.()||[],p=[...pages].reverse().find(x=>String(x.url()).includes('flow.google.com'))||pages[pages.length-1]||null;
 return{browser:b,page:p};
}
async function verify(){
 if(!PROJECT_ID)throw new Error('Primero configurá/seleccioná un proyecto de Google Flow.');
 await navigate(PROJECT_URL);await sleep(1500);
 const x=await page();try{
   const p=x.page;if(!p)throw new Error('No se encontró una pestaña de Flow.');
   const url=String(p.url()||''),text=String(await p.locator('body').innerText().catch(()=>''));if(/accounts\.google\.com|ServiceLogin|signin/i.test(url)||/email or phone|enter your password|verify it'?s you|captcha|security check/i.test(text))throw new Error('Google Flow todavía requiere autenticación.');
   if(!url.includes('/project/'+PROJECT_ID))throw new Error('Flow no abrió el proyecto configurado.');
   const inputs=p.locator('input[aria-label="Editable text"]');let title='';
   for(let i=0;i<await inputs.count().catch(()=>0);i++){const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const box=await el.boundingBox().catch(()=>null);if(box&&box.y<100){title=String(await el.inputValue().catch(()=>''));break}}
   if(PROJECT_NAME&&title&&title.trim()!==PROJECT_NAME)throw new Error('El proyecto abierto no coincide con el nombre configurado: '+compact(title,120));
   fs.writeFileSync(path.join(DIR,'flow-auth-verified.json'),JSON.stringify({ok:true,at:new Date().toISOString(),project_id:PROJECT_ID,project_name:PROJECT_NAME},null,2),{mode:0o600});
   return{ok:true,project_id:PROJECT_ID,project_name:PROJECT_NAME,title:compact(await p.title().catch(()=>''),180)};
 }finally{await x.browser.close().catch(()=>{})}
}
async function insertText(text){
 const x=await page();try{const p=x.page;if(!p)throw new Error('No hay pestaña activa.');const focus=await p.evaluate(()=>{const a=document.activeElement,tag=String(a?.tagName||'').toLowerCase(),role=String(a?.getAttribute?.('role')||'').toLowerCase();return{editable:Boolean(a&&(tag==='input'||tag==='textarea'||a.isContentEditable||role==='textbox')),tag,role}});if(!focus.editable)throw new Error('Tocá primero un campo editable en la captura.');await p.keyboard.insertText(String(text));return focus}finally{await x.browser.close().catch(()=>{})}
}

const HTML='<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Conectar Google Flow</title><style>body{margin:0;background:#f5f4ef;color:#171717;font-family:system-ui;padding:calc(16px + env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom))}.wrap{max-width:1080px;margin:auto}.bar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}button,input{font:inherit;min-height:44px;padding:10px 13px;border:1px solid #ddd8cd;border-radius:12px;background:#fff}button{font-weight:700}.primary{background:#111;color:#fff}.entry{display:flex;gap:8px}.entry input{flex:1}.screen{width:100%;max-width:1024px;background:#fff;border:1px solid #ddd8cd;border-radius:16px;display:block}.status{white-space:pre-wrap;background:#fff;border:1px solid #ddd8cd;padding:13px;border-radius:12px;margin-top:10px;color:#5f5d57}</style></head><body><main class="wrap"><h1>Conectar Google Flow</h1><p>Iniciá sesión directamente en este Chrome persistente. Publisher Runtime no recibe ni guarda tu contraseña.</p><div class="bar"><button class="primary" id="start">Abrir Google</button><button id="flow">Abrir proyecto Flow</button><button id="refresh">Actualizar</button><button id="tab">Tab</button><button id="enter">Enter</button><button id="back">Backspace</button><button id="finish">Verificar conexión</button></div><div class="entry"><input id="text" type="password" autocomplete="off" placeholder="Texto para el campo que tocaste"><button id="type">Escribir y borrar</button></div><p>Hacé clic sobre la captura para enfocar campos y botones. MFA/passkeys/CAPTCHA se realizan normalmente; no se evitan.</p><img id="screen" class="screen"><div id="status" class="status">Listo.</div></main><script>const q=s=>document.querySelector(s),img=q("#screen"),st=q("#status");async function api(u,b){const r=await fetch(u,{method:b?"POST":"GET",headers:b?{"Content-Type":"application/json"}:{},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j}async function shot(){try{const d=await api("/flow/bootstrap/screenshot");img.src=d.image;st.textContent=JSON.stringify(d.state,null,2)}catch(e){st.textContent=e.message}}q("#start").onclick=async()=>{try{await api("/flow/bootstrap/start",{});await shot()}catch(e){st.textContent=e.message}};q("#flow").onclick=async()=>{try{await api("/flow/bootstrap/project",{});await shot()}catch(e){st.textContent=e.message}};q("#refresh").onclick=shot;img.onclick=async e=>{const r=img.getBoundingClientRect(),x=(e.clientX-r.left)*1024/r.width,y=(e.clientY-r.top)*700/r.height;try{await api("/flow/bootstrap/click",{x,y});setTimeout(shot,300)}catch(e){st.textContent=e.message}};q("#type").onclick=async()=>{const el=q("#text"),t=el.value;el.value="";try{await api("/flow/bootstrap/type",{text:t});setTimeout(shot,300)}catch(e){st.textContent=e.message}};for(const [id,key] of [["tab","Tab"],["enter","Return"],["back","BackSpace"]])q("#"+id).onclick=async()=>{try{await api("/flow/bootstrap/key",{key});setTimeout(shot,300)}catch(e){st.textContent=e.message}};q("#finish").onclick=async()=>{try{const d=await api("/flow/bootstrap/finish",{});st.textContent="Google Flow conectado.\n"+JSON.stringify(d,null,2);img.removeAttribute("src")}catch(e){st.textContent=e.message}};</script></body></html>';

function safe(res,e,status=400){res.status(status).json({ok:false,error:compact(e?.message||e,700)})}
if(!globalThis.__publisherFlowBootstrapInstalled){
 globalThis.__publisherFlowBootstrapInstalled=true;
 const original=express.application.listen;
 express.application.listen=function(...args){
  const app=this;
  app.get('/flow/bootstrap',(_req,res)=>res.type('html').send(HTML));
  app.post('/flow/bootstrap/start',async(_req,res)=>{try{await start();res.json({ok:true,running:true,title:windowTitle()})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/project',async(_req,res)=>{try{if(!PROJECT_ID)throw new Error('Configurá primero el proyecto de Flow.');res.json({ok:true,...await navigate(PROJECT_URL)})}catch(e){safe(res,e)}});
  app.get('/flow/bootstrap/screenshot',async(_req,res)=>{try{if(!pids().length||!windowId())return safe(res,'Chrome está cerrado.',409);const png=shot();res.set('Cache-Control','no-store');res.json({ok:true,image:'data:image/png;base64,'+png.toString('base64'),state:{running:true,title:windowTitle()}})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/click',async(req,res)=>{try{await start();const w=windowId();if(!w)throw new Error('No hay ventana de Chrome.');const x=Math.max(0,Math.min(VIEW.width-1,Number(req.body?.x)||0)),y=Math.max(0,Math.min(VIEW.height-1,Number(req.body?.y)||0));spawnSync('xdotool',['windowactivate','--sync',w],{env:env(),timeout:3000});spawnSync('xdotool',['mousemove','--window',w,String(Math.round(x)),String(Math.round(y)),'click','1'],{env:env(),timeout:3000});await sleep(180);res.json({ok:true})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/type',async(req,res)=>{try{const text=String(req.body?.text??'');if(!text||text.length>20000)throw new Error('Texto vacío o demasiado largo.');await start();const focus=await insertText(text);res.json({ok:true,length:text.length,field:focus})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/key',async(req,res)=>{try{await start();const key=String(req.body?.key||'');if(!['Tab','Return','BackSpace','Escape','Up','Down','Left','Right'].includes(key))throw new Error('Tecla no permitida.');spawnSync('xdotool',['key','--clearmodifiers',key],{env:env(),timeout:3000});res.json({ok:true})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/finish',async(_req,res)=>{try{const out=await verify();await stop();res.json(out)}catch(e){safe(res,e)}});
  app.get('/flow/bootstrap/status',(_req,res)=>{let verified=null;try{verified=JSON.parse(fs.readFileSync(path.join(DIR,'flow-auth-verified.json'),'utf8'))}catch{}res.json({ok:true,running:Boolean(pids().length),verified,project_id:PROJECT_ID||null,project_name:PROJECT_NAME||null})});
  return original.apply(this,args);
 };
}
process.once('exit',clear);
