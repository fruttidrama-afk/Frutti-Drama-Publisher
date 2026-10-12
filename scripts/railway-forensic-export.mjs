import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";

const target=String(process.env.FORENSIC_TARGET||"").toLowerCase();
if(!["frutti","earth","dinnie"].includes(target))throw Error("INVALID_TARGET");
const base="https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-railway-volume-migration/forensic-export/";
const oidcUrl=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,oidcReq=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if(!oidcUrl||!oidcReq)throw Error("OIDC_MISSING");
const res=await fetch(oidcUrl+(oidcUrl.includes("?")?"&":"?")+"audience=publisher-factory-railway-volume-migration",{headers:{authorization:"Bearer "+oidcReq},signal:AbortSignal.timeout(10000)});
if(!res.ok)throw Error("OIDC_FETCH_FAILED");
const jwt=String((await res.json()).value||"");
const configResponse=await fetch(base+target,{headers:{authorization:"Bearer "+jwt},signal:AbortSignal.timeout(20000)});
if(!configResponse.ok)throw Error("FORENSIC_CONFIG_UNAVAILABLE_"+configResponse.status);
const cfg=await configResponse.json(),railwayToken=String(cfg.railway_api_token||"");
if(!railwayToken)throw Error("FORENSIC_RAILWAY_TOKEN_MISSING");
console.log("::add-mask::"+railwayToken);
const env={...process.env,RAILWAY_API_TOKEN:railwayToken};
function cli(args,allowFailure=false,timeout=40000){
 const r=spawnSync("railway",args,{encoding:"utf8",env,stdio:["ignore","pipe","pipe"],timeout});
 if(r.status!==0&&!allowFailure)throw Error("RAILWAY_READ_FAILED_"+args[0]+"_"+r.status);
 return r;
}
cli(["link","--project",cfg.project_id,"--environment",cfg.environment_id,"--service",cfg.service_id]);
const vol=String(cfg.volume_id);
const root=fs.mkdtempSync(path.join(os.tmpdir(),"pf-forensic-"));
const candidates=[
 "/frutti-factory/factory.sqlite",
 "/earth-factory/factory.sqlite",
 "/dinnie-factory/factory.sqlite",
 "/publisher-runtime/factory.sqlite",
 "/publisher-factory/factory.sqlite",
 "/factory.sqlite",
 "/data/frutti-factory/factory.sqlite",
 "/data/earth-factory/factory.sqlite",
 "/data/publisher-runtime/factory.sqlite",
 "/frutti-factory/stock.sqlite",
 "/earth-factory/stock.sqlite"
];
const run=String(process.env.GITHUB_RUN_ID||"");if(!/^\d{8,15}$/.test(run))throw Error("RUN_ID");
let recovered=0;
const logs=[];
try{
 // Railway volume file listing is read-only; print only filenames ending in sqlite for diagnostics.
 for(const folder of ["/","/frutti-factory","/earth-factory","/dinnie-factory","/publisher-runtime"]){
  const r=cli(["volume","files","--volume",vol,"list",folder,"--json"],true);
  if(r.status===0){
   const safe=String(r.stdout||"").split("\n").filter(s=>/factory|sqlite|publication|stock|earth|frutti|dinnie|publisher/i.test(s)&&!/token|secret|auth|profile|cookie|credential/i.test(s)).slice(0,22);
   console.log("VOLUME_READONLY_LIST",JSON.stringify({target,folder,lines:safe.map(s=>s.slice(0,200))}));
  }else console.log("VOLUME_READONLY_LIST_FAILED",JSON.stringify({target,folder,status:r.status}));
 }
 for(const db of candidates){
  const stem=db.slice(1).replaceAll("/","_");
  const local=path.join(root,stem);
  const r=cli(["volume","files","--volume",vol,"download",db,local],true,65000);
  if(r.status!==0||!fs.existsSync(local)||fs.statSync(local).size<1024)continue;
  const bytes=fs.readFileSync(local);
  if(!bytes.subarray(0,16).equals(Buffer.from("SQLite format 3\0"))){fs.rmSync(local,{force:true});continue}
  for(const suffix of ["","-wal","-shm"]){
   let src=local,filename=stem;
   if(suffix){
    src=local+suffix;filename=stem+suffix;
    const extra=cli(["volume","files","--volume",vol,"download",db+suffix,src],true,65000);
    if(extra.status!==0||!fs.existsSync(src)||!fs.statSync(src).size)continue;
   }
   const file=fs.readFileSync(src),hash=createHash("sha256").update(file).digest("hex");
   const metadata={filename,run,bytes:file.byteLength,sha256:hash};
   const sign=await fetch(base+target,{method:"POST",headers:{authorization:"Bearer "+jwt,"content-type":"application/json"},body:JSON.stringify(metadata),signal:AbortSignal.timeout(20000)});
   if(!sign.ok)throw Error("FORENSIC_UPLOAD_NOT_AUTHORIZED_"+sign.status);
   const grant=await sign.json();
   const response=await fetch(grant.signed_url,{method:"PUT",headers:{"content-type":"application/octet-stream","x-upsert":"false"},body:file,signal:AbortSignal.timeout(120000)});
   if(!response.ok)throw Error("FORENSIC_UPLOAD_FAILED_"+response.status);
   const evidence={path:db+suffix,object_key:String(grant.object_key||""),size:file.byteLength,sha256:hash};
   logs.push(evidence);recovered++;
   console.log("FORENSIC_PRESERVED_SQLITE",JSON.stringify({target,...evidence}));
  }
  // The original on-disk SQLite may have concurrent WAL data. Copy all three companions without opening it.
 }
 console.log("FORENSIC_EXPORT_RESULT",JSON.stringify({target,recovered,files:logs}));
 if(!recovered)throw Error("NO_SQLITE_EXPORTED");
}finally{
 fs.rmSync(root,{force:true,recursive:true});
}
