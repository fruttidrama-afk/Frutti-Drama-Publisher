import fs from 'node:fs';

const BROKER=String(process.env.PUBLISHER_REVIEW_STORAGE_URL||'').trim();
const PUBLISHER_ID=String(process.env.PUBLISHER_REVIEW_STORAGE_ID||'').trim();
const TOKEN=String(process.env.PUBLISHER_REVIEW_STORAGE_TOKEN||'').trim();
const REQUIRED=String(process.env.PUBLISHER_REVIEW_STORAGE_REQUIRED||'false').toLowerCase()==='true';
const PREFIX='review-storage://';
const CHUNK=6*1024*1024;

export function reviewStorageConfigured(){return Boolean(BROKER&&PUBLISHER_ID&&TOKEN)}
export function reviewStorageRequired(){return REQUIRED}
export function isReviewStorageUri(v){return String(v||'').startsWith(PREFIX)}
export function reviewStoragePath(v){return isReviewStorageUri(v)?decodeURIComponent(String(v).slice(PREFIX.length)):''}
export function reviewStorageUri(p){return PREFIX+encodeURIComponent(String(p||''))}

async function broker(action,body={}){
  if(!reviewStorageConfigured())throw new Error('REVIEW_STORAGE_NOT_CONFIGURED');
  const r=await fetch(BROKER,{
    method:'POST',
    signal:AbortSignal.timeout(90000),
    headers:{'content-type':'application/json','x-publisher-id':PUBLISHER_ID,'x-storage-token':TOKEN},
    body:JSON.stringify({action,...body})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j?.ok)throw new Error('REVIEW_STORAGE_'+String(action).toUpperCase()+'_FAILED:'+String(j?.error||r.status));
  return j;
}
async function uploadViaSignedUrl(localPath,grant){
  if(!grant?.signedUrl)throw new Error('REVIEW_STORAGE_SIGNED_URL_MISSING');
  const size=fs.statSync(localPath).size;
  const body=fs.createReadStream(localPath);
  const r=await fetch(grant.signedUrl,{
    method:'PUT',
    signal:AbortSignal.timeout(10*60*1000),
    headers:{
      'content-type':'video/mp4',
      'content-length':String(size),
      'cache-control':'max-age=3600',
      'x-upsert':'true'
    },
    body,
    duplex:'half'
  });
  if(!r.ok)throw new Error('REVIEW_STORAGE_SIGNED_UPLOAD_FAILED:'+r.status+':'+(await r.text().catch(()=>'' )).slice(0,500));
  return size;
}

export async function uploadReviewFile(localPath,{itemId='review',revision=0}={}){
  if(!reviewStorageConfigured()){
    if(REQUIRED)throw new Error('REVIEW_STORAGE_REQUIRED_NOT_CONFIGURED');
    return null;
  }
  if(!localPath||!fs.existsSync(localPath))throw new Error('REVIEW_STORAGE_LOCAL_FILE_MISSING');
  const safe=String(itemId||'review').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120)||'review';
  const objectName=safe+'-r'+Math.max(0,Number(revision||0))+'-'+Date.now()+'.mp4';
  const grant=await broker('upload-token',{objectName});
  const size=await uploadViaSignedUrl(localPath,grant);
  return{uri:reviewStorageUri(grant.path),path:grant.path,size,provider:'supabase'};
}
export async function signedReviewUrl(uri,expiresIn=3600){
  if(!isReviewStorageUri(uri))throw new Error('REVIEW_STORAGE_URI_INVALID');
  const j=await broker('read-url',{path:reviewStoragePath(uri),expiresIn});
  return String(j.signedUrl||'');
}
export async function deleteReviewObject(uri){
  if(!isReviewStorageUri(uri)||!reviewStorageConfigured())return false;
  await broker('delete',{path:reviewStoragePath(uri)});
  return true;
}
export async function readReviewRange(uri,start,end){
  const url=await signedReviewUrl(uri,1800);
  const r=await fetch(url,{headers:{Range:'bytes='+start+'-'+end},signal:AbortSignal.timeout(120000)});
  if(!r.ok&&r.status!==206)throw new Error('REVIEW_STORAGE_RANGE_FAILED:'+r.status);
  let b=Buffer.from(await r.arrayBuffer());
  const wanted=end-start+1;
  if(r.status===200&&b.length>wanted)b=b.subarray(start,start+wanted);
  if(b.length!==wanted)throw new Error('REVIEW_STORAGE_RANGE_LENGTH:'+b.length+'/'+wanted);
  return b;
}
