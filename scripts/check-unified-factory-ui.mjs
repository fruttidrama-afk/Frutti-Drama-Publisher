import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

for(const name of ["docs/index.html","factory-web/public/index.html"]){
 const html=fs.readFileSync(name,"utf8");
 const markers=["id=\"unifiedDashboard\"","id=\"udStatus\"","function udOpen(","publisher-unified-read","ABRIR EN FACTORY","if(!managed)"];
 for(const marker of markers)if(!html.includes(marker))throw Error(name+" missing "+marker);
 const scripts=[...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/g)];
 if(scripts.length!==1)throw Error(name+": expected exactly one module script, found "+scripts.length);
 const temp=path.join(os.tmpdir(),"publisher-ui-check-"+path.basename(path.dirname(name))+".mjs");
 fs.writeFileSync(temp,scripts[0][1]);
 const checked=spawnSync(process.execPath,["--check",temp],{encoding:"utf8"});
 fs.rmSync(temp,{force:true});
 if(checked.status!==0)throw Error(name+" JavaScript syntax invalid: "+checked.stderr);
 for(const marker of ["id=\"udModeRecovery\"","id=\"udRecoveryVideos\"","id=\"udRecoveryPrompts\"","id=\"udShowPrompts\"","id=\"udRecapPrompt\"","id=\"udRecapSeason\"","id=\"udRecapEpisode\"","id=\"udRecapTitle\"","id=\"udRecapDescription\"","id=\"udRecapSave\"","publisher-frutti-recap","udFruttiRecap.load(","udSetPublisherPane("]){
  if(!html.includes(marker))throw Error(name+" missing recovery workstation "+marker);
 }
 const pathToRecap=path.join(path.dirname(name),"frutti-recap.js");
 if(!fs.existsSync(pathToRecap))throw Error(name+" missing isolated Frutti recap module");
 const r=spawnSync(process.execPath,["--check",pathToRecap],{encoding:"utf8"});
 if(r.status!==0)throw Error(name+" recap module syntax invalid: "+r.stderr);
 if(!html.includes("#udPromptBrowser{display:none!important}"))throw Error(name+" still exposes unverified Prompt Studio plans");
 console.log("PASS",name,"module syntax + private recap controls + no automatic publication");
}
