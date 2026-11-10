import {checkFruttiMetadata,FRUTTI_CANONICAL_TAGS} from "./metadata-contract.js";
import {LEGACY_FRUTTI_METADATA,LEGACY_METADATA_SOURCE} from "./legacy-metadata.js";

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2";
const BASE=Deno.env.get("SUPABASE_URL")!;
const admin=createClient(BASE,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const authClient=createClient(BASE,Deno.env.get("SUPABASE_ANON_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const PID="7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7";
const MANIFEST="forensics/2026-10-12/fruttidrama/reconciliation-v2";
const TABLE="publisher_frutti_reconstructed_stock";
const cors={"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"authorization,content-type,apikey,x-client-info","cache-control":"no-store"};
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"content-type":"application/json;charset=utf-8"}})}
const tidy=(s:string)=>s.replace(/\s+/g," ").trim();
// Current metadata assistant is a deterministic editorial extractor, NOT a semantic AI model; manual cross-check remains mandatory.


// Original FruttiDrama hook/story creative package, adapted to verified pasted Flow prompts.

Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 if(req.method!=="GET"&&req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
 try{
  const h=req.headers.get("authorization")||"";
  if(!h.startsWith("Bearer "))return json({error:"LOGIN_REQUIRED"},401);
  const {data:auth,error:authError}=await authClient.auth.getUser(h.slice(7));
  const owner=auth?.user?.id;
  if(authError||!owner)return json({error:"LOGIN_INVALID"},401);
  const {data:pub,error:pubError}=await admin.from("publisher_runtime_publishers").select("id").eq("id",PID).eq("owner_id",owner).maybeSingle();
  if(pubError||!pub)return json({error:"FORBIDDEN"},403);
  if(req.method==="GET"){
   const {data,error}=await admin.from(TABLE).select("file_index,source_sha256,season,episode,generation_prompt,prompt_provenance,title,description,metadata_method,episode_story_evidence,episode_story_extraction_method,note,record_status,publication_status,revision,updated_at,created_at").eq("publisher_id",PID).order("season").order("episode");
   return error?json({error:"READ_FAILED"},503):json({items:data||[],historical_metadata:LEGACY_FRUTTI_METADATA,historical_metadata_source:LEGACY_METADATA_SOURCE,historical_metadata_status:"historical_canonical_copy_only_no_story_derived_metadata",metadata_modes:["historical","manual"],canonical_tags:FRUTTI_CANONICAL_TAGS,publication_boundary:{season:2,episode:8},publication_queue_unchanged:true,ai_status:{connected:false,provider:"Retired; manual or historical only",method:"disabled",semantic_model:false,external_ai_required:false}});
  }
  const b=await req.json().catch(()=>null);
  if(!b||typeof b!=="object")return json({error:"INVALID_BODY"},400);
  const prompt=String(b.generation_prompt||"").trim();
  if(b.action==="suggest")return json({error:"NARRATIVE_EXTRACTOR_RETIRED",detail:"La identificación automática de narrativa y la generación de metadatos a partir del prompt están desactivadas definitivamente. Usá los metadatos históricos o escribí título y descripción manualmente."},410);
  if(b.action!=="save")return json({error:"UNKNOWN_ACTION"},400);
  const idx=b.file_index,season=b.season,episode=b.episode;
  if(!Number.isInteger(idx)||idx<0||idx>30||!Number.isInteger(season)||season<2||season>6||!Number.isInteger(episode)||episode<1||episode>25)return json({error:"IDENTIFICATION_INVALID"},400);
  if(prompt.length<20||prompt.length>50000)return json({error:"PROMPT_LENGTH_INVALID"},400);
  const title=tidy(String(b.title||"")),description=String(b.description||"").trim(),note=String(b.note||"").trim();
  const exactLegacy=LEGACY_FRUTTI_METADATA.find((entry:any)=>entry.season===season&&entry.episode===episode&&entry.title===title&&entry.description===description);
  const validation=checkFruttiMetadata(title,description,{historicalExact:Boolean(exactLegacy)});
  if(!validation.ok)return json({error:validation.error,hint:"Usá DOS PALABRAS EN MAYÚSCULAS: hecho real #Shorts #ViralShorts #FruttiDrama. Descripción: qué ocurre y a quién afecta, seguida de los mismos hashtags. Editá todos los textos de ejemplo antes de guardar."},400);
  const episode_story_evidence=tidy(String(b.episode_story_evidence||"")).slice(0,2000);
  const episode_story_extraction_method=tidy(String(b.episode_story_extraction_method||"")).slice(0,100);
  if(note.length>700)return json({error:"NOTE_TOO_LONG"},400);
  const {data:src,error:srcErr}=await admin.from("publisher_factory_knowledge").select("content").eq("key",MANIFEST).eq("active",false).single();
  if(srcErr||!src?.content)return json({error:"EVIDENCE_UNAVAILABLE"},503);
  const archive=JSON.parse(src.content),entries=archive?.items;
  if(!Array.isArray(entries)||entries.length!==31)return json({error:"EVIDENCE_INCOMPLETE"},503);
  const original=entries.find((e:any)=>Number(e.file_index)===idx);
  const digest=String(original?.sha256||"").toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(digest)||digest!==String(b.source_sha256||""))return json({error:"VIDEO_SOURCE_MISMATCH"},409);
  const {data:old,error:oldErr}=await admin.from(TABLE).select("revision,source_sha256").eq("publisher_id",PID).eq("file_index",idx).maybeSingle();
  if(oldErr)return json({error:"PRE_SAVE_CHECK_FAILED"},503);
  if(old&&old.source_sha256!==digest)return json({error:"VIDEO_REPLACEMENT_FORBIDDEN"},409);
  if(old&&b.expected_revision!==old.revision)return json({error:"STALE_EDIT_REFRESH_REQUIRED"},409);
  if(!old&&b.expected_revision!=null)return json({error:"STALE_EDIT_REFRESH_REQUIRED"},409);
  const row={publisher_id:PID,file_index:idx,source_sha256:digest,season,episode,generation_prompt:prompt,prompt_provenance:"operator_copied_google_flow",title,description,metadata_method:exactLegacy?"legacy_canonical_operator_reviewed":"operator_manual_copy",episode_story_evidence,episode_story_extraction_method,note,record_status:"reconstructed_unapproved",publication_status:"unverified",assigned_by:owner,revision:old?old.revision+1:1,updated_at:new Date().toISOString()};
  const {data:saved,error:saveError}=await admin.from(TABLE).upsert(row,{onConflict:"publisher_id,file_index"}).select("file_index,season,episode,revision,updated_at,title,description").single();
  if(saveError){if(saveError.code==="23505")return json({error:"EPISODE_ALREADY_ASSIGNED_TO_ANOTHER_VIDEO"},409);return json({error:"RECONSTRUCTED_STOCK_SAVE_FAILED"},503)}
  return json({saved:true,record:saved,reconstructed_stock:true,publication_queue_unchanged:true,media_unmodified:true});
 }catch(_){return json({error:"UNEXPECTED_RECAP_ERROR"},500)}
});