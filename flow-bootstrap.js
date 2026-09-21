
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
 for(let i=0;i<24&&providerBusy();i++)await sleep(250);
 if(providerBusy())throw new Error('El worker está terminando una tarea. Esperá unos segundos y tocá ABRIR GOOGLE otra vez.');
 if(pids().length&&windowId())return;
 await stop();mark();
 let xvfbErr='';
 xvfb=spawn('Xvfb',[DISPLAY,'-screen','0',VIEW.width+'x'+VIEW.height+'x24','-nolisten','tcp','-ac'],{stdio:['ignore','ignore','pipe']});
 xvfb.stderr?.on('data',d=>{xvfbErr=(xvfbErr+String(d)).slice(-1200)});
 await sleep(550);
 if(xvfb.exitCode!==null){clear();throw new Error('No pude iniciar la pantalla remota. '+compact(xvfbErr,300))}
 let chromeErr='';
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
 ],{env:env(),stdio:['ignore','ignore','pipe']});
 chrome.stderr?.on('data',d=>{chromeErr=(chromeErr+String(d)).slice(-1600)});
 for(let i=0;i<30;i++){
   await sleep(200);
   if(chrome.exitCode!==null)break;
   if(windowId())return;
 }
 clear();
 throw new Error('Chrome remoto no llegó a abrirse. '+compact(chromeErr||xvfbErr,500));
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
   return{ok:true,project_id:detectedId,project_name:detectedName,title:compact(await p.title().catch(()=>''),180),restart_required:false};
 }finally{await x.browser.close().catch(()=>{})}
}
async function insertText(text){
 const x=await page();try{const p=x.page;if(!p)throw new Error('No hay pestaña activa.');const focus=await p.evaluate(()=>{const a=document.activeElement,tag=String(a?.tagName||'').toLowerCase(),role=String(a?.getAttribute?.('role')||'').toLowerCase();return{editable:Boolean(a&&(tag==='input'||tag==='textarea'||a.isContentEditable||role==='textbox')),tag,role}});if(!focus.editable)throw new Error('Tocá primero un campo editable en la captura.');await p.keyboard.insertText(String(text));return focus}finally{await x.browser.close().catch(()=>{})}
}

