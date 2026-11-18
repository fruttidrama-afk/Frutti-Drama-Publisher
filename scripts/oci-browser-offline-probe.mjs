// Synthetic ARM64 Chromium test. Never navigates to Flow or external sites.
// Invoke ONLY as a one-shot container: docker run --rm --network none --entrypoint node IMAGE ./scripts/oci-browser-offline-probe.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
const executablePath=process.env.CHROMIUM_PATH||'/usr/bin/chromium';
let browser;
try{
  browser=await chromium.launch({
    executablePath,headless:true,timeout:30000,
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-first-run','--disable-default-apps','--disable-extensions']
  });
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage();
  await page.setContent('<!doctype html><html><body><h1 id="offline">ARM64_OFFLINE_BROWSER_OK</h1></body></html>');
  const seen=await page.locator('#offline').innerText();
  assert.equal(seen,'ARM64_OFFLINE_BROWSER_OK');
  // ARM64 native image-processing dependency must really load and transform,
  // not merely exist in node_modules (sharp may require native ARM bindings).
  const preview=await sharp({create:{width:8,height:8,channels:3,background:'#123456'}}).png().toBuffer();
  const meta=await sharp(preview).metadata();
  assert.equal(meta.width,8);
  assert.equal(meta.height,8);
  assert.equal(meta.format,'png');
  const version=browser.version();
  assert.match(version,/^[0-9]+[.]/);
  console.log('[OCI CHROMIUM OFFLINE] PASS',JSON.stringify({version,executablePath,network:'isolated',flowVisited:false,sharpNative:'ok'}));
  await context.close();
}catch(e){
  console.error('[OCI CHROMIUM OFFLINE] FAIL',String(e?.stack||e));
  process.exitCode=1;
}finally{try{await browser?.close()}catch{}}
