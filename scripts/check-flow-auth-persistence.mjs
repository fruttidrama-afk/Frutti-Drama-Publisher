import fs from 'node:fs';
import assert from 'node:assert/strict';
const text=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const runner=text('scripts/free-runtime-runner-v2.mjs');
const provider=text('free-browser-provider.js');
const capture=text('scripts/bootstrap-flow-account-v2.mjs');
const shell=text('scripts/run-flow-account-bootstrap-v2.sh');
const checks=[
 ['bootstrapping captures IndexedDB',capture.includes('ctx.storageState({path:STATE,indexedDB:true})')],
 ['bootstrapping requires explicit human capture for Frutti too',!capture.includes("if(KEY==='frutti')")&&capture.includes("cfg.migration_state||'')==='capture_requested'")],
 ['bootstrapping verifies project and Google session',capture.includes('FLOW_LOGIN_NO_VERIFIED_GOOGLE_SESSION')&&capture.includes('FLOW_EXPECTED_PROJECT_NOT_OPEN')],
 ['persistent Chrome profile is quiesced before archiving',shell.indexOf('kill -TERM "$CHROME_PID"')>shell.indexOf('node scripts/bootstrap-flow-account-v2.mjs capture')&&shell.indexOf('kill -TERM "$CHROME_PID"')<shell.indexOf('cp -a "$PROFILE"'))],
 ['provider captures indexedDB when portable state changes',provider.includes('context.storageState({path:candidate,indexedDB:true})')],
 ['provider refresh is atomic and Google cookie gated',provider.includes('fs.renameSync(candidate,PORTABLE_STORAGE_STATE)')&&provider.includes('hasGoogleLogin')],
 ['runner validates exact project before any runtime starts',runner.indexOf('await validateFlowAuthAndRefreshState(expectedProjectUrl);')<runner.indexOf("child=spawn('npm',['start']")],
 ['runner rejects missing Google session instead of wasting credits',runner.includes('FLOW_AUTH_GOOGLE_SESSION_COOKIES_MISSING')],
 ['runner refresh retains last known good on failure',runner.includes('FLOW_AUTH_REFRESH_SKIPPED_LAST_GOOD_PRESERVED')&&runner.includes('authenticatedAfterRun?packPortableProfile():null')],
 ['runner refuses empty/unverified vault backup',runner.includes('FLOW_AUTH_VERIFIED_SNAPSHOT_INVALID')&&runner.includes('fs.renameSync(candidate,PORTABLE_STATE)')],
 ['runner retains Chrome auth profile without accumulating caches',runner.includes('FLOW_AUTH_PROFILE_TRIMMED_TO_PORTABLE_STATE')],
];
for(const [description,good] of checks){assert.ok(good,'FAIL: '+description);console.log('PASS',description)}
console.log('PASS '+checks.length+' authentication persistence guards, no network or video action');
