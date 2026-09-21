import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import {
  CONFIG, SHOW, PROJECT_ID, PROJECT_URL, PROJECT_NAME,
  DURATION_SECONDS, DURATION_LABEL, ASPECT_RATIO, OUTPUT_COUNT, OUTPUT_LABEL,
  MODEL_INTENT, RESOLUTION_INTENT, DAILY_LIMIT, CREDIT_PER_GENERATION,
  DAILY_CREDIT_BUDGET, TIMEZONE, registry as configRegistry,
  resolveVisualCharacters, buildPrompt, seedInitial, ensureBacklog
} from './runtime-config.js';

const FLOW_URL=PROJECT_URL;
const CHROMIUM_PATH=String(process.env.CHROMIUM_PATH||'/usr/bin/chromium');
const DATA_DIR=path.resolve(process.env.DATA_DIR||(process.env.RAILWAY_ENVIRONMENT?'/data':'./data'));
const FACTORY_DIR=path.join(DATA_DIR,'publisher-runtime');
const DB_PATH=path.join(FACTORY_DIR,'factory.sqlite');
const VIDEO_DIR=path.join(FACTORY_DIR,'generated');
const PROFILE_DIR=path.join(FACTORY_DIR,'flow-profile');
const MIGRATION_OK=path.join(FACTORY_DIR,'free-browser-profile-ready.json');
const MIGRATION_ATTEMPT=path.join(FACTORY_DIR,'free-browser-profile-attempt.json');
const LOCK_FILE=path.join(FACTORY_DIR,'free-browser-provider.lock');
const BOOTSTRAP_LOCK=path.join(FACTORY_DIR,'flow-auth-bootstrap.active.json');
const STATUS_FILE=path.resolve(process.cwd(),'public','free-browser-status.json');
const PROVIDER='FreeBrowserProvider';
const INSTANCE_ID=randomUUID();
const DAILY_PRODUCTION_LIMIT=DAILY_LIMIT;
const CREDITS_PER_GENERATION=CREDIT_PER_GENERATION;
const DAILY_FLOW_CREDIT_BUDGET=DAILY_CREDIT_BUDGET;
const PRODUCTION_START_EPISODE=1;
const escapeRe=v=>String(v??'').replace(/[.*+?^$()|[\]\\]/g,'\\$&');
function projectPath(){if(!PROJECT_ID)throw new Error('FLOW_PROJECT_NOT_CONFIGURED');return'/project/'+PROJECT_ID}
function modelMatches(v){const text=String(v||'');if(!MODEL_INTENT)return true;if(new RegExp(escapeRe(MODEL_INTENT),'i').test(text))return true;if(/omni/i.test(MODEL_INTENT)&&/omni/i.test(text)){if(/flash/i.test(MODEL_INTENT))return/flash/i.test(text);return true}return false}
const AFTER_GENERATE = new Set(['GENERATION_STARTED','RETRIEVING','RETRIEVAL_PENDING','RETRIEVED','REVIEW_READY']);
const AMBIGUOUS = new Set(['SUBMIT_BOUNDARY_ENTERED','SUBMIT_AMBIGUOUS']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = v => createHash('sha256').update(String(v), 'utf8').digest('hex');
const compact = (v, n=700) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const json = (v, f=null) => { try { return JSON.parse(String(v ?? '')); } catch { return f; } };
const now = () => new Date().toISOString();
const artDay = (d=new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
function dailyGenerationCount(db, day=artDay()) {
  return Number(db.prepare("SELECT COUNT(*) n FROM factory_generations WHERE day=? AND credits>0 AND COALESCE(generationKind,'automatic')<>'review_retry'").get(day)?.n||0);
}
function reconcileGenerationCreditAccounting(db){
  try{
    db.prepare("UPDATE factory_generations SET credits=? WHERE credits>0 AND (runId='manual-flow-demo' OR runId LIKE 'free-%') AND credits<>?").run(CREDITS_PER_GENERATION,CREDITS_PER_GENERATION);
  }catch{}
}
function ensureProductionPlan(db){
  seedInitial(db);ensureBacklog(db);setMeta(db,'automation:productionPlanVersion','publisher-runtime-v1');if(!meta(db,'automation:factoryEnabled',''))setMeta(db,'automation:factoryEnabled',String(process.env.PUBLISHER_ENABLED||'false').toLowerCase()==='true'?'true':'false');setMeta(db,'automation:freeFactoryEnabled','1');if(!meta(db,'flow:state',''))setMeta(db,'flow:state','CONECTADO');setMeta(db,'flow:message','Publisher Runtime v1 active; daily target '+DAILY_PRODUCTION_LIMIT+'.');
}
function dbOpen() { return new DatabaseSync(DB_PATH, { timeout:5000 }); }
function meta(db, key, fallback='') { return db.prepare('SELECT value FROM factory_meta WHERE key=?').get(key)?.value ?? fallback; }
function setMeta(db, key, value) { db.prepare("INSERT INTO factory_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value)); }
function lifecycle(db, row) { return json(meta(db, `flow:generationLifecycle:${row.id}`, ''), null); }
function setLifecycle(db, row, state, extra={}) {
  const previous = lifecycle(db,row) || {};
  const progressAt=now();
  const value = { ...previous, state, provider:PROVIDER, updated_at:progressAt, ...extra };
  setMeta(db, `flow:generationLifecycle:${row.id}`, JSON.stringify(value));
  try{db.prepare('UPDATE factory_items SET lastProgressAt=?,updatedAt=? WHERE id=?').run(progressAt,progressAt,row.id);}catch{}
  setMeta(db, 'flow:currentStep', state.toLowerCase());
  setMeta(db, 'flow:state', state === 'REVIEW_READY' ? 'CONECTADO' : 'GENERANDO');
  setMeta(db, 'flow:message', `${row.season}x${row.episode} ${state} vía ${PROVIDER}.`);
  return value;
}
function publish(state, extra={}) {
  const payload = { state, at:now(), provider:PROVIDER, tinyfish_required:false, ...extra };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(payload, null, 2), { encoding:'utf8', mode:0o644 }); } catch {}
  console.log('[FREE BROWSER]', state, extra?.message || '');
}
function pidAlive(pid){
  const n=Number(pid);
  if(!Number.isInteger(n)||n<=0)return false;
  try{process.kill(n,0);return true;}catch{return false;}
}
function bootstrapOwnsProfile() {
  try {
    if (!fs.existsSync(BOOTSTRAP_LOCK)) return false;
    const raw=json(fs.readFileSync(BOOTSTRAP_LOCK,'utf8'),{});
    const age = Date.now() - fs.statSync(BOOTSTRAP_LOCK).mtimeMs;
    if (!pidAlive(raw?.pid) || age > 2*60*60*1000) { try { fs.unlinkSync(BOOTSTRAP_LOCK); } catch {} return false; }
    const lockedProfile=String(raw?.profile_dir||'').trim();
    // Old bootstrap locks belong to /browser-profile, while the production
    // provider now uses /gflow-cli/profile_fruttidrama. Only block on the same profile.
    if(!lockedProfile) return false;
    return path.resolve(lockedProfile)===path.resolve(PROFILE_DIR);
  } catch { return false; }
}
function acquireLock() {
  try {
    if (bootstrapOwnsProfile()) return false;
    if (fs.existsSync(LOCK_FILE)){
      let stale=false;
      try{
        const raw=json(fs.readFileSync(LOCK_FILE,'utf8'),{});
        const age=Date.now()-fs.statSync(LOCK_FILE).mtimeMs;
        stale=String(raw?.instance_id||'')!==INSTANCE_ID||!pidAlive(raw?.pid)||age>30*60*1000;
      }catch{stale=true;}
      if(stale)try{fs.unlinkSync(LOCK_FILE);}catch{}
    }
    const fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid:process.pid, instance_id:INSTANCE_ID, at:now() })); fs.closeSync(fd); return true;
  } catch { return false; }
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch {} }
function registry(){return configRegistry();}
function ensureSchema(db) {
  for (const sql of [
    `ALTER TABLE factory_items ADD COLUMN promptGenerationId TEXT`,
    `ALTER TABLE factory_items ADD COLUMN characterRoles TEXT`,
    `ALTER TABLE factory_items ADD COLUMN promptPayloadHash TEXT`,
    `ALTER TABLE factory_items ADD COLUMN promptPayloadLength INTEGER`,
    `ALTER TABLE factory_items ADD COLUMN transportPreflight TEXT`,
    `ALTER TABLE factory_items ADD COLUMN runtimeAttemptCount INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE factory_items ADD COLUMN lastProgressAt TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewFeedback TEXT`,
    `ALTER TABLE factory_items ADD COLUMN retryStrategy TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewRetryToken TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewRetrySubmittedToken TEXT`,
    `ALTER TABLE factory_items ADD COLUMN reviewContentHash TEXT`,
    `ALTER TABLE factory_generations ADD COLUMN generationKind TEXT NOT NULL DEFAULT 'automatic'`
  ]) { try { db.exec(sql); } catch {} }
}
function checkpoint(row){
  const prompt=String(row?.prompt||'');if(prompt.length<400)return null;const hash=sha(prompt);if(String(row.promptHash||'')!==hash)return null;if(String(row.promptPayloadHash||hash)!==hash)return null;if(Number(row.promptPayloadLength||Buffer.byteLength(prompt,'utf8'))!==Buffer.byteLength(prompt,'utf8'))return null;
  const roles=json(row.characterRoles,[]),visual=Array.isArray(roles)?roles.filter(r=>r?.visual===true&&r?.role==='ON_SCREEN').map(r=>String(r.name||'').trim()).filter(Boolean):[];if(visual.length>3)return null;return{prompt,hash,visual,bytes:Buffer.byteLength(prompt,'utf8'),first:prompt.slice(0,180),last:prompt.slice(-180)};
}
function matchingCharacters(row){return resolveVisualCharacters(row);}
function previousContinuity(db,row){if(!CONFIG.content.serialized)return'Independent episode.';const prev=db.prepare('SELECT hook,story,status FROM factory_items WHERE episode<? ORDER BY episode DESC LIMIT 1').get(Number(row.episode));return prev?('Previous canonical beat: '+prev.hook+' — '+prev.story):(CONFIG.content.canon||'Start from the configured Creative Bible.');}
function buildLocalPrompt(db,row,visual){return buildPrompt(db,row,visual);}
function preparePromptIfNeeded(db,row){
  let cp=checkpoint(row);if(cp)return cp;const visual=matchingCharacters(row),prompt=buildLocalPrompt(db,row,visual),hash=sha(prompt),r=registry(),roles=visual.map(name=>({name,role:'ON_SCREEN',visual:true})),handles=visual.map(name=>r.characters.find(c=>String(c.name)===String(name))?.mention||('@'+name));
  db.prepare("UPDATE factory_items SET prompt=?,promptHash=?,promptGenerationId=?,characterHandles=?,characterRoles=?,promptPayloadHash=?,promptPayloadLength=?,status='draft',providerRunId=NULL,error=NULL,nextTry=0,updatedAt=? WHERE id=?").run(prompt,hash,'runtime-prompt-v1-'+randomUUID(),JSON.stringify(handles),JSON.stringify(roles),hash,Buffer.byteLength(prompt,'utf8'),now(),row.id);
  cp=checkpoint(db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id));if(!cp)throw new Error('RUNTIME_PROMPT_CHECKPOINT_FAILED');return cp;
}
async function getBody(page) { return await page.locator('body').innerText().catch(()=> ''); }

