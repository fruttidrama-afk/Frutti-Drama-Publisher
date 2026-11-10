import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

for(const name of ["docs/index.html","factory-web/public/index.html"]){
 const html=fs.readFileSync(name,"utf8");
 const markers=["id=\"unifiedDashboard\"","id=\"udStatus\"","function udOpen(","publisher-unified-read","ABRIR EN FACTORY","if(!managed)"];
 for(const marker of markers)if(!html.includes(marker))throw Error(name+" missing "+marker);
 for(const marker of [
  "✓ GOOGLE FLOW · AUTENTICACIÓN GUARDADA CORRECTAMENTE",
  "GOOGLE FLOW AUTENTICADO · PRODUCCIÓN AÚN NO VERIFICADA",
  "VALIDANDO Y GUARDANDO LA SESIÓN…",
  "auth_saved_at",
  'state==="capture_requested"',
  'setTimeout(()=>{if(activeUnifiedPublisher===publisherId)udFlowConnection(publisherId,accessToken)},4000)',
  "No necesitás repetir el inicio de sesión.",
  "GOOGLE FLOW · REVISIÓN DE SEGURIDAD NECESARIA",
  "ABRIR SEGURIDAD DE GOOGLE",
  "YA REVISÉ LA SEGURIDAD · PERMITIR NUEVA CONEXIÓN",
  'action:"acknowledge_security"',
  "payload.security_review_required"
 ]){
  if(!html.includes(marker))throw Error(name+" missing completed-auth / iPad auto-refresh marker: "+marker);
 }
 // Operator-facing reconnection must be actionable from Safari on iPad and
 // must never submit a video or expose credentials except to an owner.
 for(const marker of [
  "INICIAR RECONEXIÓN DESDE ESTE IPAD",
  "COPIAR CONTRASEÑA TEMPORAL",
  'action:"start"',
  'action:"capture"',
  'udFlowPollTimer=setTimeout',
  "ABRIR GOOGLE FLOW · SESIÓN TEMPORAL"
 ])if(!html.includes(marker))throw Error(name+" missing iPad Flow reconnection control "+marker);
 // Keep Factory's new-publisher contract aligned with the deployed runtime:
 // YouTube uploads one PRIVATE video at 12:30 ART and releases the same ID
 // at 19:00 ART; no native publishAt or direct-public fallback.
 for(const marker of [
  'const canonical="b857758bc2f46b0759a1327a39a32566e4168b6629dfa0103357ad1ec58ffab1"',
  'Number(s.upload_lead_minutes)!==390',
  'p.privacy_before_publish!=="private"',
  'p.release_mode!=="same_day_private_to_public_api_update"',
  'p.preserve_private_lead_window!==true',
  'Number(p.upload_lead_minutes)!==390',
  'youtube_upload_policy:"same-day-private-1230-then-public-1900-no-publishat"',
  'credit_refresh_fallback_hours:24'
 ])if(!html.includes(marker))throw Error(name+" stale unsafe new-publisher policy: "+marker);
 // New publishers must be created as disabled, owner-scoped Supabase/GitHub
 // runtime records by the existing transactional trigger. Never require
 // Railway credentials or launch a remote deploy as a side effect.
 for(const marker of [
  'name="publication_platform"',
  'selected_provider:platform',
  'providers:[publicationProvider]',
  'deployment_state:"profile_required"',
  'provider:"supabase-github"',
  'status:"migrating_free_runtime"',
  'railway_connection_id:null',
  '.select("id").single()',
  'if(created?.id)await udOpen(created.id)'
 ])if(!html.includes(marker))throw Error(name+" new publisher free-runtime onboarding missing "+marker);
 for(const obsolete of ['if(!rc)throw Error("Elegí una cuenta de Railway.")','status:"configured",config,runtime_version:"publisher-runtime-v1",railway_connection_id:rc.id']){
  if(html.includes(obsolete))throw Error(name+" still requires Railway to create a Publisher: "+obsolete);
 }
 for(const obsolete of [
  'private_then_public_at_posting_time',
  'direct_public_at_posting_time',
  'stock-until-posting-time-direct-public',
  'privacy_before_publish!=="not_uploaded"'
 ])if(html.includes(obsolete))throw Error(name+" obsolete publication contract: "+obsolete);
 const scripts=[...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/g)];
 if(scripts.length!==1)throw Error(name+": expected exactly one module script, found "+scripts.length);
 const temp=path.join(os.tmpdir(),"publisher-ui-check-"+path.basename(path.dirname(name))+".mjs");
 fs.writeFileSync(temp,scripts[0][1]);
 const checked=spawnSync(process.execPath,["--check",temp],{encoding:"utf8"});
 fs.rmSync(temp,{force:true});
 if(checked.status!==0)throw Error(name+" JavaScript syntax invalid: "+checked.stderr);
 for(const marker of ["id=\"udModeRecovery\"","id=\"udRecoveryVideos\"","id=\"udRecoveryPrompts\"","id=\"udShowPrompts\"","id=\"udRecapPrompt\"","id=\"udRecapSeason\"","id=\"udRecapEpisode\"","id=\"udRecapTitle\"","id=\"udRecapDescription\"","id=\"udRecapSave\"","udFruttiRecap.load(","udSetPublisherPane("]){
  if(!html.includes(marker))throw Error(name+" missing recovery workstation "+marker);
 }
 const pathToRecap=path.join(path.dirname(name),"frutti-recap.js");
 if(!fs.existsSync(pathToRecap))throw Error(name+" missing isolated Frutti recap module");
 if(!fs.readFileSync(pathToRecap,"utf8").includes("publisher-frutti-recap"))throw Error(name+" missing recap backend binding");
 const recapJs=fs.readFileSync(pathToRecap,"utf8");
 if(!recapJs.includes('story_action_v34'))throw Error(name+" missing v33 current-episode extractor revision lock");
 if(!recapJs.includes('udRecapRestoreHistorical')||!recapJs.includes('historical_metadata'))throw Error(name+" lacks historical episode metadata recovery before extractor");
 if(!html.includes('frutti-recap.js?v=20261110-legacy-metadata-recovery'))throw Error(name+" references stale Safari recap module");
 if(/Extractor de episodio actual v(?:28|30)/.test(recapJs))throw Error(name+" misleading hardcoded visible v28/v30 label");
 const recapModule=await import("data:text/javascript;base64,"+Buffer.from(recapJs).toString("base64"));
 const deployedIndex=fs.readFileSync("supabase/functions/publisher-frutti-recap/index.ts","utf8");
 const deployedRevisions=[...deployedIndex.matchAll(/engine_revision:"(story_action_v\d+)"/g)].map(m=>m[1]);
 if(deployedRevisions.length!==2||deployedRevisions.some(rev=>rev!==recapModule.FRUTTI_EXPECTED_ENGINE_REVISION))
   throw Error(name+" backend/client engine_revision mismatch: "+JSON.stringify(deployedRevisions));
 if(recapModule.fruttiEngineLabel(recapModule.FRUTTI_EXPECTED_ENGINE_REVISION)!=="Extractor de episodio actual v34")
   throw Error(name+" reports the wrong visible engine version");
 if(recapModule.fruttiEngineLabel("story_action_v28")!=="versión no confirmada")
   throw Error(name+" does not reject obsolete v28 backend labels");
 for(const id of ['id="udRecapAiState"','id="udRecapAiResult"','id="udRecapSuggest"']){
  if(!html.includes(id))throw Error(name+" missing visible AI diagnostic "+id);
 }
 if(!(html.indexOf('id="udRecapAiState"')<html.indexOf('id="udRecapSuggest"')&&html.indexOf('id="udRecapSuggest"')<html.indexOf('id="udRecapAiResult"')))throw Error(name+" AI error is not beside button");
 for(const phrase of ['response.ai_status','No generé un título que pudiera alterar la historia','GENERAR PROPUESTA DESDE PROMPT','El guardado en stock reconstruido no publica ni modifica videos en YouTube.']){
  if(!recapJs.includes(phrase))throw Error(name+" missing historical editorial recap handling: "+phrase);
 }

 const r=spawnSync(process.execPath,["--check",pathToRecap],{encoding:"utf8"});
 if(r.status!==0)throw Error(name+" recap module syntax invalid: "+r.stderr);
 if(!html.includes("#udPromptBrowser{display:none!important}"))throw Error(name+" still exposes unverified Prompt Studio plans");
 console.log("PASS",name,"module syntax + private recap controls + no automatic publication");
}
