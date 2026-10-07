import fs from 'node:fs';
import path from 'node:path';

const MODE=String(process.argv[2]||'').trim();
const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-flow-bootstrap';
const AUD='publisher-factory-flow-bootstrap';
const CONFIG_FILE=path.resolve(process.env.RUNNER_TEMP||'/tmp','flow-bootstrap-config.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function oidc(){
  const base=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
  const req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
  if(!base||!req)throw new Error('GITHUB_OIDC_UNAVAILABLE');
  const url=base+(base.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD);
  const r=await fetch(url,{headers:{authorization:'Bearer '+req}});
  if(!r.ok)throw new Error('OIDC_'+r.status);
  const j=await r.json();
  if(!j.value)throw new Error('OIDC_VALUE_MISSING');
  return String(j.value);
}
async function api(suffix,options={}){
  const token=await oidc();
  return fetch(EDGE+suffix,{...options,headers:{authorization:'Bearer '+token,...(options.headers||{})}});
}
async function getConfig(){
  const r=await api('/config');
  if(!r.ok)throw new Error('CONFIG_'+r.status+' '+(await r.text()).slice(0,500));
  const j=await r.json();
  fs.writeFileSync(CONFIG_FILE,JSON.stringify(j,null,2));
  return j;
}
async function announce(){
  const url=String(process.env.FLOW_BOOTSTRAP_URL||'').trim();
  const password=String(process.env.FLOW_BOOTSTRAP_PASSWORD||'').trim();
  const r=await api('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,password})});
  if(!r.ok)throw new Error('SESSION_ANNOUNCE_'+r.status+' '+(await r.text()).slice(0,500));
  console.log('SESSION_ANNOUNCED');
}
async function waitSignal(){
  const deadline=Date.now()+50*60*1000;
  while(Date.now()<deadline){
    const cfg=await getConfig();
    const rows=Array.isArray(cfg.targets)?cfg.targets:[];
    if(rows.some(x=>String(x.migration_state||'')==='capture_requested')){
      console.log('CAPTURE_REQUESTED');
      return;
    }
    await sleep(3000);
  }
  throw new Error('CAPTURE_SIGNAL_TIMEOUT');
}
async function upload(){
  const tar=String(process.env.FLOW_BOOTSTRAP_ARCHIVE||'');
  if(!tar||!fs.existsSync(tar))throw new Error('PROFILE_ARCHIVE_MISSING');
  const r=await api('/profile',{method:'PUT',headers:{'content-type':'application/gzip'},body:fs.readFileSync(tar)});
  if(!r.ok)throw new Error('PROFILE_UPLOAD_'+r.status+' '+(await r.text()).slice(0,500));
  console.log('PROFILE_UPLOAD_OK',await r.text());
}

if(MODE==='config'){
  const j=await getConfig();
  process.stdout.write(String(j.start_url||'https://flow.google.com/'));
}else if(MODE==='announce'){
  await announce();
}else if(MODE==='waitsignal'){
  await waitSignal();
}else if(MODE==='upload'){
  await upload();
}else{
  throw new Error('MODE must be config|announce|waitsignal|upload');
}
// BOOTSTRAP_SIGNAL_PROTOCOL: v1
