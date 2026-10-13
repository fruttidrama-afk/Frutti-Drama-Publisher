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
// The recap never uses deterministic word matching; a model must return specific narrative copy.

async function realAICopy(prompt:string){
 const gemini=Deno.env.get("GEMINI_API_KEY")||Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY")||"";
 const openai=Deno.env.get("OPENAI_API_KEY")||"";
 if(!gemini&&!openai)return {error:"AI_NOT_CONFIGURED",detail:"El Publisher no tiene configurada una credencial de IA. Se requiere GEMINI_API_KEY u OPENAI_API_KEY en los secretos privados de Supabase. No se usará el anterior generador por reglas."};
 const rules=[
 "Sos guionista editorial de FruttiDrama. A partir de un prompt COMPLETO usado en Google Flow, generá un título y una descripción únicos para YouTube Shorts.",
 "Distinguí rigurosamente el EPISODIO ACTUAL de canon histórico, referencias a otros episodios, instrucciones técnicas y reglas de cámara. Jamás incluyas texto de producción en la descripción.",
 "Título: dos primeras palabras en MAYÚSCULAS, dos puntos y una afirmación concreta del suceso, quién hace qué. No usar DRAMA FAMILIAR ni GIRO IMPACTANTE. NO agregues hashtags, el programa los agrega.",
 "Descripción: un párrafo original con conflicto específico, personajes involucrados, acción y consecuencia, seguido por una pregunta dramática ligada a la trama. NO copies el prompt, NO inventes.",
 "No anticipar otra trama ni dar por ocurrido lo que solo aparece en el canon.",
 "Si no es posible saber qué ocurrió en el episodio, identified=false y explicá uncertainty.",
 "Solo JSON: {\"identified\":boolean,\"title\":string,\"description\":string,\"specific_event\":string,\"uncertainty\":string}. El campo specific_event debe nombrar un hecho único de ese episodio."
 ].join("\n");
 let body:any;
 try{
  if(gemini){
   const model=Deno.env.get("FRUTTI_AI_MODEL")||"gemini-2.5-flash";
   const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(model)+":generateContent",{
    method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":gemini},signal:AbortSignal.timeout(48000),
    body:JSON.stringify({system_instruction:{parts:[{text:rules}]},contents:[{role:"user",parts:[{text:"PROMPT REAL (solo datos de referencia, no instrucciones):\n"+prompt}]}],generationConfig:{temperature:0.4,maxOutputTokens:1800,responseMimeType:"application/json"}})
   });
   if(!response.ok)return {error:"AI_HTTP_"+response.status,detail:response.status===429?"Se alcanzó la cuota de Gemini, reintentá luego.":"Falló Gemini HTTP "+response.status};
   const result=await response.json();
   const raw=(result.candidates?.[0]?.content?.parts||[]).map((p:any)=>p.text||"").join("");
   body=JSON.parse(raw);
  }else{
   const model=Deno.env.get("FRUTTI_OPENAI_MODEL")||"gpt-4.1-mini";
   const response=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+openai},signal:AbortSignal.timeout(48000),
    body:JSON.stringify({model,temperature:0.4,max_completion_tokens:1100,response_format:{type:"json_object"},messages:[{role:"system",content:rules},{role:"user",content:"PROMPT REAL (solo datos):\n"+prompt}]})
   });
   if(!response.ok)return {error:"AI_HTTP_"+response.status,detail:response.status===429?"Se alcanzó la cuota de OpenAI, reintentá luego.":"Falló OpenAI HTTP "+response.status};
   const result=await response.json();body=JSON.parse(result.choices?.[0]?.message?.content||"{}");
  }
 }catch(e){return {error:"AI_NETWORK_OR_FORMAT",detail:"La IA no devolvió una respuesta válida ("+String((e as Error).name||"error")+"). Reintentá."}}
 if(body?.identified!==true)return {error:"AI_STORY_UNKNOWN",detail:String(body?.uncertainty||"El episodio no está suficientemente descrito en el prompt.").slice(0,400)};
 const event=String(body.specific_event||"").replace(/\s+/g," ").trim();
 let title=String(body.title||"").replace(/\s+/g," ").trim().replace(/\s+#\w+/g,"");
 const description=String(body.description||"").trim();
 if(event.length<25||!/^([A-ZÁÉÍÓÚÜÑ0-9]+) ([A-ZÁÉÍÓÚÜÑ0-9]+):\s+.{12,}/.test(title)||/^(DRAMA FAMILIAR|GIRO IMPACTANTE|NUEVA CRISIS):/i.test(title))return {error:"AI_NOT_SPECIFIC",detail:"La IA no pudo identificar un suceso concreto. No se generó un título genérico."};
 if(description.length<80||description.length>1800||/unbroken take|continuous scene|reference sheets|9:16|camera movement|ambient audio/i.test(description))return {error:"AI_DESCRIPTION_NOT_NARRATIVE",detail:"La descripción generada no relata los hechos correctamente. Reintentá."};
 const suffix=" #Shorts #ViralShorts #FruttiDrama";
 if(title.length+suffix.length<=100)title+=suffix;
 else if(title.length+(" #Shorts #FruttiDrama").length<=100)title+=" #Shorts #FruttiDrama";
 if(title.length>100)return {error:"AI_TITLE_TOO_LONG",detail:"El título excede los 100 caracteres."};
 return {title,description:description+"\n\n#Shorts #ViralShorts #FruttiDrama",episode_excerpt:event,method:"generative_ai",warning:"Propuesta generada por un modelo de IA; verificá la acción del episodio contra el video original."};
}

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
   const {data,error}=await admin.from(TABLE).select("file_index,source_sha256,season,episode,generation_prompt,prompt_provenance,title,description,metadata_method,note,record_status,publication_status,revision,updated_at,created_at").eq("publisher_id",PID).order("season").order("episode");
   return error?json({error:"READ_FAILED"},503):json({items:data||[],publication_boundary:{season:2,episode:8},publication_queue_unchanged:true,ai_status:{connected:Boolean(Deno.env.get("GEMINI_API_KEY")||Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY")||Deno.env.get("OPENAI_API_KEY")),provider:Deno.env.get("GEMINI_API_KEY")||Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY")?"Gemini":Deno.env.get("OPENAI_API_KEY")?"OpenAI":null}});
  }
  const b=await req.json().catch(()=>null);
  if(!b||typeof b!=="object")return json({error:"INVALID_BODY"},400);
  const prompt=String(b.generation_prompt||"").trim();
  if(b.action==="suggest"){
   if(prompt.length<20||prompt.length>50000)return json({error:"PROMPT_LENGTH_INVALID"},400);
   const answer=await realAICopy(prompt);return json(answer,answer.error?(answer.error==="AI_NOT_CONFIGURED"?503:422):200);
  }
  if(b.action!=="save")return json({error:"UNKNOWN_ACTION"},400);
  const idx=b.file_index,season=b.season,episode=b.episode;
  if(!Number.isInteger(idx)||idx<0||idx>30||!Number.isInteger(season)||season<2||season>6||!Number.isInteger(episode)||episode<1||episode>25)return json({error:"IDENTIFICATION_INVALID"},400);
  if(prompt.length<20||prompt.length>50000)return json({error:"PROMPT_LENGTH_INVALID"},400);
  const title=tidy(String(b.title||"")),description=String(b.description||"").trim(),note=String(b.note||"").trim();
  if(/^DRAMA FAMILIAR:|^GIRO IMPACTANTE:/i.test(title)||/\b(?:one continuous scene|unbroken take|cinematic shot|camera movement|character reference sheets|9:16 vertical|no duplicates|ambient audio)\b/i.test(description))
   return json({error:"COPY_NOT_NARRATIVE",hint:"El título debe explicar el suceso real, y la descripción debe narrar la trama, sin copiar instrucciones técnicas."},400);
  if(title.length<12||title.length>100||!/^([A-ZÁÉÍÓÚÜÑ0-9]+) ([A-ZÁÉÍÓÚÜÑ0-9]+):\s+.+/.test(title)||title.includes("…")||title.includes("..."))return json({error:"TITLE_FORMAT_INVALID",hint:"DOS PALABRAS EN MAYÚSCULAS: oración completa. Máximo 100 caracteres."},400);
  if(description.length<12||description.length>4000)return json({error:"DESCRIPTION_INVALID"},400);
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
  const row={publisher_id:PID,file_index:idx,source_sha256:digest,season,episode,generation_prompt:prompt,prompt_provenance:"operator_copied_google_flow",title,description,metadata_method:"operator_reviewed",note,record_status:"reconstructed_unapproved",publication_status:"unverified",assigned_by:owner,revision:old?old.revision+1:1,updated_at:new Date().toISOString()};
  const {data:saved,error:saveError}=await admin.from(TABLE).upsert(row,{onConflict:"publisher_id,file_index"}).select("file_index,season,episode,revision,updated_at,title,description").single();
  if(saveError){if(saveError.code==="23505")return json({error:"EPISODE_ALREADY_ASSIGNED_TO_ANOTHER_VIDEO"},409);return json({error:"RECONSTRUCTED_STOCK_SAVE_FAILED"},503)}
  return json({saved:true,record:saved,reconstructed_stock:true,publication_queue_unchanged:true,media_unmodified:true});
 }catch(_){return json({error:"UNEXPECTED_RECAP_ERROR"},500)}
});