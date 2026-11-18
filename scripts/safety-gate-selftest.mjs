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
assert(provider.includes("import { createFlowMutex } from './flow-global-mutex.mjs'"),'All channel providers must use the kernel-backed shared Flow account mutex');
assert(provider.includes('if(!await acquireGlobalFlowLock())return;'),'Flow worker must acquire cross-container kernel mutex before opening Flow');
assert(provider.includes('assertGlobalFlowLock();'),'Generate button must require live kernel mutex ownership');
assert(!provider.includes('fs.unlinkSync(GLOBAL_FLOW_LOCK_PATH)'),'No stale-file deletion is allowed to steal an in-flight Flow account lock');
assert(read('flow-global-mutex.mjs').includes("spawn('flock',['-F','-n'"),'Flow lock must be OS flock with no-fork holder');
assert(read('flow-global-mutex.mjs').includes('exec cat >/dev/null'),'Kernel lock holder must terminate on parent process EOF');

assert(provider.includes("runtimeEnabled=centralGateOpen()&&meta(db,'automation:factoryEnabled','false')==='true'&&meta(db,'automation:operatorActivated','false')==='true'"),'Submit boundary must be gated');
assert(supervisor.includes("reason:'manual-operator-activation-required'"),'Supervisor must stay paused');
assert(!supervisor.includes("setMeta(db,'automation:factoryEnabled','true')"),'Supervisor must never reactivate');
assert(youtube.includes("if(centralGateOpen()&&db.prepare(\"SELECT value FROM factory_meta WHERE key='automation:operatorActivated'\").get()?.value==='true')normalizeTimedYoutubePublicationPolicy();"),'Paused startup must not alter YouTube schedule');
for(const src of [youtube,facebook])assert(src.includes("if(!centralGateOpen()||!isEnabled()||running||db.prepare(\"SELECT value FROM factory_meta WHERE key='automation:operatorActivated'\").get()?.value!=='true')return"),'Publication tick must check activation');
for(const [i,src] of [server,provider,supervisor,youtube,facebook].entries()){
  // Allow extra named imports (the provider also imports the explicit operator gate helper).
  // Require a real named import from the activation module, not an unrelated string mention.
  assert(/import\s*\{[^}]*\bcentralGateOpen\b[^}]*\}\s*from\s*['"]\.\/activation-gate\.mjs['"]/.test(src),
    'Missing global operator gate import: '+files[i]);
}
const preload=read('operator-preflight.mjs');
assert(preload.includes('PUBLISHER_SESSION_SECRET_REQUIRED'),'First runtime preload must reject absent operator session secrets');
const dockerfile=read('Dockerfile');
assert(dockerfile.includes('CMD ["node","--import=./operator-preflight.mjs","--import=./unattended-supervisor.js"'),'Credential preflight must run before any stateful Node preload');
assert(!dockerfile.includes('youtube-direct-public-selftest.mjs'),'Outdated direct-public YouTube selftest must not break the OCI build');
assert(dockerfile.includes('node youtube-private-public-selftest.mjs'),'OCI image build must verify PRIVATE 12:30 -> PUBLIC 19:00 on the same video');
const dockerCopyLines=dockerfile.replace(/\\\n\\s*/g,' ').split('\n').filter(x=>/^COPY\s+/.test(x));
for(const line of dockerCopyLines){
  const paths=line.trim().split(/\s+/).slice(1,-1);
  for(const source of paths){
    assert(fs.existsSync(source),'OCI Dockerfile references a missing build-context source: '+source);
  }
}
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
assert(server.includes('PIN_MAX_ATTEMPTS=6'),'Operator PIN authentication must enforce brute-force limits');
assert(server.includes("secure:Boolean(req.secure||"),'HTTPS sessions should use secure cookies');
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
assert(server.includes('// Unauthenticated health is consumed by the private Hub network.'),'Public machine health must be explicitly redacted');
assert(server.includes('flow:{configured:Boolean(status.flow?.configured),authenticated:Boolean(status.flow?.authenticated)}'),'Machine health should reveal only Boolean Flow readiness');

