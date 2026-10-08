import {spawnSync} from 'node:child_process';

const target=String(process.env.MIGRATION_TARGET||'').trim().toLowerCase();
if(!['earth','frutti','dinnie'].includes(target))throw new Error('INVALID_TARGET');
const aud='publisher-factory-railway-volume-migration';
const oidcBase=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
const oidcReq=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
if(!oidcBase||!oidcReq)throw new Error('GITHUB_OIDC_UNAVAILABLE');

const oidcUrl=oidcBase+(oidcBase.includes('?')?'&':'?')+'audience='+encodeURIComponent(aud);
const oidcRes=await fetch(oidcUrl,{headers:{authorization:'Bearer '+oidcReq}});
if(!oidcRes.ok)throw new Error('OIDC_'+oidcRes.status);
const oidc=String((await oidcRes.json()).value||'');
if(!oidc)throw new Error('OIDC_VALUE_MISSING');

const edge='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-railway-volume-migration';
const cfgRes=await fetch(edge+'/config/'+target,{headers:{authorization:'Bearer '+oidc}});
if(!cfgRes.ok)throw new Error('MIGRATION_CONFIG_'+cfgRes.status+' '+(await cfgRes.text()).slice(0,300));
const cfg=await cfgRes.json();
const token=String(cfg.railway_api_token||'');
if(!token)throw new Error('RAILWAY_API_TOKEN_MISSING');
console.log('::add-mask::'+token);

const env={...process.env,RAILWAY_API_TOKEN:token};
const run=(args)=>{
  const x=spawnSync('railway',args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(x.status!==0)throw new Error('RAILWAY_CLI_FAILED '+args.join(' ')+' :: '+String(x.stderr||x.stdout||'').slice(-1500));
  return String(x.stdout||'');
};

run(['link','--project',cfg.project_id,'--environment',cfg.environment_id,'--service',cfg.service_id]);
const raw=run(['variable','list','--json']);
let vars={};
try{vars=JSON.parse(raw)||{}}catch{throw new Error('RAILWAY_VARIABLE_JSON_INVALID')}
const embeddedRaw=String(vars.PUBLISHER_CONFIG_JSON||'').trim();
if(!embeddedRaw){
  console.log('CONFIG_IMPORT_SKIPPED '+JSON.stringify({target,reason:'missing PUBLISHER_CONFIG_JSON'}));
  process.exit(0);
}
let embedded;
try{embedded=JSON.parse(embeddedRaw)}catch{throw new Error('PUBLISHER_CONFIG_JSON_INVALID')}

const imp=await fetch(edge+'/import/'+target,{
  method:'POST',
  headers:{authorization:'Bearer '+oidc,'content-type':'application/json'},
  body:JSON.stringify({config:embedded})
});
if(!imp.ok)throw new Error('CONFIG_IMPORT_'+imp.status+' '+(await imp.text()).slice(0,500));
const result=await imp.json();
console.log('CONFIG_IMPORT_OK '+JSON.stringify({
  target,
  creative_bible_length:Number(result.creative_bible_length||0),
  canon_length:Number(result.canon_length||0),
  characters:Number(result.characters||0)
}));
