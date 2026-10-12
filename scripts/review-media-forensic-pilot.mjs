import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const edge='https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-media-forensic-pilot';
const audience='publisher-factory-media-forensics-20261012';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'publisher-forensic-pilot-'));
const requestUrl=process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'';
const requestToken=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||'';
if(!requestUrl||!requestToken)throw Error('MISSING_SIGNED_WORKFLOW_IDENTITY');
const oidc=await fetch(requestUrl+(requestUrl.includes('?')?'&':'?')+'audience='+encodeURIComponent(audience),{headers:{authorization:'Bearer '+requestToken}});
if(!oidc.ok)throw Error('OIDC_REQUEST_FAILED_'+oidc.status);
const jwt=String((await oidc.json()).value||'');
if(!jwt)throw Error('OIDC_EMPTY');
const headers={authorization:'Bearer '+jwt};
async function request(endpoint,options={}){
 const response=await fetch(edge+endpoint,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(20000)});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw Error('FORENSIC_BROKER_'+endpoint+'_'+response.status+':'+String(body.error||'').slice(0,100));
 return body;
}
function run(program,args,{allowFailure=false,timeout=120000}={}){
 const result=spawnSync(program,args,{encoding:'utf8',timeout,maxBuffer:2e6});
 if(result.error||result.status!==0&&!allowFailure)throw Error(program+'_FAILED_'+(result.error?.message||result.status)+':'+String(result.stderr||'').slice(0,250));
 return result;
}
const catalog=(await request('/samples')).samples;
if(!Array.isArray(catalog)||catalog.length!==3)throw Error('SAMPLE_LIST_UNEXPECTED');
async function upload(index,type,file){
 const grant=await request('/result/'+index,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type})});
 const data=fs.readFileSync(file);
 const response=await fetch(grant.signedUrl,{method:'PUT',body:data,headers:{'content-type':type.endsWith('.jpg')?'image/jpeg':'application/json','x-upsert':'false'},signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw Error('PRIVATE_RESULT_UPLOAD_'+index+'_'+type+'_'+response.status+':'+(await response.text()).slice(0,200));
 return{objectKey:grant.objectKey,bytes:data.length};
}
try {
 for(const sample of catalog){
  const index=Number(sample.index);
  if(!Number.isInteger(index)||index<0||index>2)throw Error('SAMPLE_ID_UNEXPECTED');
  const signed=await request('/source/'+index);
  if(signed.key!==sample.key)throw Error('INPUT_KEY_MISMATCH');
  const media=await fetch(signed.signedUrl,{signal:AbortSignal.timeout(120000)});
  if(!media.ok)throw Error('SIGNED_MEDIA_READ_FAILED_'+media.status);
  const buffer=Buffer.from(await media.arrayBuffer());
  if(buffer.length<1000||buffer.length>80000000)throw Error('INVALID_MP4_BYTES_'+buffer.length);
  const local=path.join(root,'source-'+index+'.mp4');
  const sheet=path.join(root,'contact-'+index+'.jpg');
  const reportPath=path.join(root,'report-'+index+'.json');
  fs.writeFileSync(local,buffer,{mode:0o600});
  const sha256=createHash('sha256').update(buffer).digest('hex');
  const probed=run('ffprobe',['-v','quiet','-print_format','json','-show_streams','-show_format',local]);
  const meta=JSON.parse(probed.stdout);
  const video=(meta.streams||[]).find(s=>s.codec_type==='video');
  const hasAudio=(meta.streams||[]).some(s=>s.codec_type==='audio');
  if(!video)throw Error('NO_VIDEO_STREAM_'+index);
  const frames=run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',local,'-vf','fps=1/2,scale=360:-2,tile=2x2:padding=8:margin=8','-frames:v','1','-q:v','4',sheet],{allowFailure:true});
  const contactAvailable=frames.status===0&&fs.existsSync(sheet)&&fs.statSync(sheet).size>1000;
  const wav=path.join(root,'audio-'+index+'.wav');
  const audioResult=hasAudio?run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',local,'-vn','-ac','1','-ar','16000',wav],{allowFailure:true}):null;
  const audioReadable=hasAudio&&audioResult?.status===0&&fs.existsSync(wav)&&fs.statSync(wav).size>1000;
  const technical={
   object_key:sample.key,sha256,bytes:buffer.length,duration_seconds:Number(meta.format?.duration||video.duration||0),
   video:{codec:video.codec_name,width:video.width,height:video.height},audio_present:hasAudio,audio_readable:audioReadable,
   transcription_pending:audioReadable
  };
  fs.writeFileSync(reportPath,JSON.stringify(technical,null,2));
  console.log('FORENSIC_MEDIA_PREPARED',JSON.stringify({index,bytes:buffer.length,duration:technical.duration_seconds,audioReadable,contactAvailable,sha256_prefix:sha256.slice(0,12)}));
  // Never print dialogue or frame contents into public GitHub logs.
 }
 const transcription=run('python3',['scripts/whisper_legacy_media.py',root],{allowFailure:true,timeout:660000});
 console.log('LOCAL_WHISPER_JOB',JSON.stringify({ok:transcription.status===0,exit:transcription.status}));
 for(const sample of catalog){
  const index=Number(sample.index);
  const report=path.join(root,'report-'+index+'.json'),sheet=path.join(root,'contact-'+index+'.jpg');
  const uploaded=await upload(index,'report.json',report);
  let photo=false;
  if(fs.existsSync(sheet)&&fs.statSync(sheet).size>1000){await upload(index,'contact.jpg',sheet);photo=true}
  const finalReport=JSON.parse(fs.readFileSync(report,'utf8'));
  console.log('FORENSIC_PRIVATE_OUTPUT',JSON.stringify({index,sha256_prefix:String(finalReport.sha256).slice(0,12),report:uploaded.objectKey,photo,has_transcript:Boolean(finalReport.transcript?.trim()),transcript_language:finalReport.transcript_language||null}));
 }
}finally {
 fs.rmSync(root,{force:true,recursive:true});
}
