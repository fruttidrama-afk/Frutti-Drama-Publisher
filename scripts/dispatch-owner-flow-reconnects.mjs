// Dispatch only owner-requested Google Flow login sessions from the existing
// five-minute free-runtime scheduler. This script never generates or publishes.
const EDGE='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-flow-account-bootstrap-v2';
const AUD='publisher-factory-flow-account-bootstrap-v2';
const REPO='fruttidrama-afk/Frutti-Drama-Publisher';
const keys=['frutti','earth','dinnie'];
async function identity(){
 const url=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
 const req=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'');
 if(!url||!req)throw Error('GITHUB_OIDC_UNAVAILABLE');
 const r=await fetch(url+(url.includes('?')?'&':'?')+'audience='+encodeURIComponent(AUD),{headers:{authorization:'Bearer '+req}});
 if(!r.ok)throw Error('OIDC_HTTP_'+r.status);
 const x=await r.json();if(!x.value)throw Error('OIDC_EMPTY');return x.value;
}
const gh=String(process.env.GH_BOOTSTRAP_TOKEN||'');
if(!gh)throw Error('GITHUB_DISPATCH_TOKEN_NOT_AVAILABLE');
const token=await identity();
const result=[];
for(const key of keys){
 const claim=await fetch(EDGE+'/claim/'+key,{method:'POST',headers:{authorization:'Bearer '+token}});
 if(!claim.ok)throw Error('LOGIN_REQUEST_CLAIM_FAILED_'+key+'_'+claim.status);
 const j=await claim.json();
 if(!j.launch){result.push({publisher:key,status:'idle'});continue}
 let dispatched=false;
 try{
  const response=await fetch('https://api.github.com/repos/'+REPO+'/actions/workflows/bootstrap-flow-'+key+'-v2.yml/dispatches',{
   method:'POST',
   headers:{authorization:'Bearer '+gh,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','content-type':'application/json'},
   body:JSON.stringify({ref:'main'})
  });
  if(response.status!==204)throw Error('GITHUB_WORKFLOW_DISPATCH_'+key+'_'+response.status);
  dispatched=true;result.push({publisher:key,status:'accepted'});
 }finally{
  if(!dispatched){
   const r=await fetch(EDGE+'/release/'+key,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({claim_id:j.claim_id})});
   if(!r.ok)console.error('LOGIN_REQUEST_RELEASE_FAILED',key,r.status);
  }
 }
}
console.log('OWNER_REQUESTED_FLOW_RECONNECTIONS',JSON.stringify(result));
