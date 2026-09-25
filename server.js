// RELEASE: approval-gated review media + rejection purge v1

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { google } from 'googleapis';
import {
  randomBytes,createHash,createHmac,timingSafeEqual,pbkdf2Sync,
  createCipheriv,createDecipheriv
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  generateRegistrationOptions,verifyRegistrationResponse,
  generateAuthenticationOptions,verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { CONFIG,PROJECT_ID,PROJECT_NAME,PROJECT_URL,DAILY_LIMIT,TIMEZONE,ideaForEpisode,ensureBacklog,materializeCreativePackage } from './runtime-config.js';
import { installPublication } from './publication.js';
import { installFacebookPublication } from './publication-facebook.js';
import { buildPublicationCopy } from './publication-copy.js';
import { signedReviewUrl, deleteReviewObject, isReviewStorageUri, uploadReviewFile } from './review-storage.js';

google.options({timeout:90000,retry:false});
const app=express(),PORT=Number(process.env.PORT||8080);
app.set('trust proxy',1);
const DATA_DIR=path.resolve(process.env.DATA_DIR||'/data'),DIR=path.join(DATA_DIR,'publisher-runtime'),DB_PATH=path.join(DIR,'factory.sqlite');
const AUTH_PATH=path.join(DIR,'auth.json'),SECRET_PATH=path.join(DIR,'secrets.json'),YT_TOKEN_PATH=path.join(DIR,'youtube-token.json');
const SESSION_COOKIE='publisher_session',TTL=365*24*60*60*1000;
fs.mkdirSync(DIR,{recursive:true,mode:0o700});
const db=new DatabaseSync(DB_PATH,{timeout:5000});
for(const sql of [
  "ALTER TABLE factory_items ADD COLUMN reviewFeedback TEXT",
  "ALTER TABLE factory_items ADD COLUMN retryStrategy TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewRetryToken TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewRetrySubmittedToken TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewContentHash TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewInterpretation TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewInterpretationAt TEXT",
  "ALTER TABLE factory_items ADD COLUMN creativePackageHash TEXT",
  "ALTER TABLE factory_items ADD COLUMN creativePackageId TEXT",
  "ALTER TABLE factory_generations ADD COLUMN generationKind TEXT NOT NULL DEFAULT 'automatic'"
]){try{db.exec(sql)}catch{}}

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:false,limit:'256kb'}));

function applyForcedNewIntentsAtStartup(){
  let forced={};
  try{forced=JSON.parse(String(process.env.PUBLISHER_FORCE_NEW_INTENTS_JSON||'{}'))||{}}catch{return}
  for(const [episodeKey,intent] of Object.entries(forced)){
    const episode=Number(episodeKey);if(!Number.isInteger(episode)||episode<1)continue;
    let row=db.prepare('SELECT * FROM factory_items WHERE episode=? ORDER BY season DESC LIMIT 1').get(episode);
    if(!row||!String(row.reviewFeedback||'').trim())continue;
    const hook=String(intent?.hook||'').trim(),story=String(intent?.story||'').trim();
    if(!hook||!story)continue;
    const alreadyApplied=String(row.hook||'')===hook&&String(row.story||'')===story&&String(row.prompt||'').includes('HOOK: '+hook);
    const out=alreadyApplied?{row}:materializeCreativePackage(db,row,{force:true});
    row=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||out.row||row;
    let redoReauthorized=false;
    // The current operator explicitly requested a NEW redo for this replacement
    // intent. A legacy consumed/ambiguous retry must not keep the new creative
    // package in manual_hold. Mint one fresh retry token exactly once.
    if(String(row.status||'')==='manual_hold'){
      try{if(row.videoPath&&fs.existsSync(row.videoPath))fs.rmSync(row.videoPath,{force:true})}catch{}
      const retryToken=randomBytes(24).toString('hex'),stamp=new Date().toISOString();
      db.prepare(`UPDATE factory_items SET status='regen_wait',retryStrategy='revise_prompt',reviewRetryToken=?,reviewRetrySubmittedToken=NULL,videoPath=NULL,remoteUrl=NULL,providerRunId=NULL,flowResult=NULL,reviewVideoId=NULL,reviewArchivedAt=NULL,reviewOriginalSize=NULL,reviewPreviewSize=NULL,reviewArchiveError=NULL,reviewContentHash=NULL,error='Nuevo Rehacer autorizado por el operador para el concepto reemplazado.',nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?`)
        .run(retryToken,stamp,stamp,row.id);
      row=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row;
      redoReauthorized=true;
    }
    console.log('[FORCED NEW EPISODE INTENT APPLIED]',JSON.stringify({episode,hook:row?.hook||hook,title:row?.title||null,status:row?.status||null,redoReauthorized}));
  }
}
try{applyForcedNewIntentsAtStartup()}catch(e){console.error('[FORCED NEW EPISODE INTENT ERROR]',String(e?.message||e))}


const now=()=>new Date().toISOString();
const safeEq=(a,b)=>{const A=Buffer.from(String(a)),B=Buffer.from(String(b));return A.length===B.length&&timingSafeEqual(A,B)};
const master=()=>createHash('sha256').update(String(process.env.PUBLISHER_SESSION_SECRET||'publisher-runtime-local')).digest();
function seal(v){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',master(),iv),data=Buffer.concat([c.update(JSON.stringify(v),'utf8'),c.final()]);return{v:1,iv:iv.toString('base64url'),tag:c.getAuthTag().toString('base64url'),data:data.toString('base64url')}}
function unseal(o){const d=createDecipheriv('aes-256-gcm',master(),Buffer.from(o.iv,'base64url'));d.setAuthTag(Buffer.from(o.tag,'base64url'));return JSON.parse(Buffer.concat([d.update(Buffer.from(o.data,'base64url')),d.final()]).toString('utf8'))}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return structuredClone(fallback)}}
function writeJson(file,v){const tmp=file+'.'+randomBytes(5).toString('hex')+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2),{mode:0o600});fs.renameSync(tmp,file)}
function authState(){const x=readJson(AUTH_PATH,{pinSalt:null,pinHash:null,webauthnUserID:null,passkeys:[],sessions:[],setupAt:null});x.passkeys=Array.isArray(x.passkeys)?x.passkeys:[];x.sessions=Array.isArray(x.sessions)?x.sessions:[];return x}
function saveAuth(x){writeJson(AUTH_PATH,x)}
function secrets(){const x=readJson(SECRET_PATH,null);if(!x)return{};try{return unseal(x)}catch{return{}}}
function saveSecrets(v){writeJson(SECRET_PATH,seal(v))}
function setPin(pin){const s=authState(),salt=randomBytes(18).toString('hex');s.pinSalt=salt;s.pinHash=pbkdf2Sync(pin,Buffer.from(salt,'hex'),210000,32,'sha256').toString('hex');s.setupAt=s.setupAt||now();saveAuth(s)}
function pinOk(pin){const s=authState();if(!s.pinSalt||!s.pinHash)return false;return safeEq(s.pinHash,pbkdf2Sync(String(pin),Buffer.from(s.pinSalt,'hex'),210000,32,'sha256').toString('hex'))}
function cookie(req){const out={};for(const x of String(req.headers.cookie||'').split(';')){const i=x.indexOf('=');if(i>0)out[x.slice(0,i).trim()]=decodeURIComponent(x.slice(i+1).trim())}return out}
function sign(v){return createHmac('sha256',master()).update(v).digest('base64url')}
function sessionParse(req){const t=cookie(req)[SESSION_COOKIE];if(!t)return null;const p=t.split('.');if(p.length!==3)return null;const exp=Number(p[0]);if(!Number.isFinite(exp)||exp<Date.now()||!safeEq(p[2],sign(p[0]+'.'+p[1])))return null;return{id:createHash('sha256').update(p[1]).digest('base64url'),exp,nonce:p[1]}}
function device(req){const ua=String(req.headers['user-agent']||'');if(/iPhone/i.test(ua))return'iPhone';if(/iPad/i.test(ua))return'iPad';if(/Android/i.test(ua))return /Mobile/i.test(ua)?'Android':'Android tablet';if(/Windows/i.test(ua))return'Windows PC';if(/Macintosh/i.test(ua))return'Mac';return'Browser'}
function issue(req,res,method='pin'){const exp=Date.now()+TTL,nonce=randomBytes(18).toString('base64url'),payload=String(exp)+'.'+nonce;res.cookie(SESSION_COOKIE,payload+'.'+sign(payload),{httpOnly:true,sameSite:'lax',secure:Boolean(process.env.RAILWAY_ENVIRONMENT),path:'/',maxAge:TTL});const s=authState(),id=createHash('sha256').update(nonce).digest('base64url');s.sessions=(s.sessions||[]).filter(x=>x.expiresAt>Date.now()&&!x.revokedAt);s.sessions.push({id,device:device(req),createdAt:now(),lastSeenAt:now(),expiresAt:exp,method});saveAuth(s)}
function valid(req){const x=sessionParse(req);if(!x)return false;const s=authState(),r=s.sessions.find(y=>y.id===x.id);if(r?.revokedAt)return false;if(!r){s.sessions.push({id:x.id,device:device(req),createdAt:now(),lastSeenAt:now(),expiresAt:x.exp,method:'existing'});saveAuth(s)}else if(Date.now()-Date.parse(r.lastSeenAt||0)>5*60*1000){r.lastSeenAt=now();saveAuth(s)}return true}
function configured(){const s=authState();return Boolean(s.pinHash||s.passkeys.length)}
function htmlReq(req){return req.method==='GET'&&String(req.headers.accept||'').includes('text/html')}
function secure(req,res,next){
  if(valid(req))return next();
  const loginPath=configured()?'/login':'/setup';
  if(htmlReq(req))return res.redirect(loginPath);
  return res.status(401).json({error:'Access required.',login:loginPath});
}

