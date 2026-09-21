
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

google.options({timeout:90000,retry:false});
const app=express(),PORT=Number(process.env.PORT||8080);
const DATA_DIR=path.resolve(process.env.DATA_DIR||'/data'),DIR=path.join(DATA_DIR,'publisher-runtime'),DB_PATH=path.join(DIR,'factory.sqlite');
const AUTH_PATH=path.join(DIR,'auth.json'),SECRET_PATH=path.join(DIR,'secrets.json'),YT_TOKEN_PATH=path.join(DIR,'youtube-token.json');
const SESSION_COOKIE='publisher_session',TTL=30*24*60*60*1000;
fs.mkdirSync(DIR,{recursive:true,mode:0o700});
const db=new DatabaseSync(DB_PATH,{timeout:5000});
for(const sql of [
  "ALTER TABLE factory_items ADD COLUMN reviewFeedback TEXT",
  "ALTER TABLE factory_items ADD COLUMN retryStrategy TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewRetryToken TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewRetrySubmittedToken TEXT",
  "ALTER TABLE factory_items ADD COLUMN reviewContentHash TEXT",
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
function secure(req,res,next){if(valid(req))return next();if(htmlReq(req))return res.redirect('/setup');return res.status(401).json({error:'Access required.',login:'/setup'})}

const rp=()=>String(process.env.RAILWAY_PUBLIC_DOMAIN||process.env.PUBLISHER_PUBLIC_DOMAIN||'localhost').replace(/^https?:\/\//,'').split('/')[0];
const origin=req=>String(process.env.PUBLISHER_PUBLIC_URL||(req.protocol+'://'+req.get('host'))).replace(/\/$/,'');
const regChallenges=new Map(),authChallenges=new Map();
function passkeysPublic(){return authState().passkeys.map(x=>({id:x.id,name:x.name||'Passkey',createdAt:x.createdAt,lastUsedAt:x.lastUsedAt,deviceType:x.deviceType,backedUp:Boolean(x.backedUp)}))}

app.get('/setup',(req,res)=>res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Activar Publisher</title><style>:root{--n:#0d3152;--g:#b59a64;--bg:#f7f6f2;--m:#6d6d6d}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);font-family:Arial,sans-serif;padding:24px;color:#1d1d1b}.c{width:min(470px,100%);background:#fff;border:1px solid #ded9cf;padding:30px;text-align:center}.mark{font:400 34px/.9 Georgia,serif;color:var(--n);margin-bottom:18px}.eye{font-size:11px;letter-spacing:.2em;color:var(--g);font-weight:700;margin-bottom:10px}h1{font:400 42px/.98 Georgia,serif;margin:0 0 14px}.muted{color:var(--m);line-height:1.5}.err{color:#9b4035;font-size:13px;margin-top:14px}.spin{width:26px;height:26px;border:3px solid #ddd;border-top-color:var(--n);border-radius:50%;margin:20px auto;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><main class=c><div class=mark>Publisher<br>Factory</div><div class=eye>SECURE ACTIVATION</div><h1 id=t>Opening your Publisher</h1><div id=spin class=spin></div><p id=m class=muted>Validating this device…</p><div id=e class=err></div></main><script>(async()=>{const t=document.querySelector('#t'),m=document.querySelector('#m'),e=document.querySelector('#e'),spin=document.querySelector('#spin');const raw=location.hash.startsWith('#code=')?decodeURIComponent(location.hash.slice(6)):'';if(!raw){t.textContent='Open from Publisher Factory';m.textContent='Use CONFIGURE from Publisher Factory to open this Publisher securely on this device.';spin.style.display='none';return}try{history.replaceState(null,'',location.pathname);const r=await fetch('/setup/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:raw})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Activation failed');m.textContent='Ready.';location.replace('/')}catch(x){spin.style.display='none';t.textContent='Activation failed';e.textContent=x.message}})();</script></body></html>`));
app.post('/setup/activate',(req,res)=>{const expected=String(process.env.PUBLISHER_SETUP_TOKEN||''),token=String(req.body?.token||'');if(!expected||!safeEq(token,expected))return res.status(401).json({error:'Activation link is invalid or expired.'});if(!configured())setPin(String(Math.floor(100000+Math.random()*900000)));issue(req,res,'factory-setup');res.json({ok:true})});
app.get('/login',(req,res)=>res.sendFile('login.html',{root:'public'}));
app.get('/auth/public-info',(req,res)=>{const a=authState();res.json({publisherName:CONFIG.identity.publisher_name,showName:CONFIG.identity.show_name,passkeysRegistered:a.passkeys.length})});
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

function brandPublic(){const b=CONFIG.branding||{},t=b.theme||{};return{reference_mode:b.reference_mode||null,reference_image_url:b.reference_image_url||null,logo_url:b.logo_url||null,icon_180_url:b.icon_180_url||null,icon_192_url:b.icon_192_url||null,icon_512_url:b.icon_512_url||null,maskable_icon_url:b.maskable_icon_url||b.icon_512_url||null,safe_area_ratio:Number(b.safe_area_ratio||.8),theme:{primary:t.primary||'#0d3152',secondary:t.secondary||'#b59a64',accent:t.accent||'#b59a64',background:t.background||'#f7f6f2',surface:t.surface||'#ffffff',text:t.text||'#1d1d1b'}}}
function brandRedirect(res,url,fallback){if(url)return res.redirect(302,url);res.status(200).type('image/svg+xml').send(fallback)}
function fallbackBrandSvg(){const n=String(CONFIG.identity.show_name||CONFIG.identity.publisher_name||'P').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase().slice(0,2)||'P',b=brandPublic(),t=b.theme;return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="108" fill="'+t.background+'"/><rect x="82" y="82" width="348" height="348" rx="72" fill="'+t.primary+'"/><text x="256" y="305" text-anchor="middle" font-family="Arial,sans-serif" font-size="165" font-weight="700" fill="'+(String(t.text).toLowerCase()==='#ffffff'?'#ffffff':'#ffffff')+'">'+n.replace(/[&<>]/g,'')+'</text></svg>'}
app.get('/brand/logo.svg',(req,res)=>brandRedirect(res,brandPublic().logo_url,fallbackBrandSvg()));
app.get('/apple-touch-icon.png',(req,res)=>{const b=brandPublic(),u=b.icon_180_url||b.icon_512_url;if(u)return res.redirect(302,u);res.type('image/svg+xml').send(fallbackBrandSvg())});
app.get('/manifest.webmanifest',(req,res)=>{const b=brandPublic(),icons=[];if(b.icon_192_url)icons.push({src:b.icon_192_url,sizes:'192x192',type:'image/png',purpose:'any'});if(b.icon_512_url)icons.push({src:b.icon_512_url,sizes:'512x512',type:'image/png',purpose:'any'});if(b.maskable_icon_url)icons.push({src:b.maskable_icon_url,sizes:'512x512',type:'image/png',purpose:'maskable'});if(!icons.length)icons.push({src:'/brand/logo.svg',sizes:'any',type:'image/svg+xml',purpose:'any'});res.type('application/manifest+json').send(JSON.stringify({name:CONFIG.identity.show_name||CONFIG.identity.publisher_name,short_name:CONFIG.identity.show_name||CONFIG.identity.publisher_name,start_url:'/',scope:'/',display:'standalone',background_color:b.theme.background,theme_color:b.theme.primary,icons}))});

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

app.get('/integrations/youtube',secure,(req,res)=>{const y=ytSecrets(),redirect=origin(req)+'/oauth2callback',configured=Boolean(y.client_id&&y.client_secret),connected=Boolean(loadToken()),esc=x=>String(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');res.send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f6f2"><title>Conectar YouTube</title>
<style>
:root{--navy:#0d3152;--gold:#b59a64;--ink:#1d1d1b;--muted:#6e6a63;--bg:#f7f6f2;--line:#ded9cf;--ok:#315d35;--okbg:#eef4ed}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif;padding:calc(18px + env(safe-area-inset-top)) 16px calc(34px + env(safe-area-inset-bottom));-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:auto}.back{display:inline-flex;color:var(--navy);text-decoration:none;font-weight:700;margin-bottom:20px}.eyebrow{font-size:11px;letter-spacing:.2em;color:var(--gold);font-weight:800}
h1{font:400 clamp(42px,8vw,64px)/.95 Georgia,serif;margin:10px 0 14px}.lead{font-size:17px;line-height:1.5;color:#47433d;margin:0 0 24px}
.progress{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px}.pill{padding:10px 12px;border:1px solid var(--line);background:#fff;font-size:12px;font-weight:800}.pill.ok{background:var(--okbg);border-color:#a9bea4;color:var(--ok)}
.step{background:#fff;border:1px solid var(--line);padding:20px;margin:12px 0}.step-head{display:flex;gap:12px;align-items:flex-start}.num{width:34px;height:34px;border-radius:50%;background:var(--navy);color:#fff;display:grid;place-items:center;font-weight:800;flex:0 0 auto}.step h2{font:400 27px/1.05 Georgia,serif;color:var(--navy);margin:2px 0 8px}.step p{color:var(--muted);line-height:1.5;margin:0}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:15px}.btn{min-height:46px;padding:0 15px;border:1px solid var(--gold);background:#fff;color:#725d34;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;font-weight:800;cursor:pointer}.btn.primary{background:var(--navy);border-color:var(--navy);color:#fff}.btn:active{transform:scale(.97)}
.uri{display:flex;gap:8px;margin-top:13px}.uri code{flex:1;border:1px solid var(--line);background:#faf9f6;padding:12px;word-break:break-all;font-size:12px}.copy{white-space:nowrap}
form{margin-top:14px;display:grid;gap:10px}input{width:100%;min-height:48px;padding:0 13px;border:1px solid #cfc8ba;background:#fff;font:inherit}.help{font-size:12px;color:var(--muted);margin-top:8px}.done{border-color:#a9bea4;background:var(--okbg)}.done .num{background:var(--ok)}
.final{margin-top:16px;padding:18px;border:1px solid #a9bea4;background:var(--okbg);display:${connected?'block':'none'}}.final strong{color:var(--ok);font-size:18px}
details{margin-top:12px}.tiny{font-size:12px;color:var(--muted);line-height:1.5}
@media(max-width:620px){.progress{grid-template-columns:1fr}.actions .btn{width:100%}.uri{flex-direction:column}.copy{width:100%}}
</style></head><body><main class="wrap">
<a class="back" href="/">← Volver al Publisher</a>
<div class="eyebrow">YOUTUBE · CONFIGURACIÓN GUIADA</div>
<h1>Conectemos tu canal.</h1>
<p class="lead">Lo hacés una sola vez. No necesitás entender OAuth: seguí estos pasos en orden y usá los botones.</p>
<div class="progress"><div class="pill ${configured?'ok':''}">${configured?'✓ Credenciales guardadas':'1 · Falta configurar Google'}</div><div class="pill ${connected?'ok':''}">${connected?'✓ Canal conectado':'2 · Falta conectar el canal'}</div></div>

<section class="step"><div class="step-head"><div class="num">1</div><div><h2>Activá YouTube Data API</h2><p>Primero te vamos a llevar al selector de cuentas de Google. Elegí la cuenta con la que querés configurar este Publisher —o tocá <b>Usar otra cuenta</b> para iniciar sesión—. Después elegí un proyecto o creá uno y activá <b>YouTube Data API v3</b>.</p></div></div>
<div class="actions"><a class="btn primary" target="_blank" rel="noopener" href="https://accounts.google.com/AccountChooser?hl=es&continue=https%3A%2F%2Fconsole.cloud.google.com%2Fapis%2Flibrary%2Fyoutube.googleapis.com">ELEGIR CUENTA Y ABRIR YOUTUBE DATA API</a></div></section>

<section class="step"><div class="step-head"><div class="num">2</div><div><h2>Creá una credencial OAuth</h2><p>Al tocar el botón vas a volver a pasar por el selector de cuentas de Google para evitar entrar automáticamente con otra cuenta. Elegí la misma cuenta que usaste en el paso 1. Después tocá <b>Crear credenciales → ID de cliente OAuth</b> y elegí <b>Aplicación web</b>. Si Google te pide configurar primero la pantalla de consentimiento, completá lo básico y volvé a Credenciales.</p></div></div>
<div class="actions"><a class="btn primary" target="_blank" rel="noopener" href="https://accounts.google.com/AccountChooser?hl=es&continue=https%3A%2F%2Fconsole.cloud.google.com%2Fapis%2Fcredentials">ELEGIR CUENTA Y ABRIR CREDENCIALES</a><a class="btn" target="_blank" rel="noopener" href="https://accounts.google.com/AccountChooser?hl=es&continue=https%3A%2F%2Fconsole.cloud.google.com%2Fauth%2Foverview">ELEGIR CUENTA Y ABRIR OAUTH</a></div></section>

<section class="step"><div class="step-head"><div class="num">3</div><div><h2>Pegá esta URL en “URI de redireccionamiento autorizado”</h2><p>Google necesita volver exactamente a este Publisher después de que autorices el canal.</p></div></div>
<div class="uri"><code id="redirect">${esc(redirect)}</code><button class="btn copy" type="button" id="copy">COPIAR URL</button></div>
<p class="help">En Google Cloud buscá “URI de redireccionamiento autorizados”, tocá <b>Agregar URI</b>, pegá esta dirección y guardá.</p></section>

<section class="step ${configured?'done':''}"><div class="step-head"><div class="num">4</div><div><h2>Pegá aquí el Client ID y el Client Secret</h2><p>Después de crear la credencial, Google te muestra ambos valores. Copialos y pegálos abajo.</p></div></div>
<form method="post" action="/integrations/youtube">
<input name="client_id" autocomplete="off" placeholder="Client ID" value="${esc(y.client_id||'')}">
<input name="client_secret" type="password" autocomplete="new-password" placeholder="${configured?'Client Secret (pegalo de nuevo solo si querés cambiarlo)':'Client Secret'}">
<button class="btn primary" type="submit">GUARDAR CONFIGURACIÓN</button>
</form></section>

<section class="step ${connected?'done':''}"><div class="step-head"><div class="num">5</div><div><h2>Conectá el canal</h2><p>${configured?'Ahora sí: tocá el botón, elegí la cuenta de Google del canal y aceptá los permisos.':'Primero completá el paso 4.'}</p></div></div>
<div class="actions"><a class="btn primary" href="/auth/google" ${configured?'':'style="pointer-events:none;opacity:.45"'}>CONECTAR MI CANAL DE YOUTUBE</a></div></section>

<div class="final"><strong>✓ YouTube ya está conectado.</strong><p class="tiny">Podés volver al Publisher. Esta conexión queda guardada en este runtime.</p><a class="btn primary" href="/">VOLVER AL PUBLISHER</a></div>
<details><summary>¿Qué estoy haciendo exactamente?</summary><p class="tiny">Publisher usa OAuth 2.0 para subir y administrar videos en el canal que autorices. La contraseña de Google nunca se guarda en Publisher. Google solo entrega tokens de acceso después de que vos aceptás los permisos.</p></details>
</main>
<script>
const copy=document.getElementById('copy');copy.onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('redirect').textContent);copy.textContent='COPIADO ✓';setTimeout(()=>copy.textContent='COPIAR URL',1600)}catch{const r=document.createRange();r.selectNodeContents(document.getElementById('redirect'));getSelection().removeAllRanges();getSelection().addRange(r)}};
</script></body></html>`)});
app.post('/integrations/youtube',secure,(req,res)=>{const client_id=String(req.body.client_id||'').trim(),client_secret=String(req.body.client_secret||'').trim();if(!client_id||!client_secret)return res.status(400).send('Client ID and secret required.');saveYtSecrets({client_id,client_secret,redirect_uri:origin(req)+'/oauth2callback'});res.redirect('/integrations/youtube')});
app.get('/auth/google',secure,(req,res)=>{try{const state=randomBytes(24).toString('base64url'),y=ytSecrets();saveYtSecrets({oauth_state:state,oauth_state_exp:Date.now()+15*60*1000,redirect_uri:origin(req)+'/oauth2callback'});const c=oauthClient(),url=c.generateAuthUrl({access_type:'offline',prompt:'consent',state,scope:['https://www.googleapis.com/auth/youtube','https://www.googleapis.com/auth/youtube.upload']});res.redirect(url)}catch(e){res.status(400).send(e.message)}});
app.get('/oauth2callback',async(req,res)=>{try{const y=ytSecrets();if(!req.query.code||!safeEq(String(req.query.state||''),String(y.oauth_state||''))||Number(y.oauth_state_exp||0)<Date.now())throw new Error('OAuth state invalid or expired.');const c=oauthClient(),{tokens}=await c.getToken(String(req.query.code));saveToken(tokens);saveYtSecrets({oauth_state:null,oauth_state_exp:0});res.redirect('/integrations/youtube')}catch(e){res.status(400).send('YouTube OAuth failed: '+e.message)}});

function stream(req,res,file){const st=fs.statSync(file),range=req.headers.range;res.set('Accept-Ranges','bytes');res.set('Content-Type','video/mp4');res.set('Cache-Control','private,no-store');if(!range){res.set('Content-Length',String(st.size));return fs.createReadStream(file).pipe(res)}const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m)return res.sendStatus(416);const a=m[1]?Number(m[1]):0,b=m[2]?Number(m[2]):st.size-1;if(a<0||b<a||b>=st.size)return res.sendStatus(416);res.status(206).set('Content-Range','bytes '+a+'-'+b+'/'+st.size).set('Content-Length',String(b-a+1));fs.createReadStream(file,{start:a,end:b}).pipe(res)}
function ensureCopy(row){
 const provider=(CONFIG.publication.providers||[]).find(x=>x.type==='youtube')||{};
 const copy=buildPublicationCopy({
   hook:row.hook,
   story:row.story,
   hashtags:Array.isArray(provider.hashtags)?provider.hashtags:[],
   showName:CONFIG.identity.show_name,
   maxTitleLength:100
 });
 let description=copy.description;
 while(Buffer.byteLength(description,'utf8')>4800)description=description.slice(0,-30).trimEnd();
 if(row.title!==copy.title||row.description!==description){
   db.prepare('UPDATE factory_items SET title=?,description=?,updatedAt=? WHERE id=?').run(copy.title,description,now(),row.id);
 }
 return{...row,title:copy.title,description};
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
function card(row){row=ensureCopy(row);return{id:row.id,episode:row.episode,hook:row.hook,story:row.story,title:row.title,description:row.description,status:row.status,videoUrl:row.status==='review'&&row.videoPath?'/factory/video/'+encodeURIComponent(row.id):null,archivedOriginal:Boolean(row.reviewVideoId),updatedAt:row.updatedAt,error:row.error}}
app.get('/factory/cards',(req,res)=>res.json({cards:db.prepare("SELECT * FROM factory_items WHERE status='review' ORDER BY episode LIMIT 50").all().map(card)}));
app.get('/factory/video/:id',(req,res)=>{const r=db.prepare("SELECT videoPath,status FROM factory_items WHERE id=?").get(req.params.id);if(!r||r.status!=='review'||!r.videoPath||!fs.existsSync(r.videoPath))return res.sendStatus(404);stream(req,res,r.videoPath)});
app.post('/factory/:id/approve',(req,res)=>{try{let r=db.prepare('SELECT * FROM factory_items WHERE id=?').get(req.params.id);if(!r)return res.sendStatus(404);if(r.status!=='review')return res.status(409).json({error:'Already processed.'});r=ensureCopy(r);const item=publication.enqueue(r);if(r.videoPath)try{fs.rmSync(r.videoPath,{force:true})}catch{};db.prepare("UPDATE factory_items SET status='queued',stockId=?,videoPath=NULL,error=NULL,updatedAt=? WHERE id=?").run(item.id,now(),r.id);ensureBacklog(db);res.json({ok:true,publication:item})}catch(e){res.status(400).json({error:e.message})}});
app.post('/factory/:id/reject',async(req,res)=>{
 let r=db.prepare('SELECT * FROM factory_items WHERE id=?').get(req.params.id);
 if(!r)return res.sendStatus(404);
 if(r.status!=='review')return res.status(409).json({error:'Already processed.'});
 const feedback=String(req.body?.feedback||'').replace(/[\u0000-\u001f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,1200);
 if(feedback.length<3)return res.status(400).json({error:'Explain briefly what went wrong before REDO.'});
 const strategy=classifyReviewFeedback(feedback),token=randomBytes(24).toString('hex'),rev=Number(r.revision||0)+1,stamp=now();
 if(r.reviewVideoId&&loadToken()){try{await youtubeApi().videos.delete({id:r.reviewVideoId})}catch{}}
 if(r.videoPath)try{fs.rmSync(r.videoPath,{force:true})}catch{}
 if(strategy==='revise_prompt'){
   db.prepare("UPDATE factory_items SET status='regen_wait',revision=?,reviewFeedback=?,retryStrategy=?,reviewRetryToken=?,reviewRetrySubmittedToken=NULL,prompt='',promptHash=NULL,promptGenerationId=NULL,promptPayloadHash=NULL,promptPayloadLength=NULL,transportPreflight=NULL,providerRunId=NULL,flowResult=NULL,videoPath=NULL,reviewVideoId=NULL,reviewArchivedAt=NULL,reviewOriginalSize=NULL,reviewPreviewSize=NULL,reviewContentHash=NULL,error='Human REDO requested: prompt correction required.',nextTry=0,updatedAt=? WHERE id=?")
     .run(rev,feedback,strategy,token,stamp,r.id);
 }else{
   db.prepare("UPDATE factory_items SET status='regen_wait',revision=?,reviewFeedback=?,retryStrategy=?,reviewRetryToken=?,reviewRetrySubmittedToken=NULL,transportPreflight=NULL,providerRunId=NULL,flowResult=NULL,videoPath=NULL,reviewVideoId=NULL,reviewArchivedAt=NULL,reviewOriginalSize=NULL,reviewPreviewSize=NULL,reviewContentHash=NULL,error='Human REDO requested: reuse the same prompt for one new render.',nextTry=0,updatedAt=? WHERE id=?")
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
function metaGet(k,f=''){return db.prepare('SELECT value FROM factory_meta WHERE key=?').get(k)?.value??f}
function metaSet(k,v){db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,String(v))}
function health(){
 const counts={};for(const r of db.prepare('SELECT status,COUNT(*) n FROM factory_items GROUP BY status').all())counts[r.status]=Number(r.n);
 const p=providerStatus(),beat=p?.at?Date.parse(p.at):0,workerAlive=Boolean(beat&&Date.now()-beat<180000),today=new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),completed=Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE day=? AND status IN ('review','completed') AND COALESCE(generationKind,'automatic')<>'review_retry'").get(today)?.n||0),current=db.prepare("SELECT episode,status,error,lastProgressAt FROM factory_items WHERE status IN ('generating','draft','regen_wait') ORDER BY CASE status WHEN 'generating' THEN 0 ELSE 1 END,episode LIMIT 1").get();
 return{ok:true,at:now(),runtime_version:'publisher-runtime-v1',publisher_enabled:metaGet('automation:factoryEnabled','false')==='true',show:CONFIG.identity.show_name,scheduler_alive:true,scheduler:publication.status(),scheduler_no_end_date:true,worker_alive:workerAlive,automation_provider:'FreeBrowserProvider',generation_provider:'GoogleFlowProvider',publication_provider:'YouTubeProvider',tinyfish_required:false,tinyfish_fallback:false,flow:{configured:Boolean(PROJECT_ID),authenticated:Boolean(flowAuth()?.ok),project_id:PROJECT_ID||null,project_name:PROJECT_NAME||null,project_url:PROJECT_URL||null},current_job:current||null,queue:counts,completed_today:completed,daily_target:DAILY_LIMIT,remaining_today:Math.max(0,DAILY_LIMIT-completed),provider_health:p?.state||null,last_generation:db.prepare("SELECT createdAt FROM factory_generations ORDER BY createdAt DESC LIMIT 1").get()?.createdAt||null,last_review_ready:db.prepare("SELECT updatedAt FROM factory_items WHERE status='review' ORDER BY updatedAt DESC LIMIT 1").get()?.updatedAt||null,last_publication:db.prepare("SELECT updatedAt,status,videoId FROM publication_items ORDER BY updatedAt DESC LIMIT 1").get()||null,serial_gate:{enabled:Boolean(CONFIG.content.serialized),gate:CONFIG.content.continuity_gate},storage:storage(),security:{configured:configured(),passkeys:authState().passkeys.length,active_sessions:authState().sessions.filter(x=>x.expiresAt>Date.now()&&!x.revokedAt).length}};
}
app.get('/factory/health',(req,res)=>res.json(health()));

async function archiveReviewOriginal(row){
 if(!loadToken()||row.reviewVideoId||!row.videoPath||!fs.existsSync(row.videoPath))return false;
 const yt=youtubeApi(),m=ensureCopy(row),out=await yt.videos.insert({part:['snippet','status'],requestBody:{snippet:{title:('[REVIEW] E'+row.episode+' '+m.hook).slice(0,100),description:'Private Publisher Runtime review staging.',categoryId:'24',tags:['publisher-review-'+row.id]},status:{privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true}},media:{mimeType:'video/mp4',body:fs.createReadStream(row.videoPath)}}),videoId=String(out.data?.id||'');if(!videoId)throw new Error('Private staging upload failed.');
 const original=fs.statSync(row.videoPath).size,tmp=row.videoPath+'.preview.mp4',ff=spawnSync('ffmpeg',['-y','-i',row.videoPath,'-vf','scale=540:-2','-c:v','libx264','-preset','veryfast','-crf','31','-c:a','aac','-b:a','64k','-movflags','+faststart',tmp],{timeout:180000,encoding:'utf8'});
 if(ff.status===0&&fs.existsSync(tmp)&&fs.statSync(tmp).size<original*.85){fs.renameSync(tmp,row.videoPath)}else try{fs.rmSync(tmp,{force:true})}catch{}
 const preview=fs.existsSync(row.videoPath)?fs.statSync(row.videoPath).size:0;db.prepare("UPDATE factory_items SET reviewVideoId=?,reviewArchivedAt=?,reviewOriginalSize=?,reviewPreviewSize=?,reviewArchiveError=NULL,updatedAt=? WHERE id=?").run(videoId,now(),original,preview,now(),row.id);return true;
}
let archiveBusy=false;
async function storageTick(){if(archiveBusy)return;archiveBusy=true;try{const rows=db.prepare("SELECT * FROM factory_items WHERE status='review' AND videoPath IS NOT NULL ORDER BY updatedAt DESC").all(),st=storage(),aggressive=st?.free_percent!=null&&st.free_percent<Number(CONFIG.review.archive_below_free_percent||45);for(let i=0;i<rows.length;i++){const r=rows[i];if(!r.reviewVideoId&&(aggressive||i>=Number(CONFIG.review.hot_originals||2))){try{await archiveReviewOriginal(r)}catch(e){db.prepare('UPDATE factory_items SET reviewArchiveError=?,updatedAt=? WHERE id=?').run(String(e.message).slice(0,600),now(),r.id)}}}}finally{archiveBusy=false}}
setInterval(()=>void storageTick(),5*60*1000).unref?.();setTimeout(()=>void storageTick(),30000).unref?.();

app.get('/api/status',(req,res)=>{const h=health(),youtubeConnected=Boolean(loadToken()),flowConnected=Boolean(h.flow.configured&&h.flow.authenticated),bibleConfigured=Boolean(String(CONFIG.content.creative_bible||'').trim()),ready=youtubeConnected&&flowConnected&&bibleConfigured;if(ready&&metaGet('automation:factoryEnabled','false')!=='true')metaSet('automation:factoryEnabled','true');res.json({health:h,brand:brandPublic(),youtube:{oauthConfigured:Boolean(ytSecrets().client_id&&ytSecrets().client_secret),connected:youtubeConnected},flowBootstrap:'/flow/bootstrap',onboarding:{youtube:youtubeConnected,flow:flowConnected,bible:bibleConfigured,ready}})});
app.get('/api/show-bible',(req,res)=>res.json({creative_bible:String(CONFIG.content.creative_bible||'')}));
app.post('/api/show-bible',(req,res)=>{const bible=String(req.body?.creative_bible||'').trim().slice(0,80000);if(bible.length<20)return res.status(400).json({error:'The Show Bible needs at least 20 characters.'});CONFIG.content.creative_bible=bible;try{fs.writeFileSync(path.join(DATA_DIR,'publisher-config.json'),JSON.stringify(CONFIG,null,2),{mode:0o600})}catch(e){return res.status(500).json({error:'Could not save Show Bible: '+e.message})}res.json({ok:true,length:bible.length})});
app.get('/api/config/export',(req,res)=>{const c=structuredClone(CONFIG);res.set('Content-Disposition','attachment; filename="publisher-config.json"');res.type('json').send(JSON.stringify(c,null,2))});

app.get('/security',(req,res)=>res.sendFile('security.html',{root:'public'}));
app.use(express.static('public'));
app.get('/',(req,res)=>res.sendFile('index.html',{root:'public'}));

app.listen(PORT,'0.0.0.0',()=>console.log('Publisher Runtime v1 listening',PORT));
