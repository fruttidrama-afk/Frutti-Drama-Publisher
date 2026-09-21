
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';
import { chromium } from 'playwright-core';
import { CONFIG, PROJECT_URL, PROJECT_ID, PROJECT_NAME } from './runtime-config.js';

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
 await start();await sleep(600);
 const x=await page();try{
   const p=x.page;if(!p)throw new Error('No se encontró una pestaña de Flow.');
   const url=String(p.url()||''),text=String(await p.locator('body').innerText().catch(()=>''));
   if(/accounts\.google\.com|ServiceLogin|signin/i.test(url)||/email or phone|enter your password|verify it'?s you|captcha|security check/i.test(text))throw new Error('Google Flow todavía requiere autenticación.');
   if(!url.includes('flow.google.com'))throw new Error('Abrí Google Flow y elegí o creá un proyecto.');
   const match=url.match(/\/project\/([^/?#]+)/),detectedId=match?decodeURIComponent(match[1]):'';
   if(!detectedId)throw new Error('Elegí o creá un proyecto dentro de Google Flow antes de verificar la conexión.');
   const inputs=p.locator('input[aria-label="Editable text"]');let title='';
   for(let i=0;i<await inputs.count().catch(()=>0);i++){const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const box=await el.boundingBox().catch(()=>null);if(box&&box.y<100){title=String(await el.inputValue().catch(()=>''));break}}
   const detectedName=compact(title||PROJECT_NAME||CONFIG.identity.show_name||'Flow Project',120);
   const persisted=structuredClone(CONFIG);persisted.generation={...(persisted.generation||{}),project_id:detectedId,project_url:'https://flow.google.com/project/'+detectedId,project_name:detectedName};
   fs.writeFileSync(path.join(DATA_DIR,'publisher-config.json'),JSON.stringify(persisted,null,2),{mode:0o600});
   fs.writeFileSync(path.join(DIR,'flow-auth-verified.json'),JSON.stringify({ok:true,at:new Date().toISOString(),project_id:detectedId,project_name:detectedName},null,2),{mode:0o600});
   return{ok:true,project_id:detectedId,project_name:detectedName,title:compact(await p.title().catch(()=>''),180),restart_required:true};
 }finally{await x.browser.close().catch(()=>{})}
}
async function insertText(text){
 const x=await page();try{const p=x.page;if(!p)throw new Error('No hay pestaña activa.');const focus=await p.evaluate(()=>{const a=document.activeElement,tag=String(a?.tagName||'').toLowerCase(),role=String(a?.getAttribute?.('role')||'').toLowerCase();return{editable:Boolean(a&&(tag==='input'||tag==='textarea'||a.isContentEditable||role==='textbox')),tag,role}});if(!focus.editable)throw new Error('Tocá primero un campo editable en la captura.');await p.keyboard.insertText(String(text));return focus}finally{await x.browser.close().catch(()=>{})}
}

const HTML='<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f6f2"><title>Conectar Google Flow</title><style>:root{--navy:#0d3152;--gold:#b59a64;--ink:#1d1d1b;--muted:#6e6a63;--bg:#f7f6f2;--line:#ded9cf;--ok:#315d35;--okbg:#eef4ed}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif;padding:calc(18px + env(safe-area-inset-top)) 16px calc(34px + env(safe-area-inset-bottom));-webkit-font-smoothing:antialiased}.wrap{max-width:1080px;margin:auto}.back{display:inline-flex;color:var(--navy);text-decoration:none;font-weight:700;margin-bottom:18px}.eyebrow{font-size:11px;letter-spacing:.2em;color:var(--gold);font-weight:800}h1{font:400 clamp(42px,7vw,64px)/.95 Georgia,serif;margin:10px 0 14px}.lead{font-size:17px;line-height:1.5;color:#47433d;max-width:760px}.steps{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:22px 0}.step{background:#fff;border:1px solid var(--line);padding:14px;min-height:118px}.step b{display:block;color:var(--navy);margin:7px 0}.num{width:30px;height:30px;border-radius:50%;background:var(--navy);color:#fff;display:grid;place-items:center;font-weight:800}.step span{font-size:12px;color:var(--muted);line-height:1.4}.workspace{background:#fff;border:1px solid var(--line);padding:16px}.bar{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.btn,button,input{font:inherit;min-height:46px;padding:10px 13px;border:1px solid #cfc8ba;background:#fff}.btn,button{font-weight:800;cursor:pointer}.primary{background:var(--navy);color:#fff;border-color:var(--navy)}button:active{transform:scale(.97)}.entry{display:flex;gap:8px;margin:10px 0}.entry input{flex:1}.screen{width:100%;max-width:1024px;background:#f1f1ef;border:1px solid var(--line);display:block;min-height:220px;object-fit:contain}.tip{background:#faf9f6;border-left:3px solid var(--gold);padding:11px 13px;color:var(--muted);font-size:13px;line-height:1.45;margin:11px 0}.status{white-space:pre-wrap;background:#fff;border:1px solid var(--line);padding:13px;margin-top:10px;color:#5f5d57;font-size:13px}.success{display:none;background:var(--okbg);border:1px solid #a9bea4;color:var(--ok);padding:16px;margin-top:14px}.success.show{display:block}.keys{display:flex;gap:7px;flex-wrap:wrap}.keys button{min-height:40px;padding:7px 10px;font-size:12px}details{margin-top:12px;color:var(--muted)}@media(max-width:850px){.steps{grid-template-columns:1fr 1fr}.step:last-child{grid-column:1/-1}}@media(max-width:620px){.steps{grid-template-columns:1fr}.step:last-child{grid-column:auto}.bar .primary,.bar .wide{width:100%}.entry{flex-direction:column}.entry button{width:100%}}</style></head><body><main class="wrap"><a class="back" href="/">← Volver al Publisher</a><div class="eyebrow">GOOGLE FLOW · CONEXIÓN GUIADA</div><h1>Conectemos Google Flow.</h1><p class="lead">Acá sí tenés un controlador web dentro del Publisher. Vas a ver un navegador remoto abajo: tocás la captura, escribís desde los controles y la sesión queda guardada para que la automatización pueda usar Flow después.</p><div class="steps"><div class="step"><div class="num">1</div><b>Abrí Google</b><span>Tocá “ABRIR GOOGLE”.</span></div><div class="step"><div class="num">2</div><b>Iniciá sesión</b><span>Usá la captura de abajo. Publisher no recibe tu contraseña directamente.</span></div><div class="step"><div class="num">3</div><b>Abrí Flow</b><span>Tocá “ABRIR GOOGLE FLOW”.</span></div><div class="step"><div class="num">4</div><b>Elegí un proyecto</b><span>Abrí uno existente o creá uno nuevo.</span></div><div class="step"><div class="num">5</div><b>Verificá</b><span>Con el proyecto abierto, tocá “VERIFICAR CONEXIÓN”.</span></div></div><section class="workspace"><div class="bar"><button class="primary wide" id="start">1 · ABRIR GOOGLE</button><button class="primary wide" id="flow">3 · ABRIR GOOGLE FLOW</button><button class="wide" id="refresh">ACTUALIZAR CAPTURA</button><button class="primary wide" id="finish">5 · VERIFICAR CONEXIÓN</button></div><div class="tip"><b>Cómo usar el navegador:</b> tocá en la captura exactamente donde querés hacer clic. Para escribir, primero tocá un campo dentro de la captura, después escribí abajo y tocá “ESCRIBIR”.</div><img id="screen" class="screen" alt="Navegador remoto de Google Flow"><div class="entry"><input id="text" type="password" autocomplete="off" placeholder="Escribí aquí lo que querés mandar al campo seleccionado"><button class="primary" id="type">ESCRIBIR Y BORRAR</button></div><details><summary>Controles extra</summary><div class="keys"><button id="tab">Tab</button><button id="enter">Enter</button><button id="back">Backspace</button></div><p>Si Google muestra MFA, passkey o CAPTCHA, completalo normalmente desde este navegador. El sistema no lo evita.</p></details><div id="status" class="status">Empezá tocando “1 · ABRIR GOOGLE”.</div><div id="success" class="success"><b>✓ Google Flow quedó conectado.</b><br>La sesión y el proyecto quedan guardados para este Publisher. Ya podés volver.</div></section></main><script>const q=s=>document.querySelector(s),img=q("#screen"),st=q("#status"),ok=q("#success");async function api(u,b){const r=await fetch(u,{method:b?"POST":"GET",headers:b?{"Content-Type":"application/json"}:{},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j}async function shot(){try{const d=await api("/flow/bootstrap/screenshot");img.src=d.image;st.textContent="Navegador activo · "+(d.state?.title||"Google")}catch(e){st.textContent=e.message}}q("#start").onclick=async()=>{try{st.textContent="Abriendo Google…";await api("/flow/bootstrap/start",{});await shot()}catch(e){st.textContent=e.message}};q("#flow").onclick=async()=>{try{st.textContent="Abriendo Google Flow…";await api("/flow/bootstrap/project",{});await shot()}catch(e){st.textContent=e.message}};q("#refresh").onclick=shot;img.onclick=async e=>{const r=img.getBoundingClientRect(),x=(e.clientX-r.left)*1024/r.width,y=(e.clientY-r.top)*700/r.height;try{await api("/flow/bootstrap/click",{x,y});setTimeout(shot,320)}catch(e){st.textContent=e.message}};q("#type").onclick=async()=>{const el=q("#text"),t=el.value;el.value="";try{if(!t)throw new Error("Escribí algo primero.");st.textContent="Escribiendo…";await api("/flow/bootstrap/type",{text:t});setTimeout(shot,320)}catch(e){st.textContent=e.message}};for(const [id,key] of [["tab","Tab"],["enter","Return"],["back","BackSpace"]])q("#"+id).onclick=async()=>{try{await api("/flow/bootstrap/key",{key});setTimeout(shot,300)}catch(e){st.textContent=e.message}};q("#finish").onclick=async()=>{try{st.textContent="Verificando que Flow esté abierto en un proyecto…";const d=await api("/flow/bootstrap/finish",{});ok.classList.add("show");st.textContent="Google Flow conectado ✓\nProyecto: "+(d.project_name||d.project_id||"detectado");img.removeAttribute("src")}catch(e){st.textContent="Todavía no está listo: "+e.message}};</script></body></html>'

function safe(res,e,status=400){res.status(status).json({ok:false,error:compact(e?.message||e,700)})}
if(!globalThis.__publisherFlowBootstrapInstalled){
 globalThis.__publisherFlowBootstrapInstalled=true;
 const original=express.application.listen;
 express.application.listen=function(...args){
  const app=this;
  app.get('/flow/bootstrap',(_req,res)=>res.type('html').send(HTML));
  app.post('/flow/bootstrap/start',async(_req,res)=>{try{await start();res.json({ok:true,running:true,title:windowTitle()})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/project',async(_req,res)=>{try{res.json({ok:true,...await navigate(PROJECT_ID?PROJECT_URL:'https://flow.google.com/')})}catch(e){safe(res,e)}});
  app.get('/flow/bootstrap/screenshot',async(_req,res)=>{try{if(!pids().length||!windowId())return safe(res,'Chrome está cerrado.',409);const png=shot();res.set('Cache-Control','no-store');res.json({ok:true,image:'data:image/png;base64,'+png.toString('base64'),state:{running:true,title:windowTitle()}})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/click',async(req,res)=>{try{await start();const w=windowId();if(!w)throw new Error('No hay ventana de Chrome.');const x=Math.max(0,Math.min(VIEW.width-1,Number(req.body?.x)||0)),y=Math.max(0,Math.min(VIEW.height-1,Number(req.body?.y)||0));spawnSync('xdotool',['windowactivate','--sync',w],{env:env(),timeout:3000});spawnSync('xdotool',['mousemove','--window',w,String(Math.round(x)),String(Math.round(y)),'click','1'],{env:env(),timeout:3000});await sleep(180);res.json({ok:true})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/type',async(req,res)=>{try{const text=String(req.body?.text??'');if(!text||text.length>20000)throw new Error('Texto vacío o demasiado largo.');await start();const focus=await insertText(text);res.json({ok:true,length:text.length,field:focus})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/key',async(req,res)=>{try{await start();const key=String(req.body?.key||'');if(!['Tab','Return','BackSpace','Escape','Up','Down','Left','Right'].includes(key))throw new Error('Tecla no permitida.');spawnSync('xdotool',['key','--clearmodifiers',key],{env:env(),timeout:3000});res.json({ok:true})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/finish',async(_req,res)=>{try{const out=await verify();await stop();res.json(out);setTimeout(()=>process.exit(0),900).unref?.()}catch(e){safe(res,e)}});
  app.get('/flow/bootstrap/status',(_req,res)=>{let verified=null;try{verified=JSON.parse(fs.readFileSync(path.join(DIR,'flow-auth-verified.json'),'utf8'))}catch{}res.json({ok:true,running:Boolean(pids().length),verified,project_id:PROJECT_ID||null,project_name:PROJECT_NAME||null})});
  return original.apply(this,args);
 };
}
process.once('exit',clear);
