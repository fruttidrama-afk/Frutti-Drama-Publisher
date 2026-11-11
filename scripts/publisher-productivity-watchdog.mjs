import fs from "node:fs";

// Private OIDC-protected endpoint. Public /health intentionally redacts all
// publisher information; never reverse that privacy fix to satisfy this check.
const URL = "https://wrflttnmlrsuzuukdhtf.supabase.co/functions/v1/publisher-free-runtime/status";
const AUDIENCE = "publisher-factory-free-runtime";
const CANONICAL = ["FruttiDrama","EARTH IN 10","Dinnie The Dinosaur"];
const MAX_GENERATION_GAP_HOURS = 36;
const now = new Date();
const summary = [
  "# Publisher Factory — unattended productivity watchdog",
  "",
  "Checked: " + now.toISOString(),
  "",
  "This check is read-only. A green scheduler or a valid lease does **not** prove that a video was generated or published.",
  ""
];
let failed = false;
async function githubOidcToken(){
  const url=String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||"");
  const bearer=String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||"");
  if(!url||!bearer)throw Error("WATCHDOG_OIDC_UNAVAILABLE");
  const response=await fetch(url+(url.includes("?")?"&":"?")+"audience="+encodeURIComponent(AUDIENCE),{
    headers:{authorization:"Bearer "+bearer},signal:AbortSignal.timeout(15000)
  });
  if(!response.ok)throw Error("WATCHDOG_OIDC_HTTP_"+response.status);
  const value=String((await response.json()).value||"");
  if(value.split(".").length!==3)throw Error("WATCHDOG_OIDC_INVALID");
  return value;
}
function classify(p,at=Date.now()){
  const name=String(p.name||"");
  const canonical=CANONICAL.includes(name);
  if(p.enabled!==true)return {status:canonical?"DISABLED":"ONBOARDING_DISABLED",failed:canonical};
  if(String(p.migration_state||"")!=="ready")return {status:"MIGRATION_INCOMPLETE",failed:true};
  const generation=p.last_generation_at?Date.parse(p.last_generation_at):NaN;
  const publication=p.last_publication_at?Date.parse(p.last_publication_at):NaN;
  if(!Number.isFinite(generation))return {status:"NO_CONFIRMED_GENERATION",failed:true};
  if(at-generation>MAX_GENERATION_GAP_HOURS*3600000)return {status:"GENERATION_STALE",failed:true};
  if(!Number.isFinite(publication))return {status:"NO_CONFIRMED_PUBLICATION",failed:true};
  if(at-publication>MAX_GENERATION_GAP_HOURS*3600000)return {status:"PUBLICATION_STALE",failed:true};
  return {status:"CONFIRMED_RECENT_OUTPUT",failed:false};
}
if(process.argv.includes("--selftest")){
  const assert=(await import("node:assert/strict")).default;
  const t=Date.parse("2026-11-11T04:00:00Z");
  const fresh="2026-11-11T03:00:00Z",old="2026-11-09T01:00:00Z";
  const base={name:"FruttiDrama",enabled:true,migration_state:"ready",last_generation_at:fresh,last_publication_at:fresh};
  assert.equal(classify(base,t).status,"CONFIRMED_RECENT_OUTPUT");
  assert.equal(classify({...base,last_generation_at:null},t).status,"NO_CONFIRMED_GENERATION");
  assert.equal(classify({...base,last_generation_at:old},t).status,"GENERATION_STALE");
  assert.equal(classify({...base,last_publication_at:null},t).status,"NO_CONFIRMED_PUBLICATION");
  assert.equal(classify({...base,last_publication_at:old},t).status,"PUBLICATION_STALE");
  assert.equal(classify({...base,enabled:false},t).status,"DISABLED");
  assert.equal(classify({...base,name:"New publisher",enabled:false,migration_state:"profile_required"},t).status,"ONBOARDING_DISABLED");
  assert.equal(classify({...base,migration_state:"profile_required"},t).status,"MIGRATION_INCOMPLETE");
  assert.ok(URL.endsWith("/status")&&!URL.endsWith("/health"));
  console.log("PASS 9 watchdog checks: authenticated status, no false success, safe onboarding; no network or production actions");
  process.exit(0);
}
try {
  const token=await githubOidcToken();
  const response = await fetch(URL, {signal: AbortSignal.timeout(15000), headers: {"accept":"application/json","cache-control":"no-cache","authorization":"Bearer "+token}});
  if (!response.ok) throw Error("Health endpoint returned HTTP " + response.status);
  const body = await response.json();
  if (body.ok !== true || !Array.isArray(body.publishers)) throw Error("Invalid health response");
  const names=new Set(body.publishers.map(p=>String(p.name||"")));
  for(const required of CANONICAL){
    if(!names.has(required)){summary.push("**MISSING CANONICAL PUBLISHER**: "+required);failed=true}
  }
  summary.push("Authenticated via GitHub OIDC; the public liveness endpoint remains redacted.");
  summary.push("| Publisher | Migration | Last confirmed generation (UTC) | Last confirmed publication (UTC) | Health |");
  summary.push("|---|---|---|---|---|");
  for (const p of body.publishers) {
    const name = String(p.name || p.id || "unknown").replace(/[|\r\n]/g," ");
    const migration = String(p.migration_state || "unknown").replace(/[|\r\n]/g," ");
    const generation = p.last_generation_at ? new Date(p.last_generation_at) : null;
    const publication = p.last_publication_at ? new Date(p.last_publication_at) : null;
    const assessment=classify(p,now.getTime());
    const status=assessment.status;
    if(assessment.failed)failed=true;
    const fmt = date => date && Number.isFinite(date.getTime()) ? date.toISOString() : "none";
    summary.push("| " + name + " | " + migration + " | " + fmt(generation) + " | " + fmt(publication) + " | **" + status + "** |");
  }
  summary.push("");
  summary.push("Missing publication is explicitly reported as unverified, not as success. Zero approved stock or human Review may legitimately prevent a publication; verify stock, remote platform identity and due-slot separately.");
  summary.push("Do not re-submit a Google Flow prompt after an ambiguous timeout. Reconcile the exact Flow asset ID first.");
} catch (error) {
  failed = true;
  summary.push("**HEALTH ENDPOINT UNAVAILABLE**: " + String(error?.message || error).slice(0,240));
}
const report = summary.join("\n") + "\n";
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
if (failed) {
  console.error("PUBLISHER_PRODUCTIVITY_FAILURE: scheduler liveness is not production success");
  process.exitCode = 1;
}
