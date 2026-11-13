import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const base=Deno.env.get("SUPABASE_URL")||"";
const anon=Deno.env.get("SUPABASE_ANON_KEY")||"";
const secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
const admin=createClient(base,secret,{auth:{persistSession:false,autoRefreshToken:false}});
const authClient=createClient(base,anon,{auth:{persistSession:false,autoRefreshToken:false}});
const cors={
 "access-control-allow-origin":"*",
 "access-control-allow-methods":"GET, OPTIONS",
 "access-control-allow-headers":"authorization, apikey, content-type",
 "cache-control":"no-store"
};
function json(value:any,status=200){return new Response(JSON.stringify(value),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}})}
const selectFields="id,name,enabled,platform,timezone,generation_target,publication_target,approved_stock,activation_day,last_generation_at,last_publication_at,last_runner_at,last_error,migration_state,updated_at,config";
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 if(req.method!=="GET")return json({error:"METHOD_NOT_ALLOWED"},405);
 const authorization=String(req.headers.get("authorization")||"");
 const token=authorization.startsWith("Bearer ")?authorization.slice(7):"";
 if(!token)return json({error:"AUTH_REQUIRED"},401);
 const {data:userInfo,error:authError}=await authClient.auth.getUser(token);
 const ownerId=String(userInfo?.user?.id||"");
 if(authError||!ownerId)return json({error:"AUTH_INVALID"},401);
 const params=new URL(req.url).searchParams;
 const id=String(params.get("publisher_id")||"");
 if(id&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return json({error:"INVALID_PUBLISHER_ID"},400);
 let query=admin.from("publisher_runtime_publishers").select(selectFields).eq("owner_id",ownerId).order("name");
 // Read all rows owned by this user; filter the requested publisher only for the response.
 // The factory-global Flow cooldown must also reach a publisher created AFTER an alert.
 const {data:publisherRows,error}=await query;
 if(error)return json({error:"READ_FAILED"},503);
 // Return the owner-visible resume gate only; do NOT expose full creative
 // config or stored private connection fields in this lightweight read API.
 const ownedPublisherIds=(publisherRows||[]).map((row:any)=>String(row.id));
 const publishers=(publisherRows||[]).filter((row:any)=>!id||String(row.id)===id).map((row:any)=>{
  const {config,...safe}=row;
  return {...safe,resume_gate:config?.automation?.historical_reconciliation_pending===true?"historical_reconciliation_pending":null};
 });
 if(id&&!publishers?.length)return json({error:"PUBLISHER_NOT_FOUND"},404);
 if(!id)return json({publishers:publishers||[],read_only:true});
 const publisher=publishers?.[0];
 const cutoff=new Date(Date.now()-14*86400000).toISOString().slice(0,10);
 const [o,i,inventory,flowCooldown]=await Promise.all([
   admin.from("publisher_runtime_obligations")
     .select("id,local_day,kind,ordinal,status,attempts,lease_until,last_error,updated_at")
     .eq("publisher_id",publisher.id).gte("local_day",cutoff).order("local_day",{ascending:false}).order("ordinal").limit(100),
   admin.from("publisher_runtime_incidents")
     .select("id,code,opened_at,resolved_at")
     .eq("publisher_id",publisher.id).order("opened_at",{ascending:false}).limit(15),
   admin.from("publisher_runtime_inventory")
     .select("observed_at,source_updated_at,source_bytes,review_items,stock_items,counts,active_season,error_code")
     .eq("publisher_id",publisher.id).maybeSingle(),
   admin.from("publisher_runtime_flow_cooldowns")
     .select("streak,not_before,last_alert_at,status,updated_at")
     .in("publisher_id",ownedPublisherIds).neq("status","clear")
     .order("not_before",{ascending:false,nullsFirst:false}).limit(1).maybeSingle()
 ]);
 if(o.error||i.error||inventory.error||flowCooldown.error)return json({error:"DETAIL_READ_FAILED"},503);
 // Historical Supabase MP4 objects are forensic evidence, not approved or scheduled stock.
 // Only query the authorized publisher's fixed private-bucket namespace.
 const historicPrefixById:Record<string,string>={
  "7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7":"fruttidrama",
  "ee4f3cc6-bece-4d1b-94b4-e9dfbe1b7887":"earth-in-10",
  "d4e02dfa-be8a-43f1-abf1-2113ec4b05d6":"dinnie-the-dinosaur"
 };
 const prefix=historicPrefixById[publisher.id];
 let historicEvidence:any={source:"private_supabase_review_bucket",verified:false,reason:"NAMESPACE_UNMAPPED"};
 if(prefix){
  try{
   const {data:objects,error:storageError}=await admin.storage.from("publisher-review-videos").list(prefix+"/review",{limit:1000,sortBy:{column:"name",order:"asc"}});
   if(storageError)throw storageError;
   const mp4=(objects||[]).filter((x:any)=>typeof x.name==="string"&&x.name.toLowerCase().endsWith(".mp4"));
   const keys=mp4.map((x:any)=>String(x.name).replace(/-r[0-9]+-[0-9]+\.mp4$/,""));
   historicEvidence={
    source:"private_supabase_review_bucket",verified:true,as_of:new Date().toISOString(),
    mp4_file_count:mp4.length,distinct_filename_keys:new Set(keys).size,
    stock_labeled_files:mp4.filter((x:any)=>String(x.name).startsWith("stock-")).length,
    publication_labeled_files:mp4.filter((x:any)=>String(x.name).startsWith("publication-")).length,
    bytes:mp4.reduce((s:number,x:any)=>s+Math.max(0,Number(x.metadata?.size||0)),0),
    archival_namespace:prefix+"/review",
    meaning:"Archive files only; approval, scheduling, uniqueness and publish state unverified"
   };
  }catch(_){historicEvidence={source:"private_supabase_review_bucket",verified:false,reason:"ARCHIVE_LOOKUP_UNAVAILABLE"}}
 }
 // Publisher-specific read-only catalog. The owning user has already been verified above.
 // Unverified media NEVER becomes approved stock or an operation.
 let forensicCatalog:any={available:false,items:[],total_count:0,candidate_count:0,verified_approved_stock_count:0,ready_to_publish_count:0};
 if(publisher.id==="7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7"){
  const {data:manifest,error:catalogError}=await admin.from("publisher_factory_knowledge")
   .select("content,version,updated_at").eq("key","forensics/2026-10-12/fruttidrama/reconciliation-v2").eq("active",false).maybeSingle();
  if(!catalogError&&manifest?.content){
   try {
    const record=JSON.parse(manifest.content);
    const entries=Array.isArray(record.items)?record.items:[];
    if(entries.length===31){
     const photos=entries.map((x:any)=>"media-forensics/pilot-20261012/"+Number(x.file_index)+"/contact.jpg");
     const {data:signed,error:signErr}=await admin.storage.from("publisher-runtime-state").createSignedUrls(photos,900);
     const originals=entries.map((x:any)=>String(x.storage_object||""));
     const pathsValid=originals.every((v:string)=>v.startsWith("fruttidrama/review/")&&v.toLowerCase().endsWith(".mp4")&&!v.includes(".."));
     const [originalMedia,assignments]=await Promise.all([
       pathsValid?admin.storage.from("publisher-review-videos").createSignedUrls(originals,900):Promise.resolve({data:null,error:{message:"ARCHIVE_PATH_INVALID"}}),
       admin.from("publisher_forensic_episode_assignments").select("file_index,source_sha256,assigned_season,assigned_episode,note,updated_at").eq("publisher_id",publisher.id)
     ]);
     const manuallyAssigned=new Map((assignments.data||[]).map((r:any)=>[Number(r.file_index),r]));
     const items=entries.map((e:any,n:number)=>({
       file_index:Number(e.file_index),transcript_raw:String(e.transcript_raw||"").slice(0,600),
       episode_candidate:e.episode_candidate||null,identity_confidence:e.identity_confidence||null,
       identity_evidence:e.identity_evidence||null,identity_status:String(e.identity_status||"unmatched"),
       match_basis:String(e.basis||"").slice(0,150),collision_note:String(e.collision||"").slice(0,400),
       publication_status:String(e.publication_status||"unverified_for_this_specific_file"),
       approved_stock_status:String(e.approved_stock_status||"unknown_do_not_publish"),
       source_sha256:String(e.sha256||""),sha256_short:String(e.sha256||"").slice(0,12),duration_seconds:e.video_length_seconds??null,
       contact_image_url:signErr?null:(signed?.[n]?.signedUrl||null),
       video_url:originalMedia.error?null:(originalMedia.data?.[n]?.signedUrl||null),
       manual_assignment:!assignments.error&&manuallyAssigned.get(Number(e.file_index))?.source_sha256===String(e.sha256||"")?{
        season:manuallyAssigned.get(Number(e.file_index))?.assigned_season??null,
        episode:manuallyAssigned.get(Number(e.file_index))?.assigned_episode??null,
        note:manuallyAssigned.get(Number(e.file_index))?.note||"",
        updated_at:manuallyAssigned.get(Number(e.file_index))?.updated_at||null
       }:null
     }));
     forensicCatalog={
       available:true,read_only:true,as_of:manifest.updated_at,
       total_count:31,
       candidate_count:items.filter((x:any)=>x.episode_candidate!==null).length,
       verified_approved_stock_count:0,ready_to_publish_count:0,
       manual_assignment_count:items.filter((x:any)=>x.manual_assignment?.season!==null&&x.manual_assignment?.season!==undefined).length,
       assignment_read_error:Boolean(assignments.error),video_preview_error:Boolean(originalMedia.error),
       historical_published_ids:record.snapshot_oct5||null,
       items
     };
    }
   }catch(_){forensicCatalog={...forensicCatalog,error:"FORENSIC_RECORD_UNREADABLE"}}
  }else if(catalogError)forensicCatalog={...forensicCatalog,error:"FORENSIC_RECORD_READ_FAILED"};
 }
 return json({publisher,obligations:o.data||[],incidents:i.data||[],inventory:inventory.data||null,flowCooldown:flowCooldown.data||null,historicEvidence,forensicCatalog,read_only:true});
});
