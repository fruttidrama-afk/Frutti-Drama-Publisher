import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const file=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const nav=file('scripts/novnc-ipad-touch.mjs');
const installer=file('scripts/install-novnc-ipad-touch.mjs');
const launch=file('scripts/run-flow-account-bootstrap-v2.sh');
const checks=[
 ['one-finger scrolling has an explicit mode toggle',nav.includes("☝️ DESLIZAR")&&nav.includes('touchmove')],
 ['wheel events reach noVNC display canvas',nav.includes("new WheelEvent('wheel'")&&nav.includes("canvas.dispatchEvent(")],
 ['up/down fallback uses official noVNC sendKey',nav.includes("c.sendKey(keysym,code)")&&nav.includes("0xFF56")&&nav.includes("0xFF55")],
 ['iPad scroll capture is isolated behind toggle',nav.includes("overlay.style.display=enabled?'block':'none'")],
 ['no hidden navigation or login submissions',!nav.includes('fetch(')&&!nav.includes('localStorage')&&!nav.includes('document.cookie')],
 ['Chrome installed noVNC web root is patched idempotently',installer.includes("'/usr/share/novnc'")&&installer.includes('if(!text.includes(token))')],
 ['bootstrap enables navigation before start of websockify',launch.indexOf("install-novnc-ipad-touch.mjs")<launch.indexOf("websockify --web=")],
];
for(const [name,passed] of checks){assert.ok(passed,'FAILED: '+name);console.log('PASS',name)}
for(const p of ['scripts/novnc-ipad-touch.mjs','scripts/install-novnc-ipad-touch.mjs']){
 const result=spawnSync(process.execPath,['--check',new URL('../'+p,import.meta.url).pathname],{encoding:'utf8'});
 assert.equal(result.status,0,p+' syntax: '+result.stderr);
 console.log('PASS',p,'syntax');
}
console.log('PASS all touch-navigation smoke checks; no browser/login/video actions.');
