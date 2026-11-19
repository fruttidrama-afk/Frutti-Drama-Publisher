// Publisher Factory central dashboard - inspection only during reconstruction.
// No remote generation, review mutation, scheduling, or publishing is authorized here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createHash, timingSafeEqual } from 'node:crypto';
import { handleReconciliation } from './reconciliation-studio.mjs';
const PORT=Number(process.env.HUB_PORT||8081);
const MANIFEST=String(process.env.PUBLISHER_HUB_MANIFEST||'/data/factory-hub/channels.json');
const HUB_USER=String(process.env.PUBLISHER_HUB_USER||'operator');
const HUB_PASSWORD=String(process.env.PUBLISHER_HUB_PASSWORD||'');
const READY_FILE=String(process.env.PUBLISHER_HUB_READY_FILE||'/data/factory-hub/activation-readiness.json');
const GLOBAL_FILE=String(process.env.PUBLISHER_GLOBAL_ACTIVATION_FILE||'').trim();
const ACTIVATION_ARMED=String(process.env.PUBLISHER_HUB_ACTIVATION_ARMED||'false').toLowerCase()==='true';
const DATA_ROOT=path.resolve(String(process.env.PUBLISHER_HUB_DATA_ROOT||'/data'));
const RECON_MEDIA=String(process.env.PUBLISHER_RECONCILIATION_MEDIA_ROOT||'/data/reconciliation-media');
const RECON_STORE=String(process.env.PUBLISHER_RECONCILIATION_STORE_ROOT||'/data/reconciliation');
const AUDIT_FILE=String(process.env.PUBLISHER_HUB_AUDIT_FILE||(GLOBAL_FILE?path.join(path.dirname(GLOBAL_FILE),'operator-audit.ndjson'):'')).trim();
const eq=(a,b)=>{const A=createHash('sha256').update(String(a)).digest(),B=createHash('sha256').update(String(b)).digest();return timingSafeEqual(A,B)};
const escapeHtml=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');
function basic(req,res){
  if(!HUB_PASSWORD||HUB_PASSWORD.length<20||/^REPLACE_WITH_/i.test(HUB_PASSWORD)){res.writeHead(503);res.end('Hub not configured');return false}
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
      statusUrl:String(x.status_url||''),panelUrl:String(x.panel_url||''),dbPath:String(x.db_path||''),
      stagingState:x.staging_state==='not_deployed'?'not_deployed':'unknown'
    }));
  }catch{return []}
}
async function inspect(ch){
  if(!/^https?:\/\//.test(ch.statusUrl))return{...ch,state:'SIN CONFIGURAR',online:false};
  try{
    const url=new URL(ch.statusUrl);
    if(url.protocol!=='https:'&&!['127.0.0.1','localhost','publisher-'+ch.id].includes(url.hostname))throw Error('HTTPS required outside explicit Docker peer');
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(4000)});
    if(!response.ok)throw Error('HTTP '+response.status);
    const body=await response.json();
    const enabled=body.operator_activated===true&&body.publisher_enabled===true;
    return{...ch,state:enabled?'ACTIVA':'PAUSADA',online:true,flowReady:Boolean(body.flow?.authenticated&&body.flow?.configured),publicationReady:body.publication_connected===true,enabled};
  }catch(e){return{...ch,state:ch.stagingState==='not_deployed'?'NO DESPLEGADO':'SIN RESPUESTA',online:false,
    detail:ch.stagingState==='not_deployed'?'Ejecutor intencionalmente detenido durante la reconstrucción.':'El ejecutor no responde; requiere diagnóstico.',
    error:String(e.message||e).slice(0,100)}}
}
// Require an already-existing regular database inside the private data mount;
// reject symlinks escaping the root and never create missing child databases.
function allowedChildDb(dbPath){
  if(typeof dbPath!=='string'||!path.isAbsolute(dbPath))return false;
  const resolved=path.resolve(dbPath);
  if(!resolved.startsWith(DATA_ROOT+path.sep))return false;
  try{
    const base=fs.realpathSync(DATA_ROOT),actual=fs.realpathSync(resolved);
    return actual.startsWith(base+path.sep)&&fs.statSync(actual).isFile();
  }catch{return false}
}
function readiness(chs,states=[]){
  if(states.length!==chs.length||states.some(s=>s.online!==true||s.flowReady!==true||s.publicationReady!==true||s.enabled===true))return false;
  if(!ACTIVATION_ARMED||!GLOBAL_FILE||!chs.length)return false;
  try{
    const x=JSON.parse(fs.readFileSync(READY_FILE,'utf8'));
    const ids=chs.map(c=>c.id).sort();
    return x.schema===1&&x.all_tests_passed===true&&x.historical_reconciliation_completed===true
      &&Array.isArray(x.channel_ids)&&JSON.stringify([...x.channel_ids].sort())===JSON.stringify(ids)
      &&x.operator_preactivation_review_complete===true
      &&x.live_golden_test?.flow_generated===true
      &&x.live_golden_test?.recovered_to_review===true
      &&x.live_golden_test?.operator_approved_review===true
      &&x.live_golden_test?.youtube_private_uploaded===true
      &&x.live_golden_test?.operator_verified_on_youtube===true
      &&/^[a-zA-Z0-9_-]{11}$/.test(String(x.live_golden_test?.youtube_video_id||''))
      &&Number.isFinite(Date.parse(String(x.live_golden_test?.operator_verified_at||'')))
      &&chs.every(c=>allowedChildDb(c.dbPath));
  }catch{return false}
}
function writeActivation(enabled,activationId){
  if(!GLOBAL_FILE)throw Error('Global activation path not configured');
  fs.mkdirSync(path.dirname(GLOBAL_FILE),{recursive:true,mode:0o700});
  const file=GLOBAL_FILE+'.'+process.pid+'.tmp';
  fs.writeFileSync(file,JSON.stringify({schema:1,enabled,activated_by:'operator',activation_id:activationId,at:new Date().toISOString()}),{mode:0o600});
  fs.renameSync(file,GLOBAL_FILE);
}
// Hash-chained local audit provides accidental-tamper detection, not protection
// against a malicious host administrator who can rewrite all local files.
function auditHead(){
  if(!AUDIT_FILE)throw Error('Operator audit storage is not configured');
  if(!fs.existsSync(AUDIT_FILE))return '0'.repeat(64);
  let prev='0'.repeat(64);
  for(const line of fs.readFileSync(AUDIT_FILE,'utf8').split('\n').filter(Boolean)){
    let row;try{row=JSON.parse(line)}catch{throw Error('Operator audit contains invalid JSON')}
    const {recordHash,...data}=row;
    if(data.schema!==1||data.previousHash!==prev||recordHash!==createHash('sha256').update(prev+'\n'+JSON.stringify(data)).digest('hex')){
      throw Error('Operator audit chain invalid; activation is blocked');
    }
    prev=recordHash;
  }
  return prev;
}
function appendAudit(action,activationId,channelIds=[],details={}){
  const previousHash=auditHead();
  const data={schema:1,action,activationId,channelIds,details,at:new Date().toISOString(),previousHash};
  const recordHash=createHash('sha256').update(previousHash+'\n'+JSON.stringify(data)).digest('hex');
  fs.mkdirSync(path.dirname(AUDIT_FILE),{recursive:true,mode:0o700});
  fs.appendFileSync(AUDIT_FILE,JSON.stringify({...data,recordHash})+'\n',{mode:0o600});
  return recordHash;
}
function setChildGate(ch,enabled){
  if(!allowedChildDb(ch.dbPath))throw Error('Missing or unsafe child DB path');
  const db=new DatabaseSync(ch.dbPath,{timeout:5000});
  try{
    db.exec('BEGIN IMMEDIATE');
    const value=enabled?'true':'false';
    const stmt=db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    stmt.run('automation:operatorActivated',value);
    stmt.run('automation:factoryEnabled',value);
    stmt.run('automation:allowSubmit','0');
    db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK')}catch{}throw e}finally{db.close()}
}
function html(status,ready){
  const active=status.some(x=>x.enabled===true);
  const card=x=>{
    const safePanel=/^https:\/\//.test(x.panelUrl)||/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/\??$/.test(x.panelUrl);
    const link=(x.online===true&&safePanel)?'<a target="_blank" rel="noopener noreferrer" href="'+escapeHtml(x.panelUrl)+'">Abrir panel individual</a>':'<span>Panel individual pendiente del despliegue seguro</span>';
    return '<section class="card"><div class="eyebrow">'+escapeHtml(x.id)+'</div><h2>'+escapeHtml(x.name)+'</h2><p class="state">'+escapeHtml(x.state)+'</p><p>'+link+'</p><p><a href="/reconciliation?channel='+encodeURIComponent(x.id)+'">Conciliación histórica</a></p></section>';
  };
  return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Cache-Control" content="no-store"><title>Publisher Factory · Recuperación</title><style>' +
    'body{margin:0;background:#0d1724;color:#ecf2f7;font-family:system-ui,sans-serif;padding:28px}main{max-width:1100px;margin:auto}h1{font-size:clamp(2rem,5vw,3.4rem);margin:8px 0}.eyebrow{font-size:11px;letter-spacing:.2em;color:#b7a078;text-transform:uppercase}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:15px;margin:22px 0}.card{border:1px solid #46536a;background:#142336;border-radius:16px;padding:20px}.card h2{margin:10px 0}.state{font-weight:700}.help{color:#b5c3d1;line-height:1.6}a{color:#d9c497}.activate{background:#27394b;color:#b5c3d1;padding:16px;border:1px solid #46536a;border-radius:12px;font-weight:700;opacity:.7;cursor:not-allowed}' +
    '</style></head><body><main><div class="eyebrow">Publisher Factory / Modo reconstrucción</div><h1>Panel general</h1><p class="help">La fábrica permanece pausada. El estado de cada canal se consulta sin ejecutar ninguna acción externa. Railway no forma parte del nuevo runtime.</p><div class="grid">' +
    status.map(card).join('') + '</div>' + (ready?'<button class="activate" id="activate" type="button" style="cursor:pointer;opacity:1">Activar automatización</button>':'<button class="activate" type="button" disabled aria-disabled="true">Activar automatización — bloqueado hasta validación y conciliación</button>') + (active?'<button class="activate" id="stop" type="button" style="opacity:1;cursor:pointer;margin-left:12px">Detener automatización</button>':'')+'<p class="help">La activación requiere una prueba real de Flow→Review→YouTube privado, verificación humana y decisión explícita sobre el historial. Nunca se activa automáticamente.</p><script>const b=document.querySelector("#activate");if(b)b.onclick=async()=>{if(!confirm("¿Confirmás activar ambas automatizaciones en todos los canales?") )return;const r=await fetch("/api/activate",{method:"POST",headers:{"Content-Type":"application/json","X-Publisher-Operator":"explicit-click"},body:JSON.stringify({confirm:"ACTIVAR AUTOMATIZACIÓN"})});const x=await r.json().catch(()=>({}));alert(x.ok?"Activación solicitada":"Activación rechazada: "+(x.error||r.status));location.reload()};const stop=document.querySelector("#stop");if(stop)stop.onclick=async()=>{if(!confirm("¿Detener inmediatamente todas las automatizaciones?"))return;const r=await fetch("/api/stop",{method:"POST",headers:{"Content-Type":"application/json","X-Publisher-Operator":"explicit-click"},body:"{}"});const x=await r.json().catch(()=>({}));alert(x.ok?"Fábrica detenida":"No se pudo detener: "+(x.error||r.status));location.reload()};</script></main></body></html>';
}
const server=http.createServer(async(req,res)=>{
  if(!basic(req,res))return;
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  if(String(req.url||'').startsWith('/reconciliation')){
    const handled=await handleReconciliation(req,res,{channels:channels(),mediaRoot:RECON_MEDIA,storeRoot:RECON_STORE});
    if(handled)return;
  }
  if(req.method==='POST'&&req.url==='/api/stop'){
    if(req.headers['x-publisher-operator']!=='explicit-click'){res.writeHead(403);res.end('Forbidden');return}
    const origin=String(req.headers.origin||'');
    let validOrigin=true;try{if(origin)validOrigin=new URL(origin).host===String(req.headers.host||'')}catch{validOrigin=false}
    if(!validOrigin){res.writeHead(403);res.end('Origin mismatch');return}
    const activationId=randomUUID();
    try{
      // Global stop first: workers read this file at their external-action boundary.
      writeActivation(false,activationId);
      const errors=[];
      try{appendAudit('emergency_stop',activationId,channels().map(x=>x.id))}catch(e){errors.push('audit:'+String(e.message||e))}

      for(const ch of channels())try{setChildGate(ch,false)}catch(e){errors.push(ch.id+':'+String(e.message||e))}
      res.writeHead(errors.length?207:200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:errors.length===0,global_stopped:true,errors}));
    }catch(e){
      res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:String(e.message||e)}))
    }
    return;
  }
  if(req.method==='POST'&&req.url==='/api/activate'){
    if(req.headers['x-publisher-operator']!=='explicit-click'||!String(req.headers['content-type']||'').startsWith('application/json')){res.writeHead(403);res.end('Forbidden');return}
    const origin=String(req.headers.origin||'');
    let validOrigin=true;try{if(origin)validOrigin=new URL(origin).host===String(req.headers.host||'')}catch{validOrigin=false}
    if(!validOrigin){res.writeHead(403);res.end('Origin mismatch');return}
    const chs=channels(),states=await Promise.all(chs.map(inspect));
    if(!readiness(chs,states)){res.writeHead(423,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:'Pruebas, conciliación o habilitación pendiente'}));return}
    let body='';for await(const part of req){body+=part;if(body.length>1000){res.writeHead(413);res.end('Too large');return}}
    let answer={};try{answer=JSON.parse(body)}catch{}
    if(answer.confirm!=='ACTIVAR AUTOMATIZACIÓN'){res.writeHead(400);res.end('Confirmation mismatch');return}
    const activationId=randomUUID();
    try{
      // Abort before changing child DBs unless we can persist an audit record.
      appendAudit('activation_requested',activationId,chs.map(x=>x.id));
      writeActivation(false,activationId);
      for(const ch of chs)setChildGate(ch,true);
      // Audit completion before opening the global gate. If the audit cannot
      // be written the global gate remains OFF.
      appendAudit('activation_authorized',activationId,chs.map(x=>x.id));
      writeActivation(true,activationId);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,activation_id:activationId}));
    }catch(e){writeActivation(false,activationId);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:String(e.message||e)}))}
    return;
  }
  if(req.method!=='GET'){res.writeHead(405);res.end('Read-only reconstruction');return}
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,phase:'reconstruction',activation_allowed:false}));return}
  if(req.url!=='/'){res.writeHead(404);res.end('Not found');return}
  const states=await Promise.all(channels().map(inspect));
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html(states,readiness(channels(),states)));
});
server.listen(PORT,String(process.env.HUB_LISTEN_HOST||'127.0.0.1'),()=>console.log('Publisher Factory read-only hub listening',PORT));