assert(server.includes("res.status(423).json({ok:false,error:'La reconstrucción"),'Paused mutation routes must explicitly reject');
const facebookResume=facebook.indexOf('function resumeAuthWait(){');
assert(facebookResume>=0&&facebook.slice(facebookResume,facebookResume+500).includes('if(!centralGateOpen()'), 'Facebook reconnect must not reschedule stock during pause');
const reconciliation=read('reconciliation-studio.mjs');
assert(reconciliation.includes('operator-verified-exact-prompt'),'Historical prompt linkage must be operator-verified');
assert(reconciliation.includes('pending-canonical-copy-review'),'Historical metadata must remain unverified until canonical copy checks');
assert(reconciliation.includes("mediaCache=new Map()"),'Video inventory must use source media identity');
assert(read('factory-hub.mjs').includes("function allowedChildDb("),'Child database path containment must be verified');
const hub=read('factory-hub.mjs');
assert(hub.includes('handleReconciliation(req,res'),'Reconciliation studio must be wired behind Hub authentication');
const compose=read('deploy/oracle-free/compose.yaml');
assert(compose.includes('profiles: ["explicit-publisher"]'),'Publisher must not launch with bare docker compose up');
assert(compose.includes('profiles: ["reconstruction-dashboard"]'),'Hub must require intentional profile selection');
const envRef=compose.split('env_file:').slice(1).filter(x=>x.trimStart().startsWith('- .env'));
const childEnvRefs=(compose.match(/^\s+- \.\/channels\/(?:fruttidrama|earth-in-10|dinnie)\.env$/gm)||[]);
assert.equal(envRef.length,4,'Three child publishers and the hub must each require the common private env file');
assert.equal(childEnvRefs.length,3,'Each child publisher must require its own private show config env file');
for(const id of ['fruttidrama','earth-in-10','dinnie']){
  assert(compose.includes('publisher-'+id+':'),'All three established show publishers must have separate services: '+id);
  assert(compose.includes('PUBLISHER_CHANNEL_ID: '+id),'Channel identity must be explicit: '+id);
  assert(compose.includes('./channels/'+id+'.env'),'Each channel requires isolated private config: '+id);
  assert(compose.includes('./data/'+id+':/data'),'Each channel must use a separate SQLite/browser volume: '+id);
  assert(read('deploy/oracle-free/channels/'+id+'.env.example').includes('PUBLISHER_CONFIG_JSON='),'Safe identity example missing: '+id);
}
assert(read('operator-preflight.mjs').includes('PUBLISHER_CHANNEL_IDENTITY_MISMATCH'),'Wrong show identity must abort before SQLite migration');
const composeProbe=read('scripts/oci-compose-offline-probe.sh');
assert(composeProbe.includes('root="$(mktemp -d)"'),'Compose dry-run must generate an isolated temporary workspace');
assert(composeProbe.includes('chmod 600 "$root/deploy/oracle-free/.env"'),'Synthetic Compose .env must remain private and outside source');
assert(compose.includes('PUBLISHER_ENABLED: "false"'),'OCI draft must default hard OFF independent of durable gate');
assert(compose.includes('reconciliation-media:/data/reconciliation-media:ro'),'Historical source videos must be mounted read-only');
assert(compose.includes('reconciliation:/data/reconciliation'),'Reconciliation assignments must be written outside production databases');
assert(compose.includes('reconciliation-studio.mjs:/app/reconciliation-studio.mjs:ro'),'Hub reconciliation module must be mounted read-only');
assert(compose.includes('PUBLISHER_HUB_ACTIVATION_ARMED: "false"'),'OCI hub activation must not be armed by default');
console.log('[SAFETY GATE] Static checks pass. No network, videos, or secrets used.');
