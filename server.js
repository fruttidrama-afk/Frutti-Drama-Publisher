
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
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
import { CONFIG,PROJECT_ID,PROJECT_NAME,PROJECT_URL,DAILY_LIMIT,TIMEZONE,ideaForEpisode,ensureBacklog } from './runtime-config.js';
import { installPublication } from './publication.js';
import { buildPublicationCopy } from './publication-copy.js';
import { uploadReviewFile, signedReviewUrl, deleteReviewObject, isReviewStorageUri, reviewStorageConfigured, reviewStorageRequired } from './review-storage.js';

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
  "ALTER TABLE factory_items ADD COLUMN creativePackageHash TEXT",
  "ALTER TABLE factory_items ADD COLUMN creativePackageId TEXT",
  "ALTER TABLE factory_generations ADD COLUMN generationKind TEXT NOT NULL DEFAULT 'automatic'"
]){try{db.exec(sql)}catch{}}

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:false,limit:'256kb'}));

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
    esc=x=>String(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="${esc(t.primary||'#0d3152')}"><title>Activar ${esc(show)}</title>
<style>
:root{--n:${esc(t.primary||'#0d3152')};--g:${esc(t.accent||t.secondary||'#b59a64')};--bg:${esc(t.background||'#071018')};--surface:${esc(t.surface||'#10232f')};--ink:${esc(t.text||'#f5f3ed')};--m:color-mix(in srgb,var(--ink) 70%,transparent)}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:linear-gradient(180deg,rgba(0,0,0,.42),rgba(0,0,0,.72)),${brand.reference_image_url?'url("'+esc(brand.reference_image_url)+'")':'var(--bg)'};background-size:cover;background-position:center;font-family:Arial,sans-serif;padding:24px;color:var(--ink)}
.c{width:min(520px,100%);background:color-mix(in srgb,var(--surface) 82%,transparent);border:1px solid color-mix(in srgb,var(--ink) 16%,transparent);padding:30px;text-align:center;border-radius:28px;backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);box-shadow:0 28px 90px rgba(0,0,0,.34)}
.logo{width:96px;height:96px;object-fit:cover;border-radius:24px;margin:0 auto 14px;display:${brand.logo_url?'block':'none'};box-shadow:0 14px 44px rgba(0,0,0,.25)}
.mark{font:600 28px/.95 Arial,sans-serif;letter-spacing:.08em;color:var(--ink);margin-bottom:6px}.tag{font-size:10px;letter-spacing:.16em;color:var(--m);margin-bottom:22px}.eye{font-size:11px;letter-spacing:.2em;color:var(--g);font-weight:800;margin-bottom:10px}
h1{font:600 42px/.98 Arial,sans-serif;letter-spacing:.01em;margin:0 0 14px}.muted{color:var(--m);line-height:1.5}.err{color:#ffb2a8;font-size:13px;margin-top:14px}
.spin{width:26px;height:26px;border:3px solid color-mix(in srgb,var(--ink) 20%,transparent);border-top-color:var(--g);border-radius:50%;margin:20px auto;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
.actions{display:none;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:20px}.actions.show{display:flex}.btn{border:1px solid color-mix(in srgb,var(--ink) 24%,transparent);background:transparent;color:var(--ink);padding:13px 18px;font-weight:800;letter-spacing:.04em;cursor:pointer}.btn.primary{background:var(--g);border-color:var(--g);color:#111}
</style></head><body><main class=c>${brand.logo_url?'<img class="logo" src="'+esc(brand.logo_url)+'" alt="">':''}<div class=mark>${esc(show)}</div><div class=tag>${esc(brand.tagline||'')}</div><div class=eye>DEVICE ACCESS</div><h1 id=t>Opening your Publisher</h1><div id=spin class=spin></div><p id=m class=muted>Validating this device…</p><div id=actions class=actions><button id=key class="btn primary" type=button>CREATE DEVICE KEY</button><button id=continue class=btn type=button style="display:none">CONTINUE THIS SESSION</button></div><div id=e class=err></div></main>
<script>
const q=s=>document.querySelector(s),t=q('#t'),m=q('#m'),e=q('#e'),spin=q('#spin'),actions=q('#actions'),key=q('#key'),cont=q('#continue');
const fromB64url=v=>{const s=String(v||'').replace(/-/g,'+').replace(/_/g,'/'),p=s+'='.repeat((4-s.length%4)%4),raw=atob(p),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out};
const toB64url=v=>{let s='';for(const x of new Uint8Array(v))s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
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

function brandPublic(){const b=CONFIG.branding||{},t=b.theme||{};return{reference_mode:b.reference_mode||null,reference_image_url:b.reference_image_url||null,logo_url:b.logo_url||null,icon_180_url:b.icon_180_url||null,icon_192_url:b.icon_192_url||null,icon_512_url:b.icon_512_url||null,maskable_icon_url:b.maskable_icon_url||b.icon_512_url||null,safe_area_ratio:Number(b.safe_area_ratio||.8),tagline:b.tagline||CONFIG.identity.description||'',theme:{primary:t.primary||'#0d3152',secondary:t.secondary||'#b59a64',accent:t.accent||'#b59a64',background:t.background||'#f7f6f2',surface:t.surface||'#ffffff',text:t.text||'#1d1d1b'}}}
function brandRedirect(res,url,fallback){res.set('Cache-Control','no-store, max-age=0');if(url)return res.redirect(302,url);res.status(200).type('image/svg+xml').send(fallback)}
function fallbackBrandSvg(){const n=String(CONFIG.identity.show_name||CONFIG.identity.publisher_name||'P').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase().slice(0,2)||'P',b=brandPublic(),t=b.theme;return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="108" fill="'+t.background+'"/><rect x="82" y="82" width="348" height="348" rx="72" fill="'+t.primary+'"/><text x="256" y="305" text-anchor="middle" font-family="Arial,sans-serif" font-size="165" font-weight="700" fill="'+(String(t.text).toLowerCase()==='#ffffff'?'#ffffff':'#ffffff')+'">'+n.replace(/[&<>]/g,'')+'</text></svg>'}
app.get('/brand/logo.svg',(req,res)=>brandRedirect(res,brandPublic().logo_url,fallbackBrandSvg()));
app.get('/apple-touch-icon.png',(req,res)=>{res.set('Cache-Control','no-store, max-age=0');const b=brandPublic(),u=b.icon_180_url||b.icon_512_url;if(u)return res.redirect(302,u);res.type('image/svg+xml').send(fallbackBrandSvg())});
app.get('/manifest.webmanifest',(req,res)=>{res.set('Cache-Control','no-store, max-age=0');const b=brandPublic(),icons=[];if(b.icon_192_url)icons.push({src:b.icon_192_url,sizes:'192x192',type:'image/png',purpose:'any'});if(b.icon_512_url)icons.push({src:b.icon_512_url,sizes:'512x512',type:'image/png',purpose:'any'});if(b.maskable_icon_url)icons.push({src:b.maskable_icon_url,sizes:'512x512',type:'image/png',purpose:'maskable'});if(!icons.length)icons.push({src:'/brand/logo.svg',sizes:'any',type:'image/svg+xml',purpose:'any'});res.type('application/manifest+json').send(JSON.stringify({name:CONFIG.identity.show_name||CONFIG.identity.publisher_name,short_name:CONFIG.identity.show_name||CONFIG.identity.publisher_name,start_url:'/',scope:'/',display:'standalone',background_color:b.theme.background,theme_color:b.theme.primary,icons}))});

app.use((req,res,next)=>{
 if(['/setup','/setup/activate','/login','/auth/public-info','/auth/pin','/auth/passkeys/options','/auth/passkeys/verify','/oauth2callback','/factory/health','/brand/logo.svg','/apple-touch-icon.png','/manifest.webmanifest'].includes(req.path))return next();
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

const publication=installPublication({app,db,config:CONFIG,youtubeApi,authedClient,loadToken,dataDir:DIR});

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
 const provider=(CONFIG.publication.providers||[]).find(x=>x.type==='youtube')||{};
 let flow={};try{flow=JSON.parse(String(row.flowResult||'{}'))||{}}catch{}
 const override=flow?.publication_override;
 const earth=/earth\s*in\s*10/i.test(String(CONFIG.identity?.show_name||''));
 let expected=null;
 if(override?.title&&override?.description){
   expected={title:String(override.title),description:String(override.description)};
 }else if(earth){
   expected=buildPublicationCopy({
     hook:row.hook,
     story:row.story,
     prompt:row.prompt,
     contextTerms:[],
     hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
     showName:CONFIG.identity.show_name,
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

function classifyReviewFeedback(value){
 const t=String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
 const promptSignals=[
   /dialog|speaker|habla|dice|voice|voz|linea|frase|texto/,
   /historia|story|accion|orden|beat|escena|falt|deberia|no hizo|no mostro|no dijo/,
   /personaje equivocado|wrong character|falta personaje|extra character|continuidad|canon|ubicacion|apariencia|reference/,
   /camara|duracion|tono|luz|lighting/
 ];
 if(promptSignals.some(x=>x.test(t)))return'revise_prompt';
 const stochastic=[
   /glitch|artifact|artefact|render|deform|flicker|blur|borros|pixel|frame|freeze|congel/,
   /lip sync|desincron|audio corrido|audio desfas|mano rara|brazo raro|pierna rara|extra limb|cara rara|duplicado|clon/
 ];
 if(stochastic.some(x=>x.test(t)))return'reuse_prompt';
 return'revise_prompt';
}
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
app.get('/factory/cards',(req,res)=>res.json({cards:db.prepare("SELECT * FROM factory_items WHERE status='review' ORDER BY episode LIMIT 50").all().map(card)}));
app.get('/factory/video/:id',async(req,res)=>{try{const r=db.prepare("SELECT videoPath,remoteUrl,status FROM factory_items WHERE id=?").get(req.params.id);if(!r||r.status!=='review')return res.sendStatus(404);if(r.videoPath&&fs.existsSync(r.videoPath))return stream(req,res,r.videoPath);if(isReviewStorageUri(r.remoteUrl)){const url=await signedReviewUrl(r.remoteUrl,3600);return res.redirect(302,url)}return res.sendStatus(404)}catch(e){res.status(502).json({error:'Review video storage unavailable.'})}});
app.post('/factory/:id/approve',(req,res)=>{try{let r=db.prepare('SELECT * FROM factory_items WHERE id=?').get(req.params.id);if(!r)return res.sendStatus(404);if(r.status!=='review')return res.status(409).json({error:'Already processed.'});r=ensureCopy(r);const item=publication.enqueue(r);if(r.videoPath)try{fs.rmSync(r.videoPath,{force:true})}catch{};db.prepare("UPDATE factory_items SET status='queued',stockId=?,videoPath=NULL,remoteUrl=NULL,error=NULL,updatedAt=? WHERE id=?").run(item.id,now(),r.id);ensureBacklog(db);res.json({ok:true,publication:item})}catch(e){res.status(400).json({error:e.message})}});
app.post('/factory/:id/reject',async(req,res)=>{
 let r=db.prepare('SELECT * FROM factory_items WHERE id=?').get(req.params.id);
 if(!r)return res.sendStatus(404);
 if(r.status!=='review')return res.status(409).json({error:'Already processed.'});
 const feedback=String(req.body?.feedback||'').replace(/[\u0000-\u001f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,1200);
 if(feedback.length<3)return res.status(400).json({error:'Explain briefly what went wrong before REDO.'});
 const strategy=classifyReviewFeedback(feedback),token=randomBytes(24).toString('hex'),rev=Number(r.revision||0)+1,stamp=now();
 if(isReviewStorageUri(r.remoteUrl)){try{await deleteReviewObject(r.remoteUrl)}catch{}}
 if(r.videoPath)try{fs.rmSync(r.videoPath,{force:true})}catch{}
 if(strategy==='revise_prompt'){
   db.prepare("UPDATE factory_items SET status='regen_wait',revision=?,reviewFeedback=?,retryStrategy=?,reviewRetryToken=?,reviewRetrySubmittedToken=NULL,transportPreflight=NULL,providerRunId=NULL,flowResult=NULL,videoPath=NULL,remoteUrl=NULL,reviewVideoId=NULL,reviewArchivedAt=NULL,reviewOriginalSize=NULL,reviewPreviewSize=NULL,reviewContentHash=NULL,error='Human REDO requested: replacement creative package required.',nextTry=0,updatedAt=? WHERE id=?")
     .run(rev,feedback,strategy,token,stamp,r.id);
 }else{
   db.prepare("UPDATE factory_items SET status='regen_wait',revision=?,reviewFeedback=?,retryStrategy=?,reviewRetryToken=?,reviewRetrySubmittedToken=NULL,transportPreflight=NULL,providerRunId=NULL,flowResult=NULL,videoPath=NULL,remoteUrl=NULL,reviewVideoId=NULL,reviewArchivedAt=NULL,reviewOriginalSize=NULL,reviewPreviewSize=NULL,reviewContentHash=NULL,error='Human REDO requested: reuse the same prompt for one new render.',nextTry=0,updatedAt=? WHERE id=?")
     .run(rev,feedback,strategy,token,stamp,r.id);
 }
 metaSet('flow:generationLifecycle:'+r.id,JSON.stringify({
   state:'RETRY_REQUESTED',generation_id:null,generation_started_at:null,submit_boundary_at:null,
   baseline:[],baseline_inventory:null,reviewer_retry:true,retry_token:token,retry_strategy:strategy,
   review_feedback:feedback,retry_requested_at:stamp,exactly_one_submit:true
 }));
 res.json({ok:true,regenerating:true,retryStrategy:strategy,retryToken:token});
 setTimeout(()=>{try{globalThis.__publisherRunProvider?.()}catch{}},50).unref?.();
});
app.post('/factory/enable',(req,res)=>{metaSet('automation:factoryEnabled','true');res.json({ok:true,enabled:true})});
app.post('/factory/disable',(req,res)=>{metaSet('automation:factoryEnabled','false');res.json({ok:true,enabled:false})});
app.post('/factory/preflight',(req,res)=>{metaSet('automation:allowSubmit','0');const r=db.prepare("SELECT id,episode,status FROM factory_items WHERE status IN ('draft','regen_wait') ORDER BY episode LIMIT 1").get();res.status(202).json({ok:true,next:r||null,note:'Provider will run preflight only; Generate remains disabled.'})});
app.post('/factory/test-generation',(req,res)=>{metaSet('automation:factoryEnabled','false');metaSet('automation:allowSubmit','1');res.status(202).json({ok:true,one_test_submit_authorized:true})});
app.post('/factory/run',(req,res)=>{res.status(202).json({ok:true})});

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
    const lf=liveFlowConfig(),knowledgeReady=metaGet('knowledge:flowSopLoaded','false')==='true',ready=Boolean(loadToken())&&Boolean(lf.project_id&&flowAuth()?.ok)&&Boolean(String(CONFIG.content.creative_bible||'').trim())&&knowledgeReady;
    if(!ready)return false;
    const already=metaGet('automation:factoryEnabled','false')==='true';
    if(already)return true;
    metaSet('automation:factoryEnabled','true');
    const t=now();
    if(!metaGet('automation:readinessActivatedAt',''))metaSet('automation:readinessActivatedAt',t);
    try{db.prepare("UPDATE factory_items SET nextTry=0,error=NULL,updatedAt=? WHERE status IN ('draft','regen_wait') AND providerRunId IS NULL").run(t)}catch{}
    console.log('[AUTOMATION READY] YouTube + exact Flow project + Creative Bible + canonical SOP verified. Starting autonomous production.');
    setTimeout(()=>{try{globalThis.__publisherRunProvider?.()}catch{}},450).unref?.();
    return true;
  }catch{return false}
}
function activeDailyTarget(){
 const base=Math.max(1,Number(DAILY_LIMIT||1));
 const overrideDay=String(process.env.PUBLISHER_DAILY_LIMIT_OVERRIDE_DAY||'').trim();
 const overrideCount=Math.max(base,Number(process.env.PUBLISHER_DAILY_LIMIT_OVERRIDE_COUNT||0)||0);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 return overrideDay===today&&overrideCount>base?overrideCount:base;
}
function health(){
 const counts={};for(const r of db.prepare('SELECT status,COUNT(*) n FROM factory_items GROUP BY status').all())counts[r.status]=Number(r.n);
 const p=providerStatus(),beat=p?.at?Date.parse(p.at):0,workerAlive=Boolean(beat&&Date.now()-beat<180000),today=new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),completed=Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE day=? AND status IN ('review','completed') AND COALESCE(generationKind,'automatic')<>'review_retry'").get(today)?.n||0),current=db.prepare("SELECT episode,status,error,lastProgressAt FROM factory_items WHERE status IN ('generating','draft','regen_wait') ORDER BY CASE status WHEN 'generating' THEN 0 ELSE 1 END,episode LIMIT 1").get();
 const dailyTarget=activeDailyTarget();
 const activePromptRows=db.prepare("SELECT episode,prompt FROM factory_items WHERE status IN ('draft','regen_wait') ORDER BY episode").all();
 const activeBible=String(CONFIG.content.creative_bible||'').trim();
 const emptyActivePrompts=activePromptRows.filter(x=>!String(x.prompt||'').trim()).map(x=>Number(x.episode));
 const bibleMismatchEpisodes=activeBible?activePromptRows.filter(x=>String(x.prompt||'').trim()&&!String(x.prompt||'').includes(activeBible)).map(x=>Number(x.episode)):[];
 const promptIntegrity={ok:emptyActivePrompts.length===0&&bibleMismatchEpisodes.length===0,empty_active_prompts:emptyActivePrompts.length,empty_prompt_episodes:emptyActivePrompts.slice(0,20),show_bible_mismatches:bibleMismatchEpisodes.length,show_bible_mismatch_episodes:bibleMismatchEpisodes.slice(0,20)};
 const knowledge={flow_sop_version:metaGet('knowledge:flowSopVersion',''),flow_sop_sha256:metaGet('knowledge:flowSopSha256',''),declared_sha256:metaGet('knowledge:flowSopDeclaredSha256',''),loaded:metaGet('knowledge:flowSopLoaded','false')==='true',document_count:Number(metaGet('knowledge:flowSopDocumentCount','0')||0),inherit_to_publisher:metaGet('knowledge:inheritToPublisher','false')==='true'};
 return{ok:true,at:now(),runtime_version:'publisher-runtime-v1',publisher_enabled:metaGet('automation:factoryEnabled','false')==='true',show:CONFIG.identity.show_name,scheduler_alive:true,scheduler:publication.status(),scheduler_no_end_date:true,worker_alive:workerAlive,automation_provider:'FreeBrowserProvider',generation_provider:'GoogleFlowProvider',publication_provider:'YouTubeProvider',tinyfish_required:false,tinyfish_fallback:false,knowledge,flow:(()=>{const lf=liveFlowConfig();return{configured:Boolean(lf.project_id),authenticated:Boolean(flowAuth()?.ok),project_id:lf.project_id||null,project_name:lf.project_name||null,project_url:lf.project_url||null}})(),current_job:current||null,queue:counts,completed_today:completed,daily_target:dailyTarget,remaining_today:Math.max(0,dailyTarget-completed),daily_override_active:dailyTarget!==DAILY_LIMIT,provider_health:p?.state||null,last_generation:db.prepare("SELECT createdAt FROM factory_generations ORDER BY createdAt DESC LIMIT 1").get()?.createdAt||null,last_review_ready:db.prepare("SELECT updatedAt FROM factory_items WHERE status='review' ORDER BY updatedAt DESC LIMIT 1").get()?.updatedAt||null,last_publication:db.prepare("SELECT updatedAt,status,videoId FROM publication_items ORDER BY updatedAt DESC LIMIT 1").get()||null,serial_gate:{enabled:true,creative_serialized:Boolean(CONFIG.content.serialized),gate:'review_ready',strict:true},automation_safety:{exactly_once_submit:metaGet('automation:exactlyOnceSubmit','false')==='true',strict_serial_generation:metaGet('automation:strictSerialGeneration','false')==='true',project_grid_recovery:metaGet('automation:projectGridRecovery','false')==='true',review_metadata_required:metaGet('automation:reviewMetadataRequired','false')==='true',golden_test_required:metaGet('automation:goldenTestRequired','false')==='true',prompt_show_bible_gate:true,atomic_creative_package:true},prompt_integrity:promptIntegrity,storage:storage(),security:{configured:configured(),passkeys:authState().passkeys.length,active_sessions:authState().sessions.filter(x=>x.expiresAt>Date.now()&&!x.revokedAt).length}};
}
app.get('/factory/health',(req,res)=>res.json(health()));
app.get('/factory/knowledge',(req,res)=>{
  const rows=db.prepare('SELECT key,version,sha256,source,updatedAt,length(content) bytes FROM runtime_knowledge ORDER BY key').all();
  res.json({ok:true,knowledge:health().knowledge,documents:rows});
});

async function archiveReviewOriginal(row){
 if(isReviewStorageUri(row.remoteUrl))return true;
 if(!row.videoPath||!fs.existsSync(row.videoPath))return false;
 if(!reviewStorageConfigured()){
   if(reviewStorageRequired())throw new Error('REVIEW_STORAGE_REQUIRED_NOT_CONFIGURED');
   return false;
 }
 const original=fs.statSync(row.videoPath).size;
 const cloud=await uploadReviewFile(row.videoPath,{itemId:row.id,revision:row.revision});
 db.prepare("UPDATE factory_items SET remoteUrl=?,reviewVideoId=NULL,reviewArchivedAt=?,reviewOriginalSize=?,reviewPreviewSize=NULL,reviewArchiveError=NULL,videoPath=NULL,updatedAt=? WHERE id=?")
   .run(cloud.uri,now(),cloud.size||original,now(),row.id);
 try{fs.rmSync(row.videoPath,{force:true})}catch{}
 return true;
}
let archiveBusy=false;
async function storageTick(){
 if(archiveBusy)return;archiveBusy=true;
 try{
   const rows=db.prepare("SELECT * FROM factory_items WHERE status='review' AND videoPath IS NOT NULL ORDER BY updatedAt DESC").all();
   for(const r of rows){try{await archiveReviewOriginal(r)}catch(e){db.prepare('UPDATE factory_items SET reviewArchiveError=?,updatedAt=? WHERE id=?').run(String(e.message).slice(0,600),now(),r.id)}}
 }finally{archiveBusy=false}
}
setInterval(()=>void storageTick(),5*60*1000).unref?.();setTimeout(()=>void storageTick(),30000).unref?.();

app.get('/api/status',(req,res)=>{const h=health(),youtubeConnected=Boolean(loadToken()),flowConnected=Boolean(h.flow.configured&&h.flow.authenticated),bibleConfigured=Boolean(String(CONFIG.content.creative_bible||'').trim()),ready=youtubeConnected&&flowConnected&&bibleConfigured;if(ready)activateReadyAutomation();res.json({health:health(),brand:brandPublic(),youtube:{oauthConfigured:Boolean(ytSecrets().client_id&&ytSecrets().client_secret),connected:youtubeConnected},flowBootstrap:'/flow/bootstrap',onboarding:{youtube:youtubeConnected,flow:flowConnected,bible:bibleConfigured,ready}})});
app.get('/api/show-bible',(req,res)=>res.json({creative_bible:String(CONFIG.content.creative_bible||'')}));
app.post('/api/show-bible',(req,res)=>{const bible=String(req.body?.creative_bible||'').trim().slice(0,80000);if(bible.length<20)return res.status(400).json({error:'The Show Bible needs at least 20 characters.'});CONFIG.content.creative_bible=bible;try{fs.writeFileSync(path.join(DATA_DIR,'publisher-config.json'),JSON.stringify(CONFIG,null,2),{mode:0o600});ensureBacklog(db)}catch(e){return res.status(500).json({error:'Could not save/rematerialize Show Bible packages: '+e.message})}res.json({ok:true,length:bible.length,prompts_rematerialized:true})});
app.get('/api/config/export',(req,res)=>{const c=structuredClone(CONFIG);res.set('Content-Disposition','attachment; filename="publisher-config.json"');res.type('json').send(JSON.stringify(c,null,2))});

app.get('/security',(req,res)=>res.sendFile('security.html',{root:'public'}));
app.use(express.static('public'));
app.get('/',(req,res)=>res.sendFile('index.html',{root:'public'}));

setInterval(()=>{try{activateReadyAutomation()}catch{}},30000).unref?.();
app.listen(PORT,'0.0.0.0',()=>{console.log('Publisher Runtime v1 listening',PORT);setTimeout(()=>activateReadyAutomation(),1400).unref?.()});
