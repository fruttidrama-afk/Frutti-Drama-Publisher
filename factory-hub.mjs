// Publisher Factory central dashboard - inspection only during reconstruction.
// No remote generation, review mutation, scheduling, or publishing is authorized here.
import http from 'node:http';
import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
const PORT=Number(process.env.HUB_PORT||8081);
const MANIFEST=String(process.env.PUBLISHER_HUB_MANIFEST||'/data/factory-hub/channels.json');
const HUB_USER=String(process.env.PUBLISHER_HUB_USER||'operator');
const HUB_PASSWORD=String(process.env.PUBLISHER_HUB_PASSWORD||'');
const eq=(a,b)=>{const A=createHash('sha256').update(String(a)).digest(),B=createHash('sha256').update(String(b)).digest();return timingSafeEqual(A,B)};
const escapeHtml=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');
function basic(req,res){
  if(!HUB_PASSWORD||HUB_PASSWORD.length<20){res.writeHead(503);res.end('Hub not configured');return false}
  const value=String(req.headers.authorization||'');
  if(!value.startsWith('Basic ')){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Publisher Factory"'});res.end('Authentication required');return false}
  let credentials='';try{credentials=Buffer.from(value.slice(6),'base64').toString('utf8')}catch{}
  const idx=credentials.indexOf(':');
  if(idx<0||!eq(credentials.slice(0,idx),HUB_USER)||!eq(credentials.slice(idx+1),HUB_PASSWORD)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Publisher Factory"'});res.end('Unauthorized');return false}
  return true;
}
function channels(){
  try{
    const doc=JSON.parse(fs.readFileSync(MANIFEST,'utf8'));
    if(!Array.isArray(doc.channels))return [];
    return doc.channels.filter(x=>x&&/^[a-z0-9_-]{1,50}$/i.test(String(x.id||''))).slice(0,20).map(x=>({
      id:String(x.id),name:String(x.name||x.id).slice(0,80),
      statusUrl:String(x.status_url||''),panelUrl:String(x.panel_url||'')
    }));
  }catch{return []}
}
async function inspect(ch){
  if(!/^https?:\/\//.test(ch.statusUrl))return{...ch,state:'sin-configurar'};
  try{
    const url=new URL(ch.statusUrl);
    if(url.protocol!=='https:'&&url.hostname!=='127.0.0.1'&&url.hostname!=='localhost'&&url.hostname!=='publisher')throw Error('HTTPS required outside explicit Docker peer');
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw Error('HTTP '+response.status);
    const body=await response.json();
    const enabled=body.operator_activated===true&&body.publisher_enabled===true;
    return{...ch,state:enabled?'ACTIVA / INVESTIGAR':'PAUSADA',online:true,flowReady:Boolean(body.flow?.authenticated),publicationReady:Boolean(body.scheduler_alive),enabled};
  }catch(e){return{...ch,state:'SIN RESPUESTA',online:false,error:String(e.message||e).slice(0,100)}}
}
function html(status){
  const card=x=>{
    const link=/^https:\/\//.test(x.panelUrl)?'<a target="_blank" rel="noopener" href="'+escapeHtml(x.panelUrl)+'">Abrir panel individual</a>':'<span>Panel pendiente de enlace</span>';
    return '<section class="card"><div class="eyebrow">'+escapeHtml(x.id)+'</div><h2>'+escapeHtml(x.name)+'</h2><p class="state">'+escapeHtml(x.state)+'</p><p>'+link+'</p></section>';
  };
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Cache-Control" content="no-store"><title>Publisher Factory · Recuperación</title><style>' +
    'body{margin:0;background:#0d1724;color:#ecf2f7;font-family:system-ui,sans-serif;padding:28px}main{max-width:1100px;margin:auto}h1{font-size:clamp(2rem,5vw,3.4rem);margin:8px 0}.eyebrow{font-size:11px;letter-spacing:.2em;color:#b7a078;text-transform:uppercase}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:15px;margin:22px 0}.card{border:1px solid #46536a;background:#142336;border-radius:16px;padding:20px}.card h2{margin:10px 0}.state{font-weight:700}.help{color:#b5c3d1;line-height:1.6}a{color:#d9c497}.activate{background:#27394b;color:#b5c3d1;padding:16px;border:1px solid #46536a;border-radius:12px;font-weight:700;opacity:.7;cursor:not-allowed}' +
    '</style></head><body><main><div class="eyebrow">Publisher Factory / Modo reconstrucción</div><h1>Panel general</h1><p class="help">La fábrica permanece pausada. El estado de cada canal se consulta sin ejecutar ninguna acción externa. Railway no forma parte del nuevo runtime.</p><div class="grid">' +
    status.map(card).join('') + '</div><button class="activate" type="button" disabled aria-disabled="true">Activar automatización — bloqueado hasta validación y conciliación</button><p class="help">La activación exige una aprobación humana posterior. No existe ninguna acción automática que habilite este botón.</p></main></body></html>';
}
const server=http.createServer(async(req,res)=>{
  if(!basic(req,res))return;
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  if(req.method!=='GET'){res.writeHead(405);res.end('Read-only reconstruction');return}
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,phase:'reconstruction',activation_allowed:false}));return}
  if(req.url!=='/'){res.writeHead(404);res.end('Not found');return}
  const states=await Promise.all(channels().map(inspect));
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html(states));
});
server.listen(PORT,String(process.env.HUB_LISTEN_HOST||'127.0.0.1'),()=>console.log('Publisher Factory read-only hub listening',PORT));