async function promptEditor(page) {
  // Flow exposes another visible input named "Editable text" that is not the
  // generation composer. Prefer the contenteditable closest to Start generation.
  const content=page.locator('[contenteditable="true"]');
  let best=null,bestScore=-Infinity;
  const send=page.getByRole('button',{name:/Start generation/i}).last();
  const sendBox=await send.boundingBox().catch(()=>null);
  for(let i=0;i<await content.count();i++){
    const c=content.nth(i);
    if(!(await c.isVisible().catch(()=>false)))continue;
    const box=await c.boundingBox().catch(()=>null);
    if(!box)continue;
    const area=box.width*box.height;
    const dy=sendBox?Math.abs((box.y+box.height/2)-(sendBox.y+sendBox.height/2)):0;
    const score=area-dy*1000;
    if(score>bestScore){bestScore=score;best=c;}
  }
  if(best)return best;
  const old=page.getByPlaceholder('What do you want to create?').last();
  if(await old.count().catch(()=>0)&&await old.isVisible().catch(()=>false))return old;
  throw new Error('FLOW_PROMPT_EDITOR_NOT_FOUND');
}


async function classifyPromptTarget(page,editor){
  const box=await editor.boundingBox().catch(()=>null);
  const send=page.getByRole('button',{name:/Start generation/i}).last();
  const sendBox=await send.boundingBox().catch(()=>null);
  if(!box||!sendBox)return'OTHER';
  const dy=Math.abs((box.y+box.height/2)-(sendBox.y+sendBox.height/2));
  if(box.y<140||dy>220)return'OTHER';
  return'VIDEO_PROMPT_COMPOSER';
}
async function ensureCanonicalProjectTitle(page){
  if(!String(page.url()||'').includes(projectPath()))throw new Error('WRONG_FLOW_PROJECT');const inputs=page.locator('input[aria-label="Editable text"]');let titleInput=null,current='';
  for(let i=0;i<await inputs.count().catch(()=>0);i++){const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const b=await el.boundingBox().catch(()=>null);if(!b||b.y>100)continue;titleInput=el;current=String(await el.inputValue().catch(()=>''));break}if(!titleInput)throw new Error('PROJECT_TITLE_CONTROL_NOT_FOUND');if(current.trim()===PROJECT_NAME)return{repaired:false,previous:PROJECT_NAME};
  const corrupt=current.length>180||/PRODUCTION PROMPT|GENERATION PROMPT|VIDEO FACTORY|PUBLISHER RUNTIME|DURATION \/ FORMAT|ANTI-GLITCH/i.test(current);if(!corrupt)throw new Error('PROJECT_TITLE_UNEXPECTED_VALUE:'+compact(current,120));const previous=compact(current,180);await titleInput.fill(PROJECT_NAME);await titleInput.press('Enter').catch(()=>{});await page.keyboard.press('Tab').catch(()=>{});
  const deadline=Date.now()+7000;while(Date.now()<deadline){const value=String(await titleInput.inputValue().catch(()=>''));if(value.trim()===PROJECT_NAME){publish('PROJECT_TITLE_REPAIRED',{message:'Flow project title restored to configured publisher project.'});return{repaired:true,previous}}await sleep(250)}throw new Error('PROJECT_TITLE_REPAIR_NOT_CONFIRMED');
}
async function projectTitleDiagnostic(page){
  try{const rows=await page.evaluate(()=>{const out=[];for(const el of document.querySelectorAll('input,textarea,[contenteditable="true"],button,[role="button"],[role="textbox"],h1,h2,[aria-label]')){const r=el.getBoundingClientRect();if(r.width<4||r.height<4||r.y<0||r.y>220)continue;const text=String((typeof el.value==='string'&&el.value)||el.innerText||el.textContent||'').replace(/\s+/g,' ').trim(),aria=String(el.getAttribute('aria-label')||'').trim(),title=String(el.getAttribute('title')||'').trim();if(!text&&!aria&&!title)continue;out.push({tag:el.tagName.toLowerCase(),text:text.slice(0,180),aria:aria.slice(0,120),title:title.slice(0,120),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});if(out.length>=60)break}return out});const diag={at:now(),document_title:compact(await page.title().catch(()=>''),260),url:compact(page.url(),220),candidates:rows};try{fs.writeFileSync(path.join(FACTORY_DIR,'flow-project-title-diagnostic.json'),JSON.stringify(diag,null,2),{mode:0o600})}catch{}publish('PROJECT_TITLE_REPAIR_REQUIRED',{message:'Configured Flow project title could not be verified.',evidence:JSON.stringify(rows.slice(0,8)).slice(0,900)});return diag}catch{return null}
}
async function repairProjectTitleIfContaminated(page){
  if(!String(page.url()||'').includes(projectPath()))throw new Error('WRONG_FLOW_PROJECT');const more=page.getByRole('button',{name:/More options for the project/i}).last();if(!(await more.count().catch(()=>0))||!(await more.isVisible().catch(()=>false)))throw new Error('PROJECT_TITLE_CONTEXT_NOT_FOUND');
  const inputs=page.locator('input[aria-label="Editable text"]');let titleInput=null;for(let i=0;i<await inputs.count().catch(()=>0);i++){const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const b=await el.boundingBox().catch(()=>null);if(!b||b.y>100||b.x>240||b.width>320)continue;titleInput=el;break}if(!titleInput)throw new Error('PROJECT_TITLE_INPUT_NOT_FOUND');
  const current=String(await titleInput.inputValue().catch(()=>'')).replace(/\s+/g,' ').trim();if(current===PROJECT_NAME)return{repaired:false,before:current,after:PROJECT_NAME};const contaminated=current.length>180||/PRODUCTION PROMPT|GENERATION PROMPT|VIDEO FACTORY|PUBLISHER RUNTIME|DURATION \/ FORMAT|ANTI-GLITCH/i.test(current);if(!contaminated)throw new Error('PROJECT_TITLE_UNEXPECTED_VALUE:'+compact(current,120));
  await titleInput.fill(PROJECT_NAME);await titleInput.press('Enter').catch(()=>{});await page.keyboard.press('Tab').catch(()=>{});await sleep(1000);const after=String(await titleInput.inputValue().catch(()=>'')).replace(/\s+/g,' ').trim();if(after!==PROJECT_NAME)throw new Error('PROJECT_TITLE_REPAIR_NOT_PERSISTED:'+compact(after,120));publish('PROJECT_TITLE_REPAIRED',{message:'Configured Flow project title restored; no generation submitted.'});return{repaired:true,before:compact(current,180),after};
}
async function verifyProjectIdentity(page,payload=''){
  if(!PROJECT_ID||!String(page.url()||'').includes(projectPath()))throw new Error('WRONG_FLOW_PROJECT');const inputs=page.locator('input[aria-label="Editable text"]');let titleInput=null,titleValue='';
  for(let i=0;i<await inputs.count().catch(()=>0);i++){const el=inputs.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;const b=await el.boundingBox().catch(()=>null);if(!b||b.y>100)continue;titleInput=el;titleValue=String(await el.inputValue().catch(()=>'')).trim();break}
  if(!titleInput)throw new Error('PROJECT_TITLE_CONTROL_NOT_FOUND');const prefix=compact(payload,120);if(titleValue!==PROJECT_NAME)throw new Error('PROJECT_TITLE_NOT_CONFIGURED:'+compact(titleValue,120));if(prefix&&titleValue.includes(prefix))throw new Error('PROJECT_TITLE_CONTAMINATED_WITH_PROMPT');
  return{project:PROJECT_NAME,project_id:PROJECT_ID,title_verified:true,source:'exact-project-title-input',document_title_observed:compact(await page.title().catch(()=>''),300)};
}
async function waitFlowReady(page,timeout=60000){
  if(!PROJECT_ID)throw new Error('FLOW_PROJECT_NOT_CONFIGURED');const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const url=String(page.url()||'');if(/accounts\.google\.com|signin|ServiceLogin/i.test(url))throw new Error('FLOW_AUTH_REQUIRED');const text=(await getBody(page)).slice(0,12000);if(/verify it'?s you|captcha|security check|email or phone|enter your password/i.test(text))throw new Error('FLOW_AUTH_CHALLENGE');if(url.includes(projectPath())){try{const editor=await promptEditor(page),send=page.getByRole('button',{name:/Start generation/i}).last();if(await editor.isVisible().catch(()=>false)&&await send.isVisible().catch(()=>false))return editor}catch{}}await sleep(500)}throw new Error('FLOW_NOT_READY:'+compact(page.url(),200));
}
function cleanChromiumLocks() {
  for (const name of ['SingletonLock','SingletonSocket','SingletonCookie']) try { fs.unlinkSync(path.join(PROFILE_DIR,name)); } catch {}
}
function profileChromePids(){
  const out=[];let names=[];try{names=fs.readdirSync('/proc');}catch{return out;}
  for(const name of names){
    if(!/^\d+$/.test(name))continue;
    const pid=Number(name);if(!pid||pid===process.pid)continue;
    try{
      const cmd=fs.readFileSync('/proc/'+name+'/cmdline').toString('utf8').replace(/\0/g,' ');
      if(/google-chrome|chrome/i.test(cmd)&&cmd.includes(PROFILE_DIR))out.push(pid);
    }catch{}
  }
  return [...new Set(out)];
}
async function stopProfileChrome(){
  for(const pid of profileChromePids()){try{process.kill(pid,'SIGTERM');}catch{}}
  if(profileChromePids().length)await sleep(900);
  for(const pid of profileChromePids()){try{process.kill(pid,'SIGKILL');}catch{}}
  cleanChromiumLocks();
}
async function launchLocal() {
  if(!fs.existsSync(path.join(PROFILE_DIR,'Default','Cookies')))throw new Error('GFLOW_AUTH_PROFILE_MISSING');
  await stopProfileChrome();
  cleanChromiumLocks();

  const salt=parseInt(randomUUID().replace(/-/g,'').slice(0,8),16);
  const display=':'+String(100+(salt%400));
  const port=9400+(salt%1000);
  const xvfb=spawn('Xvfb',[display,'-screen','0','1024x700x24','-nolisten','tcp','-ac'],{stdio:['ignore','ignore','pipe']});
  let xvfbErr='';xvfb.stderr?.on('data',d=>{xvfbErr=(xvfbErr+String(d)).slice(-1600);});
  await sleep(550);
  if(xvfb.exitCode!==null)throw new Error('XVFB_START_FAILED:'+compact(xvfbErr,500));

  const env={...process.env,DISPLAY:display};
  const chrome=spawn('/usr/bin/google-chrome-stable',[
    '--user-data-dir='+PROFILE_DIR,
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--remote-allow-origins=*',
    '--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer',
    '--renderer-process-limit=1','--disable-site-isolation-trials','--no-zygote',
    '--disable-features=IsolateOrigins,site-per-process,CalculateNativeWinOcclusion,OptimizationHints,MediaRouter',
    '--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-default-apps',
    '--metrics-recording-only','--no-first-run','--no-default-browser-check','--password-store=basic',
    '--js-flags=--max-old-space-size=160','--window-size=1024,700',
    FLOW_URL
  ],{env,stdio:['ignore','ignore','pipe']});
  let chromeErr='';chrome.stderr?.on('data',d=>{chromeErr=(chromeErr+String(d)).slice(-3000);});

  let cdpReady=false;
  for(let i=0;i<80;i++){
    await sleep(250);
    if(chrome.exitCode!==null)break;
    try{
      const r=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(900)});
      if(r.ok){cdpReady=true;break;}
    }catch{}
  }
  if(!cdpReady){
    const exit=chrome.exitCode;
    try{chrome.kill('SIGTERM');}catch{};try{xvfb.kill('SIGTERM');}catch{};
    await sleep(250);
    throw new Error('CHROME_CDP_NOT_READY:exit='+String(exit)+':stderr='+compact(chromeErr,700)+':xvfb='+compact(xvfbErr,300));
  }

  await sleep(3000);
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:15000});
  const context=browser.contexts()[0];
  if(!context)throw new Error('CHROME_CDP_CONTEXT_MISSING');
  const pages=context.pages();
  const page=[...pages].reverse().find(p=>String(p.url()).includes('flow.google.com'))||pages[0]||await context.newPage();
  const close=async()=>{
    try{await browser.close();}catch{}
    try{chrome.kill('SIGTERM');}catch{}
    await sleep(450);
    try{xvfb.kill('SIGTERM');}catch{}
    await stopProfileChrome().catch(()=>{});
  };
  return {browser,context,page,close};
}