const rp=()=>String(process.env.RAILWAY_PUBLIC_DOMAIN||process.env.PUBLISHER_PUBLIC_DOMAIN||'localhost').replace(/^https?:\/\//,'').split('/')[0];
const origin=req=>{
  const configured=String(process.env.PUBLISHER_PUBLIC_URL||'').trim().replace(/\/$/,'');
  if(configured)return configured;
  const railway=String(process.env.RAILWAY_PUBLIC_DOMAIN||process.env.PUBLISHER_PUBLIC_DOMAIN||'').trim().replace(/^https?:\/\//,'').split('/')[0];
  if(railway)return 'https://'+railway;
  const forwarded=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();
  const proto=forwarded||req.protocol||'http';
  return (proto+'://'+req.get('host')).replace(/\/$/,'');
};
const regChallenges=new Map(),authChallenges=new Map();
function passkeysPublic(){return authState().passkeys.map(x=>({id:x.id,name:x.name||'Passkey',createdAt:x.createdAt,lastUsedAt:x.lastUsedAt,deviceType:x.deviceType,backedUp:Boolean(x.backedUp)}))}

app.get('/setup',(req,res)=>{
  if(valid(req))return res.redirect('/');
  const brand=brandPublic(),t=brand.theme||{},show=String(CONFIG.identity.show_name||CONFIG.identity.publisher_name||'Publisher'),
    referenceBackdrop=(brand.reference_mode==='web_design'||brand.render_reference_image===false)?null:brand.reference_image_url,
    esc=x=>String(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="${esc(t.primary||'#0d3152')}"><title>Activar ${esc(show)}</title>
<style>
:root{--n:${esc(t.primary||'#0d3152')};--g:${esc(t.accent||t.secondary||'#b59a64')};--bg:${esc(t.background||'#071018')};--surface:${esc(t.surface||'#10232f')};--ink:${esc(t.text||'#f5f3ed')};--m:color-mix(in srgb,var(--ink) 70%,transparent)}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:${referenceBackdrop?'linear-gradient(180deg,rgba(0,0,0,.42),rgba(0,0,0,.72)),url("'+esc(referenceBackdrop)+'")':'radial-gradient(circle at 20% 0%,color-mix(in srgb,var(--g) 18%,transparent),transparent 34%),linear-gradient(145deg,var(--n),var(--bg))'};background-size:cover;background-position:center;font-family:Arial,sans-serif;padding:24px;color:var(--ink)}
.c{width:min(520px,100%);background:color-mix(in srgb,var(--surface) 82%,transparent);border:1px solid color-mix(in srgb,var(--ink) 16%,transparent);padding:30px;text-align:center;border-radius:28px;backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);box-shadow:0 28px 90px rgba(0,0,0,.34)}
.logo{width:96px;height:96px;object-fit:cover;border-radius:24px;margin:0 auto 14px;display:${brand.logo_url?'block':'none'};box-shadow:0 14px 44px rgba(0,0,0,.25)}
.mark{font:600 28px/.95 Arial,sans-serif;letter-spacing:.08em;color:var(--ink);margin-bottom:6px}.tag{font-size:10px;letter-spacing:.16em;color:var(--m);margin-bottom:22px}.eye{font-size:11px;letter-spacing:.2em;color:var(--g);font-weight:800;margin-bottom:10px}
h1{font:600 42px/.98 Arial,sans-serif;letter-spacing:.01em;margin:0 0 14px}.muted{color:var(--m);line-height:1.5}.err{color:#ffb2a8;font-size:13px;margin-top:14px}
.spin{width:26px;height:26px;border:3px solid color-mix(in srgb,var(--ink) 20%,transparent);border-top-color:var(--g);border-radius:50%;margin:20px auto;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
.actions{display:none;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:20px}.actions.show{display:flex}.btn{border:1px solid color-mix(in srgb,var(--ink) 24%,transparent);background:transparent;color:var(--ink);padding:13px 18px;font-weight:800;letter-spacing:.04em;cursor:pointer}.btn.primary{background:var(--g);border-color:var(--g);color:#111}
</style></head><body><main class=c>${brand.logo_url?'<img class="logo" src="'+esc(brand.logo_url)+'" alt="">':''}<div class=mark>${esc(show)}</div><div class=tag>${esc(brand.tagline||'')}</div><div class=eye>DEVICE ACCESS</div><h1 id=t>Opening your Publisher</h1><div id=spin class=spin></div><p id=m class=muted>Validating this device…</p><div id=actions class=actions><button id=key class="btn primary" type=button>CREATE DEVICE KEY</button><button id=continue class=btn type=button style="display:none">CONTINUE THIS SESSION</button></div><div id=e class=err></div></main>
<script>
const q=s=>document.querySelector(s),t=q('#t'),m=q('#m'),e=q('#e'),spin=q('#spin'),actions=q('#actions'),key=q('#key'),cont=q('#continue');
const fromB64url=v=>{const s=String(v||'').split('-').join('+').split('_').join('/'),p=s+'='.repeat((4-s.length%4)%4),raw=atob(p),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out};
const toB64url=v=>{let s='';for(const x of new Uint8Array(v))s+=String.fromCharCode(x);return btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/,'')};
const deviceName=()=>/iPad/i.test(navigator.userAgent)?'iPad':/iPhone/i.test(navigator.userAgent)?'iPhone':/Android/i.test(navigator.userAgent)?'Android':/Macintosh/i.test(navigator.userAgent)?'Mac':/Windows/i.test(navigator.userAgent)?'Windows PC':'This device';
async function req(url,opt={}){const r=await fetch(url,{headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
async function createKey(){
  key.disabled=true;e.textContent='';m.textContent='Confirmá Face ID / Touch ID / bloqueo del dispositivo para guardar esta llave.';
  try{
    if(!window.PublicKeyCredential||!navigator.credentials)throw new Error('Este navegador no permite crear una passkey.');
    const raw=await req('/auth/passkeys/register/options',{method:'POST',body:'{}'}),binding=raw._binding,o={...raw};delete o._binding;
    o.challenge=fromB64url(o.challenge);o.user={...o.user,id:fromB64url(o.user.id)};o.excludeCredentials=(o.excludeCredentials||[]).map(x=>({...x,id:fromB64url(x.id)}));
    const cred=await navigator.credentials.create({publicKey:o});if(!cred)throw new Error('Se canceló la creación de la llave.');
    const credential={id:cred.id,rawId:toB64url(cred.rawId),type:cred.type,authenticatorAttachment:cred.authenticatorAttachment||null,clientExtensionResults:cred.getClientExtensionResults?.()||{},response:{clientDataJSON:toB64url(cred.response.clientDataJSON),attestationObject:toB64url(cred.response.attestationObject),transports:cred.response.getTransports?.()||[]}};
    await req('/auth/passkeys/register/verify',{method:'POST',body:JSON.stringify({_binding:binding,name:deviceName(),credential})});
    localStorage.setItem('publisher_device_key_registered','1');
    m.textContent='Listo. Este dispositivo quedó autorizado.';location.replace('/');
  }catch(x){e.textContent=x.message;key.disabled=false;cont.style.display='inline-block';m.textContent='Podés volver a intentar o continuar con esta sesión.'}
}
(async()=>{
  const raw=location.hash.startsWith('#code=')?decodeURIComponent(location.hash.slice(6)):'';
  if(!raw){
    spin.style.display='none';
    if(localStorage.getItem('publisher_device_key_registered')==='1'){location.replace('/login');return}
    t.textContent='Open Publisher once';
    m.textContent='Abrí este Publisher una sola vez desde OPEN PUBLISHER en Publisher Factory para autorizar este dispositivo.';
    return;
  }
  try{
    history.replaceState(null,'',location.pathname);
    await req('/setup/activate',{method:'POST',body:JSON.stringify({token:raw})});
    if(localStorage.getItem('publisher_device_key_registered')==='1'){m.textContent='Device recognized.';location.replace('/');return}
    spin.style.display='none';t.textContent='Create a key for this device';m.textContent='Esto se hace una sola vez. Después vas a poder entrar directamente a este Publisher desde este dispositivo.';actions.classList.add('show');
  }catch(x){spin.style.display='none';t.textContent='Activation failed';e.textContent=x.message}
})();
key.onclick=createKey;cont.onclick=()=>location.replace('/');
</script></body></html>`)});
app.post('/setup/activate',(req,res)=>{const expected=String(process.env.PUBLISHER_SETUP_TOKEN||''),token=String(req.body?.token||'');if(!expected||!safeEq(token,expected))return res.status(401).json({error:'Activation link is invalid or expired.'});if(!configured())setPin(String(Math.floor(100000+Math.random()*900000)));issue(req,res,'factory-open');res.json({ok:true,passkeysRegistered:authState().passkeys.length,device:device(req)})});
app.get('/login',(req,res)=>res.sendFile('login.html',{root:'public'}));
app.get('/auth/public-info',(req,res)=>{const a=authState();res.json({publisherName:CONFIG.identity.publisher_name,showName:CONFIG.identity.show_name,passkeysRegistered:a.passkeys.length,brand:brandPublic()})});
app.post('/auth/pin',(req,res)=>{const pin=String(req.body.pin||'');if(!pinOk(pin))return res.status(401).json({error:'Incorrect PIN.'});issue(req,res,'pin');res.json({ok:true})});
app.post('/auth/logout',secure,(req,res)=>{const x=sessionParse(req),s=authState();if(x){const r=s.sessions.find(y=>y.id===x.id);if(r)r.revokedAt=now();saveAuth(s)}res.clearCookie(SESSION_COOKIE,{path:'/'});res.json({ok:true})});

app.post('/auth/passkeys/register/options',secure,async(req,res)=>{try{const s=authState();if(!s.webauthnUserID){s.webauthnUserID=randomBytes(32).toString('base64url');saveAuth(s)}const options=await generateRegistrationOptions({rpName:CONFIG.identity.publisher_name,rpID:rp(),userID:Buffer.from(s.webauthnUserID,'base64url'),userName:'publisher-owner',userDisplayName:CONFIG.identity.show_name,attestationType:'none',excludeCredentials:s.passkeys.map(x=>({id:x.id,transports:x.transports||[]})),authenticatorSelection:{residentKey:'required',userVerification:'required'}});const key=sessionParse(req)?.id||randomBytes(12).toString('hex');regChallenges.set(key,{challenge:options.challenge,expires:Date.now()+5*60*1000});res.json({...options,_binding:key})}catch(e){res.status(500).json({error:e.message})}});
app.post('/auth/passkeys/register/verify',secure,async(req,res)=>{try{const key=String(req.body._binding||sessionParse(req)?.id||''),p=regChallenges.get(key);regChallenges.delete(key);if(!p||p.expires<Date.now())throw new Error('Passkey request expired.');const v=await verifyRegistrationResponse({response:req.body.credential,expectedChallenge:p.challenge,expectedOrigin:origin(req),expectedRPID:rp(),requireUserVerification:true});if(!v.verified||!v.registrationInfo)throw new Error('Passkey verification failed.');const s=authState(),c=v.registrationInfo.credential,existing=s.passkeys.find(x=>x.id===c.id),record={id:c.id,publicKey:Buffer.from(c.publicKey).toString('base64url'),counter:Number(c.counter||0),transports:c.transports||[],deviceType:v.registrationInfo.credentialDeviceType||null,backedUp:Boolean(v.registrationInfo.credentialBackedUp),createdAt:existing?.createdAt||now(),lastUsedAt:null,name:String(req.body.name||('Passkey '+(s.passkeys.length+1))).slice(0,60)};s.passkeys=existing?s.passkeys.map(x=>x.id===record.id?record:x):[...s.passkeys,record];saveAuth(s);res.json({ok:true,passkeys:passkeysPublic()})}catch(e){res.status(400).json({error:e.message})}});
app.post('/auth/passkeys/options',async(req,res)=>{try{const s=authState();if(!s.passkeys.length)return res.status(409).json({error:'No passkeys registered.'});const o=await generateAuthenticationOptions({rpID:rp(),userVerification:'required',allowCredentials:s.passkeys.map(x=>({id:x.id,transports:x.transports||[]}))}),key=randomBytes(18).toString('base64url');authChallenges.set(key,{challenge:o.challenge,expires:Date.now()+5*60*1000});res.cookie('publisher_webauthn',key,{httpOnly:true,sameSite:'strict',secure:Boolean(process.env.RAILWAY_ENVIRONMENT),maxAge:5*60*1000,path:'/auth/passkeys'});res.json(o)}catch(e){res.status(500).json({error:e.message})}});
app.post('/auth/passkeys/verify',async(req,res)=>{try{const key=cookie(req).publisher_webauthn,p=authChallenges.get(key);authChallenges.delete(key);if(!p||p.expires<Date.now())throw new Error('Passkey request expired.');const s=authState(),cred=s.passkeys.find(x=>x.id===req.body.credential?.id);if(!cred)throw new Error('Unknown passkey.');const v=await verifyAuthenticationResponse({response:req.body.credential,expectedChallenge:p.challenge,expectedOrigin:origin(req),expectedRPID:rp(),credential:{id:cred.id,publicKey:new Uint8Array(Buffer.from(cred.publicKey,'base64url')),counter:Number(cred.counter||0),transports:cred.transports||[]},requireUserVerification:true});if(!v.verified)throw new Error('Passkey rejected.');cred.counter=Number(v.authenticationInfo?.newCounter??cred.counter);cred.lastUsedAt=now();saveAuth(s);issue(req,res,'passkey');res.json({ok:true})}catch(e){res.status(401).json({error:e.message})}});
app.get('/auth/passkeys',secure,(req,res)=>res.json({passkeys:passkeysPublic()}));
app.delete('/auth/passkeys/:id',secure,(req,res)=>{const s=authState(),i=s.passkeys.findIndex(x=>x.id===req.params.id);if(i<0)return res.sendStatus(404);if(s.passkeys.length<=1)return res.status(409).json({error:'Register another passkey before deleting the only one.'});s.passkeys.splice(i,1);saveAuth(s);res.json({ok:true})});
app.get('/auth/sessions',secure,(req,res)=>{const cur=sessionParse(req)?.id,s=authState();res.json({count:s.sessions.filter(x=>x.expiresAt>Date.now()&&!x.revokedAt).length,sessions:s.sessions.filter(x=>x.expiresAt>Date.now()&&!x.revokedAt).map(x=>({...x,current:x.id===cur}))})});
app.delete('/auth/sessions/:id',secure,(req,res)=>{const s=authState(),r=s.sessions.find(x=>x.id===req.params.id);if(!r)return res.sendStatus(404);r.revokedAt=now();saveAuth(s);if(sessionParse(req)?.id===r.id)res.clearCookie(SESSION_COOKIE,{path:'/'});res.json({ok:true,current:r.id===sessionParse(req)?.id})});
app.post('/auth/pin/change',secure,(req,res)=>{const old=String(req.body.currentPin||''),next=String(req.body.newPin||'');if(!pinOk(old))return res.status(401).json({error:'Current PIN is incorrect.'});if(!/^\d{6}$/.test(next))return res.status(400).json({error:'New PIN must contain six digits.'});setPin(next);res.json({ok:true})});

function isDinnieBrand(){return /dinnie\s*(?:the\s*)?dinosaur|dinnie/i.test(String(CONFIG.identity?.show_name||CONFIG.identity?.publisher_name||''))}
function dinnieStaticIconBuffer(){
  try{return Buffer.from(fs.readFileSync(path.join('public','dinnie-touch-icon.b64'),'utf8').trim(),'base64')}catch{return null}
}
async function dinnieStaticIconPng(size=180){
  const buf=dinnieStaticIconBuffer();if(!buf)return null;
  const s=Math.max(64,Math.min(1024,Number(size)||180));
  if(s===180)return buf;
  return sharp(buf).resize(s,s,{fit:'fill'}).png({compressionLevel:9}).toBuffer();
}
async function dinnieIosV2Png(){
  // Exact prebuilt 180x180 PNG. No runtime resizing, no redirect, no white or
  // transparent outer canvas. This mirrors the previously proven iOS path.
  return dinnieStaticIconBuffer();
}
function brandPublic(){
  const b=CONFIG.branding||{},t=b.theme||{},hasLogo=Boolean(String(b.logo_url||'').trim());
  return{
    reference_mode:b.reference_mode||null,
    reference_image_url:b.reference_image_url||null,
    render_reference_image:b.render_reference_image!==false&&b.reference_mode!=='web_design',
    reference_usage:b.reference_usage||null,
    // Always expose the brand through same-origin endpoints. This avoids iOS
    // broken-image behavior from third-party storage redirects and lets us
    // normalize transparency/padding consistently.
    logo_url:hasLogo?'/brand/logo.png?v=20260925-botanical':null,
    icon_180_url:isDinnieBrand()?'/apple-touch-icon-dinnie-v2.png':'/apple-touch-icon.png?v=20260925-finalfill',
    icon_192_url:isDinnieBrand()?'/apple-touch-icon-dinnie-v2.png':'/brand/icon-192.png?v=20260925-finalfill',
    icon_512_url:isDinnieBrand()?'/apple-touch-icon-dinnie-v2.png':'/brand/icon-512.png?v=20260925-finalfill',
    maskable_icon_url:isDinnieBrand()?'/apple-touch-icon-dinnie-v2.png':'/brand/icon-maskable-512.png?v=20260925-finalfill',
    safe_area_ratio:Number(b.safe_area_ratio||.8),
    tagline:b.tagline||CONFIG.identity.description||'',
    theme:{primary:t.primary||'#0d3152',secondary:t.secondary||'#b59a64',accent:t.accent||'#b59a64',background:t.background||'#f7f6f2',surface:t.surface||'#ffffff',text:t.text||'#1d1d1b'}
  }
}
function fallbackBrandSvg(){
  const n=String(CONFIG.identity.show_name||CONFIG.identity.publisher_name||'P').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase().slice(0,2)||'P',b=brandPublic(),t=b.theme;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="108" fill="'+t.background+'"/><rect x="82" y="82" width="348" height="348" rx="72" fill="'+t.primary+'"/><text x="256" y="305" text-anchor="middle" font-family="Arial,sans-serif" font-size="165" font-weight="700" fill="#ffffff">'+n.replace(/[&<>]/g,'')+'</text></svg>'
}
function safeHex(v,fallback){
  const s=String(v||'').trim();
  return /^#[0-9a-f]{6}$/i.test(s)?s:fallback;
}
async function sourceBrandLogo(){
  const u=String(CONFIG.branding?.logo_url||'').trim();
  if(!u)return null;
  const r=await fetch(u,{headers:{'User-Agent':'PublisherRuntime/1.0','Cache-Control':'no-cache'}});
  if(!r.ok)throw new Error('Brand logo fetch failed: HTTP '+r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function normalizedBrandLogoPng(){
  try{
    const src=await sourceBrandLogo();
    if(src){
      return await sharp(src,{failOn:'none'})
        .ensureAlpha()
        .trim({background:{r:0,g:0,b:0,alpha:0},threshold:8})
        .resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true})
        .png({compressionLevel:9})
        .toBuffer();
    }
  }catch(e){console.error('[BRAND LOGO PROXY]',String(e?.message||e))}
  return sharp(Buffer.from(fallbackBrandSvg())).png().toBuffer();
}
function botanicalIconBackdrop(size){
  const t=brandPublic().theme,bg=safeHex(t.background,'#071a12'),primary=safeHex(t.primary,'#123d28'),secondary=safeHex(t.secondary,'#5f8c61'),accent=safeHex(t.accent,'#8bbd70');
  const s=Number(size);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <radialGradient id="g" cx="50%" cy="42%" r="72%">
      <stop offset="0" stop-color="${primary}"/>
      <stop offset="1" stop-color="${bg}"/>
    </radialGradient>
  </defs>
  <rect width="${s}" height="${s}" fill="url(#g)"/>
  <g fill="none" stroke="${secondary}" stroke-width="${Math.max(2,s*.018)}" stroke-linecap="round" opacity=".42">
    <path d="M${-s*.03} ${s*.74} C ${s*.13} ${s*.58}, ${s*.16} ${s*.33}, ${s*.12} ${s*.06}"/>
    <path d="M${s*1.03} ${s*.78} C ${s*.86} ${s*.62}, ${s*.84} ${s*.33}, ${s*.90} ${s*.04}"/>
  </g>
  <g fill="${secondary}" opacity=".30">
    <ellipse cx="${s*.075}" cy="${s*.60}" rx="${s*.07}" ry="${s*.17}" transform="rotate(-38 ${s*.075} ${s*.60})"/>
    <ellipse cx="${s*.15}" cy="${s*.39}" rx="${s*.065}" ry="${s*.15}" transform="rotate(24 ${s*.15} ${s*.39})"/>
    <ellipse cx="${s*.925}" cy="${s*.63}" rx="${s*.07}" ry="${s*.17}" transform="rotate(38 ${s*.925} ${s*.63})"/>
    <ellipse cx="${s*.86}" cy="${s*.40}" rx="${s*.065}" ry="${s*.15}" transform="rotate(-24 ${s*.86} ${s*.40})"/>
  </g>
  <circle cx="${s*.50}" cy="${s*.49}" r="${s*.36}" fill="${accent}" opacity=".075"/>
  </svg>`;
}
async function brandedIconPng(size,{maskable=false}={}){
  const s=Math.max(64,Math.min(1024,Number(size)||180));
  let logo;
  try{
    const src=await sourceBrandLogo();
    if(src){
      // The source artwork can contain either transparent padding or a white
      // matte around the actual Dinnie mark. Remove BOTH before sizing it for
      // iOS so the artwork is not left floating as a tiny poster in a white
      // square.
      let pipeline=sharp(src,{failOn:'none'}).ensureAlpha();
      pipeline=pipeline.trim({background:{r:255,g:255,b:255,alpha:255},threshold:28});
      pipeline=pipeline.trim({background:{r:0,g:0,b:0,alpha:0},threshold:10});
      logo=await pipeline
        .resize({
          width:Math.round(s*(maskable?.90:.98)),
          height:Math.round(s*(maskable?.90:.98)),
          fit:'inside',
          withoutEnlargement:false
        })
        .png()
        .toBuffer();
    }
  }catch(e){console.error('[BRAND ICON SOURCE]',String(e?.message||e))}
  if(!logo){
    logo=await sharp(Buffer.from(fallbackBrandSvg()))
      .resize({width:Math.round(s*.90),height:Math.round(s*.90),fit:'inside'})
      .png().toBuffer();
  }

  // OPAQUE full-bleed background. iOS must never receive transparency or a
  // white canvas around the artwork.
  const bg=await sharp(Buffer.from(botanicalIconBackdrop(s)))
    .flatten({background:'#123d28'})
    .png()
    .toBuffer();

  return sharp(bg)
    .composite([{input:logo,gravity:'center'}])
    .flatten({background:'#123d28'})
    .png({compressionLevel:9})
    .toBuffer();
}
app.get('/dinnie-touch-icon.png',(req,res)=>{
  const buf=dinnieStaticIconBuffer();
  if(!buf)return res.sendStatus(404);
  res.set('Cache-Control','no-store, max-age=0');
  res.set('Content-Type','image/png');
  res.set('Content-Length',String(buf.length));
  res.send(buf);
});
app.get('/apple-touch-icon-dinnie-v2.png',async(req,res)=>{
  const buf=await dinnieIosV2Png();
  if(!buf)return res.sendStatus(404);
  res.set('Cache-Control','no-store, max-age=0');
  res.set('Content-Type','image/png');
  res.set('Content-Length',String(buf.length));
  res.send(buf);
});
app.get('/favicon.ico',(req,res)=>{
  if(!isDinnieBrand())return res.redirect(302,'/brand/icon-192.png');
  const buf=dinnieStaticIconBuffer();if(!buf)return res.sendStatus(404);
  res.set('Cache-Control','no-store, max-age=0');res.type('image/png').send(buf);
});
app.get('/brand/logo.svg',async(req,res)=>{res.set('Cache-Control','no-store, max-age=0');res.type('image/png').send(await normalizedBrandLogoPng())});
app.get('/brand/logo.png',async(req,res)=>{res.set('Cache-Control','no-store, max-age=0');res.type('image/png').send(await normalizedBrandLogoPng())});
app.get('/apple-touch-icon.png',async(req,res)=>{res.set('Cache-Control','no-store, max-age=0');res.type('image/png').send(isDinnieBrand()?await dinnieStaticIconPng(180):await brandedIconPng(180))});
app.get('/brand/icon-192.png',async(req,res)=>{res.set('Cache-Control','no-store, max-age=0');res.type('image/png').send(isDinnieBrand()?await dinnieStaticIconPng(192):await brandedIconPng(192))});
app.get('/brand/icon-512.png',async(req,res)=>{res.set('Cache-Control','no-store, max-age=0');res.type('image/png').send(isDinnieBrand()?await dinnieStaticIconPng(512):await brandedIconPng(512))});
app.get('/brand/icon-maskable-512.png',async(req,res)=>{res.set('Cache-Control','no-store, max-age=0');res.type('image/png').send(isDinnieBrand()?await dinnieStaticIconPng(512):await brandedIconPng(512,{maskable:true}))});
app.get('/manifest.webmanifest',(req,res)=>{
  res.set('Cache-Control','no-store, max-age=0');
  const b=brandPublic(),dinnie=isDinnieBrand();
  const icons=dinnie?[
    {src:'/apple-touch-icon-dinnie-v2.png',sizes:'180x180',type:'image/png',purpose:'any'},
    {src:'/apple-touch-icon-dinnie-v2.png',sizes:'180x180',type:'image/png',purpose:'maskable'}
  ]:[
    {src:b.icon_192_url,sizes:'192x192',type:'image/png',purpose:'any'},
    {src:b.icon_512_url,sizes:'512x512',type:'image/png',purpose:'any'},
    {src:b.maskable_icon_url,sizes:'512x512',type:'image/png',purpose:'maskable'}
  ];
  res.type('application/manifest+json').send(JSON.stringify({
    name:CONFIG.identity.show_name||CONFIG.identity.publisher_name,
    short_name:CONFIG.identity.show_name||CONFIG.identity.publisher_name,
    start_url:dinnie?'/?pwa=dinnie-v2':'/',scope:'/',display:'standalone',
    background_color:dinnie?'#123d28':b.theme.background,
    theme_color:dinnie?'#123d28':b.theme.primary,icons
  }))
});

app.use((req,res,next)=>{
 if(['/setup','/setup/activate','/login','/auth/public-info','/auth/pin','/auth/passkeys/options','/auth/passkeys/verify','/oauth2callback','/facebook/oauth/callback','/factory/health','/brand/logo.svg','/brand/logo.png','/apple-touch-icon.png','/dinnie-touch-icon.png','/apple-touch-icon-dinnie-v2.png','/favicon.ico','/brand/icon-192.png','/brand/icon-512.png','/brand/icon-maskable-512.png','/manifest.webmanifest'].includes(req.path))return next();
 if(req.path.startsWith('/public/'))return next();
 return secure(req,res,next);
});

function ytSecrets(){const s=secrets();return s.youtube||{}}
function saveYtSecrets(v){const s=secrets();s.youtube={...(s.youtube||{}),...v};saveSecrets(s)}
function loadToken(){try{return unseal(readJson(YT_TOKEN_PATH,null))}catch{return null}}
function saveToken(v){writeJson(YT_TOKEN_PATH,seal(v))}
function oauthClient(){const y=ytSecrets();if(!y.client_id||!y.client_secret||!y.redirect_uri)throw new Error('YouTube OAuth app is not configured.');const c=new google.auth.OAuth2(y.client_id,y.client_secret,y.redirect_uri),t=loadToken();if(t)c.setCredentials(t);c.on('tokens',x=>{const old=loadToken()||{};saveToken({...old,...x})});return c}
function authedClient(){const c=oauthClient();if(!loadToken())throw new Error('YouTube is not connected.');return c}
function youtubeApi(){return google.youtube({version:'v3',auth:authedClient()})}

function fbSecrets(){const s=secrets();return s.facebook||{}}
function saveFbSecrets(v){const s=secrets();s.facebook={...(s.facebook||{}),...v};saveSecrets(s)}
function metaGraphVersion(){return String(process.env.META_GRAPH_VERSION||'v26.0').replace(/^\/+|\/+$/g,'')}
function selectedPublicationProvider(){
  const v=String(CONFIG.publication?.selected_provider||'').toLowerCase();
  return ['youtube','facebook'].includes(v)?v:null;
}
function facebookConnection(){
  const f=fbSecrets();
  return{page_id:f.page_id||null,page_name:f.page_name||null,page_access_token:f.page_access_token||null,user_token:f.user_token||null,token_expires_at:f.token_expires_at||null};
}
function facebookConnected(){const f=facebookConnection();return Boolean(f.page_id&&f.page_access_token)}
async function validateFacebookConnection(){
  const f=facebookConnection();
  if(!f.page_id||!f.page_access_token)return{ok:false,reason:'missing'};
  try{
    const j=await metaGraph(String(f.page_id),{params:{fields:'id,name'},token:String(f.page_access_token)});
    return{ok:true,page_id:String(j.id||f.page_id),page_name:String(j.name||f.page_name||'')};
  }catch(e){
    return{ok:false,reason:String(e?.message||e)};
  }
}
function publicationConnected(){
  const p=selectedPublicationProvider();
  if(p==='facebook')return facebookConnected();
  if(p==='youtube')return Boolean(loadToken());
  return false;
}
function defaultProviderConfig(type){
  if(type==='facebook'){
    const dinnie=/dinnie|dinosaur/i.test(String(CONFIG.identity?.show_name||''));
    return{type:'facebook',hashtags:dinnie?['#DinnieTheDinosaur','#KidsAnimation','#Reels','#Viral']:['#Reels'],upload_lead_minutes:0,contains_synthetic_media:true};
  }
  return{type:'youtube',privacy_before_publish:'private',release_mode:'private_then_public_at_posting_time',use_publish_at:false,metadata_final_before_upload:true,preserve_private_lead_window:true,contains_synthetic_media:true,hashtags:[]};
}
function persistRuntimeConfig(){
  fs.writeFileSync(path.join(DATA_DIR,'publisher-config.json'),JSON.stringify(CONFIG,null,2),{mode:0o600});
}
function setPublicationProvider(type,{postingTime=null}={}){
  if(!['youtube','facebook'].includes(type))throw new Error('Choose YouTube or Facebook.');
  CONFIG.publication=CONFIG.publication||{};
  CONFIG.publication.allowed_providers=['youtube','facebook'];
  CONFIG.publication.ai_disclosure_required=true;
  CONFIG.publication.selected_provider=type;
  const existing=(CONFIG.publication.providers||[]).find(x=>x.type===type);
  CONFIG.publication.providers=[{...(existing||defaultProviderConfig(type)),contains_synthetic_media:true}];
  CONFIG.schedule=CONFIG.schedule||{};
  if(postingTime){
    const t=String(postingTime).trim();if(!/^\d{2}:\d{2}$/.test(t))throw new Error('Posting time must use HH:MM.');
    CONFIG.schedule.posting_times=[t];
  }
  CONFIG.schedule.timezone=CONFIG.schedule.timezone||CONFIG.identity?.timezone||'UTC';
  CONFIG.schedule.upload_lead_minutes=type==='facebook'?0:Number(CONFIG.schedule.upload_lead_minutes??390);
  persistRuntimeConfig();
  return type;
}
async function metaGraph(pathname,{method='GET',params={},token=null}={}){
  const u=new URL('https://graph.facebook.com/'+metaGraphVersion()+'/'+String(pathname).replace(/^\/+/,'')); 
  for(const [k,v] of Object.entries(params||{}))if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));
  if(token)u.searchParams.set('access_token',token);
  const r=await fetch(u,{method,signal:AbortSignal.timeout(90000)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||j?.error){const e=j?.error||{};throw new Error('Facebook Graph: '+String(e.message||('HTTP '+r.status)))}
  return j;
}

async function discoverFacebookPages(userToken){
  const byId=new Map();
  const absorb=async(rows=[])=>{
    for(const raw of rows||[]){
      if(!raw?.id)continue;
      let p={id:String(raw.id),name:String(raw.name||raw.id),access_token:raw.access_token?String(raw.access_token):null,tasks:Array.isArray(raw.tasks)?raw.tasks:[]};
      if(!p.access_token){
        try{
          const full=await metaGraph(p.id,{params:{fields:'id,name,access_token,tasks'},token:userToken});
          p={...p,...full,id:String(full.id||p.id),name:String(full.name||p.name),access_token:full.access_token?String(full.access_token):p.access_token,tasks:Array.isArray(full.tasks)?full.tasks:p.tasks};
        }catch{}
      }
      const prev=byId.get(p.id);
      byId.set(p.id,{...(prev||{}),...p,access_token:p.access_token||prev?.access_token||null});
    }
  };
  const direct=await metaGraph('me/accounts',{params:{fields:'id,name,access_token,tasks',limit:100},token:userToken}).catch(()=>({data:[]}));
  await absorb(direct.data||[]);
  const businesses=await metaGraph('me/businesses',{params:{fields:'id,name',limit:100},token:userToken}).catch(()=>({data:[]}));
  for(const b of businesses.data||[]){
    for(const edge of ['owned_pages','client_pages']){
      const r=await metaGraph(String(b.id)+'/'+edge,{params:{fields:'id,name,tasks',limit:100},token:userToken}).catch(()=>({data:[]}));
      await absorb(r.data||[]);
    }
  }
  return [...byId.values()].filter(p=>p.access_token);
}
async function refreshFacebookPageConnection(){
  const f=fbSecrets();
  const userToken=String(f.user_token||'').trim();
  const pageId=String(f.page_id||'').trim();
  const pageName=String(f.page_name||'').trim();
  if(!userToken||!pageId)throw new Error('FACEBOOK_AUTH_REQUIRED');
  const pages=await discoverFacebookPages(userToken);
  const same=pages.find(p=>String(p.id)===pageId)
    ||pages.find(p=>pageName&&String(p.name||'').trim().toLowerCase()===pageName.toLowerCase());
  if(!same?.access_token)throw new Error('FACEBOOK_RECONNECT_REQUIRED: the configured Page is no longer available to the saved Facebook user token.');
  const verified=await metaGraph(String(same.id),{params:{fields:'id,name'},token:String(same.access_token)});
  saveFbSecrets({
    page_options:pages,
    page_id:String(verified.id||same.id),
    page_name:String(verified.name||same.name||same.id),
    page_access_token:String(same.access_token)
  });
  console.log('[FACEBOOK AUTH REPAIR]',JSON.stringify({page_id:String(verified.id||same.id),page_name:String(verified.name||same.name||same.id)}));
  return facebookConnection();
}

const youtubePublication=installPublication({app,db,config:CONFIG,youtubeApi,authedClient,loadToken,dataDir:DIR,isEnabled:()=>selectedPublicationProvider()==='youtube'});
const facebookPublication=installFacebookPublication({db,config:CONFIG,dataDir:DIR,loadFacebookConnection:facebookConnection,refreshFacebookConnection:refreshFacebookPageConnection,isEnabled:()=>selectedPublicationProvider()==='facebook'});
const publication={
  enqueue(row){
    const p=selectedPublicationProvider();
    if(p==='facebook')return facebookPublication.enqueue(row);
    if(p==='youtube')return youtubePublication.enqueue(row);
    throw new Error('Choose and connect a publication platform before approving a video.');
  },
  async purgeRejected(row){
    const a=await youtubePublication.purgeRejected(row).catch(()=>({purged:0}));
    const b=await facebookPublication.purgeRejected(row).catch(()=>({purged:0}));
    return{youtube:a,facebook:b};
  },
  purgePrivateVideosByTitle:titles=>youtubePublication.purgePrivateVideosByTitle(titles),
  tick:()=>selectedPublicationProvider()==='facebook'?facebookPublication.tick():youtubePublication.tick(),
  status:()=>selectedPublicationProvider()==='facebook'?facebookPublication.status():youtubePublication.status()
};
function diagnosticConfiguredEpisodes(){
  const raw=String(process.env.PUBLISHER_DIAG_EPISODES||'').trim();if(!raw)return;
  for(const ep of raw.split(',').map(x=>Number(x.trim())).filter(Number.isFinite)){
    const row=db.prepare('SELECT * FROM factory_items WHERE episode=? ORDER BY season DESC LIMIT 1').get(ep);
    if(!row)continue;
    const pub=db.prepare('SELECT id,itemId,episode,title,status,filePath,fileSize,videoId,scheduledAt,uploadAt,error FROM publication_items WHERE itemId=? LIMIT 1').get(row.id)||null;
    let flow={};try{flow=JSON.parse(String(row.flowResult||'{}'))||{}}catch{}
    let lc={};try{lc=JSON.parse(String(metaGet('flow:generationLifecycle:'+row.id,'{}')))||{}}catch{}
    console.log('[EPISODE RECOVERY DIAGNOSTIC]',JSON.stringify({
      episode:ep,factoryId:row.id,status:row.status,hook:row.hook,title:row.title,
      promptHash:row.promptHash,creativePackageId:row.creativePackageId,reviewContentHash:row.reviewContentHash,
      hasVideoPath:Boolean(row.videoPath&&fs.existsSync(row.videoPath)),hasRemoteUrl:Boolean(row.remoteUrl),
      flow:{generation_id:flow.generation_id||null,generation_started_at:flow.generation_started_at||null,retrieval_evidence:flow.retrieval_evidence||null,content_hash:flow.content_hash||null,size:flow.size||null},
      lifecycle:{state:lc.state||null,generation_id:lc.generation_id||null,generation_started_at:lc.generation_started_at||null,submit_boundary_at:lc.submit_boundary_at||null,baseline_count:Array.isArray(lc.baseline)?lc.baseline.length:0,baseline_inventory:lc.baseline_inventory||null},
      publication:pub?{id:pub.id,status:pub.status,videoId:pub.videoId,title:pub.title,filePath:Boolean(pub.filePath),fileSize:pub.fileSize,scheduledAt:pub.scheduledAt,uploadAt:pub.uploadAt,error:pub.error}:null
    }));
  }
}
setTimeout(()=>{try{diagnosticConfiguredEpisodes()}catch(e){console.error('[EPISODE RECOVERY DIAGNOSTIC ERROR]',String(e?.message||e))}},2500).unref?.();
async function purgeConfiguredRejectedPrivateVideos(){
  const raw=String(process.env.PUBLISHER_PURGE_PRIVATE_TITLES||'').trim();
  if(!raw)return;
  const key='operator:purge-private-titles:'+createHash('sha256').update(raw).digest('hex').slice(0,20);
  if(metaGet(key,'')==='done')return;
  const titles=raw.split('|').map(x=>x.trim()).filter(Boolean);
  const result=await publication.purgePrivateVideosByTitle(titles);
  metaSet(key,'done');
  console.log('[REJECTED PRIVATE VIDEO PURGE]',JSON.stringify(result));
}
setTimeout(()=>void purgeConfiguredRejectedPrivateVideos().catch(e=>console.error('[REJECTED PRIVATE VIDEO PURGE ERROR]',String(e?.message||e))),4500).unref?.();


function integrationShell({title,body,brand=brandPublic()}){
  const t=brand.theme||{},esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="${esc(t.primary||'#123d28')}"><title>${esc(title)}</title>
<style>
:root{--p:${esc(t.primary||'#123d28')};--s:${esc(t.secondary||'#5f8c61')};--a:${esc(t.accent||'#8bbd70')};--bg:${esc(t.background||'#071a12')};--surface:${esc(t.surface||'#10261a')};--text:${esc(t.text||'#f3f8f0')};--muted:color-mix(in srgb,var(--text) 68%,transparent);--line:color-mix(in srgb,var(--text) 16%,transparent)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% 0%,color-mix(in srgb,var(--s) 26%,transparent),transparent 34%),linear-gradient(145deg,var(--p),var(--bg));color:var(--text);font-family:Arial,sans-serif;padding:calc(18px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom));min-height:100vh}.wrap{max-width:900px;margin:auto}.top{display:flex;align-items:center;gap:13px;margin-bottom:20px}.top img{width:70px;height:70px;object-fit:contain;border-radius:18px;background:color-mix(in srgb,var(--surface) 84%,transparent)}.top strong{font-size:26px}.eyebrow{font-size:11px;letter-spacing:.18em;color:var(--a);font-weight:800}.card{background:color-mix(in srgb,var(--surface) 88%,transparent);border:1px solid var(--line);border-radius:24px;padding:20px;margin:14px 0;box-shadow:0 18px 54px rgba(0,0,0,.18);backdrop-filter:blur(16px)}h1{font-size:clamp(38px,7vw,62px);line-height:.98;margin:7px 0 12px}h2{margin:0 0 8px;font-size:26px}.muted{color:var(--muted);line-height:1.55}.btn{min-height:48px;padding:0 16px;border-radius:14px;border:1px solid var(--a);background:transparent;color:var(--text);font-weight:800;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}.btn.primary{background:var(--a);color:#102014;border-color:var(--a)}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:14px}input,select{width:100%;min-height:50px;border:1px solid var(--line);background:color-mix(in srgb,var(--surface) 92%,#000);color:var(--text);border-radius:12px;padding:0 12px;font:inherit}label{display:grid;gap:7px;font-size:12px;font-weight:800;margin:10px 0}.radio{display:flex;gap:10px;align-items:center;border:1px solid var(--line);padding:14px;border-radius:14px;margin:8px 0}.radio input{width:auto;min-height:0}.ok{color:#b8efad}.warn{color:#f2cf85}.code{word-break:break-all;background:#08120d;border:1px solid var(--line);padding:12px;border-radius:12px;font:12px ui-monospace,monospace}.pages{display:grid;gap:8px;margin-top:12px}.page{display:flex;gap:10px;align-items:center;border:1px solid var(--line);padding:12px;border-radius:14px}.page input{width:auto;min-height:0}.back{color:var(--text);text-decoration:none;font-weight:800}.small{font-size:12px}.guide{display:grid;gap:12px}.guide-step{display:grid;grid-template-columns:42px minmax(0,1fr);gap:13px;align-items:start;padding:14px 0;border-top:1px solid var(--line)}.guide-step:first-child{border-top:0;padding-top:0}.guide-num{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--a) 22%,transparent);border:1px solid color-mix(in srgb,var(--a) 45%,transparent);font-weight:900}.guide-step h3{margin:2px 0 6px;font-size:18px}.guide-step p{margin:0;color:var(--muted);line-height:1.5}.callout{padding:14px;border-radius:16px;border:1px solid color-mix(in srgb,var(--a) 38%,transparent);background:color-mix(in srgb,var(--a) 9%,var(--surface));margin:12px 0}.callout b{color:var(--text)}.copyrow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:stretch}.copyrow .code{margin:0}.copybtn{min-height:44px}.perm{font-family:ui-monospace,monospace;font-size:12px;background:#08120d;border:1px solid var(--line);padding:7px 9px;border-radius:9px;display:inline-block;margin:3px 4px 3px 0}.checklist{display:grid;gap:8px;margin:12px 0}.checkitem{display:flex;gap:9px;align-items:flex-start}.checkdot{width:18px;height:18px;border-radius:50%;border:1px solid var(--a);display:grid;place-items:center;font-size:11px;margin-top:1px;flex:0 0 auto}.statusbar{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:16px 0}.statuspill{border:1px solid var(--line);border-radius:12px;padding:9px 8px;text-align:center;font-size:11px;font-weight:800}.statuspill.done{background:color-mix(in srgb,#63c174 16%,var(--surface));border-color:#63c174}.statuspill.current{background:color-mix(in srgb,var(--a) 14%,var(--surface));border-color:var(--a)}details{border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-top:9px;background:color-mix(in srgb,var(--surface) 92%,transparent)}summary{cursor:pointer;font-weight:800}.note{font-size:13px;color:var(--muted);line-height:1.55}.external{display:inline-flex;align-items:center;gap:7px}@media(max-width:620px){.statusbar{grid-template-columns:1fr 1fr}.copyrow{grid-template-columns:1fr}.guide-step{grid-template-columns:34px minmax(0,1fr)}.guide-num{width:30px;height:30px}}</style></head><body><main class="wrap"><a class="back" href="/">← VOLVER AL PUBLISHER</a><div class="top">${brand.logo_url?'<img src="'+esc(brand.logo_url)+'" alt="">':''}<div><div class="eyebrow">PUBLISHER CONNECTIONS</div><strong>${esc(CONFIG.identity.show_name||'Publisher')}</strong></div></div>${body}</main></body></html>`;
}

app.get('/integrations/platform',secure,(req,res)=>{
  const selected=selectedPublicationProvider(),time=String(CONFIG.schedule?.posting_times?.[0]||'19:00'),tz=String(CONFIG.schedule?.timezone||CONFIG.identity?.timezone||'UTC');
  const body=`<div class="eyebrow">PUBLICATION PLATFORM</div><h1>Elegí dónde publicar.</h1><p class="muted">Google Flow es siempre el generador. La publicación puede ir a YouTube o Facebook. Podés cambiar la plataforma antes de aprobar contenido.</p>
  <form method="post" action="/integrations/platform" class="card">
    <label class="radio"><input type="radio" name="provider" value="youtube" ${selected==='youtube'?'checked':''} required><span><b>YouTube</b><br><span class="muted small">Subida privada + publicación automática a la hora configurada.</span></span></label>
    <label class="radio"><input type="radio" name="provider" value="facebook" ${selected==='facebook'?'checked':''} required><span><b>Facebook</b><br><span class="muted small">Publicación automática de Reels en una Página administrada por vos.</span></span></label>
    <label>Hora diaria de publicación<input type="time" name="posting_time" value="${time}" required></label>
    <div class="muted small">Zona horaria: ${tz}</div>
    <div class="actions"><button class="btn primary" type="submit">SAVE + CONNECT</button></div>
  </form>`;
  res.send(integrationShell({title:'Publication platform',body}));
});
app.post('/integrations/platform',secure,(req,res)=>{
  try{
    const provider=String(req.body.provider||'').trim().toLowerCase(),postingTime=String(req.body.posting_time||'').trim();
    setPublicationProvider(provider,{postingTime});
    return res.redirect(provider==='facebook'?'/integrations/facebook':'/integrations/youtube');
  }catch(e){res.status(400).send(String(e?.message||e))}
});

app.get('/integrations/facebook',secure,(req,res)=>{
  const f=fbSecrets(),connected=facebookConnected(),callback=origin(req)+'/facebook/oauth/callback',pages=Array.isArray(f.page_options)?f.page_options:[],appConfigured=Boolean(f.app_id&&f.app_secret);
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const step=connected?4:pages.length?3:appConfigured?2:1;
  let body=`
  <div class="eyebrow">FACEBOOK REELS · PASO A PASO</div>
  <h1>Conectá tu Página sin adivinar nada.</h1>
  <p class="muted">No necesitás descargar ninguna “app de Meta” ni buscar una API key. Todo se hace desde <b>Meta for Developers</b> en el navegador. Los dos datos que este Publisher necesita son <b>App ID</b> y <b>App Secret</b>; después Facebook Login devuelve las <b>Páginas</b> que administra tu cuenta y un Page Access Token para la Página que elijas.</p>
  <div class="callout"><b>Para Dinnie:</b> iniciá sesión con la cuenta personal <b>Dimi Dimi</b> solamente para autorizar el acceso. <b>No vamos a publicar en el perfil personal.</b> En el paso 3 seleccioná la Página <b>Dimi de Dinosaur</b>. El Publisher publica exclusivamente en la Página seleccionada.</div>
  <div class="callout"><b>Importante:</b> iniciá sesión en Meta con la misma cuenta de Facebook que tiene acceso de administración a la Página que querés conectar. Para usar tu propia Página mientras vos sos administradora/desarrolladora de la app, podés hacer la conexión en modo desarrollo; si en el futuro permitís que personas ajenas conecten sus Páginas, Meta puede exigir Advanced Access/App Review para esos permisos.</div>
  <div class="statusbar">
    <div class="statuspill ${step>=1?'current':''}">1 · META APP</div>
    <div class="statuspill ${step>=2?'current':''}">2 · LOGIN</div>
    <div class="statuspill ${step>=3?'current':''}">3 · PÁGINA</div>
    <div class="statuspill ${connected?'done':''}">4 · LISTO</div>
  </div>

  <div class="card">
    <h2>Antes de empezar</h2>
    <div class="checklist">
      <div class="checkitem"><span class="checkdot">✓</span><span>Usá Safari o Chrome. <b>No hay ninguna aplicación para descargar.</b></span></div>
      <div class="checkitem"><span class="checkdot">✓</span><span>Tené abierta la cuenta de Facebook que administra tu Página.</span></div>
      <div class="checkitem"><span class="checkdot">✓</span><span>La Página debe permitirte crear contenido/publicaciones.</span></div>
      <div class="checkitem"><span class="checkdot">✓</span><span>Dejá esta pestaña del Publisher abierta; vas a volver para pegar dos datos.</span></div>
    </div>
    <div class="actions"><a class="btn primary external" target="_blank" rel="noopener" href="https://developers.facebook.com/apps/">ABRIR META FOR DEVELOPERS ↗</a></div>
  </div>

  <div class="card">
    <h2>1 · Crear la Meta App</h2>
    <div class="guide">
      <div class="guide-step"><div class="guide-num">1</div><div><h3>Entrá a Meta for Developers</h3><p>Tocá <b>My Apps / Mis apps</b> y después <b>Create App / Crear app</b>. Si es la primera vez, Meta puede pedirte activar tu cuenta de desarrollador y verificar datos básicos.</p></div></div>
      <div class="guide-step"><div class="guide-num">2</div><div><h3>Elegí el caso de uso de administración de Páginas</h3><p>Si Meta te muestra <b>“Manage everything on your Page / Administrar todo en tu Página”</b>, <b>“Create and manage posts / Crear y administrar publicaciones”</b> o una opción equivalente para gestionar contenido de una Página, elegí <b>esa</b>. Ese es el caso de uso principal de este Publisher. Facebook Login se usa después como mecanismo de autorización para que vos concedas acceso a tu Página; no es el objetivo principal de la app.</p></div></div>
      <div class="guide-step"><div class="guide-num">3</div><div><h3>Poné un nombre reconocible</h3><p>Por ejemplo <b>Dinnie Publisher</b>. Completá los datos mínimos que Meta te pida y creá la app.</p></div></div>
      <div class="guide-step"><div class="guide-num">4</div><div><h3>Copiá App ID y App Secret</h3><p>Dentro de la app, abrí <b>App settings → Basic</b>. Copiá <b>App ID</b>. En <b>App Secret</b>, tocá Show y copiá el valor. Eso reemplaza lo que mucha gente llama informalmente “API key”.</p></div></div>
    </div>
    <form method="post" action="/integrations/facebook/app">
      <label>App ID<input name="app_id" inputmode="numeric" autocomplete="off" value="${f.app_id?esc(f.app_id):''}" placeholder="Ej. 123456789012345" required></label>
      <label>App Secret<input type="password" name="app_secret" autocomplete="off" placeholder="${f.app_secret?'Ya guardado · dejalo vacío para conservarlo':'Pegá el App Secret'}" ${f.app_secret?'':'required'}></label>
      <div class="actions"><button class="btn primary" type="submit">${appConfigured?'GUARDAR / ACTUALIZAR':'GUARDAR META APP'}</button></div>
    </form>
  </div>

  <div class="card">
    <h2>2 · Activar Facebook Login y permisos</h2>
    <div class="guide">
      <div class="guide-step"><div class="guide-num">1</div><div><h3>Usá el caso de uso de Pages como base</h3><p>El caso de uso principal debe ser el de <b>administrar la Página / crear y gestionar publicaciones</b>. Dentro de ese flujo, Meta puede pedirte configurar <b>Facebook Login</b> para obtener el consentimiento del administrador y emitir los tokens. Si Facebook Login ya aparece integrado en el caso de uso, no agregues otro caso de uso duplicado.</p></div></div>
      <div class="guide-step"><div class="guide-num">2</div><div><h3>Configurá esta URL de retorno</h3><p>Entrá a la configuración de Facebook Login y buscá <b>Valid OAuth Redirect URIs</b>. Pegá exactamente esta dirección, guardá los cambios y dejá habilitado Web OAuth Login.</p>
        <div class="copyrow"><div class="code" id="fbCallback">${esc(callback)}</div><button class="btn copybtn" type="button" onclick="navigator.clipboard.writeText(document.getElementById('fbCallback').textContent).then(()=>{this.textContent='COPIADO ✓';setTimeout(()=>this.textContent='COPIAR',1400)})">COPIAR</button></div>
      </div></div>
      <div class="guide-step"><div class="guide-num">3</div><div><h3>Comprobá los permisos de Página</h3><p>En <b>App Review → Permissions and Features</b> o dentro de la configuración del caso de uso, buscá estos tres permisos:</p>
        <div><span class="perm">pages_show_list</span><span class="perm">pages_read_engagement</span><span class="perm">pages_manage_posts</span></div>
        <p class="note"><b>pages_show_list</b> permite listar las Páginas que administrás; <b>pages_read_engagement</b> es dependencia para la información de la Página; <b>pages_manage_posts</b> permite crear/publicar videos y Reels. No desactives ninguno cuando Facebook te pida autorización.</p>
      </div></div>
      <div class="guide-step"><div class="guide-num">4</div><div><h3>Volvé acá y conectá Facebook</h3><p>Cuando App ID, App Secret y Redirect URI estén listos, tocá el botón de abajo. Facebook te va a preguntar con qué cuenta continuar y qué permisos conceder.</p></div></div>
    </div>
    <div class="actions">${appConfigured?'<a class="btn primary" href="/integrations/facebook/login">LOGIN WITH FACEBOOK</a>':'<span class="warn"><b>Primero guardá App ID + App Secret arriba.</b></span>'}</div>
  </div>

  <div class="card">
    <h2>3 · Elegir la Página</h2>
    ${pages.length
      ?'<p class="muted">Facebook ya devolvió las Páginas administradas por tu cuenta personal. <b>No elijas el perfil personal Dimi Dimi.</b> Para Dinnie, seleccioná la Página <b>Dimi de Dinosaur</b>.</p><form method="post" action="/integrations/facebook/page"><div class="pages">'+pages.map(p=>'<label class="page"><input type="radio" name="page_id" value="'+esc(p.id)+'" '+(String(f.page_id||'')===String(p.id)?'checked':'')+' required><span><b>'+esc(p.name||p.id)+'</b>'+(String(p.name||'').toLowerCase()==='dimi de dinosaur'?'<br><span class="ok small"><b>PÁGINA ESPERADA PARA DINNIE ✓</b></span>':'')+'<br><span class="muted small">Page ID '+esc(p.id)+'</span></span></label>').join('')+'</div><div class="actions"><button class="btn primary" type="submit">USE THIS PAGE</button></div></form>'
      :'<p class="muted">Todavía no hay Páginas para elegir. Después de <b>LOGIN WITH FACEBOOK</b>, esta sección se completa sola.</p>'}
  </div>

  <div class="card">
    <h2>4 · Verificación final</h2>
    ${connected
      ?'<p class="ok"><b>CONNECTED ✓</b> · '+esc(f.page_name||f.page_id)+'</p><div class="checklist"><div class="checkitem"><span class="checkdot">✓</span><span>Page Access Token guardado.</span></div><div class="checkitem"><span class="checkdot">✓</span><span>FacebookReelsProvider listo para el scheduler.</span></div><div class="checkitem"><span class="checkdot">✓</span><span>Los videos rechazados no se envían a Facebook.</span></div><div class="checkitem"><span class="checkdot">✓</span><span>Los videos aprobados quedan en Stock y se publican a la hora configurada.</span></div></div><div class="actions"><a class="btn primary" href="/">VOLVER AL PUBLISHER</a><form method="post" action="/integrations/facebook/disconnect"><button class="btn" type="submit">DISCONNECT FACEBOOK</button></form></div>'
      :'<p class="warn"><b>FACEBOOK TODAVÍA NO ESTÁ CONECTADO.</b></p><p class="muted">Completá los pasos de arriba en orden. El Publisher no empieza a publicar hasta que la Página quede confirmada.</p>'}
  </div>

  <div class="card">
    <h2>Si algo no aparece como en la guía</h2>
    <details><summary>No encuentro “Facebook Login”</summary><p class="note">Meta cambia los nombres de los menús con frecuencia. Para este Publisher priorizá una opción de <b>administrar todo en tu Página</b>, <b>crear/administrar publicaciones</b> o equivalente. Facebook Login es la capa de autorización que se configura dentro o junto a ese caso de uso, no el caso de uso principal cuando Meta te ofrece uno específico de Pages.</p></details>
    <details><summary>Facebook Login vuelve pero no aparece mi Página</summary><p class="note">Comprobá que hayas iniciado sesión con la cuenta que administra esa Página, que tengas permiso para crear contenido y que hayas concedido <b>pages_show_list</b>, <b>pages_read_engagement</b> y <b>pages_manage_posts</b>. Si modificaste permisos, repetí LOGIN WITH FACEBOOK para volver a consentirlos.</p></details>
    <details><summary>Me dice que la Redirect URI no coincide</summary><p class="note">Copiá la URL de retorno de esta misma pantalla, sin agregar ni quitar barras, espacios o http/https. Debe coincidir exactamente con <b>Valid OAuth Redirect URIs</b> en Meta.</p></details>
    <details><summary>¿Tengo que mandar la app a revisión?</summary><p class="note">Para pruebas/uso propio, la cuenta que figura como administradora o desarrolladora de la Meta App puede usar la app en modo desarrollo con sus activos permitidos. Si más adelante querés que usuarios que no tienen rol en esa Meta App conecten sus propias Páginas, prepará Advanced Access/App Review para los permisos de Pages.</p></details>
  </div>

  <div class="card"><h2>Qué hace el Publisher después</h2><p class="muted">Cuando apruebes un Reel, el archivo pasa a Stock. A la hora programada, el scheduler inicia la sesión de Reels, sube el MP4, finaliza la publicación como <b>PUBLISHED</b> y verifica el estado remoto. Antes de APPROVE, el video permanece únicamente en el volumen privado del Publisher.</p></div>

  <script>
    document.querySelectorAll('a[target="_blank"]').forEach(a=>a.addEventListener('click',()=>{a.rel='noopener noreferrer'}));
  </script>
  `;
  res.send(integrationShell({title:'Connect Facebook',body}));
});

app.post('/integrations/facebook/app',secure,(req,res)=>{
  try{
    const app_id=String(req.body.app_id||'').trim(),provided=String(req.body.app_secret||'').trim(),old=fbSecrets();
    const app_secret=provided||String(old.app_secret||'');
    if(!app_id||!app_secret)throw new Error('App ID and App Secret are required.');
    setPublicationProvider('facebook');
    saveFbSecrets({app_id,app_secret,redirect_uri:origin(req)+'/facebook/oauth/callback'});
    res.redirect('/integrations/facebook');
  }catch(e){res.status(400).send(String(e?.message||e))}
});
app.get('/integrations/facebook/login',secure,(req,res)=>{
  try{
    const f=fbSecrets();if(!f.app_id||!f.app_secret)throw new Error('Save Meta App credentials first.');
    const state=randomBytes(24).toString('base64url'),redirect=origin(req)+'/facebook/oauth/callback';
    saveFbSecrets({oauth_state:state,oauth_state_exp:Date.now()+15*60*1000,redirect_uri:redirect});
    const u=new URL('https://www.facebook.com/'+metaGraphVersion()+'/dialog/oauth');
    u.searchParams.set('client_id',String(f.app_id));u.searchParams.set('redirect_uri',redirect);u.searchParams.set('state',state);
    u.searchParams.set('scope','pages_show_list,pages_read_engagement,pages_manage_posts,business_management');u.searchParams.set('auth_type','rerequest');u.searchParams.set('return_scopes','true');
    res.redirect(u.toString());
  }catch(e){res.status(400).send(String(e?.message||e))}
});
app.get('/facebook/oauth/callback',async(req,res)=>{
  try{
    const f=fbSecrets(),state=String(req.query.state||''),code=String(req.query.code||'');
    if(!code||!f.oauth_state||!safeEq(state,String(f.oauth_state))||Number(f.oauth_state_exp||0)<Date.now())throw new Error('Facebook OAuth state invalid or expired.');
    const redirect=String(f.redirect_uri||origin(req)+'/facebook/oauth/callback');
    const short=await metaGraph('oauth/access_token',{params:{client_id:f.app_id,client_secret:f.app_secret,redirect_uri:redirect,code}});
    if(!short.access_token)throw new Error('Facebook did not return an access token.');
    let userToken=String(short.access_token),expires=Number(short.expires_in||0);
    try{
      const long=await metaGraph('oauth/access_token',{params:{grant_type:'fb_exchange_token',client_id:f.app_id,client_secret:f.app_secret,fb_exchange_token:userToken}});
      if(long.access_token){userToken=String(long.access_token);expires=Number(long.expires_in||expires||0)}
    }catch{}
    const pages=await discoverFacebookPages(userToken);
    if(!pages.length)throw new Error('No managed Facebook Pages were returned. Make sure pages_show_list and business_management were granted, then reconnect Facebook.');
    const oldPageId=String(f.page_id||''),oldPageName=String(f.page_name||'');
    const same=pages.find(p=>oldPageId&&String(p.id)===oldPageId)
      ||pages.find(p=>oldPageName&&String(p.name||'').trim().toLowerCase()===oldPageName.trim().toLowerCase());
    saveFbSecrets({
      user_token:userToken,token_expires_at:expires?Date.now()+expires*1000:null,
      page_options:pages,oauth_state:null,oauth_state_exp:0,
      ...(same?.access_token?{page_id:String(same.id),page_name:String(same.name||same.id),page_access_token:String(same.access_token)}:{})
    });
    setPublicationProvider('facebook');
    if(same?.access_token){
      facebookPublication.resumeAuthWait?.();
      void facebookPublication.tick().catch(()=>{});
      return res.redirect('/?facebook=reconnected');
    }
    res.redirect('/integrations/facebook');
  }catch(e){res.status(400).send('Facebook OAuth failed: '+String(e?.message||e))}
});
app.post('/integrations/facebook/page',secure,async(req,res)=>{
  try{
    const f=fbSecrets(),id=String(req.body.page_id||''),pages=Array.isArray(f.page_options)?f.page_options:[],page=pages.find(p=>String(p.id)===id);
    if(!page)throw new Error('Choose one of the Pages returned by Facebook Login.');
    const verified=await metaGraph(page.id,{params:{fields:'id,name'},token:page.access_token});
    saveFbSecrets({page_id:String(verified.id||page.id),page_name:String(verified.name||page.name||page.id),page_access_token:String(page.access_token)});
    setPublicationProvider('facebook');
    facebookPublication.resumeAuthWait?.();
    void facebookPublication.tick().catch(()=>{});
    res.redirect('/?facebook=reconnected');
  }catch(e){res.status(400).send('Facebook Page connection failed: '+String(e?.message||e))}
});
app.post('/integrations/facebook/disconnect',secure,(req,res)=>{
  const old=fbSecrets();
  saveFbSecrets({app_id:old.app_id||null,app_secret:old.app_secret||null,redirect_uri:old.redirect_uri||null,user_token:null,token_expires_at:null,page_options:[],page_id:null,page_name:null,page_access_token:null,oauth_state:null,oauth_state_exp:0});
  res.redirect('/integrations/facebook');
});

app.get('/integrations/youtube',secure,(req,res)=>{const y=ytSecrets(),redirect=origin(req)+'/oauth2callback',configured=Boolean(y.client_id&&y.client_secret),connected=Boolean(loadToken()),show=String(CONFIG.identity.show_name||CONFIG.identity.publisher_name||'Publisher'),brand=brandPublic(),theme=brand.theme||{},esc=x=>String(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');const chooser=u=>'https://accounts.google.com/AccountChooser?hl=es&continue='+encodeURIComponent(u);const links={api:chooser('https://console.cloud.google.com/apis/library/youtube.googleapis.com'),branding:chooser('https://console.cloud.google.com/auth/branding'),audience:chooser('https://console.cloud.google.com/auth/audience'),data:chooser('https://console.cloud.google.com/auth/scopes'),clients:chooser('https://console.cloud.google.com/auth/clients'),credentials:chooser('https://console.cloud.google.com/apis/credentials')};res.send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f6f2"><title>Conectar YouTube</title>
<style>
:root{--navy:${esc(theme.primary||"#0d3152")};--gold:${esc(theme.accent||theme.secondary||"#b59a64")};--ink:${esc(theme.text||"#1d1d1b")};--muted:#6e6a63;--bg:${esc(theme.background||"#f7f6f2")};--surface:${esc(theme.surface||"#ffffff")};--line:#ded9cf;--ok:#315d35;--okbg:#eef4ed;--soft:${esc(theme.surface||"#fbfaf7")} }
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif;padding:calc(18px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom));-webkit-font-smoothing:antialiased}.wrap{max-width:860px;margin:auto}.brandhead{display:flex;align-items:center;gap:14px;margin:0 0 18px;padding:12px 14px;background:color-mix(in srgb,var(--surface) 92%,transparent);border:1px solid var(--line);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.brandhead img{width:64px;height:64px;object-fit:contain;border-radius:16px;background:var(--surface)}.brandhead strong{font:400 26px Georgia,serif;color:var(--navy)}.brandref{width:100%;height:clamp(170px,28vw,300px);object-fit:cover;border:1px solid var(--line);border-radius:22px;margin:0 0 18px;display:${brand.reference_image_url?"block":"none"};box-shadow:0 18px 54px color-mix(in srgb,var(--navy) 10%,transparent)}.back{display:inline-flex;color:var(--navy);text-decoration:none;font-weight:800;margin-bottom:18px}.eyebrow{font-size:11px;letter-spacing:.22em;color:var(--gold);font-weight:800}
h1{font:400 clamp(44px,8vw,68px)/.94 Georgia,serif;margin:10px 0 14px}.lead{font-size:17px;line-height:1.55;color:#47433d;margin:0 0 24px;max-width:760px}
.hero-note{background:color-mix(in srgb,var(--surface) 94%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid var(--line);padding:15px 16px;margin:18px 0 24px;display:flex;gap:12px;align-items:flex-start}.hero-note .dot{width:12px;height:12px;border-radius:50%;background:var(--gold);margin-top:4px;flex:0 0 auto}.hero-note p{margin:0;color:var(--muted);line-height:1.5}
.progress{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 26px}.pill{padding:11px 12px;border:1px solid var(--line);background:var(--surface);font-size:12px;font-weight:800}.pill.ok{background:var(--okbg);border-color:#a9bea4;color:var(--ok)}
.timeline{display:grid;gap:14px}.step{background:color-mix(in srgb,var(--surface) 94%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid var(--line);padding:20px;position:relative}.step.done{border-color:#a9bea4;background:linear-gradient(180deg,#fff,var(--okbg))}.step-head{display:flex;gap:13px;align-items:flex-start}.num{width:38px;height:38px;border-radius:50%;background:var(--navy);color:#fff;display:grid;place-items:center;font-weight:800;flex:0 0 auto}.step h2{font:400 clamp(27px,4vw,34px)/1.05 Georgia,serif;color:var(--navy);margin:2px 0 8px}.step p{color:var(--muted);line-height:1.52;margin:0}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:15px}.btn{min-height:46px;padding:0 15px;border:1px solid var(--gold);background:var(--surface);color:#725d34;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;font-weight:800;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease}.btn.primary{background:var(--navy);border-color:var(--navy);color:#fff}.btn:active{transform:scale(.97)}.btn:hover{box-shadow:0 7px 18px rgba(13,49,82,.09)}
.choice{margin-top:14px;background:var(--soft);border:1px solid #e6e1d7;padding:14px}.choice-title{font-size:11px;font-weight:900;letter-spacing:.12em;color:var(--gold);text-transform:uppercase;margin-bottom:8px}.choice ul{margin:0;padding-left:19px;color:#4c4943;line-height:1.55}.choice li+li{margin-top:5px}.choice strong{color:var(--ink)}
.screen-cue{margin-top:13px;padding:13px;border-left:4px solid var(--navy);background:#f5f7f9}.screen-cue b{color:var(--navy)}.screen-cue p{margin:3px 0 0;color:#4c5660}
.value{display:grid;grid-template-columns:130px 1fr;gap:8px;align-items:center;margin-top:10px}.value label{font-size:12px;font-weight:800;color:#736b5d}.value code{padding:10px 11px;background:var(--surface);border:1px solid var(--line);font-size:12px;word-break:break-all}.uri{display:flex;gap:8px;margin-top:13px}.uri code{flex:1;border:1px solid var(--line);background:#faf9f6;padding:12px;word-break:break-all;font-size:12px}.copy{white-space:nowrap}
.check{display:flex;align-items:center;gap:9px;margin-top:14px;color:#5b574f;font-size:13px}.check input{width:19px;height:19px;accent-color:var(--ok)}
form{margin-top:14px;display:grid;gap:10px}input[type=text],input[type=password]{width:100%;min-height:50px;padding:0 13px;border:1px solid #cfc8ba;background:var(--surface);font:inherit}.help{font-size:12px;color:var(--muted);margin-top:8px}.final{margin-top:18px;padding:18px;border:1px solid #a9bea4;background:var(--okbg);display:${connected?'block':'none'}}.final strong{color:var(--ok);font-size:18px}.final p{color:#4d6350}
.summary{margin-top:24px;background:var(--surface);border:1px solid var(--line);padding:18px}.summary h3{font:400 25px Georgia,serif;color:var(--navy);margin:0 0 8px}.summary ol{margin:0;padding-left:21px;color:var(--muted);line-height:1.55}
@media(max-width:650px){.progress{grid-template-columns:1fr}.actions .btn{width:100%}.uri{flex-direction:column}.copy{width:100%}.value{grid-template-columns:1fr}.step{padding:17px}.step-head{gap:10px}.num{width:34px;height:34px}}
</style></head><body><main class="wrap">
<a class="back" href="/">← Volver al Publisher</a>
<div class="brandhead">${brand.logo_url?`<img src="${esc(brand.logo_url)}" alt="">`:""}<strong>${esc(show)}</strong></div>
${brand.reference_image_url?`<img class="brandref" src="${esc(brand.reference_image_url)}" alt="">`:""}
<div class="eyebrow">YOUTUBE · ASISTENTE COMPLETO</div>
<h1>Conectemos tu canal,<br>sin adivinar nada.</h1>
<p class="lead">La idea es que puedas seguir esta pantalla aunque nunca hayas usado Google Cloud. Cada tarjeta te dice <b>qué vas a ver</b>, <b>qué opción elegir</b> y <b>qué escribir</b>.</p>
<div class="hero-note"><div class="dot"></div><p><b>Importante:</b> cada botón de Google abre primero el selector de cuentas. Elegí siempre la misma cuenta durante todo el proceso. Si querés otra, tocá <b>Usar otra cuenta</b>.</p></div>

<div class="progress">
  <div class="pill ${configured?'ok':''}">${configured?'✓ OAuth guardado':'1 · Configurar Google'}</div>
  <div class="pill ${configured?'ok':''}">${configured?'✓ Credenciales listas':'2 · Crear credencial'}</div>
  <div class="pill ${connected?'ok':''}">${connected?'✓ Canal conectado':'3 · Autorizar canal'}</div>
</div>

<section class="timeline">

<article class="step"><div class="step-head"><div class="num">1</div><div><h2>Activá YouTube Data API</h2><p>Esto habilita a este Publisher para hablar con YouTube.</p></div></div>
<div class="choice"><div class="choice-title">Qué hacer</div><ul><li>Tocá el botón de abajo.</li><li>Elegí la cuenta de Google que querés usar para este Publisher.</li><li>Si Google te pide elegir un proyecto, elegí uno existente o creá uno nuevo.</li><li>En la pantalla de <b>YouTube Data API v3</b>, tocá <b>Enable / Habilitar</b>.</li></ul></div>
<div class="actions"><a class="btn primary" target="_blank" rel="noopener" href="${links.api}">ELEGIR CUENTA Y ABRIR YOUTUBE DATA API</a></div>
<label class="check"><input type="checkbox" data-guide="api"> Ya la habilité</label></article>

<article class="step"><div class="step-head"><div class="num">2</div><div><h2>Configurá la pantalla de autorización</h2><p>Google llama a esto “Google Auth Platform”. Es donde definís quién puede conectar su cuenta.</p></div></div>
<div class="actions"><a class="btn primary" target="_blank" rel="noopener" href="${links.branding}">ABRIR GOOGLE AUTH PLATFORM</a></div>
<div class="choice"><div class="choice-title">Pantalla 1 · App information</div>
<div class="value"><label>App name</label><code>${esc(show)} Publisher</code></div>
<ul><li>En <b>User support email</b>, elegí tu propio email de Google.</li><li>Tocá <b>Next</b>.</li></ul></div>
<div class="screen-cue"><b>Si ves la pantalla “Audience” como en tu captura:</b><p>Si usás Gmail normal o querés que el Publisher funcione con cuentas fuera de una empresa, marcá <b>External</b> y tocá <b>Next</b>. Elegí <b>Internal</b> solamente si tenés Google Workspace de una organización y el Publisher será usado exclusivamente por usuarios de esa organización.</p></div>
<div class="choice"><div class="choice-title">Pantalla 2 · Audience</div><ul><li>Para una cuenta personal de Google: <strong>External</strong>.</li><li>Tocá <strong>Next</strong>.</li></ul></div>
<div class="choice"><div class="choice-title">Pantalla 3 · Contact information</div><ul><li>Escribí <strong>tu mismo email de Google</strong>.</li><li>Tocá <strong>Next</strong>.</li></ul></div>
<div class="choice"><div class="choice-title">Pantalla 4 · Finish</div><ul><li>Marcá la casilla para aceptar la política de datos de Google API Services.</li><li>Tocá <strong>Continue</strong> y después <strong>Create</strong>.</li></ul></div>
<label class="check"><input type="checkbox" data-guide="auth"> Ya terminé las 4 pantallas</label></article>

<article class="step"><div class="step-head"><div class="num">3</div><div><h2>Agregate como usuario de prueba</h2><p>Como elegiste <b>External</b>, Google normalmente empieza en modo Testing. Tenés que autorizar tu propio email como usuario de prueba.</p></div></div>
<div class="actions"><a class="btn primary" target="_blank" rel="noopener" href="${links.audience}">ABRIR AUDIENCE</a></div>
<div class="choice"><div class="choice-title">Qué tocar</div><ul><li>Buscá la sección <b>Test users</b>.</li><li>Tocá <b>Add users</b>.</li><li>Agregá el <strong>mismo email de Google con el que vas a conectar el canal de YouTube</strong>.</li><li>Guardá.</li></ul></div>
<label class="check"><input type="checkbox" data-guide="test"> Ya agregué mi email</label></article>

<article class="step"><div class="step-head"><div class="num">4</div><div><h2>Creá el cliente OAuth</h2><p>Esta es la credencial que conecta Google con este Publisher.</p></div></div>
<div class="actions"><a class="btn primary" target="_blank" rel="noopener" href="${links.clients}">ABRIR CREDENCIALES OAUTH</a></div>
<div class="choice"><div class="choice-title">Qué elegir</div><ul><li>Tocá <b>Create client</b>.</li><li>En <b>Application type</b>, elegí <strong>Web application</strong>.</li><li>En <b>Name</b>, podés escribir <strong>${esc(show)} Publisher</strong>.</li><li>Dejá <b>Authorized JavaScript origins</b> vacío.</li></ul></div>
<div class="screen-cue"><b>Ahora viene la parte más importante:</b><p>En <b>Authorized redirect URIs</b> tocá <b>Add URI</b> y pegá exactamente la dirección de abajo. Si falta una letra, Google no va a poder volver al Publisher.</p></div>
<div class="uri"><code id="redirect">${esc(redirect)}</code><button class="btn copy" type="button" id="copy">COPIAR URL</button></div>
<div class="choice"><ul><li>Tocá <b>Create</b>.</li><li>Google te va a mostrar un <b>Client ID</b> y un <b>Client Secret</b>. No cierres esa pantalla todavía.</li></ul></div>
<label class="check"><input type="checkbox" data-guide="client"> Ya creé el cliente OAuth</label></article>

<article class="step ${configured?'done':''}"><div class="step-head"><div class="num">5</div><div><h2>Pegá las credenciales acá</h2><p>Volvé a esta pestaña y copiá los dos valores que te mostró Google.</p></div></div>
<form method="post" action="/integrations/youtube">
<input name="client_id" type="text" autocomplete="off" placeholder="Pegá aquí el Client ID" value="${esc(y.client_id||'')}">
<input name="client_secret" type="password" autocomplete="new-password" placeholder="${configured?'Client Secret (solo si querés reemplazarlo)':'Pegá aquí el Client Secret'}">
<button class="btn primary" type="submit">GUARDAR CLIENT ID + SECRET</button>
</form>
<p class="help">${configured?'✓ Ya hay una configuración OAuth guardada.':'Cuando guardes correctamente, este paso aparecerá como completado.'}</p></article>

<article class="step ${connected?'done':''}"><div class="step-head"><div class="num">6</div><div><h2>Conectá el canal de YouTube</h2><p>Esta es la última parte. Google te va a pedir que elijas la cuenta/canal y aceptes los permisos.</p></div></div>
<div class="choice"><div class="choice-title">Qué va a pasar</div><ul><li>Tocá el botón de abajo.</li><li>Elegí la cuenta de Google del canal.</li><li>Si aparece una advertencia de app en testing, seguí con la cuenta que agregaste como <b>Test user</b>.</li><li>Aceptá los permisos solicitados.</li><li>Google vuelve automáticamente a este Publisher.</li></ul></div>
<div class="actions"><a class="btn primary" href="/auth/google" ${configured?'':'style="pointer-events:none;opacity:.45"'}>CONECTAR MI CANAL DE YOUTUBE</a></div></article>

</section>

<div class="final"><strong>✓ YouTube ya está conectado.</strong><p>Listo. Ya podés volver al Publisher; no tenés que repetir esta configuración mientras las credenciales sigan vigentes.</p><a class="btn primary" href="/">VOLVER AL PUBLISHER</a></div>

<div class="summary"><h3>Resumen ultracorto</h3><ol><li>Habilitar YouTube Data API.</li><li>Google Auth Platform → App info → <b>External</b> → tu email → aceptar y crear.</li><li>Audience → agregarte como Test user.</li><li>Crear cliente OAuth tipo <b>Web application</b> y pegar la URI de redirección.</li><li>Pegar Client ID + Secret acá.</li><li>Conectar el canal.</li></ol></div>

</main>
<script>
const copy=document.getElementById('copy');copy.onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('redirect').textContent);copy.textContent='COPIADO ✓';setTimeout(()=>copy.textContent='COPIAR URL',1600)}catch{const r=document.createRange();r.selectNodeContents(document.getElementById('redirect'));getSelection().removeAllRanges();getSelection().addRange(r)}};
for(const box of document.querySelectorAll('[data-guide]')){const key='yt-guide-'+box.dataset.guide;box.checked=localStorage.getItem(key)==='1';const card=box.closest('.step');if(box.checked)card.classList.add('done');box.onchange=()=>{localStorage.setItem(key,box.checked?'1':'0');card.classList.toggle('done',box.checked)}}
</script></body></html>`)});
app.post('/integrations/youtube',secure,(req,res)=>{const client_id=String(req.body.client_id||'').trim(),client_secret=String(req.body.client_secret||'').trim();if(!client_id||!client_secret)return res.status(400).send('Client ID and secret required.');saveYtSecrets({client_id,client_secret,redirect_uri:origin(req)+'/oauth2callback'});res.redirect('/integrations/youtube')});
app.get('/auth/google',secure,(req,res)=>{try{const state=randomBytes(24).toString('base64url'),y=ytSecrets();saveYtSecrets({oauth_state:state,oauth_state_exp:Date.now()+15*60*1000,redirect_uri:origin(req)+'/oauth2callback'});const c=oauthClient(),url=c.generateAuthUrl({access_type:'offline',prompt:'consent',state,scope:['https://www.googleapis.com/auth/youtube','https://www.googleapis.com/auth/youtube.upload']});res.redirect(url)}catch(e){res.status(400).send(e.message)}});
app.get('/oauth2callback',async(req,res)=>{try{const y=ytSecrets();if(!req.query.code||!safeEq(String(req.query.state||''),String(y.oauth_state||''))||Number(y.oauth_state_exp||0)<Date.now())throw new Error('OAuth state invalid or expired.');const c=oauthClient(),{tokens}=await c.getToken(String(req.query.code));saveToken(tokens);saveYtSecrets({oauth_state:null,oauth_state_exp:0});res.redirect('/integrations/youtube')}catch(e){res.status(400).send('YouTube OAuth failed: '+e.message)}});

function stream(req,res,file){const st=fs.statSync(file),range=req.headers.range;res.set('Accept-Ranges','bytes');res.set('Content-Type','video/mp4');res.set('Cache-Control','private,no-store');if(!range){res.set('Content-Length',String(st.size));return fs.createReadStream(file).pipe(res)}const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m)return res.sendStatus(416);const a=m[1]?Number(m[1]):0,b=m[2]?Number(m[2]):st.size-1;if(a<0||b<a||b>=st.size)return res.sendStatus(416);res.status(206).set('Content-Range','bytes '+a+'-'+b+'/'+st.size).set('Content-Length',String(b-a+1));fs.createReadStream(file,{start:a,end:b}).pipe(res)}
function creativePackageDigest(row,title=row?.title,description=row?.description){
 const payload={episode:Number(row?.episode||0),hook:String(row?.hook||''),story:String(row?.story||''),prompt:String(row?.prompt||''),title:String(title||''),description:String(description||'')};
 return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
function ensureCopy(row){
 const providers=CONFIG.publication?.providers||[];
 const provider=providers.find(x=>x.type===CONFIG.publication?.selected_provider)||providers[0]||{};
 let flow={};try{flow=JSON.parse(String(row.flowResult||'{}'))||{}}catch{}
 const override=flow?.publication_override;
 const showName=String(CONFIG.identity?.show_name||'');
 const earth=/earth\s*in\s*10/i.test(showName);
 const dinnie=/dinnie\s*(?:the\s*)?dinosaur|dinnie/i.test(showName);
 let expected=null;
 if(override?.title&&override?.description){
   expected={title:String(override.title),description:String(override.description)};
 }else if(earth||dinnie){
   expected=buildPublicationCopy({
     hook:row.hook,
     story:row.story,
     prompt:row.prompt,
     contextTerms:[],
     hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
     showName,
     maxTitleLength:100
   });
 }
 if(expected){
   let expectedDescription=String(expected.description||'');
   while(Buffer.byteLength(expectedDescription,'utf8')>4800)expectedDescription=expectedDescription.slice(0,-30).trimEnd();
   const expectedTitle=String(expected.title||'').slice(0,100);
   const selfConsistent=String(row?.creativePackageHash||'')===creativePackageDigest(row);
   const semanticallyCorrect=String(row?.title||'')===expectedTitle&&String(row?.description||'')===expectedDescription;
   if(selfConsistent&&semanticallyCorrect)return row;
   const packageHash=creativePackageDigest(row,expectedTitle,expectedDescription),packageId='creative-package-repaired-'+randomBytes(12).toString('hex');
   db.prepare('UPDATE factory_items SET title=?,description=?,creativePackageHash=?,creativePackageId=?,updatedAt=? WHERE id=?')
     .run(expectedTitle,expectedDescription,packageHash,packageId,now(),row.id);
   console.log('[CREATIVE PACKAGE COPY REPAIRED]',JSON.stringify({episode:row.episode,title:expectedTitle,reason:selfConsistent?'semantic-mismatch':'hash-or-copy-mismatch'}));
   return{...row,title:expectedTitle,description:expectedDescription,creativePackageHash:packageHash,creativePackageId:packageId};
 }
 if(String(row?.title||'').trim()&&String(row?.description||'').trim()&&String(row?.creativePackageHash||'')===creativePackageDigest(row)){
   return row;
 }
 let copy;
 if(String(row?.title||'').trim()&&String(row?.description||'').trim()){
   copy={title:String(row.title),description:String(row.description)};
 }else{
   copy=buildPublicationCopy({
     hook:row.hook,
     story:row.story,
     prompt:row.prompt,
     contextTerms:Array.isArray(flow.matched_terms)?flow.matched_terms:[],
     hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
     showName:CONFIG.identity.show_name,
     maxTitleLength:100
   });
 }
 let description=String(copy.description||'');
 while(Buffer.byteLength(description,'utf8')>4800)description=description.slice(0,-30).trimEnd();
 const title=String(copy.title||'').slice(0,100),packageHash=creativePackageDigest(row,title,description),packageId=String(row.creativePackageId||('creative-package-legacy-'+randomBytes(12).toString('hex')));
 db.prepare('UPDATE factory_items SET title=?,description=?,creativePackageHash=?,creativePackageId=?,updatedAt=? WHERE id=?').run(title,description,packageHash,packageId,now(),row.id);
 return{...row,title,description,creativePackageHash:packageHash,creativePackageId:packageId};
}

// REDO feedback is intentionally NOT classified here with keywords/regex.
 // The FreeBrowserProvider interprets the complete human message semantically
 // against the Show Bible and episode context before authorizing one retry.
function card(row){row=ensureCopy(row);const hasReviewMedia=row.status==='review'&&((row.videoPath&&fs.existsSync(row.videoPath))||isReviewStorageUri(row.remoteUrl));return{id:row.id,episode:row.episode,hook:row.hook,story:row.story,title:row.title,description:row.description,status:row.status,videoUrl:hasReviewMedia?'/factory/video/'+encodeURIComponent(row.id):null,archivedOriginal:isReviewStorageUri(row.remoteUrl),updatedAt:row.updatedAt,error:row.error}}
function repairLegacyEarthReviewMetadata(){
 if(!/earth\s*in\s*10/i.test(String(CONFIG.identity?.show_name||'')))return;
 const tags='#EarthIn10 #Nature #Travel #Shorts #ViralShorts';
 const repairs={
  3:{
   title:'DUNE LAGOONS: Turquoise water cuts through endless white dunes. #Shorts #ViralShorts',
   description:'Turquoise lagoons wind between sweeping white dunes in a surreal ten-second aerial landscape.\n\nEARTH IN 10\n\n'+tags
  },
  4:{
   title:'HIDDEN INTERIOR: Sunbeams cut through a weathered structure. #Shorts #ViralShorts',
   description:'Warm shafts of light pierce a shadowy, weathered interior, revealing layered beams, dust and dramatic depth.\n\nEARTH IN 10\n\n'+tags
  },
  5:{
   title:'STORM HIKE: A hooded traveler pauses beneath a gray sky. #Shorts #ViralShorts',
   description:'A hooded traveler pauses in cold, overcast weather and raises a drink against a stark gray outdoor backdrop.\n\nEARTH IN 10\n\n'+tags
  },
  6:{
   title:'QUIET STREET: Morning light falls across an empty urban block. #Shorts #ViralShorts',
   description:'A quiet street, leafy tree and low-rise buildings sit in clear daylight, captured as a calm ten-second urban moment.\n\nEARTH IN 10\n\n'+tags
  }
 };
 const rows=db.prepare("SELECT id,episode,hook,story,prompt,flowResult,status FROM factory_items WHERE episode IN (3,4,5,6) AND status='review'").all();
 for(const row of rows){
   const generic=/^(NEXT CHAPTER|NEW TURN|NEW EPISODE)$/i.test(String(row.hook||'').trim())||
     /Continue the configured Creative Bible and canon from the previous accepted beat/i.test(String(row.story||''))||
     /EPISODE INTENT:\s*Continue the configured Creative Bible and canon from the previous accepted beat/i.test(String(row.prompt||''));
   const repair=repairs[Number(row.episode)];
   if(!generic||!repair)continue;
   let flow={};try{flow=JSON.parse(String(row.flowResult||'{}'))||{}}catch{}
   flow.publication_override={...repair,reason:'legacy-generic-prompt-visual-repair',source:'review-frame-audit'};
   db.prepare('UPDATE factory_items SET flowResult=?,title=?,description=?,updatedAt=? WHERE id=?')
     .run(JSON.stringify(flow),repair.title,repair.description,now(),row.id);
 }
}
repairLegacyEarthReviewMetadata();

function auditReviewMetadata(){
 const rows=db.prepare("SELECT * FROM factory_items WHERE status='review' ORDER BY episode").all(),report=[];
 for(const row of rows){const fixed=ensureCopy(row);report.push({episode:fixed.episode,title:fixed.title});}
 if(report.length)console.log('[REVIEW COPY AUDIT]',JSON.stringify(report));
}
setTimeout(()=>{try{auditReviewMetadata()}catch(e){console.error('[REVIEW COPY AUDIT ERROR]',String(e?.message||e))}},1100).unref?.();

function repairPendingPublicationMetadata(){
 const showName=String(CONFIG.identity?.show_name||'');
 if(!/dinnie\s*(?:the\s*)?dinosaur|dinnie/i.test(showName))return;
 const rows=db.prepare("SELECT p.id publicationId,p.status publicationStatus,f.* FROM publication_items p JOIN factory_items f ON f.id=p.itemId WHERE p.status NOT IN ('published','cancelled','deleted') ORDER BY p.episode").all();
 for(const row of rows){
   const fixed=ensureCopy(row);
   const pub=db.prepare("SELECT title,description FROM publication_items WHERE id=?").get(row.publicationId);
   if(!pub)continue;
   if(String(pub.title||'')===String(fixed.title||'')&&String(pub.description||'')===String(fixed.description||''))continue;
   db.prepare("UPDATE publication_items SET title=?,description=?,updatedAt=? WHERE id=?")
     .run(String(fixed.title||''),String(fixed.description||''),now(),row.publicationId);
   console.log('[PENDING PUBLICATION COPY REPAIRED]',JSON.stringify({episode:row.episode,title:fixed.title,status:row.publicationStatus}));
 }
}
setTimeout(()=>{try{repairPendingPublicationMetadata()}catch(e){console.error('[PENDING PUBLICATION COPY REPAIR ERROR]',String(e?.message||e))}},1400).unref?.();

function applyForcedPublicationNow(){
  const episode=Number(process.env.PUBLISHER_FORCE_PUBLICATION_NOW_EPISODE||0);
  const token=String(process.env.PUBLISHER_FORCE_PUBLICATION_NOW_TOKEN||'').trim();
  if(!Number.isInteger(episode)||episode<1||!token)return;
  const key='operator:force-publication-now:'+episode+':'+token;
  if(metaGet(key,'')==='done')return;
  const item=db.prepare("SELECT * FROM publication_items WHERE episode=? AND status NOT IN ('published','cancelled','deleted') ORDER BY createdAt LIMIT 1").get(episode);
  if(!item){console.log('[FORCE PUBLICATION NOW SKIPPED]',JSON.stringify({episode,reason:'no-active-publication-item'}));setMeta(key,'done');return}
  const stamp=new Date(Date.now()-1000).toISOString();
  const prior={status:item.status,scheduledAt:item.scheduledAt,attempts:Number(item.attempts||0),retryAt:Number(item.retryAt||0),error:String(item.error||''),videoId:item.videoId||null,remotePrivacyStatus:item.remotePrivacyStatus||null};
  let history=[];try{history=JSON.parse(String(item.history||'[]'))||[]}catch{}
  history.push({status:String(item.status||'queued'),at:now(),message:'Operator emergency: publication time moved to now and retry delay cleared. Existing Facebook upload/session identity is preserved.'});
  db.prepare("UPDATE publication_items SET scheduledAt=?,uploadAt=?,retryAt=0,error=NULL,history=?,updatedAt=? WHERE id=?")
    .run(stamp,stamp,JSON.stringify(history.slice(-120)),now(),item.id);
  setMeta(key,'done');
  console.log('[FORCE PUBLICATION NOW ARMED]',JSON.stringify({episode,publicationId:item.id,prior,preservedVideoId:Boolean(item.videoId),preservedSession:Boolean(item.resumableSession)}));
  setTimeout(()=>{try{void publication.tick()}catch(e){console.error('[FORCE PUBLICATION NOW TICK ERROR]',String(e?.message||e))}},500).unref?.();
}
setTimeout(()=>{try{applyForcedPublicationNow()}catch(e){console.error('[FORCE PUBLICATION NOW ERROR]',String(e?.message||e))}},1800).unref?.();

app.get('/factory/cards',(req,res)=>res.json({cards:db.prepare("SELECT * FROM factory_items WHERE status='review' ORDER BY episode LIMIT 50").all().map(card)}));
app.get('/factory/video/:id',async(req,res)=>{try{const r=db.prepare("SELECT videoPath,remoteUrl,status FROM factory_items WHERE id=?").get(req.params.id);if(!r||r.status!=='review')return res.sendStatus(404);if(r.videoPath&&fs.existsSync(r.videoPath))return stream(req,res,r.videoPath);if(isReviewStorageUri(r.remoteUrl)){const url=await signedReviewUrl(r.remoteUrl,3600);return res.redirect(302,url)}return res.sendStatus(404)}catch(e){res.status(502).json({error:'Review video storage unavailable.'})}});
app.post('/factory/:id/approve',(req,res)=>{try{
  let r=db.prepare('SELECT * FROM factory_items WHERE id=?').get(req.params.id);
  if(!r)return res.sendStatus(404);
  if(r.status!=='review')return res.status(409).json({error:'Already processed.'});
  r=ensureCopy(r);
  const before=storage();
  const item=publication.enqueue(r);
  // Local Review media is transferred to Publication by reference (zero-copy).
  // Delete the Review source only for legacy/provider paths that explicitly made
  // a separate durable copy. Never delete the file Publication now owns.
  if(r.videoPath&&item?.sourceMediaTransferred!==true)try{fs.rmSync(r.videoPath,{force:true})}catch{}
  db.prepare("UPDATE factory_items SET status='queued',stockId=?,videoPath=NULL,remoteUrl=NULL,error=NULL,updatedAt=? WHERE id=?").run(item.id,now(),r.id);
  ensureBacklog(db);
  console.log('[APPROVAL MEDIA HANDOFF]',JSON.stringify({episode:r.episode,job_id:r.id,publication_id:item.id,zero_copy:item?.sourceMediaTransferred===true,storage_before:before,storage_after:storage()}));
  res.json({ok:true,publication:item});
}catch(e){
  console.error('[APPROVAL ERROR]',JSON.stringify({id:req.params.id,code:e?.code||null,message:String(e?.message||e),storage:storage()}));
  res.status(400).json({error:e.message});
}});
function validateImportedMp4(filePath){
  const st=fs.statSync(filePath);
  if(st.size<100000)throw new Error('El archivo es demasiado pequeño para ser un MP4 válido.');
  const head=fs.readFileSync(filePath).subarray(0,256);
  if(!head.includes(Buffer.from('ftyp')))throw new Error('El archivo no parece ser un MP4 válido.');
  const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',filePath],{encoding:'utf8',timeout:30000});
  if(probe.status!==0)throw new Error('No se pudo validar el video.');
  let parsed={};try{parsed=JSON.parse(String(probe.stdout||'{}'))||{}}catch{}
  const stream=(parsed.streams||[]).find(x=>x.codec_type==='video');
  if(!stream)throw new Error('El MP4 no contiene una pista de video válida.');
  const duration=Number(parsed?.format?.duration||0);
  if(duration<4||duration>30)throw new Error('El video importado debe ser un clip corto válido.');
  return{size:st.size,duration,width:Number(stream.width||0),height:Number(stream.height||0)};
}
app.post('/publication/:id/recover-video',express.raw({type:['video/mp4','application/octet-stream'],limit:'100mb'}),async(req,res)=>{
  let tmp='';
  try{
    if(!Buffer.isBuffer(req.body)||req.body.length<100000)return res.status(400).json({error:'Seleccioná el MP4 correcto.'});
    const item=db.prepare("SELECT * FROM publication_items WHERE id=? AND COALESCE(provider,'youtube')='youtube' LIMIT 1").get(req.params.id);
    if(!item)return res.status(404).json({error:'No existe ese video en Stock.'});
    if(String(item.status||'')!=='backup_hold')return res.status(409).json({error:'Este video no está esperando recuperación.'});
    const row=db.prepare('SELECT * FROM factory_items WHERE id=? LIMIT 1').get(item.itemId);
    if(!row)return res.status(404).json({error:'No se encontró el episodio asociado.'});

    fs.mkdirSync(path.join(DIR,'manual-recovery'),{recursive:true,mode:0o700});
    tmp=path.join(DIR,'manual-recovery','publication-'+item.id+'-'+Date.now()+'.mp4');
    fs.writeFileSync(tmp,req.body,{mode:0o600});
    const valid=validateImportedMp4(tmp);
    const digest=createHash('sha256').update(req.body).digest('hex');

    const cloud=await uploadReviewFile(tmp,{itemId:'stock-recovery-'+item.id,revision:Number(row.revision||0)});
    if(!cloud?.uri)throw new Error('No se pudo guardar la copia recuperada en el almacenamiento cloud privado.');

    let history=[];try{history=JSON.parse(String(item.history||'[]'))||[]}catch{}
    history.push({status:'queued',at:now(),message:'MP4 recuperado manualmente desde Google Flow, validado y guardado en cloud privado. El video vuelve a Stock y retomará el flujo normal de publicación.'});
    const scheduledAt=String(item.scheduledAt||'');
    const uploadAt=scheduledAt?new Date(Date.parse(scheduledAt)-390*60000).toISOString():String(item.uploadAt||'');
    db.prepare("UPDATE publication_items SET status='queued',filePath=?,fileSize=?,videoId=NULL,resumableSession=NULL,attempts=0,retryAt=0,error=NULL,history=?,updatedAt=?,remotePrivacyStatus=NULL,remotePublishAt=NULL,remoteStatusCheckedAt=NULL,uploadAt=? WHERE id=?")
      .run(cloud.uri,Number(cloud.size||valid.size),JSON.stringify(history.slice(-120)),now(),uploadAt,item.id);

    let flow={};try{flow=JSON.parse(String(row.flowResult||'{}'))||{}}catch{}
    flow={...flow,manual_recovery_upload:true,recovered_at:now(),recovery_content_hash:digest,recovery_size:valid.size,recovery_duration:valid.duration,recovery_width:valid.width,recovery_height:valid.height,recovery_storage:'private-cloud'};
    db.prepare("UPDATE factory_items SET status='queued',stockId=?,videoPath=NULL,remoteUrl=NULL,reviewContentHash=?,flowResult=?,error=NULL,nextTry=0,updatedAt=? WHERE id=?")
      .run(item.id,digest,JSON.stringify(flow),now(),row.id);

    try{fs.rmSync(tmp,{force:true})}catch{};tmp='';
    console.log('[PUBLICATION MANUAL RECOVERY ACCEPTED]',JSON.stringify({episode:item.episode,publicationId:item.id,size:valid.size,duration:valid.duration,cloud:true}));
    res.json({ok:true,episode:item.episode,publicationId:item.id,status:'queued',cloud:true,scheduledAt,uploadAt});
  }catch(e){
    try{if(tmp&&fs.existsSync(tmp))fs.rmSync(tmp,{force:true})}catch{}
    res.status(400).json({error:String(e?.message||e)});
  }
});
app.post('/factory/import-stock/:episode',express.raw({type:['video/mp4','application/octet-stream'],limit:'100mb'}),(req,res)=>{
  let tmp='';
  try{
    const episode=Number(req.params.episode);
    if(!Number.isInteger(episode)||episode<1)return res.status(400).json({error:'Episodio inválido.'});
    if(!Buffer.isBuffer(req.body)||req.body.length<100000)return res.status(400).json({error:'Seleccioná un archivo MP4 válido.'});
    let row=db.prepare('SELECT * FROM factory_items WHERE episode=? ORDER BY season DESC LIMIT 1').get(episode);
    if(!row)return res.status(404).json({error:'No existe ese episodio en el Publisher.'});
    const existing=db.prepare("SELECT id,status FROM publication_items WHERE itemId=? AND status NOT IN ('cancelled','deleted') LIMIT 1").get(row.id);
    if(existing)return res.status(409).json({error:'Ese episodio ya está en Publishing.'});

    fs.mkdirSync(path.join(DIR,'manual-imports'),{recursive:true,mode:0o700});
    tmp=path.join(DIR,'manual-imports','episode-'+episode+'-'+Date.now()+'.mp4');
    fs.writeFileSync(tmp,req.body,{mode:0o600});
    const valid=validateImportedMp4(tmp);
    const digest=createHash('sha256').update(req.body).digest('hex');

    try{if(row.videoPath&&row.videoPath!==tmp&&fs.existsSync(row.videoPath))fs.rmSync(row.videoPath,{force:true})}catch{}
    row=materializeCreativePackage(db,row,{force:false}).row;
    db.prepare(`UPDATE factory_items SET status='review',videoPath=?,remoteUrl=NULL,stockId=NULL,providerRunId=NULL,
      flowResult=?,reviewContentHash=?,error=NULL,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?`)
      .run(tmp,JSON.stringify({manual_stock_import:true,operator_selected_existing_flow_video:true,validated_ftyp:true,content_hash:digest,size:valid.size,duration:valid.duration,width:valid.width,height:valid.height}),digest,now(),now(),row.id);
    row=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id);
    row=ensureCopy(row);
    const item=publication.enqueue(row);
    db.prepare("UPDATE factory_items SET status='queued',stockId=?,videoPath=NULL,remoteUrl=NULL,error=NULL,updatedAt=? WHERE id=?").run(item.id,now(),row.id);
    try{if(fs.existsSync(tmp))fs.rmSync(tmp,{force:true})}catch{}
    tmp='';
    ensureBacklog(db);
    res.json({ok:true,episode,title:item.title,description:item.description,scheduledAt:item.scheduledAt,publication:item});
  }catch(e){
    try{if(tmp&&fs.existsSync(tmp))fs.rmSync(tmp,{force:true})}catch{}
    res.status(400).json({error:String(e?.message||e)});
  }
});
app.post('/factory/:id/reject',async(req,res)=>{
 let r=db.prepare('SELECT * FROM factory_items WHERE id=?').get(req.params.id);
 if(!r)return res.sendStatus(404);
 if(r.status!=='review')return res.status(409).json({error:'Already processed.'});
 const feedback=String(req.body?.feedback||'').replace(/[\u0000-\u001f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,1200);
 if(feedback.length<3)return res.status(400).json({error:'Explain briefly what went wrong before REDO.'});
 const token=randomBytes(24).toString('hex'),rev=Number(r.revision||0)+1,stamp=now();
 // Rejection is destructive for the rejected media: remove any accidental
 // publication record / private remote upload before the semantic AI decides
 // whether this is a render retry, prompt revision, or creative rewrite.
 await publication.purgeRejected(r);
 if(isReviewStorageUri(r.remoteUrl)){try{await deleteReviewObject(r.remoteUrl)}catch{}}
 if(r.videoPath)try{fs.rmSync(r.videoPath,{force:true})}catch{}
 db.prepare("UPDATE factory_items SET status='feedback_wait',revision=?,reviewFeedback=?,retryStrategy='ai_pending',reviewRetryToken=?,reviewRetrySubmittedToken=NULL,reviewInterpretation=NULL,reviewInterpretationAt=NULL,transportPreflight=NULL,providerRunId=NULL,flowResult=NULL,videoPath=NULL,remoteUrl=NULL,reviewVideoId=NULL,reviewArchivedAt=NULL,reviewOriginalSize=NULL,reviewPreviewSize=NULL,reviewContentHash=NULL,error='Human REDO requested: replacement creative package required; semantic AI interpretation pending.',nextTry=0,runtimeAttemptCount=0,updatedAt=? WHERE id=?")
   .run(rev,feedback,token,stamp,r.id);
 metaSet('flow:generationLifecycle:'+r.id,JSON.stringify({
   state:'FEEDBACK_AI_PENDING',generation_id:null,generation_started_at:null,submit_boundary_at:null,
   baseline:[],baseline_inventory:null,reviewer_retry:true,retry_token:token,retry_strategy:'ai_pending',
   review_feedback:feedback,retry_requested_at:stamp,exactly_one_submit:true,automatic_submit_forbidden:true
 }));
 res.json({ok:true,regenerating:true,aiPending:true,retryStrategy:'ai_pending',retryToken:token});
 setTimeout(()=>{try{globalThis.__publisherRunProvider?.()}catch{}},50).unref?.();
});
app.post('/factory/enable',(req,res)=>{metaSet('automation:factoryEnabled','true');res.json({ok:true,enabled:true})});
app.post('/factory/disable',(req,res)=>{metaSet('automation:factoryEnabled','false');res.json({ok:true,enabled:false})});
app.post('/factory/preflight',(req,res)=>{metaSet('automation:allowSubmit','0');const r=db.prepare("SELECT id,episode,status FROM factory_items WHERE status IN ('draft','regen_wait') ORDER BY episode LIMIT 1").get();res.status(202).json({ok:true,next:r||null,note:'Provider will run preflight only; Generate remains disabled.'})});
app.post('/factory/test-generation',(req,res)=>{metaSet('automation:factoryEnabled','false');metaSet('automation:allowSubmit','1');res.status(202).json({ok:true,one_test_submit_authorized:true})});
app.post('/factory/run',(req,res)=>{res.status(202).json({ok:true})});
app.post('/factory/generate-extra',(req,res)=>{
 try{
  const count=Math.max(1,Math.min(20,Math.trunc(Number(req.body?.count)||1)));
  const day=publisherDay(),current=activeDailyTarget(day),target=current+count;
  metaSet('automation:manualDailyTarget:'+day,String(target));
  metaSet('automation:factoryEnabled','true');
  metaSet('flow:state','CONECTADO');
  metaSet('flow:currentStep','manual-extra-requested');
  metaSet('flow:message','Operator requested '+count+' extra video(s) today. Daily target is now '+target+'.');
  ensureBacklog(db);
  const completed=completedGeneratedToday(day);
  setTimeout(()=>{try{globalThis.__publisherRunProvider?.()}catch{}},50).unref?.();
  res.status(202).json({ok:true,day,added:count,daily_target:target,completed_today:completed,remaining_today:Math.max(0,target-completed)});
 }catch(e){res.status(400).json({error:e.message})}
});

function storage(){
 try{const st=fs.statfsSync(DATA_DIR),block=Number(st.bsize||st.frsize||4096),total=Number(st.blocks||0)*block,free=Number(st.bavail??st.bfree??0)*block;return{total_bytes:total,free_bytes:free,used_bytes:total-free,free_percent:total?Math.round(free/total*1000)/10:null}}catch{return null}
}
function providerStatus(){return readJson(path.join(process.cwd(),'public','free-browser-status.json'),null)}
function flowAuth(){return readJson(path.join(DIR,'flow-auth-verified.json'),null)}
function liveFlowConfig(){
  let g={...(CONFIG.generation||{})};
  try{const p=readJson(path.join(DATA_DIR,'publisher-config.json'),null);if(p?.generation)g={...g,...p.generation}}catch{}
  const v=flowAuth();if(v?.project_id)g={...g,project_id:v.project_id,project_url:'https://flow.google.com/project/'+v.project_id,project_name:v.project_name||g.project_name};
  return{project_id:String(g.project_id||''),project_name:String(g.project_name||''),project_url:String(g.project_url||'')};
}
function metaGet(k,f=''){return db.prepare('SELECT value FROM factory_meta WHERE key=?').get(k)?.value??f}
function metaSet(k,v){db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v))}
function activateReadyAutomation(){
  try{
    const lf=liveFlowConfig(),knowledgeReady=metaGet('knowledge:flowSopLoaded','false')==='true',ready=publicationConnected()&&Boolean(lf.project_id&&flowAuth()?.ok)&&Boolean(String(CONFIG.content.creative_bible||'').trim())&&knowledgeReady;
    if(!ready)return false;
    const already=metaGet('automation:factoryEnabled','false')==='true';
    if(already)return true;
    metaSet('automation:factoryEnabled','true');
    const t=now();
    if(!metaGet('automation:readinessActivatedAt',''))metaSet('automation:readinessActivatedAt',t);
    try{db.prepare("UPDATE factory_items SET nextTry=0,error=NULL,updatedAt=? WHERE status IN ('draft','regen_wait') AND providerRunId IS NULL").run(t)}catch{}
    console.log('[AUTOMATION READY] '+String(selectedPublicationProvider()||'publication platform')+' + exact Flow project + Creative Bible + canonical SOP verified. Starting autonomous production.');
    setTimeout(()=>{try{globalThis.__publisherRunProvider?.()}catch{}},450).unref?.();
    return true;
  }catch{return false}
}
function publisherDay(){
 return new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
function activeDailyTarget(day=publisherDay()){
 const base=Math.max(1,Number(DAILY_LIMIT||1));
 const overrideDay=String(process.env.PUBLISHER_DAILY_LIMIT_OVERRIDE_DAY||'').trim();
 const overrideCount=Math.max(base,Number(process.env.PUBLISHER_DAILY_LIMIT_OVERRIDE_COUNT||0)||0);
 const envTarget=overrideDay===day&&overrideCount>base?overrideCount:base;
 const manualTarget=Math.max(0,Number(metaGet('automation:manualDailyTarget:'+day,'0'))||0);
 return Math.max(base,envTarget,manualTarget);
}
function publisherDayFromCandidates(...values){
 for(const value of values){
   const ms=Date.parse(String(value||''));if(!Number.isFinite(ms))continue;
   return new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
 }
 return'';
}
function retainedGeneratedToday(day=publisherDay()){
 let count=0;
 try{
   const rows=db.prepare("SELECT status,flowResult,lastProgressAt,updatedAt,stockId,reviewContentHash FROM factory_items WHERE status IN ('review','queued','historical','published')").all();
   for(const row of rows){
     let flow={};try{flow=JSON.parse(String(row.flowResult||'{}'))||{}}catch{}
     if(publisherDayFromCandidates(flow?.generation_started_at,row.lastProgressAt,row.updatedAt)===day)count++;
   }
 }catch{}
 return count;
}
function approvedPublicationGeneratedToday(day=publisherDay()){
 let count=0;
 try{
   const rows=db.prepare("SELECT p.createdAt,p.status,f.flowResult,f.lastProgressAt,f.updatedAt FROM publication_items p JOIN factory_items f ON f.id=p.itemId WHERE p.status NOT IN ('cancelled','deleted')").all();
   for(const row of rows){
     let flow={};try{flow=JSON.parse(String(row.flowResult||'{}'))||{}}catch{}
     if(publisherDayFromCandidates(row.createdAt)===day){count++;continue}
     if(publisherDayFromCandidates(flow?.generation_started_at,row.lastProgressAt,row.updatedAt)===day)count++;
   }
 }catch{}
 return count;
}
function reviewGeneratedToday(day=publisherDay()){
 let count=0;
 try{
   const rows=db.prepare("SELECT flowResult,lastProgressAt,updatedAt FROM factory_items WHERE status='review'").all();
   for(const row of rows){
     let flow={};try{flow=JSON.parse(String(row.flowResult||'{}'))||{}}catch{}
     if(publisherDayFromCandidates(flow?.generation_started_at,row.lastProgressAt,row.updatedAt)===day)count++;
   }
 }catch{}
 return count;
}
function completedGeneratedToday(day=publisherDay()){
 const ledger=Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE day=? AND credits>0 AND status IN ('review','completed')").get(day)?.n||0);
 const approvedPlusReview=approvedPublicationGeneratedToday(day)+reviewGeneratedToday(day);
 return Math.max(ledger,retainedGeneratedToday(day),approvedPlusReview);
}
function health(){
 const counts={};for(const r of db.prepare('SELECT status,COUNT(*) n FROM factory_items GROUP BY status').all())counts[r.status]=Number(r.n);
 const p=providerStatus(),beat=p?.at?Date.parse(p.at):0,workerAlive=Boolean(beat&&Date.now()-beat<180000),today=new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),completed=completedGeneratedToday(today),current=db.prepare("SELECT episode,status,error,lastProgressAt FROM factory_items WHERE status IN ('generating','draft','regen_wait') ORDER BY CASE status WHEN 'generating' THEN 0 ELSE 1 END,episode LIMIT 1").get();
 const dailyTarget=activeDailyTarget();
 const activePromptRows=db.prepare("SELECT episode,prompt FROM factory_items WHERE status IN ('draft','regen_wait') ORDER BY episode").all();
 const activeBible=String(CONFIG.content.creative_bible||'').trim();
 const emptyActivePrompts=activePromptRows.filter(x=>!String(x.prompt||'').trim()).map(x=>Number(x.episode));
 const bibleMismatchEpisodes=activeBible?activePromptRows.filter(x=>String(x.prompt||'').trim()&&!String(x.prompt||'').includes(activeBible)).map(x=>Number(x.episode)):[];
 const promptIntegrity={ok:emptyActivePrompts.length===0&&bibleMismatchEpisodes.length===0,empty_active_prompts:emptyActivePrompts.length,empty_prompt_episodes:emptyActivePrompts.slice(0,20),show_bible_mismatches:bibleMismatchEpisodes.length,show_bible_mismatch_episodes:bibleMismatchEpisodes.slice(0,20)};
 const knowledge={flow_sop_version:metaGet('knowledge:flowSopVersion',''),flow_sop_sha256:metaGet('knowledge:flowSopSha256',''),declared_sha256:metaGet('knowledge:flowSopDeclaredSha256',''),loaded:metaGet('knowledge:flowSopLoaded','false')==='true',document_count:Number(metaGet('knowledge:flowSopDocumentCount','0')||0),inherit_to_publisher:metaGet('knowledge:inheritToPublisher','false')==='true'};
 const reviewCopy=db.prepare("SELECT * FROM factory_items WHERE status='review' ORDER BY episode LIMIT 10").all().map(r=>{const x=ensureCopy(r);return{episode:Number(x.episode),title:String(x.title||''),description:String(x.description||''),creative_package_id:String(x.creativePackageId||'')}});
 const publicationCopy=db.prepare("SELECT episode,title,description,status,scheduledAt,uploadAt,attempts,retryAt,error,videoId,filePath,remotePrivacyStatus,remotePublishAt,updatedAt FROM publication_items WHERE status NOT IN ('cancelled','deleted') ORDER BY episode LIMIT 20").all().map(x=>({episode:Number(x.episode),title:String(x.title||''),description:String(x.description||''),status:String(x.status||''),scheduled_at:x.scheduledAt||null,upload_at:x.uploadAt||null,attempts:Number(x.attempts||0),retry_at:Number(x.retryAt||0)||null,error:x.error?String(x.error).slice(0,800):null,video_id:x.videoId||null,has_file:Boolean(x.filePath),remote_privacy_status:x.remotePrivacyStatus||null,remote_publish_at:x.remotePublishAt||null,updated_at:x.updatedAt||null}));
 const creditCycleRaw=metaGet('flow:dailyCreditCycle','');let creditCycle=null;try{creditCycle=creditCycleRaw?JSON.parse(creditCycleRaw):null}catch{}
 const creditCycleHealth={
   gate:'wait-for-daily-flow-refresh',
   daily_grant_credits:Number(CONFIG.generation?.daily_credit_grant||50),
   batch_target:Number(CONFIG.content?.videos_per_day||3),
   batch_cost:Number(CONFIG.content?.videos_per_day||3)*Number(CONFIG.generation?.credits_per_generation||15),
   cycle_id:creditCycle?.id||null,
   opened_at:creditCycle?.opened_at||null,
   source:creditCycle?.source||null,
   visible_balance:(()=>{const n=Number(metaGet('flow:lastCreditsVisible',''));return Number.isFinite(n)?n:null})(),
   last_checked_at:metaGet('flow:lastCreditsCheckedAt','')||null,
   renewal_evidence:metaGet('flow:dailyCreditRenewalEvidence','')||null,
   automatic_batch_open:metaGet('flow:dailyCreditBatchOpen','false')==='true',
   waiting_for_refresh:metaGet('flow:dailyCreditRefreshWaiting','false')==='true',
   used_in_cycle:Number(metaGet('flow:dailyCreditCycleUsed','0')||0),
   target_in_cycle:Number(metaGet('flow:dailyCreditCycleTarget',String(CONFIG.content?.videos_per_day||3))||0)
 };
 const generationCounter=Math.max(Number(completed||0),Number(creditCycleHealth.used_in_cycle||0));
 return{ok:true,at:now(),runtime_version:'publisher-runtime-v1',publisher_enabled:metaGet('automation:factoryEnabled','false')==='true',show:CONFIG.identity.show_name,scheduler_alive:true,scheduler:publication.status(),scheduler_no_end_date:true,worker_alive:workerAlive,automation_provider:'FreeBrowserProvider',generation_provider:'GoogleFlowProvider',publication_provider:selectedPublicationProvider()==='facebook'?'FacebookReelsProvider':selectedPublicationProvider()==='youtube'?'YouTubeProvider':'NotSelected',tinyfish_required:false,tinyfish_fallback:false,knowledge,flow:(()=>{const lf=liveFlowConfig();return{configured:Boolean(lf.project_id),authenticated:Boolean(flowAuth()?.ok),project_id:lf.project_id||null,project_name:lf.project_name||null,project_url:lf.project_url||null}})(),current_job:current||null,queue:counts,completed_today:generationCounter,calendar_completed_today:completed,daily_target:dailyTarget,remaining_today:Math.max(0,dailyTarget-generationCounter),daily_override_active:dailyTarget!==DAILY_LIMIT,provider_health:p?.state||null,last_generation:db.prepare("SELECT createdAt FROM factory_generations ORDER BY createdAt DESC LIMIT 1").get()?.createdAt||null,last_review_ready:db.prepare("SELECT updatedAt FROM factory_items WHERE status='review' ORDER BY updatedAt DESC LIMIT 1").get()?.updatedAt||null,last_publication:db.prepare("SELECT updatedAt,status,videoId FROM publication_items ORDER BY updatedAt DESC LIMIT 1").get()||null,serial_gate:{enabled:true,creative_serialized:Boolean(CONFIG.content.serialized),gate:'review_ready',strict:true},automation_safety:{exactly_once_submit:metaGet('automation:exactlyOnceSubmit','false')==='true',strict_serial_generation:metaGet('automation:strictSerialGeneration','false')==='true',project_grid_recovery:metaGet('automation:projectGridRecovery','false')==='true',review_metadata_required:metaGet('automation:reviewMetadataRequired','false')==='true',golden_test_required:metaGet('automation:goldenTestRequired','false')==='true',stable_composer_handoff:true,frutti_browser_launch_parity:true,native_no_charge_retry:false,immediate_native_retry_disabled:true,adaptive_no_charge_backoff:true,unusual_activity_exponential_backoff:true,provider_wide_unusual_activity_backoff:true,monotonic_provider_cooldown:true,successful_render_resets_provider_backoff:true,successful_redos_count_toward_daily_target:true,legacy_streak_resurrection_guard:true,strict_post_submit_recovery_match:true,catalog_wide_creative_uniqueness:true,no_landscape_repeat_cycle:true,youtube_preapproval_private_staging_disabled:true,cloud_stock_until_upload_window:true,private_upload_at_1230:true,direct_private_to_public_at_1900:true,native_publish_at_disabled:true,youtube_upload_lead_minutes_390:true,manual_stock_recovery_upload:true,recovery_upload_cloud_required:true,flow_asset_identity_gate:true,recovered_asset_reuse_blocked:true,duplicate_content_hash_guard:true,fixed_grid_multiset_recovery:true,post_click_asset_identity_verified:true,recovery_token_never_submits:true,adjacent_submit_temporal_bracket:true,download_reopen_by_asset_identity:true,zero_copy_approval_handoff:true,approval_enospc_copy_eliminated:true,show_specific_repairs_isolated:true,prompt_show_bible_gate:true,atomic_creative_package:true,approval_before_external_storage:true,reject_purges_external_artifacts:true,semantic_ai_redo_interpretation:true,post_submit_timeout_never_resubmits:true,daily_flow_credit_refresh_gate:true,calendar_midnight_does_not_open_batch:true,paid_monthly_credits_protected_until_daily_refresh:true},credit_cycle:creditCycleHealth,prompt_integrity:promptIntegrity,review_copy:reviewCopy,publication_copy:publicationCopy,storage:storage(),security:{configured:configured(),passkeys:authState().passkeys.length,active_sessions:authState().sessions.filter(x=>x.expiresAt>Date.now()&&!x.revokedAt).length}};
}
function repairObsoleteFlowSettingsErrors(){
  try{
    const stamp=now();
    const out=db.prepare(`UPDATE factory_items
      SET status=CASE WHEN status='generating' THEN 'draft' ELSE status END,
          error=NULL,nextTry=0,providerRunId=NULL,transportPreflight=NULL,lastProgressAt=?,updatedAt=?
      WHERE status IN ('draft','regen_wait','generating')
        AND (error LIKE '%FLOW_SETTING_NOT_FOUND:720p:%'
          OR error LIKE '%FLOW_SETTING_NOT_FOUND:10s:%'
          OR error LIKE '%FLOW_SETTINGS_NOT_CONFIRMED:%')`).run(stamp,stamp);
    if(Number(out?.changes||0)>0){
      console.log('[FLOW SETTINGS UI REPAIR]',JSON.stringify({repaired:Number(out.changes)}));
      setTimeout(()=>{try{globalThis.__publisherRunProvider?.()}catch{}},700).unref?.();
    }
  }catch(e){console.error('[FLOW SETTINGS UI REPAIR ERROR]',String(e?.message||e))}
}
setTimeout(repairObsoleteFlowSettingsErrors,1800).unref?.();

app.get('/factory/health',(req,res)=>res.json(health()));
app.get('/factory/knowledge',(req,res)=>{
  const rows=db.prepare('SELECT key,version,sha256,source,updatedAt,length(content) bytes FROM runtime_knowledge ORDER BY key').all();
  res.json({ok:true,knowledge:health().knowledge,documents:rows});
});

// HARD APPROVAL GATE: review media stays on the Publisher volume until the
// operator approves it. No pre-approval Supabase/YouTube staging is allowed.
async function archiveReviewOriginal(_row){return false}
async function storageTick(){
  // Deliberately no remote archival for status='review'.
  return;
}

app.get('/api/status',(req,res)=>{
  const h=health(),youtubeConnected=Boolean(loadToken()),facebook=facebookConnection(),facebookOk=facebookConnected(),selected=selectedPublicationProvider(),publicationOk=publicationConnected(),flowConnected=Boolean(h.flow.configured&&h.flow.authenticated),bibleConfigured=Boolean(String(CONFIG.content.creative_bible||'').trim()),ready=Boolean(selected&&publicationOk&&flowConnected&&bibleConfigured);
  if(ready)activateReadyAutomation();
  res.json({
    health:health(),brand:brandPublic(),
    publication:{selected,connected:publicationOk,allowed:['youtube','facebook'],posting_times:CONFIG.schedule?.posting_times||[],timezone:CONFIG.schedule?.timezone||CONFIG.identity?.timezone||'UTC'},
    youtube:{oauthConfigured:Boolean(ytSecrets().client_id&&ytSecrets().client_secret),connected:youtubeConnected},
    facebook:{appConfigured:Boolean(fbSecrets().app_id&&fbSecrets().app_secret),connected:facebookOk,pageId:facebook.page_id||null,pageName:facebook.page_name||null},
    flowBootstrap:'/flow/bootstrap',
    onboarding:{publication:publicationOk&&Boolean(selected),youtube:selected==='youtube'&&youtubeConnected,facebook:selected==='facebook'&&facebookOk,flow:flowConnected,bible:bibleConfigured,ready}
  });
});
function scheduleParts(date,tz){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  return Object.fromEntries(parts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
}
function scheduleDayKey(date,tz){const p=scheduleParts(date,tz);return p.year+'-'+p.month+'-'+p.day}
function scheduleAddDay(day,n=1){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function scheduleLocalDate(day,time,tz){
  const [y,m,d]=day.split('-').map(Number),[hh,mm]=time.split(':').map(Number);
  const target=Date.UTC(y,m-1,d,hh,mm,0);let guess=target;
  for(let i=0;i<4;i++){
    const p=scheduleParts(new Date(guess),tz);
    const seen=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
    const diff=target-seen;if(Math.abs(diff)<1000)break;guess+=diff;
  }
  return new Date(guess);
}
function reschedulePendingPublications(){
  const time=String(CONFIG.schedule?.posting_times?.[0]||'19:00');
  const tz=String(CONFIG.schedule?.timezone||CONFIG.identity?.timezone||'UTC');
  const rows=db.prepare("SELECT id,provider,videoId,status FROM publication_items WHERE status NOT IN ('published','cancelled','deleted') AND videoId IS NULL ORDER BY episode,createdAt").all();
  let day=scheduleDayKey(new Date(),tz),cursor=null,changed=0;
  for(const row of rows){
    let next;
    while(true){
      const d=scheduleLocalDate(day,time,tz);
      if(d.getTime()>Date.now()+5*60*1000 && (!cursor||d.getTime()>cursor.getTime())){next=d;break}
      day=scheduleAddDay(day,1);
    }
    const provider=String(row.provider||CONFIG.publication?.selected_provider||'youtube');
    const lead=provider==='facebook'?0:Math.max(0,Number(CONFIG.schedule?.upload_lead_minutes||0))*60000;
    db.prepare("UPDATE publication_items SET scheduledAt=?,uploadAt=?,updatedAt=? WHERE id=?")
      .run(next.toISOString(),new Date(next.getTime()-lead).toISOString(),now(),row.id);
    cursor=next;day=scheduleAddDay(day,1);changed++;
  }
  return changed;
}
app.get('/api/schedule',(req,res)=>res.json({
  posting_time:String(CONFIG.schedule?.posting_times?.[0]||'19:00'),
  posting_times:CONFIG.schedule?.posting_times||['19:00'],
  timezone:String(CONFIG.schedule?.timezone||CONFIG.identity?.timezone||'UTC')
}));
app.post('/api/schedule',(req,res)=>{
  const time=String(req.body?.posting_time||'').trim();
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))return res.status(400).json({error:'Use a valid 24-hour time, for example 19:00.'});
  CONFIG.schedule={...(CONFIG.schedule||{}),posting_times:[time]};
  try{
    fs.writeFileSync(path.join(DATA_DIR,'publisher-config.json'),JSON.stringify(CONFIG,null,2),{mode:0o600});
    const rescheduled=reschedulePendingPublications();
    return res.json({ok:true,posting_time:time,timezone:CONFIG.schedule.timezone||CONFIG.identity?.timezone||'UTC',rescheduled});
  }catch(e){
    return res.status(500).json({error:'Could not save publication time: '+String(e?.message||e)});
  }
});
app.get('/api/show-bible',(req,res)=>res.json({creative_bible:String(CONFIG.content.creative_bible||'')}));
app.post('/api/show-bible',(req,res)=>{const bible=String(req.body?.creative_bible||'').trim().slice(0,80000);if(bible.length<20)return res.status(400).json({error:'The Show Bible needs at least 20 characters.'});CONFIG.content.creative_bible=bible;try{fs.writeFileSync(path.join(DATA_DIR,'publisher-config.json'),JSON.stringify(CONFIG,null,2),{mode:0o600});ensureBacklog(db)}catch(e){return res.status(500).json({error:'Could not save/rematerialize Show Bible packages: '+e.message})}res.json({ok:true,length:bible.length,prompts_rematerialized:true})});
app.get('/api/config/export',(req,res)=>{const c=structuredClone(CONFIG);res.set('Content-Disposition','attachment; filename="publisher-config.json"');res.type('json').send(JSON.stringify(c,null,2))});

app.get('/security',(req,res)=>res.sendFile('security.html',{root:'public',headers:{'Cache-Control':'no-store, max-age=0'}}));
app.use(express.static('public',{
  setHeaders(res,filePath){
    if(/\.html$/i.test(filePath))res.setHeader('Cache-Control','no-store, max-age=0');
  }
}));
app.get('/',(req,res)=>res.sendFile('index.html',{root:'public',headers:{'Cache-Control':'no-store, max-age=0'}}));

setInterval(()=>{try{activateReadyAutomation()}catch{}},30000).unref?.();
app.listen(PORT,'0.0.0.0',()=>{console.log('Publisher Runtime v1 listening',PORT);setTimeout(()=>activateReadyAutomation(),1400).unref?.()});
