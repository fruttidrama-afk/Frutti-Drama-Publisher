import fs from 'node:fs';
import {createHash} from 'node:crypto';
const base='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-media-forensic-pilot';
const requestUrl=process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'';
const requestToken=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'';
if(!requestUrl||!requestToken)throw Error('OIDC_REQUIRED');
const identity=await fetch(requestUrl+(requestUrl.includes('?')?'&':'?')+'audience=publisher-factory-media-forensics-20261012',{headers:{authorization:'Bearer '+requestToken},signal:AbortSignal.timeout(12000)});
if(!identity.ok)throw Error('OIDC_FAILED_'+identity.status);
const token=String((await identity.json()).value||'');
const headers={authorization:'Bearer '+token};
async function api(route,options={}){
 const response=await fetch(base+route,{...options,headers:{...headers,...(options.headers||{})},signal:AbortSignal.timeout(25000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error('INDEX_API_'+route+'_'+response.status+':'+String(data.error||'').slice(0,100));
 return data;
}
const {samples}=await api('/samples');
let saved=0;
for(const sample of samples){
 const index=Number(sample.index);
 const grant=await api('/result/'+index+'?type=report.json');
 const file=await fetch(grant.signedUrl,{signal:AbortSignal.timeout(25000)});
 if(!file.ok)throw Error('PRIVATE_REPORT_READ_'+index+'_'+file.status);
 const payload=await file.json();
 if(payload.object_key!==sample.key||!(/^[a-f0-9]{64}$/.test(String(payload.sha256||''))))throw Error('PRIVATE_REPORT_INTEGRITY_'+index);
 const reply=await api('/metadata/'+index,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
 if(reply.registered!==true||reply.private!==true)throw Error('PRIVATE_INDEX_REJECTED_'+index);
 console.log('PRIVATE_TRANSCRIPT_INDEXED',JSON.stringify({index,bytes:payload.bytes,duration_seconds:payload.duration_seconds,spanish:payload.transcript_language==='es',transcribed_characters:String(payload.transcript||'').length,sha256_prefix:payload.sha256.slice(0,12)}));
 saved++;
}
if(saved!==3)throw Error('PRIVATE_INDEX_INCOMPLETE');
