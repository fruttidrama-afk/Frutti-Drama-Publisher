import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");
const orchestrator=read("supabase/functions/publisher-free-runtime/index.ts");
const runner=read("scripts/free-runtime-runner-v2.mjs");
const endpoint=read("supabase/functions/publisher-factory-control/index.ts");
const sql=read("supabase/migrations/20261117_publisher_factory_global_activation_gate.sql");
const html=read("docs/index.html");
const clone=read("factory-web/public/index.html");
let checks=0;
const pass=(condition,msg)=>{assert.ok(condition,msg);checks++};

for(const [name,body] of [["docs",html],["factory-web",clone]]){
 for(const id of ["factoryActivationSection","factoryState","factoryActivate","factoryPause","factoryChannelGrid","factoryStageRepair","factoryStageReconcile","factoryStageActivate"])
  pass(body.includes('id="'+id+'"'),name+" missing activation element: "+id);
 pass(body.includes('id="factoryActivate" disabled'),name+" button must start disabled in static HTML");
 pass(body.includes("factoryGateState.can_activate!==true"),name+" UI must fail closed");
 pass(body.includes('confirmation:"ACTIVAR AUTOMATIZACION"'),name+" explicit owner confirmation");
 pass(body.includes("await refreshFactoryGate()"),name+" read-only owner status request");
 pass(!body.includes("await resumePendingDeletes()"),name+" no automatic destructive deletion during repair");
}
pass(endpoint.includes("db.auth.getUser(jwt)"),"Endpoint must verify owner JWT");
pass(endpoint.includes('control.owner_id!==owner'),"Endpoint enforces owner-only access");
pass(endpoint.includes("!canActivate"),"Endpoint blocks unsafe activation");
pass(endpoint.includes('db.rpc("publisher_factory_activate"'),"Only atomic DB RPC can turn on");
pass(endpoint.includes('db.rpc("publisher_factory_pause"'),"Pause is explicit authenticated action");
pass(!endpoint.includes("update({enabled:true})"),"Endpoint must not individually flip publishers");
pass(sql.includes("phase text NOT NULL DEFAULT 'repair'"),"New factories start in repair");
pass(sql.includes("automation_enabled boolean NOT NULL DEFAULT false"),"Default is OFF");
pass(sql.includes("publisher_factory_control_phase_consistency"),"DB phase/flag consistency constraint");
pass(sql.includes("FOR UPDATE"),"Activation and pause serialize on singleton row");
pass(sql.includes("p_expected_revision"),"Stale frontend cannot activate with old revision");
pass(sql.includes("p_confirmation IS DISTINCT FROM 'ACTIVAR AUTOMATIZACION'"),"Activation requires explicit owner action");
pass(sql.includes("state.phase IS DISTINCT FROM 'armed'"),"Cannot activate during repair/preactivation");
pass(sql.includes("historical_reconciliation_pending"),"No publisher may still be historically unreconciled");
pass(sql.includes("status IN ('claimed','running')"),"Cannot activate with ambiguous active jobs");
pass(sql.includes("UPDATE public.publisher_runtime_publishers SET enabled=true"),"Publishers activated in same SQL transaction");
pass(sql.includes("REVOKE ALL ON FUNCTION public.publisher_factory_activate"),"No unauthenticated SQL execution");
pass(sql.includes("ENABLE ROW LEVEL SECURITY"),"Control row protected");
pass(orchestrator.includes('if(!await factoryAutomationAuthorized())return null;'),"Scheduler checks global gate before any mutation or seeding");
pass(orchestrator.includes('suffix==="/preflight"'),"Just-in-time authorization endpoint");
pass(orchestrator.includes("FACTORY_REPAIR_PAUSE"),"Explicit fail-closed reason");
pass(runner.includes("const stopped=await executionPreflight(job);"),"Runtime checks before launching local browser");
pass(runner.indexOf("const stopped=await executionPreflight(job);")<runner.indexOf("child=spawn('npm'"),"Runtime gate precedes Generate/Publish subprocess");
pass(runner.includes("FACTORY_PAUSED_BEFORE_EXECUTION"),"Mid-run pause yields blocked obligation, not external mutation");

// Evaluate the EXACT deployed gate logic with deliberately inconsistent publisher flags.
const start=orchestrator.indexOf("async function factoryAutomationAuthorized(){");
const end=orchestrator.indexOf("\nasync function materialize(){",start);
pass(start>0&&end>start,"Gate must be present before the materializer");
const functionCode=orchestrator.slice(start,end);
async function gate(row,error=null){
 const mock={from(name){assert.equal(name,"publisher_factory_control");return{
  select(){return this},eq(){return this},maybeSingle(){return Promise.resolve({data:row,error})}
 }}};
 const fn=vm.runInNewContext(functionCode+"\nfactoryAutomationAuthorized",{db:mock});
 return Boolean(await fn());
}
const safe={phase:"active",automation_enabled:true,technical_readiness:true,historical_reconciliation_complete:true};
for(const [scenario,state,failure] of [
 ["absent",null,null],["read error",safe,new Error("db offline")],
 ["repair",{...safe,phase:"repair"},null],
 ["off flag",{...safe,automation_enabled:false},null],
 ["not technically ready",{...safe,technical_readiness:false},null],
 ["not reconciled",{...safe,historical_reconciliation_complete:false},null],
 ["armed-not-yet-clicked",{...safe,phase:"armed",automation_enabled:false},null],
 ["preactivation",{...safe,phase:"ready_for_reconciliation",automation_enabled:false},null]
]){
 assert.equal(await gate(state,failure),false,scenario+" must prevent all jobs");checks++;
}
assert.equal(await gate(safe),true,"Only fully activated gate may authorize scheduler");checks++;
console.log("PASS FACTORY HARD PAUSE: "+checks+" code/owner/phase/SQL/runtime/mocked-gate assertions; zero remote calls.");
