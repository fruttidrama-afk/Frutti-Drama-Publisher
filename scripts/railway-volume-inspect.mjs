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

const endpoint='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-railway-volume-migration/config/'+target;
const r=await fetch(endpoint,{headers:{authorization:'Bearer '+oidc}});
if(!r.ok)throw new Error('MIGRATION_CONFIG_'+r.status+' '+(await r.text()).slice(0,300));
const cfg=await r.json();
const token=String(cfg.railway_api_token||'');
if(!token)throw new Error('RAILWAY_API_TOKEN_MISSING');
console.log('::add-mask::'+token);

const env={...process.env,RAILWAY_API_TOKEN:token};
const run=(args,{capture=false}={})=>{
  const x=spawnSync('railway',args,{env,encoding:'utf8',stdio:capture?['ignore','pipe','pipe']:'inherit'});
  if(x.status!==0){
    const e=(x.stderr||x.stdout||'').slice(-2000);
    throw new Error('RAILWAY_CLI_FAILED '+args.join(' ')+' :: '+e);
  }
  return String(x.stdout||'');
};

console.log('Inspecting Railway volume metadata for',target);
run(['link','--project',cfg.project_id,'--environment',cfg.environment_id,'--service',cfg.service_id]);
const listing=run(['volume','files','--volume',cfg.volume_id,'list','/','--json'],{capture:true});
let parsed;try{parsed=JSON.parse(listing)}catch{parsed={raw:listing.slice(0,20000)}}
console.log(JSON.stringify({target,project_id:cfg.project_id,environment_id:cfg.environment_id,service_id:cfg.service_id,volume_id:cfg.volume_id,listing:parsed},null,2));