function h(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function verifiedInfo(){try{return JSON.parse(fs.readFileSync(path.join(DIR,'flow-auth-verified.json'),'utf8'))}catch{return null}}
function pageHtml(message='',error=''){
 const running=Boolean(pids().length&&windowId()),title=running?windowTitle():'',verified=verifiedInfo();
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f6f2"><title>Conectar Google Flow</title><style>
:root{--navy:#0d3152;--gold:#b59a64;--ink:#1d1d1b;--muted:#6e6a63;--bg:#f7f6f2;--line:#ded9cf;--ok:#315d35;--okbg:#eef4ed;--danger:#8c3c33}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif;padding:calc(18px + env(safe-area-inset-top)) 16px calc(34px + env(safe-area-inset-bottom));-webkit-font-smoothing:antialiased}.wrap{max-width:1080px;margin:auto}.back{display:inline-flex;color:var(--navy);text-decoration:none;font-weight:800;margin-bottom:18px}.eyebrow{font-size:11px;letter-spacing:.2em;color:var(--gold);font-weight:800}h1{font:400 clamp(42px,7vw,64px)/.95 Georgia,serif;margin:10px 0 14px}.lead{font-size:17px;line-height:1.5;color:#47433d;max-width:790px}.steps{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:22px 0}.step{background:#fff;border:1px solid var(--line);padding:14px;min-height:118px}.step b{display:block;color:var(--navy);margin:7px 0}.num{width:30px;height:30px;border-radius:50%;background:var(--navy);color:#fff;display:grid;place-items:center;font-weight:800}.step span{font-size:12px;color:var(--muted);line-height:1.4}.workspace{background:#fff;border:1px solid var(--line);padding:16px}.bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 12px}.btn,button,input{font:inherit;min-height:48px;padding:10px 13px;border:1px solid #cfc8ba;background:#fff}.btn,button{font-weight:800;cursor:pointer}.primary{background:var(--navy);color:#fff;border-color:var(--navy)}button:active{transform:scale(.97)}form{margin:0}.notice{padding:12px 13px;margin:10px 0;font-size:13px;line-height:1.45}.notice.ok{background:var(--okbg);border:1px solid #a9bea4;color:var(--ok)}.notice.err{background:#fff1ee;border:1px solid #d8aaa2;color:var(--danger)}.tip{background:#faf9f6;border-left:3px solid var(--gold);padding:11px 13px;color:var(--muted);font-size:13px;line-height:1.45;margin:11px 0}.screen-wrap{width:100%;overflow:auto;border:1px solid var(--line);background:#ececeb;margin-top:12px;-webkit-overflow-scrolling:touch}.screen-input{display:block;width:1024px;height:700px;border:0;padding:0;margin:0;background:#ececeb}.screen-note{font-size:12px;color:var(--muted);margin:8px 0 0}.remote-frame{width:100%;height:min(72vh,760px);min-height:430px;border:1px solid var(--line);background:#ececeb;margin-top:12px}.live-note{background:#eef4ed;border:1px solid #a9bea4;color:#315d35;padding:11px 13px;font-size:13px;line-height:1.45;margin:10px 0}.entry{display:grid;grid-template-columns:1fr auto;gap:8px;margin:12px 0}.entry input{width:100%}.keys{display:flex;gap:7px;flex-wrap:wrap}.keys form{display:inline-block}.keys button{min-height:40px;padding:7px 10px;font-size:12px}.status{background:#fff;border:1px solid var(--line);padding:13px;margin-top:10px;color:#5f5d57;font-size:13px;line-height:1.45}.success{background:var(--okbg);border:1px solid #a9bea4;color:var(--ok);padding:16px;margin:14px 0}.success .btn{display:inline-flex;text-decoration:none;margin-top:10px}.muted{color:var(--muted)}details{margin-top:12px;color:var(--muted)}
@media(max-width:850px){.steps{grid-template-columns:1fr 1fr}.step:last-child{grid-column:1/-1}}
@media(max-width:620px){.steps{grid-template-columns:1fr}.step:last-child{grid-column:auto}.bar{grid-template-columns:1fr}.entry{grid-template-columns:1fr}.entry button{width:100%}}
</style></head><body><main class="wrap"><a class="back" href="/">← Volver al Publisher</a><div class="eyebrow">GOOGLE FLOW · CONTROLADOR WEB</div><h1>Conectemos Google Flow.</h1><p class="lead">Este controlador funciona dentro del Publisher. Los botones ahora son acciones del servidor: cuando tocás <b>ABRIR GOOGLE</b>, la página se recarga y el navegador remoto aparece abajo. No depende de JavaScript del iPhone.</p>
<div class="steps"><div class="step"><div class="num">1</div><b>Abrí Google</b><span>Inicia el navegador remoto.</span></div><div class="step"><div class="num">2</div><b>Iniciá sesión</b><span>Tocá la captura y escribí con el campo de abajo.</span></div><div class="step"><div class="num">3</div><b>Abrí Flow</b><span>Te lleva a flow.google.com.</span></div><div class="step"><div class="num">4</div><b>Elegí proyecto</b><span>Abrí o creá un proyecto de Flow.</span></div><div class="step"><div class="num">5</div><b>Verificá</b><span>Guarda sesión y proyecto.</span></div></div>
<section class="workspace">
${message?'<div class="notice ok">'+h(message)+'</div>':''}
${error?'<div class="notice err"><b>No se pudo completar la acción.</b><br>'+h(error)+'</div>':''}
${verified?'<div class="success"><b>✓ Google Flow ya fue verificado.</b><br>Proyecto: '+h(verified.project_name||verified.project_id||'detectado')+'<br><a class="btn primary" href="/">VOLVER AL PUBLISHER</a></div>':''}
<div class="bar">
<form method="post" action="/flow/bootstrap/start-page"><button class="primary" type="submit">1 · ABRIR GOOGLE</button></form>
<form method="post" action="/flow/bootstrap/project-page"><button class="primary" type="submit">3 · ABRIR GOOGLE FLOW</button></form>
<form method="get" action="/flow/bootstrap"><button type="submit">ACTUALIZAR NAVEGADOR</button></form>
<form method="post" action="/flow/bootstrap/finish-page"><button class="primary" type="submit">5 · VERIFICAR CONEXIÓN</button></form>
</div>
<div class="tip"><b>Cómo usarlo:</b> si el navegador está abierto, aparece abajo. La imagen se muestra a tamaño real dentro de un área desplazable. Deslizá horizontalmente si hace falta y tocá exactamente donde querés hacer clic.</div>
${running?`<div class="status"><b>Navegador activo.</b> ${h(title||'Google')}</div>
<div class="live-note"><b>Modo CAPTCHA seguro:</b> los clics dentro del controlador de abajo ya no recargan esta página. El CAPTCHA permanece abierto en el mismo Chrome remoto mientras lo resolvés.</div>
<iframe class="remote-frame" name="flowController" id="flowController" src="/flow/bootstrap/view" title="Controlador remoto de Google Flow"></iframe>
<form class="entry" method="post" action="/flow/bootstrap/type-view" target="flowController"><input name="text" type="password" autocomplete="off" placeholder="Primero tocá un campo en el controlador y después escribí acá"><button class="primary" type="submit">ESCRIBIR SIN RECARGAR</button></form>
<details><summary>Controles extra</summary><div class="keys">
<form method="post" action="/flow/bootstrap/key-view" target="flowController"><input type="hidden" name="key" value="Tab"><button type="submit">Tab</button></form>
<form method="post" action="/flow/bootstrap/key-view" target="flowController"><input type="hidden" name="key" value="Return"><button type="submit">Enter</button></form>
<form method="post" action="/flow/bootstrap/key-view" target="flowController"><input type="hidden" name="key" value="BackSpace"><button type="submit">Backspace</button></form>
<form method="post" action="/flow/bootstrap/key-view" target="flowController"><input type="hidden" name="key" value="Escape"><button type="submit">Escape</button></form>
</div></details>`:`<div class="status"><b>El navegador todavía está cerrado.</b><br>Tocá <b>1 · ABRIR GOOGLE</b>. Cuando termine de arrancar, esta página vuelve sola y vas a ver la pantalla remota acá.</div>`}
</section></main></body></html>`;
}
function go(res,message='',error=''){const q=new URLSearchParams();if(message)q.set('msg',compact(message,300));if(error)q.set('error',compact(error,500));res.redirect('/flow/bootstrap'+(q.size?'?'+q.toString():''))}


function safe(res,e,status=400){res.status(status).json({ok:false,error:compact(e?.message||e,700)})}
if(!globalThis.__publisherFlowBootstrapInstalled){
 globalThis.__publisherFlowBootstrapInstalled=true;
 const original=express.application.listen;
 express.application.listen=function(...args){
  const app=this;
  app.get('/flow/bootstrap',(req,res)=>res.type('html').send(pageHtml(String(req.query.msg||''),String(req.query.error||''))));
  app.post('/flow/bootstrap/start-page',async(_req,res)=>{try{await start();go(res,'Google está abierto. Usá la pantalla remota de abajo para iniciar sesión.')}catch(e){go(res,'',e?.message||e)}});
  app.post('/flow/bootstrap/project-page',async(_req,res)=>{try{await navigate(PROJECT_ID?PROJECT_URL:'https://flow.google.com/');go(res,'Google Flow está abierto. Elegí o creá un proyecto en la pantalla remota.')}catch(e){go(res,'',e?.message||e)}});
  app.get('/flow/bootstrap/screen.png',async(_req,res)=>{try{if(!pids().length||!windowId()){res.status(409).type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="700"><rect width="100%" height="100%" fill="#eee"/><text x="512" y="350" text-anchor="middle" font-family="Arial" font-size="30" fill="#555">Navegador cerrado</text></svg>');return}const png=shot();res.set('Cache-Control','no-store, max-age=0');res.type('png').send(png)}catch(e){res.status(500).type('text').send(compact(e?.message||e,500))}});
  app.get('/flow/bootstrap/view',(_req,res)=>{try{
    if(!pids().length||!windowId())return res.type('html').send('<!doctype html><html><body style="font-family:Arial;background:#eee;padding:20px">Navegador remoto cerrado.</body></html>');
    res.set('Cache-Control','no-store, max-age=0');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=1024,initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0;width:1024px;height:700px;background:#ececeb;overflow:hidden}.stage{position:relative;width:1024px;height:700px;background:#ececeb;touch-action:manipulation}.shot{position:absolute;inset:0;width:1024px;height:700px;object-fit:contain;user-select:none;-webkit-user-select:none}.top{z-index:2}.bottom{z-index:1}.busy{position:absolute;right:12px;top:12px;z-index:5;background:rgba(13,49,82,.85);color:#fff;padding:7px 9px;border-radius:8px;font:700 12px Arial;opacity:0;transition:opacity .15s}.busy.show{opacity:1}
</style></head><body><div class="stage" id="stage"><img id="a" class="shot top" src="/flow/bootstrap/screen.png?t=${Date.now()}" alt="Navegador remoto"><img id="b" class="shot bottom" alt=""><div id="busy" class="busy">actualizando…</div></div><script>
const stage=document.getElementById('stage'),a=document.getElementById('a'),b=document.getElementById('b'),busy=document.getElementById('busy');let front=a,back=b,clickBusy=false,refreshBusy=false;
function swap(){front.classList.remove('top');front.classList.add('bottom');back.classList.remove('bottom');back.classList.add('top');const t=front;front=back;back=t;}
function refresh(){if(refreshBusy||clickBusy)return;refreshBusy=true;back.onload=()=>{swap();refreshBusy=false};back.onerror=()=>{refreshBusy=false};back.src='/flow/bootstrap/screen.png?t='+Date.now()}
setInterval(refresh,850);
stage.addEventListener('click',async e=>{if(clickBusy)return;const r=stage.getBoundingClientRect(),x=(e.clientX-r.left)*1024/r.width,y=(e.clientY-r.top)*700/r.height;clickBusy=true;busy.classList.add('show');try{await fetch('/flow/bootstrap/click',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x,y})});setTimeout(refresh,120)}finally{setTimeout(()=>{clickBusy=false;busy.classList.remove('show')},220)}});
</script></body></html>`);
  }catch(e){res.status(500).type('text').send(compact(e?.message||e,500))}});
  app.post('/flow/bootstrap/click-view',async(req,res)=>{try{
    await start();const w=windowId();if(!w)throw new Error('No hay ventana de Chrome.');
    const x=Math.max(0,Math.min(VIEW.width-1,Number(req.body?.['screen.x'])||0)),y=Math.max(0,Math.min(VIEW.height-1,Number(req.body?.['screen.y'])||0));
    spawnSync('xdotool',['windowactivate','--sync',w],{env:env(),timeout:3000});
    spawnSync('xdotool',['mousemove','--window',w,String(Math.round(x)),String(Math.round(y)),'click','1'],{env:env(),timeout:3000});
    await sleep(180);res.redirect('/flow/bootstrap/view');
  }catch(e){res.status(500).type('html').send('<!doctype html><html><body style="font-family:Arial;padding:20px">Error: '+h(e?.message||e)+'<br><a href="/flow/bootstrap/view">Volver</a></body></html>')}});
  app.post('/flow/bootstrap/type-view',async(req,res)=>{try{
    const text=String(req.body?.text??'');if(!text||text.length>20000)throw new Error('Escribí algo primero.');
    await start();await insertText(text);await sleep(180);res.redirect('/flow/bootstrap/view');
  }catch(e){res.status(500).type('html').send('<!doctype html><html><body style="font-family:Arial;padding:20px">Error: '+h(e?.message||e)+'<br><a href="/flow/bootstrap/view">Volver</a></body></html>')}});
  app.post('/flow/bootstrap/key-view',async(req,res)=>{try{
    await start();const key=String(req.body?.key||'');if(!['Tab','Return','BackSpace','Escape','Up','Down','Left','Right'].includes(key))throw new Error('Tecla no permitida.');
    const w=windowId();if(w)spawnSync('xdotool',['windowactivate','--sync',w],{env:env(),timeout:3000});
    spawnSync('xdotool',['key','--clearmodifiers',key],{env:env(),timeout:3000});await sleep(120);res.redirect('/flow/bootstrap/view');
  }catch(e){res.status(500).type('html').send('<!doctype html><html><body style="font-family:Arial;padding:20px">Error: '+h(e?.message||e)+'<br><a href="/flow/bootstrap/view">Volver</a></body></html>')}});
  app.post('/flow/bootstrap/click-page',async(req,res)=>{try{await start();const w=windowId();if(!w)throw new Error('No hay ventana de Chrome.');const x=Math.max(0,Math.min(VIEW.width-1,Number(req.body?.['screen.x'])||0)),y=Math.max(0,Math.min(VIEW.height-1,Number(req.body?.['screen.y'])||0));spawnSync('xdotool',['windowactivate','--sync',w],{env:env(),timeout:3000});spawnSync('xdotool',['mousemove','--window',w,String(Math.round(x)),String(Math.round(y)),'click','1'],{env:env(),timeout:3000});await sleep(300);go(res,'Clic enviado al navegador remoto.')}catch(e){go(res,'',e?.message||e)}});
  app.post('/flow/bootstrap/type-page',async(req,res)=>{try{const text=String(req.body?.text??'');if(!text||text.length>20000)throw new Error('Escribí algo primero.');await start();await insertText(text);await sleep(250);go(res,'Texto enviado y borrado del formulario local.')}catch(e){go(res,'',e?.message||e)}});
  app.post('/flow/bootstrap/key-page',async(req,res)=>{try{await start();const key=String(req.body?.key||'');if(!['Tab','Return','BackSpace','Escape','Up','Down','Left','Right'].includes(key))throw new Error('Tecla no permitida.');const w=windowId();if(w)spawnSync('xdotool',['windowactivate','--sync',w],{env:env(),timeout:3000});spawnSync('xdotool',['key','--clearmodifiers',key],{env:env(),timeout:3000});await sleep(200);go(res,'Tecla enviada: '+key)}catch(e){go(res,'',e?.message||e)}});
  app.post('/flow/bootstrap/finish-page',async(_req,res)=>{try{const out=await verify();await stop();go(res,'Google Flow conectado ✓ · '+(out.project_name||out.project_id||'proyecto detectado'))}catch(e){go(res,'',e?.message||e)}});
  app.post('/flow/bootstrap/start',async(_req,res)=>{try{await start();res.json({ok:true,running:true,title:windowTitle()})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/project',async(_req,res)=>{try{res.json({ok:true,...await navigate(PROJECT_ID?PROJECT_URL:'https://flow.google.com/')})}catch(e){safe(res,e)}});
  app.get('/flow/bootstrap/screenshot',async(_req,res)=>{try{if(!pids().length||!windowId())return safe(res,'Chrome está cerrado.',409);const png=shot();res.set('Cache-Control','no-store');res.json({ok:true,image:'data:image/png;base64,'+png.toString('base64'),state:{running:true,title:windowTitle()}})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/click',async(req,res)=>{try{await start();const w=windowId();if(!w)throw new Error('No hay ventana de Chrome.');const x=Math.max(0,Math.min(VIEW.width-1,Number(req.body?.x)||0)),y=Math.max(0,Math.min(VIEW.height-1,Number(req.body?.y)||0));spawnSync('xdotool',['windowactivate','--sync',w],{env:env(),timeout:3000});spawnSync('xdotool',['mousemove','--window',w,String(Math.round(x)),String(Math.round(y)),'click','1'],{env:env(),timeout:3000});await sleep(180);res.json({ok:true})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/type',async(req,res)=>{try{const text=String(req.body?.text??'');if(!text||text.length>20000)throw new Error('Texto vacío o demasiado largo.');await start();const focus=await insertText(text);res.json({ok:true,length:text.length,field:focus})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/key',async(req,res)=>{try{await start();const key=String(req.body?.key||'');if(!['Tab','Return','BackSpace','Escape','Up','Down','Left','Right'].includes(key))throw new Error('Tecla no permitida.');spawnSync('xdotool',['key','--clearmodifiers',key],{env:env(),timeout:3000});res.json({ok:true})}catch(e){safe(res,e)}});
  app.post('/flow/bootstrap/finish',async(_req,res)=>{try{const out=await verify();await stop();res.json(out)}catch(e){safe(res,e)}});
  app.get('/flow/bootstrap/status',(_req,res)=>{res.json({ok:true,running:Boolean(pids().length&&windowId()),verified:verifiedInfo(),project_id:PROJECT_ID||null,project_name:PROJECT_NAME||null,title:windowTitle()})});
  return original.apply(this,args);
 };
}
process.once('exit',clear);
