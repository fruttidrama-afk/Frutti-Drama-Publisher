import fs from 'node:fs';
import assert from 'node:assert/strict';
const read=p=>fs.readFileSync(p,'utf8');
const files=['server.js','free-browser-provider.js','unattended-supervisor.js','publication.js','publication-facebook.js'];
const [server,provider,supervisor,youtube,facebook]=files.map(read);
for(const [i,src] of [server,provider,supervisor,youtube,facebook].entries())
  assert(src.includes('automation:operatorActivated'),'Activation gate missing: '+files[i]);
assert(server.includes("app.post('/factory/enable',secure"),'Legacy enable route not secured');
assert(server.includes('La activación queda reservada'),'Legacy enable route must be disabled');
assert(server.includes('Live Flow submit is forbidden during reconstruction'),'Live test forbidden');
assert(server.includes("if(!centralGateOpen()||metaGet('automation:operatorActivated','false')!=='true')return false"),'Readiness must not activate');
assert(provider.includes("if(meta(db,'automation:operatorActivated','false')!=='true'||!centralGateOpen())return;"),'Flow worker must exit when paused');
assert(provider.includes("runtimeEnabled=centralGateOpen()&&meta(db,'automation:factoryEnabled','false')==='true'&&meta(db,'automation:operatorActivated','false')==='true'"),'Submit boundary must be gated');
assert(supervisor.includes("reason:'manual-operator-activation-required'"),'Supervisor must stay paused');
assert(!supervisor.includes("setMeta(db,'automation:factoryEnabled','true')"),'Supervisor must never reactivate');
assert(youtube.includes("if(centralGateOpen()&&db.prepare(\"SELECT value FROM factory_meta WHERE key='automation:operatorActivated'\").get()?.value==='true')normalizeTimedYoutubePublicationPolicy();"),'Paused startup must not alter YouTube schedule');
for(const src of [youtube,facebook])assert(src.includes("if(!centralGateOpen()||!isEnabled()||running||db.prepare(\"SELECT value FROM factory_meta WHERE key='automation:operatorActivated'\").get()?.value!=='true')return"),'Publication tick must check activation');
for(const src of [server,provider,supervisor,youtube,facebook])assert(src.includes("import { centralGateOpen } from './activation-gate.mjs'"),'Missing global operator gate import');
const central=read('activation-gate.mjs');assert(central.includes('if(!file)return false')&&central.includes('x?.enabled===true'),'Global switch must fail closed');
// Historical state must remain frozen on startup and during read-only panel inspection.
for(const name of ['repairLegacyEarthReviewMetadata','repairPendingPublicationMetadata','repairObsoleteFlowSettingsErrors']){
  // Avoid relying on exact whitespace across the source; validate each gate in a short window.
  const start=server.indexOf('function '+name+'(){');
  assert(start>=0,'Missing startup state-freeze function: '+name);
  assert(server.slice(start,start+350).includes("if(!centralGateOpen()||metaGet('automation:operatorActivated','false')!=='true')return;"),'Paused startup mutation gate missing: '+name);
}
assert(server.includes("if(!centralGateOpen()||metaGet('automation:operatorActivated','false')!=='true')return row;"),'Paused creative-copy inspection must not mutate ledger');
const init=read('runtime-init.js');
assert(init.includes("if(centralGateOpen())cleanupRecreatableStorage();"),'Paused init must never delete browser cache/profile');
assert(init.includes('DESTRUCTIVE_INSTANCE_RESET_DISABLED'),'Destructive redeploy reset must be prohibited');
assert(init.includes("if(centralGateOpen()&&db.prepare(\"SELECT value FROM factory_meta WHERE key='automation:operatorActivated'\").get()?.value==='true')"),'Paused init must never seed historical episodes');
assert(server.includes("if(SESSION_SECRET.length<32"),'Runtime must not use known fallback session encryption key');
assert(server.includes("if(!r||r.revokedAt||r.expiresAt<Date.now())return false"),'Unknown or revoked signed sessions must be rejected');
const bootstrap=read('flow-bootstrap.js');
assert(bootstrap.includes("app.use('/flow/bootstrap'"),'Sensitive remote browser routes must be guarded');
assert(bootstrap.includes('globalThis.__publisherSecureMiddleware'),'Bootstrap needs session middleware');
assert(server.includes('globalThis.__publisherSecureMiddleware=secure;'),'Publisher session middleware not passed to bootstrap');
const providerStart=provider.indexOf('async function runProvider(){');
assert(providerStart>=0 && provider.slice(providerStart,providerStart+450).includes('if(!centralGateOpen())return;'),'Provider must return immediately while paused');
for(const endpoint of ["'/publication/run'","'/api/schedule'","'/api/show-bible'","'/integrations/platform'"]){
  assert(server.includes(endpoint),'Paused mutation endpoint missing from route safety audit: '+endpoint);
}
assert(server.includes('const frozen=pathname'), 'No pre-activation freeze for manual stock/review/schedule mutation routes');
assert(server.includes("res.status(423).json({ok:false,error:'La reconstrucción"),'Paused mutation routes must explicitly reject');
const facebookResume=facebook.indexOf('function resumeAuthWait(){');
assert(facebookResume>=0&&facebook.slice(facebookResume,facebookResume+500).includes('if(!centralGateOpen()'), 'Facebook reconnect must not reschedule stock during pause');
const reconciliation=read('reconciliation-studio.mjs');
assert(reconciliation.includes('operator-verified-exact-prompt'),'Historical prompt linkage must be operator-verified');
assert(reconciliation.includes('pending-canonical-copy-review'),'Historical metadata must remain unverified until canonical copy checks');
assert(reconciliation.includes("mediaCache=new Map()"),'Video inventory must use source media identity');
const hub=read('factory-hub.mjs');
assert(hub.includes('handleReconciliation(req,res'),'Reconciliation studio must be wired behind Hub authentication');
const compose=read('deploy/oracle-free/compose.yaml');
assert(compose.includes('profiles: ["explicit-publisher"]'),'Publisher must not launch with bare docker compose up');
assert(compose.includes('profiles: ["reconstruction-dashboard"]'),'Hub must require intentional profile selection');
assert(compose.includes('PUBLISHER_ENABLED: "false"'),'OCI draft must default hard OFF independent of durable gate');
assert(compose.includes('reconciliation-media:/data/reconciliation-media:ro'),'Historical source videos must be mounted read-only');
assert(compose.includes('reconciliation:/data/reconciliation'),'Reconciliation assignments must be written outside production databases');
assert(compose.includes('reconciliation-studio.mjs:/app/reconciliation-studio.mjs:ro'),'Hub reconciliation module must be mounted read-only');
assert(compose.includes('PUBLISHER_HUB_ACTIVATION_ARMED: "false"'),'OCI hub activation must not be armed by default');
console.log('[SAFETY GATE] Static checks pass. No network, videos, or secrets used.');
