// Idempotent read-only-source patch for noVNC's distro-installed vnc.html.
// Run as sudo in ephemeral GitHub Actions, before noVNC/websockify starts.
import fs from 'node:fs';
import path from 'node:path';
const root='/usr/share/novnc';
const html=path.join(root,'vnc.html');
const app=path.join(root,'app','frutti-ipad-touch.mjs');
const source=path.resolve('scripts/novnc-ipad-touch.mjs');
if(!fs.existsSync(html)||!fs.existsSync(source))throw Error('NOVNC_INSTALL_SOURCE_MISSING');
fs.copyFileSync(source,app);
const token='<script type="module" src="app/frutti-ipad-touch.mjs"></script>';
let text=fs.readFileSync(html,'utf8');
if(!text.includes(token)){
 if(!text.includes('</body>'))throw Error('NOVNC_HTML_BODY_MISSING');
 text=text.replace('</body>',token+'\n</body>');
 fs.writeFileSync(html,text);
}
console.log('NO_VNC_IPAD_TOUCH_NAV_READY');