async function seedPersistentProfile(storage, ua='') {
  cleanChromiumLocks();
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR,{executablePath:CHROMIUM_PATH,headless:true,acceptDownloads:true,userAgent:ua||undefined,locale:'en-US',timezoneId:TIMEZONE,viewport:{width:1440,height:1000},args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  try {
    if (Array.isArray(storage?.cookies) && storage.cookies.length) await ctx.addCookies(storage.cookies);
    for (const origin of Array.isArray(storage?.origins) ? storage.origins : []) {
      if (!origin?.origin || !Array.isArray(origin?.localStorage) || !origin.localStorage.length) continue;
      const p = await ctx.newPage();
      try { await p.goto(origin.origin,{waitUntil:'domcontentloaded',timeout:30000}); await p.evaluate(items=>{for(const i of items)localStorage.setItem(i.name,i.value);},origin.localStorage); } catch {}
      try { await p.close(); } catch {}
    }
    const p = ctx.pages()[0] || await ctx.newPage(); await p.goto(FLOW_URL,{waitUntil:'domcontentloaded',timeout:60000}); await waitFlowReady(p,60000);
  } finally { await ctx.close().catch(()=>{}); }
}
async function migrateProfileOnce(db) {
  const cookies=path.join(PROFILE_DIR,'Default','Cookies');
  if(fs.existsSync(cookies)){
    setMeta(db,'automation:provider',PROVIDER);
    setMeta(db,'automation:paidDependencyDetected','false');
    setMeta(db,'automation:tinyfishRequired','false');
    setMeta(db,'automation:tinyfishMigrationComplete','true');
    setMeta(db,'automation:tinyfishCallsAfterMigration','0');
    return true;
  }
  setMeta(db,'flow:state','REQUIERE REAUTENTICACIÓN');
  setMeta(db,'flow:message','Falta el perfil autenticado de Google Flow.');
  publish('AUTH_BOOTSTRAP_REQUIRED',{message:'Authenticated gflow Chrome profile is missing. No paid fallback will be used.'});
  return false;
}

async function visibleExact(page,text) {
  const loc=page.getByText(text,{exact:true}); for(let i=(await loc.count())-1;i>=0;i--){const c=loc.nth(i);if(await c.isVisible().catch(()=>false))return c;} return null;
}
async function clickInteractive(locator) { await locator.evaluate(el=>{const t=el.closest('button,[role="button"],[role="option"],[role="menuitem"],[role="radio"],[role="tab"]')||el;if(typeof t.click==='function')t.click();else t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}); }
async function settingsButton(page) {
  const b=page.getByRole('button',{name:'Settings trigger'}).last();
  if(!(await b.count().catch(()=>0))||!(await b.isVisible().catch(()=>false)))throw new Error('FLOW_SETTINGS_BUTTON_NOT_FOUND');
  return b;
}
async function ensureSettingsOpen(page){
  const video=page.getByRole('radio',{name:/Video/i}).last();
  if(await video.count().catch(()=>0)&&await video.isVisible().catch(()=>false))return;
  await (await settingsButton(page)).click();
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    if(await video.count().catch(()=>0)&&await video.isVisible().catch(()=>false))return;
    await sleep(150);
  }
  throw new Error('FLOW_SETTINGS_MENU_NOT_OPEN');
}
async function clickRadio(page,re,label){
  const r=page.getByRole('radio',{name:re}).last();
  if(!(await r.count().catch(()=>0))||!(await r.isVisible().catch(()=>false)))throw new Error('FLOW_SETTING_NOT_FOUND:'+label);
  if((await r.getAttribute('aria-checked').catch(()=>null))!=='true')await r.click();
  await sleep(350);
  if((await r.getAttribute('aria-checked').catch(()=>null))!=='true')throw new Error('FLOW_SETTING_NOT_CONFIRMED:'+label);
  return true;
}
async function configureFlow(page){
  await waitFlowReady(page,60000);await ensureSettingsOpen(page);await clickRadio(page,/Video/i,'Video');await clickRadio(page,new RegExp('^'+escapeRe(ASPECT_RATIO)+'$','i'),ASPECT_RATIO);
  const modelButton=page.getByRole('button',{name:/Select model family/i}).last();if(!(await modelButton.count().catch(()=>0)))throw new Error('FLOW_MODEL_BUTTON_NOT_FOUND');let currentModel=compact(await modelButton.innerText().catch(()=>''),200);
  if(!modelMatches(currentModel)){await modelButton.click();await sleep(300);const opts=page.getByRole('menuitem');let chosen=null,best=-1,tokens=norm(MODEL_INTENT).split(' ').filter(x=>x.length>2);for(let i=0;i<await opts.count().catch(()=>0);i++){const o=opts.nth(i);if(!(await o.isVisible().catch(()=>false)))continue;const txt=compact(await o.innerText().catch(()=>''),180);let score=tokens.filter(t=>norm(txt).includes(t)).length;if(/omni/i.test(MODEL_INTENT)&&/omni/i.test(txt))score+=3;if(/flash/i.test(MODEL_INTENT)&&/flash/i.test(txt))score+=2;if(score>best){best=score;chosen=o}}if(!chosen||best<1)throw new Error('FLOW_MODEL_INTENT_NOT_FOUND:'+MODEL_INTENT);await chosen.click();await sleep(450);currentModel=compact(await modelButton.innerText().catch(()=>''),200)}
  const resRe=new RegExp(escapeRe(RESOLUTION_INTENT),'i'),resRadio=page.getByRole('radio',{name:resRe}).last();if(await resRadio.count().catch(()=>0)&&await resRadio.isVisible().catch(()=>false)){if((await resRadio.getAttribute('aria-checked').catch(()=>null))!=='true')await resRadio.click();await sleep(250)}else{const exact=page.getByText(resRe).last();if(!(await exact.count().catch(()=>0)))throw new Error('FLOW_RESOLUTION_NOT_FOUND:'+RESOLUTION_INTENT);await clickInteractive(exact);await sleep(250)}
  await clickRadio(page,new RegExp('^'+escapeRe(DURATION_LABEL)+'$','i'),DURATION_LABEL);await clickRadio(page,new RegExp('^'+escapeRe(OUTPUT_LABEL)+'$','i'),OUTPUT_LABEL);
  if(CONFIG.characters.length){const ingredients=page.getByRole('radio',{name:/Ingredients/i}).last();if(await ingredients.count().catch(()=>0)&&await ingredients.isVisible().catch(()=>false)){if((await ingredients.getAttribute('aria-checked').catch(()=>null))!=='true')await ingredients.click();await sleep(300)}}
  const label=compact(await(await settingsButton(page)).innerText(),300),ratioToken=ASPECT_RATIO.replace(':','_');if(!/Video/i.test(label)||!new RegExp(escapeRe(DURATION_LABEL),'i').test(label)||!new RegExp(escapeRe(OUTPUT_LABEL),'i').test(label)||!(label.includes(ASPECT_RATIO)||label.includes(ratioToken)))throw new Error('FLOW_SETTINGS_NOT_CONFIRMED:'+label);await page.keyboard.press('Escape').catch(()=>{});
  return{label,mode:'Video',ratio:ASPECT_RATIO,model:currentModel,resolution:RESOLUTION_INTENT,duration:DURATION_LABEL,count:OUTPUT_LABEL,ingredients:CONFIG.characters.length>0};
}
async function ingredientCount(page){
  return await page.locator('[aria-label="Ingredient"]').count().catch(()=>0);
}
async function clearComposer(page){
  await waitFlowReady(page,30000);
  const clear=page.getByRole('button',{name:/Clear prompt/i}).last();
  if(await clear.count().catch(()=>0)&&await clear.isVisible().catch(()=>false)){
    await clear.click().catch(()=>{});
    await sleep(500);
  }
  const editor=await promptEditor(page);
  await editor.fill('').catch(async()=>{await editor.click();await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');});
  await sleep(250);
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){
    if(await ingredientCount(page)===0)return true;
    const remove=page.locator('[aria-label="Ingredient"]');
    if(await remove.count().catch(()=>0)){
      await remove.last().click().catch(()=>{});
      await sleep(250);
    }else break;
  }
  if(await ingredientCount(page)!==0)throw new Error('FLOW_PROMPT_CLEAR_FAILED');
  return true;
}
async function composerAdd(page) {
  const named=page.getByRole('button',{name:/Add ingredients to the prompt box/i}).last();
  if(!(await named.count().catch(()=>0))||!(await named.isVisible().catch(()=>false)))throw new Error('ADD_INGREDIENTS_BUTTON_NOT_FOUND');
  await named.click();await sleep(550);
}
async function visibleAddToPromptButton(page){
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){
    const buttons=page.locator('button');
    const count=await buttons.count();
    for(let i=count-1;i>=0;i--){
      const c=buttons.nth(i);
      if(!(await c.isVisible().catch(()=>false)))continue;
      const txt=compact(await c.innerText().catch(()=>''),120);
      if(/^Add to prompt$/i.test(txt))return c;
    }
    await sleep(200);
  }
  return null;
}
async function attachCharacter(page,name){
  const before=await ingredientCount(page);
  await composerAdd(page);

  const tab=page.getByRole('tab',{name:/Characters/i}).last();
  if(await tab.count().catch(()=>0)&&await tab.isVisible().catch(()=>false)){
    await tab.click();
  }else{
    const chars=await visibleExact(page,'Characters');
    if(!chars)throw new Error('CHARACTERS_PICKER_NOT_FOUND');
    await clickInteractive(chars);
  }
  await sleep(650);

  let candidate=page.getByRole('option',{name,exact:true}).last();
  if(!(await candidate.count().catch(()=>0))||!(await candidate.isVisible().catch(()=>false))){
    const search=page.locator('input[aria-label="Search assets"]').last();
    if(!(await search.count().catch(()=>0))||!(await search.isVisible().catch(()=>false)))throw new Error(`CHARACTER_SEARCH_INPUT_NOT_FOUND:${name}`);
    await search.fill(name);await sleep(650);
    candidate=page.getByRole('option',{name,exact:true}).last();
  }
  if(!(await candidate.count().catch(()=>0))||!(await candidate.isVisible().catch(()=>false)))throw new Error(`CHARACTER_NOT_FOUND:${name}`);

  const selectedText=compact(await candidate.innerText().catch(()=>''),120);
  if(norm(selectedText)!==norm(name))throw new Error(`CHARACTER_EXACT_MATCH_FAILED:${name}:${selectedText}`);
  await candidate.click();await sleep(700);

  const add=await visibleAddToPromptButton(page);
  if(add){await add.click().catch(()=>{});await sleep(650);}
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(300);

  const deadline=Date.now()+4000;
  let after=await ingredientCount(page);
  while(after<before+1&&Date.now()<deadline){await sleep(200);after=await ingredientCount(page);}
  if(after!==before+1)throw new Error(`CHARACTER_INGREDIENT_COUNT_FAILED:${name}:${before}->${after}`);
  return{name,before,after,exact_option:true,confirmation_clicked:Boolean(add)};
}
async function fillPrompt(page,cp){
  await waitFlowReady(page,30000);
  const editor=await promptEditor(page);
  const payload=String(cp.prompt||'').replace(/\s+/g,' ').trim();
  if(payload.length<700)throw new Error('PROMPT_PAYLOAD_TOO_SHORT');
  const target=await classifyPromptTarget(page,editor);
  if(target!=='VIDEO_PROMPT_COMPOSER')throw new Error('PROMPT_TARGET_NOT_VIDEO_COMPOSER:'+target);
  await ensureCanonicalProjectTitle(page);
  await verifyProjectIdentity(page,'');

  const read=async()=>{
    const raw=await editor.evaluate(el=>String(
      (typeof el.value==='string'&&el.value) ||
      el.innerText ||
      el.textContent ||
      ''
    )).catch(()=> '');
    return String(raw||'').replace(/\s+/g,' ').trim();
  };

  await editor.fill(payload).catch(()=>{});
  await sleep(500);
  let value=await read();
  const first=payload.slice(0,140),last=payload.slice(-140);

  if(!value.includes(first)||!value.includes(last)){
    await editor.click();
    await page.keyboard.press('Control+A').catch(()=>{});
    await page.keyboard.press('Backspace').catch(()=>{});
    await page.keyboard.insertText(payload);
    await sleep(600);
    value=await read();
  }

  if(!value.includes(first)||!value.includes(last)){
    throw new Error(`PROMPT_INJECTION_FAILED:${value.length}:${payload.length}`);
  }
  const bytes=Buffer.byteLength(value,'utf8'),expected=Buffer.byteLength(payload,'utf8');
  if(Math.abs(bytes-expected)>8)throw new Error(`PROMPT_LENGTH_MISMATCH:${bytes}:${expected}`);
  const projectGuard=await verifyProjectIdentity(page,payload);
  return{payload_length:value.length,payload_bytes:bytes,target:'VIDEO_PROMPT_COMPOSER',projectGuard};
}
async function verifyPreparedState(page,row,cp){
  await waitFlowReady(page,30000);const settings=await configureFlow(page);let count=await ingredientCount(page),repairedCharacters=false;
  if(count!==cp.visual.length){if(count!==0)throw new Error('PREPARED_CHARACTER_PARTIAL_STATE:'+count+':'+cp.visual.length);for(const name of cp.visual)await attachCharacter(page,name);count=await ingredientCount(page);if(count!==cp.visual.length)throw new Error('PREPARED_CHARACTER_REPAIR_FAILED:'+count+':'+cp.visual.length);repairedCharacters=true}
  const payload=String(cp.prompt||'').replace(/\s+/g,' ').trim(),first=payload.slice(0,140),last=payload.slice(-140);let editor=await promptEditor(page),raw=await editor.evaluate(el=>String((typeof el.value==='string'&&el.value)||el.innerText||el.textContent||'')).catch(()=>''),value=String(raw||'').replace(/\s+/g,' ').trim(),repairedPrompt=false;
  if(!value||!value.includes(first)||!value.includes(last)||Math.abs(Buffer.byteLength(value,'utf8')-Buffer.byteLength(payload,'utf8'))>8){await fillPrompt(page,cp);editor=await promptEditor(page);raw=await editor.evaluate(el=>String((typeof el.value==='string'&&el.value)||el.innerText||el.textContent||'')).catch(()=>'');value=String(raw||'').replace(/\s+/g,' ').trim();repairedPrompt=true}
  if(!value.includes(first)||!value.includes(last))throw new Error('PREPARED_PROMPT_REPAIR_FAILED');if(String(row.providerRunId||''))throw new Error('PREPARED_JOB_ALREADY_STARTED');
  const body=(await getBody(page)).slice(0,12000);if(/generating|processing|rendering|creating video|generando|procesando/i.test(body))throw new Error('PREPARED_EXISTING_GENERATION_VISIBLE');
  const target=await classifyPromptTarget(page,editor);if(target!=='VIDEO_PROMPT_COMPOSER')throw new Error('PREPARED_PROMPT_TARGET_CHANGED:'+target);await ensureCanonicalProjectTitle(page);const projectGuard=await verifyProjectIdentity(page,payload);
  return{provider:PROVIDER,prompt_target:target,project_guard:projectGuard,prompt_verified:true,visual_assets_ready:true,characters:cp.visual,ingredient_count:count,settings,prepared_state_verified:true,repaired_characters:repairedCharacters,repaired_prompt:repairedPrompt,verified_at:now(),duration:DURATION_LABEL,ratio:ASPECT_RATIO,model:settings.model,resolution:RESOLUTION_INTENT,output_count:OUTPUT_COUNT};
}
async function preflight(page,row,cp){
  await clearComposer(page);const settings=await configureFlow(page),attachments=[];for(const name of cp.visual)attachments.push(await attachCharacter(page,name));const count=await ingredientCount(page);if(count!==cp.visual.length)throw new Error('CHARACTER_INGREDIENT_TOTAL_FAILED:'+count+':'+cp.visual.length);const promptGuard=await fillPrompt(page,cp);return{provider:PROVIDER,payload_retrieved:true,prompt_verified:true,first_fragment_seen:true,last_fragment_seen:true,visual_assets_ready:true,auth_required:false,duration:DURATION_LABEL,ratio:ASPECT_RATIO,model:settings.model,resolution:RESOLUTION_INTENT,output_count:OUTPUT_COUNT,characters:cp.visual,attachments,ingredient_count:count,prompt_target:promptGuard.target,project_guard:promptGuard.projectGuard,settings,at:now()};
}
async function currentVideos(page){return await page.locator('video').evaluateAll(vs=>vs.map((v,i)=>({i,src:v.currentSrc||v.src||'',duration:Number(v.duration||0),readyState:Number(v.readyState||0),w:Number(v.videoWidth||0),h:Number(v.videoHeight||0)}))).catch(()=>[]);}
async function clickSubmitExactlyOnce(page){
  const send=page.getByRole('button',{name:/Start generation/i}).last();
  if(!(await send.count().catch(()=>0))||!(await send.isVisible().catch(()=>false))||!(await send.isEnabled().catch(()=>false)))throw new Error('START_GENERATION_BUTTON_NOT_READY');
  await send.click();await sleep(650);
  const gens=page.getByRole('button',{name:/^Generate$/i});
  for(let i=(await gens.count().catch(()=>0))-1;i>=0;i--){const c=gens.nth(i);if(await c.isVisible().catch(()=>false)&&await c.isEnabled().catch(()=>false)){await c.click();return'confirmation-generate';}}
  return'start-generation-direct';
}
async function renderAuthGuard(page){
  const url=String(page.url()||'');
  if(/accounts\.google\.com|signin|ServiceLogin/i.test(url))throw new Error('FLOW_AUTH_REQUIRED_DURING_RENDER');
  const text=(await getBody(page)).slice(0,12000);
  if(/verify it'?s you|verifica que eres t[uú]|captcha|security check|verificaci[oó]n de seguridad/i.test(text))throw new Error('FLOW_AUTH_CHALLENGE_DURING_RENDER');
  return true;
}
async function captureFlowInventory(page){
  try{
    return await page.evaluate(()=>{
      const tiles=[...document.querySelectorAll('flow-grid-tile-container')].filter(el=>{const r=el.getBoundingClientRect();return r.width>20&&r.height>20;});
      const sigs=tiles.map(el=>String(el.getAttribute('aria-label')||el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,220)).filter(Boolean);
      const body=String(document.body?.innerText||'').replace(/\s+/g,' ').trim();
      return{tile_count:tiles.length,ordered_signatures:sigs.slice(0,120),signatures:[...new Set(sigs)].slice(0,120),busy:/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation/i.test(body)};
    });
  }catch{return{tile_count:0,ordered_signatures:[],signatures:[],busy:false}}
}
function inventoryHasNew(current,baseline){
  if(!baseline)return false;
  if(Number(current?.tile_count||0)>Number(baseline?.tile_count||0))return true;
  const before=new Set(Array.isArray(baseline?.signatures)?baseline.signatures:[]);
  return (Array.isArray(current?.signatures)?current.signatures:[]).some(x=>!before.has(x));
}
async function reconcileAmbiguousGeneric(page,row,lc,db){
  const baselineInv=lc?.baseline_inventory||null;
  const boundary=Date.parse(String(lc?.submit_boundary_at||''));
  const age=Number.isFinite(boundary)?Date.now()-boundary:0;
  const currentInv=await captureFlowInventory(page);
  const body=(await getBody(page)).slice(0,14000);
  const busy=currentInv.busy||/generating|processing|rendering|creating video|generando|procesando|initiating|starting generation/i.test(body);
  const fresh=inventoryHasNew(currentInv,baselineInv);
  if(fresh||busy){
    const startedAt=String(lc?.generation_started_at||now());
    const next=setLifecycle(db,row,'GENERATION_STARTED',{...lc,generation_started_at:startedAt,evidence:`ambiguous-reconciled:fresh=${fresh};busy=${busy};tiles=${baselineInv?.tile_count||0}->${currentInv.tile_count}`,reconciled_at:now()});
    db.prepare("UPDATE factory_items SET status='generating',error=NULL,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(now(),now(),row.id);
    publish('AMBIGUOUS_RECONCILED_GENERATION',{episode:`T${row.season}E${row.episode}`,job_id:row.id,evidence:next.evidence});
    return{mode:'retrieve',lifecycle:next};
  }
  if(baselineInv&&age>=5*60*1000){
    const before=Array.isArray(baselineInv.signatures)?baselineInv.signatures:[];
    const after=Array.isArray(currentInv.signatures)?currentInv.signatures:[];
    const sameCount=Number(currentInv.tile_count||0)===Number(baselineInv.tile_count||0);
    const sameSigs=before.length===after.length&&before.every(x=>after.includes(x));
    if(sameCount&&sameSigs&&!busy){
      if(reviewerRetryTokenConsumed(row)){
        db.prepare("UPDATE factory_items SET status='manual_hold',providerRunId=NULL,error=?,nextTry=0,lastProgressAt=?,updatedAt=? WHERE id=?").run(
          'REDO was submitted but Flow did not confirm a result. Token stays consumed; automatic resubmit is forbidden.',
          now(),now(),row.id
        );
        setLifecycle(db,row,'MANUAL_HOLD_SUBMIT_NOT_CONFIRMED',{...lc,reconciled_at:now(),automatic_submit_forbidden:true,reviewer_retry:true,retry_token:String(row.reviewRetryToken||'')});
        publish('REVIEW_RETRY_NOT_CONFIRMED_HOLD',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'REDO token consumed; no automatic second Generate.'});
        return{mode:'wait'};
      }
      const retryAt=Date.now()+60000;
      db.prepare("UPDATE factory_items SET status='draft',providerRunId=NULL,error=NULL,nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?").run(retryAt,now(),now(),row.id);
      setLifecycle(db,row,'RECONCILED_NO_GENERATION',{prior_generation_id:String(lc?.generation_id||row.providerRunId||''),submit_boundary_at:String(lc?.submit_boundary_at||''),reconciled_at:now(),evidence:`No new Flow result after ${Math.round(age/1000)}s; inventory unchanged at ${currentInv.tile_count} tiles.`,retry_at:new Date(retryAt).toISOString()});
      publish('AMBIGUOUS_RECONCILED_NO_GENERATION',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'Automatic generation showed no result; retry may occur after backoff.'});
      return{mode:'wait'};
    }
  }
  const retryAt=Date.now()+60000;
  db.prepare("UPDATE factory_items SET status='generating',error=?,nextTry=?,lastProgressAt=?,updatedAt=? WHERE id=?").run('SUBMIT_AMBIGUOUS — reconciliation pending; no automatic resubmit',retryAt,now(),now(),row.id);
  setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{...lc,last_error:'Reconciliation pending; Generate remains forbidden.',retry_at:new Date(retryAt).toISOString(),last_inventory:currentInv});
  publish('SUBMIT_AMBIGUOUS',{episode:`T${row.season}E${row.episode}`,job_id:row.id,message:'Read-only Flow reconciliation pending. No Generate will be clicked.'});
  return{mode:'wait'};
}
async function waitGenerationStarted(page,baseline,baselineInventory,timeout=90000){
  const baseSrc=new Set((baseline||[]).map(v=>v.src).filter(Boolean)),startedAt=Date.now(),deadline=startedAt+timeout;
  while(Date.now()<deadline){
    await renderAuthGuard(page);
    const vids=await currentVideos(page),freshVideo=vids.some(v=>v.src&&!baseSrc.has(v.src));
    const inv=await captureFlowInventory(page),tileCountIncreased=Number(inv.tile_count||0)>Number(baselineInventory?.tile_count||0);
    const send=page.getByRole('button',{name:/Start generation/i}).last(),sendVisible=await send.isVisible().catch(()=>false),sendDisabled=await send.isDisabled().catch(()=>false);
    const busyEls=page.locator('text=/Generating|Processing|Rendering|Creating video|Generando|Procesando|Starting generation|Initiating/i');
    let visibleBusy=0;for(let i=0;i<Math.min(await busyEls.count().catch(()=>0),40);i++)if(await busyEls.nth(i).isVisible().catch(()=>false))visibleBusy++;
    const elapsed=Date.now()-startedAt,controlTransition=elapsed>=1200&&(!sendVisible||sendDisabled)&&visibleBusy>0;
    if(freshVideo||tileCountIncreased||controlTransition)return{started:true,evidence:`freshVideo=${freshVideo}; tileCountIncreased=${tileCountIncreased}; controlTransition=${controlTransition}; elapsedMs=${elapsed}`,videos:vids,inventory:inv};
    await sleep(1000);
  }
  return{started:false,evidence:'No post-submit video, tile-count increase, or generation-control transition'};
}
function newestRendered(vids,baseline){const baseSrc=new Set((baseline||[]).map(v=>v.src).filter(Boolean)),fresh=(vids||[]).filter(v=>v.readyState>=2&&v.duration>0&&((v.src&&!baseSrc.has(v.src))||v.i>=(baseline||[]).length));return fresh.at(-1)||null;}
async function visibleDownloadButton(page){
  const named=page.getByRole('button',{name:/Download|Export|Descargar/i});
  for(let i=(await named.count())-1;i>=0;i--){
    const c=named.nth(i);
    if(await c.isVisible().catch(()=>false))return c;
  }
  const buttons=page.locator('button,[role="button"]');
  for(let i=(await buttons.count())-1;i>=0;i--){
    const c=buttons.nth(i);
    if(!(await c.isVisible().catch(()=>false)))continue;
    const txt=compact((await c.innerText().catch(()=>''))+' '+(await c.getAttribute('aria-label').catch(()=>''))+' '+(await c.getAttribute('title').catch(()=>'')),180);
    if(/download|export|descargar|file_download/i.test(txt))return c;
  }
  return null;
}
async function openLatestGeneratedResult(page){
  let d=await visibleDownloadButton(page);
  if(d)return{ready:true,opened:false,signal:'download-visible'};
  const prompt=await promptEditor(page).catch(()=>null);
  const pb=prompt?await prompt.boundingBox().catch(()=>null):null;
  const selectors=['img','[role="img"]','canvas','video','[style*="background-image"]','[role="button"]','[tabindex="0"]'];
  const candidates=[];
  for(const sel of selectors){
    const loc=page.locator(sel),count=Math.min(await loc.count().catch(()=>0),80);
    for(let i=0;i<count;i++){
      const el=loc.nth(i);
      if(!(await el.isVisible().catch(()=>false)))continue;
      const b=await el.boundingBox().catch(()=>null);if(!b)continue;
      const area=b.width*b.height;
      if(area<18000||b.width<120||b.height<100)continue;
      if(pb && b.y>=pb.y-20)continue;
      if(b.x<120&&b.width<220)continue;
      const label=compact((await el.innerText().catch(()=>''))+' '+(await el.getAttribute('aria-label').catch(()=>''))+' '+(await el.getAttribute('title').catch(()=>''))+' '+(await el.getAttribute('alt').catch(()=>'')),220);
      if(/add ingredient|settings|start generation|send|prompt|character|clear prompt|search assets|upload/i.test(label))continue;
      candidates.push({el,area,y:b.y,x:b.x,w:b.width,h:b.height,sel,label});
    }
  }
  candidates.sort((a,b)=>b.area-a.area||b.y-a.y);
  for(const cand of candidates.slice(0,14)){
    await cand.el.click({position:{x:Math.max(5,Math.min(cand.w-5,cand.w/2)),y:Math.max(5,Math.min(cand.h-5,cand.h/2))}}).catch(()=>{});
    await sleep(700);
    d=await visibleDownloadButton(page);
    if(d)return{ready:true,opened:true,signal:'result-opened',candidate:{selector:cand.sel,area:Math.round(cand.area),x:Math.round(cand.x),y:Math.round(cand.y)}};
    await page.keyboard.press('Escape').catch(()=>{});
    await sleep(250);
  }
  const buttonLabels=[];
  const allButtons=page.locator('button,[role="button"]');
  for(let i=0;i<Math.min(await allButtons.count().catch(()=>0),80);i++){
    const el=allButtons.nth(i);if(!(await el.isVisible().catch(()=>false)))continue;
    const txt=compact((await el.innerText().catch(()=>''))+' '+(await el.getAttribute('aria-label').catch(()=>''))+' '+(await el.getAttribute('title').catch(()=>'')),120);
    if(txt)buttonLabels.push(txt);
  }
  publish('RETRIEVAL_SCAN',{
    message:'No download control yet.',
    buttons:[...new Set(buttonLabels)].slice(-24),
    large_candidates:candidates.slice(0,8).map(c=>({selector:c.sel,label:compact(c.label,80),area:Math.round(c.area),x:Math.round(c.x),y:Math.round(c.y)})),
    frames:page.frames().map(f=>compact(f.url(),140)).filter(Boolean).slice(0,8)
  });
  return{ready:false,opened:false,signal:'no-result-control'};
}
async function downloadResult(page,rendered,localPath){
  if(rendered?.i>=0){const v=page.locator('video').nth(rendered.i);if(await v.isVisible().catch(()=>false))await v.click({position:{x:10,y:10}}).catch(()=>{})}
  if(!rendered?.uiReady&&!(await visibleDownloadButton(page)))await openLatestGeneratedResult(page);
  let trigger=await visibleDownloadButton(page);const named=page.getByRole('button',{name:/Download|Export|Descargar/i}).last();
  if(!trigger)for(let i=(await named.count())-1;i>=0;i--){const c=named.nth(i);if(await c.isVisible().catch(()=>false)){trigger=c;break}}
  if(trigger){await trigger.click();await sleep(500);const wanted=CONFIG.generation.download_quality||'1080p Upscaled',opt=page.getByText(new RegExp(escapeRe(wanted),'i')).last();if(await opt.count().catch(()=>0)&&await opt.isVisible().catch(()=>false)){const p=page.waitForEvent('download',{timeout:15*60*1000});await opt.click();const dl=await p;await dl.saveAs(localPath);return{method:wanted}}await page.keyboard.press('Escape').catch(()=>{})}
  if(rendered?.src&&/^https?:/i.test(rendered.src)){const r=await page.context().request.get(rendered.src,{timeout:90000});if(r.ok()){fs.writeFileSync(localPath,await r.body(),{mode:0o600});return{method:'direct-video-url'}}}
  throw new Error('VIDEO_DOWNLOAD_FAILED');
}
function validateMp4(localPath){
  const st=fs.statSync(localPath);if(st.size<100000)throw new Error('MP4_TOO_SMALL:'+st.size);const head=fs.readFileSync(localPath).subarray(0,128);if(!head.includes(Buffer.from('ftyp')))throw new Error('MP4_FTYP_MISSING');
  const raw=execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',localPath],{encoding:'utf8',timeout:30000}),probe=JSON.parse(raw),stream=(probe.streams||[]).find(s=>s.codec_type==='video');if(!stream)throw new Error('MP4_VIDEO_STREAM_MISSING');
  const duration=Number(probe?.format?.duration||0),width=Number(stream.width||0),height=Number(stream.height||0),tol=Math.max(2.5,DURATION_SECONDS*.25);if(Math.abs(duration-DURATION_SECONDS)>tol)throw new Error('MP4_DURATION_UNEXPECTED:'+duration);
  const parts=ASPECT_RATIO.split(':').map(Number);if(width>0&&height>0&&parts.length===2&&parts.every(Number.isFinite)){const expected=parts[0]/parts[1],actual=width/height;if(Math.abs(actual-expected)>Math.max(.12,expected*.22))throw new Error('MP4_ASPECT_UNEXPECTED:'+width+'x'+height)}
  return{size:st.size,duration,width,height,codec:String(stream.codec_name||'')};
}
async function retrieveExisting(page,row,cp,lc,db){setLifecycle(db,row,'RETRIEVING',{generation_id:lc?.generation_id||row.providerRunId||'',baseline:lc?.baseline||[]});const baseline=Array.isArray(lc?.baseline)?lc.baseline:[],deadline=Date.now()+15*60*1000;let rendered=null,lastVideos=[],uiSignal=null,lastHeartbeat=0;while(Date.now()<deadline){await renderAuthGuard(page);if(Date.now()-lastHeartbeat>10000){lastHeartbeat=Date.now();try{db.prepare('UPDATE factory_items SET lastProgressAt=?,updatedAt=? WHERE id=?').run(now(),now(),row.id);}catch{}}lastVideos=await currentVideos(page);rendered=newestRendered(lastVideos,baseline);if(rendered)break;const text=await getBody(page);if(/failed to generate|generation failed|couldn't generate|no se pudo generar/i.test(text))throw new Error('FLOW_GENERATION_FAILED');const stillBusy=/generating|processing|rendering|creating video|generando|procesando|upscaling/i.test(text);if(!stillBusy){uiSignal=await openLatestGeneratedResult(page);if(uiSignal?.ready){rendered={uiReady:true,signal:uiSignal.signal};break;}}await sleep(2500);}if(!rendered)throw new Error(`RENDER_TIMEOUT:videos=${lastVideos.length}:ui=${uiSignal?.signal||'none'}`);const localPath=path.join(VIDEO_DIR,`${row.id}.mp4`);try{fs.unlinkSync(localPath);}catch{}const dl=await downloadResult(page,rendered,localPath),valid=validateMp4(localPath),flowResult={provider:PROVIDER,generation_id:lc?.generation_id||row.providerRunId||'',generation_started_at:lc?.generation_started_at||'',duration:valid.duration,width:valid.width,height:valid.height,size:valid.size,codec:valid.codec,validated_ftyp:true,download_quality:dl.method||CONFIG.generation.download_quality||'downloaded asset',retrieved_at:now()};db.prepare(`UPDATE factory_items SET status='review',videoPath=?,flowResult=?,error=NULL,nextTry=0,runtimeAttemptCount=0,lastProgressAt=?,updatedAt=? WHERE id=?`).run(localPath,JSON.stringify(flowResult),now(),now(),row.id);try{db.prepare(`UPDATE factory_generations SET status='review',updatedAt=?,error=NULL WHERE itemId=? AND runId=?`).run(now(),row.id,String(lc?.generation_id||row.providerRunId||''));}catch{}setLifecycle(db,row,'REVIEW_READY',{...lc,generation_id:lc?.generation_id||row.providerRunId||'',size:valid.size,duration:valid.duration,width:valid.width,height:valid.height,download_quality:flowResult.download_quality,retrieved_at:now()});setMeta(db,'flow:lastSuccessfulGenerationAt',lc?.generation_started_at||now());setMeta(db,'flow:lastSuccessfulMp4At',now());setMeta(db,'automation:provider',PROVIDER);setMeta(db,'automation:paidDependencyDetected','false');setMeta(db,'automation:tinyfishRequired','false');try{fs.writeFileSync(path.join(FACTORY_DIR,'flow-browser-self-test.json'),JSON.stringify({at:now(),ok:true,stage:'real-production-review-ready',provider:PROVIDER,episode:`T${row.season}E${row.episode}`,mp4_valid:true,duration:valid.duration,width:valid.width,height:valid.height,codec:valid.codec},null,2),{mode:0o600});}catch{}publish('REVIEW_READY',{episode:`T${row.season}E${row.episode}`,job_id:row.id,generation_id:lc?.generation_id||row.providerRunId||'',size:valid.size,duration:valid.duration,resolution:`${valid.width}x${valid.height}`,factory_url:`/factory/video/${row.id}`});return true;}
async function processRow(db,row){
  const cp=preparePromptIfNeeded(db,row);row=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id);let lc=lifecycle(db,row);const state=String(lc?.state||'').toUpperCase(),session=await launchLocal(),context=session.context;
  try{
    const page=session.page||context.pages()[0]||await context.newPage();if(!String(page.url()).includes(projectPath()))await page.goto(FLOW_URL,{waitUntil:'domcontentloaded',timeout:60000});await waitFlowReady(page,60000);
    if(AFTER_GENERATE.has(state))return await retrieveExisting(page,row,cp,lc,db);
    if(AMBIGUOUS.has(state)){const reconciled=await reconcileAmbiguousGeneric(page,row,lc,db);if(reconciled.mode==='retrieve')return await retrieveExisting(page,row,cp,reconciled.lifecycle,db);return false}
    const reviewerRetry=isReviewerRetry(row);
    const manualSubmit=meta(db,'automation:allowSubmit','0')==='1',runtimeEnabled=meta(db,'automation:factoryEnabled','false')==='true',autoSubmit=runtimeEnabled&&meta(db,'automation:freeFactoryEnabled','0')==='1'&&(reviewerRetry||dailyGenerationCount(db)<DAILY_PRODUCTION_LIMIT),submitAuthorized=manualSubmit||autoSubmit;
    publish('PREFLIGHT',{episode:'E'+row.episode,job_id:row.id});
    const pf=await preflight(page,row,cp);
    db.prepare('UPDATE factory_items SET transportPreflight=?,error=NULL,updatedAt=? WHERE id=?').run(JSON.stringify(pf).slice(0,20000),now(),row.id);
    setLifecycle(db,row,'PREFLIGHT_PASSED',{preflight_at:now(),settings:pf.settings,characters:cp.visual,prompt_hash:cp.hash,prepared_state_verified:Boolean(pf.prepared_state_verified)});
    if(!submitAuthorized){const used=dailyGenerationCount(db);setMeta(db,'flow:state',used>=DAILY_PRODUCTION_LIMIT?'ESPERANDO CRÉDITOS':'CONECTADO');setMeta(db,'flow:currentStep',used>=DAILY_PRODUCTION_LIMIT?'daily-limit':'preflight:passed-no-submit');publish(used>=DAILY_PRODUCTION_LIMIT?'DAILY_LIMIT':'PREFLIGHT_READY_NO_SUBMIT',{episode:'E'+row.episode,job_id:row.id,characters:cp.visual,settings:pf.settings});return false}
    if(manualSubmit)setMeta(db,'automation:allowSubmit','0');
    const baseline=await currentVideos(page),baselineInventory=await captureFlowInventory(page),genId='free-'+randomUUID();
    if(reviewerRetry){
      const token=String(row.reviewRetryToken||'');
      const claimed=db.prepare("UPDATE factory_items SET status='generating',providerRunId=?,reviewRetrySubmittedToken=reviewRetryToken,error=NULL,updatedAt=? WHERE id=? AND reviewRetryToken=? AND (reviewRetrySubmittedToken IS NULL OR reviewRetrySubmittedToken<>reviewRetryToken)").run(genId,now(),row.id,token);
      if(Number(claimed.changes||0)!==1)throw new Error('REVIEW_RETRY_ALREADY_SUBMITTED');
    }else db.prepare("UPDATE factory_items SET status='generating',providerRunId=?,error=NULL,updatedAt=? WHERE id=?").run(genId,now(),row.id);
    setLifecycle(db,row,'SUBMIT_BOUNDARY_ENTERED',{generation_id:genId,submit_boundary_at:now(),baseline,baseline_inventory:baselineInventory,reviewer_retry:reviewerRetry,retry_token:reviewerRetry?String(row.reviewRetryToken||''):null});
    const submitMode=await clickSubmitExactlyOnce(page),started=await waitGenerationStarted(page,baseline,baselineInventory,90000);
    if(!started.started){setLifecycle(db,row,'SUBMIT_AMBIGUOUS',{generation_id:genId,submit_mode:submitMode,baseline,baseline_inventory:baselineInventory,evidence:started.evidence,last_error:'Generation start could not be confirmed. Automatic resubmit disabled.'});db.prepare("UPDATE factory_items SET status='generating',error=?,updatedAt=? WHERE id=?").run('SUBMIT_AMBIGUOUS — no automatic resubmit',now(),row.id);throw new Error('SUBMIT_AMBIGUOUS')}
    const startedAt=now();lc=setLifecycle(db,row,'GENERATION_STARTED',{generation_id:genId,generation_started_at:startedAt,submit_mode:submitMode,baseline,baseline_inventory:baselineInventory,evidence:started.evidence});
    try{db.prepare("INSERT INTO factory_generations(id,itemId,day,promptHash,credits,status,runId,createdAt,updatedAt,error,generationKind) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)").run(randomUUID(),row.id,artDay(new Date(startedAt)),sha(cp.hash+':'+genId),CREDITS_PER_GENERATION,'running',genId,startedAt,startedAt,reviewerRetry?'review_retry':'automatic')}catch{}
    setMeta(db,'flow:lastSuccessfulGenerationAt',startedAt);publish('GENERATION_STARTED',{episode:'E'+row.episode,job_id:row.id,generation_id:genId,evidence:started.evidence});return await retrieveExisting(page,row,cp,lc,db);
  }finally{await session.close().catch(()=>{})}
}
function reconcileAmbiguousNoGeneration(){return false;}
function serialReady(db,row){
  if(!row)return false;if(!CONFIG.content.serialized||Number(row.episode)<=1)return true;
  const prev=db.prepare('SELECT status FROM factory_items WHERE episode<? ORDER BY episode DESC LIMIT 1').get(Number(row.episode));if(!prev)return false;
  const gate=CONFIG.content.continuity_gate;if(gate==='none')return true;
  return['queued','historical','published'].includes(String(prev.status||''));
}
function retryTokenOpen(row){
  const token=String(row?.reviewRetryToken||'').trim(),submitted=String(row?.reviewRetrySubmittedToken||'').trim();
  return Boolean(token&&token!==submitted);
}
function reviewerRetryTokenConsumed(row){
  const token=String(row?.reviewRetryToken||'').trim(),submitted=String(row?.reviewRetrySubmittedToken||'').trim();
  return Boolean(token&&token===submitted&&['reuse_prompt','revise_prompt'].includes(String(row?.retryStrategy||''))&&String(row?.reviewFeedback||'').trim().length>=3);
}
function isReviewerRetry(row){
  return !!row&&['reuse_prompt','revise_prompt'].includes(String(row.retryStrategy||''))&&String(row.reviewFeedback||'').trim().length>=3&&['regen_wait','draft'].includes(String(row.status||''))&&retryTokenOpen(row);
}
function normalizeConsumedReviewerRetries(db){
  const rows=db.prepare("SELECT * FROM factory_items WHERE retryStrategy IN ('reuse_prompt','revise_prompt') AND reviewFeedback IS NOT NULL AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken AND status NOT IN ('review','queued','historical','published')").all();
  for(const row of rows){
    const lc=lifecycle(db,row)||{},state=String(lc.state||'').toUpperCase();
    if(AFTER_GENERATE.has(state)||AMBIGUOUS.has(state)){
      if(String(row.status||'')!=='generating')db.prepare("UPDATE factory_items SET status='generating',nextTry=0,error='REDO already submitted: recovery only; Generate is locked.',updatedAt=? WHERE id=?").run(now(),row.id);
    }else if(String(row.status||'')!=='manual_hold'){
      db.prepare("UPDATE factory_items SET status='manual_hold',nextTry=0,error='REDO token already consumed without recoverable generation evidence. A new human REDO is required.',updatedAt=? WHERE id=?").run(now(),row.id);
      setLifecycle(db,row,'MANUAL_HOLD_CONSUMED_RETRY',{...lc,reviewer_retry:true,retry_token:String(row.reviewRetryToken||''),automatic_submit_forbidden:true,held_at:now()});
    }
  }
}
function auditRedoState(db){
  const consumed=Number(db.prepare("SELECT COUNT(*) n FROM factory_items WHERE status IN ('draft','regen_wait') AND reviewRetryToken IS NOT NULL AND reviewRetrySubmittedToken=reviewRetryToken").get()?.n||0);
  if(consumed)throw new Error('REDO_STATE_INVARIANT_FAILED:'+consumed);
}

function productionCandidate(db){
  const running=db.prepare("SELECT * FROM factory_items WHERE status='generating' AND nextTry<=? ORDER BY episode LIMIT 1").get(Date.now());if(running)return running;
  const retries=db.prepare("SELECT * FROM factory_items WHERE status IN ('draft','regen_wait') AND retryStrategy IN ('reuse_prompt','revise_prompt') AND reviewFeedback IS NOT NULL ORDER BY updatedAt,episode LIMIT 100").all();
  const retry=retries.find(row=>serialReady(db,row)&&isReviewerRetry(row));if(retry)return retry;
  const rows=db.prepare("SELECT * FROM factory_items WHERE status IN ('draft','regen_wait') AND nextTry<=? AND (reviewFeedback IS NULL OR TRIM(reviewFeedback)='') ORDER BY episode LIMIT 100").all(Date.now());
  return rows.find(row=>serialReady(db,row))||null;
}
async function runProvider(){
  if(bootstrapOwnsProfile()){publish('AUTH_BOOTSTRAP_ACTIVE',{message:'Flow bootstrap owns the persistent browser profile; provider is paused.'});return}
  if(!acquireLock())return;let db,row=null;
  try{
    if(!fs.existsSync(DB_PATH)){publish('WAITING_FOR_DB',{message:'Runtime database not ready yet.'});return}
    db=dbOpen();ensureSchema(db);ensureProductionPlan(db);reconcileGenerationCreditAccounting(db);ensureBacklog(db);normalizeConsumedReviewerRetries(db);auditRedoState(db);
    setMeta(db,'automation:provider',PROVIDER);setMeta(db,'automation:paidDependencyDetected','false');setMeta(db,'automation:tinyfishRequired','false');setMeta(db,'automation:tinyfishFallback','disabled');setMeta(db,'automation:freeBrowserProfile',PROFILE_DIR);
    const migrated=await migrateProfileOnce(db);if(!migrated)return;
    const used=dailyGenerationCount(db);row=productionCandidate(db);
    if(row&&String(row.status)==='generating'){publish('RECOVERY_PICKED',{episode:'E'+row.episode,job_id:row.id,state:String(lifecycle(db,row)?.state||''),used_today:used});await processRow(db,row);return}
    const priorityRetry=isReviewerRetry(row);
    if(used>=DAILY_PRODUCTION_LIMIT&&!priorityRetry){if(row&&String(lifecycle(db,row)?.state||'').toUpperCase()!=='PREFLIGHT_PASSED'){publish('NEXT_DAY_PREFLIGHT',{episode:'E'+row.episode,job_id:row.id,message:'Daily target complete; validating next job without Send.'});await processRow(db,row);return}setMeta(db,'flow:state','ESPERANDO CRÉDITOS');setMeta(db,'flow:currentStep','daily-limit');setMeta(db,'flow:message','Daily production complete: '+used+'/'+DAILY_PRODUCTION_LIMIT+'.');publish('DAILY_LIMIT',{used,limit:DAILY_PRODUCTION_LIMIT,day:artDay(),next_episode:row?('E'+row.episode):null});return}
    if(!row){ensureBacklog(db);row=productionCandidate(db);if(!row){setMeta(db,'flow:state','CONECTADO');setMeta(db,'flow:currentStep','idle');publish('IDLE',{message:'No production candidate yet.'});return}}
    publish(priorityRetry?'REVIEW_RETRY_PICKED':'PRODUCTION_PICKED',{episode:'E'+row.episode,job_id:row.id,used_today:used,remaining_today:Math.max(0,DAILY_PRODUCTION_LIMIT-used),daily_limit_bypassed:priorityRetry});await processRow(db,row);
  }catch(err){
    const message=compact(err?.stack||err?.message||err,900);
    try{if(db&&row){const fresh=db.prepare('SELECT * FROM factory_items WHERE id=?').get(row.id)||row,lc=lifecycle(db,fresh)||{},state=String(lc.state||'').toUpperCase(),attempts=Number(fresh.runtimeAttemptCount||0)+1,backoff=Math.min(60*60*1000,60000*Math.pow(2,Math.min(attempts-1,6))),nextTry=Date.now()+backoff;if(/FLOW_GENERATION_FAILED/.test(message)){db.prepare("UPDATE factory_items SET status='failed_after_generate',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=0,updatedAt=? WHERE id=?").run(attempts,now(),message,now(),fresh.id);setLifecycle(db,fresh,'FAILED_AFTER_GENERATE',{last_error:message,attempt_count:attempts})}else if(AFTER_GENERATE.has(state)){db.prepare("UPDATE factory_items SET status='generating',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id);setLifecycle(db,fresh,'RETRIEVAL_PENDING',{...lc,last_error:message,attempt_count:attempts,retry_at:new Date(nextTry).toISOString()})}else if(AMBIGUOUS.has(state)){db.prepare("UPDATE factory_items SET status='generating',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id)}else{db.prepare("UPDATE factory_items SET status='draft',runtimeAttemptCount=?,lastProgressAt=?,error=?,nextTry=?,updatedAt=? WHERE id=?").run(attempts,now(),message,nextTry,now(),fresh.id);setLifecycle(db,fresh,'FAILED_BEFORE_GENERATE',{last_error:message,attempt_count:attempts,retry_at:new Date(nextTry).toISOString()})}}if(db){setMeta(db,'flow:state',/FLOW_AUTH/.test(message)?'REQUIERE REAUTENTICACIÓN':'ERROR');setMeta(db,'flow:message',message)}}catch{}publish('ERROR',{message,episode:row?('E'+row.episode):null});
  }finally{try{db?.close()}catch{}releaseLock()}
}
globalThis.__publisherRunProvider=()=>{void runProvider();};
setTimeout(()=>{void runProvider()},12000);
setInterval(()=>{void runProvider()},20*1000).unref();
