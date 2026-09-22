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
function b64(v){return Buffer.from(String(v),'utf8').toString('base64')}
function metadata(bucket,p){
  return ['bucketName '+b64(bucket),'objectName '+b64(p),'contentType '+b64('video/mp4'),'cacheControl '+b64('3600')].join(',');
}
async function tusUpload(localPath,grant){
  const size=fs.statSync(localPath).size;
  const create=await fetch(grant.tusEndpoint,{
    method:'POST',
    signal:AbortSignal.timeout(90000),
    headers:{'Tus-Resumable':'1.0.0','Upload-Length':String(size),'Upload-Metadata':metadata(grant.bucket,grant.path),'x-signature':String(grant.token),'x-upsert':'true'}
  });
  if(!create.ok)throw new Error('REVIEW_STORAGE_TUS_CREATE_FAILED:'+create.status+':'+(await create.text().catch(()=>'' )).slice(0,300));
  const location=create.headers.get('location');
  if(!location)throw new Error('REVIEW_STORAGE_TUS_LOCATION_MISSING');
  const uploadUrl=new URL(location,grant.tusEndpoint).toString();
  const fd=fs.openSync(localPath,'r');
  try{
    let offset=Number(create.headers.get('upload-offset')||0);
    while(offset<size){
      const end=Math.min(size,offset+CHUNK),buf=Buffer.alloc(end-offset);
      const n=fs.readSync(fd,buf,0,buf.length,offset);
      if(n!==buf.length)throw new Error('REVIEW_STORAGE_LOCAL_READ_SHORT');
      const patch=await fetch(uploadUrl,{
        method:'PATCH',signal:AbortSignal.timeout(120000),
        headers:{'Tus-Resumable':'1.0.0','Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream','Content-Length':String(buf.length),'x-signature':String(grant.token)},
        body:buf
      });
      if(!patch.ok)throw new Error('REVIEW_STORAGE_TUS_PATCH_FAILED:'+patch.status+':'+(await patch.text().catch(()=>'' )).slice(0,300));
      const next=Number(patch.headers.get('upload-offset')||end);
      if(!Number.isSafeInteger(next)||next<=offset)throw new Error('REVIEW_STORAGE_TUS_OFFSET_INVALID');
      offset=next;
    }
  }finally{fs.closeSync(fd)}
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
  const size=await tusUpload(localPath,grant);
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
