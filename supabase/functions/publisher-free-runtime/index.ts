// Mirror of LIVE Supabase Edge publisher-free-runtime v11 (2026-11-09).
// Auth: GitHub OIDC / Supabase service role. No stored tokens or sensitive values.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {auth:{persistSession:false,autoRefreshToken:false}}
);
const BUCKET="publisher-runtime-state";
const AUD="publisher-factory-free-runtime";
const REPO="fruttidrama-afk/Frutti-Drama-Publisher";
const WORKFLOW_PATH=".github/workflows/free-runtime-runner.yml";
const CORS={"content-type":"application/json","cache-control":"no-store"};
const J=(x:any,s=200)=>new Response(JSON.stringify(x),{status:s,headers:CORS});
const now=()=>new Date().toISOString();

function b64url(s:string){
  const p=s.replace(/-/g,"+").replace(/_/g,"/");
  const pad=p+"=".repeat((4-p.length%4)%4);
  return Uint8Array.from(atob(pad),c=>c.charCodeAt(0));
}
function utf8(bytes:Uint8Array){return new TextDecoder().decode(bytes)}
let oidcCache:{at:number,keys:any[]}|null=null;
async function githubKeys(){
  if(oidcCache&&Date.now()-oidcCache.at<6*60*60*1000)return oidcCache.keys;
  const cfg=await fetch("https://token.actions.githubusercontent.com/.well-known/openid-configuration").then(r=>r.json());
  const jwks=await fetch(String(cfg.jwks_uri)).then(r=>r.json());
  oidcCache={at:Date.now(),keys:Array.isArray(jwks.keys)?jwks.keys:[]};
  return oidcCache.keys;
}
async function githubIdentity(req:Request){
  const h=String(req.headers.get("authorization")||"");
  if(!h.startsWith("Bearer "))throw new Error("OIDC_REQUIRED");
  const jwt=h.slice(7),parts=jwt.split(".");
  if(parts.length!==3)throw new Error("OIDC_MALFORMED");
  const header=JSON.parse(utf8(b64url(parts[0])));
  const claims=JSON.parse(utf8(b64url(parts[1])));
  if(header.alg!=="RS256"||!header.kid)throw new Error("OIDC_ALG");
  const jwk=(await githubKeys()).find((x:any)=>x.kid===header.kid);
  if(!jwk)throw new Error("OIDC_KID");
  const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
  const signed=new TextEncoder().encode(parts[0]+"."+parts[1]);
  const ok=await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,b64url(parts[2]),signed);
  if(!ok)throw new Error("OIDC_SIGNATURE");
  const t=Math.floor(Date.now()/1000);
  if(String(claims.iss)!=="https://token.actions.githubusercontent.com")throw new Error("OIDC_ISS");
  const aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(!aud.includes(AUD))throw new Error("OIDC_AUD");
  if(Number(claims.exp||0)<t-30||Number(claims.nbf||0)>t+30)throw new Error("OIDC_TIME");
  if(String(claims.repository)!==REPO)throw new Error("OIDC_REPO");
  if(String(claims.ref)!=="refs/heads/main")throw new Error("OIDC_REF");
  const wf=String(claims.workflow_ref||"");
  if(!wf.includes(REPO+"/"+WORKFLOW_PATH+"@refs/heads/main"))throw new Error("OIDC_WORKFLOW");
  return claims;
}
function localDay(tz:string){
  const p=new Intl.DateTimeFormat("en-CA",{timeZone:tz||"America/Argentina/Buenos_Aires",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const o=Object.fromEntries(p.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return o.year+"-"+o.month+"-"+o.day;
}
function eachDay(start:string,end:string){
  const out:string[]=[];let d=new Date(start+"T12:00:00Z"),e=new Date(end+"T12:00:00Z");
  for(let i=0;d<=e&&i<370;i++){out.push(d.toISOString().slice(0,10));d=new Date(d.getTime()+86400000)}
  return out;
}
async function materialize(){
  const {data:pubs,error}=await db.from("publisher_runtime_publishers").select("*").eq("enabled",true);
  if(error)throw error;
  for(const p of pubs||[]){
    const today=localDay(String(p.timezone||"America/Argentina/Buenos_Aires"));
    const days=eachDay(String(p.activation_day||today),today);
    for(const day of days){
      const historical=day<today;
      for(let n=1;n<=Number(p.generation_target||3);n++){
        await db.from("publisher_runtime_obligations").upsert({
          publisher_id:p.id,local_day:day,kind:"generation",ordinal:n,
          status:historical?"missed":"pending",updated_at:now()
        },{onConflict:"publisher_id,local_day,kind,ordinal",ignoreDuplicates:true});
      }
      for(let n=1;n<=Number(p.publication_target||1);n++){
        await db.from("publisher_runtime_obligations").upsert({
          publisher_id:p.id,local_day:day,kind:"publication",ordinal:n,
          status:historical?"missed":"pending",updated_at:now()
        },{onConflict:"publisher_id,local_day,kind,ordinal",ignoreDuplicates:true});
      }
    }
  }
}
async function releaseExpired(){
  // A crashed runner might have ALREADY clicked Generate/upload/release.
  // Lease expiry is NOT permission to replay any remote mutation. Only a
  // remote-ID reconciler or proven pre-submit failure may reopen the task.
  const {error}=await db.from("publisher_runtime_obligations")
    .update({status:"blocked",lease_until:null,last_error:"LEASE_EXPIRED_REMOTE_RECONCILIATION_REQUIRED",updated_at:now()})
    .in("status",["claimed","running"])
    .lt("lease_until",now());
  if(error)throw error;
}
function localClock(tz:string){
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:tz||"America/Argentina/Buenos_Aires",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const p=Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return p.hour+":"+p.minute;
}
function publicationDue(p:any){
  if(Number(p.approved_stock||0)<=0)return false;
  const clock=localClock(String(p.timezone||"America/Argentina/Buenos_Aires"));
  if(String(p.platform||"").toLowerCase()==="youtube")
    return(clock>="12:30"&&clock<"13:00")||clock>="19:00";
  const schedule=Array.isArray(p.config?.schedule?.posting_times)?p.config.schedule.posting_times:[];
  const posted=String(schedule[0]||"19:00");
  return clock>=posted;
}
const FLOW_BACKOFF_MINUTES=[30,60,120,240,480,1440] as const;
async function flowCooldown(publisherId:string){
 const x=await db.from("publisher_runtime_flow_cooldowns")
  .select("streak,not_before,last_alert_at,last_alert_claim_id,status")
  .eq("publisher_id",publisherId).maybeSingle();
 if(x.error)throw x.error;
 return x.data;
}
async function recordUnusualActivity(o:any,claimId:string,body:any){
 if(o.kind!=="generation"||body.flow_no_charge_confirmed!==true)
  throw new Error("FLOW_NO_CHARGE_PROOF_REQUIRED");
 // One serializable, row-locked database operation. The prior select/upsert
 // could lose a concurrent 24h deadline, double count or shorten a cooldown.
 const {data,error}=await db.rpc("publisher_flow_record_no_charge",{
  p_publisher_id:o.publisher_id,p_claim_id:claimId,
  p_item_id:String(body.flow_item_id||o.id).slice(0,150)
 });
 if(error)throw error;
 return Array.isArray(data)?data[0]:data;
}
// A new calendar day does not clear an unresolved remote mutation. Older
// lease-expired Generate/upload attempts must be reconciled by remote ID before
// ANY later obligation of the same kind can run. Credit waits and proven
// no-charge rejections are not remote-ambiguity fences.
async function unresolvedRemoteMutation(publisherId:string,kind:string){
  const blocked=await db.from("publisher_runtime_obligations")
    .select("id").eq("publisher_id",publisherId).eq("kind",kind)
    .eq("status","blocked")
    .or("last_error.ilike.%RECONCILIATION_REQUIRED%,last_error.ilike.%SUBMIT_AMBIGUOUS%,last_error.ilike.%REMOTE_ID_UNVERIFIED%")
    .limit(1);
  if(blocked.error)throw blocked.error;
  if((blocked.data||[]).length>0)return true;
  // Historical migration left some expired claims as pending. They are NOT
  // fresh unsubmitted work merely because their status says pending.
  const legacy=await db.from("publisher_runtime_obligations")
    .select("id").eq("publisher_id",publisherId).eq("kind",kind)
    .eq("status","pending").eq("last_error","RUNNER_LEASE_EXPIRED")
    .limit(1);
  if(legacy.error)throw legacy.error;
  return (legacy.data||[]).length>0;
}
async function claim(filterPublisher="",filterKind=""){
  await releaseExpired();await materialize();
  const {data:pubs,error}=await db.from("publisher_runtime_publishers").select("*").eq("enabled",true)
    .order("last_runner_at",{ascending:true,nullsFirst:true}).order("name",{ascending:true});
  if(error)throw error;
  // At each 12:30 / 19:00 window, give actual due publication obligations
  // priority over 22-minute Flow jobs. Other times generation can proceed.
  (pubs||[]).sort((a:any,b:any)=>Number(publicationDue(b))-Number(publicationDue(a)));
  for(const p of pubs||[]){
    if(filterPublisher&&String(p.id)!==filterPublisher)continue;
    // Preserve serialized canon and human-reviewed historic stock during
    // migration. Never spend free Flow credits from an unverified episode
    // mapping, even when a Google login itself has been verified.
    if(p.config?.automation?.historical_reconciliation_pending===true)continue;
    const migrationState=String(p.migration_state||"");
    if(!["ready","profile_uploaded","auth_verified"].includes(migrationState))continue;
    if(migrationState!=="ready"){
      const promote=await db.from("publisher_runtime_publishers")
        .update({migration_state:"ready",updated_at:now()})
        .eq("id",p.id).eq("enabled",true);
      if(promote.error)throw promote.error;
      p.migration_state="ready";
    }
    const active=await db.from("publisher_runtime_obligations").select("id").eq("publisher_id",p.id).in("status",["claimed","running"]).limit(1).maybeSingle();
    if(active.error)throw active.error;
    if(active.data)continue;
    const today=localDay(String(p.timezone||"America/Argentina/Buenos_Aires"));
    const kinds=filterKind?[filterKind]:["publication","generation"];
    for(const kind of kinds){
      if(!["generation","publication"].includes(kind))continue;
      // Per-kind fence: unrelated approved publication may proceed when a
      // generation is ambiguous, but a later Generate cannot skip its ancestor.
      if(await unresolvedRemoteMutation(String(p.id),kind))continue;
      if(kind==="publication"&&!publicationDue(p))continue;
      let q:any={data:null,error:null};
      if(kind==="generation"){
        const cd=await flowCooldown(String(p.id));
        if(cd?.not_before&&Date.parse(cd.not_before)>Date.now())continue;
        q=await db.from("publisher_runtime_obligations")
          .select("*").eq("publisher_id",p.id).eq("kind","generation")
          .eq("status","blocked").eq("last_error","FLOW_UNUSUAL_ACTIVITY_COOLDOWN")
          .order("local_day",{ascending:false}).order("ordinal").limit(1).maybeSingle();
        if(q.error)throw q.error;
      }
      if(!q.data){
        q=await db.from("publisher_runtime_obligations")
          .select("*").eq("publisher_id",p.id).eq("local_day",today).eq("kind",kind).eq("status","pending")
          .order("ordinal").limit(1).maybeSingle();
        if(q.error)throw q.error;
      }

      // Daily free Flow credits are not guaranteed to refresh at local midnight.
      // A WAITING_DAILY_FLOW_CREDIT_REFRESH block is therefore a cooldown, not a terminal state.
      // Re-probe at most once every 30 minutes without authorizing paid credits.
      if(!q.data && kind==="generation"){
        const retryBefore=new Date(Date.now()-30*60*1000).toISOString();
        q=await db.from("publisher_runtime_obligations")
          .select("*").eq("publisher_id",p.id).eq("local_day",today).eq("kind","generation")
          .eq("status","blocked").eq("last_error","WAITING_DAILY_FLOW_CREDIT_REFRESH")
          .lt("updated_at",retryBefore).order("ordinal").limit(1).maybeSingle();
        if(q.error)throw q.error;
      }
      // The 12:30 PRIVATE upload is stage one, not a completed publication.
      // Reclaim the SAME obligation at 19:00 for a single explicit privacy change.
      if(!q.data && kind==="publication" && String(p.platform||"").toLowerCase()==="youtube" && localClock(String(p.timezone||"America/Argentina/Buenos_Aires"))>="19:00"){
        q=await db.from("publisher_runtime_obligations")
          .select("*").eq("publisher_id",p.id).eq("local_day",today).eq("kind","publication")
          .eq("status","blocked").eq("last_error","YOUTUBE_PRIVATE_STAGED_WAITING_19")
          .order("ordinal").limit(1).maybeSingle();
        if(q.error)throw q.error;
      }
      if(!q.data)continue;
      // Defensive migration: old builds requeued expired/ambiguous work as
      // pending with RUNNER_LEASE_EXPIRED. Freeze these rows rather than
      // executing a possibly duplicate Flow Generate or YouTube upload.
      if(String(q.data.last_error||"")==="RUNNER_LEASE_EXPIRED"){
        await db.from("publisher_runtime_obligations").update({
          status:"blocked",last_error:"LEGACY_LEASE_EXPIRED_REMOTE_RECONCILIATION_REQUIRED",lease_until:null,updated_at:now()
        }).eq("id",q.data.id).eq("status","pending");
        continue;
      }
      const claimId=crypto.randomUUID(),lease=new Date(Date.now()+45*60*1000).toISOString();
      const priorStatus=String(q.data.status||"pending");
      const upd=await db.from("publisher_runtime_obligations").update({
        status:"claimed",claim_id:claimId,claimed_at:now(),lease_until:lease,
        attempts:Number(q.data.attempts||0)+1,updated_at:now()
      }).eq("id",q.data.id).eq("status",priorStatus).select("*").maybeSingle();
      if(upd.error)throw upd.error;
      if(!upd.data)continue;
      await db.from("publisher_runtime_publishers").update({last_runner_at:now(),updated_at:now()}).eq("id",p.id);
      return {publisher:p,obligation:upd.data,claim_id:claimId};
    }
  }
  return null;
}
async function callback(body:any){
  const id=String(body.obligation_id||""),claimId=String(body.claim_id||"");
  if(!id||!claimId)throw new Error("CALLBACK_ID_REQUIRED");
  const {data:o,error}=await db.from("publisher_runtime_obligations").select("*").eq("id",id).eq("claim_id",claimId).maybeSingle();
  if(error)throw error;if(!o)throw new Error("CLAIM_MISMATCH");
  const status=String(body.status||"failed");
  if(!["running","completed","blocked","failed"].includes(status))throw new Error("CALLBACK_STATUS");
  const lease=status==="running"?new Date(Date.now()+45*60*1000).toISOString():null;
  const err=body.error?String(body.error).slice(0,1800):null;
  const prior=String(o.status||"");
  // Terminal callbacks cannot be replayed into a NEW remote mutation or
  // overwrite a completed result. A repeated identical callback is harmless.
  if(["completed","failed"].includes(prior)){
    if(prior===status)return {ok:true,duplicate:true};
    throw new Error("CALLBACK_TERMINAL_STATE_LOCKED");
  }
  if(prior==="blocked"){
    if(status==="blocked"&&String(o.last_error||"")===String(err||""))return {ok:true,duplicate:true};
    throw new Error("CALLBACK_BLOCKED_STATE_LOCKED");
  }
  if(o.kind==="generation"&&status==="blocked"&&err==="FLOW_UNUSUAL_ACTIVITY_COOLDOWN")
    await recordUnusualActivity(o,claimId,body);
  const u=await db.from("publisher_runtime_obligations").update({status,lease_until:lease,last_error:err,updated_at:now()}).eq("id",id).eq("claim_id",claimId);
  if(u.error)throw u.error;

  if(o.kind==="generation" && status==="blocked" && err==="WAITING_DAILY_FLOW_CREDIT_REFRESH"){
    const siblings=await db.from("publisher_runtime_obligations").update({
      status:"blocked",last_error:"WAITING_DAILY_FLOW_CREDIT_REFRESH",lease_until:null,updated_at:now()
    }).eq("publisher_id",o.publisher_id).eq("local_day",o.local_day).eq("kind","generation").eq("status","pending");
    if(siblings.error)throw siblings.error;
  }
  if(o.kind==="generation" && status==="completed"){
    const clear=await db.from("publisher_runtime_flow_cooldowns").update({
      streak:0,not_before:null,last_alert_at:null,last_alert_claim_id:null,
      status:"clear",updated_at:now()
    }).eq("publisher_id",o.publisher_id);
    if(clear.error)throw clear.error;
    const reopen=await db.from("publisher_runtime_obligations").update({
      status:"pending",last_error:null,claim_id:null,claimed_at:null,lease_until:null,updated_at:now()
    }).eq("publisher_id",o.publisher_id).eq("local_day",o.local_day).eq("kind","generation")
      .eq("status","blocked").eq("last_error","WAITING_DAILY_FLOW_CREDIT_REFRESH");
    if(reopen.error)throw reopen.error;
  }

  const patch:any={last_runner_at:now(),last_error:err,updated_at:now()};
  if(status==="completed"&&o.kind==="generation")patch.last_generation_at=now();
  if(status==="completed"&&o.kind==="publication")patch.last_publication_at=now();
  if(Number.isFinite(Number(body.approved_stock)))patch.approved_stock=Math.max(0,Math.floor(Number(body.approved_stock)));
  const p=await db.from("publisher_runtime_publishers").update(patch).eq("id",o.publisher_id);
  if(p.error)throw p.error;
  return {ok:true};
}
function objectPath(id:string,type:string){return id+"/"+type+".tgz"}
async function blob(req:Request,id:string,type:string){
  if(!["state","profile"].includes(type))return J({error:"bad blob type"},400);
  const key=objectPath(id,type);
  if(req.method==="GET"){
    const {data,error}=await db.storage.from(BUCKET).download(key);
    if(error){
      if(/not found|does not exist|404/i.test(String(error.message||error)))return new Response(null,{status:404});
      throw error;
    }
    return new Response(data,{headers:{"content-type":"application/octet-stream","cache-control":"no-store"}});
  }
  if(req.method==="PUT"){
    const bytes=new Uint8Array(await req.arrayBuffer());
    if(bytes.byteLength<1||bytes.byteLength>524288000)return J({error:"blob size invalid"},413);
    const {error}=await db.storage.from(BUCKET).upload(key,bytes,{contentType:"application/octet-stream",upsert:true});
    if(error)throw error;
    if(type==="profile"){
      const cur=await db.from("publisher_runtime_publishers").select("enabled,migration_state").eq("id",id).maybeSingle();
      if(cur.error)throw cur.error;
      const next=cur.data?.enabled===true && ["ready","profile_uploaded","auth_verified"].includes(String(cur.data?.migration_state||""))
        ? "ready"
        : "profile_uploaded";
      const upd=await db.from("publisher_runtime_publishers").update({migration_state:next,updated_at:now()}).eq("id",id);
      if(upd.error)throw upd.error;
    }
    return J({ok:true,size:bytes.byteLength});
  }
  return J({error:"method"},405);
}
async function health(){
  const [p,o]=await Promise.all([
    db.from("publisher_runtime_publishers").select("id,name,enabled,migration_state,last_generation_at,last_publication_at,last_error"),
    db.from("publisher_runtime_obligations").select("status")
  ]);
  if(p.error)throw p.error;if(o.error)throw o.error;
  const counts:any={};for(const x of o.data||[])counts[x.status]=(counts[x.status]||0)+1;
  return J({ok:true,version:"publisher-free-runtime-supabase-v1",at:now(),publishers:p.data||[],obligations:counts});
}

Deno.serve(async(req:Request)=>{
  try{
    const u=new URL(req.url),suffix=u.pathname.split("/publisher-free-runtime")[1]||"/";
    if(suffix==="/health"&&req.method==="GET")return await health();
    const claims=await githubIdentity(req);
    if(suffix==="/claim"&&req.method==="POST"){
      const body=await req.json().catch(()=>({}));
      const job=await claim(String(body.publisher_id||""),String(body.kind||"").toLowerCase());
      return J({ok:true,job,identity:{repository:claims.repository,run_id:claims.run_id||null}});
    }
    if(suffix==="/callback"&&req.method==="POST")return J(await callback(await req.json()));
    const m=suffix.match(/^\/blob\/(state|profile)\/([0-9a-f-]{36})$/i);
    if(m)return await blob(req,m[2],m[1]);
    return J({error:"not found"},404);
  }catch(e){
    const msg=String((e as Error)?.message||e).slice(0,1800);
    const auth=/^OIDC_|CLAIM_MISMATCH/.test(msg);
    return J({ok:false,error:msg},auth?401:500);
  }
});