// Publisher Factory global activation control.
// No automation starts from viewing this endpoint or loading the dashboard.
// Activation requires authenticated owner, fresh revision and explicit click,
// plus an independently armed/reconciled control row checked inside one SQL txn.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "npm:@supabase/supabase-js@2";
const URL=Deno.env.get("SUPABASE_URL")!;
const ADMIN=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db=createClient(URL,ADMIN,{auth:{persistSession:false,autoRefreshToken:false}});
const cors={
 "access-control-allow-origin":"*",
 "access-control-allow-headers":"authorization,content-type",
 "access-control-allow-methods":"GET,POST,OPTIONS",
 "content-type":"application/json",
 "cache-control":"no-store"
};
const J=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:cors});
const safePhase=(s:string)=>["repair","ready_for_reconciliation","armed","active","paused"].includes(s)?s:"repair";
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 if(!["GET","POST"].includes(req.method))return J({error:"METHOD_NOT_ALLOWED"},405);
 try{
  const auth=String(req.headers.get("authorization")||"");
  if(!auth.startsWith("Bearer "))return J({error:"AUTH_REQUIRED"},401);
  const jwt=auth.slice(7);
  const {data:identity,error:authError}=await db.auth.getUser(jwt);
  const owner=String(identity?.user?.id||"");
  if(authError||!owner)return J({error:"AUTH_INVALID"},401);
  const {data:control,error:controlError}=await db.from("publisher_factory_control")
   .select("owner_id,phase,automation_enabled,technical_readiness,historical_reconciliation_complete,revision,updated_at,activated_at,audit_evidence")
   .eq("id",1).maybeSingle();
  if(controlError||!control)return J({error:"FACTORY_CONTROL_UNAVAILABLE",automation_enabled:false},503);
  if(control.owner_id!==owner)return J({error:"FACTORY_OWNER_MISMATCH"},403);
  const {data:publishers,error:pError}=await db.from("publisher_runtime_publishers")
   .select("id,name,platform,enabled,migration_state,config,last_generation_at,last_publication_at")
   .eq("owner_id",owner).order("name");
  if(pError)throw pError;
  const all=publishers||[];
  const pendingFlags=all.filter(p=>p.config?.automation?.historical_reconciliation_pending===true).map(p=>p.name);
  const allReady=all.length===3&&all.every(p=>p.migration_state==="ready");
  const canActivate=control.phase==="armed"&&control.automation_enabled===false&&
   control.technical_readiness===true&&control.historical_reconciliation_complete===true&&
   allReady&&pendingFlags.length===0&&all.every(p=>p.enabled===false);
  const status={
   phase:safePhase(control.phase),automation_enabled:control.automation_enabled===true,
   technical_readiness:control.technical_readiness===true,
   historical_reconciliation_complete:control.historical_reconciliation_complete===true,
   revision:control.revision,updated_at:control.updated_at,activated_at:control.activated_at,
   can_activate:canActivate,readiness:{
    publisher_count:all.length,publishers_ready:allReady,
    publishers_enabled:all.filter(x=>x.enabled===true).length,
    outstanding_reconciliation_publishers:pendingFlags
   },
   publishers:all.map(p=>({
    id:p.id,name:p.name,platform:p.platform,enabled:p.enabled===true,
    migration_state:p.migration_state,last_generation_at:p.last_generation_at,
    last_publication_at:p.last_publication_at,
    historical_reconciliation_pending:p.config?.automation?.historical_reconciliation_pending===true
   })),
   audit_summary:control.audit_evidence||{},read_only:true
  };
  if(req.method==="GET")return J(status);
  const body=await req.json().catch(()=>({}));
  if(body?.action==="activate"){
   if(body.confirmation!=="ACTIVAR AUTOMATIZACION"||
      !Number.isInteger(body.expected_revision))return J({error:"EXPLICIT_CONFIRMATION_REQUIRED"},400);
   if(!canActivate)return J({error:"FACTORY_NOT_ARMED",status},409);
   const {data,error}=await db.rpc("publisher_factory_activate",{
    p_owner_id:owner,p_expected_revision:body.expected_revision,
    p_confirmation:body.confirmation
   });
   if(error)return J({error:error.code==="40001"?"ACTIVATION_STALE_REVISION":
     "ACTIVATION_ATOMIC_GUARD_REJECTED",reason:String(error.message||"").slice(0,120)},409);
   return J({ok:true,...data});
  }
  if(body?.action==="pause"){
   if(status.automation_enabled!==true)return J({ok:true,already_paused:true});
   if(body.confirmation!=="PAUSAR AUTOMATIZACION")return J({error:"PAUSE_CONFIRMATION_REQUIRED"},400);
   const {data,error}=await db.rpc("publisher_factory_pause",{p_owner_id:owner});
   if(error)return J({error:"PAUSE_FAILED",reason:String(error.code||"").slice(0,20)},409);
   return J({ok:true,...data});
  }
  return J({error:"ACTION_NOT_ALLOWED"},400);
 }catch(e){
  console.error("FACTORY_CONTROL_FAILURE",String((e as Error)?.message||"unknown").slice(0,160));
  return J({error:"FACTORY_CONTROL_UNAVAILABLE",automation_enabled:false},503);
 }
});
