import http from 'node:http';
import { chromium } from 'playwright-core';

const PORT=Number(process.env.FLOW_REMOTE_PORT||6080);
const TOKEN=String(process.env.FLOW_REMOTE_TOKEN||'').trim();
if(!TOKEN)throw new Error('FLOW_REMOTE_TOKEN required');
const PREFIX='/'+TOKEN;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function connect(){
  for(let i=0;i<120;i++){
    try{return await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:3000})}catch{}
    await sleep(500);
  }
  throw new Error('CDP_CONNECT_TIMEOUT');
}
const browser=await connect();
const context=browser.contexts()[0];
function activePage(){
  const pages=context.pages();
  return [...pages].reverse().find(p=>!p.isClosed())||pages[0];
}
function sendJson(res,obj,status=200){
  const out=JSON.stringify(obj);
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','content-length':Buffer.byteLength(out)});
  res.end(out);
}
function sendHtml(res,body,status=200){
  res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
  res.end(body);
}
async function readBody(req){
  const chunks=[];
  for await(const c of req)chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
const UI=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><title>Flow Login</title><style>
*{box-sizing:border-box}body{margin:0;background:#111;color:#fff;font:15px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}header{position:sticky;top:0;z-index:5;background:#171717;padding:10px 12px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #333}header b{flex:1}.pill{font-size:12px;color:#9fe870}main{padding:8px}.screen{width:100%;border:1px solid #333;border-radius:10px;background:#222;touch-action:manipulation;display:block}.tools{position:sticky;bottom:0;background:#171717;border-top:1px solid #333;padding:8px;display:grid;grid-template-columns:1fr auto;gap:8px}input{width:100%;font-size:16px;padding:12px;border-radius:9px;border:1px solid #555;background:#222;color:#fff}button{font-size:14px;padding:10px 12px;border:0;border-radius:9px;background:#3d6fd8;color:#fff}.keys{grid-column:1/-1;display:flex;gap:7px;flex-wrap:wrap}.keys button{background:#333}.hint{padding:7px 4px;color:#bbb;font-size:12px}</style></head><body>
<header><b>Google Flow · temporary login</b><span class="pill" id="st">connecting…</span></header>
<main><img id="screen" class="screen" alt="Remote browser"><div class="hint">Tap the remote browser to click. To type: tap a remote field, type below, then Send.</div></main>
<div class="tools"><input id="txt" autocomplete="off" autocapitalize="none" placeholder="Type into selected field"><button id="send">Send</button><div class="keys"><button data-key="Enter">Enter</button><button data-key="Tab">Tab</button><button data-key="Backspace">⌫</button><button data-key="Escape">Esc</button><button id="up">↑ scroll</button><button id="down">↓ scroll</button><button id="reload">Reload</button></div></div>
<script>
const P=location.pathname.replace(/\\/$/,''); const img=document.getElementById('screen'),st=document.getElementById('st');
let busy=false;
async function shot(){if(busy)return;busy=true;img.src=P+'/shot?t='+Date.now();busy=false}
img.onload=()=>{st.textContent='live'}; img.onerror=()=>{st.textContent='reconnecting…'};
setInterval(shot,900);shot();
img.addEventListener('click',async e=>{const r=img.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;await fetch(P+'/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x,y})});setTimeout(shot,180)});
document.getElementById('send').onclick=async()=>{const el=document.getElementById('txt');await fetch(P+'/type',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:el.value})});el.value='';setTimeout(shot,180)};
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=async()=>{await fetch(P+'/key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:b.dataset.key})});setTimeout(shot,180)});
document.getElementById('up').onclick=()=>fetch(P+'/scroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dy:-600})});
document.getElementById('down').onclick=()=>fetch(P+'/scroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dy:600})});
document.getElementById('reload').onclick=()=>fetch(P+'/reload',{method:'POST'}).then(()=>setTimeout(shot,500));
</script></body></html>`;

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    if(!u.pathname.startsWith(PREFIX))return sendHtml(res,'Not found',404);
    const sub=u.pathname.slice(PREFIX.length)||'/';
    const p=activePage(); if(!p)return sendJson(res,{error:'browser page unavailable'},503);
    if(req.method==='GET'&&sub==='/')return sendHtml(res,UI);
    if(req.method==='GET'&&sub==='/shot'){
      const buf=await p.screenshot({type:'jpeg',quality:70});
      res.writeHead(200,{'content-type':'image/jpeg','cache-control':'no-store','content-length':buf.length});
      return res.end(buf);
    }
    if(req.method==='POST'&&sub==='/click'){
      const b=await readBody(req),vp=p.viewportSize()||{width:1440,height:900};
      await p.mouse.click(Math.max(0,Math.min(1,Number(b.x||0)))*vp.width,Math.max(0,Math.min(1,Number(b.y||0)))*vp.height);
      return sendJson(res,{ok:true});
    }
    if(req.method==='POST'&&sub==='/type'){const b=await readBody(req);await p.keyboard.type(String(b.text||''),{delay:25});return sendJson(res,{ok:true})}
    if(req.method==='POST'&&sub==='/key'){const b=await readBody(req);await p.keyboard.press(String(b.key||'Enter'));return sendJson(res,{ok:true})}
    if(req.method==='POST'&&sub==='/scroll'){const b=await readBody(req);await p.mouse.wheel(0,Number(b.dy||0));return sendJson(res,{ok:true})}
    if(req.method==='POST'&&sub==='/reload'){await p.reload({waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});return sendJson(res,{ok:true})}
    return sendJson(res,{error:'not found'},404);
  }catch(e){return sendJson(res,{error:String(e?.message||e)},500)}
});
server.listen(PORT,'127.0.0.1',()=>console.log('FLOW_REMOTE_READY',PORT,PREFIX));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{server.close();await browser.close().catch(()=>{});process.exit(0)});
